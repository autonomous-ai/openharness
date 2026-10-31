/// Signed out, Settings is the page over the sign-in page, and ⌘W and Escape
/// close it as Back to app does (Scholes's end-to-end test: there was no
/// workspace under it to hear ⌘W, so it stayed open).
library;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/app_shell.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/measurement/product_measurement.dart';
import 'package:harness/screens/login_screen.dart';
import 'package:harness/settings/settings_screen.dart';
import 'package:harness/state/app_state.dart';
import 'package:package_info_plus/package_info_plus.dart';

import 'support/memory_key_value_store.dart';

Future<AppNotifier> _signedOut(WidgetTester tester) async {
  tester.view.devicePixelRatio = 1;
  tester.view.physicalSize = const Size(1100, 760);
  addTearDown(tester.view.reset);
  final usage = ProductMeasurement(
    surface: 'desktop',
    automatic: false,
    setupStorage: MemoryKeyValueStore(),
    sendSetup: (_) async => {'accepted': true},
  );
  await usage.setupChoiceReady;
  final app =
      AppNotifier(
          config: AppConfig.dev,
          authSession: AuthSession(storage: MemoryKeyValueStore()),
          productMeasurement: usage,
        )
        ..signedIn = false
        ..status = AppStatus.unauthenticated;
  addTearDown(app.dispose);
  await tester.pumpWidget(
    ProviderScope(
      overrides: [appStateProvider.overrideWithValue(app)],
      child: HarnessApp(authenticatedScreen: (_) => const SizedBox.shrink()),
    ),
  );
  await tester.pump(const Duration(milliseconds: 400));
  expect(find.byType(LoginScreen), findsOneWidget);
  return app;
}

/// Settings from the app menu, as macOS's pre-workspace Settings item sends.
Future<void> _openSettings(WidgetTester tester) async {
  tester.binding.defaultBinaryMessenger.handlePlatformMessage(
    'harness/app_menu',
    const StandardMethodCodec().encodeMethodCall(const MethodCall('settings')),
    (_) {},
  );
  await tester.pumpAndSettle();
  expect(find.byType(SettingsScreen), findsOneWidget);
}

Future<void> _press(
  WidgetTester tester,
  LogicalKeyboardKey key, {
  bool meta = false,
}) async {
  if (meta) await tester.sendKeyDownEvent(LogicalKeyboardKey.metaLeft);
  await tester.sendKeyEvent(key);
  if (meta) await tester.sendKeyUpEvent(LogicalKeyboardKey.metaLeft);
  await tester.pumpAndSettle();
}

void main() {
  PackageInfo.setMockInitialValues(
    appName: 'Harness',
    packageName: 'ai.autonomous.harness',
    version: '1.2.80',
    buildNumber: '80',
    buildSignature: '',
  );

  testWidgets('signed out, ⌘W closes Settings and the sign-in page is back', (
    tester,
  ) async {
    await _signedOut(tester);
    await _openSettings(tester);
    await _press(tester, LogicalKeyboardKey.keyW, meta: true);
    expect(find.byType(SettingsScreen), findsNothing);
    expect(find.byType(LoginScreen), findsOneWidget);

    // Again after a click in Settings moved the keyboard off its search.
    await _openSettings(tester);
    await tester.tap(find.byKey(const ValueKey('product-usage-sharing')));
    await tester.pumpAndSettle();
    await _press(tester, LogicalKeyboardKey.keyW, meta: true);
    expect(find.byType(SettingsScreen), findsNothing);
    expect(find.byType(LoginScreen), findsOneWidget);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox.shrink());
  }, variant: TargetPlatformVariant.only(TargetPlatform.macOS));

  testWidgets(
    'signed out, Escape closes Settings and the sign-in page is back',
    (tester) async {
      await _signedOut(tester);
      await _openSettings(tester);
      await _press(tester, LogicalKeyboardKey.escape);
      expect(find.byType(SettingsScreen), findsNothing);
      expect(find.byType(LoginScreen), findsOneWidget);

      // Again after a click in Settings moved the keyboard off its search.
      await _openSettings(tester);
      await tester.tap(find.byKey(const ValueKey('product-usage-sharing')));
      await tester.pumpAndSettle();
      await _press(tester, LogicalKeyboardKey.escape);
      expect(find.byType(SettingsScreen), findsNothing);
      expect(find.byType(LoginScreen), findsOneWidget);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox.shrink());
    },
    variant: TargetPlatformVariant.only(TargetPlatform.macOS),
  );

  testWidgets(
    'typing w, or another ⌘ key, in Settings\' search keeps Settings open',
    (tester) async {
      await _signedOut(tester);
      await _openSettings(tester);
      await _press(tester, LogicalKeyboardKey.keyW);
      await _press(tester, LogicalKeyboardKey.keyE, meta: true);
      expect(find.byType(SettingsScreen), findsOneWidget);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox.shrink());
    },
    variant: TargetPlatformVariant.only(TargetPlatform.macOS),
  );
}
