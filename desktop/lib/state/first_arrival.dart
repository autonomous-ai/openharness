import 'dart:async';
import 'dart:io';

import 'package:flutter/foundation.dart';

import '../core/local_key_value_store.dart';
import '../core/permission_modes.dart';
import '../core/project_folder.dart';
import '../logging/app_log.dart';
import 'app_state.dart';
import 'harness_placement.dart';
import 'session_content_search.dart';
import 'swarm_navigation.dart';

@immutable
class ArrivalSession {
  const ArrivalSession({
    required this.engine,
    required this.sessionId,
    required this.cwd,
    required this.lastAt,
    this.title = '',
  });
  final String engine, sessionId, cwd, title;
  final DateTime lastAt;
}

/// One recent conversation or one fresh agent. Opening a workspace never submits a task.
@immutable
class FirstArrivalPlan {
  const FirstArrivalPlan({this.tabs = const [], this.fresh = const []});
  final List<List<ArrivalSession>> tabs;
  final List<String> fresh;
  bool get isEmpty => tabs.isEmpty && fresh.isEmpty;
  bool get typesStarterTask => fresh.isNotEmpty;
}

/// One useful harness on a computer new to Harness. Failed preparation stays recoverable;
/// it must not silently spend onboarding or start again in an unrelated empty tab.
class FirstArrival {
  FirstArrival(this._storage, {DateTime Function()? now})
    : _now = now ?? DateTime.now;

  static const key = 'first_arrival_v1';
  static const starterTask = "Make a small web page that shows today's date.";
  static const window = Duration(days: 30);
  final LocalKeyValueStore? _storage;
  final DateTime Function() _now;
  String? _state;
  bool _running = false;
  Future<void>? _beginning;
  Future<bool>? _inFlight;
  String? _error;
  ArrivalSession? _selectedSession;
  String? _selectedEngine;
  FirstArrivalPlan? _plan;
  AgentCreationAttempt? _attempt;
  String? _preparedFolder;
  String? _selectedMachine;

  bool get pending => !_running && (_state == 'new' || _state == 'agents');
  bool get running => _running;
  bool get needsRecovery =>
      !_running &&
      ((_state?.startsWith('retry:') ?? false) ||
          (_state?.startsWith('check:') ?? false));
  bool get canRetry =>
      needsRecovery &&
      (!(_state?.startsWith('check:') ?? false) || _attempt != null);
  bool get checkingStatus => _attempt?.awaitingConfirmation == true;
  String? get error => needsRecovery
      ? _error ??
            (canRetry
                ? 'Your first harness could not be opened. Try again or start a new harness.'
                : 'The earlier start is not confirmed. Open harnesses to check whether it is running.')
      : null;
  ArrivalSession? get selectedSession => _selectedSession;
  String? get selectedEngine => _selectedSession?.engine ?? _selectedEngine;

  Future<void> restore() async {
    if (_beginning case final beginning?) return beginning;
    _state = await _read();
  }

  void begin({required bool downloads}) {
    _beginning ??= () async {
      final previous = await _read();
      if (previous == 'done' || (previous?.contains(':') ?? false)) {
        _state = previous;
        return;
      }
      _state = downloads ? 'new' : 'agents';
      await _write(_state!);
    }();
  }

  /// The person chose another way into the workspace. Never reopen onboarding behind them.
  void dismiss() {
    _state = 'done';
    _error = null;
    unawaited(_write('done'));
  }

  Future<bool> retry(AppNotifier app, {bool Function()? stillCurrent}) {
    if (_inFlight case final work?) return work;
    if (!canRetry) return Future.value(false);
    _state = _state!.split(':').last;
    _error = null;
    return run(app, stillCurrent: stillCurrent);
  }

  Future<String?> _read() async {
    try {
      return await _storage?.read(key);
    } catch (_) {
      return null;
    }
  }

  Future<void> _write(String value) async {
    try {
      await _storage?.write(key, value);
    } catch (_) {
      /* Local convenience only. */
    }
  }

