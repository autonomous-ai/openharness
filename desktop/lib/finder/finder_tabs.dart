import 'package:flutter/foundation.dart';
import 'package:path/path.dart' as p;

import 'finder_diff_document.dart';
import 'finder_document.dart';
import 'finder_models.dart';

/// One tab of a Finder tile's editor area: a file to edit, or a change's
/// diff. Exactly one of [document] and [diff] is set.
class FinderTab {
  FinderTab.file(FinderDocument file)
    : id = finderFileTabId(file.path),
      path = file.path,
      document = file,
      diff = null;

  FinderTab.diff(FinderDiffDocument change)
    : id = finderDiffTabId(change.change),
      path = change.path,
      document = null,
      diff = change;

  final String id;

  /// The file the tab is about, absolute.
  final String path;
  final FinderDocument? document;
  final FinderDiffDocument? diff;

  /// A preview tab is the one a single click replaces; editing, a double
  /// click or opening it again pins it — Orca's preview tabs.
  bool preview = false;

  String get title => p.basename(path);
  bool get dirty => document?.dirty ?? false;

  void dispose() {
    document?.dispose();
    diff?.dispose();
  }
}

/// The open tabs of one Finder tile and which is in front.
class FinderTabs extends ChangeNotifier {
  final List<FinderTab> tabs = [];
  String? activeId;

  FinderTab? get active => tabs.where((tab) => tab.id == activeId).firstOrNull;

  FinderTab? byId(String id) => tabs.where((tab) => tab.id == id).firstOrNull;

  /// Brings the tab [id] to the front, making it with [create] when it is not
  /// open. A preview takes the place of the current preview tab, unless that
  /// one has edits.
  FinderTab open(
    String id,
    FinderTab Function() create, {
    required bool preview,
  }) {
    if (byId(id) case final open?) {
      if (!preview) open.preview = false;
      activate(id);
      return open;
    }
    final tab = create()..preview = preview;
    final replaced = preview
        ? tabs.indexWhere((t) => t.preview && !t.dirty)
        : -1;
    if (replaced >= 0) {
      tabs[replaced].dispose();
      tabs[replaced] = tab;
    } else {
      final at = tabs.indexWhere((t) => t.id == activeId);
      tabs.insert(at < 0 ? tabs.length : at + 1, tab);
    }
    activate(tab.id);
    return tab;
  }

  void activate(String id) {
    activeId = id;
    notifyListeners();
  }

  void pin(String id) {
    final tab = byId(id);
    if (tab == null || !tab.preview) return;
    tab.preview = false;
    notifyListeners();
  }

  /// Closes [id]; the tab to its right — or else its left — comes forward.
  void close(String id) {
    final index = tabs.indexWhere((tab) => tab.id == id);
    if (index < 0) return;
    tabs.removeAt(index).dispose();
    if (activeId == id) {
      activeId = tabs.isEmpty ? null : tabs[index.clamp(0, tabs.length - 1)].id;
    }
    notifyListeners();
  }

  /// Every tab about [path] or anything under it — what a rename or a trash
  /// of that path closes.
  List<FinderTab> under(String path) => [
    for (final tab in tabs)
      if (tab.path == path || p.isWithin(path, tab.path)) tab,
  ];

  @override
  void dispose() {
    for (final tab in tabs) {
      tab.dispose();
    }
    super.dispose();
  }
}

/// The id a change's diff tab has, so a click finds it already open.
String finderDiffTabId(GitChange change) =>
    'diff:${change.area.name}:${change.path}';

/// The id a file's tab has.
String finderFileTabId(String path) => 'file:$path';
