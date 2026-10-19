import 'package:flutter/foundation.dart';
import 'package:flutter/scheduler.dart';

/// The panel searching a terminal, as the bar asking it sees it — see [TerminalFindController].
abstract interface class TerminalFindTarget {
  /// Find [query] (empty finds nothing), from where the reader is.
  void findQuery(String query);

  /// The next match (`1`) or the one before (`-1`), wrapping at either end.
  void findStep(int delta);
}

/// Find in terminal: the phone's half of the desktop's ⌘F, between the bar that asks and the panel
/// that searches.
///
/// ⚠️ **Two owners, one object.** The bar sits where the key bar does, at the page's foot over the
/// keyboard; the terminal it searches, its highlight and its scroll position are the panel's, several
/// widgets away — and the panel is the one that sees the terminal replaced by every keyframe (each
/// keyboard raised or lowered ends in one), which is when its search has to be rebuilt. So the bar
/// writes what to find here, the panel ([TerminalFindTarget]) does the finding with a
/// `TerminalSearch` and writes back what it found, and neither reaches into the other.
class TerminalFindController extends ChangeNotifier {
  String _query = '';
  int _count = 0;
  int _selected = -1;
  bool _searching = false;
  bool _hasSnapshot = false;
  TerminalFindTarget? _target;
  bool _disposed = false;

  /// What the bar is finding, as typed.
  String get query => _query;

  /// How many matches the panel found — 0 while none, or while nothing is asked.
  int get count => _count;

  /// The match the terminal shows, from 0, or -1 for none.
  int get selected => _selected;

  /// A scan still running, and whether its answer is in yet: until it is, the count is a guess.
  bool get searching => _searching;
  bool get hasSnapshot => _hasSnapshot;

  /// The desktop bar's count, in its words: empty with nothing asked, `…` while the first answer is
  /// on its way, then `3/12` — `0/0` for none.
  String get status => _query.isEmpty
      ? ''
      : _searching && !_hasSnapshot
      ? '…'
      : '${_selected + 1}/$_count';

  /// Nothing matches what was asked: the bar says so in red, as the desktop's does.
  bool get missed => _query.isNotEmpty && !_searching && _count == 0;

  /// The bar's words changed.
  void setQuery(String value) {
    if (value == _query) return;
    _query = value;
    _target?.findQuery(value);
    _notify();
  }

  /// ↓ and ↑. Nothing to step through says nothing.
  void next() => _target?.findStep(1);
  void previous() => _target?.findStep(-1);

  /// The panel taking the search on — at once with whatever was typed before it attached, so a bar
  /// opened over a pane that remounted keeps its words.
  void attach(TerminalFindTarget target) {
    _target = target;
    target.findQuery(_query);
  }

  /// The panel letting go. Only the panel that attached can: a remounted one attaches before the old
  /// one is disposed, and the old one's goodbye must not take the new one's place.
  void detach(TerminalFindTarget target) {
    if (!identical(_target, target)) return;
    _target = null;
    report(count: 0, selected: -1, searching: false, hasSnapshot: false);
  }

  /// What the panel found.
  void report({
    required int count,
    required int selected,
    required bool searching,
    required bool hasSnapshot,
  }) {
    if (count == _count &&
        selected == _selected &&
        searching == _searching &&
        hasSnapshot == _hasSnapshot) {
      return;
    }
    _count = count;
    _selected = selected;
    _searching = searching;
    _hasSnapshot = hasSnapshot;
    _notify();
  }

  /// After the frame when told mid-build: the panel reports from its search's listener, which a
  /// resize can fire during layout, and the bar rebuilding then would be a build inside a build.
  void _notify() {
    if (_disposed) return;
    if (SchedulerBinding.instance.schedulerPhase ==
        SchedulerPhase.persistentCallbacks) {
      SchedulerBinding.instance.addPostFrameCallback((_) {
        if (!_disposed) notifyListeners();
      });
      return;
    }
    notifyListeners();
  }

  @override
  void dispose() {
    _disposed = true;
    _target = null;
    super.dispose();
  }
}
