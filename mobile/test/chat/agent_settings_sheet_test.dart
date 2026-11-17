import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:harness_mobile/chat/agent_settings_sheet.dart';
import 'package:harness_mobile/core/models.dart';
import 'package:harness_mobile/state/app_state.dart';
import 'package:harness_mobile/ws/ws_conn.dart';

import '../agent_pager_fixture.dart';

/// The agent's Model sheet as somebody uses it: the engine's own models, a pick, an effort, and the permissions shown.
///
/// ⚠️ **The assertion is what reached the machine.** A pick is a runtime-v1 profile in `agent_update`, which the
/// machine types into the agent as `/model` and `/effort`.
void main() {
  /// The request [request] is [type] carrying [payload].
  void expectRequest(
    (String, Map<String, dynamic>) request,
    String type,
    Map<String, Object> payload,
  ) {
    expect(request.$1, type);
    expect(request.$2, payload);
  }

  const catalog = [
    {
      'model': 'opus',
      'name': 'Opus 5.5',
      'description': 'For complex work and everyday tasks',
      'efforts': ['auto', 'low', 'medium', 'high', 'xhigh', 'max'],
    },
    {
      'model': 'claude-fable-5-1',
      'name': 'Fable 5.1',
      'description': 'Most capable for your hardest and longest-running tasks',
      'efforts': ['auto', 'low', 'high'],
    },
    {
      'model': 'haiku',
      'name': 'Haiku 4.5',
      'description': 'Fastest for quick answers',
      'efforts': <String>[],
    },
  ];

  AppNotifier app(
    _ModelsConn connection, {
    String selected = 'runtime-v1:a:claude:opus@medium',
    String? permissionMode = 'acceptEdits',
    String engine = 'claude',
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
            selectedModel: selected,
            permissionMode: permissionMode,
            terminalAvailable: true,
          )
        else
          agent,
    ];
    addTearDown(notifier.dispose);
    return notifier;
  }

  Future<void> open(
    WidgetTester tester,
    AppNotifier notifier, {
    String? Function()? livePermission,
    ({String name, String? effort})? Function()? liveModel,
    Future<String?> Function(String mode)? onPermission,
    Future<bool> Function()? onClearPrompt,
  }) async {
    tester.view.physicalSize = const Size(1179, 2556);
    tester.view.devicePixelRatio = 3;
    addTearDown(tester.view.reset);
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: Builder(
            builder: (context) => TextButton(
              onPressed: () => showAgentSettingsSheet(
                context,
                notifier,
                machineId: 'm',
                agentId: 'a',
                livePermission: livePermission,
                liveModel: liveModel,
                onPermission: onPermission,
                onClearPrompt: onClearPrompt,
              ),
              child: const Text('open'),
            ),
          ),
        ),
      ),
    );
    await tester.tap(find.text('open'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));
  }

  testWidgets(
    'lists the engine\'s models with their lines, the one running ticked, and its efforts',
    (tester) async {
      final connection = _ModelsConn(catalog: catalog);
      await open(tester, app(connection));

      expectRequest(connection.requests.first, 'models_list', {
        'agentId': 'a',
        'catalog': true,
      });
      expect(find.text('Opus 5.5'), findsOneWidget);
      expect(find.text('For complex work and everyday tasks'), findsOneWidget);
      expect(find.text('Fable 5.1'), findsOneWidget);
      expect(find.text('Fastest for quick answers'), findsOneWidget);
      expect(find.byIcon(LucideIcons.check), findsOneWidget);
      // Opus's efforts, Auto left out: it is the engine choosing, not a level.
      for (final label in ['Low', 'Med', 'High', 'XHigh', 'Max']) {
        expect(find.text(label), findsOneWidget, reason: label);
      }
      expect(find.text('Auto'), findsNothing);
      // A sheet given no way to change it shows no Permissions.
      expect(find.text('Permissions'), findsNothing);
    },
  );

  testWidgets(
    'a model picked keeps the effort it takes; an effort picked keeps the model',
    (tester) async {
      final connection = _ModelsConn(catalog: catalog);
      await open(tester, app(connection));

      await tester.tap(find.text('Fable 5.1'));
      await tester.pump();
      // Fable takes no `medium`: the move asks the engine to choose.
      expectRequest(connection.requests.last, 'agent_update', {
        'agentId': 'a',
        'selectedModel': 'runtime-v1:a:claude:claude-fable-5-1@auto',
      });
      await tester.pump(const Duration(milliseconds: 50));

      await tester.tap(find.text('High'));
      await tester.pump();
      expectRequest(connection.requests.last, 'agent_update', {
        'agentId': 'a',
        'selectedModel': 'runtime-v1:a:claude:claude-fable-5-1@high',
      });
    },
  );

  testWidgets(
    'words left in the prompt are said, and Clear prompt picks again once it is empty',
    (tester) async {
      final connection = _ModelsConn(catalog: catalog, refusal: 'BUSY');
      var cleared = 0;
      await open(
        tester,
        app(connection),
        onClearPrompt: () async {
          cleared++;
          // The prompt is empty now: the machine takes the pick.
          connection.refusal = null;
          return true;
        },
      );

      await tester.tap(find.text('Haiku 4.5'));
      await tester.pump();
      await tester.pump();
      expect(
        find.text('The agent is working, or its prompt holds unsent text.'),
        findsOneWidget,
      );

      await tester.tap(find.text('Clear prompt'));
      await tester.pump();
      await tester.pump();
      expect(cleared, 1);
      final updates = connection.requests.where((r) => r.$1 == 'agent_update');
      expect(
        updates,
        hasLength(2),
        reason: 'the refused pick, then the same one again',
      );
      expect(
        updates.last.$2['selectedModel'],
        'runtime-v1:a:claude:haiku@auto',
      );
      expect(
        find.text('The agent is working, or its prompt holds unsent text.'),
        findsNothing,
      );
    },
  );

  testWidgets(
    'a list the chat asked for as it opened is there the moment the sheet is',
    (tester) async {
      final connection = _ModelsConn(catalog: catalog);
      final notifier = app(connection);
      notifier.prefetchAgentModelChoices('m', 'a');
      // Asked once, however often the chat's page builds.
      notifier.prefetchAgentModelChoices('m', 'a');
      await tester.pump();
      expect(
        connection.requests.where((r) => r.$1 == 'models_list'),
        hasLength(1),
      );

      await open(tester, notifier);
      expect(find.text('Asking the agent…'), findsNothing);
      expect(find.text('Opus 5.5'), findsOneWidget);
    },
  );

  testWidgets(
    'Claude Code\'s mode is the one its footer shows, and a pick goes at once',
    (tester) async {
      final asked = <String>[];
      await open(
        tester,
        app(_ModelsConn(catalog: catalog)),
        livePermission: () => 'auto',
        onPermission: (mode) async {
          asked.add(mode);
          return null;
        },
      );
      await tester.scrollUntilVisible(find.text('Plan first'), 200);
      expect(find.text('Permissions'), findsOneWidget);
      for (final label in [
        'Auto-approve',
        'Accept edits',
        'Plan first',
        'Ask first',
      ]) {
        expect(find.text(label), findsOneWidget, reason: label);
      }
      // The footer's mode, not the one it started with (`acceptEdits`).
      expect(
        find.descendant(
          of: find.ancestor(
            of: find.text('Auto-approve'),
            matching: find.byType(InkWell),
          ),
          matching: find.byIcon(LucideIcons.check),
        ),
        findsOneWidget,
      );

      await tester.ensureVisible(find.text('Plan first'));
      await tester.pump();
      await tester.tap(find.text('Plan first'));
      await tester.pump();
      expect(asked, [
        'plan',
      ], reason: 'Claude Code changes it in place, unasked');
    },
  );

  testWidgets('Codex changes in place, Read only too, unasked', (tester) async {
    final asked = <String>[];
    await open(
      tester,
      app(
        _ModelsConn(catalog: catalog),
        engine: 'codex',
        selected: 'runtime-v1:a:codex:gpt-6-luna@auto',
        permissionMode: 'auto',
      ),
      onPermission: (mode) async {
        asked.add(mode);
        return null;
      },
    );
    await tester.scrollUntilVisible(find.text('Read only'), 200);
    await tester.ensureVisible(find.text('Read only'));
    await tester.pump();
    await tester.tap(find.text('Read only'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));
    expect(find.textContaining('Restart in'), findsNothing);
    expect(asked, ['readOnly'], reason: 'its own /permissions, no restart');
  });

  testWidgets('OpenCode starts again in a mode, and is asked first', (
    tester,
  ) async {
    final asked = <String>[];
    await open(
      tester,
      app(
        _ModelsConn(catalog: catalog),
        engine: 'opencode',
        selected: 'runtime-v1:a:opencode:opencode%2Fbig-pickle@auto',
        permissionMode: 'auto',
      ),
      onPermission: (mode) async {
        asked.add(mode);
        return null;
      },
    );
    await tester.scrollUntilVisible(find.text('Ask first'), 200);

    await tester.ensureVisible(find.text('Ask first'));
    await tester.pump();
    await tester.tap(find.text('Ask first'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));
    expect(find.text('Restart in Ask first?'), findsOneWidget);
    expect(
      asked,
      isEmpty,
      reason: 'nothing restarts before the person says so',
    );

    await tester.tap(find.text('Restart'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));
    expect(asked, ['ask']);
  });

  testWidgets(
    'OpenCode\'s variants are its efforts, Default among them to pick back',
    (tester) async {
      final connection = _ModelsConn(
        catalog: [
          {
            'model': 'opencode/deepseek-v4.1-flash-free',
            'name': 'DeepSeek V4.1 Flash Free',
            'efforts': ['auto', 'low', 'high', 'max'],
          },
        ],
      );
      await open(
        tester,
        app(
          connection,
          engine: 'opencode',
          selected:
              'runtime-v1:a:opencode:opencode%2Fdeepseek-v4.1-flash-free@high',
        ),
      );
      for (final label in ['Default', 'Low', 'High', 'Max']) {
        expect(find.text(label), findsOneWidget, reason: label);
      }
      await tester.tap(find.text('Default'));
      await tester.pump();
      expectRequest(connection.requests.last, 'agent_update', {
        'agentId': 'a',
        'selectedModel':
            'runtime-v1:a:opencode:opencode%2Fdeepseek-v4.1-flash-free@auto',
      });
    },
  );

  testWidgets(
    'an OpenCode agent with no session yet is marked by what its footer names, a name cut short included',
    (tester) async {
      await open(
        tester,
        app(
          _ModelsConn(
            catalog: [
              {
                'model': 'opencode/big-pickle',
                'name': 'Big Pickle',
                'efforts': <String>[],
              },
              {
                'model': 'opencode/deepseek-v4.1-flash-free',
                'name': 'DeepSeek V4.1 Flash Free',
                'efforts': ['auto', 'low', 'high', 'max'],
              },
            ],
          ),
          engine: 'opencode',
          // OpenCode makes its session at the first message: the machine names no model until then.
          selected: '',
        ),
        liveModel: () => (name: 'DeepSeek V4.1 Flash F…', effort: 'high'),
      );
      expect(
        find.descendant(
          of: find.ancestor(
            of: find.text('DeepSeek V4.1 Flash Free'),
            matching: find.byType(InkWell),
          ),
          matching: find.byIcon(LucideIcons.check),
        ),
        findsOneWidget,
      );
      expect(find.text('High'), findsOneWidget);
      expect(
        tester
            .widget<Semantics>(
              find.ancestor(
                of: find.text('High'),
                matching: find.byWidgetPredicate(
                  (w) => w is Semantics && w.properties.label == 'Effort High',
                ),
              ),
            )
            .properties
            .selected,
        isTrue,
      );
    },
  );

  testWidgets('an older computer, with no list to give, says so', (
    tester,
  ) async {
    await open(tester, app(_ModelsConn(catalog: null)));
    expect(
      find.text("This computer can't list this agent's models yet."),
      findsOneWidget,
    );
  });
}

/// A machine answering `models_list` with a catalog, remembering every request, and refusing `agent_update` with
/// [refusal] when set — thrown, as [WsConn] does with a reply carrying `error`.
class _ModelsConn extends PagerConn {
  _ModelsConn({required this.catalog, this.refusal});

  final List<Map<String, Object>>? catalog;
  String? refusal;
  final List<(String, Map<String, dynamic>)> requests = [];

  @override
  Future<Map<String, dynamic>> request(
    String type, {
    Map<String, dynamic> payload = const {},
    Duration timeout = const Duration(seconds: 20),
  }) async {
    requests.add((type, payload));
    if (type == 'models_list') {
      return catalog == null ? {'models': <Object>[]} : {'catalog': catalog};
    }
    if (type == 'agent_update' && refusal != null) {
      throw WsRequestFailure(
        responseType: 'agent_update_result',
        code: refusal!,
      );
    }
    return {};
  }
}
