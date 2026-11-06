import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/state/app_state.dart';
import 'package:harness/super_tabs/buddy_restart.dart' show launchArgsLine;
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/view.dart';
import 'package:harness/ws/ws_conn.dart';

import 'support/buddy_fixture.dart';
import 'support/restart_connection.dart';
import 'support/super_tab_fixture.dart';
import 'swarm_state_test.dart' show createApp;

/// "Restart Buddy…" in the Buddy chat's menu (spec 2026-11-06-buddy-launch-flags).
void main() {
  late RestartConnection connection;
  late AppNotifier app;

  setUp(() {
    connection = RestartConnection();
    app = createApp(connected: true, connectionForTest: (_) => connection);
    app.stateOf('m')!.agents = [
      const Agent(
        id: 'h-wren',
        name: 'Wren',
        engine: 'claude',
        terminalAvailable: true,
        launchArgs: ['--chrome'],
      ),
    ];
  });
  tearDown(() => app.dispose());

  Future<SuperTabController> show(
    WidgetTester tester,
    ConversationServer server,
  ) async {
    await tester.binding.setSurfaceSize(const Size(1280, 800));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final c = server.controller(account: 'peer');
    await c.refresh();
    await tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(),
        home: Scaffold(
          body: SuperTabView(
            controller: c,
            app: app,
            onInvite: () {},
            onAddAgent: (_) {},
            onOpenTerminal: (_) {},
            machineName: (_) => 'Team Mac',
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    return c;
  }

  Future<void> close(WidgetTester tester, SuperTabController c) async {
    await tester.pumpWidget(const SizedBox());
    await c.flush();
    c.dispose();
  }

  final buddyEntry = find.byKey(const ValueKey('super-buddy-lead'));
  final field = find.byKey(const ValueKey('super-buddy-launch-args'));
  final error = find.byKey(const ValueKey('super-buddy-launch-args-error'));
  final restart = find.widgetWithText(FilledButton, 'Restart');

  ConversationServer swarm() {
    final server = buddySwarm();
    giveBuddy(server, machineId: 'm');
    return server;
  }

  Future<void> openMenu(WidgetTester tester) async {
    await tester.tap(buddyEntry);
    await tester.pumpAndSettle();
    await tester.tap(find.byTooltip('Buddy options'));
    await tester.pumpAndSettle();
  }

  Future<void> openDialog(WidgetTester tester) async {
    await openMenu(tester);
    await tester.tap(find.text('Restart Buddy…'));
    await tester.pumpAndSettle();
  }

  String creationId() => connection.requests.last['creationId'] as String;

  testWidgets("the menu has Restart Buddy… on the reader's own Buddy chat", (
    tester,
  ) async {
    final c = await show(tester, swarm());
    await openMenu(tester);
    expect(find.text('Restart Buddy…'), findsOneWidget);
    await close(tester, c);
  });

  testWidgets('the menu has none on a workgroup chat', (tester) async {
    final server = swarm();
    (server.state['conversations'] as List).add({
      ...conversationFixture('side-work', 'Side work'),
      'projectId': 'lead',
    });
    final c = await show(tester, server);
    await c.select('side-work');
    await tester.pumpAndSettle();
    await tester.tap(find.byTooltip('Workgroup options'));
    await tester.pumpAndSettle();
    expect(find.text('Restart Buddy…'), findsNothing);
    await close(tester, c);
  });

  testWidgets('the menu has none on a Buddy chat whose Buddy is gone', (
    tester,
  ) async {
    // The chat is there, the Buddy is not: an older project chat, read only.
    final server = swarm();
    (server.state['agents'] as List).clear();
    final c = await show(tester, server);
    await openMenu(tester);
    expect(find.text('Rename Buddy…'), findsOneWidget);
    expect(find.text('Restart Buddy…'), findsNothing);
    await close(tester, c);
  });

  testWidgets('the dialog prefills the saved flags and says where they apply', (
    tester,
  ) async {
    final c = await show(tester, swarm());
    await openDialog(tester);
    expect(find.text('Restart Buddy'), findsOneWidget);
    expect(find.text('Extra launch flags'), findsOneWidget);
    expect(tester.widget<TextField>(field).controller!.text, '--chrome');
    expect(
      find.text(
        "Added to Claude Code's command line each time this Buddy starts on "
        'Test host. Your Buddy runs with full permissions. Clear the field to '
        'remove them.',
      ),
      findsOneWidget,
    );
    await close(tester, c);
  });

  testWidgets('Restart sends the flags and the dialog closes on success', (
    tester,
  ) async {
    final c = await show(tester, swarm());
    await openDialog(tester);
    await tester.enterText(field, '--chrome --x');
    await tester.tap(restart);
    await tester.pump();
    expect(connection.requests.single['agentId'], 'h-wren');
    expect(connection.requests.single['launchArgs'], '--chrome --x');
    // Busy: the field is read-only and the button shows progress.
    expect(tester.widget<TextField>(field).readOnly, isTrue);
    expect(find.byType(CircularProgressIndicator), findsOneWidget);
    connection.restartReplies.single.complete({
      ...restartReceipt(creationId(), agentId: 'h-wren'),
      'launchArgs': ['--chrome', '--x'],
    });
    await tester.pumpAndSettle();
    expect(find.text('Restart Buddy'), findsNothing);
    await close(tester, c);
  });

  testWidgets('Enter in the field restarts', (tester) async {
    final c = await show(tester, swarm());
    await openDialog(tester);
    await tester.testTextInput.receiveAction(TextInputAction.done);
    await tester.pump();
    expect(connection.requests.single['launchArgs'], '--chrome');
    connection.restartReplies.single.complete({
      ...restartReceipt(creationId(), agentId: 'h-wren'),
      'launchArgs': ['--chrome'],
    });
    await tester.pumpAndSettle();
    expect(find.text('Restart Buddy'), findsNothing);
    await close(tester, c);
  });

  testWidgets("a refusal shows the daemon's words and keeps the dialog", (
    tester,
  ) async {
    final c = await show(tester, swarm());
    await openDialog(tester);
    await tester.enterText(field, '--model x');
    await tester.tap(restart);
    await tester.pump();
    connection.restartReplies.single.completeError(
      const WsRequestFailure(
        responseType: 'agent_restart_result',
        code: 'INVALID_LAUNCH_ARGS',
        detail: "--model is set by Harness and can't be added here.",
      ),
    );
    await tester.pumpAndSettle();
    expect(
      tester.widget<Text>(error).data,
      "--model is set by Harness and can't be added here.",
    );
    expect(find.text('Restart Buddy'), findsOneWidget);
    expect(tester.widget<TextField>(field).readOnly, isFalse);
    await close(tester, c);
  });

  testWidgets('an engine that did not start says to fix or clear the flags', (
    tester,
  ) async {
    final c = await show(tester, swarm());
    await openDialog(tester);
    await tester.tap(restart);
    await tester.pump();
    connection.restartReplies.single.complete({
      'creationId': creationId(),
      'state': 'failed',
      'failure': {'code': 'RESUME_FAILED'},
    });
    await tester.pumpAndSettle();
    expect(
      tester.widget<Text>(error).data,
      "The Buddy didn't start with these flags. Fix or clear them and restart.",
    );
    expect(find.text('Restart Buddy'), findsOneWidget);
    await close(tester, c);
  });

  testWidgets('a reply with no echo says to update Harness on the machine', (
    tester,
  ) async {
    final c = await show(tester, swarm());
    await openDialog(tester);
    await tester.tap(restart);
    await tester.pump();
    connection.restartReplies.single.complete(
      restartReceipt(creationId(), agentId: 'h-wren'),
    );
    await tester.pumpAndSettle();
    expect(
      tester.widget<Text>(error).data,
      'Update Harness on Test host to use launch flags.',
    );
    expect(find.text('Restart Buddy'), findsOneWidget);
    await close(tester, c);
  });

  testWidgets('an empty field with nothing saved is a plain restart', (
    tester,
  ) async {
    app.stateOf('m')!.agents = [
      const Agent(id: 'h-wren', name: 'Wren', engine: 'claude'),
    ];
    final c = await show(tester, swarm());
    await openDialog(tester);
    await tester.tap(restart);
    await tester.pump();
    expect(connection.requests.single.containsKey('launchArgs'), isFalse);
    connection.restartReplies.single.complete(
      restartReceipt(creationId(), agentId: 'h-wren'),
    );
    await tester.pumpAndSettle();
    expect(find.text('Restart Buddy'), findsNothing);
    await close(tester, c);
  });

  test('words with spaces or quotes are quoted so they read back whole', () {
    expect(launchArgsLine(['--chrome']), '--chrome');
    expect(
      launchArgsLine(['--add-dir', '/a b', "it's", '']),
      "--add-dir '/a b' 'it'\\''s' ''",
    );
  });
}
