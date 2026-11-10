import 'dart:async';

import 'package:fake_async/fake_async.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/state/app_state.dart';
import 'package:harness/state/harness_activity.dart';
import 'package:harness/super_tabs/view.dart';

import 'support/swarm_v4_data.dart';
import 'swarm_state_test.dart' show createApp;

/// A message to an agent whose engine is still starting waits for it (the daemon's `message_waiting`, reason
/// `engine_starting`): the agent reads as Starting until its turn starts, or the daemon says it could not be typed.
void main() {
  Map<String, dynamic> waiting(String agentId) => {
    'type': 'message_waiting',
    'agentId': agentId,
    'dbSessionId': 'session-$agentId',
    'payload': {'reason': 'engine_starting'},
  };

  test(
    'waiting for its engine, an agent is Starting until its turn starts',
    () async {
      final app = createApp(connected: true);
      addTearDown(app.dispose);
      expect(harnessActivity(app, 'm', 'a1'), HarnessActivity.idle);
      await app.handleEventForTest('m', waiting('a1'));
      expect(harnessActivity(app, 'm', 'a1'), HarnessActivity.starting);
      // Another agent of the same computer is not.
      expect(harnessActivity(app, 'm', 'a2'), HarnessActivity.idle);
      await app.handleEventForTest('m', {
        'type': 'turn_started',
        'agentId': 'a1',
        'payload': <String, dynamic>{},
      });
      expect(harnessActivity(app, 'm', 'a1'), isNot(HarnessActivity.starting));
    },
  );

  test('the error that it could not be typed ends the wait', () async {
    final app = createApp(connected: true);
    addTearDown(app.dispose);
    await app.handleEventForTest('m', waiting('a3'));
    await app.handleEventForTest('m', {
      'type': 'error',
      'agentId': 'a3',
      'dbSessionId': 'session-a3',
      'payload': {'message': 'Claude Code did not start in time.'},
    });
    expect(harnessActivity(app, 'm', 'a3'), isNot(HarnessActivity.starting));
  });

  test('a computer that disconnects ends every wait on it', () async {
    final app = createApp(connected: true);
    addTearDown(app.dispose);
    await app.handleEventForTest('m', waiting('a4'));
    app.connectionStatusForTest('m', ConnectionStatus.reconnecting);
    expect(harnessActivity(app, 'm', 'a4'), isNot(HarnessActivity.starting));
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

      await app.handleEventForTest('host', waiting('session-second'));
      await tester.pumpAndSettle();
      expect(starting('super-agent-second'), findsOneWidget);
      expect(starting('swarm-agent-header'), findsOneWidget);
      // Never a failure while it waits.
      expect(find.textContaining('Failed'), findsNothing);

      await app.handleEventForTest('host', {
        'type': 'turn_started',
        'agentId': 'session-second',
        'payload': <String, dynamic>{},
      });
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

  test('a wait that ends without a word ends after two minutes', () {
    fakeAsync((async) {
      final app = createApp(connected: true);
      unawaited(app.handleEventForTest('m', waiting('a6')));
      async.flushMicrotasks();
      expect(harnessActivity(app, 'm', 'a6'), HarnessActivity.starting);
      async.elapse(AppNotifier.engineWaitFor - const Duration(seconds: 1));
      expect(harnessActivity(app, 'm', 'a6'), HarnessActivity.starting);
      async.elapse(const Duration(seconds: 2));
      expect(harnessActivity(app, 'm', 'a6'), HarnessActivity.idle);
      app.dispose();
    });
  });

  test(
    'another conversation\'s late turn frame does not end the wait',
    () async {
      final app = createApp(connected: true);
      addTearDown(app.dispose);
      final machine = app.machineStates['m']!;
      machine.agents = [
        for (final agent in machine.agents)
          if (agent.id != 'a7') agent,
        Agent(
          id: 'a7',
          name: 'Agent 7',
          engine: 'codex',
          terminalAvailable: true,
          sessionId: 'now',
        ),
      ];
      await app.handleEventForTest('m', waiting('a7'));
      await app.handleEventForTest('m', {
        'type': 'turn_ended',
        'agentId': 'a7',
        'dbSessionId': 'before',
        'payload': <String, dynamic>{},
      });
      expect(harnessActivity(app, 'm', 'a7'), HarnessActivity.starting);
    },
  );

  test('another reason to wait is not a start', () async {
    final app = createApp(connected: true);
    addTearDown(app.dispose);
    await app.handleEventForTest('m', {
      ...waiting('a5'),
      'payload': {'reason': 'busy'},
    });
    expect(harnessActivity(app, 'm', 'a5'), HarnessActivity.idle);
  });
}
