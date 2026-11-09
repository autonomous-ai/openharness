/// The Swarm's leaderboard as a person uses it (docs/plans/2026-11-09-swarm-v4-leaderboard.md): Top Teams in the left pane
/// opens it, it ranks people by how many of their agents ship, this week or all time, says why one of the reader's own computers
/// could not read GitHub, and shows nothing for an empty board.
library;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/view.dart';

import 'super_tab_activity_lists_test.dart' show swarm;
import 'super_tab_shipping_test.dart' show person;
import 'support/super_tab_fixture.dart';

/// Lets the server's answers in and draws a few frames: the Swarm view is never idle, so it is not waited for.
Future<void> _settle(WidgetTester tester) async {
  for (var i = 0; i < 3; i++) {
    await tester.runAsync(
      () => Future<void>.delayed(const Duration(milliseconds: 30)),
    );
    await tester.pump(const Duration(milliseconds: 50));
  }
}

/// This week: Dee's three agents ship, the reader (owner) is second, Ken third; one of the reader's computers is signed out of
/// GitHub. All time: the owner leads.
Map<String, dynamic> board(String path) => path.contains('all=1')
    ? {
        'week': 0,
        'people': [
          person('owner', 1, 9.5, agents: 5, level: 4),
          person('dee', 2, 7.1, agents: 3, level: 3, name: 'Dee'),
        ],
        'failures': <dynamic>[],
      }
    : {
        'week': 1793577600000,
        'people': [
          person('dee', 1, 4.2, agents: 3, level: 3, name: 'Dee'),
          person('owner', 2, 2.4, agents: 2, level: 2),
          person('ken', 3, 1.0, name: 'Ken'),
        ],
        'failures': [
          {'machineId': 'mac-1', 'code': 'GH_SIGNED_OUT'},
        ],
      };

