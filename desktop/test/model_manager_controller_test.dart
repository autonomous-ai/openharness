import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/models/model_manager_controller.dart';
import 'package:harness/models/local_model.dart';
import 'package:harness/state/app_state.dart';

import 'support/model_manager.dart';
import 'swarm_screen_test.dart' show terminal;
import 'swarm_state_test.dart' show MemoryStore;

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  late ModelManagerConnection connection;
  late ModelManagerTestApp app;
  late ModelManagerController controller;
  setUp(() {
    connection = ModelManagerConnection();
    app = ModelManagerTestApp(connection);
    controller = ModelManagerController(
      app,
      storage: MemoryStore(),
      poll: false,
    );
  });
  tearDown(() {
    controller.dispose();
    app.dispose();
  });

  test('silent discovery preserves the workspace and never starts a model or sends a chat', () async {
    connection.holdCreation = Completer<void>();
    final original = app.activeSwarmId;
    controller.start();
    final prepare = controller.prepare();
    await controller.refresh();
    expect(controller.localModels, hasLength(5));
    expect(app.actions, isEmpty);
    expect(app.sent, isEmpty);
    expect(app.panes, isEmpty);
    connection.holdCreation!.complete();
    await prepare;
    await controller.prepare();
    expect(connection.creations, hasLength(1));
    expect(controller.manager?.dsh, AppNotifier.gridHarness);
    expect(app.activeSwarmId, original);
  });

  test(
    'advanced manager opens locally without an unsolicited setup task',
    () async {
      app.installed = false;
      controller.start();
      await controller.open();
      await controller.open();
      expect(app.installs, 1);
      expect(connection.creations, hasLength(1));
      expect(app.sent, isEmpty);
      expect(app.activeSwarm.name, modelManagerName);
      expect(app.allPanes.single.agentId, 'manager');
    },
  );

  test('a lost manager creation acknowledgement reuses its receipt', () async {
    connection.loseFirstReply = true;
    controller.start();
    await controller.prepare();
    expect(controller.manager, isNull);
    await controller.open();
    expect(connection.creations, hasLength(1));
    expect(controller.manager?.id, 'manager');
  });

  test(
    'opening the manager from another tab reuses its pending pane',
    () async {
      app.stateOf('m')!.agents = [
        const Agent(id: 'source', name: 'Work', engine: 'codex'),
      ];
      app.adoptSessionForTest(terminal('source', []));
      final sourceTab = app.activeSwarmId;
      await controller.open();
      final managerTab = app.activeSwarmId;
      final count = app.swarms.length;
      expect(managerTab, isNot(sourceTab));
      app.selectSwarm(sourceTab);
      await controller.open();
      expect(app.activeSwarmId, managerTab);
      expect(app.swarms, hasLength(count));
      expect(app.allPanes.where((p) => p.agentId == 'manager'), hasLength(1));
      expect(connection.creations, hasLength(1));
    },
  );

  test(
    'Start submits one local operation and never changes or creates a session',
    () async {
      app.stateOf('m')!.agents = [
        const Agent(id: 'source', name: 'Work', engine: 'codex'),
      ];
      app.adoptSessionForTest(terminal('source', []));
      controller.start();
      await controller.prepare();
      await controller.refresh();
      final tab = app.activeSwarmId;
      final row = controller.localModels.first;
      await controller.toggle(row);
      await controller.toggle(row);
      expect(app.actions, [(machine: 'm', model: 'qwen', start: true)]);
      expect(
        controller.operationFor(controller.localModels.first)?.progress,
        .42,
      );
      expect(app.activeSwarmId, tab);
      expect(app.focusedPane?.agentId, 'source');
      expect(
        app.stateOf('m')!.agents.firstWhere((a) => a.id == 'source').gridModel,
        isNull,
      );
      expect(app.sent, isEmpty);
      expect(connection.creations, hasLength(1));
    },
  );

  test('downloaded models use the same Start action', () async {
    await controller.refresh();
    await controller.toggle(
      controller.localModels.firstWhere((m) => m.downloaded),
    );
    expect(app.actions.single, (machine: 'm', model: 'gemma', start: true));
  });

  test(
    'the acknowledgement supplies progress while fresh inventory is in flight',
    () async {
      await controller.refresh();
      final row = controller.localModels.first;
      final reply = Completer<Map<String, dynamic>>();
      app.localReply = reply;
      final action = controller.toggle(row);
      await Future<void>.delayed(Duration.zero);
      expect(controller.operationFor(row)?.label, 'Downloading');
      expect(controller.operationFor(row)?.progress, .42);
      reply.complete(app.localInventory);
      await action;
    },
  );

  test('Stop explicitly unloads a running model', () async {
    app.localInventory = modelInventory(scenario: 'ready');
    await controller.refresh();
    await controller.toggle(controller.localModels.first);
    expect(app.actions.single, (machine: 'm', model: 'qwen', start: false));
  });

  test(
    'a lost action acknowledgement is recovered from status without replaying',
    () async {
      app.actionReplyLost = true;
      await controller.refresh();
      await controller.toggle(controller.localModels.first);
      expect(app.actions, hasLength(1));
      expect(controller.busy, isTrue);
      expect(controller.localModels.first.operation?.progress, .42);
      expect(controller.error, isNull);
    },
  );

  test(
    'readiness requires a completed test reply, not a running process alone',
    () async {
      app.localInventory = modelInventory(scenario: 'ready');
      final models = app.localInventory['models'] as List;
      models[0]['operation']['phase'] = 'running';
      await controller.refresh();
      expect(controller.readyModel, isNull);
      models[0]['operation']['phase'] = 'done';
      await controller.refresh();
      expect(controller.readyModel?.name, 'Qwen3.8-27B');
      controller.dismissReady();
      expect(controller.readyModel, isNull);
    },
  );

  test(
    'an unavailable inventory disables actions while preserving the last view',
    () async {
      await controller.refresh();
      app.localReadFails = true;
      await controller.refresh();
      expect(controller.localModels, hasLength(5));
      expect(controller.inventoryAvailable, isFalse);
      await controller.toggle(controller.localModels.first);
      expect(app.actions, isEmpty);
    },
  );

  test('an account change discards an in-flight action result', () async {
    controller.start();
    await controller.prepare();
    await controller.refresh();
    app.actionReply = Completer<Map<String, dynamic>>();
    final pending = controller.toggle(controller.localModels.first);
    app.machineStates.clear();
    app.notifyListeners();
    app.actionReply!.complete({
      'operation': {
        'id': 'old',
        'modelId': 'qwen',
        'action': 'start',
        'stage': 'downloading',
        'phase': 'running',
      },
    });
    await pending;
    expect(controller.localModels, isEmpty);
    expect(controller.pendingOperation, isNull);
    expect(controller.busy, isFalse);
  });

  test(
    'discovery invites a supported session once and remembers dismissal',
    () async {
      app.stateOf('m')!.agents = [
        const Agent(id: 'work', name: 'Work', engine: 'codex'),
      ];
      controller.start();
      controller.start();
      await controller.prepare();
      await controller.refresh();
      expect(controller.showIntroduction, isTrue);
      expect(controller.hasOwnModels, isFalse);
      await controller.dismissIntroduction();
      expect(controller.showIntroduction, isFalse);
      expect(app.actions, isEmpty);
    },
  );

  test(
    'an unavailable local connection shows a next step and cannot act',
    () async {
      await controller.refresh();
      final model = controller.localModels.first;
      app.machineStates.clear();
      await controller.refresh();
      expect(controller.error, contains('Connect this computer'));
      await controller.toggle(model);
      await controller.open();
      expect(controller.error, contains('Connect this computer'));
      expect(app.actions, isEmpty);
    },
  );

  test(
    'disconnect immediately disables actions on the last observed inventory',
    () async {
      controller.start();
      await controller.prepare();
      await controller.refresh();
      app.stateOf('m')!.connectionStatus = ConnectionStatus.disconnected;
      app.notifyListeners();
      expect(controller.inventoryAvailable, isFalse);
      await controller.toggle(controller.localModels.first);
      expect(app.actions, isEmpty);
    },
  );

  for (final failure in ['install', 'probe', 'create']) {
    test(
      'advanced manager recovers from $failure failure while discovery stays usable',
      () async {
        if (failure == 'install') {
          app.installed = false;
          app.installError = 'Install interrupted';
        }
        if (failure == 'probe') app.probeError = 'Unavailable';
        if (failure == 'create') {
          connection.creationError = 'Create interrupted';
        }
        await controller.open();
        expect(controller.error, isNotNull);
        expect(controller.opening, isFalse);
        expect(controller.preparing, isFalse);
        await controller.refresh();
        expect(controller.localModels, isNotEmpty);
        expect(controller.inventoryAvailable, isTrue);
        app.installError = app.probeError = connection.creationError = null;
        await controller.open();
        expect(controller.error, isNull);
        expect(app.activeSwarm.name, modelManagerName);
      },
    );
  }

  for (final failure in ['none', 'error', 'throw']) {
    test(
      'resuming an existing manager handles $failure without creating another',
      () async {
        app.stateOf('m')!.agents = [
          const Agent(
            id: 'manager',
            name: modelManagerName,
            engine: 'codex',
            dsh: AppNotifier.gridHarness,
            status: 'stopped',
          ),
        ];
        app.resumeError = failure == 'error' ? 'Could not resume' : null;
        app.resumeThrows = failure == 'throw';
        await controller.open();
        expect(app.resumes, 1);
        expect(connection.creations, isEmpty);
        expect(controller.error, failure == 'none' ? isNull : isNotNull);
        expect(controller.opening, isFalse);
      },
    );
  }

  test(
    'a read issued before Start cannot overwrite its acknowledgement',
    () async {
      await controller.refresh();
      final stale = Map<String, dynamic>.of(app.localInventory);
      final read = Completer<Map<String, dynamic>>();
      app.localReply = read;
      final refreshing = controller.refresh();
      final toggling = controller.toggle(controller.localModels.first);
      await Future<void>.delayed(Duration.zero);
      read.complete(stale);
      await refreshing;
      await toggling;
      expect(app.actions, hasLength(1));
      expect(controller.localModels.first.operation?.active, isTrue);
      expect(controller.busy, isTrue);
    },
  );

  test('a completed operation on a removed catalog row cannot leave controls busy forever', () async {
    await controller.refresh();
    app.actionReply = Completer<Map<String, dynamic>>();
    final action = controller.toggle(controller.localModels.first);
    app.localInventory = {'models': [], 'busy': false};
    app.actionReply!.complete({
      'operation': {
        'id': 'gone',
        'modelId': 'qwen',
        'action': 'start',
        'stage': 'checking',
        'phase': 'running',
      },
    });
    await action;
    expect(controller.busy, isFalse);
    expect(controller.pendingOperation, isNull);
    expect(controller.localModels, isEmpty);
  });

  test('an old daemon or malformed inventory disables actions without clearing the last view', () async {
    await controller.refresh();
    app.localInventory = {'error': 'Update Harness to manage local models.'};
    await controller.refresh();
    expect(controller.localModels, hasLength(5));
    expect(controller.inventoryAvailable, isFalse);
    expect(controller.error, contains('Update Harness'));
    app.localInventory = {
      'models': [
        {'id': 7},
      ],
    };
    await controller.refresh();
    expect(controller.error, contains('unavailable'));
  });

  test(
    'late discovery and manager setup cannot publish to another account',
    () async {
      controller.start();
      await controller.prepare();
      await controller.refresh();
      final reply = Completer<Map<String, dynamic>>();
      app.localReply = reply;
      final pending = controller.refresh();
      app.machineStates.clear();
      app.notifyListeners();
      reply.complete(modelInventory(scenario: 'ready'));
      await pending;
      expect(controller.readyModel, isNull);
      expect(controller.localModels, isEmpty);
    },
  );

  test('a model with no supported control is never submitted', () async {
    await controller.refresh();
    await controller.toggle(
      const LocalModel(id: 'read-only', name: 'External'),
    );
    expect(app.actions, isEmpty);
  });

  testWidgets('polls visible or active work and stays quiet when closed', (
    tester,
  ) async {
    final polling = ModelManagerController(app);
    polling.start();
    await tester.pump();
    final initial = app.localReads;
    await tester.pump(const Duration(seconds: 8));
    expect(app.localReads, initial);
    polling.setPanelVisible(true);
    await tester.pump(const Duration(seconds: 4));
    expect(app.localReads, greaterThan(initial));
    polling.setPanelVisible(false);
    await polling.toggle(polling.localModels.first);
    final busyReads = app.localReads;
    await tester.pump(const Duration(seconds: 4));
    expect(app.localReads, greaterThan(busyReads));
    polling.dispose();
    final disposedReads = app.localReads;
    polling.start();
    await tester.pump(const Duration(seconds: 8));
    expect(app.localReads, disposedReads);
  });

  test('model data keeps unknown telemetry absent and parses only valid operations', () {
    final base = {
      'id': 'job',
      'modelId': 'model',
      'action': 'start',
      'phase': 'running',
      'stage': 'checking',
    };
    for (final stage in [
      'checking',
      'downloading',
      'starting',
      'verifying',
      'stopping',
    ]) {
      expect(
        LocalModelOperation.parse({...base, 'stage': stage})?.label,
        {
          'checking': 'Checking',
          'downloading': 'Downloading',
          'starting': 'Starting',
          'verifying': 'Testing',
          'stopping': 'Stopping',
        }[stage],
      );
    }
    for (final raw in [
      null,
      {},
      {...base, 'action': 'delete'},
      {...base, 'phase': 'unknown'},
      {...base, 'stage': 'unknown'},
    ]) {
      expect(LocalModelOperation.parse(raw), isNull);
    }
    final model = LocalModel.fromJson({
      'id': 'model',
      'sizeBytes': double.nan,
      'requests': -1,
      'tokensPerSecond': double.infinity,
      'operation': {...base, 'progress': 2},
    });
    expect(model.sizeBytes, isNull);
    expect(model.requests, isNull);
    expect(model.tokensPerSecond, isNull);
    expect(model.operation?.progress, 1);
  });
}
