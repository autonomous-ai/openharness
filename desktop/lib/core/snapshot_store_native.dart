import 'dart:io';

import 'harness_file_store.dart';
import 'posix_file_mode.dart';
import 'snapshot_store.dart';

/// The real one: `~/.harness/desktop-app/<name>.json`.
///
/// Written to a temporary file and renamed, so a crash mid-write leaves the
/// previous snapshot rather than half of a new one.
class FileSnapshotStore implements SnapshotStore {
  FileSnapshotStore(this.name, {Directory? directory, this.private = false})
    : directory =
          directory ?? Directory(HarnessFileStore.defaultDirectoryPath());

  /// The basename, without `.json`.
  final String name;
  final Directory directory;

  /// True keeps it to this user, as `state.json` is ([HarnessFileStore]): the
  /// directory 0700 and the file 0600 from its first byte, for a snapshot that
  /// holds an account's content.
  final bool private;

  File get file => File('${directory.path}/$name.json');

  @override
  Future<String?> read() async {
    try {
      final snapshot = file;
      if (!await snapshot.exists()) return null;
      return await snapshot.readAsString();
    } on Object {
      return null;
    }
  }

  @override
  Future<void> write(String contents) async {
    try {
      await directory.create(recursive: true);
      if (!private) {
        final temporary = File('${file.path}.tmp');
        await temporary.writeAsString(contents, flush: true);
        await temporary.rename(file.path);
        return;
      }
      await _restrict(directory.path, 0x1c0);
      // Its own temporary: two windows writing one at once must not write
      // into the same file.
      final temporary = File(
        '${file.path}.$pid.${DateTime.now().microsecondsSinceEpoch}.tmp',
      );
      try {
        if (PosixFileMode.supported) {
          PosixFileMode.createExclusive(temporary.path, 0x180);
        }
        await temporary.writeAsString(contents, flush: true);
        await _restrict(temporary.path, 0x180);
        await temporary.rename(file.path);
      } finally {
        if (await temporary.exists()) await temporary.delete();
      }
    } on Object {
      // A snapshot that could not be written costs the next launch a recompute
      // and nothing else, so it must not turn good work into a failure.
    }
  }

  @override
  Future<void> clear() async {
    try {
      if (await file.exists()) await file.delete();
    } on FileSystemException {
      // Whatever it held is off the screen either way, and the next write
      // replaces the file.
    }
  }

  /// Windows has no POSIX modes, and a phone's sandbox is already private to
  /// the app, as [HarnessFileStore] has it.
  static Future<void> _restrict(String path, int mode) async {
    if (!PosixFileMode.supported) return;
    if ((await FileStat.stat(path)).mode & 0xfff == mode) return;
    PosixFileMode.chmod(path, mode);
  }
}
