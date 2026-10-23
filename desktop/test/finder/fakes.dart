import 'dart:async';

import 'package:harness/finder/finder_files.dart';
import 'package:harness/finder/finder_git.dart';
import 'package:harness/finder/finder_models.dart';
import 'package:path/path.dart' as p;

/// An in-memory folder: `/r` holds `lib/main.dart` and `README.md`.
class FakeFinderFiles implements FinderFiles {
  final texts = <String, String>{
    '/r/README.md': '# Readme\n\nHello',
    '/r/lib/main.dart': 'void main() {}\n',
  };
  final folders = <String>{'/r', '/r/lib'};
  final stamps = <String, DiskStamp>{};
  final listed = <String>[];
  final writes = <String, String>{};
  final trashed = <String>[];
  final opened = <String>[];
  final disk = StreamController<Set<String>>.broadcast();
  int _clock = 0;

  DiskStamp _touch(String path) =>
      stamps[path] = DiskStamp(DateTime(2026, 10, 20, 0, 0, ++_clock), 1);

  /// Something other than the tile changed [path].
  void changeOnDisk(String path, String text) {
    texts[path] = text;
    _touch(path);
  }

  @override
  Future<List<FinderEntry>> list(String directory) async {
    listed.add(directory);
    return [
      for (final folder in folders.where(
        (f) => p.dirname(f) == directory && f != directory,
      ))
        FinderEntry(name: p.basename(folder), path: folder, isDirectory: true),
      for (final file in texts.keys.where((f) => p.dirname(f) == directory))
        FinderEntry(name: p.basename(file), path: file, isDirectory: false),
    ];
  }

  @override
  Future<FinderContent> read(String path) async {
    final text = texts[path];
    if (text == null) {
      throw const FinderException('This file no longer exists.');
    }
    return FinderText(text, stamps[path] ?? _touch(path));
  }

  @override
  Future<DiskStamp?> stamp(String path) async =>
      texts.containsKey(path) ? stamps[path] ?? _touch(path) : null;

  @override
  Future<DiskStamp> write(String path, String text) async {
    texts[path] = text;
    writes[path] = text;
    return _touch(path);
  }

  @override
  Future<void> createFile(String path) async {
    if (texts.containsKey(path)) {
      throw const FinderException('An item with this name already exists.');
    }
    texts[path] = '';
  }

  @override
  Future<void> createFolder(String path) async => folders.add(path);

  @override
  Future<void> rename(String from, String to) async {
    texts[to] = texts.remove(from)!;
  }

  @override
  Future<void> trash(String path) async {
    trashed.add(path);
    texts.remove(path);
  }

  @override
  Future<bool> open(String path) async {
    opened.add(path);
    return true;
  }

  @override
  Future<bool> reveal(String path) async => true;

  @override
  Stream<Set<String>> watch(String root) => disk.stream;
}

/// `/r` as a repository on `main`, one commit ahead, with `lib/main.dart`
/// edited.
class FakeFinderGit implements FinderGit {
  static const edited = GitChange(
    path: 'lib/main.dart',
    kind: GitChangeKind.modified,
    area: GitArea.unstaged,
    added: 1,
    removed: 1,
  );

  List<GitChange> current = [edited];
  final staged = <String>[];
  final unstaged = <String>[];
  final discarded = <String>[];
  Set<String> ignoredPaths = {};
  bool fail = false;
  int reads = 0;

  @override
  Future<GitChanges?> changes(String folder) async {
    reads++;
    if (fail) throw const FinderException('Git is gone.');
    return GitChanges(root: '/r', branch: 'main', ahead: 1, changes: current);
  }

  @override
  Future<Set<String>> ignored(
    GitChanges repository,
    List<FinderEntry> entries,
  ) async => entries.map((e) => e.path).where(ignoredPaths.contains).toSet();

  @override
  Future<List<DiffLine>> diff(GitChanges repository, GitChange change) async =>
      const [
        DiffLine(DiffLineKind.hunk, '@@ -1 +1 @@'),
        DiffLine(DiffLineKind.removed, 'old line', oldLine: 1),
        DiffLine(DiffLineKind.added, 'new line', newLine: 1),
      ];

  @override
  Future<void> stage(GitChanges repository, List<GitChange> changes) async =>
      staged.addAll(changes.map((c) => c.path));

  @override
  Future<void> unstage(GitChanges repository, List<GitChange> changes) async =>
      unstaged.addAll(changes.map((c) => c.path));

  @override
  Future<void> discard(GitChanges repository, List<GitChange> changes) async =>
      discarded.addAll(changes.map((c) => c.path));
}
