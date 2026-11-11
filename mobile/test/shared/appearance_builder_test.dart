import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/shared/theme/appearance_builder.dart';
import 'package:harness_mobile/shared/theme/appearance_prefs_store.dart';
import 'package:harness_mobile/shared/theme/color_palette.dart';

import '../voice_fakes.dart' show MemoryKeyValueStore;

/// What the app does before it builds its theme: the palette Settings' Theme resolves to, for this
/// phone's own light or dark, on `AppTheme` — and built again as either moves.
void main() {
  tearDown(() {
    AppTheme.palette.value = HarnessPalette.graphite;
    AppTheme.terminalPaletteOverride.value = null;
  });

  Future<List<HarnessPalette>> pump(
    WidgetTester tester,
    AppearancePrefsStore store,
  ) async {
    final built = <HarnessPalette>[];
    await tester.pumpWidget(
      AppearanceBuilder(
        store: store,
        builder: (context, prefs, palette) {
          expect(
            AppTheme.palette.value,
            palette,
            reason: 'on before the build',
          );
          built.add(palette);
          return const SizedBox();
        },
      ),
    );
    return built;
  }

  testWidgets('System follows the phone as it turns', (tester) async {
    addTearDown(tester.platformDispatcher.clearPlatformBrightnessTestValue);
    tester.platformDispatcher.platformBrightnessTestValue = Brightness.light;
    final store = AppearancePrefsStore(storage: MemoryKeyValueStore());
    await store.setThemeMode(AppThemeMode.system);

    final built = await pump(tester, store);
    expect(built.last, HarnessPalette.paper);
    expect(
      AppTheme.terminalPalette,
      HarnessPalette.graphite,
      reason: 'the terminal stays dark',
    );

    tester.platformDispatcher.platformBrightnessTestValue = Brightness.dark;
    await tester.pump();
    expect(built.last, HarnessPalette.graphite);
    expect(AppTheme.terminalPaletteOverride.value, isNull);
  });

  testWidgets('Dark and Light hold whatever the phone says', (tester) async {
    addTearDown(tester.platformDispatcher.clearPlatformBrightnessTestValue);
    tester.platformDispatcher.platformBrightnessTestValue = Brightness.light;
    final store = AppearancePrefsStore(storage: MemoryKeyValueStore());
    await store.setThemeMode(AppThemeMode.dark);

    final built = await pump(tester, store);
    expect(built.last, HarnessPalette.graphite);

    await store.setThemeMode(AppThemeMode.light);
    await tester.pump();
    expect(built.last, HarnessPalette.paper);

    tester.platformDispatcher.platformBrightnessTestValue = Brightness.dark;
    await tester.pump();
    expect(AppTheme.palette.value, HarnessPalette.paper);
  });

  testWidgets('left to App colors, a light phone changes nothing', (
    tester,
  ) async {
    addTearDown(tester.platformDispatcher.clearPlatformBrightnessTestValue);
    tester.platformDispatcher.platformBrightnessTestValue = Brightness.light;
    final store = AppearancePrefsStore(storage: MemoryKeyValueStore());

    final built = await pump(tester, store);
    expect(built.last, HarnessPalette.graphite, reason: 'the shipped dark');
    expect(AppTheme.terminalPaletteOverride.value, isNull);
  });
}
