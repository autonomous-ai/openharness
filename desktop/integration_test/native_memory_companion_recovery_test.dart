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
    await windowManager.show();
    await windowManager.focus();
    await Future<void>.delayed(const Duration(milliseconds: 100));
  });
  testWidgets('native recovery test window has foreground focus', (_) async {
    expect(await windowManager.isFocused(), isTrue);
  });
  recovery.memoryCompanionRecoveryTests(native: true);
}
