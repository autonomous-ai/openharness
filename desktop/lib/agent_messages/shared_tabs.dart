import 'dart:async';

import 'package:flutter/foundation.dart';

import '../ws/ws_conn.dart';
import '../measurement/product_measurement.dart';
import 'shared_tabs_model.dart';

typedef SharedTabsRequest = Future<Map<String, dynamic>> Function(
  Map<String, dynamic> payload,
);

/// A refused `share_*` action, with the daemon's code and a sentence to read.
class SharedTabsFailure implements Exception {
  const SharedTabsFailure(this.code, this.message);

  final String code, message;

  @override
  String toString() => 'SharedTabsFailure($code): $message';
}

enum SharedTabsState { unknown, ready, off, tooOld, unsupported, unavailable }

/// One row of a shared tab's Tasks: a GitHub issue, its pull request and CI.
@immutable
class SharedTaskRow {
  const SharedTaskRow({
    required this.repo,
    required this.issue,
    required this.title,
    required this.url,
    required this.state,
    this.assignee,
    this.pr,
    this.updatedAt,
  });

  final String repo, title, url;
  final int issue;

  /// When the issue last changed, as GitHub says; null when it did not say.
  /// A merged task leaves Tab Activity 24 hours after it.
  final DateTime? updatedAt;

  /// `open` or `closed`.
  final String state;

  /// The marker's `<account>/<harness>`, as the daemon read it.
  final ({String accountId, String harness})? assignee;
  final ({
    int number,
    String url,
    String state,
    String ci,
    bool autoMerge,
    String mergeState,
    DateTime? mergedAt,
  })?
  pr;

  static SharedTaskRow? fromJson(Object? json) {
    if (json is! Map) return null;
    final repo = json['repo'], issue = json['issue'], url = json['url'];
    if (repo is! String || issue is! int || url is! String) return null;
    final a = json['assignee'], p = json['pr'];
    final title = json['title'],
        state = json['state'],
        updated = json['updatedAt'];
    return SharedTaskRow(
      updatedAt: updated is String ? DateTime.tryParse(updated) : null,
      repo: repo,
      issue: issue,
      title: title is String ? title : '',
      url: url,
      state: state == 'open' ? 'open' : 'closed',
      assignee: a is Map && a['account'] is String && a['harness'] is String
          ? (accountId: a['account'] as String, harness: a['harness'] as String)
          : null,
      pr: p is Map && p['number'] is int && p['url'] is String
          ? (
              number: p['number'] as int,
              url: p['url'] as String,
              state: p['state'] is String ? p['state'] as String : 'Open',
              ci: p['ci'] is String ? p['ci'] as String : 'none',
              autoMerge: p['autoMerge'] == true,
              mergeState: p['mergeState'] is String
                  ? p['mergeState'] as String
                  : '',
              // When it merged (`gh pr view`), for Tab Activity's 24 hours.
              mergedAt: p['mergedAt'] is String
                  ? DateTime.tryParse(p['mergedAt'] as String)
                  : null,
            )
          : null,
    );
  }
}

/// A tab's Tasks as last read: [loaded] tells "not read yet" from "nothing".
@immutable
class SharedTasks {
  const SharedTasks({
    this.loading = false,
    this.loaded = false,
    this.rows = const [],
    this.error,
    this.truncated = false,
  });

  final bool loading, loaded, truncated;
  final List<SharedTaskRow> rows;

  /// The failure code of the last read (`GH_MISSING`, `GH_SIGNED_OUT`,
  /// `RATE_LIMITED`, `TIMEOUT`, `GH_FAILED`), kept with the tab.
  final String? error;
}

/// Shared tabs as this computer's daemon holds them (`agent_messages` `shares`),
/// and the actions on them. Its own notifier, as [AgentMessagesController] is,
/// so its traffic never rebuilds the workspace.
class SharedTabsController extends ChangeNotifier {
  SharedTabsController({
    required this.request,
    required this.foreground,
    this.onActivity,
    this.messagesSwitch,
    this.measurement,
  }) {
    _switchKnown = messagesSwitch?.value;
    messagesSwitch?.addListener(_switchChanged);
    if (_switchKnown == false) _settleOff();
  }

  final SharedTabsRequest request;
  final ProductMeasurement? measurement;
  final ValueListenable<bool> foreground;
  final void Function(SharedActivity activity)? onActivity;

  /// The account's Agent Messages switch (Settings ▸ Experimental, off by
  /// default), null until the account's settings are read. While it is off,
  /// [refresh] asks nothing and answers as the daemon would: every daemon
  /// refuses `shares` with MESSAGES_OFF then (cli/src/messages/service.ts
  /// `awakeShares`), and asking anyway was a request and an fsync'd WARN every
  /// 60 s and on each reconnect, for every account that never turned it on.
  /// Not read yet, it asks as before. None given (tests): always asks.
  final ValueListenable<bool?>? messagesSwitch;

