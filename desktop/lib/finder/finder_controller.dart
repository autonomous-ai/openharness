import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:path/path.dart' as p;

import 'finder_diff_document.dart';
import 'finder_document.dart';
import 'finder_files.dart';
import 'finder_git.dart';
import 'finder_git_state.dart';
import 'finder_load.dart';
import 'finder_models.dart';
import 'finder_tabs.dart';
import 'finder_tree.dart';
import 'finder_watch.dart' show isGitInternal;

/// The two halves of a Finder tile's sidebar.
enum FinderMode { files, changes }

/// How often the tile reads Git without being told to, as Orca's safety poll
/// does: the watcher can miss what another program did to the index.
const kFinderSafetyRefresh = Duration(seconds: 60);

/// Everything one Finder tile shows: its folder tree, its Git changes and
/// its open tabs — kept in step with the disk by a watcher.
class FinderController extends ChangeNotifier {
  FinderController({
    required this.root,
    required this.files,
    required FinderGit git,
  }) : git = FinderGitState(root, git) {
    tree = FinderTree(root, files, _notify)..onListed = this.git.markIgnored;
    this.git.addListener(_gitChanged);
  }

  final String root;
  final FinderFiles files;
  final FinderGitState git;
  final FinderTabs tabs = FinderTabs();
  late final FinderTree tree;

  FinderMode mode = FinderMode.files;

  /// Diffs show both sides in columns rather than one interleaved column.
  bool sideBySide = false;

  /// What the last action could not do, said at the foot of the sidebar
  /// until the next one or a few seconds pass.
  String? notice;
  Timer? _noticeTimer;

  StreamSubscription<Set<String>>? _watch;
  int _gitRevision = 0;
  Timer? _safety;
  bool _disposed = false;

  /// Reads the folder and its repository, then follows the disk.
  Future<void> start() async {
    _watch ??= files.watch(root).listen(onDiskChanged);
    _safety ??= Timer.periodic(kFinderSafetyRefresh, (_) => git.refresh());
    await refresh();
  }

  /// Reads everything again: the tree, the changes, the open diffs.
  Future<void> refresh() async {
    await Future.wait([tree.reload(), git.refresh()]);
    // Folders listed before Git answered have no ignored marks yet.
    final listed = [
      for (final row in tree.rows) row.entry,
      ...switch (tree.listingOf(root)) {
        FinderLoaded(:final value) => value,
        _ => const <FinderEntry>[],
      },
    ];
    await git.markIgnored(listed);
  }

  /// A batch of paths the watcher heard change.
  void onDiskChanged(Set<String> paths) {
    final project = paths.where((path) => !isGitInternal(path)).toSet();
    // A path's folder lists it; the path itself may be a folder whose own
    // entries moved (FSEvents reports the root that way). Only folders
    // already listed are read again.
    unawaited(
      tree.refresh({
        for (final path in project) ...[path, p.dirname(path)],
      }),
    );
    for (final tab in tabs.tabs) {
      if (project.contains(tab.path)) unawaited(tab.document?.diskChanged());
    }
    unawaited(git.refresh());
  }

  void setMode(FinderMode next) {
    if (mode == next) return;
    mode = next;
    _notify();
    if (next == FinderMode.changes) unawaited(git.refresh());
  }

  void toggleSideBySide() {
    sideBySide = !sideBySide;
    _notify();
  }

  /// Opens [path] in a tab — a preview unless [preview] is false.
  FinderTab openFile(String path, {bool preview = true}) =>
      tabs.open(finderFileTabId(path), () {
        final document = FinderDocument(path, files);
        document.addListener(() => _pinWhenEdited(document));
        unawaited(document.load());
        return FinderTab.file(document);
      }, preview: preview);

  /// Opens [change]'s diff in a tab.
  FinderTab openChange(GitChange change, {bool preview = true}) {
    final repository = git.repository;
    return tabs.open(finderDiffTabId(change), () {
      final diff = FinderDiffDocument(
        change,
        p.join(repository?.root ?? root, change.path),
        git.diff,
      );
      unawaited(diff.load());
      return FinderTab.diff(diff);
    }, preview: preview);
  }

  void say(String message) {
    notice = message;
    _noticeTimer?.cancel();
    _noticeTimer = Timer(const Duration(seconds: 6), () {
      notice = null;
      _notify();
    });
    _notify();
  }

  /// The path the tree highlights: the file in the front tab.
  String? get activePath => tabs.active?.path;

  /// Saves the front tab's file. Diffs of it follow through the watcher.
  Future<bool> saveActive() async =>
      await tabs.active?.document?.save() ?? false;

  void _pinWhenEdited(FinderDocument document) {
    final tab = tabs.byId(finderFileTabId(document.path));
    if (tab != null && tab.preview && document.dirty) tabs.pin(tab.id);
  }

  /// Open diffs read again whenever Git's status does, so a stage or a
  /// save shows in them.
  void _gitChanged() {
    if (git.revision != _gitRevision) {
      _gitRevision = git.revision;
      for (final tab in tabs.tabs) {
        unawaited(tab.diff?.load());
      }
    }
    _notify();
  }

  void _notify() {
    if (!_disposed) notifyListeners();
  }

  @override
  void dispose() {
    _disposed = true;
    _safety?.cancel();
    _noticeTimer?.cancel();
    unawaited(_watch?.cancel());
    git
      ..removeListener(_gitChanged)
      ..dispose();
    tabs.dispose();
    super.dispose();
  }
}
