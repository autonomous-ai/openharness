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

  ConversationServer swarm() {
    final server = buddySwarm();
    giveBuddy(server, machineId: 'm');
    return server;
  }

  String creationId() => connection.requests.last['creationId'] as String;

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
