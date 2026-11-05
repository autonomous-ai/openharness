import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/manage_page.dart';
import 'package:harness/super_tabs/model.dart';
import 'package:harness/super_tabs/scorecard.dart';
import 'package:harness/super_tabs/scorecard_view.dart';

import 'support/super_tab_fixture.dart';

Map<String, dynamic> _day(String on, Map<String, dynamic> figures) => {
  'projectId': 'p0',
  'on': on,
  'timeZone': 'Asia/Ho_Chi_Minh',
  'computedAt': 0,
  'figures': {
    'limits': {'lostAfterMinutes': 10, 'askLookbackDays': 7},
    'asksShipped': 0,
    'askToShipMedianMinutes': null,
    'askToShipMaxMinutes': null,
    'unansweredAsks': 0,
    'oldestUnansweredAskMinutes': null,
    'idleMinutes': 0,
    'lostLeftAlone': 0,
    'lostLeftMinutes': 0,
    'fixesAfterMerge': 0,
    'corrections': 0,
    'starts': 0,
    'startsFailed': 0,
    'routeDecisions': 0,
    'typedIntoPm': 0,
    'ackPosts': 0,
    'agentPosts': 0,
    ...figures,
  },
};

final _projects = [
  SuperTabProject.fromJson(projectFixture('p0', 'openharness', 'chat-0')),
  SuperTabProject.fromJson(projectFixture('p1', 'lampos', 'chat-1')),
];

void main() {
  group('scorecard figures as the table says them', () {
    test('minutes, counts with failures, and a day with no row', () {
      expect(scorecardDuration(null), '–');
      expect(scorecardDuration(45), '45m');
      expect(scorecardDuration(190), '3h10');
      expect(scorecardDuration(600), '10h');
      final day = SuperTabScorecardDay.fromJson(
        _day('2026-11-05', {'starts': 31, 'startsFailed': 3}),
      );
      expect(
        scorecardRows
            .firstWhere((r) => r.label == 'Agent starts (failed)')
            .cell(day),
        '31 (3)',
      );
      expect(scorecardRows.first.cell(null), '–');
    });

    test('columns are the 7 days back from the newest row', () {
      expect(scorecardColumns('2026-11-05'), [
        '2026-11-05',
        '2026-11-04',
        '2026-11-03',
        '2026-11-02',
        '2026-11-01',
        '2026-10-31',
        '2026-10-30',
      ]);
    });
  });

  group('the reader', () {
    test('reads one project and says when the server is too old', () async {
      final asked = <String>[];
      var answer = <String, dynamic>{
        'days': [
          _day('2026-11-05', {'asksShipped': 9}),
        ],
      };
      Object? failure;
      final reader = SuperTabScorecardReader(
        tabId: 'tab',
        request: (method, path, {body}) async {
          asked.add('$method $path');
          if (failure != null) throw failure;
          return answer;
        },
      );
      await reader.show('p0');
      expect(asked, ['GET /api/super-tabs/tab/scorecard?projectId=p0']);
      expect(reader.days.single.figures['asksShipped'], 9);
      failure = const SuperTabFailure(
        'NOT_FOUND',
        'Not found',
        statusCode: 404,
      );
      answer = const {};
      await reader.refresh();
      expect(reader.days, isEmpty);
      expect(reader.error, 'The scorecard needs a newer Harness server.');
    });
  });

  testWidgets('Manage has a Scorecard tab', (tester) async {
    SuperTabManageTab? chosen;
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: SuperTabManageTabs(
            selected: SuperTabManageTab.machines,
            onChoose: (tab) => chosen = tab,
          ),
        ),
      ),
    );
    await tester.tap(find.byKey(const ValueKey('super-manage-tab-scorecard')));
    expect(chosen, SuperTabManageTab.scorecard);
  });

  testWidgets('shows the open project\'s last days, a missing day as a dash', (
    tester,
  ) async {
    final reader = SuperTabScorecardReader(
      tabId: 'tab',
      request: (method, path, {body}) async => {
        'days': [
          _day('2026-11-05', {
            'asksShipped': 9,
            'askToShipMedianMinutes': 190,
            'idleMinutes': 95,
          }),
          // 11-04 failed: no row.
          _day('2026-11-03', {'asksShipped': 7}),
        ],
      },
    );
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: SuperTabScorecardView(
            projects: _projects,
            projectId: 'p0',
            reader: reader,
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.text('Asks shipped'), findsOneWidget);
    expect(find.text('11-05'), findsOneWidget);
    expect(find.text('3h10'), findsOneWidget);
    expect(find.text('1h35'), findsOneWidget);
    final shipped = find.byKey(const ValueKey('scorecard-asksShipped'));
    final cells = tester
        .widgetList<Text>(
          find.descendant(of: shipped, matching: find.byType(Text)),
        )
        .map((t) => t.data)
        .toList();
    expect(cells.take(4), ['Asks shipped', '9', '–', '7']);
    reader.dispose();
  });
}
