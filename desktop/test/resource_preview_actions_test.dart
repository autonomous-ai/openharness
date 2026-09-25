import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/cli_link.dart';
import 'package:harness/core/dsh_catalog.dart';
import 'package:harness/core/machine_resources.dart';
import 'package:harness/core/models.dart';
import 'package:harness/widgets/api_picker_form.dart';
import 'package:harness/models/model_search_catalog.dart';
import 'package:harness/state/harness_sessions.dart';
import 'package:harness/state/swarm_navigation.dart';
import 'package:harness/state/swarm_search.dart';
import 'package:harness/usage/models_menu_controller.dart';
import 'package:harness/widgets/swarm_resource_preview.dart';
import 'package:harness/widgets/terminal_text_action.dart';

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
          name: 'home',
          own: true,
          models: [GridModel(id: 'qwen3.8-27b', node: 'mac.lan')],
        ),
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
    catalog = ModelSearchCatalog(
      app.modelManager,
      subscriptions,
      pollHosts: false,
    );
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
    refocuses = 0;
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: SwarmResourcePreview(
            search: search,
            controls: controls,
            onChoose: choices.add,
            onRefocus: () => refocuses++,
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

  Future<void> closeApiEditor(WidgetTester tester) async {
    await invoke(tester, 'picker.cancel');
    expect(find.byType(ApiPickerForm), findsNothing);
    expect(modals, isEmpty);
    expect(refocuses, greaterThan(0));
  }

  testWidgets('shared and subscription management stays in the picker', (
    tester,
  ) async {
    await mount(tester, ':Shared Qwen');
    expect(find.text('Shared · Team · Team computer'), findsOneWidget);
    expect(find.text('Available'), findsNothing);
    await invoke(tester, 'picker.accept');
    expect(choices, isEmpty);
    search.setQuery(':Codex subscription');
    search.setModelSelection('claude', app.inventory, machineId: 'm');
    await tester.pumpAndSettle();
    expect(find.text('Codex subscription · Fixture account'), findsOneWidget);
    expect(find.text('10% used'), findsOneWidget);
    expect(find.text('Usage available'), findsOneWidget);
    final before = refocuses;
    await invoke(tester, 'picker.accept');
    expect(choices, isEmpty);
    expect(refocuses, before);
    expect(search.managing, isFalse);
    await invoke(tester, 'picker.complete');
    expect(search.managing, isTrue);
    expect(
      tester
          .widget<TerminalTextAction>(
            find.byKey(const ValueKey('resource-action:picker.refresh')),
          )
          .focusNode!
          .hasFocus,
      isTrue,
    );
    await invoke(tester, 'picker.accept');
    expect(subscriptions.refreshes, 1);
    expect(app.actions, isEmpty);
  });

  testWidgets('own-machine models remain visible when local discovery fails', (
    tester,
  ) async {
    await mount(tester, ':mac.lan');
    expect(find.text('qwen3.8-27b'), findsOneWidget);
    expect(find.text('On your machines · mac.lan'), findsOneWidget);
    expect(
      find.byKey(const ValueKey('resource-action:picker.accept')),
      findsOneWidget,
    );
    expect(
      find.byKey(const ValueKey('resource-action:picker.model_stop')),
      findsNothing,
    );
    final selected = search.selected!.id;
    app.localReadFails = true;
    await invoke(tester, 'picker.refresh');
    expect(search.selected!.id, selected);
    expect(
      find.textContaining('Local models · Models are unavailable'),
      findsOneWidget,
    );
    search.setQuery(':Shared Qwen');
    await tester.pumpAndSettle();
    expect(
      find.textContaining('Local models · Models are unavailable'),
      findsOneWidget,
    );
    app.localReadFails = false;
    await invoke(tester, 'picker.refresh');
    expect(
      find.byKey(const ValueKey('local-model-inventory-notice')),
      findsNothing,
    );
    expect(app.actions, isEmpty);
  });

  testWidgets('running model details and refresh report real inventory', (
    tester,
  ) async {
    await mount(tester, ':Qwen3.8-27B', scenario: 'ready');
    expect(find.text('17.6 tok/s · 42 requests / 1d'), findsOneWidget);
    await invoke(tester, 'picker.accept');
    expect(choices, isEmpty);
    final reads = app.localReads;
    await invoke(tester, 'picker.refresh');
    expect(app.localReads, greaterThan(reads));
    expect(subscriptions.refreshes, 1);
    expect(app.apiCalls.last, 'list');
    await tester.tap(
      find.byKey(const ValueKey('resource-action:picker.model_stop')),
    );
    await tester.pumpAndSettle();
    expect(app.actions.single.start, isFalse);
    await invoke(tester, 'picker.resource_toggle');
    expect(app.actions, hasLength(1));
  });

  testWidgets('Grid hostname resolves to remote Harness controls in place', (
    tester,
  ) async {
    await mount(tester, ':mac.lan');
    final id = search.selected!.id;
    app.machineStates['other']!.machine = const Machine(
      machineId: 'other',
      authMode: MachineAuthMode.remote,
      name: 'M2',
      hostname: 'mac.lan',
    );
    const modelId = 'local:Qwen3.8-27B-Q4_0.gguf';
    final running = <String, dynamic>{
      'id': modelId,
      'name': 'qwen3.8-27b',
      'state': 'running',
      'canStart': false,
      'canStop': true,
      'sizeBytes': 16 * 1024 * 1024 * 1024,
      'tokensPerSecond': 17.6,
      'requests': 42,
      'windowSeconds': 86400,
    };
    app.machineInventories['other'] = {
      'models': [running],
      'busy': false,
    };
    catalog.setVisible(true);
    await tester.pumpAndSettle();
    expect(search.selected!.id, id);
    expect(
      search.rows.where((row) => row.title == 'qwen3.8-27b · Q4_0'),
      hasLength(1),
    );
    expect(find.text('M2 · 16.0 GB'), findsOneWidget);
    expect(find.text('17.6 tok/s · 42 requests / 1d'), findsOneWidget);
    TerminalTextAction button(String action) => tester.widget(
      find.byKey(ValueKey('resource-action:picker.model_$action')),
    );
    expect(
      find.byKey(const ValueKey('resource-action:picker.model_download')),
      findsNothing,
    );
    expect(
      find.byKey(const ValueKey('resource-action:picker.model_start')),
      findsNothing,
    );
    expect(button('stop').onPressed, isNotNull);
    final originalLocal = app.localInventory;
    await invoke(tester, 'picker.model_stop');
    expect(app.actions, [(machine: 'other', model: modelId, start: false)]);
    expect(app.localInventory, same(originalLocal));
    expect(find.text('Stopping'), findsOneWidget);
    expect(app.connection.creations, isEmpty);

    // Stop removes the serving row, but its management row and selection stay.
    app.machineInventories['other'] = {
      'models': [
        {...running, 'state': 'downloaded', 'canStart': true, 'canStop': false},
      ],
      'busy': false,
    };
    app.inventory = const GridModels(gridName: 'home', models: []);
    await catalog.refresh(force: true);
    await tester.pumpAndSettle();
    expect(search.selected!.id, id);
    search.setModelSelection('codex', app.inventory, machineId: 'm');
    await tester.pump();
    expect(button('start').onPressed, isNotNull);
    expect(
      find.byKey(const ValueKey('resource-action:picker.model_stop')),
      findsNothing,
    );
    app.machineStates['other']!.connectionStatus =
        ConnectionStatus.disconnected;
    app.notifyListeners();
    await tester.pumpAndSettle();
    expect(button('start').onPressed, isNull);
    expect(find.text('Connect to M2 to manage its models.'), findsOneWidget);
    await invoke(tester, 'picker.model_start');
    expect(app.actions, hasLength(1));
  });

  testWidgets(
    'older hosts prepare models with Get and explain their combined download and start',
    (tester) async {
      await mount(tester, ':Falcon');
      app.machineStates['other']!.machine = const Machine(
        machineId: 'other',
        authMode: MachineAuthMode.remote,
        name: 'M2',
        hostname: 'mac.lan',
      );
      app.machineInventories['other'] = {
        'models': [
          {
            'id': 'falcon-q4',
            'name': 'Falcon-H1R-7B',
            'quant': 'Q4_K_XL',
            'state': 'available',
            'canStart': true,
          },
        ],
      };
      catalog.setVisible(true);
      await tester.pumpAndSettle();
      TerminalTextAction button(String action) => tester.widget(
        find.byKey(ValueKey('resource-action:picker.model_$action')),
      );
      expect(find.text('Downloads and starts on M2.'), findsOneWidget);
      expect(find.textContaining('Update Harness'), findsNothing);
      expect(button('download').label, 'Get');
      expect(button('download').onPressed, isNotNull);
      expect(
        find.byKey(const ValueKey('resource-action:picker.model_start')),
        findsNothing,
      );
      expect(
        find.byKey(const ValueKey('resource-action:picker.model_stop')),
        findsNothing,
      );
      await invoke(tester, 'picker.model_download');
      expect(app.actions, [
        (machine: 'other', model: 'falcon-q4', start: true),
      ]);
      expect(app.downloads, isEmpty);
      expect(find.text('Downloading 42%'), findsOneWidget);
      expect(find.text('Downloads and starts on M2.'), findsNothing);
    },
  );

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
    expect(find.textContaining(app.modelManager.error!), findsOneWidget);
    expect(choices, isEmpty);
  });

  testWidgets(
    'API removal cancels, reports failure, retries and restores focus',
    (tester) async {
      await mount(tester, ':DeepSeek');
      await invoke(tester, 'picker.resource_remove');
      expect(find.text('Delete DeepSeek API?'), findsOneWidget);
      expect(find.byType(Dialog), findsNothing);
      await tester.tap(find.byKey(const ValueKey('api-form:cancel')));
      await tester.pumpAndSettle();
      expect(app.apiCalls, ['list']);
      expect(search.selected!.modelId, 'model:api:deepseek');
      app.removeFails = true;
      await invoke(tester, 'picker.resource_remove');
      await tester.tap(find.byKey(const ValueKey('api-form:delete')));
      await tester.pumpAndSettle();
      expect(find.text('Try removal again'), findsOneWidget);
      app.removeFails = false;
      await invoke(tester, 'picker.resource_remove');
      await tester.tap(find.byKey(const ValueKey('api-form:delete')));
      await tester.pumpAndSettle();
      expect(app.apiCalls.where((action) => action == 'remove'), hasLength(2));
      expect(search.rows, isEmpty);
      expect(find.text('No matching models'), findsOneWidget);
      expect(modals, isEmpty);
    },
  );

  testWidgets(
    'API edit and add actions return without changing the selection',
    (tester) async {
      await mount(tester, ':DeepSeek');
      await invoke(tester, 'picker.resource_settings');
      expect(find.byType(ApiPickerForm), findsOneWidget);
      expect(find.byType(Dialog), findsNothing);
      await closeApiEditor(tester);
      await invoke(tester, 'picker.resource_add_api');
      expect(find.byType(ApiPickerForm), findsOneWidget);
      await closeApiEditor(tester);
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
    expect(find.byType(ApiPickerForm), findsOneWidget);
    await closeApiEditor(tester);
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
      await invoke(tester, 'picker.cancel');
      await invoke(tester, 'picker.resource_link');
      expect(search.query, '@');
      search.setQuery('@This Mac');
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
      await invoke(tester, 'picker.cancel');
      expect(app.deleted, isEmpty);
      final original = app.machineStates.remove('other');
      expect(controls.invoke('picker.resource_rename'), isFalse);
      app.machineStates['other'] = original!;
    },
  );

  testWidgets('machine rename and connection forms cancel without mutations', (
    tester,
  ) async {
    await mount(tester, '@Other computer');
    await invoke(tester, 'picker.resource_rename');
    expect(find.text('Rename machine'), findsOneWidget);
    expect(find.byType(Dialog), findsNothing);
    await invoke(tester, 'picker.cancel');
    app.machineStates['other']!.needsLink = true;
    app.notifyListeners();
    await tester.pump();
    await invoke(tester, 'picker.resource_connect');
    expect(find.textContaining('Other computer'), findsWidgets);
    expect(find.byType(Dialog), findsNothing);
    await invoke(tester, 'picker.cancel');
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
