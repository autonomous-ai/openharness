import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/leaderboard/weekly_page.dart';
import 'package:harness/super_tabs/view.dart';

import 'support/capture.dart';
import 'support/humans_fixture.dart';
import 'support/super_tab_fixture.dart';

final shots = Platform.environment['SUPER_TAB_WEEKLY_LEADERBOARD_SHOTS'];

ConversationServer weeklySwarm() {
  final server = humansSwarm();
  server.leaderboard!['allProjects'] = true;
  server.leaderboard!['people'] = [
    for (final (id, rank, shipped, accepted, unblocked, points, agents, streak)
        in [
          ('peer', 1, 6, 8, 3, 29, 3, 6),
          ('tony', 2, 2, 4, 0, 10, 1, 2),
          ('owner', 3, 1, 8, 4, 15, 1, 1),
          ('scholes', 4, 0, 2, 2, 4, 1, 0),
          ('diego', 5, 0, 1, 1, 2, 1, 0),
          ('huy', 6, 0, 0, 0, 0, 1, 0),
          ('maximilian.alexander.longname', 6, 0, 0, 0, 0, 0, 0),
        ])
      {
        'personId': id,
        'displayName':
            {'peer': 'Dee', 'owner': 'Ken', 'tony': 'Tony'}[id] ?? id,
        'rank': rank,
        'points': points,
        'shipped': {'count': shipped},
        'accepted': accepted,
        'unblocked': {'count': unblocked},
        'agentsBrought': agents,
        'streakDays': streak,
      },
  ];
  return server;
}

Future<SuperTabController> showBoard(
  WidgetTester tester,
  ConversationServer server, {
  Brightness brightness = Brightness.light,
  Size size = const Size(1120, 760),
}) async {
  await tester.binding.setSurfaceSize(size);
  addTearDown(() => tester.binding.setSurfaceSize(null));
  grid.AppTheme.brightness.value = brightness;
  addTearDown(() => grid.AppTheme.brightness.value = Brightness.dark);
  final c = server.controller(
    account: 'peer',
    initial: {'tabId': 'tab', 'accountId': 'peer', 'selectedId': 'lead'},
  );
  addTearDown(c.dispose);
  await c.refresh();
  await tester.pumpWidget(
    MaterialApp(
      debugShowCheckedModeBanner: false,
      theme: grid.buildAppTheme(brightness: brightness),
      home: Scaffold(body: SuperTabWeeklyLeaderboardPage(controller: c)),
    ),
  );
  await tester.pump();
  return c;
}

