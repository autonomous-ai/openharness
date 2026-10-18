import 'dart:async';
import 'dart:ffi';
import 'dart:io';
import 'dart:isolate';
import 'dart:math';
import 'dart:typed_data';

import 'package:ffi/ffi.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:path/path.dart' as p;
import 'package:harness/ws/windows_pipe.dart';

/// kernel32 as a script: each call takes the next answer for its kind and
/// records what it was asked. The real calls run on Windows CI
/// (`integration_test/windows_pipe_test.dart`).
class _ScriptedIo implements PipeIo {
  _ScriptedIo({
    List<({int handle, int error})> creates = const [],
    List<bool> waits = const [],
    List<({Uint8List bytes, int error})> reads = const [],
    List<({int count, int error})> writes = const [],
  }) : _creates = [...creates],
       _waits = [...waits],
       _reads = [...reads],
       _writes = [...writes];

  final List<({int handle, int error})> _creates;
  final List<bool> _waits;
  final List<({Uint8List bytes, int error})> _reads;
  final List<({int count, int error})> _writes;
  final calls = <String>[];
  final waitedMs = <int>[];
  final written = BytesBuilder();

  @override
  ({int handle, int error}) create(String path) {
    calls.add('create $path');
    return _creates.removeAt(0);
  }

  @override
  bool waitFree(String path, int timeoutMs) {
    calls.add('wait');
    waitedMs.add(timeoutMs);
    return _waits.removeAt(0);
  }

  @override
  ({Uint8List bytes, int error}) read(int handle, int max) {
    calls.add('read $handle $max');
    return _reads.removeAt(0);
  }

  @override
  ({int count, int error}) write(int handle, Uint8List bytes, int offset) {
    final answer = _writes.removeAt(0);
    calls.add('write $handle from $offset');
    if (answer.error == 0) {
      written.add(bytes.sublist(offset, offset + answer.count));
    }
    return answer;
  }

  @override
  void cancel(int handle) => calls.add('cancel $handle');

  @override
  void close(int handle) => calls.add('close $handle');

  @override
  void dispose() => calls.add('dispose');
}

const _path = r'\\.\pipe\harness-0123456789abcdef0123456789abcdef';
const _busy = (handle: invalidPipeHandle, error: errorPipeBusy);
const _absent = (handle: invalidPipeHandle, error: errorFileNotFound);
({Uint8List bytes, int error}) _data(List<int> bytes) =>
    (bytes: Uint8List.fromList(bytes), error: 0);
({Uint8List bytes, int error}) _readError(int error) =>
    (bytes: Uint8List(0), error: error);

