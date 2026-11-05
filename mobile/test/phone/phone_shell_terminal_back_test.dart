import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/core/models.dart';
import 'package:harness_mobile/phone/phone_shell.dart';
import 'package:harness_mobile/phone/phone_shell_scope.dart';
import 'package:harness_mobile/phone/terminal_page.dart';
import 'package:harness_mobile/settings/experimental_features.dart';
import 'package:harness_mobile/state/app_state.dart';
import 'package:harness_mobile/swarm/swarm_page.dart';
import 'package:harness_mobile/terminal/terminal_session.dart';

import 'devices_fixture.dart';

/// From Swarm to an agent's terminal and back, the way an iPhone does it: no system back event.
///
/// Opening an agent makes its terminal the root page, so there is no page under it and iOS has no
/// back button of its own. The header's chevron is the way back.
void main() {
  late DevicesApp app;

  setUp(() {
    app = DevicesApp()
      ..currentUser = const CurrentUserProfile(
        id: 'person-me',
        email: 'me@example.com',
      );
    const machine = Machine(
      machineId: 'm',
      authMode: MachineAuthMode.remote,
      name: 'Test host',
    );
    app.machines = [machine];
    app.machineStates['m'] = MachineState(machine)
      ..nodeOnline = true
      ..connectionStatus = ConnectionStatus.connected
      ..agentLoadStatus = AgentLoadStatus.loaded
      ..agents = [
        const Agent(
          id: 'a',
          name: 'builder',
          engine: 'claude',
          project: AgentProject(name: 'grid', cwd: '/src/grid'),
          terminalAvailable: true,
        ),
      ];
    final session = TerminalSession(
      machineId: 'm',
      agentId: 'a',
      agentName: 'builder',
      engineId: 'claude',
      send: (type, payload) async => true,
      sendBinary: (_) async => true,
    )..status = TerminalSessionStatus.controlling;
    session.streamId = 's';
    app.adoptSessionForTest(session);
    experimentalFeaturesStore.value = {PhoneExperiment.swarm};
  });
  tearDown(() {
    experimentalFeaturesStore.value = const {};
    app.dispose();
  });

  Future<void> frames(WidgetTester tester) async {
    for (var i = 0; i < 8; i++) {
      await tester.pump(const Duration(milliseconds: 150));
    }
  }

  testWidgets('an agent opened from Swarm, then the header chevron: Swarm '
      'Home again, with no system back', (tester) async {
    await tester.pumpWidget(MaterialApp(home: PhoneShell(notifier: app)));
    await frames(tester);
    expect(find.byType(SwarmPage), findsOneWidget);

    PhoneShellScope.maybeOf(tester.element(find.byType(SwarmPage)))!
        .onOpenAgent('m', 'a');
    await frames(tester);
    expect(find.byType(TerminalPage), findsOneWidget);
    expect(find.byType(SwarmPage), findsNothing);

    await tester.tap(find.byKey(const ValueKey('tty-back')));
    await frames(tester);

    expect(find.byType(SwarmPage), findsOneWidget);
    expect(find.byType(TerminalPage), findsNothing);

    await tester.pumpWidget(const SizedBox());
    await tester.pump(const Duration(seconds: 1));
  });

  testWidgets(
    'with Swarm off, the terminal has no chevron: nothing is behind it',
    (tester) async {
      experimentalFeaturesStore.value = const {};
      await tester.pumpWidget(MaterialApp(home: PhoneShell(notifier: app)));
      await frames(tester);
      tester
          .widget<PhoneShellScope>(find.byType(PhoneShellScope))
          .onOpenAgent('m', 'a');
      await frames(tester);

      expect(find.byType(TerminalPage), findsOneWidget);
      expect(find.byKey(const ValueKey('tty-back')), findsNothing);

      await tester.pumpWidget(const SizedBox());
      await tester.pump(const Duration(seconds: 1));
    },
  );
}
