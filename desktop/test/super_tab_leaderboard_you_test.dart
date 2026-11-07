// Audit finding 15 (task #4211): the reader finds themselves on the weekly
// Leaderboard (their row filled and saying "You"), a week with no streak reads
// a dash, and the top three each carry a mark beside their place.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/leaderboard/weekly_page.dart';

import 'super_tab_weekly_leaderboard_test.dart' show showBoard, weeklySwarm;
import 'support/super_tab_fixture.dart';

/// The weekly board with the reader, Dee (`peer`), second; a teammate is
/// also called Dee, so only the account says which row is the reader's.
ConversationServer secondPlace() {
  final server = weeklySwarm();
  final people = (server.leaderboard!['people'] as List)
      .cast<Map<String, dynamic>>();
  final dee = people.removeAt(0)..['rank'] = 2;
  people.first['rank'] = 1;
  people.insert(1, dee);
  people.firstWhere((p) => p['personId'] == 'scholes')['displayName'] = 'Dee';
  return server;
}

Finder _row(String id) => find.byKey(ValueKey('weekly-row-$id'));

Finder _in(String id, Finder what) =>
    find.descendant(of: _row(id), matching: what);

Color? _fill(WidgetTester tester, String id) =>
    (tester.widget<Container>(_row(id)).decoration as BoxDecoration?)?.color;

void main() {
  testWidgets('the reader\'s row is filled and says You, found by account', (
    tester,
  ) async {
    await showBoard(tester, secondPlace());
    await tester.pumpAndSettle();
    expect(_in('peer', find.text('You')), findsOneWidget);
    expect(find.text('You'), findsOneWidget);
    expect(_fill(tester, 'peer'), grid.AppSurface.selectedFill);
    for (final other in ['tony', 'owner', 'scholes']) {
      expect(_fill(tester, other), isNot(grid.AppSurface.selectedFill));
    }
    expect(tester.takeException(), isNull);
  });

  testWidgets('You follows the signed-in account to a new controller', (
    tester,
  ) async {
    final server = secondPlace();
    await showBoard(tester, server);
    await tester.pumpAndSettle();
    final ken = server.controller(
      account: 'owner',
      initial: {'tabId': 'tab', 'accountId': 'owner', 'selectedId': 'lead'},
    );
    addTearDown(ken.dispose);
    await ken.refresh();
    await tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: Brightness.light),
        home: Scaffold(body: SuperTabWeeklyLeaderboardPage(controller: ken)),
      ),
    );
    await tester.pumpAndSettle();
    expect(_in('owner', find.text('You')), findsOneWidget);
    expect(_in('peer', find.text('You')), findsNothing);
    expect(_fill(tester, 'owner'), grid.AppSurface.selectedFill);
  });

  testWidgets('a week with no streak reads a dash, not 0d', (tester) async {
    await showBoard(tester, secondPlace());
    await tester.pumpAndSettle();
    expect(find.text('0d'), findsNothing);
    expect(_in('scholes', find.text('–')), findsOneWidget);
    expect(_in('tony', find.text('2d')), findsOneWidget);
  });

  testWidgets('the top three carry a mark beside their place, said in words', (
    tester,
  ) async {
    await showBoard(tester, secondPlace());
    await tester.pumpAndSettle();
    final marks = find.byType(Icon);
    for (final (id, place, words) in [
      ('tony', '1', 'Number one this week'),
      ('peer', '2', 'Number two this week'),
      ('owner', '3', 'Number three this week'),
    ]) {
      expect(tester.widget<Icon>(_in(id, marks)).semanticLabel, words);
      // The place is still its numeral, beside the mark.
      expect(_in(id, find.text(place)), findsWidgets);
    }
    expect(_in('scholes', marks), findsNothing);
  });
}
