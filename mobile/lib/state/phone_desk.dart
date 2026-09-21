import 'dart:async';

import 'package:flutter/foundation.dart';

import '../core/last_opened_agent.dart' show AgentRef;
import '../logging/app_log.dart';
import 'desk_sync.dart';

/// The account's desk — its tabs, the same on every computer — as a PHONE holds
/// it.
///
/// `desk_sync.dart` (vendored from the desktop, unchanged) has the document's
/// shape and the backend's own rules replayed for optimistic writes. This is
/// the phone's half of it, and it is deliberately not the desktop's half:
///
/// ⚠️ **The phone FOLLOWS the desk; it does not project itself onto it.** A
/// window's tabs are its `swarms`, so the desktop diffs that projection after
/// every layout change and sends the difference. The phone's `swarms` are not
/// tabs at all — they are the one-pane container a pager attaches into, and it
/// attaches the agents either side of the one on screen ahead of a swipe. A
/// projection of THAT would add every agent a thumb passes to whatever tab the
/// phone happened to be in, on every computer the person owns. So nothing here
/// is derived from `swarms`: the tabs are read, and the only writes are the two
/// a person makes by hand on the phone — [adopt] for an agent created here, and
/// [drop] for one deleted here.
///
/// What is NOT on the desk stays per device, as it does on a window: which tab
/// is open ([activeTabId]) is this phone's own, and so is the agent within it.
class PhoneDesk {
  PhoneDesk({
    required this.read,
    required this.write,
    required this.onChanged,
    this.pollInterval = const Duration(seconds: 15),
  });

  /// How often a phone in the FOREGROUND re-reads the desk on its own.
  ///
  /// ⚠️ **Not belt-and-braces on a phone: it is the main wire.** A
  /// `desk_changed` push reaches this app only over a machine's relay socket —
  /// the backend has no per-phone socket to send it on — so a backend that
  /// predates that forwarding, or a moment with no machine connected, delivers
  /// nothing at all, and the tabs would sit at whatever they were when the app
  /// last launched. 15s is the beat the desktop reads the desk on.
  ///
  /// Stopped while the app is in the background ([pause]) and armed again by
  /// the [refresh] a resume makes.
  final Duration pollInterval;

  /// `GET /api/desk` — the document, or null where the backend has no desk to
  /// give (see `ApiClient.desk`).
  final Future<Map<String, dynamic>?> Function() read;

  /// `POST /api/desk/ops` — the ops, answered with the document they produced.
  final Future<Map<String, dynamic>?> Function(List<Map<String, dynamic>> ops)
  write;

  /// The app has tabs it did not have a moment ago: rebuild.
  final VoidCallback onChanged;

  final DeskSyncState _state = DeskSyncState();
  Timer? _retry;
  Timer? _poll;
  Future<void>? _joining;
  bool _disposed = false;

  /// Bumped by [reset] — a sign-out, or a switch of account. Everything in
  /// flight reads it on the way back and drops what it was carrying if it
  /// moved, so the next account never inherits the last one's answer.
  int _generation = 0;

  /// The tabs, in the desk's order, with this phone's unacknowledged writes
  /// already laid over them — what the tab strip draws.
  List<DeskTab> get tabs => _state.synced;

  /// Whether the desk answered at all. False leaves the phone as it was before
  /// the desk existed: no strip, and a swipe over every agent on the account.
  bool get enabled => _state.enabled;

  /// The tab the phone is in, or null for the agents no tab holds (and for a
  /// phone whose desk is empty). Device-local by decision — see the class note.
  String? get activeTabId => _activeTabId;
  String? _activeTabId;

  /// A tab was picked by hand. The screen answers by opening an agent of that
  /// tab; nothing else here moves.
  void select(String? tabId) {
    if (_activeTabId == tabId) return;
    _activeTabId = tabId;
    onChanged();
  }

  /// The screen worked out which tab it is showing, and which agent of it.
  /// Silent: this is called from a build, and it is a record of what is already
  /// drawn, not a change to draw.
  void note(String? tabId, {AgentRef? showing}) {
    _activeTabId = tabId;
    if (showing != null) _lastAgent[tabId] = showing;
  }

