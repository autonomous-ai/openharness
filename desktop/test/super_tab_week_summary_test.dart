import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_icons.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/leaderboard/model.dart';
import 'package:harness/super_tabs/leaderboard/week_summary.dart';
import 'package:harness/super_tabs/view.dart';

import 'support/humans_fixture.dart';
import 'support/super_tab_fixture.dart';

/// This week at the top of the right sidebar (Dee, 2026-10-29): Faster,
/// Better and Cheaper against last week. The arrow means better in both
/// directions; words say the same for a screen reader and on hover, with the
/// last four weeks.
const _minute = 60000;

Map<String, dynamic> _week(
  int back, {
  int? requestMs,
  int reviewed = 0,
  int passed = 0,
}) => {
  'week':
      DateTime.utc(2026, 10, 26).millisecondsSinceEpoch - back * 7 * 86400000,
  'shipped': requestMs == null ? 0 : 3,
  'medianRequestMs': requestMs,
  'firstReview': {'reviewed': reviewed, 'passed': passed},
};

ConversationServer _summarySwarm(List<Map<String, dynamic>> weeks) {
  final server = humansSwarm();
  server.leaderboard!['weeks'] = weeks;
  return server;
}

/// Better this week on both: 48 min against 60 (20% faster), 82% against 76%.
final _better = [
  _week(0, requestMs: 48 * _minute, reviewed: 34, passed: 28),
  _week(1, requestMs: 60 * _minute, reviewed: 25, passed: 19),
  _week(2, requestMs: 90 * _minute, reviewed: 10, passed: 5),
  _week(3),
];

void main() {
  Future<SuperTabController> show(
    WidgetTester tester,
    ConversationServer server,
  ) async {
    await tester.binding.setSurfaceSize(const Size(1300, 900));
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
            machineName: (_) => 'Mac Studio',
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

  Finder row(String name) => find.byKey(ValueKey('week-summary-$name'));
  Finder inRow(String name, Finder finder) =>
      find.descendant(of: row(name), matching: finder);
  Icon arrow(WidgetTester tester, String name) =>
      tester.widget<Icon>(inRow(name, find.byType(Icon)));

  testWidgets(
    'sits above the leaderboard with Faster, Better and Cheaper against last week',
    (tester) async {
      final controller = await show(tester, _summarySwarm(_better));
      final summary = find.byKey(const ValueKey('week-summary'));
      expect(
        find.descendant(of: summary, matching: find.text('This week')),
        findsOneWidget,
      );
      expect(
        tester.getBottomLeft(summary).dy,
        lessThanOrEqualTo(
          tester
              .getTopLeft(find.byKey(const ValueKey('leaderboard-tab-humans')))
              .dy,
        ),
      );
      expect(inRow('faster', find.text('Faster')), findsOneWidget);
      expect(inRow('faster', find.text('time to ship')), findsOneWidget);
      expect(inRow('faster', find.text('48 min')), findsOneWidget);
      expect(inRow('faster', find.text('20%')), findsOneWidget);
      expect(arrow(tester, 'faster').icon, AppIcons.arrowUp);
      expect(arrow(tester, 'faster').color, grid.AppPalette.online);
      expect(
        inRow('better', find.text('passed review the first time')),
        findsOneWidget,
      );
      expect(inRow('better', find.text('82%')), findsOneWidget);
      expect(inRow('better', find.text('6 pts')), findsOneWidget);
      expect(arrow(tester, 'better').icon, AppIcons.arrowUp);
      expect(inRow('cheaper', find.text('per shipped change')), findsOneWidget);
      expect(inRow('cheaper', find.text('Measuring')), findsOneWidget);
      expect(inRow('cheaper', find.byType(Icon)), findsNothing);
      await close(tester, controller);
    },
  );

  testWidgets(
    'says each trend in words, and shows the last four weeks on hover',
    (tester) async {
      final semantics = tester.ensureSemantics();
      final controller = await show(tester, _summarySwarm(_better));
      expect(
        find.bySemanticsLabel(
          'Faster: 48 min to ship, 20% faster than last week',
        ),
        findsOneWidget,
      );
      expect(
        find.bySemanticsLabel(
          'Better: 82% passed review the first time, 6 points more than last week',
        ),
        findsOneWidget,
      );
      expect(
        find.byTooltip(
          '20% faster than last week\n'
          'This week: 48 min\nLast week: 1 h\n2 weeks ago: 1.5 h\n3 weeks ago: none shipped',
        ),
        findsOneWidget,
      );
      expect(
        find.byTooltip(
          '6 points more than last week\n'
          'This week: 82%\nLast week: 76%\n2 weeks ago: 50%\n3 weeks ago: none reviewed',
        ),
        findsOneWidget,
      );
      semantics.dispose();
      await close(tester, controller);
    },
  );

  testWidgets('points down in the error ink when a week got worse', (
    tester,
  ) async {
    final controller = await show(
      tester,
      _summarySwarm([
        _week(0, requestMs: 72 * _minute, reviewed: 10, passed: 6),
        _week(1, requestMs: 60 * _minute, reviewed: 10, passed: 8),
        _week(2),
        _week(3),
      ]),
    );
    expect(inRow('faster', find.text('20%')), findsOneWidget);
    expect(arrow(tester, 'faster').icon, AppIcons.arrowDown);
    expect(
      arrow(tester, 'faster').color,
      Theme.of(tester.element(row('faster'))).colorScheme.error,
    );
    expect(
      find.byTooltip(RegExp('^20% slower than last week')),
      findsOneWidget,
    );
    expect(inRow('better', find.text('20 pts')), findsOneWidget);
    expect(arrow(tester, 'better').icon, AppIcons.arrowDown);
    await close(tester, controller);
  });

  testWidgets(
    'shows no arrow without last week, and no number without this week',
    (tester) async {
      final controller = await show(
        tester,
        _summarySwarm([
          _week(0, reviewed: 4, passed: 3),
          _week(1),
          _week(2),
          _week(3),
        ]),
      );
      expect(inRow('faster', find.byType(Icon)), findsNothing);
      expect(inRow('faster', find.text('None shipped')), findsOneWidget);
      expect(inRow('better', find.text('75%')), findsOneWidget);
      expect(inRow('better', find.byType(Icon)), findsNothing);
      await close(tester, controller);
    },
  );

  test('compares weeks so that up always means better', () {
    final weeks = [for (final w in _better) SuperTabTeamWeek.fromJson(w)];
    expect(fasterChange(weeks), 20);
    expect(betterChange(weeks), 6);
    expect(fasterChange([weeks[0]]), isNull);
    expect(
      fasterChange([
        SuperTabTeamWeek.fromJson(_week(0, requestMs: 90 * _minute)),
        SuperTabTeamWeek.fromJson(_week(1, requestMs: 60 * _minute)),
      ]),
      -50,
    );
  });
}
