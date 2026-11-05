// Task #3006 (Dee, 11-05): Light / Dark / Match macOS at the top of
// Appearance > Workspace, with the light and the dark theme chosen below it,
// and the whole app following the Mac live in Match macOS.
import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/app_shell.dart';
import 'package:harness/core/local_key_value_store.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/shared/theme/appearance_prefs_store.dart';
import 'package:harness/shared/theme/color_palette.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/widgets/harness_customize_pane.dart';

import 'swarm_state_test.dart' show createApp;

class _Storage implements LocalKeyValueStore {
  final values = <String, String>{};
  @override
  Future<String?> read(String key) async => values[key];
  @override
  Future<void> delete(String key) async => values.remove(key);
  @override
  Future<void> write(String key, String value) async => values[key] = value;
}

Future<void> _openWorkspace(
  WidgetTester tester,
  AppearancePrefsStore store,
) async {
  tester.view.devicePixelRatio = 1;
  tester.view.physicalSize = const Size(1000, 1400);
  addTearDown(tester.view.reset);
  await tester.pumpWidget(
    MaterialApp(
      theme: grid.buildAppTheme(brightness: store.value.palette.brightness),
      home: Scaffold(
        body: Align(
          alignment: Alignment.centerRight,
          child: SizedBox(
            width: 440,
            child: HarnessCustomizePane(onClose: () {}, store: store),
          ),
        ),
      ),
    ),
  );
  await tester.tap(find.byKey(const ValueKey('customize-appearance')));
  await tester.pumpAndSettle();
}

Iterable<String> _palettesIn(String group) => find
    .descendant(
      of: find.byKey(ValueKey(group)),
      matching: find.byWidgetPredicate(
        (widget) =>
            widget.key is ValueKey<String> &&
            (widget.key! as ValueKey<String>).value.startsWith('palette-'),
      ),
    )
    .evaluate()
    .map((e) => (e.widget.key! as ValueKey<String>).value.substring(8));

