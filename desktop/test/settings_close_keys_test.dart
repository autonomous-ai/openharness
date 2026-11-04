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
import 'package:harness/screens/swarm_menu_bus.dart';
import 'package:harness/settings/settings_screen.dart';
import 'package:harness/shortcuts/app_keymap.dart';
import 'package:harness/state/app_state.dart';
import 'package:package_info_plus/package_info_plus.dart';

import 'support/memory_key_value_store.dart';

Future<AppNotifier> _signedOut(WidgetTester tester, {AppKeymap? keymap}) async {
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
      child: HarnessApp(
        keymap: keymap,
        authenticatedScreen: (_) => const SizedBox.shrink(),
      ),
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

  testWidgets(
    'signed out, Settings hands AppKit only Close Tab\'s key; the menu rows '
    'keep theirs',
    (tester) async {
      // Before a workspace nothing else sends the keymap, and AppKit's Close
      // Tab, off while signed out, would take ⌘W first. Only ⌘W goes to
      // Flutter: ⌘, ⌘H and ⌘M stay with the menu (review of #2455).
      _resetBus();
      final keymap = AppKeymap();
      addTearDown(keymap.dispose);
      await _signedOut(tester, keymap: keymap);
      expect(swarmMenuBus.state.input, isNull);
      expect(swarmMenuBus.state.hints, isEmpty);
      await _openSettings(tester);
      expect(swarmMenuBus.state.input, {'cmd+w'});
      // Every menu row still gets its key from the whole keymap.
      expect(swarmMenuBus.state.hints['settings'], '⌘,');
      expect(swarmMenuBus.state.hints['machineList'], '⌘M');
      await _press(tester, LogicalKeyboardKey.keyW, meta: true);
      expect(find.byType(SettingsScreen), findsNothing);
      expect(find.byType(LoginScreen), findsOneWidget);
      await tester.pumpWidget(const SizedBox.shrink());
    },
    variant: TargetPlatformVariant.only(TargetPlatform.macOS),
  );

  testWidgets(
    'leaving the workspace (sign-out) takes back every key but Close Tab\'s',
    (tester) async {
      _resetBus();
      final keymap = AppKeymap();
      addTearDown(keymap.dispose);
      final app = await _signedOut(tester, keymap: keymap);
      app
        ..signedIn = true
        ..status = AppStatus.authenticated;
      app.notifyListeners();
      await tester.pumpAndSettle();
      expect(find.byType(LoginScreen), findsNothing);
      // The workspace's own keymap hands Flutter every key.
      swarmMenuBus.state.input = null;

      app
        ..signedIn = false
        ..status = AppStatus.unauthenticated;
      app.notifyListeners();
      await tester.pumpAndSettle();
      expect(find.byType(LoginScreen), findsOneWidget);
      expect(swarmMenuBus.state.input, {'cmd+w'});
      expect(swarmMenuBus.state.hints['settings'], '⌘,');
      await tester.pumpWidget(const SizedBox.shrink());
    },
    variant: TargetPlatformVariant.only(TargetPlatform.macOS),
  );
}

void _resetBus() {
  void reset() => swarmMenuBus.state
    ..hints = const {}
    ..input = null;
  reset();
  addTearDown(reset);
}
