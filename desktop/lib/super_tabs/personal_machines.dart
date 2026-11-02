import 'dart:async';
import 'dart:convert';

import 'package:clock/clock.dart';
import 'package:flutter/foundation.dart';

import '../core/models.dart' show sameMachineId;
import '../state/app_state.dart';
import 'controller.dart';
import 'machines.dart' show contributeComputer;
import 'model.dart';
import 'personal_projects.dart' show PersonalProjects;

/// A machine of the person's own not yet in their Personal Swarm: why, in one
/// word, and the [reason] behind a failure, for its hover.
typedef PersonalMachineRow = ({
  String machineId,
  String name,
  String status,
  String? reason,
});

/// The person's own machines in their Personal Swarm, per app (Dee,
/// 2026-11-02: it listed only the computers its app was opened on). Linked and
/// their own: never a Harness Team account's, nor one shared with them. Only
/// while Personal is theirs alone, as [PersonalProjects.eligible] says. Each is
/// added as Add machine adds it, one at a time. This computer has its own path
/// (`PersonalSwarm.show`). An offline machine cannot be set up, so it waits
/// here until it is online. One the person removed stays out: every machine
/// seen in the Swarm is remembered, and one remembered and gone was removed.
/// Draws nothing itself: where the rows show is the list's (machines.dart).
class PersonalMachines extends ChangeNotifier {
  PersonalMachines._(this.app);
  static final _of = Expando<PersonalMachines>();
  static PersonalMachines of(AppNotifier app) =>
      _of[app] ??= PersonalMachines._(app);

  final AppNotifier app;

  /// The longest wait before a failed machine is asked again.
  static const maxRetryWait = Duration(minutes: 5);

  /// The machines seen in an account's Personal Swarm:
  /// `super_tab.machines.<account>` (account_keys.dart sweeps it).
  static String storageKey(String account) => 'super_tab.machines.$account';

  final _seen = <String, Set<String>>{};
  final _loads = <String, Future<bool>>{};
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

  bool _left(SuperTabController c, String machineId) =>
      _seen[c.accountId]?.any((id) => sameMachineId(id, machineId)) ?? false;

  /// What the list shows: the person's own machines still to join. Nothing
  /// while Personal is not theirs alone, or their memory of it is not read yet.
  List<PersonalMachineRow> waiting(SuperTabController c) {
    if (!PersonalProjects.of(app).eligible(c) ||
        !_seen.containsKey(c.accountId)) {
      return const [];
    }
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
          ),
    ];
  }

  String _key(SuperTabController c, String machineId) =>
      '${c.accountId}/${c.tabId}/$machineId';

  /// Reads what this computer remembers; false when it cannot, and then nothing
  /// is added: a machine the person removed could come back.
  Future<bool> _load(String account) => _loads[account] ??= () async {
    try {
      final text = await app.superTabs.storage.read(storageKey(account));
      final saved = text == null ? const [] : jsonDecode(text) as List;
      _seen[account] = {
        ...?_seen[account],
        for (final id in saved)
          if (id is String) id,
      };
      return true;
    } catch (_) {
      unawaited(_loads.remove(account));
      return false;
    }
  }();

  void _remember(SuperTabController c) {
    final account = c.accountId;
    final seen = _seen[account];
    if (seen == null) return;
    final before = seen.length;
    for (final m in c.snapshot?.machines ?? const <Map<String, dynamic>>[]) {
      if (m['machineId'] case final String id) seen.add(id);
    }
    if (seen.length == before) return;
    unawaited(
      app.superTabs.storage
          .write(storageKey(account), jsonEncode([...seen]..sort()))
          .catchError((Object _) {}),
    );
  }

  /// Adds what can be added now, one at a time; a call during one runs it again
  /// after. Run when Personal changes, so an offline machine joins soon after
  /// it comes online, and a failed one once its wait is over.
  Future<void> sync(SuperTabController c) async {
    final projects = PersonalProjects.of(app);
    if (!projects.eligible(c)) return;
    final account = c.accountId, scope = '$account/${c.tabId}';
    if (!_syncing.add(scope)) {
      _again.add(scope);
      return;
    }
    bool alive() =>
        projects.eligible(c) &&
        _syncing.contains(scope) &&
        c.accountId == account;
    try {
      if (!await _load(account)) return;
      notifyListeners();
      do {
        _again.remove(scope);
        final tried = <String>{};
        while (alive()) {
          _remember(c);
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
        // As Add machine: where the Swarm runs teammates' work through Team
        // accounts, a machine is never lent under its owner's own login.
        teamAccountOnly: c.snapshot?.teamAccounts ?? false,
        offerTeamAccount: false,
      );
      if (added == null) return;
      _failures.remove(key);
      _retryAt.remove(key);
      _reasons.remove(key);
      _remember(c);
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