  /// The switch's last value other than null: the store passes through null
  /// whenever it is bound again.
  bool? _switchKnown;

  /// Whether [refresh] asks the daemon.
  bool get asking => messagesSwitch?.value != false;

  void _switchChanged() {
    final now = messagesSwitch!.value;
    if (now == null) return;
    final was = _switchKnown;
    _switchKnown = now;
    if (!now) {
      _settleOff();
    } else if (was == false) {
      // Turned on: read now, not at the next poll.
      unawaited(refresh());
    }
  }

  /// What a MESSAGES_OFF answer does, for a switch that is off; a read in
  /// flight is dropped.
  void _settleOff() {
    if (_disposed) return;
    ++_reads;
    if (_state == SharedTabsState.off &&
        identical(_snapshot, SharedTabsSnapshot.empty)) {
      return;
    }
    _state = SharedTabsState.off;
    _snapshot = SharedTabsSnapshot.empty;
    _notify();
  }

  /// The last `shared_activity` frame this computer's daemon sent, each a new
  /// value: Tab Activity reads its tab again on one for it.
  ValueListenable<SharedActivity?> get heard => _heard;
  final _heard = ValueNotifier<SharedActivity?>(null);

  SharedTabsSnapshot _snapshot = SharedTabsSnapshot.empty;
  SharedTabsState _state = SharedTabsState.unknown;
  final _hidden =
      <String>{}; // dismissed here when the daemon could not be told
  final _tasks = <String, SharedTasks>{};
  final _taskReads = <String, Future<void>>{};
  int _reads = 0, _account = 0, _activityRevision = 0;
  bool _disposed = false;

  /// The read in flight, the account it reads for, and whether another was
  /// asked for meanwhile ([refresh]).
  Future<void>? _flight;
  int _flightAccount = -1;
  bool _again = false;

  SharedTabsSnapshot get snapshot => _snapshot.without(_hidden);
  SharedTabsState get state => _state;

  void _notify() {
    if (!_disposed) notifyListeners();
  }

  static SharedTabsState? _stateFor(String code) => switch (code) {
    'UNKNOWN_ACTION' ||
    'DAEMON_TOO_OLD' ||
    'UNSUPPORTED' => SharedTabsState.tooOld,
    'MESSAGES_OFF' => SharedTabsState.off,
    'SHARED_TABS_UNSUPPORTED' => SharedTabsState.unsupported,
    _ => null,
  };

  /// Reads `shares` again. One read at a time: a call while one is in flight
  /// asks for one more after it and joins it, never a second in parallel. A
  /// burst of `shared_tabs_changed` is then at most two reads, where each frame
  /// had started its own (two backend requests each; final review of 1c, I4).
  Future<void> refresh() {
    if (_disposed) return Future<void>.value();
    if (!asking) {
      _settleOff();
      return Future<void>.value();
    }
    final running = _flight;
    if (running != null && _flightAccount == _account) {
      _again = true;
      return running;
    }
    _again = false;
    _flightAccount = _account;
    late final Future<void> flight;
    flight = _refreshWhileAsked().whenComplete(() {
      // After a reset a newer flight may hold the slot: clear only our own.
      if (identical(_flight, flight)) _flight = null;
    });
    return _flight = flight;
  }

  Future<void> _refreshWhileAsked() async {
    final account = _account;
    do {
      _again = false;
      await _readShares();
    } while (_again && !_disposed && account == _account);
  }

  Future<void> _readShares() async {
    // Turned off while an earlier read was in flight: no second one.
    if (_disposed || !asking) return;
    final read = ++_reads, account = _account;
    Map<String, dynamic> answer;
    try {
      answer = await request({'action': 'shares'});
    } on WsRequestFailure catch (e) {
      if (_disposed || account != _account || read != _reads) return;
      final next = _stateFor(e.code);
      if (next == null) {
        // Transient: keep what was known; with nothing known yet, say so.
        if (_state == SharedTabsState.unknown) {
          _state = SharedTabsState.unavailable;
          _notify();
        }
        return;
      }
      _state = next;
      _snapshot = SharedTabsSnapshot.empty;
      _notify();
      return;
    } catch (_) {
      if (_disposed || account != _account || read != _reads) return;
      if (_state == SharedTabsState.unknown) {
        _state = SharedTabsState.unavailable;
        _notify();
      }
      return;
    }
    if (_disposed || account != _account || read != _reads) return;
    final next = SharedTabsSnapshot.fromJson(answer);
    if (next == null) {
      if (_state == SharedTabsState.unknown) {
        _state = SharedTabsState.unavailable;
        _notify();
      }
      return;
    }
    _snapshot = next;
    _state = SharedTabsState.ready;
    for (final a in next.activity) {
      _hand(a);
    }
    _notify();
  }

