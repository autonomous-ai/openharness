import 'dart:async';
import 'dart:isolate';
import 'dart:typed_data';

import 'windows_pipe_kernel32.dart'
    if (dart.library.js_interop) 'windows_pipe_kernel32_web.dart';

/// One open connection to the daemon's pipe: bytes in, bytes out. One carries
/// one HTTP exchange or one WebSocket, as a Unix socket does on macOS.
abstract interface class PipeStream {
  /// What the daemon sends, until it closes its end.
  Stream<Uint8List> get input;

  /// Sends [bytes]. Ignored once the connection is closing.
  void add(List<int> bytes);

  /// Sends pending bytes for a bounded while, then closes the connection.
  Future<void> close();
}

/// Opens a [PipeStream] to the pipe at a path.
typedef PipeDialer = Future<PipeStream> Function(String pipePath);

/// Why the pipe could not be used. Every one of them means the same to a
/// trusted caller: there is no pipe to trust right now.
sealed class PipeFailure implements Exception {
  const PipeFailure(this.message);
  final String message;

  @override
  String toString() => message;
}

/// The data folder records no pipe (or one that is not a Harness pipe), or
/// has no token.
final class PipeRecordMissing extends PipeFailure {
  const PipeRecordMissing()
    : super('The Harness daemon on this computer records no private pipe.');
}

/// Nothing listens at the recorded name (`ERROR_FILE_NOT_FOUND`).
final class PipeAbsent extends PipeFailure {
  const PipeAbsent(this.pipePath)
    : super('The Harness daemon\'s private pipe is not open.');
  final String pipePath;
}

/// Every instance of the pipe stayed busy for as long as the app waited.
final class PipeBusy extends PipeFailure {
  const PipeBusy(this.pipePath)
    : super('The Harness daemon\'s private pipe stayed busy.');
  final String pipePath;
}

/// CreateFileW refused for another reason, by its Windows error [code].
final class PipeOpenFailed extends PipeFailure {
  const PipeOpenFailed(this.pipePath, this.code)
    : super('The Harness daemon\'s private pipe could not be opened.');
  final String pipePath;
  final int code;
}

/// The daemon closed its end while something was still to be written.
final class PipeBroken extends PipeFailure {
  const PipeBroken() : super('The Harness daemon closed its private pipe.');
}

/// A read or a write failed, by its Windows error [code] (or an NTSTATUS).
final class PipeIoFailed extends PipeFailure {
  const PipeIoFailed(this.code)
    : super('Reading or writing the Harness daemon\'s private pipe failed.');
  final int code;
}

/// Something answered on the pipe without the daemon's proof: not this
/// user's daemon (a process that took the name of a daemon that is gone).
final class PipeUnproven extends PipeFailure {
  const PipeUnproven(this.pipePath)
    : super('Something other than Harness answered on its private pipe.');
  final String pipePath;
}

/// The answer was not the HTTP the daemon speaks, or it came too late.
final class PipeProtocolError extends PipeFailure {
  const PipeProtocolError(super.message);
}

// The Windows errors the pipe can report (winerror.h).
const errorFileNotFound = 2;
const errorBrokenPipe = 109;
const errorPipeBusy = 231;
const errorNoData = 232;
const errorPipeNotConnected = 233;
const errorMoreData = 234;
const errorOperationAborted = 995;
const errorIoPending = 997;

/// `INVALID_HANDLE_VALUE`.
const invalidPipeHandle = -1;

/// The most one read takes and one write gives.
const pipeChunkBytes = 64 * 1024;

/// How long an open waits, in all, while every instance of the pipe is busy.
const defaultPipeBusyWait = Duration(seconds: 2);

/// The kernel32 calls a pipe connection makes, behind an interface so the
/// state machine below runs anywhere against a fake. Every call returns what
/// it did and, when it failed, the Windows error (0 on success). Reads and
/// writes block their isolate until they complete.
abstract interface class PipeIo {
  /// CreateFileW on [path]: a handle, or [invalidPipeHandle] and the error.
  ({int handle, int error}) create(String path);

  /// WaitNamedPipeW: whether an instance came free within [timeoutMs].
  bool waitFree(String path, int timeoutMs);

  /// One read of at most [max] bytes: what came, or the error that ended it.
  ({Uint8List bytes, int error}) read(int handle, int max);

  /// One write of [bytes] from [offset]: how many went, or the error.
  ({int count, int error}) write(int handle, Uint8List bytes, int offset);

  /// Aborts a read blocked on [handle] in another isolate (CancelIoEx).
  void cancel(int handle);

