import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/core/models.dart';
import 'package:harness_mobile/phone/terminal_search.dart';
import 'package:harness_mobile/state/app_state.dart';
import 'package:harness_mobile/state/pending_question.dart';

import 'edge_fixture.dart';

/// Find — every agent on every computer, over Focus — laid out at every phone, scale and
/// brightness: none, one and two hundred agents, names that break layouts, each of its modes, and
/// a machine that has gone away. None may report an overflow.
void main() {
  setUpAll(loadRealFontsIfAsked);

  Future<void> pumpFind(
    WidgetTester tester,
    AppNotifier app,
    double scale,
    Brightness brightness, {
    String? query,
  }) async {
    await tester.pumpWidget(
      phoneApp(
        Scaffold(
          body: TerminalSearchOverlay(
            notifier: app,
            animation: const AlwaysStoppedAnimation(1),
            onClose: () {},
            showing: (machineId: 'm', agentId: 'a0'),
            bottomInset: 34,
            voice: edgeVoice().voice,
          ),
        ),
        textScale: scale,
        brightness: brightness,
      ),
    );
    await frames(tester);
    if (query != null) {
      await tester.enterText(find.byType(TextField), query);
      await frames(tester);
    }
  }

  /// A few of [agents] asking, the way a busy account looks.
  AppNotifier busyApp(List<Agent> agents, {String machineName = 'studio'}) {
    final app = edgeApp(agents: agents, machineName: machineName);
    final machine = app.stateOf('m')!;
    for (final agent in agents.skip(1).take(3)) {
      machine.blockedAgents[agent.id] = PendingQuestion(
        machineId: 'm',
        agentId: agent.id,
        requestId: 'q-${agent.id}',
        answerKey: '1',
        prompt:
            'Run the migration on the test database, then drop the old '
            'table $longName?',
        options: const ['Yes', 'No'],
        multi: false,
        since: DateTime.now(),
      );
    }
    machine.processingAgentIds.add(agents.last.id);
    return app;
  }

  testWidgets('no machine, nothing to find', (tester) async {
    await expectNoLayoutErrors(tester, (scale, brightness) async {
      final app = edgeApp(noMachines: true);
      addTearDown(app.dispose);
      await pumpFind(tester, app, scale, brightness);
      expect(find.text('No harnesses running.'), findsOneWidget);
    });
  });

  testWidgets('one agent, the one on screen', (tester) async {
    await expectNoLayoutErrors(tester, (scale, brightness) async {
      final app = edgeApp(agents: [edgeAgent('a0', name: emojiName)]);
      addTearDown(app.dispose);
      await pumpFind(tester, app, scale, brightness);
    });
  });

  testWidgets('200 agents with long names, some asking, one working', (
    tester,
  ) async {
    await expectNoLayoutErrors(tester, (scale, brightness) async {
      final app = busyApp([
        edgeAgent(
          'a0',
          name: longName,
          project: longProject,
          branch: longBranch,
        ),
        edgeAgent('r', name: rtlName, project: longProject),
        edgeAgent('e', name: emojiName, branch: longBranch),
        ...manyAgents(197).map(
          (agent) => edgeAgent('x${agent.id}', name: '$longName-${agent.id}'),
        ),
      ], machineName: longMachine);
      addTearDown(app.dispose);
      await pumpFind(tester, app, scale, brightness);
      expect(find.text('needs you'), findsOneWidget);
    });
  });

  for (final (mode, query) in [
    ('typed', 'refactor'),
    ('with no match', 'zzzz-nothing'),
    ('commands', '>'),
    ('help', '?'),
    ('projects', '#'),
    ('machines', '@'),
    ('models', ':'),
  ]) {
    testWidgets('a query: $mode', (tester) async {
      await expectNoLayoutErrors(tester, (scale, brightness) async {
        final app = busyApp([
          edgeAgent('a0', name: longName, project: longProject),
          ...manyAgents(20),
        ], machineName: longMachine);
        addTearDown(app.dispose);
        await pumpFind(tester, app, scale, brightness, query: query);
      });
    });
  }

  testWidgets('typing with the keyboard up', (tester) async {
    await expectNoLayoutErrors(tester, (scale, brightness) async {
      final app = busyApp([edgeAgent('a0', name: longName), ...manyAgents(30)]);
      addTearDown(app.dispose);
      await pumpFind(tester, app, scale, brightness, query: 'agent');
      raiseKeyboard(tester);
      await frames(tester);
      lowerKeyboard(tester);
      await frames(tester);
    });
  });

  testWidgets('its machine offline', (tester) async {
    await expectNoLayoutErrors(tester, (scale, brightness) async {
      final app = edgeApp(
        online: false,
        machineName: longMachine,
        agents: manyAgents(5, firstName: longName),
      );
      addTearDown(app.dispose);
      await pumpFind(tester, app, scale, brightness);
    });
  });
}
