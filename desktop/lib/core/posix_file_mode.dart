import 'dart:ffi';
import 'dart:io';

import 'package:ffi/ffi.dart';

/// `chmod(2)`, and a new file created with an exact mode, from libc.
///
/// `HarnessFileStore` set its 0600/0700 modes by running `/bin/chmod`, and
/// every `state.json` write needed one: `writeAsString` created the temporary
/// file 0644. Dart starts a process synchronously on the calling isolate: it
/// forks and waits for the child to exec before `Process.run` returns. On
/// macOS and Linux the UI isolate runs on the platform main thread (Flutter
/// 3.47), so each write held up the frame and the native event loop until
/// another process had been scheduled. On a loaded 16-core Mac (load 29, a
/// 490 MiB Dart VM, 2026-10-18) that synchronous part took 0.22 ms median,
/// 0.33 ms p95 and up to 18–43 ms; this binding's chmod took 0.04 ms median,
/// 0.07 ms p95. Linux was not measured.
abstract final class PosixFileMode {
  /// Where the binding below is known to match libc. Other hosts keep their
  /// own fallback.
  static bool get supported => Platform.isMacOS || Platform.isLinux;

  /// `chmod(path, mode)`. Throws a [FileSystemException] on failure.
  static void chmod(String path, int mode) => _libc.chmod(path, mode);

  /// Creates [path], which must not exist yet, as an empty file of exactly
  /// [mode]: `fchmod` after `open`, so the umask cannot change it.
  static void createExclusive(String path, int mode) =>
      _libc.createExclusive(path, mode);
}

final _libc = _Libc();

final class _Libc {
  final _library = DynamicLibrary.process();
  late final _open = _library
      .lookupFunction<
        Int Function(Pointer<Utf8>, Int, VarArgs<(Int,)>),
        int Function(Pointer<Utf8>, int, int)
      >('open');
  late final _close = _library
      .lookupFunction<Int Function(Int), int Function(int)>('close');
  // mode_t is 16 bits on macOS and 32 on Linux.
  late final int Function(Pointer<Utf8>, int) _chmod = Platform.isMacOS
      ? _library.lookupFunction<
          Int Function(Pointer<Utf8>, Uint16),
          int Function(Pointer<Utf8>, int)
        >('chmod')
      : _library.lookupFunction<
          Int Function(Pointer<Utf8>, Uint32),
          int Function(Pointer<Utf8>, int)
        >('chmod');
  late final int Function(int, int) _fchmod = Platform.isMacOS
      ? _library
            .lookupFunction<Int Function(Int, Uint16), int Function(int, int)>(
              'fchmod',
            )
      : _library
            .lookupFunction<Int Function(Int, Uint32), int Function(int, int)>(
              'fchmod',
            );
  late final _errno = _library
      .lookupFunction<Pointer<Int> Function(), Pointer<Int> Function()>(
        Platform.isMacOS ? '__error' : '__errno_location',
      );

  void chmod(String path, int mode) => using((arena) {
    final name = _name(path, arena);
    _retry(() => _chmod(name, mode), path, mode);
  });

  void createExclusive(String path, int mode) => using((arena) {
    final name = _name(path, arena);
    // O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC.
    final flags = Platform.isMacOS
        ? 0x1 | 0x200 | 0x800 | 0x1000000
        : 0x1 | 0x40 | 0x80 | 0x80000;
    final fd = _retry(() => _open(name, flags, mode), path, mode);
    final close = _close;
    try {
      _retry(() => _fchmod(fd, mode), path, mode);
    } finally {
      // Not retried on EINTR: the descriptor may already be released.
      close(fd);
    }
  });

  Pointer<Utf8> _name(String path, Arena arena) {
    if (path.contains('\u0000')) {
      throw ArgumentError.value(path, 'path', 'Contains a NUL byte');
    }
    return path.toNativeUtf8(allocator: arena);
  }

  int _retry(int Function() call, String path, int mode) {
    final readErrno = _errno;
    while (true) {
      final result = call();
      if (result >= 0) return result;
      final error = readErrno().value;
      if (error == 4) continue; // EINTR
      throw FileSystemException(
        'Could not set mode ${mode.toRadixString(8)}',
        path,
        OSError('POSIX mode change failed', error),
      );
    }
  }
}
