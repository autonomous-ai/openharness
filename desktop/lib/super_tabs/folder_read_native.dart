import 'dart:ffi';
import 'dart:io';
import 'dart:math';
import 'dart:typed_data';

import 'package:ffi/ffi.dart';

import 'folder_read.dart' show FolderFiles;
import 'folder_read_io.dart';

/// [path] held open as a folder: on macOS and Linux by its descriptor, each
/// file reached from it by `openat` with `O_NOFOLLOW` at every step, so a
/// link put in place of a file or folder after the listing is refused by the
/// kernel rather than followed. Windows reads by path ([IoFolderFiles]).
FolderFiles openFolder(String path) => Platform.isMacOS || Platform.isLinux
    ? _PosixFolderFiles(path)
    : IoFolderFiles(path);

final class _PosixFolderFiles implements FolderFiles {
  /// The dropped folder itself is not followed either: one swapped for a
  /// link before the zip opens it is refused (ELOOP), not read through.
  _PosixFolderFiles(String path)
    : _fd = _libc.open(path, _flags.directory | _flags.noFollow, path);

  final int _fd;

  @override
  Uint8List? read(List<String> inside, int maxBytes) {
    final opened = <int>[];
    try {
      var at = _fd;
      for (var i = 0; i < inside.length; i++) {
        final last = i == inside.length - 1;
        final fd = _libc.openAt(
          at,
          inside[i],
          last ? _flags.file : _flags.directory | _flags.noFollow,
          inside.take(i + 1).join('/'),
        );
        if (fd == null) return null;
        opened.add(at = fd);
      }
      return _libc.readAll(at, maxBytes + 1, inside.join('/'));
    } finally {
      opened.reversed.forEach(_libc.close);
    }
  }

  @override
  void close() => _libc.close(_fd);
}

/// `open(2)` flags; `O_NOFOLLOW` and `O_DIRECTORY` differ between Linux's
/// x86 and Arm ABIs.
final _flags = () {
  final arm = Abi.current() == Abi.linuxArm64 || Abi.current() == Abi.linuxArm;
  final (nonBlock, directory, noFollow, cloexec) = Platform.isMacOS
      ? (0x4, 0x100000, 0x100, 0x1000000)
      : arm
      ? (0x800, 0x4000, 0x8000, 0x80000)
      : (0x800, 0x10000, 0x20000, 0x80000);
  return (
    noFollow: noFollow,
    directory: directory | cloexec,
    // Non-blocking, so a pipe put in place of a file cannot hang the read.
    file: noFollow | nonBlock | cloexec,
  );
}();

/// What an `openat`/`read` refusal means here: the name is now a link
/// (ELOOP), a file where a folder was (ENOTDIR), a folder, pipe or socket
/// where a file was (EISDIR, EAGAIN, ENXIO). Anything else is a failure.
final _notPlain = Platform.isMacOS ? {62, 20, 21, 35, 6} : {40, 20, 21, 11, 6};
const _eintr = 4;

final _libc = _Libc();

final class _Libc {
  final _library = DynamicLibrary.process();
  late final _open = _library
      .lookupFunction<
        Int Function(Pointer<Utf8>, Int, VarArgs<(Int,)>),
        int Function(Pointer<Utf8>, int, int)
      >('open');
  late final _openat = _library
      .lookupFunction<
        Int Function(Int, Pointer<Utf8>, Int, VarArgs<(Int,)>),
        int Function(int, Pointer<Utf8>, int, int)
      >('openat');
  late final _read = _library
      .lookupFunction<
        IntPtr Function(Int, Pointer<Uint8>, Size),
        int Function(int, Pointer<Uint8>, int)
      >('read');
  late final _close = _library
      .lookupFunction<Int Function(Int), int Function(int)>('close');
  late final _errno = _library
      .lookupFunction<Pointer<Int> Function(), Pointer<Int> Function()>(
        Platform.isMacOS ? '__error' : '__errno_location',
      );

  int open(String path, int flags, String shown) => using((arena) {
    while (true) {
      final fd = _open(path.toNativeUtf8(allocator: arena), flags, 0);
      if (fd >= 0) return fd;
      final errno = _errno().value;
      if (errno != _eintr) throw _failure('open', shown, errno);
    }
  });

  /// [name] opened in folder [at], or null when it is not what [flags] ask.
  int? openAt(int at, String name, int flags, String shown) => using((arena) {
    while (true) {
      final fd = _openat(at, name.toNativeUtf8(allocator: arena), flags, 0);
      if (fd >= 0) return fd;
      final errno = _errno().value;
      if (_notPlain.contains(errno)) return null;
      if (errno != _eintr) throw _failure('open', shown, errno);
    }
  });

  /// Up to [limit] bytes of [fd], or null when it is not a plain file.
  Uint8List? readAll(int fd, int limit, String shown) => using((arena) {
    const chunk = 1 << 16;
    final buffer = arena<Uint8>(chunk);
    final bytes = BytesBuilder();
    while (bytes.length < limit) {
      final count = _read(fd, buffer, min(chunk, limit - bytes.length));
      if (count == 0) break;
      if (count < 0) {
        final errno = _errno().value;
        if (errno == _eintr) continue;
        if (_notPlain.contains(errno)) return null;
        throw _failure('read', shown, errno);
      }
      bytes.add(buffer.asTypedList(count));
    }
    return bytes.takeBytes();
  });

  void close(int fd) => _close(fd);

  FileSystemException _failure(String call, String path, int errno) =>
      FileSystemException('$call failed', path, OSError('', errno));
}
