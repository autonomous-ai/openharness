import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/leaderboard/column.dart';
import 'package:harness/super_tabs/view.dart';

import 'support/super_tab_fixture.dart';

/// Where the leaderboard opens in a Swarm (v2 G): a trophy in the conversation
/// header shows it as a column at the far right, beside People, on a wide
/// window, and as a dialog on a narrower one. Answer opens the waiting group.
void main() {
  final trophy = find.byKey(const ValueKey('super-leaderboard'));
  final boardPane = find.byKey(const ValueKey('super-board-pane'));

  ConversationServer swarm() => ConversationServer()
    ..leaderboard = {
      'projectId': 'lead',
      'week': DateTime.utc(2026, 10, 26).millisecondsSinceEpoch,
      'goal': {
        'openRequests': 2,
        'thisWeek': {'shipped': 1, 'points': 3, 'medianAskToShipMs': 7200000},
        'lastWeek': {'shipped': 0, 'points': 0, 'medianAskToShipMs': null},
      },
      'people': [
        {
          'personId': 'owner',
          'points': 3,
          'rank': 1,
          'medal': 'gold',
          'shipped': {'count': 1, 'medianAskToShipMs': 7200000},
          'unblocked': {'count': 0, 'agentMs': 0, 'medianAnswerMs': null},
          'lent': {'machines': 0, 'agentMs': 0},
          'streakDays': 1,
        },
      ],
      'waiting': {
        'total': 1,
        'people': [
          {
            'personId': 'owner',
            'count': 1,
            'conversationIds': ['offline'],
          },
        ],
      },
    };

  Future<SuperTabController> show(
    WidgetTester tester,
    ConversationServer server,
    Size size,
  ) async {
    await tester.binding.setSurfaceSize(size);
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final controller = server.controller(
      account: 'owner',
      initial: {'tabId': 'tab', 'accountId': 'owner', 'selectedId': 'lead'},
    );
    await controller.refresh();
    await tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: Brightness.dark),
        home: Scaffold(
          body: SuperTabView(
            controller: controller,
            onInvite: () {},
            onAddAgent: (_) {},
            onOpenTerminal: (_) {},
            machineName: (_) => 'Studio',
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    return controller;
  }

  Future<void> close(WidgetTester tester, SuperTabController controller) async {
    await tester.pumpWidget(const SizedBox());
    await controller.flush();
    controller.dispose();
  }

  testWidgets(
    'opens the board as a column at the far right of a wide window, and closes it again',
    (tester) async {
      final server = swarm();
      final controller = await show(tester, server, const Size(1500, 800));
      expect(boardPane, findsNothing);
      expect(server.leaderboardReads, isEmpty);
      await tester.tap(trophy);
      await tester.pumpAndSettle();
      expect(boardPane, findsOneWidget);
      expect(tester.getSize(boardPane).width, SuperTabLeaderboardColumn.width);
      expect(tester.getTopRight(boardPane).dx, 1500);
      expect(find.text('Owner'), findsNothing);
      expect(find.text('owner'), findsWidgets);
      expect(server.leaderboardReads, [
        '/api/super-tabs/tab/leaderboard?projectId=lead',
      ]);
      await tester.tap(trophy);
      await tester.pumpAndSettle();
      expect(boardPane, findsNothing);
      await close(tester, controller);
    },
  );

  testWidgets('opens the waiting group from Answer', (tester) async {
    final server = swarm();
    final controller = await show(tester, server, const Size(1500, 800));
    await tester.tap(trophy);
    await tester.pumpAndSettle();
    await tester.tap(find.text('Answer'));
    await tester.pumpAndSettle();
    expect(controller.selectedId, 'offline');
    await close(tester, controller);
  });

  testWidgets(
    'shows the board in a dialog when the window has no room for the column',
    (tester) async {
      final server = swarm();
      final controller = await show(tester, server, const Size(1100, 800));
      await tester.tap(trophy);
      await tester.pumpAndSettle();
      expect(boardPane, findsNothing);
      expect(
        find.descendant(
          of: find.byType(Dialog),
          matching: find.byType(SuperTabLeaderboardColumn),
        ),
        findsOneWidget,
      );
      await tester.tap(find.text('Answer'));
      await tester.pumpAndSettle();
      expect(find.byType(Dialog), findsNothing);
      expect(controller.selectedId, 'offline');
      await close(tester, controller);
    },
  );
}
