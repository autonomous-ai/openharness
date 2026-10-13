import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/foundation.dart';

/// Agent Messages (docs/design/2026-10-10-agent-messages.md) as this window
/// sees them: harnesses in a tab with Agent Messages on message each other with
/// `harness send`, and the daemons deliver. The window only shows it — each
/// tab's flag (the backend's, off unless a person turned it on), the traffic
/// the daemons report as `messages_changed`, a tab's log, and the marks a
/// message leaves on its panes. Nothing here composes or sends.

/// What became of a message for one recipient. A message never expires: it
/// stays queued until it is delivered, or fails for a reason a person can read.
enum AgentMessageState {
  queued,
  delivered,
  failed;

  static AgentMessageState? parse(Object? value) => switch (value) {
    'queued' => queued,
    'delivered' => delivered,
    'failed' => failed,
    _ => null,
  };
}

/// One end of a message: a harness on a machine, named as its daemon named it.
@immutable
class AgentMessageParty {
  const AgentMessageParty({
    required this.machineId,
    required this.agentId,
    this.name = '',
  });

  final String machineId, agentId;

  /// Empty when the frame carried no name (`messages_changed` names nobody).
  final String name;

  String get key => agentMessageKey(machineId, agentId);

  static AgentMessageParty? fromJson(Object? json) {
    if (json is! Map) return null;
    final machineId = json['machineId'], agentId = json['agentId'];
    if (machineId is! String || machineId.isEmpty) return null;
    if (agentId is! String || agentId.isEmpty) return null;
    final name = json['name'];
    return AgentMessageParty(
      machineId: machineId,
      agentId: agentId,
      name: name is String ? name : '',
    );
  }
}

String agentMessageKey(String machineId, String agentId) =>
    '$machineId\u0000$agentId';

@immutable
class AgentMessageStatus {
  const AgentMessageStatus({
    required this.machineId,
    required this.agentId,
    required this.state,
    required this.at,
    this.via,
    this.reason,
  });

  final String machineId, agentId;
  final AgentMessageState state;

  /// `hook` (at the agent's next tool call) or `prompt` (typed into an idle
  /// agent); null until it is delivered.
  final String? via;
  final String? reason;
  final int at;

  String get key => agentMessageKey(machineId, agentId);

  /// Whether this says more than [other] about the same recipient. Each daemon
  /// knows its own side: the sender's may still say queued for a recipient
  /// another machine's daemon has delivered to, so a final state wins over a
  /// queued one, and between two of the same kind the later one does.
  bool supersedes(AgentMessageStatus other) {
    final mine = state == AgentMessageState.queued ? 0 : 1;
    final theirs = other.state == AgentMessageState.queued ? 0 : 1;
    return mine != theirs ? mine > theirs : at > other.at;
  }

  static AgentMessageStatus? fromJson(Object? json) {
    if (json is! Map) return null;
    final party = AgentMessageParty.fromJson(json);
    final state = AgentMessageState.parse(json['state']);
    if (party == null || state == null) return null;
    final via = json['via'], reason = json['reason'], at = json['at'];
    return AgentMessageStatus(
      machineId: party.machineId,
      agentId: party.agentId,
      state: state,
      via: via is String ? via : null,
      reason: reason is String && reason.isNotEmpty ? reason : null,
      at: at is num ? at.toInt() : 0,
    );
  }
}

/// One message in a tab's log, as a daemon's `history` answers it.
@immutable
class AgentMessage {
  const AgentMessage({
    required this.id,
    required this.tabId,
    required this.from,
    required this.to,
    required this.text,
    required this.at,
    this.statuses = const [],
  });

  final String id, tabId, text;
  final AgentMessageParty from;
  final List<AgentMessageParty> to;
  final DateTime at;
  final List<AgentMessageStatus> statuses;

  /// What the log shows of the text: its first non-empty line.
  String get firstLine =>
      text
          .split('\n')
          .map((line) => line.trim())
          .where((line) => line.isNotEmpty)
          .firstOrNull ??
      '';

  AgentMessageStatus? statusOf(AgentMessageParty recipient) =>
      statuses.where((s) => s.key == recipient.key).firstOrNull;

  AgentMessageState stateOf(AgentMessageParty recipient) =>
      statusOf(recipient)?.state ?? AgentMessageState.queued;

