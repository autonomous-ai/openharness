import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/widgets/pane_grid.dart';

import 'swarm_screen_test.dart' show terminal;
import 'swarm_state_test.dart' show createApp;

/// What a pane offers when its harness did not come up — and, for the one case
/// where the engine is in fact still running, what it offers INSTEAD of
/// pretending the start failed.
void main() {
  late AppNotifier app;

  setUp(() {
    app = createApp();
    app.stateOf('m')!
      ..nodeOnline = true
      ..terminalCapabilityAvailable = true;
    app.adoptSessionForTest(terminal('a0', []));
  });

  tearDown(() => app.dispose());

  /// Through the daemon's own push, so the window-band rule in `_upsertAgent`
  /// is exercised rather than stepped over.
  Future<void> agentWith({required String launchError}) =>
      app.handleEventForTest('m', {
        'type': 'agent_synced',
        'payload': {
          'agent': {
            'id': 'a0',
            'name': 'Session a0',
            'engine': 'codex',
            'terminal': {'available': true},
            'launch': {
              'state': 'failed',
              'error': launchError,
              'detail': 'The daemon said so.',
            },
          },
        },
      });

  Future<void> pump(WidgetTester tester) async {
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: ListenableBuilder(
            listenable: app,
            builder: (_, _) => PaneGrid(notifier: app, swarmMode: false),
          ),
        ),
      ),
    );
    await tester.pump();
  }

  testWidgets('a resume the daemon could not confirm offers Check again', (
    tester,
  ) async {
    // The engine is usually still running in the pane — output keeps arriving
    // while the keyboard is locked — so the pane says that and offers the cheap
    // question, not a relaunch.
    await agentWith(launchError: 'RESUME_UNCONFIRMED');
    await pump(tester);
    expect(find.text('Not confirmed'), findsWidgets);
    expect(find.textContaining('still running here'), findsWidgets);
    expect(find.widgetWithText(FilledButton, 'Check again'), findsOneWidget);
    expect(find.text('Start failed'), findsNothing);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('a launch that really failed offers Restart, with its reason', (
    tester,
  ) async {
    await agentWith(launchError: 'ENGINE_MISSING');
    await pump(tester);
    expect(find.text('Start failed'), findsWidgets);
    expect(find.textContaining('The daemon said so.'), findsWidgets);
    expect(find.widgetWithText(FilledButton, 'Restart'), findsOneWidget);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('a harness whose pane says it keeps the window band quiet', (
    tester,
  ) async {
    // The push reaches every client watching the machine. One that is looking
    // at the pane is already told; a window-wide band would be a second copy of
    // the same sentence, addressed to people who pressed nothing.
    expect(app.lastError, isNull);
    await agentWith(launchError: 'RESUME_UNCONFIRMED');
    await pump(tester);
    expect(app.lastError, isNull);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('a harness with no pane still raises the window band', (
    tester,
  ) async {
    await app.closePane(app.panes.single.id);
    await agentWith(launchError: 'ENGINE_MISSING');
    expect(app.lastError, 'The daemon said so.');
  });
}