  void changed() => unawaited(refresh());

  void handleActivity(Map<String, dynamic> payload) {
    final a = SharedActivity.fromJson(payload);
    if (a == null || _disposed) return;
    _heard.value = _hand(a);
  }

  SharedActivity _hand(SharedActivity a) {
    final revised = a.withRevision(++_activityRevision);
    onActivity?.call(revised);
    return revised;
  }

  /// Sign-out or another account: nothing of the old one stays, and its late
  /// answers are dropped.
  void reset() {
    _account++;
    _snapshot = SharedTabsSnapshot.empty;
    _state = SharedTabsState.unknown;
    _hidden.clear();
    _tasks.clear();
    _taskReads.clear();
    _notify();
  }

  SharedTab? tabForDesk(String deskTabId) {
    final me = _snapshot.me?.accountId;
    if (me == null) return null;
    for (final t in _snapshot.tabs) {
      if (t.deskTabId(me) == deskTabId) return t;
    }
    return null;
  }

  bool isShared(String deskTabId) => tabForDesk(deskTabId) != null;

  /// The tab ids the daemons file [deskTabId]'s Agent Messages under. A
  /// member's desk tab is derived from its shared tab id (R1): the daemons
  /// file the messages that cross accounts under the shared tab id, and those
  /// between the member's own harnesses in the tab under the desk tab id (the
  /// desk tab is the first the two share). Any other tab: its desk id alone.
  List<String> agentMessagesTabIds(String deskTabId) {
    final me = _snapshot.me?.accountId;
    final tab = tabForDesk(deskTabId);
    return tab != null && me != null && !tab.ownedBy(me)
        ? [deskTabId, tab.sharedTabId]
        : [deskTabId];
  }

  Future<Map<String, dynamic>> _ask(
    String action,
    Map<String, dynamic> payload,
  ) async {
    final account = _account;
    try {
      return await request({'action': action, ...payload});
    } on WsRequestFailure catch (e) {
      final next = _stateFor(e.code);
      if (next == SharedTabsState.tooOld && account == _account) {
        _state = next!;
        _notify();
      }
      final detail = e.detail;
      throw SharedTabsFailure(
        e.code,
        detail == null || detail.isEmpty ? e.code : detail,
      );
    } catch (_) {
      // A timeout, a closed socket or a session not ready: this computer's daemon was not reached.
      throw const SharedTabsFailure(
        'UNAVAILABLE',
        'Harness could not reach this computer. Check that it is online, then try again.',
      );
    }
  }

  /// One `share_*` action; the shares are read again after it, whatever it
  /// answered.
  Future<Map<String, dynamic>> act(
    String action,
    Map<String, dynamic> payload,
  ) async {
    final account = _account;
    final flow = switch (action) {
      'share_invite' => ProductFlow.shareInvite,
      'share_accept' => ProductFlow.shareAccept,
      _ => null,
    };
    final finish = flow == null ? null : measurement?.begin(flow);
    try {
      final answer = await _ask(action, payload);
      if (account != _account || _disposed) {
        finish?.call(ProductOutcome.cancelled);
        return answer;
      }
      if (action == 'share_invite') {
        final sent = answer['invited'];
        final refused = answer['refused'];
        measurement?.sharedInvites(
          sent: sent is List ? sent.length : 0,
          refused: refused is List ? refused.length : 0,
        );
        finish?.call(
          sent is! List
              ? ProductOutcome.unknown
              : sent.isEmpty
              ? ProductOutcome.failed
              : ProductOutcome.ok,
        );
      } else {
        finish?.call(
          answer['pending'] == true
              ? ProductOutcome.unknown
              : answer['sharedTabId'] is String
              ? ProductOutcome.ok
              : ProductOutcome.unknown,
        );
      }
      return answer;
    } catch (_) {
      finish?.call(ProductOutcome.failed);
      rethrow;
    } finally {
      if (account == _account && !_disposed) unawaited(refresh());
    }
  }

  Future<void> dismiss(String id) async {
    try {
      await act('share_notice_dismiss', {'id': id});
    } on SharedTabsFailure catch (e) {
      if (e.code == 'NOT_FOUND') return;
      _hidden.add(id);
      _notify();
    }
  }

  SharedTasks tasksFor(String sharedTabId) =>
      _tasks[sharedTabId] ?? const SharedTasks();

