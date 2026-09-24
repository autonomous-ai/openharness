import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/cli_link.dart';
import 'package:harness/core/dsh_catalog.dart';
import 'package:harness/core/machine_resources.dart';
import 'package:harness/core/models.dart';
import 'package:harness/models/api_connections_panel.dart';
import 'package:harness/models/model_search_catalog.dart';
import 'package:harness/state/harness_sessions.dart';
import 'package:harness/state/swarm_navigation.dart';
import 'package:harness/state/swarm_search.dart';
import 'package:harness/usage/models_menu_controller.dart';
import 'package:harness/widgets/swarm_resource_preview.dart';

import 'support/model_manager.dart';
import 'support/real_fonts.dart';

class _Subscriptions extends ModelsMenuController {
  int refreshes = 0;
  @override
  List<Map<String, Object?>> get rows => [
    {
      'engine': 'codex',
      'title': 'Codex subscription',
      'account': 'Fixture account',
      'status': 'Usage available',
      'details': ['Usage available', '10% used'],
    },
  ];
  @override
  Future<void> refresh() async => refreshes++;
}

class _App extends ModelManagerTestApp {
  _App() : super(ModelManagerConnection());
  final apiCalls = <String>[];
  bool removeFails = false;
  bool removed = false;
  int machineRefreshes = 0;
  final deleted = <String>[];
  @override
  Future<Map<String, dynamic>> apiConnections(
    String machineId,
    Map<String, dynamic> payload,
  ) async {
    final action = payload['action'] as String;
    apiCalls.add(action);
    if (action == 'remove') {
      if (removeFails) {
        return {'error': 'fixture', 'detail': 'Try removal again'};
      }
      removed = true;
    }
    return {
      'connections': [
        if (!removed)
          {
            'id': 'deepseek',
            'provider': 'custom',
            'name': 'DeepSeek API',
            'baseUrl': 'https://fixture.invalid/v1',
            'keyEnv': 'FIXTURE_KEY',
          },
      ],
      'presets': <Object>[],
    };
  }

  @override
  Future<MachineResources?> readMachineResources(String machineId) async =>
      const MachineResources(
        cpuPercent: 25,
        memoryUsedBytes: 4 * 1024 * 1024 * 1024,
        memoryTotalBytes: 16 * 1024 * 1024 * 1024,
      );
  @override
  Future<void> retryMachines() async => machineRefreshes++;
  @override
  Future<RemotePasswordStatus> remotePasswordStatus() async =>
      const RemotePasswordStatus(hasPassword: false);
  @override
  Future<String?> deleteMachine(String machineId) async {
    deleted.add(machineId);
    return null;
  }
}

