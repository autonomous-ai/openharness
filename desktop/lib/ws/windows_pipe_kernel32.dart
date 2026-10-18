import 'dart:ffi';
import 'dart:io';
import 'dart:math' as math;
import 'dart:typed_data';

import 'package:ffi/ffi.dart';
import 'package:path/path.dart' as p;

import 'windows_pipe.dart';

/// The real [PipeIo]: kernel32, on the isolate that calls it. Only Windows
/// has it; elsewhere nothing calls this, and kernel32 is never loaded.
PipeIo kernel32PipeIo() => _Kernel32PipeIo();

const _infinite = 0xFFFFFFFF;
const _waitObject0 = 0;

// What a finished overlapped call leaves in OVERLAPPED.Internal (ntstatus.h).
const _statusSuccess = 0x00000000;
const _statusBufferOverflow = 0x80000005;
const _statusEndOfFile = 0xC0000011;
const _statusPipeDisconnected = 0xC00000B0;
const _statusPipeClosing = 0xC00000B1;
const _statusPipeBroken = 0xC000014B;
const _statusCancelled = 0xC0000120;

/// OVERLAPPED on a 64-bit Windows (x64 and arm64), 32 bytes.
final class _Overlapped extends Struct {
  @IntPtr()
  external int internal;
  @IntPtr()
  external int internalHigh;
  @Uint32()
  external int offset;
  @Uint32()
  external int offsetHigh;
  @IntPtr()
  external int hEvent;
}

final _kernel32 = DynamicLibrary.open('kernel32.dll');

// Each operation and its error capture happen inside one native call. Nonleaf
// transitions may run VM work after return; the caller-owned error slot survives.
final _bridge = _PipeBridge(_loadBridge());

DynamicLibrary _loadBridge() {
  final override = Platform.environment['HARNESS_DESKTOP_PIPE_IO_DLL'];
  if (override != null &&
      (override.isEmpty || !p.isAbsolute(override) || p.isRootRelative(override))) {
    throw ArgumentError('HARNESS_DESKTOP_PIPE_IO_DLL must be an absolute path');
  }
  return DynamicLibrary.open(
    override ??
        p.join(p.dirname(Platform.resolvedExecutable), 'harness_pipe_io.dll'),
  );
}

final class _PipeBridge {
  _PipeBridge(DynamicLibrary dll)
    : open = dll
          .lookupFunction<
            IntPtr Function(Pointer<Utf16>, Pointer<Uint32>),
            int Function(Pointer<Utf16>, Pointer<Uint32>)
          >('harness_pipe_open_v1'),
      read = dll
          .lookupFunction<
            Int32 Function(
              IntPtr,
              Pointer<Uint8>,
              Uint32,
              Pointer<_Overlapped>,
              Pointer<Uint32>,
            ),
            int Function(
              int,
              Pointer<Uint8>,
              int,
              Pointer<_Overlapped>,
              Pointer<Uint32>,
            )
          >('harness_pipe_read_v1'),
      write = dll
          .lookupFunction<
            Int32 Function(
              IntPtr,
              Pointer<Uint8>,
              Uint32,
              Pointer<_Overlapped>,
              Pointer<Uint32>,
            ),
            int Function(
              int,
              Pointer<Uint8>,
              int,
              Pointer<_Overlapped>,
              Pointer<Uint32>,
            )
          >('harness_pipe_write_v1'),
      event = dll
          .lookupFunction<
            IntPtr Function(Pointer<Uint32>),
            int Function(Pointer<Uint32>)
          >('harness_pipe_create_event_v1');

  final int Function(Pointer<Utf16>, Pointer<Uint32>) open;
  final int Function(
    int,
    Pointer<Uint8>,
    int,
    Pointer<_Overlapped>,
    Pointer<Uint32>,
  )
  read;
  final int Function(
    int,
    Pointer<Uint8>,
    int,
    Pointer<_Overlapped>,
    Pointer<Uint32>,
  )
  write;
  final int Function(Pointer<Uint32>) event;
}

final _cancelIoEx = _kernel32
    .lookupFunction<
      Int32 Function(IntPtr, Pointer<_Overlapped>),
      int Function(int, Pointer<_Overlapped>)
    >('CancelIoEx', isLeaf: true);
final _closeHandle = _kernel32
    .lookupFunction<Int32 Function(IntPtr), int Function(int)>(
      'CloseHandle',
      isLeaf: true,
    );
final _waitNamedPipe = _kernel32
    .lookupFunction<
      Int32 Function(Pointer<Utf16>, Uint32),
      int Function(Pointer<Utf16>, int)
    >('WaitNamedPipeW');
final _waitForSingleObject = _kernel32
    .lookupFunction<Uint32 Function(IntPtr, Uint32), int Function(int, int)>(
      'WaitForSingleObject',
    );

final _nothing = Uint8List(0);

