import 'swarm_interactions_test.dart' show chord;

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/app_shell.dart';
import 'package:harness/screens/swarm_screen.dart';
import 'package:harness/settings/settings_screen.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/state/app_state.dart';
import 'package:harness/state/pane_preset.dart';
import 'package:harness/widgets/account_menu.dart';
import 'package:harness/widgets/setup_tour.dart';

import 'swarm_state_test.dart' show createApp;

Future<void> _menu(WidgetTester tester, String method) {
  final result = Completer<void>();
  const codec = StandardMethodCodec();
  tester.binding.defaultBinaryMessenger.handlePlatformMessage(
    'harness/app_menu',
    codec.encodeMethodCall(MethodCall(method)),
    (reply) {
      try {
        codec.decodeEnvelope(reply!);
        result.complete();
      } catch (error, stack) {
        result.completeError(error, stack);
      }
    },
  );
  return result.future;
}

Future<void> _mount(WidgetTester tester, AppNotifier app) async {
  tester.view.devicePixelRatio = 1;
  tester.view.physicalSize = const Size(1280, 800);
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
  app.status = AppStatus.authenticated;
  await tester.pumpWidget(
    ProviderScope(
      overrides: [appStateProvider.overrideWithValue(app)],
      child: HarnessApp(authenticatedScreen: _swarm),
    ),
  );
  await tester.pump();
}

