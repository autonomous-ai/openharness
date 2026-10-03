import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/auth/auth_session.dart';
import 'package:harness_mobile/core/config.dart';
import 'package:harness_mobile/core/models.dart';
import 'package:harness_mobile/state/app_state.dart';
import 'package:harness_mobile/widgets/rename_agent_dialog.dart';
import 'package:harness_mobile/ws/ws_conn.dart';

/// The machine the agent runs on. Every `agent_update` waits on a completer the
/// test settles, so an answer can be made to land wherever the test needs it —
/// after a refusal, or in the middle of the dialog closing.
class _Conn extends WsConn {
  _Conn()
    : super(
        wsBaseUrl: 'ws://fixture.invalid',
        autonomousEnv: 'test',
        machineId: 'm',
        accessTokenProvider: (_, _) async => '',
        onAuthFailure: (_) {},
        onEvent: (_) {},
        onStatus: (_) {},
      );

  final updates =
      <
        ({Map<String, dynamic> payload, Completer<Map<String, dynamic>> reply})
      >[];

  @override
  Future<Map<String, dynamic>> request(
    String type, {
    Map<String, dynamic> payload = const {},
    Duration timeout = const Duration(seconds: 20),
  }) {
    if (type != 'agent_update') return Future.value(const {});
    final reply = Completer<Map<String, dynamic>>();
    updates.add((payload: payload, reply: reply));
    return reply.future;
  }
}

