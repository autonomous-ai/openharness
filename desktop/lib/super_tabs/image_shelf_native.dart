import 'dart:io';
import 'dart:typed_data';

import '../core/harness_file_store.dart';
import '../core/posix_file_mode.dart';
import '../logging/app_log.dart';
import 'image_cache.dart';

/// A computer keeps its chat pictures on disk, up to the cache's cap.
const kDefaultShelfBytes = kSuperTabImageCacheBytes;

/// `~/.harness/desktop-app/image-cache/`.
SuperTabImageShelf defaultImageShelf() => DirectoryImageShelf(
  Directory(
    '${HarnessFileStore.defaultDirectoryPath()}'
    '${Platform.pathSeparator}image-cache',
  ),
);

/// The chat's pictures in a folder of their own, kept to this user (0700, each
/// file 0600 from its first byte) since they are the account's content. Each
/// write goes to a temporary of its own and is renamed into place, so two
/// windows never read half a picture; the time a file was last changed is
/// when it was last shown.
class DirectoryImageShelf implements SuperTabImageShelf {
  DirectoryImageShelf(this.directory);

  final Directory directory;

  static const _part = '.part';

  String _path(String name) => '${directory.path}${Platform.pathSeparator}$name';

  @override
  Future<List<SuperTabShelfEntry>> list() async {
    final entries = <SuperTabShelfEntry>[];
    try {
      await for (final entry in directory.list()) {
        if (entry is! File) continue;
        final name = entry.uri.pathSegments.last;
        // A write a stop left half done: never a picture.
        if (name.endsWith(_part)) {
          await _delete(entry);
          continue;
        }
        try {
          final stat = await entry.stat();
          entries.add(
            SuperTabShelfEntry(
              name: name,
              bytes: stat.size,
              usedAt: stat.modified,
            ),
          );
        } on FileSystemException {
          // Gone under the listing: another window evicted it.
        }
      }
    } on PathNotFoundException {
      return const [];
    }
    return entries;
  }

  @override
  Future<Uint8List?> read(String name) async {
    try {
      return await File(_path(name)).readAsBytes();
    } on PathNotFoundException {
      return null;
    }
  }

  @override
  Future<void> write(String name, Uint8List bytes) async {
    await directory.create(recursive: true);
    _restrict(directory.path, 0x1c0);
    final temporary = File(
      _path('$name.$pid.${DateTime.now().microsecondsSinceEpoch}$_part'),
    );
    try {
      if (PosixFileMode.supported) {
        PosixFileMode.createExclusive(temporary.path, 0x180);
      }
      await temporary.writeAsBytes(bytes, flush: true);
      await temporary.rename(_path(name));
    } catch (_) {
      await _delete(temporary);
      rethrow;
    }
  }

  @override
  Future<void> touch(String name) async {
    try {
      await File(_path(name)).setLastModified(DateTime.now());
    } on FileSystemException {
      // Evicted meanwhile: nothing to mark.
    }
  }

  @override
  Future<void> delete(String name) => _delete(File(_path(name)));

  @override
  Future<void> clear() async {
    try {
      await directory.delete(recursive: true);
    } on PathNotFoundException {
      // Nothing was kept.
    }
  }

  static Future<void> _delete(File file) async {
    try {
      await file.delete();
    } on PathNotFoundException {
      // Already gone: another window evicted it.
    } on FileSystemException catch (error) {
      appLog.warn(
        'super-tabs',
        'image cache file not deleted: '
            '${error.osError?.message ?? error.runtimeType}',
      );
    }
  }

  /// Windows has no POSIX modes, and a phone's sandbox is already the app's.
  static void _restrict(String path, int mode) {
    if (!PosixFileMode.supported) return;
    if (FileStat.statSync(path).mode & 0xfff == mode) return;
    PosixFileMode.chmod(path, mode);
  }
}
