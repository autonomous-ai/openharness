import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/core/models.dart';
import 'package:harness_mobile/phone/phone_shell.dart';
import 'package:harness_mobile/phone/phone_shell_scope.dart';
import 'package:harness_mobile/phone/terminal_page.dart';
import 'package:harness_mobile/state/app_state.dart';
import 'package:harness_mobile/terminal/terminal_session.dart';

import 'devices_fixture.dart';

/// An agent opened from anywhere is the root page: there is no page under it, so its header draws
/// no back chevron.
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
  });
  tearDown(() => app.dispose());

  Future<void> frames(WidgetTester tester) async {
    for (var i = 0; i < 8; i++) {
      await tester.pump(const Duration(milliseconds: 150));
    }
  }

  testWidgets(
    'the terminal has no chevron: nothing is behind it',
    (tester) async {
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
