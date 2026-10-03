import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/cli_link.dart';
import 'package:harness/core/machine_resources.dart';
import 'package:harness/core/models.dart';
import 'package:harness/models/api_connections_controller.dart';
import 'package:harness/models/local_model.dart';
import 'package:harness/models/model_search_catalog.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/state/swarm_navigation.dart';
import 'package:harness/state/swarm_search.dart';
import 'package:harness/usage/models_menu_controller.dart';
import 'package:harness/widgets/desktop_chrome.dart';
import 'package:harness/widgets/api_picker_form.dart';
import 'package:harness/widgets/machine_picker_form.dart';
import 'package:harness/widgets/swarm_resource_preview.dart';

import 'support/model_manager.dart';

class _Usage extends ModelsMenuController {
  @override
  List<Map<String, Object?>> get rows => const [];
}

class _EdgeApp extends ModelManagerTestApp {
  _EdgeApp() : super(ModelManagerConnection());

  @override
  String? machineListError;

  int machineRetries = 0;
  int resourceReads = 0;
  Completer<void>? retryReply;
  Completer<MachineResources?>? resourceReply;
  final apiWrites = <Map<String, dynamic>>[];
  final failingModelHosts = <String>{};
  List<Map<String, dynamic>> savedApis = [];

  @override
  Future<Map<String, dynamic>> localModels(
    String machineId, {
    bool refresh = false,
    bool setup = false,
  }) {
    if (failingModelHosts.contains(machineId)) {
      throw StateError('Fixture model host unavailable');
    }
    return super.localModels(machineId, refresh: refresh, setup: setup);
  }

  @override
  Future<void> retryMachines() async {
    machineRetries++;
    await retryReply?.future;
    machineListError = null;
    notifyListeners();
  }

  @override
  Future<MachineResources?> readMachineResources(String machineId) async {
    resourceReads++;
    return resourceReply?.future ??
        Future.value(const MachineResources(cpuPercent: 33));
  }

  @override
  Future<RemotePasswordStatus> remotePasswordStatus() async =>
      const RemotePasswordStatus(hasPassword: false);

  @override
  Future<Map<String, dynamic>> apiConnections(
    String machineId,
    Map<String, dynamic> payload, {
    Duration timeout = const Duration(seconds: 10),
  }) async {
    apiWrites.add(Map.of(payload));
    if (payload['action'] == 'save') {
      final saved = Map<String, dynamic>.from(payload['connection'] as Map)
        ..remove('apiKey')
        ..['id'] = 'saved-api';
      savedApis = [...savedApis, saved];
    }
    return {'connections': savedApis, 'presets': <Object>[]};
  }
}

class _PreviewFixture {
  _PreviewFixture({
    required this.app,
    required String query,
    bool offersCreate = false,
    bool preview = true,
    bool selectOnEmpty = true,
  }) {
    catalog = ModelSearchCatalog(app.modelManager, usage, pollHosts: false);
    search = SwarmSearchController(
      app,
      const [],
      models: catalog,
      adding: true,
      activityFirst: true,
      offersCreate: offersCreate,
      previewInitiallyVisible: preview,
      selectOnEmptyQuery: selectOnEmpty,
    )..setQuery(query);
  }

  final _EdgeApp app;
  final usage = _Usage();
  late final ModelSearchCatalog catalog;
  late final SwarmSearchController search;
  final controls = SearchPreviewControls();
  final queryFocus = FocusNode();
  final choices = <SwarmSearchSelection>[];
  var refocuses = 0;
  var disposed = false;

  void refocus() {
    refocuses++;
    queryFocus.requestFocus();
    search.setManaging(false);
  }

