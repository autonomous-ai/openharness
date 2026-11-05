import 'dart:async';

import 'package:clock/clock.dart';
import 'package:flutter/foundation.dart';

import '../core/models.dart' show sameMachineId;
import '../state/app_state.dart';
import 'controller.dart';
import 'machines.dart' show contributeComputer;
import 'personal_projects.dart' show PersonalProjects;

/// A machine of the person's own not yet in their Personal Swarm: why, in one
/// word, and the [reason] behind a failure, for its hover.
typedef PersonalMachineRow = ({
  String machineId,
  String name,
  String status,
  String? reason,
  bool canRetry,
});

/// The person's own machines in their Personal Swarm, per app (Dee,
/// 2026-11-02: it listed only the computers its app was opened on). Linked and
/// their own: never a Harness Team account's, nor one shared with them. Only
/// while Personal is theirs alone, as [PersonalProjects.eligible] says. Each is
/// added as Add machine adds it, one at a time. This computer has its own path
/// (`PersonalSwarm.show`). An offline machine cannot be set up, so it waits
/// here until it is online. One the person removed stays out, on every
/// computer: the server keeps that (backend commands.ts machine.remove).
/// Draws nothing itself: where the rows show is the list's (machines.dart).
class PersonalMachines extends ChangeNotifier {
  PersonalMachines._(this.app);
  static final _of = Expando<PersonalMachines>();
  static PersonalMachines of(AppNotifier app) =>
      _of[app] ??= PersonalMachines._(app);

  final AppNotifier app;

  /// What Try again on a machine that is off runs first (task #3042).
  @visibleForTesting
  late Future<void> Function() reconnect = app.retryMachines;

  /// Try again on [machineId]'s row (task #3042): not built yet.
  Future<void> retry(SuperTabController c, String machineId) async {}

  /// The longest wait before a failed machine is asked again.
  static const maxRetryWait = Duration(minutes: 5);

  final _syncing = <String>{};
  final _again = <String>{};
  final _failures = <String, int>{};
  final _retryAt = <String, DateTime>{};
  final _reasons = <String, String>{};

  bool _inSwarm(SuperTabController c, String machineId) =>
      (c.snapshot?.machines ?? const <Map<String, dynamic>>[]).any(
        (m) =>
            m['machineId'] is String &&
            sameMachineId(m['machineId'], machineId),
      );

  /// The person's own linked machines, read afresh each time: one shared or
  /// made a Team account's since is never asked.
  Iterable<MachineState> get _own => app.machineStates.values.where(
    (m) =>
        !m.isLocalMachine &&
        !m.machine.isTeamAccount &&
        !m.belongsToOtherAccount &&
        !m.needsLink,
  );

  /// One the person took out: the server's record, on every computer.
  bool _left(SuperTabController c, String machineId) =>
      (c.snapshot?.removedMachines ?? const <String>[]).any(
        (id) => sameMachineId(id, machineId),
      );

  /// What the list shows: the person's own machines still to join. Nothing
  /// while Personal is not known to be theirs alone.
  List<PersonalMachineRow> waiting(SuperTabController c) {
    if (!_mayAdd(c)) return const [];
    return [
      for (final m in _own)
        if (!_inSwarm(c, m.machine.machineId) && !_left(c, m.machine.machineId))
          (
            machineId: m.machine.machineId,
            name: m.machine.displayName,
            status: m.isOffline
                ? 'Offline'
                : _reasons.containsKey(_key(c, m.machine.machineId))
                ? "Couldn't add"
                : 'Adding',
            reason: m.isOffline ? null : _reasons[_key(c, m.machine.machineId)],
            canRetry: false,
          ),
    ];
  }

  String _key(SuperTabController c, String machineId) =>
      '${c.accountId}/${c.tabId}/$machineId';

  /// Personal, its alone-ness read from the server: a saved view may be from
  /// before someone joined.
  bool _mayAdd(SuperTabController c) =>
      PersonalProjects.of(app).eligible(c) && !c.showingSaved;

  /// Adds what can be added now, one at a time; a call during one runs it again
  /// after. Run when Personal changes, so an offline machine joins soon after
  /// it comes online, and a failed one once its wait is over.
  Future<void> sync(SuperTabController c) async {
    if (!_mayAdd(c)) return;
    final account = c.accountId, scope = '$account/${c.tabId}';
    if (!_syncing.add(scope)) {
      _again.add(scope);
      return;
    }
    bool alive() =>
        _mayAdd(c) && _syncing.contains(scope) && c.accountId == account;
    try {
      notifyListeners();
      do {
        _again.remove(scope);
        final tried = <String>{};
        while (alive()) {
          final next = _own.where((m) {
            final id = m.machine.machineId;
            final retryAt = _retryAt[_key(c, id)];
            return !tried.contains(id) &&
                !m.isOffline &&
                !_inSwarm(c, id) &&
                !_left(c, id) &&
                (retryAt == null || !clock.now().isBefore(retryAt));
          }).firstOrNull;
          if (next == null) break;
          final id = next.machine.machineId;
          tried.add(id);
          await _add(c, id, alive);
          notifyListeners();
        }
      } while (_again.contains(scope));
    } finally {
      _syncing.remove(scope);
      _again.remove(scope);
      notifyListeners();
    }
  }

  Future<void> _add(
    SuperTabController c,
    String machineId,
    bool Function() alive,
  ) async {
    final key = _key(c, machineId);
    try {
      final added = await contributeComputer(
        c,
        app,
        machineId,
        setupId: 'personal-machine-$machineId',
        alive: alive,
        // If someone joins Personal later, teammates' work still never runs
        // on these under their owner's login.
        teamAccountOnly: true,
        // Only what is missing, and never one the person took out: the server
        // decides, whatever this computer's read was.
        ifMissing: true,
        unlessRemoved: true,
        offerTeamAccount: false,
      );
      if (added == null) return;
      _failures.remove(key);
      _retryAt.remove(key);
      _reasons.remove(key);
    } catch (failure) {
      if (!alive()) return;
      final count = _failures[key] = (_failures[key] ?? 0) + 1;
      final wait = Duration(seconds: 5 << count.clamp(1, 6));
      _retryAt[key] = clock.now().add(
        wait < maxRetryWait ? wait : maxRetryWait,
      );
      _reasons[key] = failure is SuperTabFailure
          ? failure.message
          : 'Could not add this machine.';
    }
  }
}
