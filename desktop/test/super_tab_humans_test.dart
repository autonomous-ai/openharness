import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/view.dart';

import 'support/humans_fixture.dart';
import 'support/super_tab_fixture.dart';

/// The leaderboard lives in the right pane's Humans section (Dee, 2026-10-27):
/// the team goal on one line with a small week picker, then everyone, most
/// points first, each one aligned row with a quiet line of their three numbers.
/// There is no separate leaderboard view.
void main() {
  Finder person(String id) => find.byKey(ValueKey('super-person-$id'));

  Future<SuperTabController> show(
    WidgetTester tester,
    ConversationServer server, {
    Size size = const Size(1300, 900),
  }) async {
    await tester.binding.setSurfaceSize(size);
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final controller = server.controller(
      account: 'peer',
      initial: {'tabId': 'tab', 'accountId': 'peer', 'selectedId': 'lead'},
    );
    await controller.refresh();
    await tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: Brightness.light),
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

  testWidgets('lists every person, most points first, with no cut-off', (
    tester,
  ) async {
    final controller = await show(tester, humansSwarm());
    final ids = [
      'peer',
      'owner',
      'tony',
      'scholes',
      'diego',
      'huy',
      'maximilian.alexander.longname',
    ];
    for (final id in ids) {
      expect(person(id), findsOneWidget);
    }
    expect(find.textContaining('Show '), findsNothing);
    final tops = [for (final id in ids) tester.getTopLeft(person(id)).dy];
    expect(tops, [...tops]..sort());
    await close(tester, controller);
  });

  testWidgets(
    'gives each person their points on the right and a quiet line of their three numbers',
    (tester) async {
      final controller = await show(tester, humansSwarm());
      Finder within(String id, String text) =>
          find.descendant(of: person(id), matching: find.text(text));
      expect(within('peer', '21 pts'), findsOneWidget);
      expect(within('peer', '6 shipped'), findsOneWidget);
      expect(within('peer', '3 unblocked'), findsOneWidget);
      expect(within('peer', '0 h lent'), findsOneWidget);
      expect(within('owner', '13 pts'), findsOneWidget);
      expect(within('owner', '20 h lent'), findsOneWidget);
      // Fixed columns: points end at one edge, and each number starts where
      // the one above it does.
      final right = tester.getTopRight(within('peer', '21 pts')).dx;
      expect(tester.getTopRight(within('owner', '13 pts')).dx, right);
      expect(tester.getTopRight(within('huy', '0 pts')).dx, right);
      expect(
        tester.getTopLeft(within('owner', '4 unblocked')).dx,
        tester.getTopLeft(within('peer', '3 unblocked')).dx,
      );
      expect(
        tester.getTopLeft(within('owner', '20 h lent')).dx,
        tester.getTopLeft(within('peer', '0 h lent')).dx,
      );
      // A long name is cut short rather than pushing the points out.
      final name = tester.widget<Text>(
        within(
          'maximilian.alexander.longname',
          'maximilian.alexander.longname',
        ),
      );
      expect(name.overflow, TextOverflow.ellipsis);
      expect(
        tester.getTopRight(within('maximilian.alexander.longname', '0 pts')).dx,
        right,
      );
      expect(tester.takeException(), isNull);
      await close(tester, controller);
    },
  );

  testWidgets('puts the team goal on one line above the people', (
    tester,
  ) async {
    final controller = await show(tester, humansSwarm());
    final goal = find.byKey(const ValueKey('leaderboard-goal'));
    expect(
      tester.widget<Text>(goal).data,
      'Team goal: 7 shipped · 46 pts · 9 open',
    );
    expect(tester.widget<Text>(goal).maxLines, 1);
    // The week before and the median are on hover.
    expect(
      find.byTooltip(
        'Team goal: 7 shipped · 46 pts · 9 open\n4 shipped last week\nMedian ask to ship 2 h',
      ),
      findsOneWidget,
    );
    expect(
      tester.getTopLeft(goal).dy,
      lessThan(tester.getTopLeft(person('peer')).dy),
    );
    await close(tester, controller);
  });

  testWidgets('reads another week from the small week picker', (tester) async {
    final server = humansSwarm();
    final controller = await show(tester, server);
    final picker = find.byKey(const ValueKey('leaderboard-week'));
    expect(tester.getSize(picker).height, lessThanOrEqualTo(32));
    await tester.tap(picker);
    await tester.pumpAndSettle();
    await tester.tap(find.text('Last week').last);
    await tester.pumpAndSettle();
    expect(server.leaderboardReads.last, contains('&week='));
    await close(tester, controller);
  });

  testWidgets('has no separate leaderboard view or trophy', (tester) async {
    final controller = await show(
      tester,
      humansSwarm(),
      size: const Size(1500, 900),
    );
    expect(find.byKey(const ValueKey('super-leaderboard')), findsNothing);
    expect(find.byKey(const ValueKey('super-board-pane')), findsNothing);
    expect(find.byTooltip('Leaderboard'), findsNothing);
    await close(tester, controller);
  });

  testWidgets("shows a person's week when their name is tapped", (
    tester,
  ) async {
    final controller = await show(tester, humansSwarm());
    await tester.tap(person('peer'));
    await tester.pumpAndSettle();
    final dialog = find.byType(AlertDialog);
    expect(
      find.descendant(
        of: dialog,
        matching: find.text('6 asks landed · median 2 h to ship'),
      ),
      findsOneWidget,
    );
    expect(
      find.descendant(of: dialog, matching: find.text('6 days shipping')),
      findsOneWidget,
    );
    await close(tester, controller);
  });

  testWidgets('opens the waiting conversation from Answer', (tester) async {
    final controller = await show(tester, humansSwarm());
    await tester.tap(find.text('Answer'));
    await tester.pumpAndSettle();
    expect(controller.selectedId, 'offline');
    await close(tester, controller);
  });

  testWidgets('reads the board of the open conversation’s project', (
    tester,
  ) async {
    final server = humansSwarm();
    final controller = await show(tester, server);
    expect(server.leaderboardReads, [
      '/api/super-tabs/tab/leaderboard?projectId=lead',
    ]);
    await close(tester, controller);
  });

  testWidgets(
    'lists people without numbers, quietly, where the server has no leaderboard',
    (tester) async {
      final server = humansSwarm()..leaderboard = null;
      final controller = await show(tester, server);
      expect(person('peer'), findsOneWidget);
      expect(find.textContaining('pts'), findsNothing);
      expect(find.textContaining('leaderboard'), findsNothing);
      await close(tester, controller);
    },
  );
}