  /// The agent this phone last had on screen in [tabId], if it has been in it.
  ///
  /// What makes a tab switch feel like the desktop's: going back to a tab returns
  /// to where you were in it rather than to its first agent. Per device and never
  /// written down — a tab is a place you were, and only this phone was there.
  AgentRef? lastAgentIn(String? tabId) => _lastAgent[tabId];

  final Map<String?, AgentRef> _lastAgent = {};

  // ── reading ──────────────────────────────────────────────────────────────

  /// Join the desk unless this phone already has, or is joining now. Called from
  /// every path that finishes a sign-in, because the first read of a session
  /// that had no network yet answers with an error rather than with a desk.
  void ensure() {
    if (_state.enabled || _joining != null || _disposed) return;
    unawaited(_join());
  }

  Future<void> _join() async {
    final run = _read(first: true);
    _joining = run;
    try {
      await run;
    } finally {
      if (identical(_joining, run)) _joining = null;
    }
  }

  /// Read the desk again — a `desk_changed` push, or the app coming back to the
  /// foreground after however long in somebody's pocket.
  ///
  /// A resume comes through here, so this is also where the poll is armed again
  /// after [pause].
  Future<void> refresh() {
    if (!_state.enabled) {
      ensure();
      return Future<void>.value();
    }
    _startPolling();
    return _read(first: false);
  }

  /// The app is no longer in front of anybody: stop reading the desk until it
  /// is. iOS suspends the process anyway; Android does not always, and a phone
  /// in a pocket has no tabs to show.
  void pause() {
    _poll?.cancel();
    _poll = null;
  }

  void _startPolling() {
    if (_poll != null || _disposed || !_state.enabled) return;
    _poll = Timer.periodic(pollInterval, (_) {
      // Nothing while a write of this phone's own is in the air: its answer is
      // the document, and a read underneath it would only race that.
      if (_state.pending.isNotEmpty || _state.inFlight) return;
      unawaited(_read(first: false));
    });
  }

  /// A `desk_changed` frame: the payload carries only the revision, so a phone
  /// already at it has nothing to fetch.
  ///
  /// ⚠️ It arrives once PER MACHINE the phone is connected to — the frame rides
  /// each machine's socket (backend `lib/webWs.ts`) because a phone holds no
  /// adapter socket of its own. The revision test is what keeps four machines
  /// from meaning four GETs.
  void noticeRevision(Object? revision) {
    if (!_state.enabled) return;
    if (revision is int && revision <= _state.revision) return;
    unawaited(refresh());
  }

  Future<void> _read({required bool first}) async {
    if (_disposed) return;
    final generation = _generation;
    Map<String, dynamic>? raw;
    try {
      raw = await read();
    } catch (error) {
      appLog.warn('desk', '${first ? 'first read' : 'read'} failed: $error');
      return;
    }
    if (_disposed || generation != _generation) return;
    final doc = DeskDoc.fromJson(raw);
    if (doc == null) {
      if (first) appLog.info('desk', 'not available here — no tabs to show');
      return;
    }
    if (first) {
      _state.enabled = true;
      appLog.info(
        'desk',
        'joined at rev ${doc.revision} · ${doc.tabs.length} tabs',
      );
      _startPolling();
    }
    _apply(doc);
  }

  /// Take [doc] as the desk, with this phone's unacknowledged ops laid back over
  /// it. A document older than one already applied is ignored — two machines'
  /// sockets can deliver the same change out of order.
  void _apply(DeskDoc doc) {
    if (doc.revision < _state.revision) return;
    _state.revision = doc.revision;
    _state.synced = applyDeskOps(doc.tabs, _state.pending);
    onChanged();
  }

  // ── the two writes a phone makes ─────────────────────────────────────────

