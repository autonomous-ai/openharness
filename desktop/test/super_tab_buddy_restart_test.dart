import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/state/app_state.dart';
import 'package:harness/super_tabs/buddy_restart.dart'
    show
        BuddyRestartOutcome,
        BuddyRestartResult,
        launchArgsLine,
        restartBuddyWithFlags,
        splitLaunchArgs;
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

  testWidgets("the menu has none on someone else's Buddy chat", (tester) async {
    final server = swarm();
    final c = server.controller(account: 'someone-else');
    await c.refresh();
    await tester.binding.setSurfaceSize(const Size(1280, 800));
    addTearDown(() => tester.binding.setSurfaceSize(null));
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
    expect(c.buddy('lead'), isNull);
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

  testWidgets('the menu has none on a Buddy with no agent on a machine', (
    tester,
  ) async {
    final server = swarm();
    for (final agent in server.state['agents'] as List) {
      if ((agent as Map)['buddyOf'] != null) agent['harnessId'] = '';
    }
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
        'Test host. Your Buddy runs with full permissions. Don\'t put secrets '
        'here: other people on that computer can see them. Clear the field to '
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
      'state': 'unconfirmed',
    });
    await tester.pumpAndSettle();
    expect(
      tester.widget<Text>(error).data,
      "The Buddy didn't start with these flags. Fix or clear them and restart.",
    );
    expect(find.text('Restart Buddy'), findsOneWidget);
    await close(tester, c);
  });

  testWidgets('after a bad flag, clearing the field restarts anew', (
    tester,
  ) async {
    final c = await show(tester, swarm());
    await openDialog(tester);
    await tester.enterText(field, '--bad');
    await tester.tap(restart);
    await tester.pump();
    final first = creationId();
    connection.restartReplies.single.complete({
      'creationId': first,
      'state': 'unconfirmed',
    });
    await tester.pumpAndSettle();
    expect(error, findsOneWidget);
    await tester.enterText(field, '');
    await tester.tap(restart);
    await tester.pump();
    expect(connection.checks, isEmpty);
    expect(connection.requests, hasLength(2));
    expect(connection.requests.last['launchArgs'], '');
    expect(creationId(), isNot(first));
    connection.restartReplies.last.complete({
      ...restartReceipt(creationId(), agentId: 'h-wren'),
      'launchArgs': <String>[],
    });
    await tester.pumpAndSettle();
    expect(find.text('Restart Buddy'), findsNothing);
    await close(tester, c);
  });

  testWidgets('a stopped Buddy resumes with the flags', (tester) async {
    app.stateOf('m')!.agents = [
      const Agent(
        id: 'h-wren',
        name: 'Wren',
        engine: 'claude',
        status: 'stopped',
        launchArgs: ['--chrome'],
      ),
    ];
    final c = await show(tester, swarm());
    await openDialog(tester);
    await tester.tap(restart);
    await tester.pump();
    expect(connection.types.single, 'agent_resume');
    expect(connection.requests.single['launchArgs'], '--chrome');
    connection.restartReplies.single.complete({
      ...restartReceipt(creationId(), agentId: 'h-wren'),
      'launchArgs': ['--chrome'],
    });
    await tester.pumpAndSettle();
    expect(find.text('Restart Buddy'), findsNothing);
    await close(tester, c);
  });

  testWidgets('a restart started elsewhere is not the dialog\'s result', (
    tester,
  ) async {
    final c = await show(tester, swarm());
    final other = app.restartAgent('m', 'h-wren');
    await openDialog(tester);
    await tester.tap(restart);
    await tester.pump();
    expect(connection.requests, hasLength(2));
    expect(connection.requests.last['launchArgs'], '--chrome');
    connection.restartReplies.first.complete(
      restartReceipt(
        connection.requests.first['creationId'] as String,
        agentId: 'h-wren',
      ),
    );
    await other;
    await tester.pump();
    expect(find.text('Restart Buddy'), findsOneWidget);
    connection.restartReplies.last.complete({
      ...restartReceipt(creationId(), agentId: 'h-wren'),
      'launchArgs': ['--chrome'],
    });
    await tester.pumpAndSettle();
    expect(find.text('Restart Buddy'), findsNothing);
    await close(tester, c);
  });

  testWidgets('a busy Buddy shows its own failure, not the flags text', (
    tester,
  ) async {
    final c = await show(tester, swarm());
    await openDialog(tester);
    await tester.tap(restart);
    await tester.pump();
    connection.restartReplies.single.completeError(
      const WsRequestFailure(
        responseType: 'agent_restart_result',
        code: 'AGENT_BUSY',
      ),
    );
    await tester.pumpAndSettle();
    final text = tester.widget<Text>(error).data!;
    expect(text, isNot(contains("didn't start")));
    expect(text, isNotEmpty);
    await close(tester, c);
  });

  testWidgets('an offline machine shows the connection failure', (
    tester,
  ) async {
    app.stateOf('m')!.agents = [
      const Agent(
        id: 'h-wren',
        name: 'Wren',
        engine: 'claude',
        status: 'stopped',
      ),
    ];
    app.stateOf('m')!.connectionStatus = ConnectionStatus.disconnected;
    final c = await show(tester, swarm());
    await openDialog(tester);
    await tester.tap(restart);
    await tester.pumpAndSettle();
    final text = tester.widget<Text>(error).data!;
    expect(text, isNot(contains("didn't start")));
    expect(text, contains('not connected'));
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

  group('splitLaunchArgs', () {
    test('splits on whitespace', () {
      expect(splitLaunchArgs('--chrome'), ['--chrome']);
      expect(splitLaunchArgs('  '), <String>[]);
    });

    test('reads quotes and backslash escapes', () {
      expect(splitLaunchArgs('--add-dir "a b" --x=\'y z\' c\\ d'), [
        '--add-dir',
        'a b',
        '--x=y z',
        'c d',
      ]);
    });

    test('an unclosed quote or a trailing backslash is null', () {
      expect(splitLaunchArgs('--x "a'), isNull);
      expect(splitLaunchArgs('a\\'), isNull);
    });

    test('is the inverse of launchArgsLine', () {
      final w = ['--add-dir', 'a b', "it's", r'back\slash'];
      expect(splitLaunchArgs(launchArgsLine(w)), w);
    });
  });

  group('restartBuddyWithFlags', () {
    Future<BuddyRestartResult> run(
      WidgetTester tester,
      SuperTabController c,
      Future<void> Function() reply,
    ) async {
      final result = restartBuddyWithFlags(
        c,
        'lead',
        app,
        text: '--chrome',
        saved: '--chrome',
      );
      await tester.pump();
      await reply();
      await tester.pumpAndSettle();
      return result;
    }

    testWidgets('success is done', (tester) async {
      final c = await show(tester, swarm());
      final result = await run(tester, c, () async {
        connection.restartReplies.single.complete({
          ...restartReceipt(creationId(), agentId: 'h-wren'),
          'launchArgs': ['--chrome'],
        });
      });
      expect(result.outcome, BuddyRestartOutcome.done);
      expect(result.message, isNull);
      await close(tester, c);
    });

    testWidgets('a refusal carries the daemon detail', (tester) async {
      final c = await show(tester, swarm());
      final result = await run(tester, c, () async {
        connection.restartReplies.single.completeError(
          const WsRequestFailure(
            responseType: 'agent_restart_result',
            code: 'INVALID_LAUNCH_ARGS',
            detail: "--model is set by Harness and can't be added here.",
          ),
        );
      });
      final r = result;
      expect(r.outcome, BuddyRestartOutcome.refused);
      expect(r.message, "--model is set by Harness and can't be added here.");
      await close(tester, c);
    });

    testWidgets('an unconfirmed receipt is notStarted', (tester) async {
      final c = await show(tester, swarm());
      final result = await run(tester, c, () async {
        connection.restartReplies.single.complete({
          'creationId': creationId(),
          'state': 'unconfirmed',
        });
      });
      final r = result;
      expect(r.outcome, BuddyRestartOutcome.notStarted);
      expect(
        r.message,
        "The Buddy didn't start with these flags. Fix or clear them and "
        'restart.',
      );
      await close(tester, c);
    });

    testWidgets('a reply with no echo is ignored', (tester) async {
      final c = await show(tester, swarm());
      final result = await run(tester, c, () async {
        connection.restartReplies.single.complete(
          restartReceipt(creationId(), agentId: 'h-wren'),
        );
      });
      final r = result;
      expect(r.outcome, BuddyRestartOutcome.ignored);
      expect(r.message, 'Update Harness on Test host to use launch flags.');
      await close(tester, c);
    });
  });
}
