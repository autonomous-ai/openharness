import 'dart:convert';
import 'dart:ffi';
import 'dart:io';

import 'package:ffi/ffi.dart';

import 'log_append_io.dart' as fallback;

/// Dart's FileMode.append seeks to EOF when opening, rather than using
/// O_APPEND. Another window can append between that seek and the write,
/// causing the two writers to overwrite each other. Use a kernel append on
/// the desktop POSIX hosts; no file lock or polling is needed.
void appendDurableLog(File file, String contents) {
  if (!Platform.isMacOS && !Platform.isLinux) {
    fallback.appendDurableLog(file, contents);
    return;
  }
  _posix.append(file.path, contents);
}

final _posix = _PosixAppend();

class _PosixAppend {
  final _library = DynamicLibrary.process();
  late final _open = _library
      .lookupFunction<
        Int Function(Pointer<Utf8>, Int, VarArgs<(Int,)>),
        int Function(Pointer<Utf8>, int, int)
      >('open');
  late final _write = _library
      .lookupFunction<
        IntPtr Function(Int, Pointer<Uint8>, UintPtr),
        int Function(int, Pointer<Uint8>, int)
      >('write');
  late final _sync = _library
      .lookupFunction<Int Function(Int), int Function(int)>('fsync');
  late final _close = _library
      .lookupFunction<Int Function(Int), int Function(int)>('close');
  late final _errno = _library
      .lookupFunction<Pointer<Int> Function(), Pointer<Int> Function()>(
        Platform.isMacOS ? '__error' : '__errno_location',
      );

  void append(String path, String contents) {
    if (path.contains('\u0000')) {
      throw ArgumentError.value(path, 'path', 'Contains a NUL byte');
    }
    final bytes = utf8.encode(contents);
    using((arena) {
      final name = path.toNativeUtf8(allocator: arena);
      final data = arena<Uint8>(bytes.length);
      data.asTypedList(bytes.length).setAll(0, bytes);
      // O_WRONLY | O_CREAT | O_APPEND | O_CLOEXEC. The descriptor never
      // escapes a call, even on a partial write, signal or disk failure.
      final flags = Platform.isMacOS
          ? 0x1 | 0x200 | 0x8 | 0x1000000
          : 0x1 | 0x40 | 0x400 | 0x80000;
      final close = _close;
      final fd = _retry(() => _open(name, flags, 0x1b6), path);
      try {
        var offset = 0;
        while (offset < bytes.length) {
          final written = _retry(
            () => _write(fd, data + offset, bytes.length - offset),
            path,
          );
          if (written == 0) {
            throw FileSystemException('Log append made no progress', path);
          }
          offset += written;
        }
        _retry(() => _sync(fd), path);
      } finally {
        // Do not retry close on EINTR: the fd may already have been released
        // and reused by another thread.
        close(fd);
      }
    });
  }

  int _retry(int Function() operation, String path) {
    final readErrno = _errno;
    while (true) {
      final result = operation();
      if (result >= 0) return result;
      final error = readErrno().value;
      if (error == 4) continue; // EINTR
      throw FileSystemException(
        'Could not append or flush diagnostic log',
        path,
        OSError('POSIX log write failed', error),
      );
    }
  }
}