void main() {
  late _Conn conn;
  late AppNotifier app;

  setUp(() {
    conn = _Conn();
    app = AppNotifier(
      config: AppConfig.dev,
      authSession: AuthSession(),
      configStore: null,
      connectionForTest: (_) => conn,
    );
    const studio = Machine(
      machineId: 'm',
      authMode: MachineAuthMode.remote,
      name: 'Studio',
    );
    app.machines = [studio];
    app.machineStates['m'] = MachineState(studio)
      ..agents = [
        const Agent(
          id: 'a',
          name: 'Fix login',
          engine: 'claude',
          project: AgentProject(name: 'harness', cwd: '/code/harness'),
        ),
      ];
  });

  tearDown(() => app.dispose());

  /// The phone's terminal page, as a route of its own over a home — the way
  /// the `⋯` sheet opens the dialog — so a dialog that pops one route too many
  /// is caught taking the page with it.
  Future<void> openOverPage(WidgetTester tester, {String? agentId}) async {
    await tester.pumpWidget(
      MaterialApp(
        home: Builder(
          builder: (context) => Scaffold(
            body: TextButton(
              onPressed: () => Navigator.of(context).push(
                MaterialPageRoute<void>(
                  builder: (context) => Scaffold(
                    body: Center(
                      child: TextButton(
                        onPressed: () => showAgentRenameDialog(
                          context,
                          app,
                          'm',
                          agentId ?? 'a',
                          'Fix login',
                        ),
                        child: const Text('Rename…'),
                      ),
                    ),
                  ),
                ),
              ),
              child: const Text('Open terminal'),
            ),
          ),
        ),
      ),
    );
    await tester.tap(find.text('Open terminal'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Rename…'));
    await tester.pumpAndSettle();
  }

  FilledButton save(WidgetTester tester) =>
      tester.widget<FilledButton>(find.widgetWithText(FilledButton, 'Save'));

  testWidgets('opens on the name, selected, with where the agent runs', (
    tester,
  ) async {
    await openOverPage(tester);
    expect(find.text('Rename Harness'), findsOneWidget);
    expect(find.text('Studio · harness'), findsOneWidget);
    final field = tester.widget<TextField>(find.byType(TextField));
    expect(
      field.controller!.selection.textInside(field.controller!.text),
      'Fix login',
    );
    // With the keyboard already up on it, so the first key replaces the name —
    // the veil's own Escape handler once took this focus for itself.
    expect(field.focusNode!.hasPrimaryFocus, isTrue);
    expect(tester.testTextInput.hasAnyClients, isTrue);
    // The same name back is no rename at all.
    expect(save(tester).onPressed, isNull);
  });

  testWidgets('an agent missing from its machine names the machine alone', (
    tester,
  ) async {
    await openOverPage(tester, agentId: 'gone');
    expect(find.text('Studio'), findsOneWidget);
    expect(find.byKey(const ValueKey('engine-icon-claude')), findsNothing);
  });

  testWidgets('Save sends the trimmed name and closes on the answer', (
    tester,
  ) async {
    await openOverPage(tester);
    await tester.enterText(find.byType(TextField), '  Fix the login  ');
    await tester.pump();
    await tester.tap(find.text('Save'));
    await tester.pump();
    expect(conn.updates.single.payload, {
      'agentId': 'a',
      'name': 'Fix the login',
    });
    // Taken, not refused: the button spins at full colour and the field holds.
    expect(find.bySemanticsLabel('Saving'), findsOneWidget);
    expect(tester.widget<TextField>(find.byType(TextField)).readOnly, isTrue);

    conn.updates.single.reply.complete(const {});
    await tester.pumpAndSettle();
    expect(find.text('Rename Harness'), findsNothing);
    expect(find.text('Rename…'), findsOneWidget, reason: 'the page stays');
    expect(app.machineStates['m']!.agents.single.name, 'Fix the login');
  });

  testWidgets('a refusal stays under the field until the name is edited', (
    tester,
  ) async {
    await openOverPage(tester);
    await tester.enterText(find.byType(TextField), 'taken');
    await tester.pump();
    await tester.tap(find.text('Save'));
    await tester.pump();
    conn.updates.single.reply.complete(const {'error': 'NAME_TAKEN'});
    await tester.pumpAndSettle();

    expect(find.text('Rename failed: NAME_TAKEN'), findsOneWidget);
    expect(find.text('Rename Harness'), findsOneWidget);
    expect(tester.widget<TextField>(find.byType(TextField)).readOnly, isFalse);

    // Moving the caret is not an edit: the refusal still stands.
    final field = tester.widget<TextField>(find.byType(TextField));
    field.controller!.selection = const TextSelection.collapsed(offset: 1);
    await tester.pump();
    expect(find.text('Rename failed: NAME_TAKEN'), findsOneWidget);

    await tester.enterText(find.byType(TextField), 'taken 2');
    await tester.pump();
    expect(find.text('Rename failed: NAME_TAKEN'), findsNothing);
  });

  testWidgets('Enter on an empty name is refused on the spot', (tester) async {
    await openOverPage(tester);
    await tester.tap(find.byTooltip('Clear'));
    await tester.pump();
    expect(
      tester.widget<TextField>(find.byType(TextField)).controller!.text,
      isEmpty,
    );
    expect(save(tester).onPressed, isNull);

    await tester.testTextInput.receiveAction(TextInputAction.done);
    await tester.pumpAndSettle();
    expect(find.text('Name cannot be empty'), findsOneWidget);
    expect(conn.updates, isEmpty, reason: 'no round trip for a blank name');
  });

  testWidgets('Enter on the name it already has just closes', (tester) async {
    await openOverPage(tester);
    await tester.testTextInput.receiveAction(TextInputAction.done);
    await tester.pumpAndSettle();
    expect(find.text('Rename Harness'), findsNothing);
    expect(conn.updates, isEmpty);
    expect(find.text('Rename…'), findsOneWidget);
  });

  testWidgets('Cancel and Escape close it without a word to the machine', (
    tester,
  ) async {
    await openOverPage(tester);
    await tester.tap(find.text('Cancel'));
    await tester.pumpAndSettle();
    expect(find.text('Rename Harness'), findsNothing);

    await tester.tap(find.text('Rename…'));
    await tester.pumpAndSettle();
    await tester.sendKeyEvent(LogicalKeyboardKey.escape);
    await tester.pumpAndSettle();
    expect(find.text('Rename Harness'), findsNothing);
    expect(find.text('Rename…'), findsOneWidget);
    expect(conn.updates, isEmpty);
  });

  testWidgets('an answer landing while the dialog is already closing does '
      'not take the page under it too', (tester) async {
    await openOverPage(tester);
    await tester.enterText(find.byType(TextField), 'Fix the login');
    await tester.pump();
    await tester.tap(find.text('Save'));
    await tester.pump();

    // Nobody waits on a slow relay: they close the dialog themselves…
    await tester.tap(find.text('Cancel'));
    await tester.pump();
    // …and the machine answers while it is still fading out.
    conn.updates.single.reply.complete(const {});
    await tester.pump();
    await tester.pumpAndSettle();

    expect(find.text('Rename Harness'), findsNothing);
    expect(
      find.text('Rename…'),
      findsOneWidget,
      reason: 'the terminal page the dialog was opened over is still there',
    );
  });
}
