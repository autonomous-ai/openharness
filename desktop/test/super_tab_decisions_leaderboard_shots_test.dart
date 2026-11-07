// Audit findings 14 and 15 (task #4251): the all-clear Decisions and the
// weekly Leaderboard with the reader second, for the PR's pictures, light and
// dark. Writes nothing unless HARNESS_SUPER_TAB_CAPTURE names a folder.
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/decisions_page.dart';

import 'super_tab_decisions_empty_test.dart' show withMoving;
import 'super_tab_leaderboard_you_test.dart' show secondPlace;
import 'super_tab_pages_test.dart' show loaded;
import 'super_tab_weekly_leaderboard_test.dart' show showBoard;
import 'support/capture.dart';

final shots = Platform.environment['HARNESS_SUPER_TAB_CAPTURE'];

void main() {
  setUpAll(() => loadCaptureFonts(shots));

  for (final brightness in Brightness.values) {
    testWidgets('all-clear Decisions in ${brightness.name}', (tester) async {
      await tester.binding.setSurfaceSize(const Size(900, 640));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      // The app's own ink follows the theme it is drawn in.
      grid.AppTheme.brightness.value = brightness;
      addTearDown(() => grid.AppTheme.brightness.value = Brightness.dark);
      final activity = await loaded(tester, withMoving(4));
      await tester.pumpWidget(
        MaterialApp(
          debugShowCheckedModeBanner: false,
          theme: grid.buildAppTheme(brightness: brightness),
          home: Scaffold(
            body: SuperTabDecisionsPage(
              activity: activity,
              onOpenConversation: (_) {},
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.text('All clear'), findsOneWidget);
      await captureWindow(
        tester,
        shots,
        'decisions-all-clear-${brightness.name}',
      );
    });

    testWidgets('Leaderboard with the reader second in ${brightness.name}', (
      tester,
    ) async {
      await showBoard(tester, secondPlace(), brightness: brightness);
      await tester.pumpAndSettle();
      expect(find.text('You'), findsOneWidget);
      await captureWindow(tester, shots, 'leaderboard-you-${brightness.name}');
    });
  }
}
