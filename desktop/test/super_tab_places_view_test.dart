/// Back and Forward go through the reader's places in a Swarm: its chats, the
/// thread open beside one, and the Leaderboard.
library;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/places.dart';
import 'package:harness/super_tabs/view.dart';

import 'support/super_tab_swarm.dart' show swarm;
import 'support/super_tab_fixture.dart';

/// Lets the server's answers in and draws a few frames: the Swarm view is
/// never idle, so it is not waited for.
Future<void> _settle(WidgetTester tester) async {
  for (var i = 0; i < 3; i++) {
    await tester.runAsync(
      () => Future<void>.delayed(const Duration(milliseconds: 30)),
    );
    await tester.pump(const Duration(milliseconds: 50));
  }
}

/// This week's Leaderboard with the owner on it, so Humans shows.
void withPoints(ConversationServer server) {
  server.leaderboard = {
    'projectId': 'lead',
    'allProjects': true,
    'week': 1793577600000,
    'people': [
      {
        'personId': 'owner',
        'displayName': 'Owner',
        'rank': 1,
        'points': 4,
        'shipped': {'count': 1},
        'accepted': 1,
        'unblocked': {'count': 0},
        'agentsBrought': 2,
        'streakDays': 1,
      },
    ],
  };
}

void main() {
  Finder key(String k) => find.byKey(ValueKey(k));

  Future<(SuperTabController, ConversationServer)> show(
    WidgetTester tester, {
    void Function(ConversationServer server)? prepare,
    bool board = false,
  }) async {
    await tester.binding.setSurfaceSize(const Size(1300, 800));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final server = swarm();
    server.append('A root to thread on');
    server.ask(['Ship it?']);
    prepare?.call(server);
    final c = server.controller(
      account: 'owner',
      initial: {'tabId': 'tab', 'accountId': 'owner', 'selectedId': 'lead'},
    );
    await tester.runAsync(c.refresh);
    await tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: Brightness.light),
        home: Scaffold(
          body: SuperTabView(
            controller: c,
            onAddAgent: (_) {},
            onOpenTerminal: (_) {},
            machineName: (_) => 'Mac Studio',
          ),
        ),
      ),
    );
    await _settle(tester);
    return (c, server);
  }

  /// Unmounts and disposes the view in the test's own time: the Swarm view
  /// is never idle, and a flush in tear-down would wait on the test's clock.
  Future<void> end(WidgetTester tester, SuperTabController c) async {
    await tester.pumpWidget(const SizedBox());
    c.dispose();
    await tester.pump(const Duration(seconds: 5));
  }

  Future<void> tap(WidgetTester tester, String k) async {
    await tester.tap(key(k));
    await _settle(tester);
  }

  testWidgets(
    'Humans opens this week\'s Leaderboard, and it takes part in Back and Forward',
    (tester) async {
      final (c, server) = await show(tester, board: true, prepare: withPoints);
      // Humans is the Leaderboard's way in (task #4466).
      expect(key('project-sidebar-humans'), findsOneWidget);
      // Top Teams folds; a person in it opens the board (anh Dee, 2026-11-09).
      await tap(tester, 'project-sidebar-humans');
      await tap(tester, 'super-human-owner');
      expect(find.text('This week'), findsOneWidget);
      expect(key('weekly-person-owner'), findsOneWidget);
      expect(
        server.leaderboardReads.any((path) {
          final query = Uri.parse(path).queryParameters;
          return query['scope'] == 'all' && !query.containsKey('period');
        }),
        isTrue,
      );
      // Back to the project's channel it was opened from (Swarm v4).
      SuperTabPlaces.of(c).step(-1);
      await _settle(tester);
      expect(find.text('This week'), findsNothing);
      expect(key('super-agents-only'), findsOneWidget);
      SuperTabPlaces.of(c).step(1);
      await _settle(tester);
      expect(find.text('This week'), findsOneWidget);
      await end(tester, c);
    },
  );

  testWidgets('Back to a chat opens the thread that was open beside it', (
    tester,
  ) async {
    final (c, _) = await show(tester, board: true, prepare: withPoints);
    c.openThread('message-1');
    await _settle(tester);
    await tap(tester, 'project-sidebar-humans');
    await tap(tester, 'super-human-owner');
    expect(find.text('This week'), findsOneWidget);
    c.closeThread();
    await _settle(tester);

    SuperTabPlaces.of(c).step(-1);
    await _settle(tester);
    expect(find.text('This week'), findsNothing);
    expect(c.openedThread?.root, 'message-1');
    await end(tester, c);
  });

  testWidgets('⌘[ in a Swarm steps its places before the tabs', (tester) async {
    final (c, _) = await show(tester, board: true, prepare: withPoints);
    expect(stepSwarmPlaces(c, -1), isFalse);
    await tap(tester, 'project-sidebar-humans');
    await tap(tester, 'super-human-owner');
    expect(canStepSwarmPlaces(c, -1), isTrue);
    expect(stepSwarmPlaces(c, -1), isTrue);
    await _settle(tester);
    expect(find.text('This week'), findsNothing);
    expect(key('super-agents-only'), findsOneWidget);
    expect(stepSwarmPlaces(null, -1), isFalse);
    await end(tester, c);
  });
}
