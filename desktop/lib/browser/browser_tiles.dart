/// Which agents' Browser tiles this window wants beside their terminals, by machine and agent, for this run only.
///
/// A Browser tile is a viewer, so it is never in the saved layout or the desk (`PaneKind`). Its agent's machine says
/// whether the browser is on, and that is what brings a tile back after a restart: a browser that is on opens its
/// tile, unless its person closed that tile while it ran. A tile opened by hand stays wanted, browser on or off, until
/// it is closed by hand. A browser seen off forgets that close, so its next start (a Start on another computer, its
/// agent running again) opens the tile again.
class BrowserTiles {
  /// The oldest note goes first once this many are kept: an agent stopped elsewhere may never say so here.
  static const capacity = 200;

  // Insertion-ordered, so the oldest is first.
  final _open = <(String, String)>{};
  final _closed = <(String, String)>{};

  /// Notes whether [agentId]'s browser is [on], and says whether its tile belongs beside its terminal.
  bool sync(String machineId, String agentId, {required bool on}) {
    final key = (machineId, agentId);
    if (!on) {
      _closed.remove(key);
    } else if (!_closed.contains(key)) {
      _keep(_open, key);
    }
    return _open.contains(key);
  }

  /// Its person opened it.
  void opened(String machineId, String agentId) {
    final key = (machineId, agentId);
    _closed.remove(key);
    _keep(_open, key);
  }

  /// Its person closed it, while its browser was [on] or off. The browser runs on.
  void closed(String machineId, String agentId, {required bool on}) {
    final key = (machineId, agentId);
    _open.remove(key);
    if (on) _keep(_closed, key);
  }

  /// The agent is gone.
  void forget(String machineId, String agentId) {
    _open.remove((machineId, agentId));
    _closed.remove((machineId, agentId));
  }

  /// The agent's pane became another agent (a Change agent): its tile is that agent's now.
  void move(String machineId, String from, String to) {
    for (final notes in [_open, _closed]) {
      if (notes.remove((machineId, from))) _keep(notes, (machineId, to));
    }
  }

  static void _keep(Set<(String, String)> notes, (String, String) key) {
    notes
      ..remove(key)
      ..add(key);
    while (notes.length > capacity) {
      notes.remove(notes.first);
    }
  }
}