void main() {
  test(
    'the first native pipe open recognizes an unused name as absent',
    () async {
      final random = Random.secure();
      final id = List.generate(
        16,
        (_) => random.nextInt(256).toRadixString(16).padLeft(2, '0'),
      ).join();
      final path = r'\\.\pipe\harness-' + id;
      // open creates a fresh reader isolate, so no earlier test can initialize
      // its bindings. A random name needs no daemon, record, token or home.
      await expectLater(
        WindowsPipeConnection.open(path)
            .then((connection) => connection.close()),
        throwsA(
          isA<PipeAbsent>().having((error) => error.pipePath, 'path', path),
        ),
      );
    },
    skip: Platform.isWindows ? false : 'kernel32 needs native Windows',
  );

  test('native bridge errors survive subsequent OS and Dart work', () async {
    final dll = DynamicLibrary.open(
      Platform.environment['HARNESS_DESKTOP_PIPE_IO_DLL'] ??
          p.join(p.dirname(Platform.resolvedExecutable), 'harness_pipe_io.dll'),
    );
    final open = dll
        .lookupFunction<
          IntPtr Function(Pointer<Utf16>, Pointer<Uint32>),
          int Function(Pointer<Utf16>, Pointer<Uint32>)
        >('harness_pipe_open_v1');
    final read = dll
        .lookupFunction<
          Int32 Function(
            IntPtr,
            Pointer<Uint8>,
            Uint32,
            Pointer<Void>,
            Pointer<Uint32>,
          ),
          int Function(int, Pointer<Uint8>, int, Pointer<Void>, Pointer<Uint32>)
        >('harness_pipe_read_v1');
    final write = dll
        .lookupFunction<
          Int32 Function(
            IntPtr,
            Pointer<Uint8>,
            Uint32,
            Pointer<Void>,
            Pointer<Uint32>,
          ),
          int Function(int, Pointer<Uint8>, int, Pointer<Void>, Pointer<Uint32>)
        >('harness_pipe_write_v1');
    final event = dll
        .lookupFunction<
          IntPtr Function(Pointer<Uint32>),
          int Function(Pointer<Uint32>)
        >('harness_pipe_create_event_v1');
    final kernel = DynamicLibrary.open('kernel32.dll');
    final setError = kernel
        .lookupFunction<Void Function(Uint32), void Function(int)>(
          'SetLastError',
        );
    final close = kernel
        .lookupFunction<Int32 Function(IntPtr), int Function(int)>(
          'CloseHandle',
        );
    final error = calloc<Uint32>();
    final buffer = calloc<Uint8>();
    final overlapped = calloc<Uint64>(4);
    final random = Random.secure();
    final name =
        (r'\\.\pipe\harness-' +
                List.generate(
                  16,
                  (_) => random.nextInt(256).toRadixString(16).padLeft(2, '0'),
                ).join())
            .toNativeUtf16(allocator: calloc);
    Future<void> retained(int expected) async {
      setError(12345);
      final work = List.generate(100, (i) => i.toString());
      await Future<void>.delayed(Duration.zero);
      expect(work.last, '99');
      expect(error.value, expected);
    }

    try {
      expect(open(name, error), invalidPipeHandle);
      await retained(errorFileNotFound);
      expect(read(invalidPipeHandle, buffer, 1, overlapped.cast(), error), 0);
      await retained(6); // ERROR_INVALID_HANDLE
      expect(write(invalidPipeHandle, buffer, 1, overlapped.cast(), error), 0);
      await retained(6);
      final handle = event(error);
      expect(handle, isNot(0));
      try {
        await retained(0); // Success must clear the output slot explicitly.
      } finally {
        if (handle != 0) close(handle);
      }
    } finally {
      calloc.free(name);
      calloc.free(overlapped);
      calloc.free(buffer);
      calloc.free(error);
    }
  }, skip: Platform.isWindows ? false : 'native bridge needs Windows');

  group('WindowsPipeConnection', () {
    late Directory dir;
    late ReceivePort events;
    late List<String> observed;

    setUp(() {
      dir = Directory.systemTemp.createTempSync('hpipe-');
      events = ReceivePort();
      observed = [];
      events.listen((event) => observed.add(event as String));
    });
    tearDown(() async {
      File('${dir.path}/cancel').writeAsStringSync('yes');
      File('${dir.path}/release-write').writeAsStringSync('yes');
      await Future<void>.delayed(const Duration(milliseconds: 50));
      events.close();
      dir.deleteSync(recursive: true);
    });

    PipeIo Function() factory({bool slowWrite = false, String? fail}) {
      return _blockingFactory(
        dir.path,
        events.sendPort,
        slowWrite: slowWrite,
        fail: fail,
      );
    }

    Future<void> seen(String event) async {
      final deadline = DateTime.now().add(const Duration(seconds: 15));
      while (!observed.contains(event)) {
        if (DateTime.now().isAfter(deadline)) {
          fail('Missing $event: $observed');
        }
        await Future<void>.delayed(const Duration(milliseconds: 10));
      }
    }

    test(
      'writes while the reader is blocked, copies added bytes and closes once',
      () async {
        final connection = await WindowsPipeConnection.open(
          _path,
          io: factory(),
        );
        final inputDone = connection.input.drain<void>();
        await seen('reading');
        final bytes = Uint8List.fromList([1, 2, 3]);
        connection.add(bytes);
        bytes[0] = 99;
        await seen('wrote');
        expect(File('${dir.path}/written').readAsBytesSync(), [1, 2, 3]);
        final closing = connection.close();
        expect(identical(connection.close(), closing), isTrue);
        await closing;
        await inputDone;
        await seen('closed');
        expect(observed.where((e) => e == 'closed'), hasLength(1));
        expect(observed, isNot(contains('closed-active')));
      },
    );

    test(
      'bounded close retains the handle until a blocked writer exits late',
      () async {
        final connection = await WindowsPipeConnection.open(
          _path,
          io: factory(slowWrite: true),
        );
        final inputDone = connection.input.drain<void>();
        connection.add([4, 5]);
        await seen('writing');
        final timer = Stopwatch()..start();
        await connection.close();
        expect(timer.elapsed, lessThan(const Duration(seconds: 15)));
        expect(File('${dir.path}/closed').existsSync(), isFalse);
        expect(observed, isNot(contains('closed')));
        expect(observed, isNot(contains('closed-active')));
        File('${dir.path}/release-write').writeAsStringSync('go');
        await seen('closed');
        await inputDone;
        expect(observed.where((e) => e == 'closed'), hasLength(1));
        expect(observed, isNot(contains('closed-active')));
      },
    );

    test(
      'delivers incoming chunks and retries cancellation missed between reads',
      () async {
        File('${dir.path}/miss-cancel').writeAsStringSync('yes');
        final connection = await WindowsPipeConnection.open(
          _path,
          io: factory(),
        );
        final received = <List<int>>[];
        final done = Completer<void>();
        connection.input.listen(received.add, onDone: done.complete);
        File('${dir.path}/data.tmp')
          ..writeAsBytesSync([8, 9])
          ..renameSync('${dir.path}/data');
        await seen('delivered');
        await connection.close();
        await done.future;
        await seen('closed');
        expect(received, [
          [8, 9],
        ]);
        expect(observed, contains('missed-cancel'));
        expect(observed, isNot(contains('closed-active')));
      },
    );

    test(
      'an unexpected writer error ends input and still disposes both isolates',
      () async {
        File('${dir.path}/throw-write').writeAsStringSync('yes');
        final connection = await WindowsPipeConnection.open(
          _path,
          io: factory(),
        );
        final ended = expectLater(
          connection.input,
          emitsInOrder([emitsError(isA<PipeIoFailed>()), emitsDone]),
        );
        connection.add([1]);
        await ended;
        await connection.close();
        await seen('disposed harness pipe writer');
        await seen('closed');
        expect(observed, isNot(contains('closed-active')));
      },
    );

    test(
      'an absent open disposes its reader without starting a writer',
      () async {
        File('${dir.path}/absent').writeAsStringSync('yes');
        await expectLater(
          WindowsPipeConnection.open(_path, io: factory()),
          throwsA(isA<PipeAbsent>()),
        );
        await seen('disposed harness pipe reader');
        expect(observed, isNot(contains('closed')));
        expect(observed, isNot(contains('writing')));
      },
    );

    test(
      'a reader factory error settles open instead of hanging cleanup',
      () async {
        await expectLater(
          WindowsPipeConnection.open(
            _path,
            io: factory(fail: 'harness pipe reader'),
          ).timeout(const Duration(seconds: 7)),
          throwsA(isA<PipeIoFailed>()),
        );
      },
    );

    test(
      'a failed isolate spawn settles open without a handle to close',
      () async {
        final unsendable = ReceivePort();
        try {
          await expectLater(
            WindowsPipeConnection.open(
              _path,
              io: () {
                unsendable.close();
                throw StateError('not reached');
              },
            ).timeout(const Duration(seconds: 7)),
            throwsA(isA<ArgumentError>()),
          );
          expect(observed, isEmpty);
        } finally {
          unsendable.close();
        }
      },
    );

    test('a writer factory error cancels the already opened reader', () async {
      await expectLater(
        WindowsPipeConnection.open(
          _path,
          io: factory(fail: 'harness pipe writer'),
        ).timeout(const Duration(seconds: 7)),
        throwsA(isA<PipeIoFailed>()),
      );
      await seen('closed');
      expect(observed, isNot(contains('closed-active')));
    });

    test(
      'a peer exit during open never starts a writer on a closed handle',
      () async {
        File('${dir.path}/peer-close').writeAsStringSync('yes');
        final connection = await WindowsPipeConnection.open(
          _path,
          io: factory(),
        );
        await connection.input.drain<void>();
        await connection.close();
        await seen('closed');
        expect(observed, isNot(contains('writer-start-after-close')));
        expect(observed, isNot(contains('write-after-close')));
        expect(observed, isNot(contains('closed-active')));
      },
    );
  });

  group('openPipeHandle', () {
    test('opens the pipe at once when an instance is free', () {
      final io = _ScriptedIo(creates: [(handle: 7, error: 0)]);
      expect(openPipeHandle(io, _path, busyWaitMs: 2000), 7);
      expect(io.calls, ['create $_path']);
    });

    test('rejects an invalid handle even when its error is zero', () {
      final io = _ScriptedIo(creates: [(handle: invalidPipeHandle, error: 0)]);
      expect(
        () => openPipeHandle(io, _path, busyWaitMs: 2000),
        throwsA(
          isA<PipeOpenFailed>().having((failure) => failure.code, 'code', 0),
        ),
      );
    });

    test('waits for a busy pipe, then opens it', () {
      var now = 0;
      final io = _ScriptedIo(
        creates: [_busy, _busy, (handle: 9, error: 0)],
        waits: [true, false],
      );
      expect(
        openPipeHandle(io, _path, busyWaitMs: 2000, clockMs: () => now += 100),
        9,
      );
      expect(io.calls, [
        'create $_path',
        'wait',
        'create $_path',
        'wait',
        'create $_path',
      ]);
      // Each wait is for what is left of the one bound, never a fresh one.
      expect(io.waitedMs, [1900, 1800]);
    });

    test('gives up on a pipe that stays busy, as busy', () {
      var now = 0;
      final io = _ScriptedIo(creates: [_busy, _busy], waits: [false]);
      expect(
        () => openPipeHandle(
          io,
          _path,
          busyWaitMs: 1000,
          clockMs: () => now += 600,
        ),
        throwsA(isA<PipeBusy>()),
      );
      expect(io.calls, ['create $_path', 'wait', 'create $_path']);
    });

    test(
      'a name nobody listens on is a pipe that is gone, also after a wait',
      () {
        expect(
          () => openPipeHandle(
            _ScriptedIo(creates: [_absent]),
            _path,
            busyWaitMs: 2000,
          ),
          throwsA(
            isA<PipeAbsent>().having((f) => f.pipePath, 'pipePath', _path),
          ),
        );
        // The daemon left while every instance was busy.
        expect(
          () => openPipeHandle(
            _ScriptedIo(creates: [_busy, _absent], waits: [false]),
            _path,
            busyWaitMs: 2000,
          ),
          throwsA(isA<PipeAbsent>()),
        );
      },
    );

    test('any other refusal is a failed open with its Windows error', () {
      expect(
        () => openPipeHandle(
          _ScriptedIo(creates: [(handle: invalidPipeHandle, error: 5)]),
          _path,
          busyWaitMs: 2000,
        ),
        throwsA(isA<PipeOpenFailed>().having((f) => f.code, 'code', 5)),
      );
    });
  });

  group('pumpPipe', () {
    test('hands on every chunk, skips an empty one, and ends when the daemon closes its end', () {
      final io = _ScriptedIo(
        reads: [
          _data([1, 2]),
          _data([]),
          _data([3]),
          _readError(errorBrokenPipe),
        ],
      );
      final chunks = <List<int>>[];
      expect(pumpPipe(io, 7, chunks.add), PipeEnd.closedByPeer);
      expect(chunks, [
        [1, 2],
        [3],
      ]);
      expect(io.calls.first, 'read 7 $pipeChunkBytes');
    });

    test('a pipe that is no longer connected, or closing, is the end of the stream too', () {
      for (final error in [errorPipeNotConnected, errorNoData]) {
        expect(
          pumpPipe(_ScriptedIo(reads: [_readError(error)]), 7, (_) {}),
          PipeEnd.closedByPeer,
        );
      }
    });

    test('a cancelled read is this side closing', () {
      expect(
        pumpPipe(
          _ScriptedIo(
            reads: [
              _data([1]),
              _readError(errorOperationAborted),
            ],
          ),
          7,
          (_) {},
        ),
        PipeEnd.cancelled,
      );
    });

    test('any other read failure is a failure, with its code', () {
      expect(
        () => pumpPipe(_ScriptedIo(reads: [_readError(0xC0000185)]), 7, (_) {}),
        throwsA(isA<PipeIoFailed>().having((f) => f.code, 'code', 0xC0000185)),
      );
    });
  });

  group('writeAllToPipe', () {
    test('writes everything, however many writes it takes', () {
      final io = _ScriptedIo(
        writes: [(count: 2, error: 0), (count: 3, error: 0)],
      );
      writeAllToPipe(io, 7, Uint8List.fromList([1, 2, 3, 4, 5]));
      expect(io.written.takeBytes(), [1, 2, 3, 4, 5]);
      expect(io.calls, ['write 7 from 0', 'write 7 from 2']);
    });

    test('a daemon that closed its end is a broken pipe', () {
      for (final error in [
        errorBrokenPipe,
        errorNoData,
        errorPipeNotConnected,
      ]) {
        expect(
          () => writeAllToPipe(
            _ScriptedIo(writes: [(count: 0, error: error)]),
            7,
            Uint8List.fromList([1]),
          ),
          throwsA(isA<PipeBroken>()),
        );
      }
    });

    test('a write that wrote nothing, or failed otherwise, is a failure', () {
      expect(
        () => writeAllToPipe(
          _ScriptedIo(writes: [(count: 0, error: 0)]),
          7,
          Uint8List.fromList([1]),
        ),
        throwsA(isA<PipeIoFailed>()),
      );
      expect(
        () => writeAllToPipe(
          _ScriptedIo(writes: [(count: 0, error: errorOperationAborted)]),
          7,
          Uint8List.fromList([1]),
        ),
        throwsA(
          isA<PipeIoFailed>().having(
            (f) => f.code,
            'code',
            errorOperationAborted,
          ),
        ),
      );
      // Nothing to write is nothing asked.
      final idle = _ScriptedIo();
      writeAllToPipe(idle, 7, Uint8List(0));
      expect(idle.calls, isEmpty);
    });
  });

  test('every pipe failure reads as a sentence, never a Windows code', () {
    for (final failure in <PipeFailure>[
      const PipeRecordMissing(),
      const PipeAbsent(_path),
      const PipeBusy(_path),
      const PipeOpenFailed(_path, 5),
      const PipeBroken(),
      const PipeIoFailed(109),
      const PipeUnproven(_path),
    ]) {
      expect(failure.toString(), endsWith('.'));
      expect(failure.toString(), isNot(contains('109')));
    }
  });
}