  Widget widget({
    bool desktop = true,
    double width = 600,
    SwarmSearchController? replacement,
    Duration? resourcePollInterval,
  }) {
    final preview = SwarmResourcePreview(
      search: replacement ?? search,
      controls: controls,
      onChoose: choices.add,
      onRefocus: refocus,
      onModalChanged: (_) {},
      onCommands: () {},
      resourcePollInterval: resourcePollInterval,
    );
    return MaterialApp(
      theme: grid.buildAppTheme(brightness: Brightness.dark),
      home: Scaffold(
        body: Center(
          child: SizedBox(
            width: width,
            child: Column(
              children: [
                TextField(
                  key: const ValueKey('edge-query'),
                  focusNode: queryFocus,
                  autofocus: true,
                ),
                Expanded(
                  child: desktop ? DesktopChrome(child: preview) : preview,
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  void dispose() {
    if (disposed) return;
    disposed = true;
    controls.dispose();
    queryFocus.dispose();
    search.dispose();
    catalog.dispose();
    usage.dispose();
    app.dispose();
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test(
    'model status words follow operation progress and all pending states',
    () {
      final app = _EdgeApp();
      final usage = _Usage();
      final catalog = ModelSearchCatalog(
        app.modelManager,
        usage,
        pollHosts: false,
      );
      addTearDown(app.dispose);
      addTearDown(usage.dispose);
      addTearDown(catalog.dispose);
      final owner = app.modelManager;
      const available = LocalModel(id: 'weights', name: 'Model');
      const downloaded = LocalModel(
        id: 'weights',
        name: 'Model',
        state: 'downloaded',
      );
      const running = LocalModel(
        id: 'weights',
        name: 'Model',
        state: 'running',
      );

      for (final (model, label) in [
        (available, 'Not downloaded'),
        (downloaded, 'Downloaded'),
        (running, 'Running'),
      ]) {
        expect(catalog.localStatus(model), label);
        expect(catalog.localStatusWord(model), label);
      }
      owner.pendingId = 'weights';
      for (final (download, start, label) in [
        (true, true, 'Downloading'),
        (false, true, 'Starting'),
        (false, false, 'Stopping'),
      ]) {
        owner.pendingDownload = download;
        owner.pendingStart = start;
        expect(catalog.localStatus(available), label);
        expect(catalog.localStatusWord(available), label);
      }
      owner.pendingId = null;
      owner.pendingOperation = const LocalModelOperation(
        id: 'download',
        modelId: 'weights',
        action: 'download',
        stage: 'downloading',
        phase: 'running',
        progress: .42,
      );
      expect(catalog.localStatus(available), 'Downloading 42%');
      expect(catalog.localStatusWord(available), 'Downloading');
      owner.pendingOperation = const LocalModelOperation(
        id: 'download',
        modelId: 'weights',
        action: 'download',
        stage: 'downloading',
        phase: 'failed',
        error: 'Disk full',
      );
      expect(catalog.localStatus(available), 'Failed · try again');
      expect(catalog.localStatusWord(available), 'Failed');
    },
  );

  test('duplicate machine names keep stable model rows and removal revokes control', () async {
    final app = _EdgeApp();
    final usage = _Usage();
    final catalog = ModelSearchCatalog(
      app.modelManager,
      usage,
      pollHosts: false,
    );
    addTearDown(app.dispose);
    addTearDown(usage.dispose);
    addTearDown(catalog.dispose);
    app.machineStates['other']!
      ..machine = const Machine(
        machineId: 'other',
        name: 'This Mac',
        authMode: MachineAuthMode.remote,
      )
      ..connectionStatus = ConnectionStatus.connected
      ..nodeOnline = true;
    const weights = {
      'id': 'qwen.gguf',
      'name': 'Qwen weights',
      'state': 'downloaded',
      'canStart': true,
    };
    app.localInventory = {
      'models': [weights],
    };
    app.machineInventories['other'] = {
      'models': [weights],
    };
    catalog.setVisible(true);
    await catalog.refresh();
    final originalIds = catalog.rows.map((row) => row.id).toList();
    expect(originalIds, [
      'model:local:qwen.gguf',
      'model:machine:other:qwen.gguf',
    ]);
    await catalog.refresh(force: true);
    expect(catalog.rows.map((row) => row.id), originalIds);
    app.machineStates.remove('other');
    app.notifyListeners();
    expect(
      catalog.entries.values.where((entry) => entry.local != null),
      hasLength(1),
    );
    expect(catalog.rows.single.id, originalIds.first);
    expect(app.actions, isEmpty);
  });

  test(
    'served model IDs resolve inventory even when the display name differs',
    () async {
      final app = _EdgeApp();
      final usage = _Usage();
      final catalog = ModelSearchCatalog(
        app.modelManager,
        usage,
        pollHosts: false,
      );
      addTearDown(app.dispose);
      addTearDown(usage.dispose);
      addTearDown(catalog.dispose);
      app.localInventory = {
        'models': [
          {
            'id': 'qwen.gguf',
            'name': 'Qwen weights',
            'state': 'running',
            'canStop': true,
          },
        ],
      };
      app.inventory = const GridModels(
        gridName: 'home',
        models: [GridModel(id: 'QWEN.GGUF', node: 'This Mac')],
      );
      await app.modelManager.refresh();
      expect(catalog.entries, hasLength(1));
      expect(catalog.entries.values.single.local!.id, 'qwen.gguf');
      expect(catalog.entries.values.single.gridModel!.id, 'QWEN.GGUF');
    },
  );

  Future<_PreviewFixture> mount(
    WidgetTester tester, {
    String query = '@This Mac',
    _EdgeApp? app,
    bool desktop = true,
    double width = 600,
    bool preview = true,
    bool selectOnEmpty = true,
    Duration? resourcePollInterval,
    bool offersCreate = false,
  }) async {
    final seeded = app ?? _EdgeApp();
    await seeded.modelManager.refresh();
    final fixture = _PreviewFixture(
      app: seeded,
      query: query,
      preview: preview,
      selectOnEmpty: selectOnEmpty,
      offersCreate: offersCreate,
    );
    addTearDown(fixture.dispose);
    await tester.pumpWidget(
      fixture.widget(
        desktop: desktop,
        width: width,
        resourcePollInterval: resourcePollInterval,
      ),
    );
    await tester.pumpAndSettle();
    return fixture;
  }

  Future<void> invoke(
    WidgetTester tester,
    _PreviewFixture fixture,
    String command,
  ) async {
    expect(fixture.controls.invoke(command), isTrue, reason: command);
    await tester.pumpAndSettle();
  }

  for (final desktop in [true, false]) {
    testWidgets(
      'empty preview scope links keep query focus and never launch ($desktop)',
      (tester) async {
        final fixture = await mount(
          tester,
          query: '',
          desktop: desktop,
          selectOnEmpty: false,
        );
        for (final prefix in ['@', '#', ':', '*', '>']) {
          fixture.search.setQuery('');
          await tester.pumpAndSettle();
          await tester.tap(find.byKey(ValueKey('swarm-search-scope:$prefix')));
          await tester.pumpAndSettle();
          expect(fixture.search.query, '$prefix ');
          expect(fixture.queryFocus.hasFocus, isTrue);
          expect(fixture.choices, isEmpty);
        }
      },
    );

    testWidgets(
      'retry preserves selected machine and joins a pending refresh ($desktop)',
      (tester) async {
        final app = _EdgeApp()..machineListError = 'Inventory timed out';
        final pending = Completer<void>();
        app.retryReply = pending;
        final fixture = await mount(tester, app: app, desktop: desktop);
        final selected = fixture.search.selected!.id;
        final retry = find.byKey(
          const ValueKey('resource-action:picker.refresh'),
        );
        expect(retry, findsOneWidget);
        await tester.tap(retry);
        await tester.pump();
        expect(app.machineRetries, 1);
        expect(find.text('Working…'), findsOneWidget);
        fixture.controls.invoke('picker.refresh');
        await tester.pump();
        expect(app.machineRetries, 1);
        expect(fixture.search.selected!.id, selected);
        pending.complete();
        await tester.pumpAndSettle();
        expect(find.text('Working…'), findsNothing);
        expect(find.text('Inventory timed out'), findsNothing);
        expect(fixture.search.selected!.id, selected);
        expect(app.resourceReads, greaterThan(0));
        fixture.search.scrollPreview(1);
        await tester.pump();
        expect(fixture.search.selected!.id, selected);
      },
    );
  }

  testWidgets(
    'keyboard action focus restores a hidden preview and stays on one resource',
    (tester) async {
      final fixture = await mount(tester, preview: false);
      expect(fixture.search.previewVisible, isFalse);
      await invoke(tester, fixture, 'picker.focus_actions');
      expect(fixture.search.previewVisible, isTrue);
      expect(fixture.search.managing, isTrue);
      final selected = fixture.search.selected!.id;
      await invoke(tester, fixture, 'picker.next');
      await invoke(tester, fixture, 'picker.previous');
      expect(fixture.search.selected!.id, selected);
      await invoke(tester, fixture, 'picker.cancel');
      expect(fixture.queryFocus.hasFocus, isTrue);
      expect(fixture.search.managing, isFalse);
    },
  );

  testWidgets(
    'Return cannot act on a resource selected after its controls were focused',
    (tester) async {
      final fixture = await mount(tester);
      await invoke(tester, fixture, 'picker.focus_actions');
      fixture.search.setQuery('@Other computer');
      expect(fixture.controls.invoke('picker.accept'), isTrue);
      await tester.pumpAndSettle();
      expect(find.byType(MachinePickerForm), findsNothing);
      expect(fixture.queryFocus.hasFocus, isTrue);
      expect(fixture.choices, isEmpty);
    },
  );

  testWidgets(
    'rapid Return after selecting Add machine focuses its newly built controls',
    (tester) async {
      final fixture = await mount(tester, offersCreate: true);
      fixture.search.setQuery('@');
      final create = fixture.search.rows.indexWhere((row) => row.isCreate);
      expect(create, isNonNegative);
      fixture.search.move(create - fixture.search.cursor);
      expect(fixture.controls.invoke('picker.accept'), isTrue);
      await tester.pumpAndSettle();
      expect(fixture.search.managing, isTrue);
      await invoke(tester, fixture, 'picker.accept');
      expect(find.byType(MachinePickerForm), findsOneWidget);
      expect(find.text('Add machine · App'), findsOneWidget);
      expect(fixture.app.connection.creations, isEmpty);
    },
  );

  testWidgets(
    'a disabled model action accepts arrows without losing the selection',
    (tester) async {
      final fixture = await mount(tester, query: ':gemma');
      await invoke(tester, fixture, 'picker.resource_toggle');
      await invoke(tester, fixture, 'picker.focus_actions');
      final selected = fixture.search.selected!.id;
      await invoke(tester, fixture, 'picker.previous');
      await invoke(tester, fixture, 'picker.next');
      await invoke(tester, fixture, 'picker.accept');
      expect(fixture.search.selected!.id, selected);
      expect(fixture.choices, isEmpty);
      expect(fixture.app.actions, isEmpty);
      await invoke(tester, fixture, 'picker.cancel');
      expect(fixture.queryFocus.hasFocus, isTrue);
    },
  );

  testWidgets('a missing machine remains a read-only unavailable preview', (
    tester,
  ) async {
    final fixture = await mount(tester);
    fixture.app.machineStates.remove('m');
    await tester.pumpWidget(fixture.widget());
    await tester.pumpAndSettle();
    expect(find.text('Unavailable'), findsOneWidget);
    expect(fixture.controls.invoke('picker.accept'), isFalse);
    expect(find.byType(MachinePickerForm), findsNothing);
    expect(fixture.choices, isEmpty);
  });

  testWidgets(
    'create API from a filtered preview returns to its new saved row',
    (tester) async {
      final fixture = await mount(
        tester,
        query: ':missing',
        offersCreate: true,
      );
      expect(fixture.search.selected!.isCreate, isTrue);
      await tester.tap(
        find.byKey(const ValueKey('resource-action:picker.accept')),
      );
      await tester.pumpAndSettle();
      expect(find.byType(ApiPickerForm), findsOneWidget);
      fixture.refocus();
      await tester.pump();
      await invoke(tester, fixture, 'picker.focus_actions');
      expect(fixture.queryFocus.hasFocus, isFalse);
      await tester.tap(find.byKey(const ValueKey('api-form:provider:custom')));
      await tester.pumpAndSettle();
      await tester.enterText(
        find.byKey(const ValueKey('api-form-input:name')),
        'Saved API',
      );
      await tester.enterText(
        find.byKey(const ValueKey('api-form-input:url')),
        'https://fixture.invalid/v1',
      );
      await tester.enterText(
        find.byKey(const ValueKey('api-form-input:key')),
        'fixture-only-key',
      );
      await tester.tap(find.byKey(const ValueKey('api-form:save')));
      await tester.pumpAndSettle();
      expect(find.byType(ApiPickerForm), findsNothing);
      expect(fixture.search.query, ':');
      expect(fixture.search.selected!.modelId, 'model:api:saved-api');
      expect(fixture.queryFocus.hasFocus, isTrue);
      expect(
        fixture.app.apiWrites.where((entry) => entry['action'] == 'save'),
        hasLength(1),
      );
    },
  );

  testWidgets(
    'a create result returns one intent and keeps launch ownership outside the preview',
    (tester) async {
      final fixture = await mount(
        tester,
        query: 'New feature task',
        offersCreate: true,
      );
      expect(fixture.search.selected!.isCreate, isTrue);
      await tester.tap(
        find.byKey(const ValueKey('resource-action:picker.accept')),
      );
      await tester.pumpAndSettle();
      expect(fixture.choices, hasLength(1));
      expect(fixture.choices.single.destination.isCreate, isTrue);
      expect(fixture.app.connection.creations, isEmpty);
      expect(fixture.queryFocus.hasFocus, isTrue);
    },
  );

  testWidgets(
    'a native model discovery error is visible beside the retained model',
    (tester) async {
      final fixture = await mount(tester, query: ':gemma');
      fixture.app.localReadFails = true;
      await invoke(tester, fixture, 'picker.refresh');
      final error = fixture.app.modelManager.error;
      expect(error, isNotNull);
      expect(find.text('Local models · $error'), findsOneWidget);
      expect(fixture.search.selected!.modelId, 'model:local:gemma');
      expect(fixture.choices, isEmpty);
    },
  );

  testWidgets(
    'discovered models explain pending controls and keep the stable row when inventory arrives',
    (tester) async {
      final app = _EdgeApp()
        ..localInventory = {'models': <Object>[]}
        ..inventory = const GridModels(
          gridName: 'home',
          models: [GridModel(id: 'Discovery model', node: 'This Mac')],
        );
      final fixture = await mount(tester, app: app, query: ':Discovery model');
      final selected = fixture.search.selected!.id;
      final reply = Completer<Map<String, dynamic>>();
      app.localReply = reply;
      final pending = app.modelManager.refresh(force: true);
      await tester.pump();
      expect(find.text('Finding model controls…'), findsOneWidget);
      reply.complete({
        'models': [
          {
            'id': 'discovery',
            'name': 'Discovery model',
            'state': 'running',
            'canStop': true,
          },
        ],
      });
      await pending;
      await tester.pumpAndSettle();
      expect(find.text('Finding model controls…'), findsNothing);
      expect(fixture.search.selected!.id, selected);
      expect(fixture.catalog.entries.values.single.local!.id, 'discovery');
    },
  );

  testWidgets('a remote model inventory error stays with its own host', (
    tester,
  ) async {
    final app = _EdgeApp();
    app.machineStates['other']!
      ..nodeOnline = true
      ..connectionStatus = ConnectionStatus.connected;
    app.machineInventories['other'] = {
      'models': [
        {
          'id': 'remote',
          'name': 'Remote model',
          'state': 'downloaded',
          'canStart': true,
        },
      ],
    };
    final fixture = await mount(tester, app: app, query: ':');
    fixture.catalog.setVisible(true);
    await fixture.catalog.refresh();
    fixture.search.setQuery(':Remote model');
    await tester.pumpAndSettle();
    final entry = fixture.catalog.entries[fixture.search.selected!.id]!;
    app.failingModelHosts.add('other');
    await entry.controller!.refresh(force: true);
    await tester.pumpAndSettle();
    expect(entry.controller!.error, 'Models are unavailable. Try again.');
    expect(app.modelManager.error, isNull);
    expect(find.text('Models are unavailable. Try again.'), findsOneWidget);
    expect(fixture.search.selected!.id, entry.id);
    expect(fixture.app.actions, isEmpty);
  });

  testWidgets(
    'changing selection closes machine edits before stale input can submit',
    (tester) async {
      final fixture = await mount(tester);
      await invoke(tester, fixture, 'picker.resource_rename');
      expect(find.byType(MachinePickerForm), findsOneWidget);
      fixture.refocus();
      await tester.pump();
      await invoke(tester, fixture, 'picker.focus_actions');
      expect(fixture.queryFocus.hasFocus, isFalse);
      fixture.search.setQuery('@Other computer');
      await tester.pumpAndSettle();
      expect(find.byType(MachinePickerForm), findsNothing);
      expect(fixture.queryFocus.hasFocus, isTrue);
      expect(fixture.app.connection.creations, isEmpty);
    },
  );

  testWidgets(
    'switching to another search controller detaches old selection callbacks',
    (tester) async {
      final fixture = await mount(tester);
      final replacement = SwarmSearchController(
        fixture.app,
        const [],
        adding: true,
      )..setQuery('@Other computer');
      addTearDown(replacement.dispose);
      await tester.pumpWidget(fixture.widget(replacement: replacement));
      await tester.pumpAndSettle();
      await invoke(tester, fixture, 'picker.focus_actions');
      expect(replacement.managing, isTrue);
      final before = fixture.refocuses;
      fixture.search.setQuery('@does-not-exist');
      await tester.pumpAndSettle();
      expect(fixture.refocuses, before);
      expect(replacement.selected!.machineId, 'other');
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'machine metrics poll only while visible and join overlapping reads',
    (tester) async {
      final fixture = await mount(
        tester,
        resourcePollInterval: const Duration(seconds: 1),
      );
      final app = fixture.app;
      final before = app.resourceReads;
      final reply = Completer<MachineResources?>();
      app.resourceReply = reply;
      await tester.pump(const Duration(seconds: 1));
      expect(app.resourceReads, before + 2);
      await tester.pump(const Duration(seconds: 3));
      expect(
        app.resourceReads,
        before + 2,
        reason: 'A slow daemon must not accumulate overlapping requests',
      );
      reply.complete(null);
      await tester.pump();
      app.resourceReply = null;
      app.foreground.value = false;
      await tester.pump(const Duration(seconds: 2));
      expect(app.resourceReads, before + 2);
      app.foreground.value = true;
      fixture.search.setQuery(':');
      await tester.pump(const Duration(seconds: 2));
      expect(
        app.resourceReads,
        before + 2,
        reason: 'Model browsing should not poll machine telemetry',
      );
      fixture.search.setQuery('@');
      await tester.pump();
      final returned = app.resourceReads;
      await tester.pump(const Duration(seconds: 1));
      expect(app.resourceReads, returned + 2);
      await tester.pumpWidget(const SizedBox());
      final closed = app.resourceReads;
      await tester.pump(const Duration(seconds: 5));
      expect(app.resourceReads, closed);
      expect(tester.takeException(), isNull);
    },
  );

  for (final window in [7200, 90]) {
    testWidgets(
      'model preview explains oversized resting weights and usage window $window',
      (tester) async {
        final app = _EdgeApp();
        app.localInventory = {
          'memoryBytes': 8 * 1024 * 1024 * 1024,
          'models': [
            {
              'id': 'large',
              'name': 'Large model',
              'state': 'running',
              'canStop': true,
              'gridAsleep': true,
              'sizeBytes': 16 * 1024 * 1024 * 1024,
              'requests': 3,
              'windowSeconds': window,
            },
          ],
        };
        await mount(tester, app: app, query: ':Large model');
        expect(
          find.text('needs 16 GB · ${thisComputerName()} has 8.0 GB'),
          findsOneWidget,
        );
        expect(find.text('Resting until your next message'), findsOneWidget);
        expect(
          find.text(window == 7200 ? '3 req / 2h' : '3 req / 2m'),
          findsOneWidget,
        );
        expect(tester.takeException(), isNull);
      },
    );
  }

  testWidgets(
    'a model start keeps its progress and retry error on the selected preview',
    (tester) async {
      final app = _EdgeApp();
      final reply = Completer<Map<String, dynamic>>();
      app.actionReply = reply;
      final fixture = await mount(tester, app: app, query: ':gemma');
      fixture.search.setModelSelection('codex', app.inventory, machineId: 'm');
      final selected = fixture.search.selected!;
      expect(fixture.search.canStartModelForUse(selected), isTrue);
      final start = fixture.search.startModelForUse(
        selected,
        stillCurrent: () => true,
      );
      await tester.pump();
      expect(find.textContaining('Starting…'), findsOneWidget);
      expect(fixture.search.selected!.id, selected.id);
      const failure = {
        'id': 'start',
        'modelId': 'gemma',
        'action': 'start',
        'stage': 'starting',
        'phase': 'failed',
        'error': 'Not enough memory',
      };
      app.localInventory = {
        'models': [
          {
            'id': 'gemma',
            'name': 'gemma-4-12B',
            'state': 'downloaded',
            'canStart': true,
            'operation': failure,
          },
        ],
      };
      reply.complete({'operation': failure});
      await tester.pumpAndSettle();
      expect(await start, isNull);
      expect(fixture.search.modelUseError, 'Not enough memory');
      expect(find.text('Not enough memory'), findsWidgets);
      expect(fixture.search.selected!.id, selected.id);
      expect(app.actions, hasLength(1));
      expect(fixture.choices, isEmpty);
    },
  );

  testWidgets('narrow API preview wraps labels and explains host ownership', (
    tester,
  ) async {
    final app = _EdgeApp();
    const api = ApiConnection({
      'id': 'edge-api',
      'name': 'Private API',
      'provider': 'custom',
      'baseUrl': 'https://example.invalid/v1',
      'authHeader': 'Authorization',
      'authPrefix': 'Bearer',
    });
    final fixture = await mount(tester, app: app, query: ':', width: 250);
    app.modelManager.apis
      ..connections = [api]
      ..loaded = true;
    app.modelManager.apis.models['edge-api'] = ApiModels(
      models: [const ApiModel(id: 'reasoning', name: 'Reasoning model')],
    );
    app.modelManager.apis.notifyListeners();
    fixture.search.setQuery(':reasoning');
    fixture.search.move(1); // The API heading stays above its matching models.
    fixture.search.setModelSelection(
      'codex',
      app.inventory,
      machineId: 'other',
    );
    await tester.pumpAndSettle();
    expect(
      fixture.search.selected?.modelId,
      'model:apimodel:edge-api:reasoning',
      reason:
          'catalog=${fixture.catalog.entries.keys}; rows=${fixture.search.rows.map((row) => row.id)}',
    );
    expect(find.text('Reasoning model'), findsOneWidget);
    expect(
      find.textContaining('only the harnesses there can run on it'),
      findsOneWidget,
    );
    expect(tester.takeException(), isNull);
    fixture.search.setModelSelection(
      'terminal',
      const GridModels(
        gridName: 'home',
        models: [],
        localModelEngines: {'codex'},
      ),
      machineId: 'm',
    );
    await tester.pumpAndSettle();
    expect(find.text('Not available to this harness'), findsOneWidget);
    await invoke(tester, fixture, 'picker.resource_settings');
    expect(find.byType(ApiPickerForm), findsOneWidget);
    expect(
      tester
          .widget<TextField>(find.byKey(const ValueKey('api-form-input:name')))
          .controller!
          .text,
      'Private API',
    );
  });
}
