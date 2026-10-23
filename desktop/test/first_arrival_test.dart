import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/local_key_value_store.dart';
import 'package:harness/core/models.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/state/first_arrival.dart';
import 'package:harness/core/engine_availability.dart';
import 'package:harness/core/project_folder.dart';
import 'package:harness/state/harness_placement.dart';
import 'package:harness/state/pane_arrangement.dart';
import 'package:harness/state/terminal_pane.dart';
import 'package:harness/state/session_content_search.dart';
import 'package:harness/state/swarm_navigation.dart';

class _MemoryStore implements LocalKeyValueStore {
  final values = <String, String>{};
  @override
  Future<String?> read(String key) async => values[key];
  @override
  Future<void> write(String key, String value) async => values[key] = value;
  @override
  Future<void> delete(String key) async => values.remove(key);
}

class _PreparingApp extends AppNotifier {
  _PreparingApp()
    : super(
        config: AppConfig.dev,
        authSession: AuthSession(),
        configStore: null,
      );

  final engineCheck = Completer<void>();
  int generation = 0;
  @override
  int get accountGeneration => generation;
  bool probing = false;
  final local = MachineState(
    const Machine(
      machineId: 'local',
      name: 'Mac',
      authMode: MachineAuthMode.self,
    ),
  );
  @override
  MachineState get localMachineState => local;
  @override
  Iterable<String> get searchableMachineIds => ['local'];
  @override
  Future<void> probeEngines(String machineId, {bool force = false}) {
    probing = true;
    return engineCheck.future;
  }
}

class _PreparingArrival extends FirstArrival {
  _PreparingArrival(super.storage);
  final index = Completer<List<ArrivalSession>>();
  bool searching = false;
  @override
  Future<List<ArrivalSession>> recentSessions(
    AppNotifier app,
    String machineId, {
    required Duration budget,
  }) {
    searching = true;
    return index.future;
  }
}

class _OpeningApp extends _PreparingApp {
  _OpeningApp() {
    machineStates['local'] = local;
    local.engines.replace([
      const EngineAvailability(
        engine: 'codex',
        installed: true,
        signedIn: true,
      ),
    ]);
  }
  final starts = <({String engine, String? folder, String? prompt})>[];
  String? refusal;
  int folders = 0;
  @override
  Future<void> probeEngines(String machineId, {bool force = false}) async {}
  @override
  Future<String> prepareLocalProjectFolder(
    ProjectFolderRequest request, {
    String label = 'harness',
  }) async {
    folders++;
    return '/work/first-task';
  }

  @override
  Future<String?> createAgent(
    String machineId, {
    required String engine,
    required String? folder,
    ProjectFolderRequest? projectFolder,
    bool bypassPermission = true,
    String? permissionMode,
    String? codexHome,
    String? dsh,
    GridModel? model,
    String? prompt,
    String? name,
    String? agent,
    String? swarmId,
    String? swarmRole,
    String? swarmSkillMode,
    PaneSplitRequest? split,
    AgentCreationAttempt? attempt,
    HarnessPlacement? placement,
  }) async {
    starts.add((engine: engine, folder: folder, prompt: prompt));
    if (refusal != null) return refusal;
    activeSwarm.panes.add(
      TerminalPane(id: 1, machineId: machineId, agentId: 'first'),
    );
    return null;
  }
}

final _base = DateTime(2026, 10, 8, 12);

/// A conversation last active [minutesAgo] minutes before noon.
ArrivalSession _s(String engine, String id, int minutesAgo) => ArrivalSession(
  engine: engine,
  sessionId: id,
  cwd: '/work/$id',
  lastAt: _base.subtract(Duration(minutes: minutesAgo)),
);

List<List<String>> _ids(List<List<ArrivalSession>> tabs) => [
  for (final tab in tabs) [for (final session in tab) session.sessionId],
];

SessionContentHit _hit(
  String sessionId, {
  String engine = 'claude',
  bool open = false,
  String? openIn,
  int minutesAgo = 0,
  String? cwd,
  bool external = true,
}) => SessionContentHit(
  machineId: 'local',
  agentId: external ? '' : 'agent-$sessionId',
  sessionId: sessionId,
  field: 'name',
  snippet: '',
  together: false,
  score: 1,
  lastAt: _base.subtract(Duration(minutes: minutesAgo)),
  external: external
      ? ExternalSessionRef(
          sessionId: sessionId,
          engine: engine,
          cwd: cwd ?? '/work/$sessionId',
          origin: 'terminal',
          title: 'Title $sessionId',
          open: open,
          openIn: openIn,
        )
      : null,
);

