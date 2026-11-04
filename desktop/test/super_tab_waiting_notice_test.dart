// Huy (11-04, #2792): the toast "Egret3 · Waiting on you" did nothing when
// clicked; he went through Manage to reach the agent's terminal and its
// prompt. A Waiting on you notice opens the agent's terminal beside the chat
// it waits in, or says why it can't.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/notify/agent_alerts.dart';
import 'package:harness/notify/alert_sounds.dart';
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/workspace.dart';
import 'package:harness/widgets/agent_alert_banners.dart';

import 'super_tab_launch_test.dart' show SuperTabLaunchFixture, tabId;
import 'support/super_tab_fixture.dart';

const _reason =
    'Not in a task or chat now. Give it work or add it to a chat to open its terminal.';

/// A Swarm with Nova waiting on the reader in its task, and Finn in no chat.
Future<SuperTabController> waitingSwarm(SuperTabLaunchFixture f) async {
  f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Company');
  final state = f.connection.server.state;
  state['projects'] = [projectFixture('lead', 'Web', 'lead')];
  state['agents'] = [
    for (final (id, name) in [('nova', 'Nova'), ('finn', 'Finn')])
      {
        'id': id,
        'displayName': name,
        'name': 'Engineer',
        'projectId': 'lead',
        'machineId': 'm',
        'harnessId': 'native-$id',
        'contributorId': 'owner',
        'configuration': {'engine': 'codex'},
      },
  ];
  (state['conversations'] as List).add({
    ...conversationFixture('task', 'Build the mobile app'),
    'projectId': 'lead',
    'agentIds': ['nova'],
    'assignment': {'id': 'as-nova', 'agentId': 'nova', 'status': 'needs_human'},
  });
  f.app.stateOf('m')!.agents = [
    for (final name in ['nova', 'finn'])
      Agent.fromJson({
        'id': 'native-$name',
        'name': name,
        'engine': 'codex',
        'status': 'stopped',
        'sessionId': 'saved-$name',
        'terminal': {'available': false},
      }),
  ];
  final c = await f.app.superTabs.open(tabId);
  await c.refresh();
  await c.select('lead');
  return c;
}

void main() {
  Future<void> show(WidgetTester tester, SuperTabLaunchFixture f) async {
    await tester.binding.setSurfaceSize(const Size(1440, 900));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    // Banners are off until the person turns them on.
    f.app.agentAlerts.store.value = true;
    addTearDown(() => f.app.agentAlerts.store.value = false);
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: Stack(
            children: [
              ListenableBuilder(
                listenable: f.app,
                builder: (_, _) => SuperTabWorkspace(
                  app: f.app,
                  canvas: const SizedBox.expand(),
                  onAddAgent: (_) {},
                ),
              ),
              AgentAlertBanners(notifier: f.app),
            ],
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
  }

  Future<void> clickToast(
    WidgetTester tester,
    SuperTabLaunchFixture f,
    String agent,
  ) async {
    f.app.agentAlerts.post(
      AgentAlert(
        machineId: 'm',
        agentId: 'native-$agent',
        title: agent,
        kind: AlertKind.needsYou,
        at: DateTime.now(),
      ),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('agent-alert-banner')));
    await tester.pumpAndSettle();
  }

  Future<void> done(
    WidgetTester tester,
    SuperTabLaunchFixture f,
    SuperTabController c,
  ) async {
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
    await c.flush();
    f.app.superTabs.dispose();
    await tester.pump();
  }

  testWidgets('a Waiting on you toast opens the agent\'s terminal beside the '
      'task it waits in, focused', (tester) async {
    final f = SuperTabLaunchFixture();
    final c = await waitingSwarm(f);
    await show(tester, f);
    expect(c.selectedId, 'lead');
    await clickToast(tester, f, 'nova');
    expect(c.selectedId, 'task');
    expect(c.terminalAgents('task').single.id, 'nova');
    expect(f.app.panes.single.agentId, 'native-nova');
    expect(f.app.focusedPane?.agentId, 'native-nova');
    await done(tester, f, c);
  });

  testWidgets('from another tab, the toast brings the agent\'s Swarm forward '
      'with its terminal open', (tester) async {
    final f = SuperTabLaunchFixture();
    final c = await waitingSwarm(f);
    final swarm = f.app.activeSwarmId;
    f.app.newSwarm();
    await show(tester, f);
    expect(f.app.activeSwarmId, isNot(swarm));
    await clickToast(tester, f, 'nova');
    expect(f.app.activeSwarmId, swarm);
    expect(c.selectedId, 'task');
    expect(f.app.focusedPane?.agentId, 'native-nova');
    await done(tester, f, c);
  });

  // Review of #2973 (Avocet): an agent no Swarm holds, clicked from a Swarm
  // tab, was added there and closed by the Swarm view, as Huy's was.
  testWidgets('from a Swarm tab, the toast for a harness no Swarm holds opens '
      'it in a new tab, focused', (tester) async {
    final f = SuperTabLaunchFixture();
    final c = await waitingSwarm(f);
    final swarm = f.app.activeSwarmId;
    f.app.stateOf('m')!.agents = [
      ...f.app.stateOf('m')!.agents,
      Agent.fromJson({
        'id': 'native-solo',
        'name': 'solo',
        'engine': 'codex',
        'status': 'stopped',
        'sessionId': 'saved-solo',
        'terminal': {'available': false},
      }),
    ];
    await show(tester, f);
    await clickToast(tester, f, 'solo');
    expect(f.app.activeSwarmId, isNot(swarm));
    expect(f.app.activeSwarm.isSuperTab, isFalse);
    expect(f.app.focusedPane?.agentId, 'native-solo');
    expect(c.selectedId, 'lead');
    await done(tester, f, c);
  });

  testWidgets('Activity\'s "is waiting on you" opens the task with the '
      'agent\'s terminal focused', (tester) async {
    final f = SuperTabLaunchFixture();
    final c = await waitingSwarm(f);
    await show(tester, f);
    await tester.tap(find.byKey(const ValueKey('super-activity')));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Nova is waiting on you'));
    await tester.pumpAndSettle();
    expect(c.selectedId, 'task');
    expect(c.terminalAgents('task').single.id, 'nova');
    expect(f.app.focusedPane?.agentId, 'native-nova');
    await done(tester, f, c);
  });

  testWidgets('the toast for an agent no chat holds brings its Swarm forward '
      'and says why its terminal cannot open', (tester) async {
    final f = SuperTabLaunchFixture();
    final c = await waitingSwarm(f);
    await show(tester, f);
    await clickToast(tester, f, 'finn');
    expect(find.text(_reason), findsOneWidget);
    expect(c.selectedId, 'lead');
    expect(f.app.panes.where((p) => p.agentId == 'native-finn'), isEmpty);
    await done(tester, f, c);
  });
}