  /// CloseHandle.
  void close(int handle);

  /// Frees what this instance allocated.
  void dispose();
}

/// Opens [path] through [io]. While every instance of the pipe is busy it
/// waits for one (WaitNamedPipeW), for at most [busyWaitMs] in all; then
/// [PipeBusy]. A name nobody listens on is [PipeAbsent]: the pipe is gone.
int openPipeHandle(
  PipeIo io,
  String path, {
  required int busyWaitMs,
  int Function()? clockMs,
}) {
  final now = clockMs ?? () => DateTime.now().millisecondsSinceEpoch;
  final deadline = now() + busyWaitMs;
  for (;;) {
    final opened = io.create(path);
    if (opened.error == 0 && opened.handle != invalidPipeHandle) {
      return opened.handle;
    }
    switch (opened.error) {
      case errorFileNotFound:
        throw PipeAbsent(path);
      case errorPipeBusy:
        final left = deadline - now();
        if (left <= 0) throw PipeBusy(path);
        // Whatever the wait says, CreateFileW is asked again: it alone says
        // reliably what is there now (the pipe may have gone meanwhile).
        io.waitFree(path, left);
      default:
        throw PipeOpenFailed(path, opened.error);
    }
  }
}

/// How a read loop ended.
enum PipeEnd {
  /// The daemon closed its end: the end of the stream.
  closedByPeer,

  /// This side cancelled the read, closing the connection.
  cancelled,
}

/// Reads [handle] until the daemon closes its end or the read is cancelled,
/// handing every chunk to [onData]. Any other failure is [PipeIoFailed].
PipeEnd pumpPipe(PipeIo io, int handle, void Function(Uint8List chunk) onData) {
  for (;;) {
    final got = io.read(handle, pipeChunkBytes);
    switch (got.error) {
      case 0:
        if (got.bytes.isNotEmpty) onData(got.bytes);
      case errorBrokenPipe || errorPipeNotConnected || errorNoData:
        return PipeEnd.closedByPeer;
      case errorOperationAborted:
        return PipeEnd.cancelled;
      default:
        throw PipeIoFailed(got.error);
    }
  }
}

/// Writes all of [bytes] to [handle], however many writes that takes. A daemon
/// that closed its end is [PipeBroken].
void writeAllToPipe(PipeIo io, int handle, Uint8List bytes) {
  var offset = 0;
  while (offset < bytes.length) {
    final wrote = io.write(handle, bytes, offset);
    switch (wrote.error) {
      case 0 when wrote.count > 0:
        offset += wrote.count;
      case errorBrokenPipe || errorNoData || errorPipeNotConnected:
        throw const PipeBroken();
      default:
        throw PipeIoFailed(wrote.error);
    }
  }
}

/// The daemon's Windows pipe as a [PipeStream] (spec §1.6), through kernel32
/// on two background isolates: their calls block, and the UI isolate never
/// may. One reads, blocked until bytes come; the other writes what [add] sends
/// it through a SendPort. The handle is overlapped, because a synchronous one
/// serialises a read and a write on it: a WebSocket waiting for the daemon
/// would hold up every keystroke.
class WindowsPipeConnection implements PipeStream {
  WindowsPipeConnection._(this.pipePath, this._factory) {
    // Awaited later, maybe after they failed: handled from the start.
    _opened.future.ignore();
    _writerReady.future.ignore();
  }

  final String pipePath;
  final PipeIo Function() _factory;
  final _input = StreamController<Uint8List>();
  final _fromReader = ReceivePort('harness pipe reader');
  final _fromWriter = ReceivePort('harness pipe writer');
  final _opened = Completer<void>();
  final _writerReady = Completer<void>();
  final _readerDone = Completer<void>();
  final _writerDone = Completer<void>();
  final _drains = <int, Completer<void>>{};
  var _nextDrain = 0;
  int? _handle;
  SendPort? _toWriter;
  PipeFailure? _writeFailed;
  Future<void>? _closing;
  PipeIo? _mainIo;
  var _starting = true;
  var _readerSpawned = false;
  var _writerSpawned = false;
  var _readEnded = false;
  var _cancelling = false;
  var _cleaned = false;
  Timer? _cancelTimer;

  @override
  Stream<Uint8List> get input => _input.stream;