void main() {
  group('planFirstArrival', () {
    test('opens only the most recent usable conversation', () {
      final plan = planFirstArrival(
        newUser: false,
        sessions: [
          _s('claude', 'old', 9),
          _s('codex', 'new', 1),
          _s('claude', 'next', 2),
        ],
        installed: {'claude', 'codex', 'opencode'},
      );
      expect(_ids(plan.tabs), [
        ['new'],
      ]);
      expect(plan.fresh, isEmpty);
    });
    test('does not select history for a missing or signed-out agent', () {
      final plan = planFirstArrival(
        newUser: false,
        sessions: [_s('claude', 'unavailable', 1), _s('codex', 'ready', 2)],
        installed: {'codex'},
        signedOut: {'claude'},
      );
      expect(_ids(plan.tabs), [
        ['ready'],
      ]);
    });
    test('a new setup opens OpenCode alone with an unsent suggestion', () {
      final plan = planFirstArrival(newUser: true, sessions: [], installed: {});
      expect(plan.fresh, ['opencode']);
      expect(plan.typesStarterTask, isTrue);
    });
    test('prefers a configured agent to an unknown credential', () {
      expect(
        planFirstArrival(
          newUser: false,
          sessions: [],
          installed: {'claude', 'codex'},
          signedIn: {'codex'},
        ).fresh,
        ['codex'],
      );
    });
    test('a fresh configured agent also gets an editable suggestion', () {
      final plan = planFirstArrival(
        newUser: false,
        sessions: [],
        installed: {'claude', 'codex'},
      );
      expect(plan.fresh, ['claude']);
      expect(plan.typesStarterTask, isTrue);
    });
    test('unconfigured providers leave one OpenCode harness', () {
      expect(
        planFirstArrival(
          newUser: false,
          sessions: [],
          installed: {'claude', 'codex'},
          signedOut: {'claude', 'codex'},
        ).fresh,
        ['opencode'],
      );
    });
    test('no available engine has an explicit recovery path', () {
      expect(
        planFirstArrival(newUser: false, sessions: [], installed: {}).isEmpty,
        isTrue,
      );
    });
  });

  group('sessionsFromHits', () {
    test('keeps Claude Code and Codex conversations nothing is running', () {
      final sessions = sessionsFromHits([
        _hit('old', minutesAgo: 30),
        _hit('new', engine: 'codex', minutesAgo: 1),
        _hit('running', open: true, openIn: 'app'),
        _hit('in-terminal', open: true, openIn: 'terminal'),
        _hit('other-engine', engine: 'gemini'),
        _hit('harness-own', external: false),
        _hit('gone', cwd: '/gone'),
        _hit('old', minutesAgo: 30),
      ], folderExists: (path) => path != '/gone');
      expect([for (final s in sessions) s.sessionId], ['new', 'old']);
      expect(sessions.first.engine, 'codex');
      expect(sessions.first.title, 'Title new');
      expect(sessions.first.cwd, '/work/new');
    });
  });

  group('FirstArrival', () {
    test('an account change during preparation prevents the launch', () async {
      final app = _OpeningApp();
      addTearDown(app.dispose);
      final arrival = _PreparingArrival(_MemoryStore())
        ..begin(downloads: false);
      await arrival.restore();
      final opening = arrival.run(app);
      await Future<void>.delayed(Duration.zero);
      app.generation++;
      arrival.index.complete([]);
      expect(await opening, isFalse);
      expect(app.starts, isEmpty);
    });

    test(
      'loading the initial sharing preference does not cancel onboarding',
      () async {
        final app = _OpeningApp();
        addTearDown(app.dispose);
        final arrival = _PreparingArrival(_MemoryStore())
          ..begin(downloads: false);
        await arrival.restore();
        final opening = arrival.run(app);
        await Future<void>.delayed(Duration.zero);
        app.productMeasurement.savedChoice({'enabled': true, 'revision': 0});
        arrival.index.complete([]);
        expect(await opening, isTrue);
        expect(app.starts, hasLength(1));
      },
    );

    test(
      'opens one fresh harness with a local draft and no submitted prompt',
      () async {
        final app = _OpeningApp();
        addTearDown(app.dispose);
        final arrival = _PreparingArrival(_MemoryStore())
          ..begin(downloads: false);
        await arrival.restore();
        arrival.index.complete([]);
        expect(await arrival.run(app), isTrue);
        expect(app.starts, [
          (engine: 'codex', folder: '/work/first-task', prompt: null),
        ]);
        expect(app.allPanes.single.firstTask, FirstArrival.starterTask);
        expect(app.allPanes.single.composerVisible, isTrue);
        expect(arrival.pending, isFalse);
        expect(arrival.needsRecovery, isFalse);
      },
    );
    test('a failed launch retries in its prepared project and does not run later by itself', () async {
      final app = _OpeningApp()..refusal = 'Install Codex, then retry.';
      addTearDown(app.dispose);
      final arrival = _PreparingArrival(_MemoryStore())
        ..begin(downloads: false);
      await arrival.restore();
      arrival.index.complete([]);
      expect(await arrival.run(app), isFalse);
      expect(arrival.error, 'Install Codex, then retry.');
      expect(await arrival.run(app), isFalse);
      expect(app.starts, hasLength(1));
      app.refusal = null;
      expect(await arrival.retry(app), isTrue);
      expect(app.folders, 1);
      expect(app.starts.map((s) => s.folder), [
        '/work/first-task',
        '/work/first-task',
      ]);
    });

    test('the index and engine check start together and both finish before planning', () async {
      final app = _PreparingApp();
      addTearDown(app.dispose);
      final arrival = _PreparingArrival(_MemoryStore())
        ..begin(downloads: false);
      await arrival.restore();
      final opening = arrival.run(app);
      await Future<void>.delayed(Duration.zero);
      expect(arrival.searching, isTrue);
      expect(
        app.probing,
        isTrue,
        reason: 'a slow index must not delay the engine check',
      );
      var finished = false;
      opening.then((_) => finished = true);
      arrival.index.complete([]);
      await Future<void>.delayed(Duration.zero);
      expect(
        finished,
        isFalse,
        reason: 'do not infer no installed engines while the probe is pending',
      );
      app.engineCheck.complete();
      expect(await opening, isFalse); // No installed engines or conversations.
      expect(arrival.pending, isFalse);
      expect(arrival.needsRecovery, isTrue);
    });

    // Production order: setup's begin runs before the signed-in restore.
    test(
      'runs only on a computer setup has just reached, and only once',
      () async {
        final store = _MemoryStore();
        final existing = FirstArrival(store);
        await existing.restore();
        expect(existing.pending, isFalse, reason: 'an existing install');

        final fresh = FirstArrival(store)..begin(downloads: true);
        await fresh.restore();
        expect(fresh.pending, isTrue);
        expect(store.values[FirstArrival.key], 'new');

        // A relaunch before the workspace opened still owes it.
        final again = FirstArrival(store);
        await again.restore();
        expect(again.pending, isTrue);
      },
    );

    test(
      'a spent mark stays spent, even when setup runs again first',
      () async {
        final store = _MemoryStore()..values[FirstArrival.key] = 'done';
        final arrival = FirstArrival(store)..begin(downloads: false);
        await arrival.restore();
        expect(arrival.pending, isFalse);
        expect(store.values[FirstArrival.key], 'done');
      },
    );

    test(
      'a failed first connection stays recoverable without auto-retrying',
      () async {
        final store = _MemoryStore();
        final arrival = FirstArrival(store)..begin(downloads: true);
        await arrival.restore();
        final app = AppNotifier(
          config: AppConfig.dev,
          authSession: AuthSession(),
          configStore: null,
        );
        addTearDown(app.dispose);
        expect(await arrival.run(app, machineWait: Duration.zero), isFalse);
        expect(arrival.pending, isFalse);
        await Future<void>.delayed(Duration.zero);
        expect(store.values[FirstArrival.key], 'retry:new');
        expect(arrival.needsRecovery, isTrue);
        final restored = FirstArrival(store);
        await restored.restore();
        expect(restored.pending, isFalse);
        expect(restored.canRetry, isTrue);
        expect(await arrival.run(app, machineWait: Duration.zero), isFalse);
      },
    );

    test('a second call joins the run under way', () async {
      final arrival = FirstArrival(_MemoryStore())..begin(downloads: true);
      await arrival.restore();
      final app = AppNotifier(
        config: AppConfig.dev,
        authSession: AuthSession(),
        configStore: null,
      );
      addTearDown(app.dispose);
      final first = arrival.run(
        app,
        machineWait: const Duration(milliseconds: 300),
      );
      expect(arrival.running, isTrue);
      expect(arrival.pending, isFalse);
      // The workspace's call, with none of its own settings: it waits for the same run.
      final joined = arrival.run(app);
      expect(await Future.wait([first, joined]), [false, false]);
      expect(arrival.running, isFalse);
      expect(
        await arrival.run(app),
        isFalse,
        reason: 'retry requires an explicit action',
      );
      expect(arrival.canRetry, isTrue);
    });

    test('the person taking over first stops it and spends the mark', () async {
      final arrival = FirstArrival(_MemoryStore())..begin(downloads: true);
      await arrival.restore();
      final app = AppNotifier(
        config: AppConfig.dev,
        authSession: AuthSession(),
        configStore: null,
      );
      addTearDown(app.dispose);
      expect(
        await arrival.run(
          app,
          stillCurrent: () => false,
          machineWait: Duration.zero,
        ),
        isFalse,
      );
      expect(arrival.pending, isFalse);
    });
  });

  test('an uncertain start restored without its receipt is inspected, never relaunched', () async {
    final store = _MemoryStore()..values[FirstArrival.key] = 'check:new';
    final arrival = FirstArrival(store);
    await arrival.restore();
    expect(arrival.needsRecovery, isTrue);
    expect(arrival.canRetry, isFalse);
    expect(arrival.error, contains('not confirmed'));
    arrival.dismiss();
    expect(arrival.needsRecovery, isFalse);
  });
}
