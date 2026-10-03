// A saved API as a place to run a harness (Cmd-I / Cmd-P `:`): an API that takes a Bearer key lists
// its chat models folded under its row, Enter shows them, and Use moves the focused pane's agent onto
// one through the daemon — which reads the endpoint and key itself. Only this computer's harnesses
// can use its APIs, and an API that takes no Bearer key stays tools-only.

import 'package:harness/shared/theme/app_icons.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/models/api_connections_controller.dart';
import 'package:harness/models/model_search_catalog.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/state/retarget_refusal.dart';
import 'package:harness/state/swarm_navigation.dart';
import 'package:harness/state/swarm_search.dart';
import 'package:harness/widgets/swarm_resource_preview.dart';
import 'package:harness/widgets/swarm_switcher.dart';
import 'package:harness/ws/local_cli_discovery.dart';

import 'keymap_host_test.dart' show MemoryKeymap, key;
import 'keymap_runtime_test.dart' as configured;
import 'resource_picker_test.dart' show fixture;
import 'support/model_manager.dart';
import 'support/real_fonts.dart';

final field = find.byKey(const ValueKey('swarm-search-input'));
SwarmSearchController search(WidgetTester tester) =>
    tester.widget<SwarmSearchResults>(find.byType(SwarmSearchResults)).search;

const openRouter = ApiConnection({
  'id': 'openrouter',
  'provider': 'openrouter',
  'name': 'OpenRouter',
  'baseUrl': 'https://openrouter.ai/api/v1',
  'keyEnv': 'OPENROUTER_API_KEY',
  'authHeader': 'Authorization',
  'authPrefix': 'Bearer',
});
const customDs = ApiConnection({
  'id': 'custom-ds',
  'provider': 'custom',
  'name': 'custom ds',
  'baseUrl': 'https://relay.example.test/v1',
  'keyEnv': 'CUSTOM_DS_API_KEY',
  'authHeader': 'Authorization',
  'authPrefix': 'Bearer',
});
const fal = ApiConnection({
  'id': 'fal-ai',
  'provider': 'fal',
  'name': 'fal.ai',
  'baseUrl': 'https://queue.fal.run',
  'keyEnv': 'FAL_KEY',
  'authHeader': 'Authorization',
  'authPrefix': 'Key',
});

class _ApiApp extends ModelManagerTestApp {
  _ApiApp() : super(ModelManagerConnection());
  final modelReads = <String>[];
  final moves = <({String machine, String agent, String api, String model})>[];
  Map<String, dynamic> Function(String id)? answer;

  @override
  Future<Map<String, dynamic>> apiConnections(
    String machineId,
    Map<String, dynamic> payload, {
    Duration timeout = const Duration(seconds: 10),
  }) async {
    if (payload['action'] == 'models') {
      final id = payload['id'] as String;
      modelReads.add(id);
      return answer?.call(id) ??
          {
            'id': id,
            'models': [
              {
                'id': 'anthropic/claude-sonnet-4.6',
                'name': 'Anthropic: Claude Sonnet 4.6',
                'contextWindow': 1000000,
              },
              {'id': 'z-ai/glm-5', 'contextWindow': 202752},
            ],
          };
    }
    if (payload['action'] == 'save') {
      final input = Map<String, dynamic>.from(payload['connection'] as Map)
        ..remove('apiKey');
      input['id'] = '${input['name']}'.toLowerCase().replaceAll(
        RegExp('[^a-z0-9]+'),
        '-',
      );
      listed = [...listed.where((row) => row['id'] != input['id']), input];
    }
    return {'connections': listed, 'presets': const <Object>[]};
  }

  /// The APIs the CLI would list: the fixture's, then any saved through the editor.
  List<Map<String, dynamic>> listed = [openRouter.data, fal.data];

  @override
  Future<void> retargetAgentToApiModel(
    String machineId,
    String agentId, {
    required String connectionId,
    required String modelId,
  }) async {
    moves.add((
      machine: machineId,
      agent: agentId,
      api: connectionId,
      model: modelId,
    ));
  }
}

