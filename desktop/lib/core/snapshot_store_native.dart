import 'dart:io';

import 'harness_file_store.dart';
import 'snapshot_store.dart';

/// The real one: `~/.harness/desktop-app/<name>.json`.
///
/// Written to a temporary file and renamed, so a crash mid-write leaves the
/// previous snapshot rather than half of a new one.
class FileSnapshotStore implements SnapshotStore {
  FileSnapshotStore(this.name, {Directory? directory})
    : directory =
          directory ?? Directory(HarnessFileStore.defaultDirectoryPath());

  /// The basename, without `.json`.
  final String name;
  final Directory directory;

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
      final temporary = File('${file.path}.tmp');
      await temporary.writeAsString(contents, flush: true);
      await temporary.rename(file.path);
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
}