void main() {
  Finder key(String k) => find.byKey(ValueKey(k));
  String text(WidgetTester tester, String k) =>
      tester.widget<Text>(key(k)).data!;

  /// What the place mark in a person's row says, or null for a row with none.
  String? mark(WidgetTester tester, String id) {
    final icons = find.descendant(
      of: key('leaderboard-row-$id'),
      matching: find.byType(Icon),
    );
    return icons.evaluate().isEmpty
        ? null
        : tester.widget<Icon>(icons.first).semanticLabel;
  }

  Future<(SuperTabController, ConversationServer)> show(
    WidgetTester tester, {
    Brightness brightness = Brightness.light,
  }) async {
    await tester.binding.setSurfaceSize(const Size(1300, 800));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final server = swarm()..shippingAnswer = board;
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
            board: true,
            controller: c,
            onInvite: () {},
            onAddAgent: (_) {},
            onOpenTerminal: (_) {},
            machineName: (id) => id == 'mac-1' ? 'Mac Studio' : 'Another Mac',
          ),
        ),
      ),
    );
    await _settle(tester);
    return (c, server);
  }

  /// Unmounts and disposes the view in the test's own time: the Swarm view is never idle.
  Future<void> end(WidgetTester tester, SuperTabController c) async {
    await tester.pumpWidget(const SizedBox());
    c.dispose();
    await tester.pump(const Duration(seconds: 5));
  }

  Future<void> tap(WidgetTester tester, Finder target) async {
    await tester.tap(target);
    await _settle(tester);
  }

  for (final brightness in Brightness.values) {
    testWidgets(
      'Top Teams opens the leaderboard: people by agents shipping, this week and all time (${brightness.name})',
      (tester) async {
        final (c, server) = await show(tester, brightness: brightness);
        // Top Teams is the board in short, folded until opened, its points on the right.
        await tap(tester, key('project-sidebar-humans'));
        expect(
          find.descendant(
            of: key('super-human-dee'),
            matching: find.text('4.2'),
          ),
          findsOneWidget,
        );
        double top(String id) => tester.getTopLeft(key('super-human-$id')).dy;
        expect(top('dee'), lessThan(top('owner')));
        expect(top('owner'), lessThan(top('ken')));
        await tap(tester, key('super-human-dee'));

        // This week: each person's place, name, how many of their agents ship and their level, and points.
        expect(find.text('Leaderboard'), findsWidgets);
        expect(text(tester, 'leaderboard-person-dee'), 'Dee');
        expect(
          text(tester, 'leaderboard-detail-dee'),
          '3 agents shipping · Level 3',
        );
        expect(text(tester, 'leaderboard-points-dee'), '4.2');
        expect(
          text(tester, 'leaderboard-detail-ken'),
          '1 agent shipping · Level 1',
        );
        // The reader's own row says You; first place carries its mark beside the numeral, said in words.
        expect(
          find.descendant(
            of: key('leaderboard-row-owner'),
            matching: find.text('You'),
          ),
          findsOneWidget,
        );
        expect(
          find.descendant(
            of: key('leaderboard-row-dee'),
            matching: find.text('You'),
          ),
          findsNothing,
        );
        expect(mark(tester, 'dee'), 'Number one this week');
        expect(mark(tester, 'ken'), 'Number three this week');
        // The place is still its numeral, beside the mark.
        expect(
          find.descendant(
            of: key('leaderboard-row-dee'),
            matching: find.text('1'),
          ),
          findsOneWidget,
        );
        // A computer of the reader's that could not read GitHub says so; the numbers stay.
        expect(
          find.descendant(
            of: key('leaderboard-failure-mac-1'),
            matching: find.text('Mac Studio · GitHub signed out'),
          ),
          findsOneWidget,
        );

        // All time: read anew, never this week's numbers under its name.
        await tap(tester, key('leaderboard-all'));
        expect(server.shippingReads.last, contains('all=1'));
        expect(text(tester, 'leaderboard-points-owner'), '9.5');
        expect(
          text(tester, 'leaderboard-detail-owner'),
          '5 agents shipping · Level 4',
        );
        expect(key('leaderboard-row-ken'), findsNothing);
        expect(key('leaderboard-failure-mac-1'), findsNothing);
        expect(mark(tester, 'owner'), 'Number one of all time');
        await tap(tester, key('leaderboard-week'));
        expect(text(tester, 'leaderboard-points-dee'), '4.2');
        expect(tester.takeException(), isNull);
        await end(tester, c);
      },
    );
  }

  testWidgets(
    'a failed read keeps the board and says why, and Retry reads it again',
    (tester) async {
      final (c, server) = await show(tester);
      await tap(tester, key('project-sidebar-humans'));
      await tap(tester, key('super-human-dee'));
      server.failShippingReads = 1;
      await tap(tester, find.byTooltip('Refresh leaderboard'));
      expect(find.text('No connection.'), findsOneWidget);
      expect(text(tester, 'leaderboard-points-dee'), '4.2');
      final reads = server.shippingReads.length;
      await tap(tester, key('leaderboard-retry'));
      expect(server.shippingReads.length, reads + 1);
      expect(find.text('No connection.'), findsNothing);
      expect(text(tester, 'leaderboard-points-dee'), '4.2');
      await end(tester, c);
    },
  );

  testWidgets('an empty board shows nothing: no rows, and no Top Teams', (
    tester,
  ) async {
    final (c, server) = await show(tester);
    await tap(tester, key('project-sidebar-humans'));
    await tap(tester, key('super-human-dee'));
    server.shippingAnswer = (_) => {
      'week': 1793577600000,
      'people': <dynamic>[],
      'failures': <dynamic>[],
    };
    await tap(tester, find.byTooltip('Refresh leaderboard'));
    expect(
      find.byWidgetPredicate((w) {
        final k = w.key;
        return k is ValueKey<String> && k.value.startsWith('leaderboard-row-');
      }),
      findsNothing,
    );
    expect(key('project-sidebar-humans'), findsNothing);
    expect(find.textContaining('agents shipping'), findsNothing);
    expect(tester.takeException(), isNull);
    await end(tester, c);
  });

  testWidgets(
    'a server before the leaderboard shows no Top Teams, and asks nothing more of it',
    (tester) async {
      await tester.binding.setSurfaceSize(const Size(1300, 800));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      final server = swarm();
      final c = server.controller(
        account: 'owner',
        initial: {'tabId': 'tab', 'accountId': 'owner', 'selectedId': 'lead'},
      );
      await tester.runAsync(c.refresh);
      await tester.pumpWidget(
        MaterialApp(
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
      await _settle(tester);
      expect(server.shippingReads, hasLength(1));
      expect(key('project-sidebar-humans'), findsNothing);
      expect(tester.takeException(), isNull);
      await end(tester, c);
    },
  );
}