  /// Opens the pipe at [pipePath]: [PipeAbsent] when nothing listens there,
  /// [PipeBusy] after [busyWait] of busy instances. [io] makes each isolate's
  /// kernel32 calls; it is sent to them, so it must be sendable between isolates.
  static Future<WindowsPipeConnection> open(
    String pipePath, {
    PipeIo Function()? io,
    Duration busyWait = defaultPipeBusyWait,
  }) async {
    final connection = WindowsPipeConnection._(pipePath, io ?? kernel32PipeIo);
    try {
      await connection._start(busyWait);
    } catch (_) {
      await connection.close();
      rethrow;
    }
    return connection;
  }

  Future<void> _start(Duration busyWait) async {
    _fromReader.listen(_onReader);
    _fromWriter.listen(_onWriter);
    try {
      await Isolate.spawn(
        _readerMain,
        (_fromReader.sendPort, pipePath, _factory, busyWait.inMilliseconds),
        debugName: 'harness pipe reader',
        onError: _fromReader.sendPort,
        onExit: _fromReader.sendPort,
      );
      _readerSpawned = true;
      await _opened.future;
      // A peer can close as soon as CreateFileW returns. Do not launch a new
      // handle user after shutdown has already begun.
      if (_readEnded) return;
      await Isolate.spawn(
        _writerMain,
        (_fromWriter.sendPort, _handle!, _factory),
        debugName: 'harness pipe writer',
        onError: _fromWriter.sendPort,
        onExit: _fromWriter.sendPort,
      );
      _writerSpawned = true;
      await _writerReady.future;
    } finally {
      _starting = false;
      if (_readEnded || _writeFailed != null) unawaited(close());
    }
  }

  void _onReader(Object? message) {
    switch (message) {
      case ('opened', final int handle):
        _handle = handle;
        _opened.complete();
      case ('data', final TransferableTypedData bytes):
        if (!_input.isClosed) _input.add(bytes.materialize().asUint8List());
      case ('failed', final String kind, final int code):
        final failure = switch (kind) {
          'absent' => PipeAbsent(pipePath),
          'busy' => PipeBusy(pipePath),
          'open' => PipeOpenFailed(pipePath, code),
          _ => PipeIoFailed(code),
        };
        _readerEnded(failure);
      case ('end', _):
        _readerEnded(null);
      case [_, _]:
        // An uncaught error in the reader (onError): its exit follows.
        _readerEnded(const PipeIoFailed(-1));
      case null:
        // The reader isolate has exited.
        _readerEnded(const PipeIoFailed(-1));
        if (!_readerDone.isCompleted) _readerDone.complete();
        _tryCleanup();
    }
  }

  /// The read loop is over: the stream ends, with [failure] first if any. A
  /// connection that was open closes itself, since nothing more will come.
  void _readerEnded(PipeFailure? failure) {
    if (_readEnded) return;
    _readEnded = true;
    if (!_opened.isCompleted) {
      _opened.completeError(failure ?? const PipeIoFailed(-1));
    } else if (!_input.isClosed) {
      if (failure != null && _closing == null) _input.addError(failure);
      unawaited(_input.close());
    }
    if (!_starting) unawaited(close());
  }

  void _onWriter(Object? message) {
    switch (message) {
      case ('ready', final SendPort port):
        _toWriter = port;
        _writerReady.complete();
      case ('drained', final int id):
        _drains.remove(id)?.complete();
      case ('failed', final int code):
        _writerFailed(
          code == errorBrokenPipe ? const PipeBroken() : PipeIoFailed(code),
        );
      case [_, _]:
        _writerFailed(const PipeIoFailed(-1));
      case null:
        if (!_writerReady.isCompleted) {
          _writerReady.completeError(const PipeIoFailed(-1));
        } else if (_closing == null && _writeFailed == null) {
          _writerFailed(const PipeIoFailed(-1));
        }
        _settleDrains();
        if (!_writerDone.isCompleted) _writerDone.complete();
        _tryCleanup();
    }
  }

  void _writerFailed(PipeFailure failure) {
    if (_writeFailed != null) return;
    _writeFailed = failure;
    if (!_writerReady.isCompleted) {
      _writerReady.completeError(failure);
    } else {
      if (!_input.isClosed && _closing == null) _input.addError(failure);
      if (!_starting) unawaited(close());
    }
    _settleDrains();
  }

  void _settleDrains() {
    for (final drain in _drains.values) {
      if (!drain.isCompleted) drain.complete();
    }
    _drains.clear();
  }

  @override
  void add(List<int> bytes) {
    final port = _toWriter;
    if (port == null || _closing != null || bytes.isEmpty) return;
    final chunk = bytes is Uint8List ? bytes : Uint8List.fromList(bytes);
    port.send(('write', TransferableTypedData.fromList([chunk])));
  }