  Future<bool> run(
    AppNotifier app, {
    bool Function()? stillCurrent,
    Duration machineWait = const Duration(seconds: 30),
    Duration indexWait = const Duration(seconds: 15),
    Duration installWait = const Duration(minutes: 10),
  }) {
    if (_inFlight case final work?) return work;
    if (!pending) return Future.value(false);
    final work = _run(
      app,
      stillCurrent: stillCurrent,
      machineWait: machineWait,
      indexWait: indexWait,
      installWait: installWait,
    );
    _inFlight = work;
    return work.whenComplete(() => _inFlight = null);
  }

  Future<bool> _run(
    AppNotifier app, {
    bool Function()? stillCurrent,
    required Duration machineWait,
    required Duration indexWait,
    required Duration installWait,
  }) async {
    _running = true;
    final state = _state!;
    final generation = app.accountGeneration;
    var opened = false;
    String? tab;
    bool current() =>
        _state != 'done' &&
        app.signedIn &&
        app.accountGeneration == generation &&
        (stillCurrent?.call() ?? true) &&
        (tab == null || app.activeSwarmId == tab);
    bool fail(String message) {
      _error = message;
      _state = '${checkingStatus ? 'check' : 'retry'}:$state';
      unawaited(_write(_state!));
      return false;
    }

    try {
      if (!current() || app.allPanes.isNotEmpty) {
        dismiss();
        return false;
      }
      app.productMeasurement.firstRunStarted();
      final machine = await _localMachine(app, machineWait);
      if (!current()) {
        dismiss();
        return false;
      }
      if (machine == null) {
        return fail(
          'This computer has not connected yet. Try again when it is connected.',
        );
      }
      final machineId = machine.machine.machineId;
      if (_selectedMachine != null && _selectedMachine != machineId) {
        return fail(
          'The computer changed. Choose a harness on the computer you want to use.',
        );
      }
      final (sessions, _) = await (
        recentSessions(app, machineId, budget: indexWait),
        app.probeEngines(machineId),
      ).wait;
      if (!current() || app.allPanes.isNotEmpty) {
        dismiss();
        return false;
      }
      final installed = {
        for (final engine in const ['claude', 'codex', 'opencode'])
          if (machine.engines[engine]?.installed == true) engine,
      };
      final signedOut = {
        for (final engine in const ['claude', 'codex'])
          if (machine.engines[engine]?.signedIn == false) engine,
      };
      final plan = _plan ??= planFirstArrival(
        newUser: state == 'new',
        sessions: sessions,
        installed: installed,
        signedOut: signedOut,
        signedIn: {
          for (final engine in const ['claude', 'codex'])
            if (machine.engines[engine]?.signedIn == true) engine,
        },
      );
      if (plan.isEmpty) {
        _plan = null;
        return fail('Choose an agent to start your first harness.');
      }
      _selectedMachine = machineId;
      if (_attempt?.awaitingConfirmation != true) {
        _attempt = AgentCreationAttempt(holdWait: installWait);
      }
      tab = app.activeSwarmId;
      String? failure;
      if (plan.tabs.isNotEmpty) {
        final session = plan.tabs.single.single;
        _selectedSession = session;
        final result = await app.resumeConversation(
          machineId,
          engine: session.engine,
          folder: session.cwd,
          sessionId: session.sessionId,
          name: session.title.isEmpty ? null : session.title,
          swarmId: tab,
          placement: HarnessPlacement.currentTab,
          attempt: _attempt,
        );
        failure = result.error;
      } else {
        _selectedSession = null;
        final engine = plan.fresh.single;
        _selectedEngine = engine;
        final folder = _preparedFolder ??= await app.prepareLocalProjectFolder(
          ProjectFolderRequest.generated(
            label: externalEngineName(engine),
            at: _now(),
            task: starterTask,
          ),
          label: externalEngineName(engine),
        );
        if (!current() || app.allPanes.isNotEmpty) {
          dismiss();
          return false;
        }
        failure = await app.createAgent(
          machineId,
          engine: engine,
          folder: folder,
          permissionMode: kDefaultPermissionMode,
          swarmId: tab,
          placement: HarnessPlacement.currentTab,
          attempt: _attempt,
        );
      }
      if (!current()) {
        dismiss();
        return false;
      }
      if (failure != null) return fail(failure);
      final panes = app.swarms.where((s) => s.id == tab).firstOrNull?.panes;
      final createdId = _attempt?.agentId;
      final pane = panes
          ?.where(
            (p) =>
                p.machineId == machineId &&
                (createdId == null
                    ? panes.length == 1
                    : p.agentId == createdId),
          )
          .firstOrNull;
      if (pane == null) {
        return fail('The harness has not opened yet. Try again to check it.');
      }
      if (plan.typesStarterTask) {
        // An editable Flutter draft, not keystrokes sent to a terminal that may still be signing in.
        pane.firstTask = starterTask;
        pane.composerVisible = true;
      }
      app.focusPane(pane.id, reveal: true);
      app.productMeasurement.firstRunReady(machineId, pane.agentId);
      opened = true;
      dismiss();
      return true;
    } catch (_) {
      if (!current()) {
        dismiss();
        return false;
      }
      return fail(
        'Your first harness could not be opened. Try again or choose another agent.',
      );
    } finally {
      _running = false;
      appLog.info(
        'onboarding',
        'first arrival: ${opened ? 'opened one harness' : 'opened nothing'}',
      );
    }
  }

