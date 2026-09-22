import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/core/models.dart';
import 'package:harness_mobile/phone/agent_model_rows.dart';
import 'package:harness_mobile/phone/agent_model_sections.dart';
import 'package:harness_mobile/phone/agent_model_sheet.dart';
import 'package:harness_mobile/state/app_state.dart';
import 'package:harness_mobile/ws/ws_conn.dart';

import 'agent_pager_fixture.dart';

/// Moving one agent onto a model, and back off it.
///
/// ⚠️ **The assertion is what reached the machine.** A retarget re-execs the
/// agent's process, so what this feature is FOR is the `agent_retarget` frame
/// and its payload — the rows above it are how a person names one.
void main() {
  /// A machine answering `grid_models_list`, remembering every request, and
  /// refusing the retarget when [refusal] is set.
  ///
  /// The refusal is thrown rather than returned, which is what [WsConn] does
  /// with a reply carrying `error` — see its `_dispatch`.
  GridConn conn({Map<String, dynamic>? models, String? refusal}) =>
      GridConn(models: models ?? _grids, refusal: refusal);

  /// The pager fixture's app, with `a` running on [gridModel] (null = its own
  /// Claude login) and [engine].
  AppNotifier app(
    GridConn connection, {
    String? gridModel,
    String engine = 'claude',
    GridWebSearch? webSearch,
  }) {
    final notifier = pagerApp(connection);
    final machine = notifier.stateOf('m')!;
    machine.agents = [
      for (final agent in machine.agents)
        if (agent.id == 'a')
          Agent(
            id: 'a',
            name: 'a',
            engine: engine,
            gridModel: gridModel,
            gridWebSearch: webSearch,
            terminalAvailable: true,
          )
        else
          agent,
    ];
    addTearDown(notifier.dispose);
    return notifier;
  }

  /// Open the sheet over a bare page — the terminal underneath is no part of
  /// what this file is about, and a page with one never settles (see
  /// [agent_pager_fixture]).
  Future<void> open(WidgetTester tester, AppNotifier notifier) async {
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: Builder(
            builder: (context) => TextButton(
              onPressed: () => showAgentModelSheet(
                context,
                notifier,
                machineId: 'm',
                agentId: 'a',
              ),
              child: const Text('open'),
            ),
          ),
        ),
      ),
    );
    await tester.tap(find.text('open'));
    // The sheet's own opening animation, with the machine's answer landing
    // inside it.
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));
  }

  /// The payloads this phone sent for [type], in order.
  List<Map<String, dynamic>> sent(GridConn connection, String type) => [
    for (final (sentType, payload) in connection.requests)
      if (sentType == type) payload,
  ];

  /// A model's row in the open sheet.
  Finder row(String title) => find.byWidgetPredicate(
    (widget) => widget is ModelRow && widget.title == title,
  );

  testWidgets(
    'the sheet lists the subscription, the own grid and a shared one',
    (tester) async {
      await open(tester, app(conn()));

      expect(find.text('SUBSCRIPTION'), findsOne);
      // No usage read runs under test, so the row falls back to the engine's own
      // name — which is the word the sheet uses for "its own login" anyway.
      expect(row('Claude'), findsOne);

      expect(find.text('LOCAL MODELS ON YOUR MACHINES'), findsOne);
      expect(row('qwen3-coder'), findsOne);
      // Which of the user's own computers is answering it.
      expect(find.text('mac-mini'), findsOne);

      expect(find.text('MODELS SHARED WITH YOU'), findsOne);
      expect(find.text('autonomous.ai'), findsOne);
      expect(row('DeepSeek-V4-Flash'), findsOne);
    },
  );

  testWidgets('the agent is on its own login until a model is picked', (
    tester,
  ) async {
    await open(tester, app(conn()));

    expect(tester.widget<ModelRow>(row('Claude')).selected, isTrue);
    expect(tester.widget<ModelRow>(row('qwen3-coder')).selected, isFalse);
  });

  testWidgets('picking a shared grid\'s model names the grid it came from', (
    tester,
  ) async {
    final connection = conn();
    await open(tester, app(connection));

    await tester.tap(row('DeepSeek-V4-Flash'));
    await tester.pump();

    expect(sent(connection, 'agent_retarget'), [
      {
        'agentId': 'a',
        'gridModel': 'DeepSeek-V4-Flash',
        // Without this the daemon would resolve the id against the account's
        // OWN grid, which does not serve it.
        'gridName': 'autonomous.ai',
      },
    ]);
  });

  testWidgets('picking the subscription takes the agent back off the grid', (
    tester,
  ) async {
    final connection = conn();
    await open(tester, app(connection, gridModel: 'qwen3-coder'));

    expect(tester.widget<ModelRow>(row('qwen3-coder')).selected, isTrue);
    await tester.tap(row('Claude'));
    await tester.pump();

    expect(sent(connection, 'agent_retarget'), [
      {'agentId': 'a', 'clearGrid': true},
    ]);
  });

  testWidgets('picking the model already in force changes nothing', (
    tester,
  ) async {
    final connection = conn();
    await open(tester, app(connection, gridModel: 'qwen3-coder'));

    await tester.tap(row('qwen3-coder'));
    await tester.pump();

    // A retarget re-execs the agent's process — a tap on the row already
    // wearing the tick must not throw a live process away to put it back.
    expect(sent(connection, 'agent_retarget'), isEmpty);
  });

  testWidgets('a refused move says why, in the app\'s own words', (
    tester,
  ) async {
    final connection = conn(refusal: 'AGENT_BUSY');
    await open(tester, app(connection));

    await tester.tap(row('qwen3-coder'));
    // The sheet closing, then the refusal landing in the page behind it.
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));

    expect(
      find.textContaining('This agent is still responding'),
      findsOne,
      reason:
          'the daemon refuses before it touches the pane, so the terminal '
          'never says why',
    );
  });

  testWidgets('an engine with no way onto a local model is told so', (
    tester,
  ) async {
    // The daemon names the capable engines beside the list; Cursor talks only
    // to its own API and is not among them.
    await open(tester, app(conn(), engine: 'cursor'));

    expect(find.text('Cursor can only run on its own login.'), findsOne);
    expect(row('qwen3-coder'), findsNothing);
  });

  testWidgets('a machine that did not answer is not an account with no grid', (
    tester,
  ) async {
    await open(tester, app(conn(models: {})));

    expect(find.text('Could not reach this machine.'), findsOne);
  });

  testWidgets('the web-search warning rides the model the agent is on', (
    tester,
  ) async {
    await open(
      tester,
      app(
        conn(),
        gridModel: 'qwen3-coder',
        webSearch: GridWebSearch.unavailable,
      ),
    );

    expect(tester.widget<ModelRow>(row('qwen3-coder')).warning, isNotNull);
    // Nothing is known about the models the agent is NOT running.
    expect(tester.widget<ModelRow>(row('DeepSeek-V4-Flash')).warning, isNull);
  });

  testWidgets('a long model id and a long node fit a phone\'s width', (
    tester,
  ) async {
    // ⚠️ At a real phone's width, not the test binding's 800×600 default: the
    // row is a Row of three parts and the names in it are as long as a GGUF's
    // filename. An overflow fails this loudly.
    tester.view.physicalSize = const Size(390, 844);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);

    await open(tester, app(conn(models: _longNames)));

    expect(row('Qwen3.6-35B-A3B-UD-Q5_K_XL-00001-of-00002'), findsOne);
  });

  group('sections', () {
    test('the own grid keeps its heading even with nothing to offer', () {
      final sections = modelSheetSections(
        const GridModels(gridName: 'mine', models: []),
      );

      expect(sections.single.own, isTrue);
      expect(
        modelSheetEmptySentence(
          const GridModels(gridName: 'mine', models: []),
          sections.single,
        ),
        startsWith('No local models on this account yet.'),
      );
    });

    test('a shared grid serving nothing is left out altogether', () {
      final answer = GridModels(
        gridName: 'mine',
        models: const [],
        grids: const [
          GridSection(name: 'mine', own: true, models: []),
          GridSection(name: 'theirs', own: false, models: []),
        ],
      );

      expect(modelSheetSections(answer).map((s) => s.name), ['mine']);
    });

    test('a machine with no grid CLI says that before anything else', () {
      const answer = GridModels(
        gridName: 'mine',
        models: [],
        gridCli: GridCli.missing,
      );

      expect(
        modelSheetEmptySentence(answer, answer.sections.single),
        "Harness Compute isn't installed on this machine.",
      );
    });

    test('the sheet is not offered while it is gated off', () {
      // The row is hidden for now — see [kModelSheetEnabled]. Asserted rather
      // than left implied so flipping the gate back on fails here first, in the
      // one place that says what the rule underneath it is.
      expect(kModelSheetEnabled, isFalse);
      expect(modelSheetSupports('claude'), isFalse);
      expect(modelSheetSupports('CODEX'), isFalse);
    });

    test('only the engines whose switching was driven get the sheet', () {
      // The gate above sits in front of this rule; it is the rule the row goes
      // back to, so it is kept honest while the row is away.
      expect(kModelSheetEngines.contains('claude'), isTrue);
      expect(kModelSheetEngines.contains('codex'), isTrue);
      expect(kModelSheetEngines.contains('cursor'), isFalse);
      expect(modelSheetSupports('cursor'), isFalse);
      expect(modelSheetSupports(null), isFalse);
    });
  });
}