  /// The same message as another daemon tells it: the union of what both
  /// know about each recipient (see [AgentMessageStatus.supersedes]).
  AgentMessage merge(AgentMessage other) {
    final best = <String, AgentMessageStatus>{
      for (final status in statuses) status.key: status,
    };
    for (final status in other.statuses) {
      final known = best[status.key];
      if (known == null || status.supersedes(known)) best[status.key] = status;
    }
    return AgentMessage(
      id: id,
      tabId: tabId,
      from: from.name.isEmpty ? other.from : from,
      to: to,
      text: text,
      at: at,
      statuses: best.values.toList(growable: false),
    );
  }

  static AgentMessage? fromJson(Object? json) {
    if (json is! Map) return null;
    final id = json['id'], tabId = json['tabId'], text = json['text'];
    final at = json['at'];
    final from = AgentMessageParty.fromJson(json['from']);
    final to = [
      for (final row in json['to'] is List ? json['to'] as List : const [])
        ?AgentMessageParty.fromJson(row),
    ];
    if (id is! String || id.isEmpty || tabId is! String || text is! String) {
      return null;
    }
    if (from == null || to.isEmpty || at is! num) return null;
    return AgentMessage(
      id: id,
      tabId: tabId,
      from: from,
      to: to,
      text: text,
      at: DateTime.fromMillisecondsSinceEpoch(at.toInt()),
      statuses: [
        for (final row
            in json['statuses'] is List ? json['statuses'] as List : const [])
          ?AgentMessageStatus.fromJson(row),
      ],
    );
  }
}

/// A tab's log, merged from every daemon that answered. [reached] is false
/// when none did, which is not the same as an empty log; [complete] is false
/// when a machine with a harness in the tab did not answer (offline, or gone
/// from the tab), so its side of the log may be missing.
typedef AgentMessageLog = ({
  List<AgentMessage> messages,
  bool reached,
  bool complete,
});

/// A tab with Agent Messages on, and the machines to ask for its traffic.
typedef AgentMessagesRemoteTab = ({String tabId, List<String> machineIds});

/// The short note a message leaves in a pane's header: `→ api` on the
/// sender's, `← lead` on each recipient's.
@immutable
class PaneMessageMark {
  const PaneMessageMark({
    required this.label,
    this.tooltip,
    this.warning = false,
  });

  final String label;
  final String? tooltip;

  /// The rate limit stopped this pane's harness: the one time Agent Messages
  /// asks for the person's attention.
  final bool warning;
}

/// How a tab's 💬 reads.
enum TabMessagesState { off, on, flowing }

typedef AgentMessageTabsRead = Future<Map<String, dynamic>?> Function();
typedef AgentMessagesWrite = Future<Map<String, dynamic>> Function(
  String tabId,
  bool enabled,
);
typedef AgentMessagesRequest = Future<Map<String, dynamic>> Function(
  String machineId,
  Map<String, dynamic> payload,
);
typedef AgentNameOf = String? Function(String machineId, String agentId);

/// Each tab's flag, the traffic the daemons report, and the pane marks it
/// leaves. Its own notifier, as `AgentAlerts` is: a message arriving must not
/// rebuild the workspace, only the 💬 and the marks that listen here.
class AgentMessagesController extends ChangeNotifier {
  AgentMessagesController({
    required this.read,
    required this.write,
    required this.request,
    required this.nameOf,
    DateTime Function()? now,
    this.flowingFor = const Duration(seconds: 10),
    this.remoteRecency = const Duration(seconds: 60),
    this.markLife = const Duration(seconds: 5),
  }) : now = now ?? DateTime.now;

  final AgentMessageTabsRead read;
  final AgentMessagesWrite write;
  final AgentMessagesRequest request;
  final AgentNameOf nameOf;

  /// Only to tell a message another machine's log holds from one that just
  /// moved ([pollRemote]); lifetimes here run on timers.
  final DateTime Function() now;

  /// How long a tab's status shows 💬 after the last message moved in it,
  /// before it goes back to the tab's working, done or question mark.
  final Duration flowingFor;

  /// How recent another machine's message must be to count as traffic when a
  /// poll first sees it ([pollRemote]): longer than the remote watch's 15 s
  /// round, so no message falls between two rounds, yet old history does not
  /// light a tab up.
  final Duration remoteRecency;

  /// How long a pane's mark stays, unless the pane is focused first.
  final Duration markLife;

  final _enabled = <String, bool>{};
  final _pending = <String, bool>{};
  final _failed = <String, String>{};
  final _writes = <String, int>{};
  final _traffic = <String, int>{};
  final _seenMessages = <String>{};
  // What has a lifetime holds the timer that ends it — a tab's 💬 stops, a
  // mark goes — so nothing has to compare clocks to know it is over.
  final _flowing = <String, Timer>{};
  final _marks = <String, (PaneMessageMark, Timer)>{};
  final _polling = <String>{};
  int _reads = 0, _account = 0;
  bool _disposed = false;

