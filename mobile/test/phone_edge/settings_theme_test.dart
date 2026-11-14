import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/core/models.dart';
import 'package:harness_mobile/phone/settings_page.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/shared/theme/appearance_builder.dart';
import 'package:harness_mobile/shared/theme/appearance_prefs_store.dart';
import 'package:harness_mobile/shared/theme/color_palette.dart';
import 'package:harness_mobile/state/app_state.dart';
import 'package:package_info_plus/package_info_plus.dart';

import '../voice_fakes.dart' show MemoryKeyValueStore;
import 'edge_fixture.dart';

/// Settings keeps App colors, which names the palette on screen and, picked, hands light and dark
/// back to the palette.
void main() {
  setUpAll(
    () => PackageInfo.setMockInitialValues(
      appName: 'Harness',
      packageName: 'ai.autonomous.harness',
      version: '1.2.3',
      buildNumber: '456',
      buildSignature: '',
    ),
  );

  tearDown(() {
    AppTheme.palette.value = HarnessPalette.graphite;
    AppTheme.brightness.value = Brightness.dark;
    AppTheme.terminalPaletteOverride.value = null;
  });

  /// [page] pushed over a page, in an app built as `HarnessApp` builds it: on the store's
  /// appearance ([AppearanceBuilder]), its brightness set from the palette as `_GridTokenScope`
  /// sets it — so a choice there repaints the whole app, as it does on a phone.
  Future<(AppNotifier, AppearancePrefsStore, MemoryKeyValueStore)> open(
    WidgetTester tester,
    Widget Function(AppNotifier app, AppearancePrefsStore store) page, {
    AppearancePrefs prefs = const AppearancePrefs(),
    Phone phone = largePhone,
    double textScale = 1,
  }) async {
    setPhone(tester, phone);
    final storage = MemoryKeyValueStore();
    final store = AppearancePrefsStore(storage: storage)..value = prefs;
    final app = edgeApp()
      ..currentUser = const CurrentUserProfile(
        id: 'u',
        name: 'Ada Lovelace',
        email: 'ada@example.com',
      );
    final shown = page(app, store);
    await tester.pumpWidget(
      AppearanceBuilder(
        store: store,
        builder: (context, prefs, palette) {
          AppTheme.brightness.value = palette.brightness;
          return phoneApp(
            Builder(
              builder: (context) => TextButton(
                onPressed: () =>
                    Navigator.of(context)
                        .push(MaterialPageRoute<void>(builder: (_) => shown)),
                child: const Text('open'),
              ),
            ),
            brightness: palette.brightness,
            textScale: textScale,
          );
        },
      ),
    );
    await tester.tap(find.text('open'));
    await frames(tester);
    return (app, store, storage);
  }

  /// Settings, opened from the terminal.
  Future<(AppNotifier, AppearancePrefsStore, MemoryKeyValueStore)> openSettings(
    WidgetTester tester, {
    AppearancePrefs prefs = const AppearancePrefs(),
  }) => open(
    tester,
    (app, store) => SettingsPage(notifier: app, large: false, appearance: store),
    prefs: prefs,
  );

  Future<void> close(WidgetTester tester, AppNotifier app) async {
    await tester.pumpWidget(const SizedBox());
    await tester.pump(const Duration(seconds: 3));
    app.dispose();
    await tester.pump(const Duration(seconds: 30));
  }

  Future<void> reveal(WidgetTester tester, Finder finder) async {
    await tester.scrollUntilVisible(
      finder,
      200,
      scrollable: find.byType(Scrollable).last,
    );
    await tester.pump();
  }

  /// The ground [page] is drawn on.
  Color? ground(WidgetTester tester, [Type page = SettingsPage]) => tester
      .widget<Scaffold>(
        find
            .descendant(
              of: find.byType(page),
              matching: find.byType(Scaffold),
            )
            .first,
      )
      .backgroundColor;

  group('opened from the terminal', () {
    testWidgets('keeps App colors and no Theme; it names the palette on '
        'screen', (tester) async {
      final (app, _, _) = await openSettings(
        tester,
        prefs: const AppearancePrefs(themeMode: AppThemeMode.light),
      );

      await reveal(tester, find.text('App colors'));
      expect(find.text('Theme'), findsNothing);
      expect(find.text('Paper'), findsOneWidget, reason: "Light's palette");
      await close(tester, app);
    });

    testWidgets('a palette picked there hands light and dark back to it', (
      tester,
    ) async {
      final (app, store, storage) = await openSettings(
        tester,
        prefs: const AppearancePrefs(themeMode: AppThemeMode.light),
      );

      await reveal(tester, find.text('App colors'));
      await tester.tap(find.text('App colors'));
      await frames(tester);
      await tester.tap(find.text('Midnight'));
      await frames(tester);

      expect(store.value.themeMode, isNull);
      expect(store.value.palette, HarnessPalette.midnight);
      expect(storage.values.containsKey('app_theme_mode'), isFalse);
      expect(AppTheme.palette.value, HarnessPalette.midnight);
      expect(ground(tester), HarnessPalette.midnight.background);
      await close(tester, app);
    });
  });
}