void main() {
  testWidgets('desktop shell preserves platform text size and contrast', (
    tester,
  ) async {
    final app = createApp()..status = AppStatus.authenticated;
    tester.platformDispatcher.textScaleFactorTestValue = 1.6;
    tester.platformDispatcher.accessibilityFeaturesTestValue =
        const FakeAccessibilityFeatures(highContrast: true);
    addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
    addTearDown(tester.platformDispatcher.clearAccessibilityFeaturesTestValue);
    await tester.pumpWidget(
      ProviderScope(
        overrides: [appStateProvider.overrideWithValue(app)],
        child: HarnessApp(
          authenticatedScreen: (_) =>
              const Scaffold(body: Text('Readable desktop controls')),
        ),
      ),
    );
    await tester.pump();
    final context = tester.element(find.text('Readable desktop controls'));
    expect(MediaQuery.textScalerOf(context).scale(10), 16);
    expect(MediaQuery.highContrastOf(context), isTrue);
    final theme = Theme.of(context);
    final rim = theme.outlinedButtonTheme.style!.side!.resolve({})!;
    expect(rim.width, 2);
    expect(rim.color.a, greaterThan(.5));
    expect(theme.textTheme.bodyMedium!.fontFamily, grid.AppType.sansFamily);
    await tester.pumpWidget(const SizedBox());
    app.dispose();
  });

  testWidgets('held app menu commands open only one dialog', (tester) async {
    final app = createApp();
    await _mount(tester, app);
    final first = _menu(tester, 'showShortcuts');
    final repeated = _menu(tester, 'showShortcuts');
    await tester.pump(const Duration(milliseconds: 300));
    await repeated;
    expect(find.byType(Dialog), findsOneWidget);
    await _menu(tester, 'showLayout');
    expect(find.byType(Dialog), findsOneWidget);
    Navigator.of(tester.element(find.byType(Dialog))).pop();
    await tester.pump(const Duration(milliseconds: 300));
    await first;
    expect(find.byType(Dialog), findsNothing);
    final reopened = _menu(tester, 'showShortcuts');
    await tester.pump(const Duration(milliseconds: 300));
    expect(find.byType(Dialog), findsOneWidget);
    Navigator.of(tester.element(find.byType(Dialog))).pop();
    await tester.pump(const Duration(milliseconds: 300));
    await reopened;
    await tester.pumpWidget(const SizedBox());
    app.dispose();
  });

  testWidgets('repeated layout menu shortcut cycles the visible palette', (
    tester,
  ) async {
    final app = createApp();
    for (var i = 0; i < 3; i++) {
      await app.addAgentToSwarm('m', 'a$i');
    }
    await _mount(tester, app);
    final before = app.presetFor(3);
    final opened = _menu(tester, 'showLayout');
    final beforeFirstFrame = _menu(tester, 'showLayout');
    await tester.pump(const Duration(milliseconds: 300));
    await beforeFirstFrame;
    await _menu(tester, 'showLayout');
    await _menu(tester, 'showShortcuts');
    await tester.pump();
    expect(find.byType(Dialog), findsOneWidget);
    expect(app.presetFor(3), before);
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.pump(const Duration(milliseconds: 300));
    await opened;
    expect(app.presetFor(3), PanePreset.forCount(3)[1]);
    expect(find.byType(Dialog), findsNothing);
    await tester.pumpWidget(const SizedBox());
    app.dispose();
  });

  // A dropdown is an overlay entry, which stays above every route: a dialog or
  // page opened while one is up must close it first, or its rows stay live
  // over the modal (Sign out behind Check for Updates).
  testWidgets('a dialog or page that opens closes the open dropdown', (
    tester,
  ) async {
    final app = createApp();
    await _mount(tester, app);
    Future<void> openMenu() async {
      unawaited(
        showAccountMenu(
          tester.element(find.byType(SwarmScreen)),
          name: 'Tim',
          email: 'tim@example.com',
        ),
      );
      await tester.pump();
      expect(find.byType(AccountMenu), findsOneWidget);
    }

    await openMenu();
    final shortcuts = _menu(tester, 'showShortcuts');
    await tester.pump(const Duration(milliseconds: 300));
    expect(find.byType(Dialog), findsOneWidget);
    expect(find.byType(AccountMenu), findsNothing);
    Navigator.of(tester.element(find.byType(Dialog))).pop();
    await tester.pump(const Duration(milliseconds: 300));
    await shortcuts;

    // Settings from the app menu (a page, not a dialog) too.
    await openMenu();
    final settings = _menu(tester, 'settings');
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));
    expect(find.byType(SettingsScreen), findsOneWidget);
    expect(find.byType(AccountMenu), findsNothing);
    Navigator.of(tester.element(find.byType(SettingsScreen))).pop();
    await tester.pump(const Duration(milliseconds: 300));
    await settings;
    await tester.pumpWidget(const SizedBox());
    app.dispose();
  });

  testWidgets('app menu dialogs do not open over Settings', (tester) async {
    final app = createApp();
    await _mount(tester, app);
    await chord(tester, LogicalKeyboardKey.comma);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));
    expect(find.byType(SettingsScreen), findsOneWidget);
    for (final method in ['showShortcuts', 'showLayout']) {
      await _menu(tester, method);
    }
    await tester.pump();
    expect(find.byType(Dialog), findsNothing);
    expect(find.byType(SettingsScreen), findsOneWidget);
    Navigator.of(tester.element(find.byType(SettingsScreen))).pop();
    await tester.pump(const Duration(milliseconds: 300));
    await tester.pumpWidget(const SizedBox());
    app.dispose();
  });

  // Help ▸ Welcome Tour (macOS native menu, Linux menu bar): the first-run
  // slides again, full window, with no install line.
  testWidgets('Welcome Tour shows the slides until Escape or Close', (
    tester,
  ) async {
    final app = createApp();
    await _mount(tester, app);

    final shown = _menu(tester, 'welcomeTour');
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));
    expect(find.byType(SetupTour), findsOneWidget);
    expect(find.text(tourTagline), findsOneWidget);
    expect(find.byKey(const ValueKey('tour-install-line')), findsNothing);
    // Held or repeated, the menu opens one tour.
    await _menu(tester, 'welcomeTour');
    await _menu(tester, 'showShortcuts');
    await tester.pump(const Duration(milliseconds: 300));
    expect(find.byType(SetupTour), findsOneWidget);
    expect(find.byType(Dialog), findsNothing);

    await tester.sendKeyEvent(LogicalKeyboardKey.escape);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));
    await shown;
    expect(find.byType(SetupTour), findsNothing);

    final again = _menu(tester, 'welcomeTour');
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));
    await tester.tap(find.byKey(const ValueKey('tour-close')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));
    await again;
    expect(find.byType(SetupTour), findsNothing);

    await tester.pumpWidget(const SizedBox());
    app.dispose();
  });
}

/// The screen the desktop app mounts once signed in — the argument `HarnessApp`
/// now takes, so the shell itself does not have to know about either app.
Widget _swarm(AppNotifier app) => SwarmScreen(notifier: app);
