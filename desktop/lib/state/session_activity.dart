import 'dart:async';

import 'package:flutter/foundation.dart';

import '../core/models.dart';
import 'app_state.dart';
import 'harness_activity.dart';
import 'harness_sessions.dart';
import 'swarm_navigation.dart';

typedef SessionActivity = ({DateTime? at, HarnessActivity? status});

/// Fresh display metadata for visible sessions. Ranking keeps its own snapshot;
/// a long-running turn must not look idle just because its last message is old.
class SessionActivityController extends ChangeNotifier {
  SessionActivityController(this.app) {
    app.addListener(_appChanged);
    app.agentUnread.addListener(_appChanged);
  }

  final AppNotifier app;
  final _external = <String, SessionActivity>{};
  Map<String, SwarmDestination> _rows = const {};
  Map<String, SessionActivity> _last = const {};
  Timer? _timer;
  bool _disposed = false;
  bool _reading = false;
  bool _scheduled = false;
  int _revision = 0;

  SessionActivity read(SwarmDestination row) {
    final machine = app.stateOf(row.machineId ?? '');
    final online =
        machine?.nodeOnline != false &&
        machine?.connectionStatus == ConnectionStatus.connected;
    if (row.external case final external?) {
      final value =
          _external[row.id] ??
          (
            at: row.lastActivityAt,
            status: external.open ? HarnessActivity.unknown : null,
          );
      return (
        at: value.at,
        status: online ? value.status : HarnessActivity.offline,
      );
    }
    final agent = machine?.agents
        .where((agent) => agent.id == row.agentId)
        .firstOrNull;
    return (
      at: agent?.lastActivityAt ?? row.lastActivityAt,
      status: row.machineId != null && row.agentId != null
          ? harnessActivity(app, row.machineId!, row.agentId!)
          : null,
    );
  }

  /// Only watch the rows on screen, including after scrolling/searching. New
  /// targets refresh after this frame; no network request changes list order.
  void watch(Iterable<SwarmDestination> rows) {
    if (_disposed) return;
    final next = {for (final row in rows) row.id: row};
    final changed = !setEquals(next.keys.toSet(), _rows.keys.toSet());
    _rows = next;
    _last = {for (final row in _rows.values) row.id: read(row)};
    if (!changed) return;
    _revision++;
    _external.removeWhere((id, _) => !next.containsKey(id));
    _timer?.cancel();
    if (next.values.any((row) => row.external != null)) {
      _timer = Timer.periodic(const Duration(seconds: 5), (_) => refresh());
      _schedule();
    }
  }

  void _schedule() {
    if (_scheduled || _disposed) return;
    _scheduled = true;
    scheduleMicrotask(() {
      _scheduled = false;
      if (!_disposed) unawaited(refresh());
    });
  }

  Future<void> refresh() async {
    if (_reading || _disposed) return;
    _reading = true;
    final revision = _revision;
    try {
      await Future.wait([
        for (final row in _rows.values.where((row) => row.external != null))
          _readExternal(row, revision),
      ]);
    } finally {
      _reading = false;
    }
    if (_disposed) return;
    if (revision != _revision) {
      _schedule();
      return;
    }
    _appChanged();
  }

  Future<void> _readExternal(SwarmDestination row, int revision) async {
    final reply = await app.readSessionTail(
      row.machineId!,
      row.external!.sessionId,
      maxChars: 1000,
    );
    if (_disposed || revision != _revision) return;
    if (reply == null) {
      // A failed read cannot keep claiming work is still in progress.
      _external[row.id] = (at: read(row).at, status: HarnessActivity.unknown);
      return;
    }
    final at = reply['lastAt'];
    final external = reply['external'];
    final open = external is Map && external['open'] == true;
    final working = external is Map ? external['working'] : null;
    _external[row.id] = (
      at: at is int ? DateTime.fromMillisecondsSinceEpoch(at) : read(row).at,
      status: !open
          ? null
          : working == true
          ? HarnessActivity.working
          : working == false
          ? HarnessActivity.idle
          : HarnessActivity.unknown,
    );
  }

  void _appChanged() {
    if (_disposed) return;
    final next = {for (final row in _rows.values) row.id: read(row)};
    if (mapEquals(next, _last)) return;
    _last = next;
    notifyListeners();
  }

  @override
  void dispose() {
    _disposed = true;
    _timer?.cancel();
    app.removeListener(_appChanged);
    app.agentUnread.removeListener(_appChanged);
    super.dispose();
  }
}

String? sessionActivityLabel(SessionActivity activity, DateTime now) =>
    activity.at == null ? null : harnessActivityAge(activity.at, now);

String sessionActivityTooltip(SessionActivity activity) => [
  ?activity.status?.label,
  if (activity.at case final at?) harnessActivityTooltip(at),
].join(' · ');
