// An agent's named state (OpenClaw engine spec, decision 5) on its pane: the daemon's sentence
// under the header while it holds, gone once the daemon pushes the agent without it.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/terminal/terminal_session.dart';
import 'package:harness/widgets/terminal_panel.dart';

import 'support/real_fonts.dart';
import 'swarm_state_test.dart' show createApp;

const _noGateway =
    'OpenClaw Gateway is not running. Start it with openclaw gateway.';

Map<String, Object?> _frame({String? namedState}) => {
  'id': 'agent-1',
  'name': 'Gateway check',
  'engine': 'openclaw',
  'terminal': {'available': true},
  'namedState': ?namedState,
};

void main() {
  setUpAll(loadRealFonts);

  testWidgets('a named state shows under the header and clears with the hold', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(1200, 800);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    final app = createApp();
    addTearDown(app.dispose);
    app.machineStates['m']!.agents = [
      Agent.fromJson(_frame(namedState: _noGateway)),
    ];
    final session =
        TerminalSession(
            machineId: 'm',
            agentId: 'agent-1',
            agentName: 'Gateway check',
            engineId: 'openclaw',
            send: (_, _) async => true,
            sendBinary: (_) async => true,
          )
          ..status = TerminalSessionStatus.controlling
          ..streamId = 'stream-1';
    addTearDown(session.dispose);
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: SizedBox(
            width: 900,
            height: 320,
            // Rebuilt on every change to the app, as the pane grid rebuilds it.
            child: ListenableBuilder(
              listenable: app,
              builder: (context, _) =>
                  TerminalPanel(notifier: app, session: session, focused: true),
            ),
          ),
        ),
      ),
    );
    await tester.pump();
    expect(find.text(_noGateway), findsOneWidget);

    // The Gateway is back: the daemon pushes the agent with no named state.
    await app.handleEventForTest('m', {
      'type': 'agent_synced',
      'payload': {'agent': _frame()},
    });
    await tester.pump();
    expect(find.text(_noGateway), findsNothing);
    // The note gave its line back to the terminal, which tells the machine its new size.
    await tester.pump(const Duration(milliseconds: 100));
  });

  test('an older daemon sends no named state, and the agent has none', () {
    expect(Agent.fromJson(_frame()).namedState, isNull);
    expect(
      Agent.fromJson(_frame(namedState: _noGateway)).namedState,
      _noGateway,
    );
  });
}
