import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/terminal/terminal_binary.dart';
import 'package:harness/terminal/terminal_session.dart';
import 'package:harness/widgets/pane_grid.dart';
import 'package:harness/widgets/terminal_panel.dart';
import 'package:xterm/xterm.dart';

import 'swarm_screen_test.dart' show terminal;
import 'swarm_state_test.dart' show createApp;

/// What a pane offers when its harness did not come up — and, for the one case
/// where the engine is in fact still running, what it offers INSTEAD of
/// pretending the start failed.
void main() {
  late AppNotifier app;
  late List<TerminalBinaryFrame> input;
  late TerminalSession session;

  setUp(() {
    app = createApp();
    app.stateOf('m')!
      ..nodeOnline = true
      ..terminalCapabilityAvailable = true;
    input = [];
    session = terminal('a0', input);
    app.adoptSessionForTest(session);
  });

  tearDown(() => app.dispose());

  /// Through the daemon's own push, so the window-band rule in `_upsertAgent`
  /// is exercised rather than stepped over.
  Future<void> agentWith({String? launchError, String state = 'failed'}) =>
      app.handleEventForTest('m', {
        'type': 'agent_synced',
        'payload': {
          'agent': {
            'id': 'a0',
            'name': 'Session a0',
            'engine': 'codex',
            'terminal': {'available': true},
            'launch': {
              'state': state,
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
    await agentWith(launchError: 'RESUME_UNCONFIRMED');
    await pump(tester);
    expect(find.text('Not confirmed'), findsWidgets);
    expect(find.textContaining('Answer setup prompts below'), findsWidgets);
    expect(find.widgetWithText(FilledButton, 'Check again'), findsOneWidget);
    expect(find.text('Start failed'), findsNothing);
    await tester.pumpWidget(const SizedBox());
  });

  for (final state in ['starting', 'RESUME_UNCONFIRMED', 'LAUNCH_TIMEOUT']) {
    testWidgets(
      '$state keeps setup prompts visible and accepts keyboard input',
      (tester) async {
        await agentWith(
          state: state == 'starting' ? 'starting' : 'failed',
          launchError: state,
        );
        session.terminal.write('[oh-my-zsh] Would you like to update? [Y/n] ');
        await pump(tester);
        final panel = tester.widget<TerminalPanel>(find.byType(TerminalPanel));
        expect(panel.readOnly, isFalse);
        expect(session.acceptsInput, isTrue);
        expect(
          tester.getTopLeft(find.byType(TerminalView)).dy,
          greaterThan(
            tester
                .getBottomLeft(
                  find
                      .textContaining(
                        state == 'starting'
                            ? 'You can answer setup prompts'
                            : state == 'RESUME_UNCONFIRMED'
                            ? 'Answer setup prompts below'
                            : 'The daemon said so.',
                      )
                      .last,
                )
                .dy,
          ),
        );
        await tester.tap(find.byType(TerminalView));
        await tester.pump();
        expect(session.acceptsInput, isTrue, reason: '${session.status}');
        expect(
          tester.widget<TerminalView>(find.byType(TerminalView)).readOnly,
          isFalse,
        );
        expect(
          tester
              .widget<TerminalView>(find.byType(TerminalView))
              .focusNode!
              .hasFocus,
          isTrue,
        );
        tester.testTextInput.enterText('y');
        // setUp constructs the session outside the widget fake-async zone.
        // Let its ordered transport tail complete in that same zone.
        await tester.runAsync(() async {});
        await tester.pump(const Duration(milliseconds: 20));
        expect(utf8.decode(input.expand((frame) => frame.bytes).toList()), 'y');
        await agentWith(state: 'ready');
        await tester.pump();
        expect(
          tester.widget<TerminalPanel>(find.byType(TerminalPanel)).notice,
          isNull,
        );
        expect(app.panes.single.session, same(session));
        await tester.pump(const Duration(milliseconds: 400));
        await tester.pumpWidget(const SizedBox());
      },
    );
  }

  testWidgets('an offline startup still keeps its terminal read only', (
    tester,
  ) async {
    await agentWith(state: 'starting');
    app.stateOf('m')!.nodeOnline = false;
    await pump(tester);
    expect(
      tester.widget<TerminalPanel>(find.byType(TerminalPanel)).readOnly,
      isTrue,
    );
    expect(input, isEmpty);
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
