import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:window_manager/window_manager.dart';
import 'package:harness/core/test_run.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/view.dart';

import '../test/support/swarm_v4_data.dart';
import '../test/swarm_state_test.dart' show createApp;
import 'flutter_test_config.dart';

/// Swarm v4 in a real macOS window with lampOS's review data, for anh Dee to click through. It never opens a production
/// daemon, account or database, and it stays open for [_open] (set SWARM_V4_REVIEW_MINUTES to change it).
const _open = Duration(
  minutes: int.fromEnvironment('SWARM_V4_REVIEW_MINUTES', defaultValue: 600),
);

void main() {
  if (!kUnderTest) throw StateError('Requires FLUTTER_TEST=1');
  // A person clicks and types in this window: a test binding drops real input unless told to pass it on.
  ensureNativeTestBinding()
    ..framePolicy = LiveTestWidgetsFlutterBindingFramePolicy.fullyLive
    ..shouldPropagateDevicePointerEvents = true;
  testWidgets(
    'Swarm v4 review',
    (tester) async {
      await windowManager.ensureInitialized();
      await windowManager.setSize(const Size(1440, 900));
      await windowManager.setTitle('Swarm v4 — review with test data');
      await windowManager.show();
      await windowManager.focus();
      final server = swarmV4Server();
      final c = server.controller(
        account: 'owner',
        initial: {'tabId': 'tab', 'accountId': 'owner', 'selectedId': 'lead'},
      );
      await tester.runAsync(c.refresh);
      final app = createApp();
      await tester.pumpWidget(
        ValueListenableBuilder(
          valueListenable: grid.AppTheme.brightness,
          builder: (context, brightness, _) => MaterialApp(
            debugShowCheckedModeBanner: false,
            theme: grid.buildAppTheme(brightness: brightness),
            home: Scaffold(
              body: SuperTabView(
                controller: c,
                app: app,
                onNewSwarm: () {},
                onAddAgent: (_) {},
                onOpenTerminal: (_) {},
                machineName: (_) => 'Mac Studio',
              ),
            ),
          ),
        ),
      );
      await tester.runAsync(() => Future<void>.delayed(_open));
    },
    variant: TargetPlatformVariant.only(TargetPlatform.macOS),
    timeout: const Timeout(Duration(hours: 12)),
  );
}
