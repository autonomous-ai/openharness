library;

import 'dart:async';

import 'package:flutter/foundation.dart';

import 'alert_sounds.dart';

/// One thing an agent did that is worth saying on screen.
@immutable
class AgentAlert {
  const AgentAlert({
    required this.machineId,
    required this.agentId,
    required this.title,
    required this.kind,
    required this.at,
  });

  final String machineId;
  final String agentId;

  /// What the agent is called, as the window calls it.
  final String title;
  final AlertKind kind;
  final DateTime at;

  /// One banner per AGENT, so a busy one replaces its own last message rather
  /// than stacking three of them. The kind is deliberately not part of this:
  /// an agent that finished and then asked a question has one current state,
  /// and the newer message is it.
  String get key => '$machineId/$agentId';

  /// What the banner says under the agent's name.
  String get sentence => switch (kind) {
    AlertKind.done => 'Finished',
    AlertKind.needsYou => 'Waiting on you',
  };
}

/// The banners currently on screen.
///
/// Its own notifier rather than app state: a banner appearing must not rebuild
/// the workspace, and an agent event already rebuilds enough.
class AgentAlerts extends ChangeNotifier {
  AgentAlerts({
    ScreenAlertStore? store,
    this.now = _systemNow,
    this.life = const Duration(seconds: 7),
    this.visible = 3,
  }) : store = store ?? screenAlertStore;

  static DateTime _systemNow() => DateTime.now();

  final ScreenAlertStore store;
  final DateTime Function() now;

  /// How long a banner stays before it withdraws on its own. Long enough to
  /// read a name and reach for it, short enough that a swarm does not leave a
  /// wall of them standing.
  final Duration life;

  /// How many are shown at once. Past this the oldest goes: a stack taller than
  /// this stops being a glance and starts being a list, and there is already a
  /// list — the workspace.
  final int visible;

  final _alerts = <AgentAlert>[];
  Timer? _sweep;

  /// Newest first, which is the order they are read in.
  List<AgentAlert> get alerts => List.unmodifiable(_alerts.reversed);

  /// Say something happened. Silent when the feature is off.
  void post(AgentAlert alert) {
    if (!store.value) return;
    // Sweep before adding. The timer is what takes a banner down while nothing else is happening,
    // but anything that touches the stack is also a chance to notice what has outlived its life —
    // and a window that was asleep, or a clock that is not the system's, may have left the timer
    // behind entirely.
    _dropExpired();
    _alerts.removeWhere((a) => a.key == alert.key);
    _alerts.add(alert);
    while (_alerts.length > visible) {
      _alerts.removeAt(0);
    }
    _schedule();
    notifyListeners();
  }

  /// Take one down — the person dealt with it, or dismissed it.
  void dismiss(AgentAlert alert) {
    final before = _alerts.length;
    _dropExpired();
    _alerts.removeWhere((a) => a.key == alert.key);
    if (_alerts.length == before) return;
    _schedule();
    notifyListeners();
  }

  void clear() {
    if (_alerts.isEmpty) return;
    _alerts.clear();
    _sweep?.cancel();
    _sweep = null;
    notifyListeners();
  }

  /// Drop whatever has outlived [life], and arrange to be called again while
  /// anything is still standing.
  ///
  /// One timer for the whole stack rather than one per banner: the banners come
  /// in bursts, and a timer each would be a timer per agent in a swarm.
  void _schedule() {
    _sweep?.cancel();
    _sweep = null;
    if (_alerts.isEmpty) return;
    final at = now();
    final oldest = _alerts.first.at;
    final left = life - at.difference(oldest);
    _sweep = Timer(left.isNegative ? Duration.zero : left, _expire);
  }

  /// Drop what has outlived [life]. Each banner is judged on ITS OWN age: a stack that expired
  /// together would take a notice raised a second ago down with one from a minute ago.
  bool _dropExpired() {
    final at = now();
    final before = _alerts.length;
    _alerts.removeWhere((a) => at.difference(a.at) >= life);
    return _alerts.length != before;
  }

  void _expire() {
    final changed = _dropExpired();
    _schedule();
    if (changed) notifyListeners();
  }

  @override
  void dispose() {
    _sweep?.cancel();
    super.dispose();
  }
}
