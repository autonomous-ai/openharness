import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/core/models.dart';
import 'package:harness_mobile/phone/settings_page.dart';
import 'package:harness_mobile/settings/experimental_features.dart';
import 'package:harness_mobile/shared/theme/app_space.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/shared/theme/app_type.dart';
import 'package:harness_mobile/shared/theme/appearance_builder.dart';
import 'package:harness_mobile/shared/theme/appearance_prefs_store.dart';
import 'package:harness_mobile/shared/theme/color_palette.dart';
import 'package:harness_mobile/state/app_state.dart';
import 'package:harness_mobile/swarm/swarm_row.dart';
import 'package:harness_mobile/swarm/swarm_style.dart';
import 'package:harness_mobile/swarm/swarm_you_page.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:package_info_plus/package_info_plus.dart';

import '../voice_fakes.dart' show MemoryKeyValueStore;
import 'edge_fixture.dart';

/// Swarm asks light or dark — Theme: System | Dark | Light — on its You (in its Settings, in App
/// colors' place, until 2026-11-04), and every screen turns on the tap; the terminal keeps the dark
/// side. Settings opened from the terminal keeps App colors, which names the palette on screen and,
/// picked, hands light and dark back to the palette.
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

  /// Settings, opened from Swarm's You ([swarm]) or from the terminal.
  Future<(AppNotifier, AppearancePrefsStore, MemoryKeyValueStore)> openSettings(
    WidgetTester tester, {
    required bool swarm,
    AppearancePrefs prefs = const AppearancePrefs(),
  }) => open(
    tester,
    (app, store) => SettingsPage(
      notifier: app,
      large: false,
      swarm: swarm,
      experiments: ExperimentalFeaturesStore(storage: MemoryKeyValueStore()),
      appearance: store,
    ),
    prefs: prefs,
  );

  /// Swarm's You, where its Theme is.
  Future<(AppNotifier, AppearancePrefsStore, MemoryKeyValueStore)> openYou(
    WidgetTester tester, {
    AppearancePrefs prefs = const AppearancePrefs(),
    Phone phone = largePhone,
    double textScale = 1,
  }) => open(
    tester,
    (_, store) => SwarmYouPage(appearance: store),
    prefs: prefs,
    phone: phone,
    textScale: textScale,
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

  Finder rowOf(String title) =>
      find.ancestor(of: find.text(title), matching: find.byType(SwarmRow));
  Finder segment(String label) =>
      find.descendant(of: rowOf('Theme'), matching: find.text(label));

  /// The fill a Theme segment wears: the primary ink when chosen.
  Color? fillOf(WidgetTester tester, String label) => tester
      .widget<Material>(
        find
            .ancestor(of: segment(label), matching: find.byType(Material))
            .first,
      )
      .color;

  /// The ground [page] is drawn on: Settings, or Swarm's You.
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

  group("on Swarm's You", () {
    testWidgets('Theme: System, Dark, Light — Dark, for the shipped Graphite — '
        'in the card with Settings', (tester) async {
      final (app, _, _) = await openYou(tester);

      await reveal(tester, find.text('Theme'));
      expect(find.text('App colors'), findsNothing);
      expect(
        find.descendant(
          of: rowOf('Theme'),
          matching: find.byIcon(LucideIcons.sunMoon300),
        ),
        findsOneWidget,
      );
      expect(
        find.descendant(
          of: find.ancestor(
            of: find.text('Theme'),
            matching: find.byType(SwarmGroup),
          ),
          matching: find.text('Settings'),
        ),
        findsOneWidget,
        reason: "in Settings' card",
      );
      for (final label in ['System', 'Dark', 'Light']) {
        expect(segment(label), findsOneWidget, reason: label);
      }
      expect(fillOf(tester, 'Dark'), AppPalette.textPrimary);
      expect(fillOf(tester, 'System'), Colors.transparent);
      expect(fillOf(tester, 'Light'), Colors.transparent);
      expect(
        tester.getSemantics(find.bySemanticsLabel('Dark')),
        isSemantics(label: 'Dark', isButton: true, isSelected: true),
      );
      expect(
        tester.getSemantics(find.bySemanticsLabel('Light')),
        isSemantics(label: 'Light', isButton: true, isSelected: false),
      );
      await close(tester, app);
    });

    testWidgets('a screen reader changes the theme: each segment not chosen '
        'takes a tap, the chosen one none (review of #2920)', (tester) async {
      final (app, store, storage) = await openYou(tester);
      await reveal(tester, find.text('Theme'));
      expect(
        tester.getSemantics(find.bySemanticsLabel('Light')),
        isSemantics(label: 'Light', isButton: true, isSelected: false, hasTapAction: true),
      );
      expect(
        tester.getSemantics(find.bySemanticsLabel('System')),
        isSemantics(label: 'System', isButton: true, isSelected: false, hasTapAction: true),
      );
      expect(
        tester.getSemantics(find.bySemanticsLabel('Dark')),
        isSemantics(label: 'Dark', isButton: true, isSelected: true, hasTapAction: false),
      );
      tester.semantics.tap(find.semantics.byLabel('Light'));
      await frames(tester);
      expect(store.value.themeMode, AppThemeMode.light);
      expect(storage.values['app_theme_mode'], 'light');
      expect(fillOf(tester, 'Light'), AppPalette.textPrimary);
      await close(tester, app);
    });

    testWidgets("Light turns the app light at once and is kept; the terminal's "
        'colours stay Graphite', (tester) async {
      final (app, store, storage) = await openYou(tester);
      expect(ground(tester, SwarmYouPage), HarnessPalette.graphite.background);

      await reveal(tester, find.text('Theme'));
      await tester.tap(segment('Light'));
      await frames(tester);

      expect(store.value.themeMode, AppThemeMode.light);
      expect(storage.values['app_theme_mode'], 'light');
      expect(AppTheme.palette.value, HarnessPalette.paper);
      expect(
        ground(tester, SwarmYouPage),
        HarnessPalette.paper.background,
        reason: 'now',
      );
      expect(fillOf(tester, 'Light'), AppPalette.textPrimary);
      expect(fillOf(tester, 'Dark'), Colors.transparent);
      expect(
        AppTheme.terminalPalette,
        HarnessPalette.graphite,
        reason: 'the terminal keeps the dark side',
      );

      await tester.tap(segment('Dark'));
      await frames(tester);
      expect(AppTheme.palette.value, HarnessPalette.graphite);
      expect(ground(tester, SwarmYouPage), HarnessPalette.graphite.background);
      await close(tester, app);
    });

    testWidgets('System follows the phone, and keeps following it', (
      tester,
    ) async {
      addTearDown(tester.platformDispatcher.clearPlatformBrightnessTestValue);
      tester.platformDispatcher.platformBrightnessTestValue = Brightness.light;
      final (app, store, _) = await openYou(tester);
      expect(
        AppTheme.palette.value,
        HarnessPalette.graphite,
        reason: 'untouched, a light phone changes nothing',
      );

      await reveal(tester, find.text('Theme'));
      await tester.tap(segment('System'));
      await frames(tester);
      expect(store.value.themeMode, AppThemeMode.system);
      expect(ground(tester, SwarmYouPage), HarnessPalette.paper.background);

      tester.platformDispatcher.platformBrightnessTestValue = Brightness.dark;
      await frames(tester);
      expect(ground(tester, SwarmYouPage), HarnessPalette.graphite.background);
      expect(fillOf(tester, 'System'), AppPalette.textPrimary);
      await close(tester, app);
    });

    testWidgets('a palette chosen in App colors stays on its side', (
      tester,
    ) async {
      final (app, _, _) = await openYou(
        tester,
        prefs: const AppearancePrefs(palette: HarnessPalette.midnight),
      );

      await reveal(tester, find.text('Theme'));
      await tester.tap(segment('Light'));
      await frames(tester);
      expect(AppTheme.palette.value, HarnessPalette.paper);
      expect(AppTheme.terminalPalette, HarnessPalette.midnight);

      await tester.tap(segment('Dark'));
      await frames(tester);
      expect(AppTheme.palette.value, HarnessPalette.midnight, reason: 'back');
      await close(tester, app);
    });

    testWidgets("draws a compact control with a control's words", (
      tester,
    ) async {
      final (app, _, _) = await openYou(tester, phone: smallPhone);
      await reveal(tester, find.text('Theme'));

      // The test font draws every glyph an em wide, so widths here are not a
      // phone's; the roles are.
      expect(
        tester.getSize(find.byType(SwarmSegments<AppThemeMode>)).height,
        AppControl.heightSmall + 2 * AppSpace.xs,
      );
      final words = tester.widget<Text>(segment('Light')).style!;
      expect(words.fontSize, AppType.bodySize);
      expect(words.fontWeight, AppFont.medium);
      expect(
        tester.widget<Text>(segment('Dark')).style!.fontWeight,
        AppFont.semibold,
        reason: 'the chosen one',
      );
      await close(tester, app);
    });

    testWidgets('fits the smallest phone at the largest text size', (
      tester,
    ) async {
      final errors = await collectErrors(() async {
        final (app, _, _) = await openYou(
          tester,
          phone: smallPhone,
          textScale: AppearancePrefs.uiSizeMax / AppearancePrefs.uiSizeDefault,
        );
        await reveal(tester, find.text('Theme'));
        for (final label in ['System', 'Dark', 'Light']) {
          expect(segment(label), findsOneWidget, reason: label);
        }
        await close(tester, app);
      });
      expect(errors, isEmpty);
    });
  });

  group('Settings opened from Swarm', () {
    testWidgets('has no Theme and no App colors: Appearance is the text size '
        'alone', (tester) async {
      final (app, _, _) = await openSettings(tester, swarm: true);

      await reveal(tester, find.text('Text size'));
      expect(find.text('Theme'), findsNothing);
      expect(find.text('App colors'), findsNothing);
      expect(find.byType(SwarmSegments<AppThemeMode>), findsNothing);
      await close(tester, app);
    });
  });

  group('opened from the terminal', () {
    testWidgets('keeps App colors and no Theme; it names the palette on '
        'screen', (tester) async {
      final (app, _, _) = await openSettings(
        tester,
        swarm: false,
        prefs: const AppearancePrefs(themeMode: AppThemeMode.light),
      );

      await reveal(tester, find.text('App colors'));
      expect(find.text('Theme'), findsNothing);
      expect(find.byType(SwarmSegments<AppThemeMode>), findsNothing);
      expect(find.text('Paper'), findsOneWidget, reason: "Light's palette");
      await close(tester, app);
    });

    testWidgets('a palette picked there hands light and dark back to it', (
      tester,
    ) async {
      final (app, store, storage) = await openSettings(
        tester,
        swarm: false,
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
