library;

import 'dart:async';
import 'dart:math';

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
    AlertKind.failed => 'Failed',
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

/// Which agents have news the person has not looked at yet.
///
/// Separate from [AgentAlerts] and from the sound, and NOT behind either of
/// their switches, because it is not an interruption: a banner appears over the
/// work and a sound reaches another room, while this is a mark that sits still
/// until somebody goes looking. Somebody who turned the noisy halves off still
/// wants the window to be able to say which agent moved while they were away.
class AgentUnread extends ChangeNotifier {
  /// Bound the desktop inbox independently of the dial's eight visible rows.
  /// A ninth notification must not silently replace the first on desktop.
  /// Entries remain per harness and in memory, with oldest-first eviction.
  static const capacity = 256;

  final _unread = <String, AlertKind>{};
  final _tokens = <String, String>{};
  final _messages = <String, String>{};
  final _receivedAt = <String, DateTime>{};
  final _epoch = List.generate(
    12,
    (_) => Random.secure().nextInt(256),
  ).map((n) => n.toRadixString(16).padLeft(2, '0')).join();
  int _sequence = 0;

  /// Identity of the notification, not its text. Two turns can say the same thing.
  String? readTokenFor(String machineId, String agentId) =>
      _tokens[keyFor(machineId, agentId)];

  /// The message belongs to this unread receipt, never the session's latest
  /// transcript (which may already describe a different turn).
  String? messageFor(String machineId, String agentId) =>
      _messages[keyFor(machineId, agentId)];
  DateTime? receivedAtFor(String machineId, String agentId) =>
      _receivedAt[keyFor(machineId, agentId)];

  static String keyFor(String machineId, String agentId) =>
      '$machineId/$agentId';

  /// How many agents are carrying something unread. Agents, not events — the
  /// number answers "how many should I look at", and an agent that finished
  /// three turns is still one place to go.
  int get count => _unread.length;

  bool get isEmpty => _unread.isEmpty;

  /// Every mark, NEWEST FIRST — the order the dial's drawer keeps.
  ///
  /// The key is `machineId/agentId`; [keyFor] made it and this is the one place
  /// that has to take it apart, so the split lives here rather than at the call
  /// site. A machine id never contains a slash (it is hex or a uuid).
  List<({String machineId, String agentId, AlertKind kind})> get newestFirst =>
      [
        for (final key in _unread.keys.toList().reversed)
          if (key.indexOf('/') > 0)
            (
              machineId: key.substring(0, key.indexOf('/')),
              agentId: key.substring(key.indexOf('/') + 1),
              kind: _unread[key]!,
            ),
      ];

  /// What this agent's mark says, or null when it has none.
  AlertKind? kindFor(String machineId, String agentId) =>
      _unread[keyFor(machineId, agentId)];

  /// Record that an agent did something. The NEWEST kind wins: an agent that
  /// finished and then asked a question is waiting on a person, and that is the
  /// mark worth showing.
  void mark(
    String machineId,
    String agentId,
    AlertKind kind, {
    bool fresh = false,
    String? message,
    DateTime? at,
  }) {
    final key = keyFor(machineId, agentId);
    if (!fresh && _unread[key] == kind) return;
    _tokens[key] = '$_epoch-${(++_sequence).toRadixString(36)}';
    _receivedAt[key] = at ?? DateTime.now();
    _messages.remove(key);
    if (message != null && message.trim().isNotEmpty) {
      _messages[key] = message.length > 600
          ? message.substring(0, 600)
          : message;
    }
    // Re-inserted, not updated in place: an agent that moved is the newest
    // again, which is what makes the first key the oldest for the eviction
    // below. `notif_push` on the dial does exactly this — it lifts an existing
    // row out before putting it back on top.
    _unread
      ..remove(key)
      ..[key] = kind;
    while (_unread.length > capacity) {
      _tokens.remove(_unread.keys.first);
      _messages.remove(_unread.keys.first);
      _receivedAt.remove(_unread.keys.first);
      _unread.remove(_unread.keys.first);
    }
    notifyListeners();
  }

  /// The person went and looked. Silent when there was nothing to clear, so a
  /// pane being focused for any other reason does not rebuild the window.
  void clear(String machineId, String agentId) {
    final key = keyFor(machineId, agentId);
    if (_unread.remove(key) == null) return;
    _tokens.remove(key);
    _messages.remove(key);
    _receivedAt.remove(key);
    notifyListeners();
  }

  /// An agent that no longer exists cannot be gone to. Called when one is
  /// deleted, so its mark does not sit in the count forever.
  void forget(String machineId, String agentId) => clear(machineId, agentId);

  void clearAll() {
    if (_unread.isEmpty) return;
    _unread.clear();
    _tokens.clear();
    _messages.clear();
    _receivedAt.clear();
    notifyListeners();
  }
}