void main() {
  setUpAll(loadRealFonts);
  late _App app;
  late _Subscriptions subscriptions;
  late ModelSearchCatalog catalog;
  late SwarmSearchController search;
  late SearchPreviewControls controls;
  final choices = <SwarmSearchSelection>[];
  int managerOpens = 0;
  int refocuses = 0;
  final modals = <bool>[];

  Future<void> mount(
    WidgetTester tester,
    String query, {
    bool create = false,
    String scenario = 'first',
  }) async {
    app = _App();
    for (final machine in app.machineStates.values) {
      machine.nodeOnline = true;
      machine.connectionStatus = ConnectionStatus.connected;
    }
    app.localInventory = modelInventory(scenario: scenario);
    app.inventory = const GridModels(
      gridName: 'home',
      models: [],
      grids: [
        GridSection(
          name: 'Team',
          own: false,
          models: [GridModel(id: 'Shared Qwen', node: 'Team computer')],
        ),
      ],
    );
    app.machineStates['m']!.dsh.replace(const [
      DshEntry(
        id: 'blender',
        name: 'Blender',
        engine: 'codex',
        category: '3D',
        author: 'Fixture author',
        description: 'Build a scene.',
      ),
    ]);
    await app.modelManager.refresh();
    await app.modelManager.apis.refresh();
    subscriptions = _Subscriptions();
    catalog = ModelSearchCatalog(app.modelManager, subscriptions);
    search = SwarmSearchController(
      app,
      const [],
      models: catalog,
      offersCreate: create,
      adding: create,
      activityFirst: true,
    )..setQuery(query);
    controls = SearchPreviewControls();
    choices.clear();
    modals.clear();
    managerOpens = refocuses = 0;
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: SwarmResourcePreview(
            search: search,
            controls: controls,
            onChoose: choices.add,
            onRefocus: () => refocuses++,
            onManageModels: () async => managerOpens++,
            onModalChanged: modals.add,
            onCommands: () {},
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    addTearDown(() async {
      await tester.pumpWidget(const SizedBox());
      controls.dispose();
      search.dispose();
      catalog.dispose();
      subscriptions.dispose();
      app.dispose();
    });
  }

  Future<void> invoke(WidgetTester tester, String command) async {
    expect(controls.invoke(command), isTrue);
    await tester.pumpAndSettle();
  }

  Future<void> closeDialog(WidgetTester tester) async {
    Navigator.of(
      tester.element(find.byType(SwarmResourcePreview, skipOffstage: false)),
    ).pop();
    await tester.pumpAndSettle();
    expect(modals.last, isFalse);
    expect(refocuses, greaterThan(0));
  }

  testWidgets('shared and subscription metadata opens the terminal manager', (
    tester,
  ) async {
    await mount(tester, ':Shared Qwen');
    expect(find.text('Shared · Team · Team computer'), findsOneWidget);
    expect(find.text('Available'), findsOneWidget);
    await invoke(tester, 'picker.accept');
    expect(managerOpens, 1);
    search.setQuery(':Codex subscription');
    await tester.pumpAndSettle();
    expect(find.text('Account Fixture account'), findsOneWidget);
    expect(find.text('10% used'), findsOneWidget);
    expect(find.text('Usage available'), findsOneWidget);
    await invoke(tester, 'picker.accept');
    expect(managerOpens, 2);
    expect(app.actions, isEmpty);
  });

  testWidgets('running model details and refresh report real inventory', (
    tester,
  ) async {
    await mount(tester, ':Qwen3.8-27B', scenario: 'ready');
    expect(find.text('17.6 tokens/sec'), findsOneWidget);
    expect(find.text('42 requests / 86400 sec'), findsOneWidget);
    await invoke(tester, 'picker.accept');
    expect(managerOpens, 1);
    final reads = app.localReads;
    await invoke(tester, 'picker.refresh');
    expect(app.localReads, greaterThan(reads));
    expect(subscriptions.refreshes, 1);
    expect(app.apiCalls.last, 'list');
    await invoke(tester, 'picker.resource_toggle');
    expect(app.actions.single.start, isFalse);
    await invoke(tester, 'picker.resource_toggle');
    expect(app.actions, hasLength(1));
  });

  testWidgets('empty and refreshing models never invent a result', (
    tester,
  ) async {
    await mount(tester, ':missing');
    expect(find.text('No matching models'), findsOneWidget);
    app.modelManager.scanning = true;
    search.setQuery(':still missing');
    await tester.pump();
    expect(find.text('Finding models…'), findsOneWidget);
    app.modelManager.scanning = false;
    app.localReadFails = true;
    await invoke(tester, 'picker.refresh');
    expect(app.modelManager.error, isNotNull);
    expect(find.text(app.modelManager.error!), findsWidgets);
    expect(choices, isEmpty);
  });

  testWidgets(
    'API removal cancels, reports failure, retries and restores focus',
    (tester) async {
      await mount(tester, ':DeepSeek');
      await invoke(tester, 'picker.resource_remove');
      expect(find.text('Remove DeepSeek API?'), findsOneWidget);
      await tester.tap(find.text('Cancel'));
      await tester.pumpAndSettle();
      expect(app.apiCalls, ['list']);
      expect(search.selected!.modelId, 'model:api:deepseek');
      app.removeFails = true;
      await invoke(tester, 'picker.resource_remove');
      await tester.tap(find.text('Remove'));
      await tester.pumpAndSettle();
      expect(find.text('Try removal again'), findsOneWidget);
      app.removeFails = false;
      await invoke(tester, 'picker.resource_remove');
      await tester.tap(find.text('Remove'));
      await tester.pumpAndSettle();
      expect(app.apiCalls.where((action) => action == 'remove'), hasLength(2));
      expect(search.rows, isEmpty);
      expect(find.text('No matching models'), findsOneWidget);
      expect(modals, [true, false, true, false, true, false]);
    },
  );

  testWidgets(
    'API edit and add actions return without changing the selection',
    (tester) async {
      await mount(tester, ':DeepSeek');
      await invoke(tester, 'picker.resource_settings');
      expect(find.byType(ApiConnectionsPanel), findsOneWidget);
      await tester.tap(find.byTooltip('Back to APIs'));
      await tester.pumpAndSettle();
      await closeDialog(tester);
      await invoke(tester, 'picker.resource_add_api');
      expect(find.byType(ApiConnectionsPanel), findsOneWidget);
      await closeDialog(tester);
      expect(search.selected!.modelId, 'model:api:deepseek');
      expect(app.apiCalls, ['list']);
    },
  );

  testWidgets('new model exposes API setup without launching a model', (
    tester,
  ) async {
    await mount(tester, ':missing', create: true);
    expect(search.selected!.isCreate, isTrue);
    await invoke(tester, 'picker.resource_add_api');
    expect(find.byType(ApiConnectionsPanel), findsOneWidget);
    await closeDialog(tester);
    expect(app.actions, isEmpty);
    expect(choices, isEmpty);
  });

  testWidgets('Store Enter chooses its product and an empty Store stays idle', (
    tester,
  ) async {
    await mount(tester, '*blender');
    expect(find.text('Build a scene.'), findsOneWidget);
    expect(find.text('By Fixture author'), findsOneWidget);
    await invoke(tester, 'picker.accept');
    expect(choices.single.destination.storeId, 'blender');
    search.setQuery('*missing');
    await tester.pump();
    expect(find.text('No matching store entries'), findsOneWidget);
    await invoke(tester, 'picker.accept');
    expect(choices, hasLength(1));
  });

  testWidgets(
    'machine refresh shows measurements and shared access stays view only',
    (tester) async {
      await mount(tester, '@This Mac');
      await invoke(tester, 'picker.refresh');
      expect(app.machineRefreshes, 1);
      expect(find.textContaining('CPU 25%'), findsOneWidget);
      expect(find.textContaining('RAM 4.0 / 16 GB'), findsOneWidget);
      await invoke(tester, 'picker.resource_settings');
      expect(find.textContaining('password'), findsWidgets);
      await closeDialog(tester);
      await invoke(tester, 'picker.resource_link');
      expect(find.text('Link another machine'), findsWidgets);
      await closeDialog(tester);
      final machine = app.machineStates['m']!;
      machine.machine = const Machine(
        machineId: 'm',
        name: 'This Mac',
        authMode: MachineAuthMode.remote,
        isShared: true,
      );
      app.notifyListeners();
      await tester.pump();
      expect(find.textContaining('View only'), findsOneWidget);
      expect(controls.invoke('picker.resource_settings'), isFalse);
    },
  );

  testWidgets(
    'remote machine removal confirms and unavailable snapshots cannot act',
    (tester) async {
      await mount(tester, '@Other computer');
      await invoke(tester, 'picker.resource_remove');
      expect(app.deleted, isEmpty);
      await closeDialog(tester);
      expect(app.deleted, isEmpty);
      final original = app.machineStates.remove('other');
      expect(controls.invoke('picker.accept'), isFalse);
      app.machineStates['other'] = original!;
    },
  );

  testWidgets('machine rename and connection forms cancel without mutations', (
    tester,
  ) async {
    await mount(tester, '@Other computer');
    await invoke(tester, 'picker.resource_rename');
    expect(find.text('Rename Machine'), findsOneWidget);
    await closeDialog(tester);
    app.machineStates['other']!.needsLink = true;
    app.notifyListeners();
    await tester.pump();
    await invoke(tester, 'picker.resource_connect');
    expect(find.textContaining('Other computer'), findsWidgets);
    await closeDialog(tester);
    expect(app.deleted, isEmpty);
    expect(choices, isEmpty);
    expect(search.selected!.machineId, 'other');
  });

  testWidgets(
    'Add here chooses the selected harness without opening another workspace',
    (tester) async {
      await mount(tester, '');
      app.machineStates['other']!.agents = [
        const Agent(
          id: 'task',
          name: 'Fixture task',
          engine: 'codex',
          terminalAvailable: true,
        ),
      ];
      app.rememberOpenedHarness('other', 'task');
      app.notifyListeners();
      search.setQuery('Fixture task');
      await tester.pump();
      await invoke(tester, 'picker.add_here');
      expect(choices.single.action, SwarmSearchAction.addHere);
      expect(choices.single.destination.agentId, 'task');
      expect(app.panes, isEmpty);
    },
  );

  testWidgets('session filter and sort commands cycle through every mode', (
    tester,
  ) async {
    await mount(tester, '');
    for (var i = 0; i < SessionFilter.values.length; i++) {
      await invoke(tester, 'picker.resource_filter');
      expect(
        search.sessionFilter,
        SessionFilter.values[(i + 1) % SessionFilter.values.length],
      );
    }
    for (var i = 0; i < SessionSort.values.length; i++) {
      await invoke(tester, 'picker.resource_sort');
      expect(
        search.sessionSort,
        SessionSort.values[(i + 1) % SessionSort.values.length],
      );
    }
  });
}