  /// Whether the daemon and backend answered for this account's tabs. Until
  /// they have — and for good, with an older CLI or backend that does not know
  /// Agent Messages (404) — there is no 💬 and no menu row: "off" would be a
  /// guess, and a click could not take.
  bool get loaded => _loaded;
  bool _loaded = false;

  /// On when the person turned it on; off when they did not, and whenever the
  /// backend or daemon cannot say — an older one has no flag to read.
  bool isOn(String tabId) => _pending[tabId] ?? _enabled[tabId] ?? false;

  /// A turn on or off is on its way to the backend.
  bool isPending(String tabId) => _pending.containsKey(tabId);

  /// Messages moved in [tabId] within [flowingFor].
  bool isFlowing(String tabId) => _flowing.containsKey(tabId);

  TabMessagesState stateOf(String tabId) => !isOn(tabId)
      ? TabMessagesState.off
      : isFlowing(tabId)
      ? TabMessagesState.flowing
      : TabMessagesState.on;

  /// Why the last turn on or off for [tabId] did not take.
  String? failureFor(String tabId) => _failed[tabId];

  /// Counts the `messages_changed` frames for [tabId], so an open log knows
  /// when to read again.
  int trafficFor(String tabId) => _traffic[tabId] ?? 0;

  PaneMessageMark? markFor(String machineId, String agentId) =>
      _marks[agentMessageKey(machineId, agentId)]?.$1;

  void _notify() {
    if (!_disposed) notifyListeners();
  }

  /// Read every tab's flag again. A failure keeps what was known: one dropped
  /// request must not turn a tab's 💬 off under the person. An answer of null
  /// is a daemon or backend without Agent Messages.
  Future<void> refresh() async {
    if (_disposed) return;
    final read = ++_reads, account = _account;
    final writes = Map.of(_writes);
    Map<String, dynamic>? answer;
    try {
      answer = await this.read();
    } catch (_) {
      return;
    }
    if (_disposed || account != _account || read != _reads) return;
    if (answer == null) {
      if (!_loaded && _enabled.isEmpty) return;
      _loaded = false;
      _enabled.clear();
      _notify();
      return;
    }
    final tabs = answer['tabs'];
    final next = <String, bool>{
      for (final tab in tabs is List ? tabs : const [])
        if (tab is Map && tab['id'] is String)
          tab['id'] as String: tab['enabled'] == true,
    };
    // A write that landed while this read was out is newer than its answer.
    for (final MapEntry(:key, :value) in _writes.entries) {
      if (writes[key] != value && _enabled.containsKey(key)) {
        next[key] = _enabled[key]!;
      }
    }
    _enabled
      ..clear()
      ..addAll(next);
    _loaded = true;
    _notify();
  }

  /// Turn Agent Messages on or off for [tabId]. Shown at once, put back if
  /// the backend refuses or cannot be reached. Answers whether it took.
  Future<bool> setEnabled(String tabId, bool enabled) async {
    if (_disposed || _pending.containsKey(tabId)) return false;
    final account = _account;
    _pending[tabId] = enabled;
    _failed.remove(tabId);
    _notify();
    var saved = false;
    try {
      final answer = await write(tabId, enabled);
      if (_disposed || account != _account) return false;
      final confirmed = answer['enabled'];
      _enabled[tabId] = confirmed is bool ? confirmed : enabled;
      saved = _enabled[tabId] == enabled;
    } catch (_) {
      if (_disposed || account != _account) return false;
    }
    _pending.remove(tabId);
    _writes[tabId] = (_writes[tabId] ?? 0) + 1;
    if (!saved) {
      _failed[tabId] =
          'Agent Messages could not be turned ${enabled ? 'on' : 'off'}. '
          'Check that Harness is signed in and online, then try again.';
    }
    _notify();
    unawaited(refresh());
    return saved;
  }

  Future<bool> toggle(String tabId) => setEnabled(tabId, !isOn(tabId));

