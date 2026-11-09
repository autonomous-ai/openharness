import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/state/app_state.dart';
import 'package:harness/super_tabs/agent_instructions.dart';
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/github_issues.dart';
import 'package:harness/super_tabs/view.dart';

import 'support/super_tab_fixture.dart';
import 'support/swarm_v4_data.dart';
import 'swarm_state_test.dart' show createApp;

/// An agent's Info (Swarm v4, anh Dee 2026-11-09: "we need more info on the agent"): the bar's Info opens what the app already
/// knows of the agent, beside its chat or in its place, one row each, and no row for what it does not know.
void main() {
  Finder key(String k) => find.byKey(ValueKey(k));

  late ConversationServer server;
  late SuperTabController controller;
  var terminalOpen = false;

  /// This computer's view of `host`, where lampOS's agents run: up, and the first builder at work in its folder.
  AppNotifier app({bool online = true, String folder = '/Users/dee/lampOS'}) {
    final app = createApp(connected: true);
    addTearDown(app.dispose);
    final machine = Machine(
      machineId: 'host',
      authMode: MachineAuthMode.remote,
      name: 'Mac Studio',
      status: online ? 'online' : 'offline',
    );
    app.machines = [machine];
    app.machineStates['host'] = MachineState(machine)
      ..nodeOnline = online
      ..connectionStatus = ConnectionStatus.connected
      ..agentLoadStatus = AgentLoadStatus.loaded
      ..agents = [
        Agent(
          id: 'session-first builder',
          name: 'first builder',
          engine: 'claude',
          modelName: 'Opus 5.5',
          project: AgentProject(name: 'lampOS', cwd: folder),
          terminalAvailable: true,
        ),
      ]
      ..processingAgentIds.add('session-first builder');
    return app;
  }

  /// lampOS's Swarm at [size] with [chat] open, its person named Dee; [project] renames the project.
  Future<void> show(
    WidgetTester tester,
    Size size, {
    String chat = 'agent-chat-first builder',
    AppNotifier? app,
    SwarmGitHub? github,
    String? project,
  }) async {
    terminalOpen = false;
    await tester.binding.setSurfaceSize(size);
    addTearDown(() => tester.binding.setSurfaceSize(null));
    server = swarmV4Server();
    (server.state['people'] as List).cast<Map<String, dynamic>>().firstWhere(
      (p) => p['id'] == 'owner',
    )['name'] = 'Dee';
    if (project != null) {
      (server.state['projects'] as List)
              .cast<Map<String, dynamic>>()
              .first['name'] =
          project;
    }
    controller = server.controller(
      account: 'owner',
      initial: {'tabId': 'tab', 'accountId': 'owner', 'selectedId': chat},
    );
    addTearDown(controller.dispose);
    await tester.runAsync(controller.refresh);
    // A Swarm shown again starts afresh, nothing open.
    await tester.pumpWidget(const SizedBox());
    await tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: Brightness.light),
        home: Scaffold(
          body: StatefulBuilder(
            builder: (context, set) => SuperTabView(
              controller: controller,
              app: app,
              onInvite: () {},
              onAddAgent: (_) {},
              onOpenTerminal: (_) {},
              machineName: (_) => 'Mac Studio',
              github: github ?? swarmV4GitHub(),
              instructions: SwarmV4Computer().link,
              terminal: terminalOpen
                  ? const Center(child: Text('Terminal fixture'))
                  : null,
              onOpenGroupTerminals: () => set(() => terminalOpen = true),
              onCloseTerminal: () => set(() => terminalOpen = false),
              board: true,
            ),
          ),
        ),
      ),
    );
    await settle(tester);
  }

  Future<void> tap(WidgetTester tester, Finder what) async {
    await tester.tap(what);
    await settle(tester);
  }

  /// Info's row [id] says [value].
  void expectRow(String id, String value) => expect(
    find.descendant(of: key('swarm-info-$id'), matching: find.text(value)),
    findsOneWidget,
    reason: id,
  );

  testWidgets('Info shows the agent\'s person, project and part, computer, engine, model, state, task and folder, and is one pane '
      'with Instructions and Terminal', (tester) async {
    await show(tester, const Size(1440, 900), app: app());
    await tap(tester, key('swarm-info-button'));
    expect(
      find.descendant(
        of: key('super-right-pane'),
        matching: key('swarm-agent-info'),
      ),
      findsOneWidget,
    );
    expectRow('owner', 'Dee');
    expectRow('projects', 'lampos · PM');
    expectRow('computer', 'Mac Studio · online');
    expectRow('engine', 'Claude Code');
    expectRow('model', 'Opus 5.5');
    expectRow('state', 'Working');
    expectRow(
      'task',
      '#5759 The two update rows were scored down for #5539 and #5476',
    );
    expectRow('folder', '/Users/dee/lampOS');
    // One pane at a time: Instructions takes Info's place, Info Instructions', Terminal Info's, and Info the terminal's.
    await tap(tester, key('swarm-instructions-button'));
    expect(key('swarm-agent-info'), findsNothing);
    expect(find.byType(SwarmAgentInstructions), findsOneWidget);
    await tap(tester, key('swarm-info-button'));
    expect(find.byType(SwarmAgentInstructions), findsNothing);
    expect(key('swarm-agent-info'), findsOneWidget);
    await tap(tester, key('swarm-terminal-button'));
    expect(key('swarm-agent-info'), findsNothing);
    expect(find.text('Terminal fixture'), findsOneWidget);
    await tap(tester, key('swarm-info-button'));
    expect(find.text('Terminal fixture'), findsNothing);
    expect(key('swarm-agent-info'), findsOneWidget);
    await tap(tester, key('swarm-info-close'));
    expect(key('swarm-agent-info'), findsNothing);
    expect(tester.takeException(), isNull);
  });

  testWidgets(
    'an agent the app knows little of shows only the rows it has, and its computer going off says so',
    (tester) async {
      // No view of the computer: no model, state or folder, and third holds no task.
      await show(tester, const Size(1440, 900), chat: 'agent-chat-third');
      await tap(tester, key('swarm-info-button'));
      expectRow('owner', 'Dee');
      expectRow('projects', 'lampos · Builder');
      expectRow('computer', 'Mac Studio');
      expectRow('engine', 'Claude Code');
      for (final id in ['model', 'state', 'task', 'folder']) {
        expect(key('swarm-info-$id'), findsNothing, reason: id);
      }
      await show(tester, const Size(1440, 900), app: app(online: false));
      await tap(tester, key('swarm-info-button'));
      expectRow('computer', 'Mac Studio · offline');
      expectRow('state', 'Offline');
    },
  );

  for (final size in const [Size(1024, 700), Size(880, 560)]) {
    testWidgets(
      'at ${size.width.toInt()}x${size.height.toInt()} Info takes the chat\'s place, and Chat leads back',
      (tester) async {
        await show(tester, size, app: app());
        await tap(tester, key('swarm-info-button'));
        expect(key('super-right-pane'), findsNothing);
        expect(
          find.descendant(
            of: key('super-center-pane'),
            matching: key('swarm-agent-info'),
          ),
          findsOneWidget,
        );
        expect(key('swarm-agent-info').hitTestable(), findsOneWidget);
        expectRow('state', 'Working');
        await tap(tester, key('swarm-back-to-chat-button'));
        expect(key('swarm-agent-info'), findsNothing);
        expect(
          find.byKey(const ValueKey('super-message-composer')).hitTestable(),
          findsOneWidget,
        );
        expect(tester.takeException(), isNull);
      },
    );
  }

  testWidgets(
    'clicked as fast as a person can, at 880x560 with a very long project and folder, Info is one pane and stays inside it',
    (tester) async {
      await show(
        tester,
        const Size(880, 560),
        app: app(
          folder:
              '/Users/dee/work/autonomous/lampOS/firmware/voice/wake-word/models/'
              'onboarding/2026-11-10/a-folder-name-with-no-break-in-it-at-all',
        ),
        project: 'lampOS \u{1F4A1} the lamp that listens, remembers and answers, for every room of every house',
      );
      for (var i = 0; i < 7; i++) {
        await tester.tap(key('swarm-info-button'));
        await tester.pump();
      }
      await settle(tester);
      expect(key('swarm-agent-info'), findsOneWidget);
      expect(tester.takeException(), isNull);
      final pane = tester.getRect(key('swarm-agent-info'));
      for (final id in ['projects', 'folder']) {
        final row = tester.getRect(key('swarm-info-$id'));
        expect(row.left, greaterThanOrEqualTo(pane.left), reason: id);
        expect(row.right, lessThanOrEqualTo(pane.right), reason: id);
      }
    },
  );

  testWidgets('a board that cannot be read says why in the Task row', (
    tester,
  ) async {
    await show(
      tester,
      const Size(1440, 900),
      github: SwarmGitHub(
        run: (_) async => ProcessResult(0, 4, '', 'gh auth login'),
      ),
    );
    await tap(tester, key('swarm-info-button'));
    expectRow('task', 'Sign in to GitHub: run gh auth login.');
    expect(tester.takeException(), isNull);
  });
}

/// Settles, and lets the read mark a chat saves 200 ms after it is read go, so no timer outlives the test.
Future<void> settle(WidgetTester tester) async {
  await tester.pumpAndSettle();
  await tester.pump(const Duration(milliseconds: 300));
}
