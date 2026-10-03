import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/test_run.dart';
import 'package:integration_test/integration_test.dart';
import 'package:window_manager/window_manager.dart';

import '../test/memory_companion_recovery_test.dart' as recovery;

/// The same complete workspace journey uses in-memory stores and fake transports.
/// It cannot run with production pollers enabled or launch a real companion.
void main() {
  if (!kUnderTest) {
    throw StateError('Native memory recovery requires FLUTTER_TEST=1');
  }
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  setUpAll(() async {
    await windowManager.ensureInitialized();
    await windowManager.setSize(const Size(1280, 1000));
  });
  testWidgets('native recovery test window has foreground focus', (tester) async {
    // Check a rendered window: AppKit activation is asynchronous, and this
    // fixture otherwise reaches the assertion before mounting its first frame.
    await tester.pumpWidget(
      const MaterialApp(
        home: Scaffold(body: Text('Synthetic memory recovery fixture')),
      ),
    );
    await windowManager.show();
    await windowManager.focus();
    // A native reviewer can activate this exact synthetic window when the
    // platform launcher cannot foreground it. The assertion remains required.
    final manualReview =
        Platform.environment['HARNESS_NATIVE_FOCUS_REVIEW'] == '1';
    if (manualReview) {
      debugPrint('Synthetic memory fixture is ready for foreground review.');
    }
    final focusTimeout = Duration(seconds: manualReview ? 60 : 3);
    final deadline = Stopwatch()..start();
    var focused = await windowManager.isFocused();
    while (!focused && deadline.elapsed < focusTimeout) {
      await tester.pump(const Duration(milliseconds: 100));
      focused = await windowManager.isFocused();
    }
    expect(
      focused,
      isTrue,
      reason:
          'Native focus after a rendered frame and bounded activation wait '
          '(visible=${await windowManager.isVisible()}, '
          'minimized=${await windowManager.isMinimized()}).',
    );
  });
  recovery.memoryCompanionRecoveryTests(native: true);
}