PipeIo Function() _blockingFactory(
  String root,
  SendPort events, {
  required bool slowWrite,
  String? fail,
}) => () {
  if (fail == Isolate.current.debugName) throw StateError('factory');
  return _BlockingIo(root, events, slowWrite: slowWrite);
};

/// Blocking kernel calls are replaced only here; the real connection still
/// starts two isolates and owns cancellation/handle lifetime. Scratch markers
/// coordinate their synchronous calls without any production service or home.
class _BlockingIo implements PipeIo {
  _BlockingIo(this.root, this.events, {required this.slowWrite}) {
    if (Isolate.current.debugName == 'harness pipe writer' &&
        marker('closed').existsSync()) {
      events.send('writer-start-after-close');
    }
  }
  final String root;
  final SendPort events;
  final bool slowWrite;

  File marker(String name) => File('$root/$name');

  @override
  ({int handle, int error}) create(String path) => marker('absent').existsSync()
      ? (handle: invalidPipeHandle, error: errorFileNotFound)
      : (handle: 7, error: 0);

  @override
  bool waitFree(String path, int timeoutMs) => false;

  @override
  ({Uint8List bytes, int error}) read(int handle, int max) {
    marker('reader-active').writeAsStringSync('yes');
    events.send('reading');
    while (!marker('cancel').existsSync() &&
        !marker('peer-close').existsSync() &&
        !marker('data').existsSync()) {
      sleep(const Duration(milliseconds: 5));
    }
    marker('reader-active').deleteSync();
    if (marker('data').existsSync()) {
      final bytes = marker('data').readAsBytesSync();
      marker('data').deleteSync();
      events.send('delivered');
      return (bytes: bytes, error: 0);
    }
    return _readError(
      marker('peer-close').existsSync()
          ? errorBrokenPipe
          : errorOperationAborted,
    );
  }

  @override
  ({int count, int error}) write(int handle, Uint8List bytes, int offset) {
    if (marker('throw-write').existsSync()) throw StateError('write failed');
    if (marker('closed').existsSync()) events.send('write-after-close');
    marker('writer-active').writeAsStringSync('yes');
    events.send('writing');
    while (slowWrite && !marker('release-write').existsSync()) {
      sleep(const Duration(milliseconds: 5));
    }
    marker('written').writeAsBytesSync(bytes.sublist(offset));
    marker('writer-active').deleteSync();
    events.send('wrote');
    return (count: bytes.length - offset, error: 0);
  }

  @override
  void cancel(int handle) {
    if (marker('miss-cancel').existsSync()) {
      marker('miss-cancel').deleteSync();
      events.send('missed-cancel');
      return;
    }
    marker('cancel').writeAsStringSync('yes');
  }

  @override
  void close(int handle) {
    if (marker('reader-active').existsSync() ||
        marker('writer-active').existsSync()) {
      events.send('closed-active');
    }
    marker('closed').writeAsStringSync('yes');
    events.send('closed');
  }

  @override
  void dispose() => events.send('disposed ${Isolate.current.debugName}');
}