  /// Reads the tab's tasks; a second call while one runs joins it.
  ///
  /// The first argument is the key [tasksFor] answers by: the shared tab id, or, for a desk tab
  /// that is not shared, any key the caller keeps with [tabId] (the desk tab
  /// the daemon reads by).
  Future<void> loadTasks(String sharedTabId, {String? tabId}) {
    final running = _taskReads[sharedTabId];
    if (running != null) return running;
    late final Future<void> flight;
    flight = _loadTasks(sharedTabId, tabId).whenComplete(() {
      // After a reset a newer flight may hold the slot: remove only our own.
      if (identical(_taskReads[sharedTabId], flight)) {
        _taskReads.remove(sharedTabId);
      }
    });
    return _taskReads[sharedTabId] = flight;
  }

  Future<void> _loadTasks(String sharedTabId, String? tabId) async {
    final account = _account, before = tasksFor(sharedTabId);
    _tasks[sharedTabId] = SharedTasks(
      loading: true,
      loaded: before.loaded,
      rows: before.rows,
      truncated: before.truncated,
    );
    _notify();
    SharedTasks next;
    try {
      final answer = await _ask(
        'share_tasks',
        tabId != null ? {'tabId': tabId} : {'sharedTabId': sharedTabId},
      );
      final rows = answer['rows'];
      next = SharedTasks(
        loaded: true,
        rows: rows is List
            ? rows
                  .map(SharedTaskRow.fromJson)
                  .whereType<SharedTaskRow>()
                  .toList()
            : const [],
        truncated: answer['truncated'] == true,
      );
    } on SharedTabsFailure catch (e) {
      next = SharedTasks(
        loaded: before.loaded,
        rows: before.rows,
        error: e.code,
      );
    } catch (_) {
      next = SharedTasks(
        loaded: before.loaded,
        rows: before.rows,
        error: 'GH_FAILED',
      );
    }
    if (_disposed || account != _account) return;
    _tasks[sharedTabId] = next;
    _notify();
  }

  /// Each harness of the tab's repo and branch, by `machineId\u0000agentId`;
  /// empty when nobody answers.
  Future<Map<String, ({String? project, String? branch})>> who(
    String sharedTabId,
  ) async {
    final account = _account;
    try {
      final answer = await _ask('share_who', {'sharedTabId': sharedTabId});
      if (account != _account) return {};
      final list = answer['harnesses'];
      return {
        if (list is List)
          for (final h in list)
            if (h is Map && h['machineId'] is String && h['agentId'] is String)
              '${h['machineId']}\u0000${h['agentId']}': (
                project: h['project'] is String ? h['project'] as String : null,
                branch: h['branch'] is String ? h['branch'] as String : null,
              ),
      };
    } catch (_) {
      return {};
    }
  }

  @override
  void dispose() {
    _disposed = true;
    messagesSwitch?.removeListener(_switchChanged);
    _heard.dispose();
    super.dispose();
  }
}

/// Reads the shares every 60 s while the window is in front, and once as soon
/// as it comes back. A hidden or minimised window asks nothing, and neither
/// does any window while the account's Agent Messages switch is off
/// ([SharedTabsController.asking]); turned on, the controller reads at once
/// and the polls start again from there.
class SharedTabsWatch {
  SharedTabsWatch({
    required this.controller,
    required this.foreground,
    this.every = const Duration(seconds: 60),
  });

  final SharedTabsController controller;
  final ValueListenable<bool> foreground;
  final Duration every;
  Timer? _timer;
  bool _started = false, _disposed = false, _asking = false;

  void start() {
    if (_started || _disposed) return;
    _started = true;
    _asking = controller.asking;
    foreground.addListener(_foregroundChanged);
    controller.messagesSwitch?.addListener(_switchChanged);
    _foregroundChanged();
  }

  void _foregroundChanged() {
    _timer?.cancel();
    _timer = null;
    if (foreground.value && controller.asking) unawaited(poll());
  }

  /// The settings store notifies on each of its 30 s reads: only a change
  /// counts.
  void _switchChanged() {
    final asking = controller.asking;
    if (_disposed || asking == _asking) return;
    _asking = asking;
    _timer?.cancel();
    _timer = null;
    if (asking && foreground.value) {
      _timer = Timer(every, () => unawaited(poll()));
    }
  }

  @visibleForTesting
  Future<void> poll() async {
    _timer?.cancel();
    _timer = null;
    if (_disposed || !foreground.value || !controller.asking) return;
    await controller.refresh();
    if (!_disposed &&
        _started &&
        foreground.value &&
        controller.asking &&
        _timer == null) {
      _timer = Timer(every, () => unawaited(poll()));
    }
  }

  void dispose() {
    _disposed = true;
    _timer?.cancel();
    _timer = null;
    if (_started) {
      foreground.removeListener(_foregroundChanged);
      controller.messagesSwitch?.removeListener(_switchChanged);
    }
  }
}
