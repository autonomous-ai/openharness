// The trusted pipe against the daemon's own pipe code, on a real Windows named pipe, from inside the
// app: cli/scripts/windows-pipe-test-server.ts serves lib/localSocket.ts's authenticated pipe and
// localWsServer.ts's WebSocket from this checkout, under a throwaway data folder and port, never the
// real %USERPROFILE%\.harness or 18473, and the app dials it with its kernel32 client
// (lib/ws/windows_pipe.dart). Windows only; the Windows desktop workflow's build-test job runs it:
//
//   cd cli && npm ci && cd ../desktop && flutter test -d windows integration_test/windows_pipe_test.dart
import 'dart:async';
import 'dart:convert';
import 'dart:ffi';
import 'dart:io';
import 'dart:isolate';
import 'dart:math';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:ffi/ffi.dart';
import 'package:harness/api/api_client.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/ws/daemon_pipe_record.dart';
import 'package:harness/ws/local_daemon_transport.dart';
import 'package:harness/ws/trusted_pipe.dart';
import 'package:harness/ws/windows_pipe.dart';
import 'package:harness/ws/windows_pipe_auth.dart';
import 'package:harness/ws/windows_pipe_kernel32.dart';
import 'package:harness/ws/ws_conn.dart';
import 'package:integration_test/integration_test.dart';
import 'package:path/path.dart' as p;

// A small native peer supplements the daemon cases below. Its 4 KiB buffer and
// withheld reads/writes make the client's first native transfer block. We observe
// entry/completion at PipeIo, not the numeric ERROR_IO_PENDING hidden inside it.
class _ObservedIo implements PipeIo {
  _ObservedIo(this.events) : native = kernel32PipeIo();
  final SendPort events;
  final PipeIo native;
  @override
  ({int handle, int error}) create(String path) => native.create(path);
  @override
  bool waitFree(String path, int timeoutMs) => native.waitFree(path, timeoutMs);
  @override
  ({Uint8List bytes, int error}) read(int handle, int max) {
    events.send(('read-enter', 0, 0));
    final result = native.read(handle, max);
    events.send(('read-done', result.error, result.bytes.length));
    return result;
  }

  @override
  ({int count, int error}) write(int handle, Uint8List bytes, int offset) {
    events.send(('write-enter', 0, 0));
    final result = native.write(handle, bytes, offset);
    events.send(('write-done', result.error, result.count));
    return result;
  }

  @override
  void cancel(int handle) => native.cancel(handle);
  @override
  void close(int handle) => native.close(handle);
  @override
  void dispose() => native.dispose();
}

// A separate closure context keeps ReceivePorts/native peers out of the factory
// sent to the reader/writer isolates.
PipeIo Function() _observedFactory(SendPort events) =>
    () => _ObservedIo(events);

// Only pipe creation is test-specific FFI. Transfers and cancellation
// reuse the real production kernel32 adapter on workers, never the UI isolate.
class _ControlledPipe {
  _ControlledPipe(this.path) {
    final kernel = DynamicLibrary.open('kernel32.dll');
    final create = kernel
        .lookupFunction<
          IntPtr Function(
            Pointer<Utf16>,
            Uint32,
            Uint32,
            Uint32,
            Uint32,
            Uint32,
            Uint32,
            Pointer<Void>,
          ),
          int Function(
            Pointer<Utf16>,
            int,
            int,
            int,
            int,
            int,
            int,
            Pointer<Void>,
          )
        >('CreateNamedPipeW', isLeaf: true);
    final name = path.toNativeUtf16(allocator: calloc);
    try {
      handle = create(name, 3 | 0x40000000, 8, 1, 4096, 4096, 5000, nullptr);
      if (handle == invalidPipeHandle) {
        throw StateError('CreateNamedPipeW failed');
      }
    } finally {
      calloc.free(name);
    }
  }
  final String path;
  late final int handle;
  final operations = <Future<Object?>>[];
  final native = kernel32PipeIo();

  Future<Uint8List> read(int count) {
    final serverHandle = handle;
    final operation = Isolate.run(() {
      final io = kernel32PipeIo();
      try {
        final bytes = BytesBuilder();
        while (bytes.length < count) {
          final got = io.read(serverHandle, count - bytes.length);
          if (got.error != 0) throw PipeIoFailed(got.error);
          bytes.add(got.bytes);
        }
        return bytes.takeBytes();
      } finally {
        io.dispose();
      }
    });
    operations.add(operation);
    return operation;
  }

