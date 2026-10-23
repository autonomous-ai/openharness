import 'package:path/path.dart' as p;

import 'finder_controller.dart';
import 'finder_files.dart';
import 'finder_models.dart';

/// What the tree's menu and the Changes rows do to files. Each answers why
/// it failed, or null, and leaves the refresh to the watcher and Git.
extension FinderFileActions on FinderController {
  /// Makes [name] in [folder] — a file opened in a pinned tab, or a folder
  /// opened in the tree.
  Future<String?> create(
    String folder,
    String name, {
    required bool asFolder,
  }) => _attempt(() async {
    final path = p.join(folder, _validName(name));
    if (asFolder) {
      await files.createFolder(path);
    } else {
      await files.createFile(path);
    }
    await tree.refresh({folder});
    if (folder != root) await tree.expand(folder);
    if (!asFolder) openFile(path, preview: false);
  });

  /// Renames [path] in place. Its open tabs close: they name the old path.
  Future<String?> rename(String path, String name) => _attempt(() async {
    final target = p.join(p.dirname(path), _validName(name));
    if (target == path) return;
    if (tabs.under(path).any((tab) => tab.dirty)) {
      throw const FinderException('Save or close its changed tabs first.');
    }
    await files.rename(path, target);
    for (final tab in tabs.under(path)) {
      tabs.close(tab.id);
    }
    await tree.refresh({p.dirname(path)});
  });

  /// Moves [path] to the Trash, closing its tabs.
  Future<String?> trash(String path) => _attempt(() async {
    await files.trash(path);
    for (final tab in tabs.under(path)) {
      tabs.close(tab.id);
    }
    await tree.refresh({p.dirname(path)});
    await git.refresh();
  });

  /// Throws away [changes]: tracked files go back to what the index has,
  /// untracked ones go to the Trash — never deleted outright.
  Future<String?> discard(List<GitChange> changes) => _attempt(() async {
    final repository = git.repository;
    if (repository == null) return;
    for (final change in changes.where((c) => c.area == GitArea.untracked)) {
      await files.trash(p.join(repository.root, change.path));
    }
    await git.discard([
      for (final change in changes)
        if (change.area == GitArea.unstaged) change,
    ]);
  });

  Future<String?> stage(List<GitChange> changes) =>
      _attempt(() => git.stage(changes));

  Future<String?> unstage(List<GitChange> changes) =>
      _attempt(() => git.unstage(changes));

  Future<String?> _attempt(Future<void> Function() action) async {
    try {
      await action();
      return null;
    } on FinderException catch (error) {
      return error.message;
    }
  }
}

String _validName(String name) {
  final trimmed = name.trim();
  if (trimmed.isEmpty || trimmed == '.' || trimmed == '..') {
    throw const FinderException('Enter a name.');
  }
  if (trimmed.contains('/') || trimmed.contains('\u0000')) {
    throw const FinderException('A name can’t contain “/”.');
  }
  return trimmed;
}