  /// Stops accepting writes and waits at most two seconds for their drain,
  /// then at most two more for cancellation. Handle/resource cleanup continues
  /// after that bound if either isolate is still finishing its kernel call.
  @override
  Future<void> close() => _closing ??= _shutdown();

  Future<void> _shutdown() async {
    final port = _toWriter;
    if (port != null) {
      // What add() was given reaches the pipe first, for a bounded while.
      if (_writeFailed == null) {
        final id = _nextDrain++;
        final drained = _drains[id] = Completer<void>();
        port.send(('drain', id));
        await drained.future.timeout(_settle, onTimeout: () {});
      }
      port.send(('stop',));
    }
    // Cancellation is a request, not completion. Keep observing both isolates
    // after close's bounded wait, and retry a cancel that landed between reads.
    _cancelling = true;
    _cancelPending();
    _tryCleanup();
    if (!_cleaned) {
      _cancelTimer = Timer.periodic(const Duration(milliseconds: 100), (_) {
        _cancelPending();
        _tryCleanup();
      });
      await Future.wait<void>([
        if (_readerSpawned) _readerDone.future,
        if (_writerSpawned) _writerDone.future,
      ]).timeout(_settle, onTimeout: () => <void>[]);
      _tryCleanup();
    }
    // A delayed driver must not hold up callers or stream completion. Its
    // handle, ports and allocations stay owned until the real exits arrive.
    if (!_input.isClosed) unawaited(_input.close());
  }

  void _cancelPending() {
    final handle = _handle;
    if (handle != null && !_cleaned) {
      (_mainIo ??= _factory()).cancel(handle);
    }
  }

  void _tryCleanup() {
    if (_cleaned || !_cancelling || _starting) return;
    if (_readerSpawned && !_readerDone.isCompleted) return;
    if (_writerSpawned && !_writerDone.isCompleted) return;
    _cleaned = true;
    _cancelTimer?.cancel();
    // Neither isolate can ever use this numeric handle again. Windows may
    // recycle it immediately after CloseHandle.
    final handle = _handle;
    if (handle != null) (_mainIo ??= _factory()).close(handle);
    _fromReader.close();
    _fromWriter.close();
    _settleDrains();
    if (!_input.isClosed) unawaited(_input.close());
    _mainIo?.dispose();
  }

  static const _settle = Duration(seconds: 2);
}

/// The reader isolate: opens the pipe, says so, then reads until the end.
void _readerMain((SendPort, String, PipeIo Function(), int) start) {
  final (main, path, factory, busyWaitMs) = start;
  final io = factory();
  try {
    final int handle;
    try {
      handle = openPipeHandle(io, path, busyWaitMs: busyWaitMs);
    } on PipeAbsent {
      main.send(('failed', 'absent', errorFileNotFound));
      return;
    } on PipeBusy {
      main.send(('failed', 'busy', errorPipeBusy));
      return;
    } on PipeOpenFailed catch (failure) {
      main.send(('failed', 'open', failure.code));
      return;
    }
    main.send(('opened', handle));
    try {
      final end = pumpPipe(io, handle, (chunk) {
        main.send(('data', TransferableTypedData.fromList([chunk])));
      });
      main.send(('end', end.name));
    } on PipeIoFailed catch (failure) {
      main.send(('failed', 'io', failure.code));
    }
  } finally {
    io.dispose();
  }
}

/// The writer isolate: writes each chunk it is sent, in order, until stopped.
void _writerMain((SendPort, int, PipeIo Function()) start) {
  final (main, handle, factory) = start;
  final io = factory();
  final inbox = ReceivePort('harness pipe writes');
  var failed = false;
  inbox.listen((message) {
    switch (message) {
      case ('write', final TransferableTypedData bytes):
        if (failed) return;
        try {
          writeAllToPipe(io, handle, bytes.materialize().asUint8List());
        } on PipeBroken {
          failed = true;
          main.send(('failed', errorBrokenPipe));
        } on PipeIoFailed catch (failure) {
          failed = true;
          main.send(('failed', failure.code));
        } catch (_) {
          // Keep the inbox alive for stop so even an unexpected failure frees
          // this isolate's event/OVERLAPPED storage before its exit is observed.
          failed = true;
          main.send(('failed', -1));
        }
      case ('drain', final int id):
        main.send(('drained', id));
      case ('stop',):
        inbox.close();
        io.dispose();
    }
  });
  main.send(('ready', inbox.sendPort));
}
