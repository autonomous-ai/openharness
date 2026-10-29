import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/leaderboard/model.dart';
import 'package:harness/super_tabs/leaderboard/week_summary.dart';

/// This week in the 280-point sidebar at 200% text, with the Mac's own system
/// face (review of #2117): every label and caption stays whole; enlarged text
/// gets room instead of being cut. Only where that face exists.
const _systemFace = '/System/Library/Fonts/SFNS.ttf';

void main() {
  setUpAll(() async {
    if (!File(_systemFace).existsSync()) return;
    final bytes = ByteData.sublistView(await File(_systemFace).readAsBytes());
    for (final family in [
      '.AppleSystemUIFont',
      'SF Pro Text',
      'Ubuntu Sans',
      'Roboto',
    ]) {
      await (FontLoader(family)..addFont(Future.value(bytes))).load();
    }
  });

  testWidgets(
    'keeps every label, caption and figure whole at 200% text in the sidebar',
    (tester) async {
      SuperTabTeamWeek week(int at, int requestMs, int reviewed, int passed) =>
          SuperTabTeamWeek.fromJson({
            'week': at,
            'shipped': 1,
            'medianRequestMs': requestMs,
            'firstReview': {'reviewed': reviewed, 'passed': passed},
          });
      await tester.pumpWidget(
        MaterialApp(
          theme: grid.buildAppTheme(brightness: Brightness.light),
          home: MediaQuery(
            data: const MediaQueryData(textScaler: TextScaler.linear(2)),
            child: Scaffold(
              body: Center(
                child: SizedBox(
                  width: 280,
                  child: LeaderboardWeekSummary(
                    weeks: [
                      week(1000, 48 * 60000, 34, 28),
                      week(0, 60 * 60000, 25, 19),
                    ],
                    weekNames: const ['this week', 'last week'],
                  ),
                ),
              ),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull);
      final cut = [
        for (final text in [
          'Faster',
          'Better',
          'Cheaper',
          'time to ship',
          'passed review the first time',
          'per shipped change',
          'Measuring',
          '48 min',
          '82%',
        ])
          if (tester
              .renderObject<RenderParagraph>(find.text(text))
              .didExceedMaxLines)
            text,
      ];
      expect(cut, isEmpty);
    },
    skip: !File(_systemFace).existsSync(),
  );
}