  /// A `messages_changed` frame from a daemon: a message moved, or a sender
  /// hit the rate limit.
  void handleEvent(Map<String, dynamic> payload) {
    if (_disposed) return;
    final limited = AgentMessageParty.fromJson(payload['limited']);
    if (limited != null) {
      _mark(
        limited.key,
        const PaneMessageMark(
          label: '→ rate limited',
          tooltip:
              'Agent Messages: this harness sent too many messages. '
              'Harness refuses its next ones for a few minutes.',
          warning: true,
        ),
      );
      _notify();
      return;
    }
    final tabId = payload['tabId'];
    if (tabId is! String || tabId.isEmpty) return;
    _flow(tabId);
    final id = payload['messageId'];
    // Each status change says the message again; it marks its panes once.
    if (id is String && _remember(id)) {
      final from = AgentMessageParty.fromJson(payload['from']);
      final to = [
        for (final row
            in payload['to'] is List ? payload['to'] as List : const [])
          ?AgentMessageParty.fromJson(row),
      ];
      if (from != null) _markPanes(from, to);
    }
    _notify();
  }

  /// [tabId]'s status shows 💬 for [flowingFor] from now — longer when the
  /// traffic was only read from another machine's log — and an open log reads
  /// again.
  void _flow(String tabId, [Duration extra = Duration.zero]) {
    _flowing.remove(tabId)?.cancel();
    _flowing[tabId] = Timer(flowingFor + extra, () {
      _flowing.remove(tabId);
      _notify();
    });
    _traffic[tabId] = trafficFor(tabId) + 1;
  }

  /// Whether [messageId] is new to this window; remembered either way.
  bool _remember(String messageId) {
    if (!_seenMessages.add(messageId)) return false;
    while (_seenMessages.length > 500) {
      _seenMessages.remove(_seenMessages.first);
    }
    return true;
  }

  /// Ask [tabs]' machines for what they hold: a daemon tells `messages_changed`
  /// only to the windows on its own computer (the core's `clients.windows`), so
  /// traffic between harnesses on other machines would never reach this one.
  /// A message new to this window that moved within [remoteRecency] counts as
  /// traffic, exactly as if its frame had arrived, and flows for one [round]
  /// longer: the next round can only renew it a round later, so 💬 would
  /// otherwise lapse between rounds while agents keep talking. One request at
  /// a time per machine; a machine still answering the last round is skipped.
  Future<void> pollRemote(
    Iterable<AgentMessagesRemoteTab> tabs, {
    Duration round = Duration.zero,
  }) async {
    if (_disposed) return;
    final byMachine = <String, List<String>>{};
    for (final tab in tabs) {
      for (final machineId in tab.machineIds) {
        byMachine.putIfAbsent(machineId, () => []).add(tab.tabId);
      }
    }
    await Future.wait([
      for (final MapEntry(key: machineId, value: tabIds) in byMachine.entries)
        if (!_polling.contains(machineId)) _poll(machineId, tabIds, round),
    ]);
  }

  Future<void> _poll(
    String machineId,
    List<String> tabIds,
    Duration round,
  ) async {
    final account = _account;
    _polling.add(machineId);
    try {
      for (final tabId in tabIds) {
        // The newest few are enough to see what moved since the last round.
        final messages = await _historyFrom(machineId, tabId, limit: 20);
        if (_disposed || account != _account) return;
        if (messages == null) continue;
        var moved = false;
        for (final message in messages) {
          if (!_remember(message.id)) continue;
          if (now().difference(message.at) >= remoteRecency) continue;
          moved = true;
          _markPanes(message.from, message.to);
        }
        if (moved) {
          _flow(tabId, round);
          _notify();
        }
      }
    } finally {
      _polling.remove(machineId);
    }
  }

  void _mark(String key, PaneMessageMark mark) {
    _marks.remove(key)?.$2.cancel();
    _marks[key] = (
      mark,
      Timer(markLife, () {
        _marks.remove(key);
        _notify();
      }),
    );
  }

  void _markPanes(AgentMessageParty from, List<AgentMessageParty> to) {
    if (to.isEmpty) return;
    final names = [for (final r in to) _name(r)];
    _mark(
      from.key,
      PaneMessageMark(
        label: '→ ${names.join(', ')}',
        tooltip: 'Sent an agent message to ${names.join(', ')}',
      ),
    );
    final sender = _name(from);
    for (final recipient in to) {
      _mark(
        recipient.key,
        PaneMessageMark(
          label: '← $sender',
          tooltip: 'Agent message from $sender',
        ),
      );
    }
  }

  /// The name the window shows for [party]: the app's agent list, then the
  /// daemon's, then the start of its id.
  String _name(AgentMessageParty party) {
    final known = nameOf(party.machineId, party.agentId);
    if (known != null && known.trim().isNotEmpty) return known.trim();
    if (party.name.isNotEmpty) return party.name;
    return party.agentId.substring(0, math.min(8, party.agentId.length));
  }

