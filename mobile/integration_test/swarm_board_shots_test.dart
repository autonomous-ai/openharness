import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';

import 'package:harness_mobile/notify/system_notices.dart';
import 'package:harness_mobile/settings/experimental_features.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart' as grid;
import 'package:harness_mobile/shared/theme/color_palette.dart';
import 'package:harness_mobile/swarm/swarm_project_page.dart';
import 'package:harness_mobile/swarm/swarm_session.dart';

import '../test/swarm/swarm_board_fixture.dart';
import '../test/swarm/swarm_fixture.dart';
import '../test/voice_fakes.dart' show MemoryKeyValueStore;

/// A project's Board on a simulator (task #3821), a screenshot at each column
/// and at the Chat tab, in the dark theme and then the light one.
///
/// Every answer is scripted in memory ([boardBackend]): nothing reaches an
/// account, a machine or the backend.
///
///     flutter drive -d <simulator> --driver=test_driver/journey_driver.dart \
///       --target=integration_test/swarm_board_shots_test.dart
///
/// Screenshots land in `HARNESS_JOURNEY_OUT` (default `build/journey/`).
void main() {
  final binding = IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  for (final palette in [HarnessPalette.graphite, HarnessPalette.mist]) {
    final theme = palette.isDark ? 'dark' : 'light';
    testWidgets('the Board, $theme', (tester) async {
      grid.AppTheme.palette.value = palette;
      grid.AppTheme.brightness.value = palette.brightness;
      final account = ValueNotifier<String?>(me);
      final host = SwarmHost(
        accountId: () => account.value,
        account: account,
        request: boardBackend().request,
        notices: SilentSystemNotices(),
        features: ExperimentalFeaturesStore(storage: MemoryKeyValueStore())
          ..value = {PhoneExperiment.swarm},
      )..foreground = false;
      addTearDown(host.dispose);
      var step = 0;
      Future<void> wait([int ms = 900]) async {
        for (var elapsed = 0; elapsed < ms; elapsed += 100) {
          await tester.pump(const Duration(milliseconds: 100));
        }
      }

      Future<void> shot(String name) async {
        await wait();
        step++;
        await binding.takeScreenshot(
          'board-$theme-${step.toString().padLeft(2, '0')}-$name',
        );
      }

      Finder key(String value) => find.byKey(ValueKey(value));
      Future<void> page(double dx) async {
        await tester.fling(key('swarm-board-pages'), Offset(dx, 0), 1500);
        await wait(500);
      }

      await tester.pumpWidget(
        grid.BrightnessScope(
          child: MaterialApp(
            debugShowCheckedModeBanner: false,
            theme: grid.buildAppTheme(brightness: palette.brightness),
            builder: (context, child) =>
                SwarmScope(notifier: host, child: child!),
            home: const SwarmProjectPage(swarmId: tab, projectId: project),
          ),
        ),
      );
      for (
        var i = 0;
        i < 200 && key('swarm-board-card-g1').evaluate().isEmpty;
        i++
      ) {
        await tester.pump(const Duration(milliseconds: 100));
      }
      expect(key('swarm-board-card-g1'), findsOneWidget);

      await shot('working');
      await page(400);
      await shot('next-up');
      await page(400);
      await shot('proposal');
      for (final (column, name) in [
        (3, 'done'),
        (4, 'merged'),
        (5, 'shipped'),
      ]) {
        for (var i = 0; i < (column == 3 ? 3 : 1); i++) {
          await page(-400);
        }
        await shot(name);
      }
      await tester.tap(key('swarm-project-tab-chat'));
      await shot('chat');
    });
  }
}
