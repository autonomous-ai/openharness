import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/settings/settings_screen.dart';
import 'package:harness/settings/settings_section.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/state/app_state.dart';

import 'support/real_fonts.dart';

/// Settings on a phone (the web build's compact width): the list of sections
/// and one section take turns instead of squeezing side by side.
void main() {
  setUpAll(loadRealFonts);
  final boundary = GlobalKey();
  const settingsButton = Key('open-settings');

  Future<void> mount(
    WidgetTester tester,
    Size size, {
    SettingsSection? initialSection,
  }) async {
    final notifier = AppNotifier(
      config: AppConfig.dev,
      authSession: AuthSession(),
      configStore: null,
    );
    addTearDown(notifier.dispose);
    tester.view.devicePixelRatio = 1;
    tester.view.physicalSize = size;
    addTearDown(tester.view.reset);
    await tester.pumpWidget(
      RepaintBoundary(
        key: boundary,
        child: MaterialApp(
          theme: grid.buildAppTheme(brightness: Brightness.dark),
          home: Builder(
            builder: (context) => Scaffold(
              body: TextButton(
                key: settingsButton,
                onPressed: () => showSettingsScreen(
                  context,
                  notifier,
                  initialSection: initialSection,
                  source: 'test',
                  compactBelow: 720,
                ),
                child: const Text('Settings'),
              ),
            ),
          ),
        ),
      ),
    );
    await tester.tap(find.byKey(settingsButton));
    await tester.pumpAndSettle();
  }

  Future<void> capture(WidgetTester tester, String name) async {
    final output = Platform.environment['HARNESS_REFINEMENT_CAPTURE_DIR'];
    if (output == null) return;
    await tester.runAsync(() async {
      final image =
          await (boundary.currentContext!.findRenderObject()
                  as RenderRepaintBoundary)
              .toImage();
      final data = await image.toByteData(format: ui.ImageByteFormat.png);
      Directory(output).createSync(recursive: true);
      File('$output/$name.png').writeAsBytesSync(data!.buffer.asUint8List());
      image.dispose();
    });
  }

  final list = find.byKey(const Key('settings-back-button'));
  final back = find.byKey(const Key('settings-compact-back'));

  testWidgets('a phone opens the list, then one section at full width', (
    tester,
  ) async {
    await mount(tester, const Size(390, 844));
    expect(list, findsOneWidget);
    expect(back, findsNothing);
    // No keyboard thrown over the list the moment it opens.
    final search = find.byKey(const Key('settings-search-field'));
    expect(tester.widget<TextField>(search).focusNode!.hasFocus, isFalse);
    await capture(tester, 'settings-phone-list');

    await tester.tap(find.text(SettingsSection.notifications.label));
    await tester.pumpAndSettle();
    expect(list, findsNothing);
    expect(back, findsOneWidget);
    await capture(tester, 'settings-phone-section');

    await tester.tap(back);
    await tester.pumpAndSettle();
    expect(list, findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('system Back leaves the section before leaving Settings', (
    tester,
  ) async {
    await mount(
      tester,
      const Size(390, 844),
      initialSection: SettingsSection.notifications,
    );
    expect(back, findsOneWidget);
    await tester.binding.handlePopRoute();
    await tester.pumpAndSettle();
    expect(list, findsOneWidget);
    await tester.binding.handlePopRoute();
    await tester.pumpAndSettle();
    expect(find.byType(SettingsScreen), findsNothing);
  });

  testWidgets('a wide window keeps the list beside the section', (
    tester,
  ) async {
    await mount(tester, const Size(1280, 800));
    expect(list, findsOneWidget);
    expect(back, findsNothing);
    expect(find.text(SettingsSection.notifications.label), findsOneWidget);
  });
}