  String nameOfParty(AgentMessageParty party) => _name(party);

  /// The person looked at this pane: its mark has done its job.
  void seen(String machineId, String agentId) {
    final mark = _marks.remove(agentMessageKey(machineId, agentId));
    if (mark == null) return;
    mark.$2.cancel();
    _notify();
  }

  void _stopTimers() {
    for (final timer in _flowing.values) {
      timer.cancel();
    }
    for (final (_, timer) in _marks.values) {
      timer.cancel();
    }
    _flowing.clear();
    _marks.clear();
  }

  /// [tabId]'s log from [machineIds]' daemons, merged by message id, oldest
  /// first. Each daemon holds what it sent and what it delivered, so one
  /// alone can be missing half of a tab that spans machines; the log is
  /// complete only when every one of [expected] answered.
  Future<AgentMessageLog> history(
    String tabId,
    Iterable<String> machineIds, {
    Iterable<String> expected = const [],
  }) async {
    final asked = machineIds.toSet().toList();
    final answers = await Future.wait([
      for (final machineId in asked) _historyFrom(machineId, tabId),
    ]);
    final answered = {
      for (var i = 0; i < asked.length; i++)
        if (answers[i] != null) asked[i],
    };
    final merged = <String, AgentMessage>{};
    for (final message in answers.nonNulls.expand((list) => list)) {
      merged.update(
        message.id,
        (known) => known.merge(message),
        ifAbsent: () => message,
      );
    }
    final messages = merged.values.toList()
      ..sort((a, b) {
        final byTime = a.at.compareTo(b.at);
        return byTime != 0 ? byTime : a.id.compareTo(b.id);
      });
    return (
      messages: messages,
      reached: answered.isNotEmpty,
      complete: answered.containsAll(expected),
    );
  }

  Future<List<AgentMessage>?> _historyFrom(
    String machineId,
    String tabId, {
    int? limit,
  }) async {
    try {
      final reply = await request(machineId, {
        'action': 'history',
        'tabId': tabId,
        'limit': ?limit,
      });
      final rows = reply['messages'];
      if (reply['error'] != null || rows is! List) return null;
      return [
        for (final row in rows)
          if (AgentMessage.fromJson(row) case final message?
              when message.tabId == tabId)
            message,
      ];
    } catch (_) {
      // Offline, or a daemon that predates Agent Messages and goes silent.
      return null;
    }
  }

  /// Sign-out or another account: nothing of this one's stays.
  void reset() {
    _account++;
    _reads++;
    _enabled.clear();
    _pending.clear();
    _failed.clear();
    _writes.clear();
    _traffic.clear();
    _seenMessages.clear();
    _polling.clear();
    _stopTimers();
    _loaded = false;
    _notify();
  }

  @override
  void dispose() {
    _disposed = true;
    _stopTimers();
    super.dispose();
  }
}

/// Asks other machines for their traffic ([AgentMessagesController.pollRemote])
/// every [every] while the window is in front, and once as soon as it comes
/// back. A hidden or minimised window asks nothing.
class AgentMessagesRemoteWatch {
  AgentMessagesRemoteWatch({
    required this.controller,
    required this.foreground,
    required this.tabs,
    this.every = const Duration(seconds: 15),
  });

  final AgentMessagesController controller;
  final ValueListenable<bool> foreground;

  /// The tabs to ask about now: on, with a harness on another machine.
  final List<AgentMessagesRemoteTab> Function() tabs;
  final Duration every;
  Timer? _timer;
  bool _started = false, _disposed = false;

  void start() {
    if (_started || _disposed) return;
    _started = true;
    foreground.addListener(_foregroundChanged);
    _foregroundChanged();
  }

  void _foregroundChanged() {
    _timer?.cancel();
    _timer = null;
    if (foreground.value) unawaited(poll());
  }

  @visibleForTesting
  Future<void> poll() async {
    _timer?.cancel();
    _timer = null;
    if (_disposed || !foreground.value) return;
    final targets = tabs();
    if (targets.isNotEmpty) await controller.pollRemote(targets, round: every);
    if (!_disposed && _started && foreground.value && _timer == null) {
      _timer = Timer(every, () => unawaited(poll()));
    }
  }

  void dispose() {
    _disposed = true;
    _timer?.cancel();
    _timer = null;
    if (_started) foreground.removeListener(_foregroundChanged);
  }
}