final class _Kernel32PipeIo implements PipeIo {
  factory _Kernel32PipeIo() {
    // Resolve every export before allocating resources or issuing any I/O.
    final native = _bridge;
    return _Kernel32PipeIo._(native, calloc<Uint32>());
  }

  _Kernel32PipeIo._(this._native, this._error);

  final _PipeBridge _native;
  Pointer<Uint32> _error;
  _Operation? _reading;
  _Operation? _writing;

  @override
  ({int handle, int error}) create(String path) {
    final name = path.toNativeUtf16(allocator: calloc);
    try {
      final handle = _native.open(name, _error);
      return (handle: handle, error: _error.value);
    } finally {
      calloc.free(name);
    }
  }

  @override
  bool waitFree(String path, int timeoutMs) {
    final name = path.toNativeUtf16(allocator: calloc);
    try {
      return _waitNamedPipe(name, timeoutMs) != 0;
    } finally {
      calloc.free(name);
    }
  }

  @override
  ({Uint8List bytes, int error}) read(int handle, int max) {
    final op = _reading ??= _Operation(_native, _error);
    op.arm();
    _native.read(
      handle,
      op.buffer,
      math.min(max, pipeChunkBytes),
      op.overlapped,
      _error,
    );
    final error = _error.value;
    if (error != 0 && error != errorIoPending && error != errorMoreData) {
      return (bytes: _nothing, error: error);
    }
    final status = op.finish(handle, pending: error == errorIoPending);
    return switch (status) {
      _statusSuccess || _statusBufferOverflow => (
        bytes: Uint8List.fromList(
          op.buffer.asTypedList(op.overlapped.ref.internalHigh),
        ),
        error: 0,
      ),
      _ => (bytes: _nothing, error: _errorOf(status)),
    };
  }

  @override
  ({int count, int error}) write(int handle, Uint8List bytes, int offset) {
    final op = _writing ??= _Operation(_native, _error);
    final length = math.min(bytes.length - offset, pipeChunkBytes);
    op.buffer.asTypedList(length).setRange(0, length, bytes, offset);
    op.arm();
    _native.write(handle, op.buffer, length, op.overlapped, _error);
    final error = _error.value;
    if (error != 0 && error != errorIoPending) {
      return (count: 0, error: error);
    }
    final status = op.finish(handle, pending: error == errorIoPending);
    return status == _statusSuccess
        ? (count: op.overlapped.ref.internalHigh, error: 0)
        : (count: 0, error: _errorOf(status));
  }

  @override
  void cancel(int handle) => _cancelIoEx(handle, nullptr);

  @override
  void close(int handle) => _closeHandle(handle);

  @override
  void dispose() {
    _reading?.free();
    _writing?.free();
    _reading = null;
    _writing = null;
    if (_error != nullptr) {
      calloc.free(_error);
      _error = nullptr;
    }
  }
}

/// The Windows error for an NTSTATUS a read or a write finished with.
int _errorOf(int status) => switch (status) {
  _statusPipeBroken ||
  _statusPipeDisconnected ||
  _statusPipeClosing ||
  _statusEndOfFile => errorBrokenPipe,
  _statusCancelled => errorOperationAborted,
  _ => status,
};

/// One overlapped read or write at a time: its buffer, its OVERLAPPED and the
/// event the kernel signals when it is done.
final class _Operation {
  factory _Operation(_PipeBridge native, Pointer<Uint32> error) {
    final event = native.event(error);
    if (event == 0) throw PipeIoFailed(error.value);
    Pointer<Uint8> buffer = nullptr;
    try {
      buffer = calloc<Uint8>(pipeChunkBytes);
      return _Operation._(buffer, calloc<_Overlapped>(), event);
    } catch (_) {
      if (buffer != nullptr) calloc.free(buffer);
      _closeHandle(event);
      rethrow;
    }
  }

  _Operation._(this.buffer, this.overlapped, this.event);

  final Pointer<Uint8> buffer;
  final Pointer<_Overlapped> overlapped;
  final int event;
  var _waitFailed = false;

  void arm() {
    if (_waitFailed) throw const PipeIoFailed(-1);
    overlapped.ref
      ..internal = 0
      ..internalHigh = 0
      ..offset = 0
      ..offsetHigh = 0
      ..hEvent = event;
  }

  /// Blocks this isolate until the call is done; its NTSTATUS, or -1 when the
  /// wait itself failed.
  int finish(int handle, {required bool pending}) {
    if (pending && _waitForSingleObject(event, _infinite) != _waitObject0) {
      // A failed wait cannot prove completion. Request cancellation but never
      // reuse/free memory that the kernel may still write. No GetLastError is
      // read after this non-leaf wait.
      _waitFailed = true;
      _cancelIoEx(handle, overlapped);
      return -1;
    }
    return overlapped.ref.internal & 0xFFFFFFFF;
  }

  void free() {
    if (_waitFailed) return;
    _closeHandle(event);
    calloc.free(buffer);
    calloc.free(overlapped);
  }
}