  Future<MachineState?> _localMachine(AppNotifier app, Duration wait) async {
    final deadline = _now().add(wait);
    while (true) {
      final machine = app.localMachineState;
      if (machine != null &&
          app.searchableMachineIds.contains(machine.machine.machineId)) {
        return machine;
      }
      if (!_now().isBefore(deadline)) return null;
      await Future<void>.delayed(const Duration(milliseconds: 250));
    }
  }

  Future<List<ArrivalSession>> recentSessions(
    AppNotifier app,
    String machineId, {
    required Duration budget,
  }) async {
    final at = _now();
    final hits = await app.searchSessions(
      machineId,
      '',
      when: (
        from: at.subtract(window),
        to: at,
        phrase: 'last ${window.inDays} days',
      ),
      limit: 30,
      budget: budget,
    );
    return sessionsFromHits(
      hits ?? const [],
      folderExists: (path) {
        try {
          return path.isNotEmpty && Directory(path).existsSync();
        } catch (_) {
          return false;
        }
      },
    );
  }
}

/// Prefer one recent usable conversation, then one signed-in engine. A person with no
/// configured agent gets OpenCode alone; optional provider sign-ins can happen after first work.
FirstArrivalPlan planFirstArrival({
  required bool newUser,
  required List<ArrivalSession> sessions,
  required Set<String> installed,
  Set<String> signedOut = const {},
  Set<String> signedIn = const {},
}) {
  final usable =
      sessions
          .where(
            (s) =>
                installed.contains(s.engine) && !signedOut.contains(s.engine),
          )
          .toList()
        ..sort((a, b) => b.lastAt.compareTo(a.lastAt));
  if (usable.isNotEmpty) {
    return FirstArrivalPlan(
      tabs: [
        [usable.first],
      ],
    );
  }
  final ready = [
    for (final engine in const ['claude', 'codex'])
      if (installed.contains(engine) && !signedOut.contains(engine)) engine,
  ];
  final engine =
      ready.where(signedIn.contains).firstOrNull ?? ready.firstOrNull;
  if (engine != null) return FirstArrivalPlan(fresh: [engine]);
  if (newUser ||
      installed.contains('opencode') ||
      installed.any(signedOut.contains)) {
    return const FirstArrivalPlan(fresh: ['opencode']);
  }
  return const FirstArrivalPlan();
}

/// Recent conversations from a `session_search` answer: Claude Code and Codex only, Harness's own
/// left out, none that a process anywhere has open, none whose folder has gone, once each.
List<ArrivalSession> sessionsFromHits(
  List<SessionContentHit> hits, {
  required bool Function(String path) folderExists,
}) {
  final seen = <String>{};
  final sessions = <ArrivalSession>[];
  for (final hit in hits) {
    final ref = hit.external;
    final at = hit.lastAt ?? hit.at;
    if (ref == null || ref.open || at == null) continue;
    if (ref.engine != 'claude' && ref.engine != 'codex') continue;
    if (!seen.add('${ref.engine}:${ref.sessionId}')) continue;
    if (!folderExists(ref.cwd)) continue;
    sessions.add(
      ArrivalSession(
        engine: ref.engine,
        sessionId: ref.sessionId,
        cwd: ref.cwd,
        title: ref.title,
        lastAt: at,
      ),
    );
  }
  sessions.sort((a, b) => b.lastAt.compareTo(a.lastAt));
  return sessions;
}