void main() {
  tearDown(() {
    debugDefaultTargetPlatformOverride = null;
    grid.AppTheme.palette.value = HarnessPalette.graphite;
    grid.AppTheme.brightness.value = Brightness.dark;
  });

  testWidgets('Workspace opens on Light / Dark / Match macOS, themes below', (
    tester,
  ) async {
    debugDefaultTargetPlatformOverride = TargetPlatform.macOS;
    final store = AppearancePrefsStore(storage: _Storage());
    addTearDown(store.dispose);
    await _openWorkspace(tester, store);

    final mode = find.byKey(const ValueKey('appearance-mode'));
    expect(mode, findsOneWidget);
    for (final label in ['Light', 'Dark', 'Match macOS']) {
      expect(
        find.descendant(of: mode, matching: find.text(label)),
        findsOneWidget,
      );
    }
    // At the top: above the light themes, the dark themes and every pane row.
    final top = tester.getTopLeft(mode).dy;
    expect(
      top,
      lessThan(
        tester.getTopLeft(find.byKey(const ValueKey('palettes-light'))).dy,
      ),
    );
    expect(
      tester.getTopLeft(find.byKey(const ValueKey('palettes-light'))).dy,
      lessThan(
        tester.getTopLeft(find.byKey(const ValueKey('palettes-dark'))).dy,
      ),
    );
    expect(top, lessThan(tester.getTopLeft(find.text('Pane style')).dy));

    expect(_palettesIn('palettes-light').toSet(), {
      for (final p in HarnessPalette.values)
        if (!p.isDark) p.name,
    });
    expect(_palettesIn('palettes-dark').toSet(), {
      for (final p in HarnessPalette.values)
        if (p.isDark) p.name,
    });
    expect(tester.takeException(), isNull);
  });

  testWidgets('elsewhere the third choice is Match system', (tester) async {
    debugDefaultTargetPlatformOverride = TargetPlatform.linux;
    final store = AppearancePrefsStore(storage: _Storage());
    addTearDown(store.dispose);
    await _openWorkspace(tester, store);
    expect(find.text('Match system'), findsOneWidget);
    expect(find.text('Match macOS'), findsNothing);
  });

  testWidgets('the switch and the two theme lists set what shows', (
    tester,
  ) async {
    debugDefaultTargetPlatformOverride = TargetPlatform.macOS;
    final store = AppearancePrefsStore(storage: _Storage());
    addTearDown(store.dispose);
    await _openWorkspace(tester, store);
    final mode = find.byKey(const ValueKey('appearance-mode'));

    await tester.tap(find.descendant(of: mode, matching: find.text('Light')));
    await tester.pumpAndSettle();
    expect(store.value.mode, AppearanceMode.light);
    expect(store.value.palette, HarnessPalette.cloud);

    await tester.ensureVisible(find.byKey(const ValueKey('palette-plum')));
    await tester.tap(find.byKey(const ValueKey('palette-plum')));
    await tester.pumpAndSettle();
    expect(store.value.palette, HarnessPalette.plum);

    await tester.ensureVisible(find.byKey(const ValueKey('palette-night')));
    await tester.tap(find.byKey(const ValueKey('palette-night')));
    await tester.pumpAndSettle();
    expect(store.value.mode, AppearanceMode.dark);
    expect(store.value.palette, HarnessPalette.night);
    expect(store.value.lightPalette, HarnessPalette.plum);

    await tester.ensureVisible(mode);
    await tester.tap(find.descendant(of: mode, matching: find.text('Light')));
    await tester.pumpAndSettle();
    expect(store.value.palette, HarnessPalette.plum);

    // Each list marks its own choice, whichever one is on screen.
    final selected = tester.getSemantics(
      find.byKey(const ValueKey('palette-night')),
    );
    expect(selected.flagsCollection.isSelected, isTrue);
  });

  testWidgets('in Match macOS the whole app follows the Mac live', (
    tester,
  ) async {
    debugDefaultTargetPlatformOverride = TargetPlatform.macOS;
    final dispatcher = tester.platformDispatcher;
    dispatcher.platformBrightnessTestValue = Brightness.light;
    addTearDown(dispatcher.clearPlatformBrightnessTestValue);
    final saved = appearancePrefsStore.value;
    addTearDown(() => appearancePrefsStore.value = saved);
    appearancePrefsStore.value = const AppearancePrefs();
    appearancePrefsStore.followSystemBrightness();
    final app = createApp()..status = AppStatus.authenticated;
    addTearDown(app.dispose);
    late BuildContext screen;
    await tester.pumpWidget(
      ProviderScope(
        overrides: [appStateProvider.overrideWithValue(app)],
        child: HarnessApp(
          authenticatedScreen: (_) => Builder(
            builder: (context) {
              screen = context;
              return Scaffold(
                body: TextButton(
                  onPressed: () => unawaited(showHarnessCustomizePane(context)),
                  child: const Text('Open Appearance'),
                ),
              );
            },
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.text('Open Appearance'));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('customize-appearance')));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Match macOS'));
    await tester.pumpAndSettle();
    expect(appearancePrefsStore.value.mode, AppearanceMode.system);
    expect(grid.AppTheme.palette.value, HarnessPalette.cloud);
    expect(Theme.of(screen).brightness, Brightness.light);

    dispatcher.platformBrightnessTestValue = Brightness.dark;
    await tester.pumpAndSettle();
    expect(grid.AppTheme.palette.value, HarnessPalette.graphite);
    expect(grid.AppTheme.brightness.value, Brightness.dark);
    expect(Theme.of(screen).brightness, Brightness.dark);

    dispatcher.platformBrightnessTestValue = Brightness.light;
    await tester.pumpAndSettle();
    expect(grid.AppTheme.palette.value, HarnessPalette.cloud);
    expect(Theme.of(screen).brightness, Brightness.light);
    await tester.pumpWidget(const SizedBox());
  });
}
