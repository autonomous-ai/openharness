import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/runtime_platform.dart';
import 'package:harness/core/test_run.dart';
import 'package:integration_test/integration_test.dart';
import 'package:window_manager/window_manager.dart';

import '../test/device_window_activation_test.dart'
    show deviceWindowApp, deviceEvent;
import '../test/swarm_screen_test.dart' show mount;

void main() {
  if (!kUnderTest || !RuntimePlatform.isMacOS) {
    throw StateError('Run this macOS fixture with FLUTTER_TEST=1');
  }
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('device gestures reveal the hidden and minimized Mac window', (
    tester,
  ) async {
    await windowManager.ensureInitialized();
    await windowManager.show();
    await windowManager.focus();
    final app = deviceWindowApp();
    await mount(tester, app);
    try {
      for (final minimize in [false, true]) {
        if (minimize) {
          await windowManager.minimize();
        } else {
          await windowManager.hide();
        }
        await tester.pump(const Duration(milliseconds: 700));
        expect(await windowManager.isFocused(), isFalse);
        expect(app.inForeground, isFalse);

        // An automatically displayed question must leave the window alone.
        await deviceEvent(app, 'dial_open', {
          'agentId': 'a0',
          'reason': 'question',
        });
        await tester.pump(const Duration(milliseconds: 100));
        expect(await windowManager.isFocused(), isFalse);

        await deviceEvent(
          app,
          minimize ? 'dial_scroll' : 'dial_focus',
          minimize ? {'phase': 'down'} : {'agentId': 'a0'},
        );
        for (var attempt = 0; attempt < 40; attempt++) {
          await tester.pump(const Duration(milliseconds: 50));
          if (await windowManager.isFocused() &&
              !await windowManager.isMinimized()) {
            break;
          }
        }
        expect(await windowManager.isVisible(), isTrue);
        expect(await windowManager.isMinimized(), isFalse);
        expect(await windowManager.isFocused(), isTrue);
        expect(app.allPanes, hasLength(1));
        expect(app.paneFocusByUser, isFalse);
      }
    } finally {
      await windowManager.restore();
      await windowManager.show();
      await tester.pumpWidget(const SizedBox());
      app.dispose();
    }
  });
}
