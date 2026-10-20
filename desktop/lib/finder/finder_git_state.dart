import 'package:flutter/foundation.dart';
import 'package:path/path.dart' as p;

import 'finder_files.dart' show FinderException;
import 'finder_git.dart';
import 'finder_load.dart';
import 'finder_models.dart';

/// Which status a file or folder shows when several apply — Orca's order:
/// a conflict over everything, a deletion over an edit, an edit over an add.
const _priority = [
  GitChangeKind.conflicted,
  GitChangeKind.deleted,
  GitChangeKind.modified,
  GitChangeKind.typeChanged,
  GitChangeKind.added,
  GitChangeKind.untracked,
  GitChangeKind.renamed,
  GitChangeKind.copied,
];

/// A Finder tile's view of its repository: the changes, the marks the tree
/// draws from them, and which listed entries Git ignores.
class FinderGitState extends ChangeNotifier {
  FinderGitState(this.root, this._git);

  final String root;
  final FinderGit _git;

  FinderLoad<GitChanges?> status = const FinderLoading();

  /// Counts status reads, so a listener can tell a new status from a new
  /// ignored mark.
  int revision = 0;
  Map<String, GitChangeKind> _files = const {};
  Map<String, GitChangeKind> _folders = const {};
  final Set<String> _ignored = {};
  Future<void>? _reading;
  bool _again = false;
  bool _disposed = false;

  GitChanges? get repository => switch (status) {
    FinderLoaded(:final value) => value,
    _ => null,
  };

  GitChangeKind? fileStatus(String path) => _files[path];

  /// A folder wears its most pressing child's status — never a deletion,
  /// since the deleted file is not in the folder to see.
  GitChangeKind? folderStatus(String path) => _folders[path];

  bool isIgnored(String path) => _ignored.contains(path);

  /// Reads the status again. Calls made while one read is running share the
  /// next read instead of starting their own — a save and a watcher batch in
  /// the same moment are one `git status`.
  Future<void> refresh() {
    if (_reading != null) {
      _again = true;
      return _reading!;
    }
    return _reading = _read().whenComplete(() {
      _reading = null;
      if (_again) {
        _again = false;
        refresh();
      }
    });
  }

  /// Marks which of [entries] Git ignores; the tree shows them faint.
  Future<void> markIgnored(List<FinderEntry> entries) async {
    final repository = this.repository;
    if (repository == null || entries.isEmpty) return;
    try {
      final ignored = await _git.ignored(repository, entries);
      for (final entry in entries) {
        ignored.contains(entry.path)
            ? _ignored.add(entry.path)
            : _ignored.remove(entry.path);
      }
      _notify();
    } on FinderException {
      // A mark, not content: without it the tree still reads.
    }
  }

  Future<void> stage(List<GitChange> changes) => _then(_git.stage, changes);
  Future<void> unstage(List<GitChange> changes) => _then(_git.unstage, changes);
  Future<void> discard(List<GitChange> changes) => _then(_git.discard, changes);

  Future<List<DiffLine>> diff(GitChange change) {
    final repository = this.repository;
    if (repository == null) {
      throw const FinderException('This folder is no longer in Git.');
    }
    return _git.diff(repository, change);
  }

  Future<void> _then(
    Future<void> Function(GitChanges, List<GitChange>) action,
    List<GitChange> changes,
  ) async {
    final repository = this.repository;
    if (repository == null) return;
    try {
      await action(repository, changes);
    } finally {
      await refresh();
    }
  }

  Future<void> _read() async {
    try {
      status = FinderLoaded(await _git.changes(root));
    } on FinderException catch (error) {
      status = FinderFailed(error.message);
    }
    _index(repository);
    revision++;
    _notify();
  }

  void _index(GitChanges? repository) {
    final files = <String, GitChangeKind>{};
    final folders = <String, GitChangeKind>{};
    for (final change in repository?.changes ?? const <GitChange>[]) {
      final path = p.join(repository!.root, change.path);
      files[path] = _stronger(files[path], change.kind);
      if (change.kind == GitChangeKind.deleted) continue;
      for (var dir = p.dirname(path); p.isWithin(root, dir) || dir == root;) {
        folders[dir] = _stronger(folders[dir], change.kind);
        if (dir == root) break;
        dir = p.dirname(dir);
      }
    }
    _files = files;
    _folders = folders;
  }

  void _notify() {
    if (!_disposed) notifyListeners();
  }

  @override
  void dispose() {
    _disposed = true;
    super.dispose();
  }
}

GitChangeKind _stronger(GitChangeKind? current, GitChangeKind next) =>
    current == null || _priority.indexOf(next) < _priority.indexOf(current)
    ? next
    : current;
