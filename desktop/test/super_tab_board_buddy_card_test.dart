import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/state/app_state.dart';
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/view.dart';
import 'package:harness/ws/ws_conn.dart';

import 'super_tab_activity_lists_test.dart' show swarm;
import 'support/buddy_fixture.dart';
import 'support/restart_connection.dart';
import 'support/capture.dart';
import 'swarm_state_test.dart' show createApp;

/// The Board's Buddy card (spec 2026-11-06-board-buddy-card): Restart with
/// launch flags as chips, Rename and Remove, from the Buddy pane's name.
void main() {
  late RestartConnection connection;
  late AppNotifier app;

  Finder key(String k) => find.byKey(ValueKey(k));
  final button = key('super-board-buddy-button');
  final card = key('super-buddy-card');
  final restart = key('super-buddy-card-restart');
  final input = key('launch-flag-input');

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

  Future<void> settle(WidgetTester tester) async {
    for (var i = 0; i < 3; i++) {
      await tester.runAsync(
        () => Future<void>.delayed(const Duration(milliseconds: 30)),
      );
      await tester.pump(const Duration(milliseconds: 50));
    }
  }

  Future<SuperTabController> show(
    WidgetTester tester, {
    String machineId = 'm',
    Brightness brightness = Brightness.light,
  }) async {
    await tester.binding.setSurfaceSize(const Size(1500, 900));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final server = swarm();
    server.state['buddies'] = true;
    giveBuddy(server, person: 'owner', machineId: machineId);
    (server.state['conversations'] as List)
        .cast<Map<String, dynamic>>()
        .firstWhere((g) => g['id'] == 'offline')
        .addAll({
          'number': 42,
          'assignment': {'id': 'a1', 'agentId': 'kestrel', 'status': 'working'},
        });
    final c = server.controller(
      account: 'owner',
      initial: {'tabId': 'tab', 'accountId': 'owner', 'selectedId': 'lead'},
    );
    await tester.runAsync(c.refresh);
    await tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: brightness),
        home: Scaffold(
          body: SuperTabView(
            controller: c,
            app: app,
            onInvite: () {},
            onAddAgent: (_) {},
            onOpenTerminal: (_) {},
            machineName: (_) => 'Mac Studio',
            board: true,
          ),
        ),
      ),
    );
    await settle(tester);
    await tester.tap(key('super-group-lead'));
    await settle(tester);
    return c;
  }

  Future<void> end(WidgetTester tester, SuperTabController c) async {
    await tester.pumpWidget(const SizedBox());
    c.dispose();
    await tester.pump(const Duration(seconds: 5));
  }

  Future<void> open(WidgetTester tester) async {
    await tester.tap(button);
    await settle(tester);
  }

  String creationId() => connection.requests.last['creationId'] as String;

  Future<void> addFlag(WidgetTester tester, String flag) async {
    await tester.enterText(input, '$flag ');
    await tester.pump();
  }

  testWidgets('the Buddy pane name opens a card with its facts', (
    tester,
  ) async {
    final c = await show(tester);
    expect(card, findsNothing);
    await open(tester);
    expect(card, findsOneWidget);
    expect(find.text('Running'), findsOneWidget);
    expect(find.text('Runs on'), findsOneWidget);
    expect(find.text('Test host'), findsWidgets);
    expect(find.text('Engine'), findsOneWidget);
    expect(find.textContaining('Claude Code'), findsWidgets);
    expect(
      find.descendant(
        of: key('launch-flag-chip-0'),
        matching: find.text('--chrome'),
      ),
      findsOneWidget,
    );
    expect(find.text('Launch flags'), findsOneWidget);
    await end(tester, c);
  });

  testWidgets("the help line is the dialog's, and changes with focus", (
    tester,
  ) async {
    final c = await show(tester);
    await open(tester);
    expect(
      find.text(
        "Added to Claude Code's command line each time this Buddy starts on "
        'Test host. Your Buddy runs with full permissions. Don\'t put secrets '
        'here: other people on that computer can see them.',
      ),
      findsOneWidget,
    );
    await tester.tap(input);
    await tester.pump();
    expect(
      find.text('Press Enter or Space to add · ⌫ removes the last flag'),
      findsOneWidget,
    );
    await end(tester, c);
  });

  testWidgets("a task card's chat has no Buddy button", (tester) async {
    final c = await show(tester);
    expect(button, findsOneWidget);
    await tester.tap(key('super-task-card-offline'));
    await settle(tester);
    expect(c.selectedId, 'offline');
    expect(button, findsNothing);
    await end(tester, c);
  });

  testWidgets('Esc closes the card', (tester) async {
    final c = await show(tester);
    await open(tester);
    await tester.sendKeyEvent(LogicalKeyboardKey.escape);
    await settle(tester);
    expect(card, findsNothing);
    await end(tester, c);
  });

  testWidgets('a second click on the name closes it', (tester) async {
    final c = await show(tester);
    await open(tester);
    await tester.tap(button);
    await settle(tester);
    expect(card, findsNothing);
    await end(tester, c);
  });

  testWidgets('moving the pane to a task card closes an open card', (
    tester,
  ) async {
    final c = await show(tester);
    await open(tester);
    expect(card, findsOneWidget);
    await tester.runAsync(() => c.select('offline'));
    await settle(tester);
    expect(button, findsNothing);
    expect(card, findsNothing);
    await end(tester, c);
  });

  testWidgets('Restart sends the chips as one line and closes on success', (
    tester,
  ) async {
    final c = await show(tester);
    await open(tester);
    await addFlag(tester, '--foo');
    await tester.tap(restart);
    await tester.pump();
    expect(connection.types.single, 'agent_restart');
    expect(connection.requests.single['agentId'], 'h-wren');
    expect(connection.requests.single['launchArgs'], '--chrome --foo');
    expect(find.text('Restarting…'), findsOneWidget);
    expect(find.text('Restarting'), findsOneWidget);
    expect(
      tester.widget<TextField>(input).enabled,
      isFalse,
      reason: 'read only while it runs',
    );
    connection.restartReplies.single.complete({
      ...restartReceipt(creationId(), agentId: 'h-wren'),
      'launchArgs': ['--chrome', '--foo'],
    });
    await settle(tester);
    expect(card, findsNothing);
    await end(tester, c);
  });

  testWidgets('a stopped Buddy says Stopped and Start resumes with the flags', (
    tester,
  ) async {
    app.stateOf('m')!.agents = [
      const Agent(
        id: 'h-wren',
        name: 'Wren',
        engine: 'claude',
        status: 'stopped',
        launchArgs: ['--chrome'],
      ),
    ];
    final c = await show(tester);
    await open(tester);
    expect(find.text('Stopped'), findsOneWidget);
    expect(find.text('Running'), findsNothing);
    expect(
      find.descendant(of: restart, matching: find.text('Start')),
      findsOneWidget,
    );
    await tester.tap(restart);
    await tester.pump();
    expect(connection.types.single, 'agent_resume');
    expect(connection.requests.single['launchArgs'], '--chrome');
    connection.restartReplies.single.complete({
      ...restartReceipt(creationId(), agentId: 'h-wren'),
      'launchArgs': ['--chrome'],
    });
    await settle(tester);
    expect(card, findsNothing);
    await end(tester, c);
  });

  testWidgets('a refusal shows the detail and marks the named chip', (
    tester,
  ) async {
    final c = await show(tester);
    await open(tester);
    await addFlag(tester, '--model');
    await tester.tap(restart);
    await tester.pump();
    connection.restartReplies.single.completeError(
      const WsRequestFailure(
        responseType: 'agent_restart_result',
        code: 'INVALID_LAUNCH_ARGS',
        detail: "--model is set by Harness and can't be added here.",
      ),
    );
    await settle(tester);
    expect(
      find.text("--model is set by Harness and can't be added here."),
      findsOneWidget,
    );
    final box = tester.widget<DecoratedBox>(
      find
          .descendant(
            of: key('launch-flag-chip-1'),
            matching: find.byType(DecoratedBox),
          )
          .first,
    );
    expect(
      ((box.decoration as BoxDecoration).border! as Border).top.color,
      grid.AppPalette.dangerFill,
    );
    expect(card, findsOneWidget);
    await end(tester, c);
  });

  testWidgets('an engine that did not start says to fix or clear the flags', (
    tester,
  ) async {
    final c = await show(tester);
    await open(tester);
    await tester.tap(restart);
    await tester.pump();
    connection.restartReplies.single.complete({
      'creationId': creationId(),
      'state': 'unconfirmed',
    });
    await settle(tester);
    expect(
      find.text(
        "The Buddy didn't start with these flags. Fix or clear them and "
        'restart.',
      ),
      findsOneWidget,
    );
    await end(tester, c);
  });

  testWidgets('a reply with no echo says to update Harness on the machine', (
    tester,
  ) async {
    final c = await show(tester);
    await open(tester);
    await tester.tap(restart);
    await tester.pump();
    connection.restartReplies.single.complete(
      restartReceipt(creationId(), agentId: 'h-wren'),
    );
    await settle(tester);
    expect(
      find.text('Update Harness on Test host to use launch flags.'),
      findsOneWidget,
    );
    await end(tester, c);
  });

  testWidgets('after a failure a second Restart is a fresh attempt with the '
      'current chips', (tester) async {
    final c = await show(tester);
    await open(tester);
    await addFlag(tester, '--bad');
    await tester.tap(restart);
    await tester.pump();
    final first = creationId();
    connection.restartReplies.single.complete({
      'creationId': first,
      'state': 'unconfirmed',
    });
    await settle(tester);
    await tester.tap(key('launch-flag-remove-1'));
    await tester.pump();
    await tester.tap(restart);
    await tester.pump();
    expect(connection.checks, isEmpty);
    expect(connection.requests, hasLength(2));
    expect(connection.requests.last['launchArgs'], '--chrome');
    expect(creationId(), isNot(first));
    connection.restartReplies.last.complete({
      ...restartReceipt(creationId(), agentId: 'h-wren'),
      'launchArgs': ['--chrome'],
    });
    await settle(tester);
    expect(card, findsNothing);
    await end(tester, c);
  });

  testWidgets('Rename opens the rename dialog', (tester) async {
    final c = await show(tester);
    await open(tester);
    await tester.tap(key('super-buddy-card-rename'));
    await settle(tester);
    expect(find.text('Rename your Buddy'), findsOneWidget);
    await end(tester, c);
  });

  testWidgets('Remove opens the remove confirm', (tester) async {
    final c = await show(tester);
    await open(tester);
    await tester.tap(key('super-buddy-card-remove'));
    await settle(tester);
    expect(find.text('Remove Buddy?'), findsOneWidget);
    await end(tester, c);
  });

  testWidgets('a Buddy whose machine agent is unknown shows Stopped and no '
      'flags', (tester) async {
    app.stateOf('m')!.agents = [];
    final c = await show(tester);
    await open(tester);
    expect(card, findsOneWidget);
    expect(find.text('Stopped'), findsOneWidget);
    expect(input, findsNothing);
    expect(restart, findsNothing);
    expect(tester.takeException(), isNull);
    await end(tester, c);
  });

  // Writes nothing unless HARNESS_SUPER_TAB_CAPTURE names a folder.
  final shots = Platform.environment['HARNESS_SUPER_TAB_CAPTURE'];
  if (shots != null) setUpAll(() => loadCaptureFonts(shots));
  testWidgets('the open card in the dark theme', (tester) async {
    final c = await show(tester, brightness: Brightness.dark);
    await open(tester);
    await captureWindow(tester, shots, 'buddy-card-dark');
    expect(card, findsOneWidget);
    await end(tester, c);
  });
}
