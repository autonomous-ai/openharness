import 'dart:ffi';
import 'dart:math' as math;
import 'dart:typed_data';

import 'package:ffi/ffi.dart';

import 'windows_pipe.dart';

/// The real [PipeIo]: kernel32, on the isolate that calls it. Only Windows
/// has it; elsewhere nothing calls this, and kernel32 is never loaded.
PipeIo kernel32PipeIo() => _Kernel32PipeIo();

const _genericRead = 0x80000000;
const _genericWrite = 0x40000000;
const _openExisting = 3;
const _fileFlagOverlapped = 0x40000000;

/// The daemon's end may only identify this process, never act as it: a
/// squatter on a dead daemon's name gets nothing to impersonate.
const _securitySqosPresent = 0x00100000;
const _securityIdentification = 0x00010000;
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

// The calls that return at once are leaf calls, and so is GetLastError, made
// straight after: nothing the VM does can come between them and change the
// thread's last error. The waits block, so they are not leaf calls, and what a
// read or a write did is read from the OVERLAPPED the kernel filled in, never
// from GetLastError after a wait.
final _createFile = _kernel32
    .lookupFunction<
      IntPtr Function(
        Pointer<Utf16>,
        Uint32,
        Uint32,
        Pointer<Void>,
        Uint32,
        Uint32,
        IntPtr,
      ),
      int Function(Pointer<Utf16>, int, int, Pointer<Void>, int, int, int)
    >('CreateFileW', isLeaf: true);
final _readFile = _kernel32
    .lookupFunction<
      Int32 Function(
        IntPtr,
        Pointer<Uint8>,
        Uint32,
        Pointer<Uint32>,
        Pointer<_Overlapped>,
      ),
      int Function(
        int,
        Pointer<Uint8>,
        int,
        Pointer<Uint32>,
        Pointer<_Overlapped>,
      )
    >('ReadFile', isLeaf: true);
final _writeFile = _kernel32
    .lookupFunction<
      Int32 Function(
        IntPtr,
        Pointer<Uint8>,
        Uint32,
        Pointer<Uint32>,
        Pointer<_Overlapped>,
      ),
      int Function(
        int,
        Pointer<Uint8>,
        int,
        Pointer<Uint32>,
        Pointer<_Overlapped>,
      )
    >('WriteFile', isLeaf: true);
final _getLastError = _kernel32
    .lookupFunction<Uint32 Function(), int Function()>(
      'GetLastError',
      isLeaf: true,
    );
final _createEvent = _kernel32
    .lookupFunction<
      IntPtr Function(Pointer<Void>, Int32, Int32, Pointer<Utf16>),
      int Function(Pointer<Void>, int, int, Pointer<Utf16>)
    >('CreateEventW', isLeaf: true);
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
  _Operation? _reading;
  _Operation? _writing;

  @override
  ({int handle, int error}) create(String path) {
    final name = path.toNativeUtf16(allocator: calloc);
    try {
      final handle = _createFile(
        name,
        _genericRead | _genericWrite,
        0, // no sharing
        nullptr,
        _openExisting,
        _fileFlagOverlapped | _securitySqosPresent | _securityIdentification,
        0,
      );
      if (handle == invalidPipeHandle) {
        return (handle: invalidPipeHandle, error: _getLastError());
      }
      return (handle: handle, error: 0);
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
    final op = _reading ??= _Operation();
    op.arm();
    final ok = _readFile(
      handle,
      op.buffer,
      math.min(max, pipeChunkBytes),
      nullptr,
      op.overlapped,
    );
    final error = ok == 0 ? _getLastError() : 0;
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
    final op = _writing ??= _Operation();
    final length = math.min(bytes.length - offset, pipeChunkBytes);
    op.buffer.asTypedList(length).setRange(0, length, bytes, offset);
    op.arm();
    final ok = _writeFile(handle, op.buffer, length, nullptr, op.overlapped);
    final error = ok == 0 ? _getLastError() : 0;
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
  factory _Operation() {
    final event = _createEvent(nullptr, 1, 0, nullptr);
    if (event == 0) throw PipeIoFailed(_getLastError());
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