Future<_ApiApp> _apiFixture({String agentMachine = 'm', Agent? agent}) async {
  final app = _ApiApp()
    ..inventory = const GridModels(
      gridName: 'home',
      models: [],
      grids: [GridSection(name: 'home', own: true, models: [])],
    );
  await fixture(provided: app);
  app.modelManager.apis.connections = [openRouter, fal];
  final machine = app.machineStates[agentMachine]!
    ..localEndpoint = LocalCliEndpoint(
      computerId: 'fixture',
      wsUri: Uri.parse('ws://fixture.invalid'),
      protocolVersion: 1,
      terminalProtocolVersion: 3,
    )
    ..connectionStatus = ConnectionStatus.connected
    ..agentLoadStatus = AgentLoadStatus.loaded;
  machine.agents.add(
    agent ??
        const Agent(
          id: 'a69',
          name: 'Current harness',
          engine: 'claude',
          terminalAvailable: true,
        ),
  );
  return app;
}

String rowTitle(SwarmDestination row) => row.title;

Finder inPreview(String text) => find.descendant(
  of: find.byType(SwarmResourcePreview),
  matching: find.text(text),
);

void main() {
  setUpAll(loadRealFonts);

  testWidgets(
    "an API's models stay folded until Enter on its row, and Use moves the pane onto one",
    (tester) async {
      final app = await _apiFixture();
      final map = MemoryKeymap();
      try {
        await configured.mount(tester, app, map);
        await key(tester, LogicalKeyboardKey.keyI, cmd: true);
        await tester.pumpAndSettle();
        final picker = search(tester);
        expect(picker.modelSelectionEngine, 'claude');
        // Read once for the API that takes a Bearer key; fal.ai is for tools only.
        expect(app.modelReads, ['openrouter']);
        expect(
          picker.rows.where(
            (row) => row.modelId?.startsWith('model:apimodel:') == true,
          ),
          isEmpty,
        );
        final apiRow = picker.rows.singleWhere(
          (row) => row.modelId == 'model:api:openrouter',
        );
        expect(picker.canExpandApi(apiRow), isTrue);
        expect(
          picker.canExpandApi(
            picker.rows.singleWhere((row) => row.modelId == 'model:api:fal-ai'),
          ),
          isFalse,
        );
        // fal.ai lists no models to run a harness on: its preview says what it is for instead.
        final falRow = picker.rows.singleWhere(
          (row) => row.modelId == 'model:api:fal-ai',
        );
        picker.move(picker.rows.indexOf(falRow) - picker.cursor);
        await tester.pump();
        expect(inPreview('Tools'), findsOneWidget);
        expect(
          find.text(
            'harness agents on this computer can call it with the saved key',
          ),
          findsOneWidget,
        );
        expect(
          find.descendant(
            of: find.byKey(const ValueKey('swarm-search-preview')),
            matching: find.textContaining('models to run a harness'),
          ),
          findsNothing,
        );

        // Folded: a marker to open it, and how many models it has at the end of its row.
        expect(
          tester
              .widget<Icon>(
                find.byKey(
                  const ValueKey('api-row-marker:model:api:openrouter'),
                ),
              )
              .icon,
          AppIcons.chevronRight,
        );
        expect(
          tester
              .widget<Text>(
                find.byKey(const ValueKey('api-row-hint:model:api:openrouter')),
              )
              .data,
          '2 models',
        );
        expect(
          tester
              .widget<Text>(
                find.byKey(const ValueKey('api-row-hint:model:api:fal-ai')),
              )
              .data,
          'Tools',
        );
        picker.move(picker.rows.indexOf(apiRow) - picker.cursor);
        await tester.pump();
        expect(
          find.text('pick one of its 2 models to run a harness on it'),
          findsOneWidget,
        );
        expect(find.text('Use'), findsWidgets);
        expect(find.text('https://openrouter.ai/api/v1'), findsOneWidget);
        expect(inPreview('Key'), findsNothing);
        expect(find.textContaining('OPENROUTER_API_KEY'), findsNothing);
        expect(inPreview('Tools'), findsNothing);
        expect(picker.actionLabel(apiRow), 'Show models');

        await key(tester, LogicalKeyboardKey.enter);
        await tester.pump();
        expect(picker.expandedApis, {'openrouter'});
        expect(
          picker.selected!.modelId,
          apiModelRowId('openrouter', 'anthropic/claude-sonnet-4.6'),
        );
        // Named alone, one step in under its API, which now says it is open.
        expect(picker.selected!.title, 'anthropic/claude-sonnet-4.6');
        final marker = find.byKey(
          const ValueKey('api-row-marker:model:api:openrouter'),
        );
        expect(tester.widget<Icon>(marker).icon, AppIcons.chevronDown);
        expect(
          tester
              .getTopLeft(
                find.descendant(
                  of: find.byKey(
                    ValueKey(
                      'swarm-search-line:${apiModelRowId('openrouter', 'anthropic/claude-sonnet-4.6')}',
                    ),
                  ),
                  matching: find.text('anthropic/claude-sonnet-4.6'),
                ),
              )
              .dx,
          greaterThan(
            tester
                .getTopLeft(
                  find.descendant(
                    of: find.byKey(
                      const ValueKey('swarm-search-line:model:api:openrouter'),
                    ),
                    matching: find.text('OpenRouter'),
                  ),
                )
                .dx,
          ),
        );
        expect(picker.modelRowAction(picker.selected!), 'Use');
        // The end of its row says what Enter does on it — never the API's name, which heads it.
        final rowId = apiModelRowId(
          'openrouter',
          'anthropic/claude-sonnet-4.6',
        );
        expect(
          tester
              .widget<Text>(find.byKey(ValueKey('model-row-status:$rowId')))
              .data,
          'Use',
        );
        expect(
          find.descendant(
            of: find.byKey(ValueKey('swarm-search-line:$rowId')),
            matching: find.text('OpenRouter'),
          ),
          findsNothing,
        );
        expect(find.text('OpenRouter · 1M context'), findsOneWidget);
        expect(find.text('Anthropic: Claude Sonnet 4.6'), findsOneWidget);
        expect(app.moves, isEmpty);

        await key(tester, LogicalKeyboardKey.enter);
        await tester.pumpAndSettle();
        expect(app.moves, [
          (
            machine: 'm',
            agent: 'a69',
            api: 'openrouter',
            model: 'anthropic/claude-sonnet-4.6',
          ),
        ]);
        expect(find.byType(SwarmSearchResults), findsNothing);
        expect(tester.takeException(), isNull);
      } finally {
        await tester.pumpWidget(const SizedBox());
        app.dispose();
        map.dispose();
      }
    },
  );

  testWidgets(
    '[ Add ] under APIs says what an API is for, and nothing about local models',
    (tester) async {
      final app = await _apiFixture();
      final map = MemoryKeymap();
      try {
        await configured.mount(tester, app, map);
        await key(tester, LogicalKeyboardKey.keyI, cmd: true);
        await tester.pumpAndSettle();
        final picker = search(tester);
        final add = picker.rows.singleWhere((row) => row.isCreate);
        picker.move(picker.rows.indexOf(add) - picker.cursor);
        await tester.pump();
        expect(find.text('Add an API key'), findsOneWidget);
        expect(
          find.text(
            'OpenRouter or a Custom API: Use its models to run a harness.',
          ),
          findsOneWidget,
        );
        expect(
          find.text(
            'fal.ai or Replicate: harness agents can call it as a tool.',
          ),
          findsOneWidget,
        );
        expect(find.textContaining('local model'), findsNothing);
      } finally {
        await tester.pumpWidget(const SizedBox());
        app.dispose();
        map.dispose();
      }
    },
  );

  testWidgets(
    'a search finds API models without unfolding them, each under its own API',
    (tester) async {
      final app = await _apiFixture();
      app.modelManager.apis.connections = [openRouter, customDs, fal];
      final map = MemoryKeymap();
      try {
        await configured.mount(tester, app, map);
        await key(tester, LogicalKeyboardKey.keyI, cmd: true);
        await tester.pumpAndSettle();
        await tester.enterText(field, ':glm');
        await tester.pumpAndSettle();
        final picker = search(tester);
        final apis = picker.rows
            .where((row) => picker.isApiRow(row) || picker.isApiModelRow(row))
            .map((row) => row.modelId)
            .toList();
        // Both APIs list the model: each copy sits under its own API, and neither API unfolded.
        expect(apis, [
          'model:api:openrouter',
          apiModelRowId('openrouter', 'z-ai/glm-5'),
          'model:api:custom-ds',
          apiModelRowId('custom-ds', 'z-ai/glm-5'),
        ]);
        expect(picker.expandedApis, isEmpty);
        expect(find.text('z-ai/glm-5'), findsNWidgets(2));
        expect(find.textContaining('· OpenRouter'), findsNothing);
      } finally {
        await tester.pumpWidget(const SizedBox());
        app.dispose();
        map.dispose();
      }
    },
  );

  testWidgets('Save returns to the list on the new API, ready to open it', (
    tester,
  ) async {
    final app = await _apiFixture();
    final map = MemoryKeymap();
    try {
      await configured.mount(tester, app, map);
      await key(tester, LogicalKeyboardKey.keyI, cmd: true);
      await tester.pumpAndSettle();
      final picker = search(tester);
      final add = picker.rows.singleWhere((row) => row.isCreate);
      picker.move(picker.rows.indexOf(add) - picker.cursor);
      await tester.pump();
      await key(tester, LogicalKeyboardKey.enter);
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('api-form:provider:custom')));
      await tester.pumpAndSettle();
      await tester.enterText(
        find.byKey(const ValueKey('api-form-input:name')),
        'haha cust',
      );
      await key(tester, LogicalKeyboardKey.tab);
      expect(
        tester
            .widget<TextField>(find.byKey(const ValueKey('api-form-input:url')))
            .focusNode!
            .hasFocus,
        isTrue,
      );
      await tester.enterText(
        find.byKey(const ValueKey('api-form-input:url')),
        'https://relay.example.test/v1',
      );
      await tester.enterText(
        find.byKey(const ValueKey('api-form-input:key')),
        'fixture-key',
      );
      // Traverse the secondary controls, then the fixed footer action.
      final save = find.byKey(const ValueKey('api-form:save'));
      for (
        var step = 0;
        step < 6 && !tester.widget<FilledButton>(save).focusNode!.hasFocus;
        step++
      ) {
        await key(tester, LogicalKeyboardKey.tab);
      }
      expect(tester.widget<FilledButton>(save).focusNode!.hasFocus, isTrue);
      expect(save.hitTestable(), findsOneWidget);
      await key(tester, LogicalKeyboardKey.enter);
      await tester.pumpAndSettle();

      // Back on the list, on the API just saved, with the keys in the list rather than the pane.
      expect(find.byKey(const ValueKey('api-form:save')), findsNothing);
      expect(picker.selected?.modelId, 'model:api:haha-cust');
      expect(picker.managing, isFalse);
      expect(tester.widget<TextField>(field).focusNode!.hasFocus, isTrue);
      await tester.pumpAndSettle();
      // Enter opens its models straight away.
      await key(tester, LogicalKeyboardKey.enter);
      await tester.pump();
      expect(picker.expandedApis, contains('haha-cust'));
      expect(
        picker.selected?.modelId,
        apiModelRowId('haha-cust', 'anthropic/claude-sonnet-4.6'),
      );
    } finally {
      await tester.pumpWidget(const SizedBox());
      app.dispose();
      map.dispose();
    }
  });

  testWidgets('a URL that is not one says how to fix it, under the URL', (
    tester,
  ) async {
    final app = await _apiFixture();
    final map = MemoryKeymap();
    try {
      await configured.mount(tester, app, map);
      await key(tester, LogicalKeyboardKey.keyI, cmd: true);
      await tester.pumpAndSettle();
      final picker = search(tester);
      final add = picker.rows.singleWhere((row) => row.isCreate);
      picker.move(picker.rows.indexOf(add) - picker.cursor);
      await tester.pump();
      await key(tester, LogicalKeyboardKey.enter);
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('api-form:provider:custom')));
      await tester.pumpAndSettle();
      Finder input(String id) => find.byKey(ValueKey('api-form-input:$id'));
      await tester.enterText(input('name'), 'fdafd');
      await tester.enterText(input('url'), 'fdfd');
      await tester.enterText(input('key'), 'fixture-key');
      await tester.tap(find.byKey(const ValueKey('api-form:save')));
      await tester.pumpAndSettle();

      final error = find.byKey(const ValueKey('api-form-error:url'));
      expect(
        tester.widget<Text>(error).data,
        'Enter the full URL, starting with https://, '
        'for example https://openrouter.ai/api/v1.',
      );
      // Under the URL, above the next field — and nothing was saved.
      expect(
        tester.getTopLeft(error).dy,
        greaterThan(tester.getTopLeft(input('url')).dy),
      );
      expect(
        tester.getTopLeft(error).dy,
        lessThan(tester.getTopLeft(input('key')).dy),
      );
      expect(
        tester.widget<TextField>(input('url')).focusNode!.hasFocus,
        isTrue,
      );
      expect(find.byKey(const ValueKey('api-form:save')), findsOneWidget);
      expect(app.listed.map((row) => row['name']), isNot(contains('fdafd')));
      // Typing a fix takes the sentence away.
      await tester.enterText(input('url'), 'https://relay.example.test/v1');
      await tester.pump();
      expect(error, findsNothing);
    } finally {
      await tester.pumpWidget(const SizedBox());
      app.dispose();
      map.dispose();
    }
  });

  testWidgets('the model the pane is already on moves nothing', (tester) async {
    final app = await _apiFixture(
      agent: const Agent(
        id: 'a69',
        name: 'Current harness',
        engine: 'claude',
        terminalAvailable: true,
        gridModel: 'z-ai/glm-5',
        // What the daemon reads off Claude Code: the endpoint without `/v1`.
        gridBaseUrl: 'https://openrouter.ai/api',
      ),
    );
    final map = MemoryKeymap();
    try {
      await configured.mount(tester, app, map);
      await key(tester, LogicalKeyboardKey.keyI, cmd: true);
      await tester.pumpAndSettle();
      await tester.enterText(field, ':glm');
      await tester.pumpAndSettle();
      final picker = search(tester);
      final row = picker.rows.singleWhere(
        (row) => row.modelId == apiModelRowId('openrouter', 'z-ai/glm-5'),
      );
      picker.move(picker.rows.indexOf(row) - picker.cursor);
      await tester.pump();
      await key(tester, LogicalKeyboardKey.enter);
      await tester.pumpAndSettle();
      expect(app.moves, isEmpty);
      expect(find.byType(SwarmSearchResults), findsNothing);
    } finally {
      await tester.pumpWidget(const SizedBox());
      app.dispose();
      map.dispose();
    }
  });

  testWidgets('a harness on another computer cannot use this one’s APIs', (
    tester,
  ) async {
    final app = await _apiFixture();
    app.machineStates['other']!
      ..connectionStatus = ConnectionStatus.connected
      ..nodeOnline = true;
    final map = MemoryKeymap();
    try {
      await configured.mount(tester, app, map);
      await key(tester, LogicalKeyboardKey.keyI, cmd: true);
      await tester.pumpAndSettle();
      final picker = search(tester);
      final row = picker
          .models!
          .entries[apiModelRowId('openrouter', 'z-ai/glm-5')]!
          .destination;
      expect(picker.canSelectModel(row), isTrue);
      // The same list, opened for a harness on the other computer: shown, and says why not.
      picker.setModelSelection('claude', app.inventory, machineId: 'other');
      expect(picker.canSelectModel(row), isFalse);
      expect(picker.modelUseReason(row), 'Other machine');
      // And an engine the daemon cannot re-point is refused here too.
      picker.setModelSelection(
        'cursor',
        const GridModels(
          gridName: 'home',
          models: [],
          localModelEngines: {'claude'},
        ),
        machineId: 'm',
      );
      expect(picker.canSelectModel(row), isFalse);
      expect(picker.modelUseReason(row), 'Not available to this harness');
    } finally {
      await tester.pumpWidget(const SizedBox());
      app.dispose();
      map.dispose();
    }
  });

  group('the words', () {
    test('each thing wrong with an API URL has its own fix', () {
      expect(apiUrlProblem(''), "Enter the API's URL.");
      const full =
          'Enter the full URL, starting with https://, '
          'for example https://openrouter.ai/api/v1.';
      expect(apiUrlProblem('fdfd'), full);
      expect(apiUrlProblem('openrouter.ai/api/v1'), full);
      expect(apiUrlProblem('file:///not-an-api'), full);
      expect(
        apiUrlProblem('https://me:secret@api.example.test/v1'),
        'Take the username or password out of the URL. The key has its own field.',
      );
      expect(
        apiUrlProblem('https://api.example.test/v1?key=1'),
        'Take the ? or # part off the end of the URL.',
      );
      expect(apiUrlProblem(' https://openrouter.ai/api/v1 '), isNull);
      expect(apiUrlProblem('http://localhost:8080/v1'), isNull);
    });

    test('context windows read the way people say them', () {
      expect(contextWindowLabel(65536), '64K');
      expect(contextWindowLabel(131072), '128K');
      expect(contextWindowLabel(200000), '200K');
      expect(contextWindowLabel(1000000), '1M');
      expect(contextWindowLabel(1048576), '1M');
      expect(contextWindowLabel(2000000), '2M');
    });

    test('an API refusal says what the daemon said, in API terms', () {
      expect(
        retargetRefusalMessage(
          'API_UNAVAILABLE',
          engineLabel: 'Claude Code',
          api: true,
          detail: 'OpenRouter did not accept the saved key.',
        ),
        'OpenRouter did not accept the saved key.',
      );
      expect(
        retargetRefusalMessage(
          'GRID_ENGINE_UNSUPPORTED',
          engineLabel: 'Cursor',
          api: true,
        ),
        'Cursor can only run on its own login, not an API model.',
      );
      expect(
        retargetRefusalMessage(
          'GRID_ENGINE_UNSUPPORTED',
          engineLabel: 'Cursor',
        ),
        'Cursor can only run on its own login, not a Local model.',
      );
    });

    test('an agent is on an API model only at that API’s endpoint', () {
      const onIt = Agent(
        id: 'a',
        name: 'a',
        gridModel: 'z-ai/glm-5',
        gridBaseUrl: 'https://openrouter.ai/api/v1',
      );
      expect(agentOnApiModel(onIt, openRouter, 'z-ai/glm-5'), isTrue);
      expect(agentOnApiModel(onIt, openRouter, 'other'), isFalse);
      const grid = Agent(
        id: 'a',
        name: 'a',
        gridModel: 'z-ai/glm-5',
        gridBaseUrl: 'https://grid.example.test/relay/v1',
      );
      expect(agentOnApiModel(grid, openRouter, 'z-ai/glm-5'), isFalse);
      expect(agentOnApiModel(null, openRouter, 'z-ai/glm-5'), isFalse);
    });
  });
}