/// One own grid serving `qwen3-coder`, and one shared grid serving
/// `DeepSeek-V4-Flash`.
const _grids = <String, dynamic>{
  'gridName': 'mine',
  'models': [
    {'id': 'qwen3-coder', 'node': 'mac-mini'},
  ],
  'grids': [
    {
      'name': 'mine',
      'own': true,
      'models': [
        {'id': 'qwen3-coder', 'node': 'mac-mini'},
      ],
    },
    {
      'name': 'autonomous.ai',
      'own': false,
      'models': [
        {'id': 'DeepSeek-V4-Flash', 'node': 'scholes-60001'},
      ],
    },
  ],
  'localModelEngines': ['claude', 'codex', 'opencode'],
  'gridCli': 'managed',
};

/// One grid whose model id and node are both as long as they get in the wild.
const _longNames = <String, dynamic>{
  'gridName': 'mine',
  'models': [
    {
      'id': 'Qwen3.6-35B-A3B-UD-Q5_K_XL-00001-of-00002',
      'node': 'firmware-engineer-daniel',
    },
  ],
  'localModelEngines': ['claude'],
  'gridCli': 'managed',
};

/// A machine that answers the model list and remembers what it was asked.
class GridConn extends PagerConn {
  GridConn({required this.models, this.refusal});

  /// The `grid_models_list` reply. Empty stands for a machine that never
  /// answered — the RPC then times out, which is what [_load] reads as
  /// unreachable.
  final Map<String, dynamic> models;

  /// The code `agent_retarget` refuses with, or null to accept the move.
  final String? refusal;

  final List<(String, Map<String, dynamic>)> requests = [];

  @override
  Future<Map<String, dynamic>> request(
    String type, {
    Map<String, dynamic> payload = const {},
    Duration timeout = const Duration(seconds: 20),
  }) async {
    requests.add((type, payload));
    if (type == 'grid_models_list') {
      if (models.isEmpty) throw WsRequestTimeout(type);
      return models;
    }
    if (type == 'agent_retarget' && refusal != null) {
      throw WsRequestFailure(
        responseType: 'agent_retarget_result',
        code: refusal!,
      );
    }
    return {};
  }
}
