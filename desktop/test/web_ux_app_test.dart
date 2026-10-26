// The web UX review fixture's fake account: it must show the states it is
// seeded with and never wait on a backend.

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/sign_in_provider.dart';
import 'package:harness/core/models.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/terminal/terminal_session.dart';

import 'support/web_ux_app.dart';

const _agent = Agent(
  id: 'a1',
  name: 'Fix checkout flow',
  engine: 'claude',
  terminalAvailable: true,
);

void main() {
  test('a sign-in waits on screen without reaching a backend', () async {
    final app = WebUxApp()..status = AppStatus.unauthenticated;
    addTearDown(app.dispose);

    await app.login(SignInProvider.google);

    expect(app.status, AppStatus.bootstrapping);
    expect(app.signingIn, isTrue);
  });

  test('a machine is listed in the connection state it was seeded with', () {
    final app = WebUxApp();
    addTearDown(app.dispose);

    app.addMachine(
      'm1',
      'Studio Mac',
      status: ConnectionStatus.reconnecting,
      needsLink: true,
      agents: const [_agent],
    );

    expect(app.machines.single.displayName, 'Studio Mac');
    final state = app.stateOf('m1')!;
    expect(state.connectionStatus, ConnectionStatus.reconnecting);
    expect(state.needsLink, isTrue);
    expect(state.agentLoadStatus, AgentLoadStatus.needsLink);
    expect(state.agents.single.id, 'a1');
  });

  test('a terminal opens as the focused pane showing its screen', () {
    final app = WebUxApp()..addMachine('m1', 'Studio Mac');
    addTearDown(app.dispose);

    final session = app.openTerminal(
      'm1',
      _agent,
      screen: 'hello from the fixture',
      status: TerminalSessionStatus.takenOver,
      readOnly: true,
    );

    expect(app.focusedPane?.session, same(session));
    expect(session.status, TerminalSessionStatus.takenOver);
    expect(session.readOnly, isTrue);
    expect(
      session.terminal.buffer.lines[0].toString(),
      startsWith('hello from the fixture'),
    );
  });

  test('a seeded error and expired session read as the real ones do', () {
    final app = WebUxApp()
      ..error = 'Could not start Claude Code.'
      ..expired = true;
    addTearDown(app.dispose);

    expect(app.lastError, 'Could not start Claude Code.');
    expect(app.sessionExpired, isTrue);
  });

  /// The rows of [session]'s screen, as drawn.
  List<String> rows(TerminalSession session) => [
    for (final line in session.terminal.buffer.lines.toList())
      line.toString().trimRight(),
  ];

  test(
    'a resize redraws the screen at the new width, as a daemon does',
    () async {
      final app = WebUxApp()..addMachine('m1', 'Studio Mac');
      addTearDown(app.dispose);
      final session = app.openTerminal(
        'm1',
        _agent,
        screen: '${'x' * 60}\r\nend',
      );

      // A phone's pane: narrower than the 80 columns the screen was written at.
      session.terminal.resize(30, 10);
      await pumpEventQueue();

      expect(rows(session).take(3), ['x' * 30, 'x' * 30, 'end']);
    },
  );

  test('a view-only terminal keeps the grid another app drew', () async {
    final app = WebUxApp()..addMachine('m1', 'Studio Mac');
    addTearDown(app.dispose);
    final session = app.openTerminal(
      'm1',
      _agent,
      screen: '${'x' * 60}\r\nend',
      readOnly: true,
    );

    session.terminal.resize(30, 10);
    await pumpEventQueue();

    // No input, so no resize reaches the computer: the grid is clipped.
    expect(rows(session).take(2), ['x' * 30, 'end']);
  });
}