  Future<void> write(Uint8List bytes) {
    final serverHandle = handle;
    final operation = Isolate.run(() {
      final io = kernel32PipeIo();
      try {
        writeAllToPipe(io, serverHandle, bytes);
      } finally {
        io.dispose();
      }
    });
    operations.add(operation);
    return operation;
  }

  Future<void> close() async {
    // A worker may not have entered ReadFile yet. Retry cancellation until all
    // workers exit; even a timed-out caller never frees a handle they still use.
    native.cancel(handle);
    final retry = Timer.periodic(const Duration(milliseconds: 100), (_) {
      native.cancel(handle);
    });
    final finished =
        Future.wait(
          operations.map((op) => op.then<void>((_) {}, onError: (Object _) {})),
        ).whenComplete(() {
          retry.cancel();
          native.close(handle);
          native.dispose();
        });
    await finished.timeout(const Duration(seconds: 10));
  }
}

// Inspect the private native ABI only here: both operations remain pending while
// Dart and another OS call run. The regular cases below exercise production PipeIo.
Future<(int, int)> _pendingErrorsSurviveClobber(String path) async {
  final dll = DynamicLibrary.open(
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
  final cancel = kernel
      .lookupFunction<
        Int32 Function(IntPtr, Pointer<Void>),
        int Function(int, Pointer<Void>)
      >('CancelIoEx');
  final wait = kernel
      .lookupFunction<Uint32 Function(IntPtr, Uint32), int Function(int, int)>(
        'WaitForSingleObject',
      );
  final close = kernel
      .lookupFunction<Int32 Function(IntPtr), int Function(int)>('CloseHandle');
  final error = calloc<Uint32>(2);
  final name = path.toNativeUtf16(allocator: calloc);
  final readBuffer = calloc<Uint8>();
  final writeBuffer = calloc<Uint8>(pipeChunkBytes);
  final reading = calloc<Uint64>(4);
  final writing = calloc<Uint64>(4);
  var handle = invalidPipeHandle;
  var readEvent = 0;
  var writeEvent = 0;
  var readMayBePending = false;
  var writeMayBePending = false;
  try {
    handle = open(name, error);
    if (handle == invalidPipeHandle) {
      throw StateError('raw open: ${error.value}');
    }
    readEvent = event(error);
    if (readEvent == 0) throw StateError('raw read event: ${error.value}');
    writeEvent = event(error);
    if (writeEvent == 0) throw StateError('raw write event: ${error.value}');
    reading[3] = readEvent;
    writing[3] = writeEvent;
    // No server bytes and no server reads: both first transfers must pend.
    readMayBePending = read(handle, readBuffer, 1, reading.cast(), error) == 0;
    writeMayBePending =
        write(handle, writeBuffer, pipeChunkBytes, writing.cast(), error + 1) ==
        0;
    if (!readMayBePending || !writeMayBePending) {
      throw StateError('first controlled read/write did not pend');
    }
    setError(12345);
    final work = List.generate(100, (i) => i.toString());
    await Future<void>.delayed(Duration.zero);
    if (work.last != '99') throw StateError('Dart work failed');
    return (error[0], error[1]);
  } finally {
    if (handle != invalidPipeHandle) cancel(handle, nullptr);
    // BOOL zero is conservatively treated as potentially pending, even if a
    // broken bridge returned a wrong error. Never free on an unproved wait.
    final readSafe = !readMayBePending || wait(readEvent, 10000) == 0;
    final writeSafe = !writeMayBePending || wait(writeEvent, 10000) == 0;
    if (readSafe) {
      if (readEvent != 0) close(readEvent);
      calloc.free(reading);
      calloc.free(readBuffer);
    }
    if (writeSafe) {
      if (writeEvent != 0) close(writeEvent);
      calloc.free(writing);
      calloc.free(writeBuffer);
    }
    if (readSafe && writeSafe) {
      if (handle != invalidPipeHandle) close(handle);
    }
    calloc.free(name);
    calloc.free(error); // The kernel never owns the error-out slots.
    if (!readSafe || !writeSafe) {
      throw StateError(
        'raw pending completion unproved; native storage retained',
      );
    }
  }
}

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  if (Platform.isWindows && Platform.environment['FLUTTER_TEST'] != '1') {
    throw StateError('Run this isolated fixture with FLUTTER_TEST=1.');
  }

  group(
    'on a real Windows pipe',
    () {
      late Directory dataDir;
      Process? server;
      late String pipePath;
      late String squatterPath;
      late int tcpPort;
      late String machineId;
      // A throwaway port: the record is named for it. Never the real daemon's 18473.
      final port = 28000 + Random().nextInt(1000);

      setUpAll(() async {
        // %TEMP% is in the profile, where the daemon's token may live (secureState.ts).
        dataDir = Directory.systemTemp.createTempSync('hpipe-');
        final child = server = await Process.start(
          'node',
          [
            '--import',
            'tsx',
            'scripts/windows-pipe-test-server.ts',
            dataDir.path,
            '$port',
          ],
          environment: {
            'HOME': dataDir.path,
            'USERPROFILE': dataDir.path,
            'ADAPTER_DATA_DIR': dataDir.path,
            'CLAUDE_CONFIG_DIR': p.join(dataDir.path, 'claude'),
            'CODEX_HOME': p.join(dataDir.path, 'codex'),
            'XDG_CONFIG_HOME': p.join(dataDir.path, 'config'),
            'XDG_DATA_HOME': p.join(dataDir.path, 'data'),
            'HARNESSD_SERVICES': 'none',
            'TMUX': '',
            'TMUX_PANE': '',
          },
          workingDirectory: p.normalize(
            p.join(Directory.current.path, '..', 'cli'),
          ),
        );
        unawaited(child.stderr.transform(utf8.decoder).forEach(stderr.write));
        final ready = jsonDecode(
          await child.stdout
              .transform(utf8.decoder)
              .transform(const LineSplitter())
              .first
              .timeout(const Duration(seconds: 60)),
        ) as Map<String, dynamic>;
        pipePath = ready['pipe'] as String;
        squatterPath = ready['squatter'] as String;
        tcpPort = ready['tcpPort'] as int;
        machineId = ready['machineId'] as String;
      });

      tearDownAll(() async {
        try {
          final child = server;
          if (child != null) {
            await child.stdin.close().catchError((Object _) {});
            try {
              expect(
                await child.exitCode.timeout(const Duration(seconds: 10)),
                0,
              );
            } on TimeoutException {
              child.kill();
              await child.exitCode.timeout(const Duration(seconds: 10));
              fail('the throwaway pipe server did not stop when stdin closed');
            }
          }
        } finally {
          dataDir.deleteSync(recursive: true);
        }
      });

      /// Points the record at [pipe], as a restart, or a stale record a squatter took over, would.
      void recordNames(String pipe) =>
          File(p.join(dataDir.path, 'daemon-$port.json')).writeAsStringSync(
            jsonEncode({'port': tcpPort, 'pipe': pipe, 'pid': server!.pid}),
          );

      TrustedPipe trustedPipe() => TrustedPipe(
        lookup: () => readDaemonPipeRecord(dataDir: dataDir.path, port: port),
      );

      ApiClient api(LocalDaemonTransport transport) => ApiClient(
        config: AppConfig(
          apiBaseUrl: 'http://unused.invalid',
          localCliBaseUrl: 'http://127.0.0.1:$tcpPort',
        ),
        session: AuthSession(),
        localTransport: transport,
      );

      WsConn conn(LocalDaemonTransport transport, {bool trusted = true}) =>
          WsConn(
            wsBaseUrl: 'wss://unused.example',
            autonomousEnv: 'prod',
            machineId: machineId,
            accessTokenProvider: (_, _) async => '',
            onAuthFailure: (_) {},
            onEvent: (_) {},
            onStatus: (_) {},
            transportKind: WsTransportKind.localPlaintext,
            // Only the explicit untrusted fixture reaches the loopback port.
            allowLocalTcpFixture: !trusted,
            localWsUri: Uri.parse('ws://127.0.0.1:$tcpPort/api/local-ws'),
            localTransport: transport,
            trustedLocal: trusted,
            fixedReconnectDelay: const Duration(milliseconds: 200),
          );

      Future<void> ready(WsConn connection) =>
          connection.waitUntilReady(timeout: const Duration(seconds: 20));

      /// What the daemon says to a key from [connection]: `UNSUPPORTED` from a trusted window,
      /// `LOCAL_SOCKET_REQUIRED` from any other (localWsServer.ts).
      Future<String> actRefusal(WsConn connection) async {
        try {
          await connection.request(
            'daemon_act',
            payload: {'id': 'say:1', 'choice': 'y'},
          );
          return 'answered';
        } on WsRequestFailure catch (failure) {
          return failure.code;
        }
      }

      /// One raw exchange on the pipe: what came back before the daemon closed its end.
      Future<String> raw(String request) async {
        final connection = await WindowsPipeConnection.open(pipePath);
        try {
          connection.add(utf8.encode(request));
          final bytes = BytesBuilder();
          await connection.input
              .forEach(bytes.add)
              .timeout(const Duration(seconds: 10));
          return latin1.decode(bytes.takeBytes());
        } finally {
          await connection.close();
        }
      }

      setUp(() => recordNames(pipePath));

      test('REST: the Add Phone code comes over the pipe, with the daemon\'s proof', () async {
        final client = api(LocalDaemonTransport(trustedPipe: trustedPipe()));
        expect((await client.phoneSignInCode())?.code, 'hnh_pipe_test');
        expect(client.phoneSignInUnavailable, isFalse);
      });

      test('WebSocket: this computer\'s window connection over the pipe is one the daemon trusts', () async {
        final trusted = conn(LocalDaemonTransport(trustedPipe: trustedPipe()));
        addTearDown(trusted.close);
        unawaited(trusted.connect());
        await ready(trusted);
        expect(trusted.trustedPipeMissing, isFalse);
        expect(await actRefusal(trusted), 'UNSUPPORTED');

        // The same daemon over its loopback port: refused, which is why the pipe is needed.
        final plain = conn(LocalDaemonTransport(), trusted: false);
        addTearDown(plain.close);
        unawaited(plain.connect());
        await ready(plain);
        expect(await actRefusal(plain), 'LOCAL_SOCKET_REQUIRED');
      });

      test('the daemon refuses a request without an auth, and with a wrong one, and drops such an upgrade', () async {
        final noAuth = await raw(
          'GET /api/status HTTP/1.1\r\nhost: localhost\r\nconnection: close\r\n\r\n',
        );
        expect(noAuth, startsWith('HTTP/1.1 401'));
        expect(noAuth.toLowerCase(), isNot(contains(pipeProofHeader)));

        final record = readDaemonPipeRecord(dataDir: dataDir.path, port: port)!;
        final wrong = pipeAuthHeaderValue(
          Uint8List(32),
          record.pipeId,
          Uint8List(16),
        );
        final wrongAuth = await raw(
          'GET /api/status HTTP/1.1\r\nhost: localhost\r\nconnection: close\r\n$pipeAuthHeader: $wrong\r\n\r\n',
        );
        expect(wrongAuth, startsWith('HTTP/1.1 401'));
        expect(wrongAuth.toLowerCase(), isNot(contains(pipeProofHeader)));

        final upgrade = await raw(
          'GET /api/local-ws HTTP/1.1\r\nhost: localhost\r\nupgrade: websocket\r\nconnection: Upgrade\r\n'
          'sec-websocket-key: dGhlIHNhbXBsZSBub25jZQ==\r\nsec-websocket-version: 13\r\n\r\n',
        );
        expect(upgrade, isEmpty);
      });

      test('a pipe that answers with a bad proof is not trusted, and the daemon\'s own is found again', () async {
        recordNames(squatterPath);
        final pipe = trustedPipe();
        final transport = LocalDaemonTransport(trustedPipe: pipe);
        final client = api(transport);
        await expectLater(
          pipe.request('GET', '/api/status'),
          throwsA(isA<PipeUnproven>()),
        );
        await expectLater(
          pipe.webSocket('/api/local-ws'),
          throwsA(isA<PipeUnproven>()),
        );
        expect(await client.phoneSignInCode(), isNull);
        expect(client.phoneSignInUnavailable, isTrue);

        final fallback = conn(transport);
        addTearDown(fallback.close);
        await fallback.connect();
        expect(fallback.isReady, isFalse);
        expect(fallback.trustedPipeMissing, isTrue);

        recordNames(pipePath);
        expect(await pipe.probe(), isTrue);
        expect((await client.phoneSignInCode())?.code, 'hnh_pipe_test');
        expect(client.phoneSignInUnavailable, isFalse);
        // The same window connection finds the new pipe on its next retry.
        await ready(fallback);
        expect(fallback.trustedPipeMissing, isFalse);
        expect(await actRefusal(fallback), 'UNSUPPORTED');
      });

      test('a pipe that is gone is absent', () async {
        const gone = r'\\.\pipe\harness-00000000000000000000000000000000';
        await expectLater(
          WindowsPipeConnection.open(gone),
          throwsA(isA<PipeAbsent>()),
        );
        recordNames(gone);
        await expectLater(
          trustedPipe().request('GET', '/api/status'),
          throwsA(isA<PipeAbsent>()),
        );
      });

      test('pending native errors survive OS clobber and Dart work', () async {
        final random = Random.secure();
        final id = List.generate(
          16,
          (_) => random.nextInt(256),
        ).map((byte) => byte.toRadixString(16).padLeft(2, '0')).join();
        final peer = _ControlledPipe('\\\\.\\pipe\\harness-$id');
        final path = peer.path;
        try {
          final errors = await Isolate.run(
            () => _pendingErrorsSurviveClobber(path),
          ).timeout(const Duration(seconds: 30));
          expect(errors, (997, 997));
        } finally {
          await peer.close();
        }
      });

      for (final cancel in [false, true]) {
        test(
          'first native reads and writes ${cancel ? 'cancel safely while blocked' : 'complete after controlled backpressure'}',
          () async {
            final id = List.generate(
              16,
              (_) => Random.secure().nextInt(256),
            ).map((byte) => byte.toRadixString(16).padLeft(2, '0')).join();
            final peer = _ControlledPipe('\\\\.\\pipe\\harness-$id');
            final events = ReceivePort();
            final observed = <(String, int, int)>[];
            final subscription = events.listen((event) {
              observed.add(event as (String, int, int));
            });
            final port = events.sendPort;
            WindowsPipeConnection? connection;
            StreamSubscription<Uint8List>? input;
            final received = <int>[];
            final firstBytes = Completer<void>();
            Future<void> seen(String kind) async {
              final deadline = DateTime.now().add(const Duration(seconds: 10));
              while (!observed.any((event) => event.$1 == kind)) {
                if (DateTime.now().isAfter(deadline)) {
                  fail('no $kind from native client');
                }
                await Future<void>.delayed(const Duration(milliseconds: 10));
              }
            }

            try {
              connection = await WindowsPipeConnection.open(
                peer.path,
                io: _observedFactory(port),
              );
              input = connection.input.listen((bytes) {
                received.addAll(bytes);
                if (received.length >= 3 && !firstBytes.isCompleted) {
                  firstBytes.complete();
                }
              });
              await seen('read-enter');
              // No server bytes exist: the client's very first ReadFile is blocked.
              await Future<void>.delayed(const Duration(milliseconds: 100));
              expect(
                observed.where((event) => event.$1 == 'read-done'),
                isEmpty,
              );
              final bytes = Uint8List.fromList(
                List.generate(pipeChunkBytes, (i) => i % 251),
              );
              connection.add(bytes);
              await seen('write-enter');
              // The first 64 KiB write cannot fit the peer's unread 4 KiB buffer.
              await Future<void>.delayed(const Duration(milliseconds: 100));
              expect(
                observed.where((event) => event.$1 == 'write-done'),
                isEmpty,
              );
              if (cancel) {
                await connection.close().timeout(const Duration(seconds: 6));
                await seen('read-done');
                await seen('write-done');
                expect(
                  observed.firstWhere((event) => event.$1 == 'read-done').$2,
                  errorOperationAborted,
                );
                expect(
                  observed.firstWhere((event) => event.$1 == 'write-done').$2,
                  errorOperationAborted,
                );
              } else {
                await peer
                    .write(Uint8List.fromList([17, 29, 43]))
                    .timeout(const Duration(seconds: 10));
                await seen('read-done');
                expect(
                  observed.firstWhere((event) => event.$1 == 'read-done'),
                  ('read-done', 0, 3),
                );
                await firstBytes.future.timeout(const Duration(seconds: 10));
                expect(received, [17, 29, 43]);
                expect(
                  await peer
                      .read(bytes.length)
                      .timeout(const Duration(seconds: 10)),
                  bytes,
                );
                await seen('write-done');
                expect(
                  observed.firstWhere((event) => event.$1 == 'write-done'),
                  ('write-done', 0, pipeChunkBytes),
                );
              }
            } finally {
              try {
                await connection?.close();
              } finally {
                try {
                  await input?.cancel();
                  await peer.close();
                } finally {
                  await subscription.cancel();
                  events.close();
                }
              }
            }
          },
        );
      }
    },
    skip: Platform.isWindows ? false : 'the real pipe is Windows only; test/trusted_pipe_test.dart covers the rest',
  );
}