  /// An agent created ON THIS PHONE joins the tab the phone is in, the way one
  /// created in a window joins that window's tab.
  ///
  /// Without this a phone-made agent would belong to no tab at all: invisible in
  /// every window's tab bar, and — now that a swipe stays inside the tab — only
  /// reachable here through search. Nothing to do when the phone is not in a tab
  /// (the desk is empty, or the person is in the group for agents no tab holds):
  /// the agent is then exactly where it would have been anyway.
  void adopt(AgentRef agent) {
    final tabId = _activeTabId;
    if (!_state.enabled || tabId == null) return;
    final tab = _state.synced.where((t) => t.id == tabId).firstOrNull;
    if (tab == null) return;
    final pane = DeskPaneRef(
      machineId: agent.machineId,
      agentId: agent.agentId,
    );
    if (tab.panes.contains(pane)) return;
    _queue([
      {'op': 'pane.add', 'tabId': tabId, ...pane.toJson()},
    ]);
  }

  /// An agent deleted on this phone leaves every tab that held it.
  ///
  /// A window that had it open removes it too, as soon as it hears the agent is
  /// gone — but only a window that is RUNNING, and the person deleting an agent
  /// from a phone is by definition away from it. Left undone, the tab keeps a
  /// pane that can never attach.
  void drop(AgentRef agent) {
    if (!_state.enabled) return;
    final pane = DeskPaneRef(
      machineId: agent.machineId,
      agentId: agent.agentId,
    );
    final ops = [
      for (final tab in _state.synced)
        if (tab.panes.contains(pane))
          {'op': 'pane.remove', 'tabId': tab.id, ...pane.toJson()},
    ];
    if (ops.isEmpty) return;
    _queue(ops);
  }

  /// Believe the write, show it, and send it. The desk's answer (or a document
  /// from another computer) is applied over it afterwards, with anything still
  /// unacknowledged laid back on top.
  void _queue(List<Map<String, dynamic>> ops) {
    _state.synced = applyDeskOps(_state.synced, ops);
    _state.pending.addAll(ops);
    appLog.debug('desk', 'queued ${ops.map((op) => op['op']).join(' ')}');
    onChanged();
    unawaited(_flush());
  }

  Future<void> _flush() async {
    if (_disposed ||
        !_state.enabled ||
        _state.inFlight ||
        _state.pending.isEmpty) {
      return;
    }
    _state.inFlight = true;
    final generation = _generation;
    final batch = List<Map<String, dynamic>>.from(_state.pending);
    Map<String, dynamic>? raw;
    try {
      raw = await write(batch);
    } catch (error) {
      _state.inFlight = false;
      if (_disposed || generation != _generation) return;
      // Kept, not dropped: an agent created in a tunnel still joins that tab
      // once there is a network again. Backoff, capped at a minute.
      _state.failures++;
      final wait = Duration(
        seconds: (5 * (1 << (_state.failures - 1).clamp(0, 4))).clamp(5, 60),
      );
      appLog.warn(
        'desk',
        'write failed (${batch.length} ops, retry in ${wait.inSeconds}s): $error',
      );
      _retry?.cancel();
      _retry = Timer(wait, () => unawaited(_flush()));
      return;
    }
    _state.inFlight = false;
    if (_disposed || generation != _generation) return;
    _state.failures = 0;
    _retry?.cancel();
    _retry = null;
    // Acknowledged, or refused for good — either way these are no longer this
    // phone's to replay.
    _state.pending.removeRange(0, batch.length.clamp(0, _state.pending.length));
    final doc = DeskDoc.fromJson(raw);
    if (doc == null) {
      appLog.info('desk', 'write not accepted — the desk is left alone');
      _state.enabled = false;
      _state.pending.clear();
      onChanged();
      return;
    }
    _apply(doc);
    if (_state.pending.isNotEmpty) unawaited(_flush());
  }

  /// Sign-out, or a different account signing in: everything about the last
  /// desk goes, including writes it never managed to send. They were that
  /// account's, and this phone is no longer holding it.
  void reset() {
    _generation++;
    _retry?.cancel();
    _retry = null;
    pause();
    _joining = null;
    _activeTabId = null;
    _lastAgent.clear();
    _state.reset();
  }

  void dispose() {
    _disposed = true;
    _retry?.cancel();
    _retry = null;
    pause();
  }
}
