// The Take control band where the host hides key hints (the web,
// WorkspaceChrome.showsKeyHints false; audit finding S8): it names the click,
// not a key a touch screen does not have. Desktop keeps its ⏎.

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_icons.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/state/workspace_chrome.dart';
import 'package:harness/terminal/terminal_session.dart';
import 'package:harness/web/shell/web_chrome.dart';
import 'package:harness/widgets/terminal_panel.dart';

import 'swarm_state_test.dart' show createApp;

final _button = find.widgetWithText(FilledButton, 'Take control');

Future<(AppNotifier, TerminalSession)> _takenOver(
  WidgetTester tester, {
  required bool web,
}) async {
  final app = createApp();
  app.stateOf('m')!
    ..nodeOnline = true
    ..terminalCapabilityAvailable = true;
  final session =
      TerminalSession(
          machineId: 'm',
          agentId: 'a0',
          agentName: 'Session a0',
          engineId: 'codex',
          send: (_, _) async => true,
          sendBinary: (_) async => true,
        )
        ..status = TerminalSessionStatus.controlling
        ..streamId = 'stream-a0';
  app.adoptSessionForTest(session);
  final panel = TerminalPanel(
    notifier: app,
    session: session,
    focused: true,
    onToggleComposer: () {},
  );
  await tester.pumpWidget(
    MaterialApp(
      home: Scaffold(
        body: SizedBox(
          width: 900,
          height: 400,
          child: web
              ? WorkspaceChromeScope(
                  chrome: webWorkspaceChrome(app),
                  child: panel,
                )
              : panel,
        ),
      ),
    ),
  );
  await tester.pump();
  session.handleFrame('terminal_closed', {
    'streamId': 'stream-a0',
    'code': 'TERMINAL_TAKEN_OVER',
    'reason': 'Another client connected to this terminal.',
  });
  await tester.pump();
  return (app, session);
}

Future<void> _finish(WidgetTester tester, AppNotifier app) async {
  await tester.pump(const Duration(milliseconds: 500));
  await tester.pumpWidget(const SizedBox());
  app.dispose();
}

void main() {
  testWidgets('on the web the band asks for a click and draws no key', (
    tester,
  ) async {
    final (app, _) = await _takenOver(tester, web: true);

    expect(
      find.text('Typing is paused. Click here to take control.'),
      findsOneWidget,
    );
    expect(find.textContaining('⏎'), findsNothing);
    expect(
      find.descendant(
        of: _button,
        matching: find.byIcon(AppIcons.cornerDownLeft),
      ),
      findsNothing,
    );
    await _finish(tester, app);
  });

  testWidgets('on the web a stray key is answered without naming a key', (
    tester,
  ) async {
    final (app, _) = await _takenOver(tester, web: true);

    await tester.sendKeyEvent(LogicalKeyboardKey.keyA);
    await tester.pump();

    expect(
      find.text('Keys are ignored — click here to take control.'),
      findsOneWidget,
    );
    expect(find.textContaining('⏎'), findsNothing);
    await _finish(tester, app);
  });

  testWidgets('Desktop keeps ⏎ on the band and on its button', (tester) async {
    final (app, _) = await _takenOver(tester, web: false);

    expect(
      find.text('Typing is paused. Click here or press ⏎ to take control.'),
      findsOneWidget,
    );
    expect(
      find.descendant(
        of: _button,
        matching: find.byIcon(AppIcons.cornerDownLeft),
      ),
      findsOneWidget,
    );
    await _finish(tester, app);
  });
}