void main() {
  setUpAll(() => loadCaptureFonts(shots));

  for (final brightness in [Brightness.light, Brightness.dark]) {
    testWidgets(
      'weekly org board shows team play without lending in ${brightness.name}',
      (tester) async {
        final server = weeklySwarm();
        await showBoard(tester, server, brightness: brightness);
        await tester.pumpAndSettle();
        final uri = Uri.parse(server.leaderboardReads.single);
        expect(uri.queryParameters, {'projectId': 'lead', 'scope': 'all'});
        for (final name in [
          'This week',
          'Shipped',
          'Accepted',
          'Unblocked',
          'Streak',
          'Agents',
          'Points',
        ]) {
          expect(find.text(name), findsOneWidget);
        }
        expect(find.text('Lent'), findsNothing);
        expect(find.text('Brought'), findsNothing);
        expect(
          find.byKey(const ValueKey('weekly-agents-peer')),
          findsOneWidget,
        );
        expect(
          tester
              .widget<Text>(find.byKey(const ValueKey('weekly-agents-peer')))
              .data,
          '3',
        );
        expect(
          tester
              .getTopLeft(find.byKey(const ValueKey('weekly-person-peer')))
              .dy,
          lessThan(
            tester
                .getTopLeft(find.byKey(const ValueKey('weekly-person-owner')))
                .dy,
          ),
        );
        expect(find.text('Agents brought earn no points.'), findsOneWidget);
        await captureWindow(tester, shots, 'weekly-${brightness.name}');
        expect(tester.takeException(), isNull);
      },
    );

    testWidgets('Desktop opens the weekly board in ${brightness.name}', (
      tester,
    ) async {
      final server = weeklySwarm();
      final c = await showBoard(
        tester,
        server,
        brightness: brightness,
        size: const Size(1500, 900),
      );
      await tester.pumpWidget(
        MaterialApp(
          debugShowCheckedModeBanner: false,
          theme: grid.buildAppTheme(brightness: brightness),
          home: Scaffold(
            body: SuperTabView(
              board: true,
              controller: c,
              onInvite: () {},
              onAddAgent: (_) {},
              onOpenTerminal: (_) {},
              machineName: (_) => 'Mac Studio',
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      // Humans opens the whole board (task #4466).
      // Top Teams folds; a person in it opens the whole board.
      await tester.tap(find.byKey(const ValueKey('project-sidebar-humans')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('super-human-owner')));
      await tester.pumpAndSettle();
      expect(find.text('This week'), findsOneWidget);
      expect(find.byKey(const ValueKey('weekly-person-peer')), findsOneWidget);
      expect(
        tester.getTopLeft(find.byKey(const ValueKey('weekly-person-tony'))).dy,
        lessThan(
          tester
              .getTopLeft(find.byKey(const ValueKey('weekly-person-owner')))
              .dy,
        ),
      );
      await captureWindow(tester, shots, 'weekly-desktop-${brightness.name}');
      await tester.pumpWidget(const SizedBox());
    });
  }

  testWidgets('failed reads clear the board and Retry recovers', (
    tester,
  ) async {
    final server = weeklySwarm()..failLeaderboardReads = 1;
    await showBoard(tester, server);
    await tester.pumpAndSettle();
    expect(find.text('No connection.'), findsOneWidget);
    await tester.tap(find.text('Retry'));
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('weekly-person-peer')), findsOneWidget);
    server.leaderboardAnswer = (_) => throw const SuperTabFailure(
      'FORBIDDEN',
      'Unavailable',
      statusCode: 403,
    );
    await tester.tap(find.byTooltip('Refresh leaderboard'));
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('weekly-person-peer')), findsNothing);
    expect(
      find.text('This leaderboard is no longer available.'),
      findsOneWidget,
    );
  });

  testWidgets(
    'an older backend is identified without showing misleading scores',
    (tester) async {
      await showBoard(tester, humansSwarm());
      await tester.pumpAndSettle();
      expect(
        find.text('The weekly org leaderboard needs a newer server.'),
        findsOneWidget,
      );
      expect(find.byKey(const ValueKey('weekly-person-peer')), findsNothing);
    },
  );

  testWidgets('an org with no readable projects makes no leaderboard request', (
    tester,
  ) async {
    final server = weeklySwarm();
    server.state['projects'] = <dynamic>[];
    final c = await showBoard(tester, server);
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);
    expect(c.snapshot!.projects, isEmpty);
    expect(server.leaderboardReads, isEmpty);
    expect(find.text('No projects to show yet.'), findsOneWidget);
  });

  testWidgets(
    'changes during a read coalesce and stale responses never appear',
    (tester) async {
      final server = weeklySwarm();
      final gate = Completer<void>();
      server.leaderboardGate = gate.future;
      final c = await showBoard(tester, server);
      expect(server.leaderboardReads, hasLength(1));
      for (var i = 0; i < 3; i++) {
        server.state['name'] = 'Changed $i';
        await c.refresh();
      }
      await tester.pump();
      expect(server.leaderboardReads, hasLength(1));
      gate.complete();
      await tester.pumpAndSettle();
      expect(server.leaderboardReads, hasLength(2));
      expect(find.byKey(const ValueKey('weekly-person-peer')), findsOneWidget);
    },
  );

  // Task #4220: every change in the Swarm cleared the board and showed a spinner until the next read landed.
  testWidgets('a change in the Swarm refreshes the board without blanking '
      'it, and a failed refresh keeps it', (tester) async {
    final server = weeklySwarm();
    final c = await showBoard(tester, server);
    await tester.pumpAndSettle();
    final peer = find.byKey(const ValueKey('weekly-person-peer'));
    expect(peer, findsOneWidget);
    final gate = Completer<void>();
    server.leaderboardGate = gate.future;
    server.state['name'] = 'Changed';
    await c.refresh();
    await tester.pump();
    expect(server.leaderboardReads, hasLength(2));
    expect(peer, findsOneWidget);
    gate.complete();
    await tester.pumpAndSettle();
    expect(peer, findsOneWidget);
    server.leaderboardGate = null;
    server.failLeaderboardReads = 1;
    await tester.tap(find.byTooltip('Refresh leaderboard'));
    await tester.pumpAndSettle();
    expect(peer, findsOneWidget);
    expect(find.text('No connection.'), findsOneWidget);
  });

  testWidgets('empty week and narrow pane remain usable', (tester) async {
    final server = weeklySwarm();
    server.leaderboard!['people'] = <dynamic>[];
    await showBoard(tester, server, size: const Size(420, 600));
    await tester.pumpAndSettle();
    expect(
      find.text('A fresh week. Pick up a task and start shipping.'),
      findsOneWidget,
    );
    expect(tester.takeException(), isNull);
  });
}
