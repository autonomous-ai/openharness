import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/state/app_state.dart';
import 'package:harness/state/harness_activity.dart';
import 'package:harness/super_tabs/view.dart';

import 'support/swarm_v4_data.dart';
import 'swarm_state_test.dart' show createApp;

/// A message to an agent whose engine is still starting waits for it, and the agent's frame says so (the daemon's
/// `waitingFor: engine`): the agent reads as Starting while it does. The frame is the agent's state, sent again whenever it
/// changes and read whole on a reconnect, so a person who comes back mid-start still sees Starting.
void main() {
  Map<String, dynamic> frame(String agentId, {String? waitingFor}) => {
    'id': agentId,
    'name': agentId,
    'engine': 'claude',
    'status': 'running',
    'sessionId': 'session-$agentId',
    'terminal': {'available': true},
    'waitingFor': waitingFor,
  };

  Map<String, dynamic> synced(String agentId, {String? waitingFor}) => {
    'type': 'agent_synced',
    'payload': {'agent': frame(agentId, waitingFor: waitingFor)},
  };

  test('while its frame says it waits for its engine, an agent is Starting', () async {
    final app = createApp(connected: true);
    addTearDown(app.dispose);
    await app.handleEventForTest('m', synced('a1'));
    expect(harnessActivity(app, 'm', 'a1'), HarnessActivity.idle);
    await app.handleEventForTest('m', synced('a1', waitingFor: 'engine'));
    expect(harnessActivity(app, 'm', 'a1'), HarnessActivity.starting);
    expect(app.engineStarting('m', 'a1'), isTrue);
    // Another agent of the same computer is not.
    expect(harnessActivity(app, 'm', 'a2'), isNot(HarnessActivity.starting));
    // Its engine is up: the daemon sends the frame again, waiting for nothing.
    await app.handleEventForTest('m', synced('a1'));
    expect(harnessActivity(app, 'm', 'a1'), isNot(HarnessActivity.starting));
    expect(app.engineStarting('m', 'a1'), isFalse);
  });

  test('a list read on reconnecting brings the wait back', () {
    final app = createApp(connected: true);
    addTearDown(app.dispose);
    final machine = app.machineStates['m']!;
    machine.agents = [Agent.fromJson(frame('a4', waitingFor: 'engine'))];
    expect(harnessActivity(app, 'm', 'a4'), HarnessActivity.starting);
  });

  test('a computer that is off says offline, not starting', () async {
    final app = createApp(connected: true);
    addTearDown(app.dispose);
    await app.handleEventForTest('m', synced('a3', waitingFor: 'engine'));
    app.connectionStatusForTest('m', ConnectionStatus.reconnecting);
    expect(harnessActivity(app, 'm', 'a3'), isNot(HarnessActivity.starting));
  });

  test('a wait for anything else is not a start', () async {
    final app = createApp(connected: true);
    addTearDown(app.dispose);
    await app.handleEventForTest('m', synced('a5', waitingFor: 'turn'));
    expect(harnessActivity(app, 'm', 'a5'), isNot(HarnessActivity.starting));
  });

  testWidgets(
    'its person sees "starting" on its Your Team row and in its chat\'s bar, and nothing once its turn starts',
    (tester) async {
      await tester.binding.setSurfaceSize(const Size(1440, 900));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      final app = createApp(connected: true);
      // The computer the review data's agents run on, with Second's Claude Code session on it.
      const host = Machine(
        machineId: 'host',
        authMode: MachineAuthMode.remote,
        name: 'Mac Studio',
      );
      app.machines = [...app.machines, host];
      app.machineStates['host'] = MachineState(host)
        ..nodeOnline = true
        ..connectionStatus = ConnectionStatus.connected
        ..agentLoadStatus = AgentLoadStatus.loaded
        ..agents = [
          Agent(
            id: 'session-second',
            name: 'second',
            engine: 'claude',
            terminalAvailable: true,
          ),
        ];
      final c = swarmV4Server().controller(
        account: 'owner',
        initial: {
          'tabId': 'tab',
          'accountId': 'owner',
          'selectedId': 'agent-chat-second',
        },
      );
      addTearDown(c.dispose);
      await tester.runAsync(c.refresh);
      await tester.pumpWidget(
        MaterialApp(
          theme: grid.buildAppTheme(brightness: Brightness.light),
          home: Scaffold(
            body: ListenableBuilder(
              listenable: app,
              builder: (_, _) => SuperTabView(
                controller: c,
                app: app,
                onInvite: () {},
                onAddAgent: (_) {},
                onOpenTerminal: (_) {},
                machineName: (_) => 'Mac Studio',
                github: swarmV4GitHub(),
                board: true,
              ),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      Finder starting(String key) => find.descendant(
        of: find.byKey(ValueKey(key)),
        matching: find.textContaining('starting'),
      );
      expect(starting('super-agent-second'), findsNothing);
      expect(starting('swarm-agent-header'), findsNothing);

      await app.handleEventForTest(
        'host',
        synced('session-second', waitingFor: 'engine'),
      );
      await tester.pumpAndSettle();
      expect(starting('super-agent-second'), findsOneWidget);
      expect(starting('swarm-agent-header'), findsOneWidget);
      // Never a failure while it waits.
      expect(find.textContaining('Failed'), findsNothing);

      await app.handleEventForTest('host', synced('session-second'));
      await tester.pump();
      expect(starting('super-agent-second'), findsNothing);
      expect(starting('swarm-agent-header'), findsNothing);
      await tester.pumpWidget(const SizedBox());
      await tester.runAsync(c.flush);
      // Its turn's watchdog and preview go with the app, before the timers are checked.
      app.dispose();
      await tester.pump();
    },
  );
}
