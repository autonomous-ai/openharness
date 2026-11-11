import 'dart:async';
import 'dart:ui' show Brightness;

import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/core/local_key_value_store.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/shared/theme/appearance_prefs_store.dart';
import 'package:harness_mobile/shared/theme/color_palette.dart';

/// `state.json`, in memory. Writes can be held at a gate so a test can stage
/// the person tapping again while the disk is still busy with the last tap.
class _Memory implements LocalKeyValueStore {
  _Memory([Map<String, String>? values]) : values = values ?? {};

  final Map<String, String> values;
  final writes = <(String, String)>[];
  Completer<void>? gate;
  bool failing = false;

  @override
  Future<String?> read(String key) async {
    if (failing) throw StateError('state.json is unreadable');
    return values[key];
  }

  @override
  Future<void> write(String key, String value) async {
    final held = gate;
    if (held != null) await held.future;
    if (failing) throw StateError('disk full');
    writes.add((key, value));
    values[key] = value;
  }

  @override
  Future<void> delete(String key) async {
    if (failing) throw StateError('disk full');
    values.remove(key);
  }
}

/// The phone's Settings ▸ Appearance: the palette and the UI size, remembered
/// across launches.
void main() {
  group('load', () {
    test('reads back what was chosen', () async {
      final store = AppearancePrefsStore(
        storage: _Memory({
          'app_ui_font_family': '  Inter ',
          'app_ui_font_size': '16',
          'app_color_palette': 'forest',
        }),
      );
      await store.load();
      expect(
        store.value,
        const AppearancePrefs(
          uiFamily: 'Inter',
          uiSize: 16,
          palette: HarnessPalette.forest,
        ),
      );
    });

    test('nothing saved is the shipped look', () async {
      final store = AppearancePrefsStore(storage: _Memory());
      await store.load();
      expect(store.value, const AppearancePrefs());
      expect(store.value.palette, HarnessPalette.graphite);
      expect(store.value.uiSize, AppearancePrefs.uiSizeDefault);
      expect(store.value.uiFamily, isNull);
    });

    test('a hand-edited file lands on something that still draws', () async {
      final store = AppearancePrefsStore(
        storage: _Memory({
          // A blank family would render no text at all.
          'app_ui_font_family': '   ',
          // `NaN` parses, and clamps to the maximum if let through.
          'app_ui_font_size': 'NaN',
          'app_color_palette': 'neon',
        }),
      );
      await store.load();
      expect(store.value, const AppearancePrefs());

      final huge = AppearancePrefsStore(
        storage: _Memory({'app_ui_font_size': '400'}),
      );
      await huge.load();
      expect(huge.value.uiSize, AppearancePrefs.uiSizeMax);

      final garbage = AppearancePrefsStore(
        storage: _Memory({'app_ui_font_size': 'big'}),
      );
      await garbage.load();
      expect(garbage.value.uiSize, AppearancePrefs.uiSizeDefault);
    });

    test(
      'an unreadable file is the shipped look, not a failed launch',
      () async {
        final store = AppearancePrefsStore(storage: _Memory()..failing = true);
        store.value = const AppearancePrefs(palette: HarnessPalette.ember);
        await store.load();
        expect(store.value, const AppearancePrefs());
      },
    );
  });

  group('palette', () {
    test('moves the app at once, and is written behind it', () async {
      final storage = _Memory()..gate = Completer<void>();
      final store = AppearancePrefsStore(storage: storage);
      var repaints = 0;
      store.addListener(() => repaints++);

      final saved = store.setPalette(HarnessPalette.midnight);
      expect(store.value.palette, HarnessPalette.midnight);
      expect(repaints, 1, reason: 'the tap repaints, not the disk');
      expect(storage.writes, isEmpty);

      storage.gate!.complete();
      await saved;
      expect(storage.values['app_color_palette'], 'midnight');
    });

    test('taps faster than the disk end on the LAST one', () async {
      final storage = _Memory()..gate = Completer<void>();
      final store = AppearancePrefsStore(storage: storage);

      final first = store.setPalette(HarnessPalette.dusk);
      final second = store.setPalette(HarnessPalette.slate);
      final third = store.setPalette(HarnessPalette.ember);
      // One save in flight, which the later taps ride on.
      expect(identical(first, second) && identical(second, third), isTrue);

      storage.gate!.complete();
      await third;
      expect(storage.values['app_color_palette'], 'ember');
      expect(store.value.palette, HarnessPalette.ember);
      // The stale `dusk` went first; the loop wrote the newest after it.
      expect(storage.writes.last, ('app_color_palette', 'ember'));
    });

    test('the palette already on is no write at all', () async {
      final storage = _Memory();
      final store = AppearancePrefsStore(storage: storage);
      await store.setPalette(HarnessPalette.graphite);
      expect(storage.writes, isEmpty);
    });

    test('a disk that fails keeps the choice for this run', () async {
      final store = AppearancePrefsStore(storage: _Memory()..failing = true);
      await store.setPalette(HarnessPalette.forest);
      expect(store.value.palette, HarnessPalette.forest);
      // And the next choice is still attempted, not stuck behind the failure.
      await store.setPalette(HarnessPalette.dusk);
      expect(store.value.palette, HarnessPalette.dusk);
    });

    test('every palette is found again by the id it is saved under', () {
      for (final palette in HarnessPalette.values) {
        expect(HarnessPalette.fromId(palette.name), palette);
        expect(palette.label, isNotEmpty);
      }
      expect(HarnessPalette.fromId(null), HarnessPalette.graphite);
    });
  });

  group('UI size', () {
    test('steps by the button, written as a number', () async {
      final storage = _Memory();
      final store = AppearancePrefsStore(storage: storage);
      await store.setUiSize(15);
      expect(store.value.uiSize, 15);
      expect(storage.values['app_ui_font_size'], '15.0');
    });

    test('snaps to its ends instead of refusing', () async {
      final store = AppearancePrefsStore(storage: _Memory());
      await store.setUiSize(50);
      expect(store.value.uiSize, AppearancePrefs.uiSizeMax);
      await store.setUiSize(2);
      expect(store.value.uiSize, AppearancePrefs.uiSizeMin);
      await store.setUiSize(double.nan);
      expect(store.value.uiSize, AppearancePrefs.uiSizeDefault);
    });

    test('the size already on is no write', () async {
      final storage = _Memory();
      final store = AppearancePrefsStore(storage: storage);
      await store.setUiSize(AppearancePrefs.uiSizeDefault);
      expect(storage.writes, isEmpty);
    });

    test('a disk that fails keeps the size for this run', () async {
      final store = AppearancePrefsStore(storage: _Memory()..failing = true);
      await store.setUiSize(12);
      expect(store.value.uiSize, 12);
    });
  });

  group('theme (System | Dark | Light, Swarm\'s Settings)', () {
    tearDown(() {
      AppTheme.palette.value = HarnessPalette.graphite;
      AppTheme.terminalPaletteOverride.value = null;
    });

    test('unset, the palette decides, as before Theme existed', () {
      for (final palette in HarnessPalette.values) {
        final prefs = AppearancePrefs(palette: palette);
        for (final phone in Brightness.values) {
          expect(prefs.paletteFor(phone), palette, reason: palette.name);
        }
        expect(prefs.terminalPalette, palette, reason: 'App colors dresses it');
        expect(
          prefs.shownThemeMode,
          palette.isDark ? AppThemeMode.dark : AppThemeMode.light,
        );
      }
    });

    test('Dark and Light keep a palette on their side, else the shipped one '
        'of that side', () {
      const midnight = AppearancePrefs(
        palette: HarnessPalette.midnight,
        themeMode: AppThemeMode.dark,
      );
      expect(midnight.paletteFor(Brightness.light), HarnessPalette.midnight);
      expect(
        midnight.copyWith(themeMode: AppThemeMode.light).paletteFor(
          Brightness.dark,
        ),
        HarnessPalette.paper,
      );
      const mist = AppearancePrefs(
        palette: HarnessPalette.mist,
        themeMode: AppThemeMode.light,
      );
      expect(mist.paletteFor(Brightness.dark), HarnessPalette.mist);
      expect(
        mist.copyWith(themeMode: AppThemeMode.dark).paletteFor(Brightness.light),
        HarnessPalette.graphite,
      );
    });

    test('System follows the phone', () {
      const prefs = AppearancePrefs(themeMode: AppThemeMode.system);
      expect(prefs.paletteFor(Brightness.dark), HarnessPalette.graphite);
      expect(prefs.paletteFor(Brightness.light), HarnessPalette.paper);
      expect(prefs.shownThemeMode, AppThemeMode.system);
    });

    test("once Theme is chosen the terminal keeps the dark side, whatever "
        'the app wears', () {
      for (final mode in AppThemeMode.values) {
        expect(
          AppearancePrefs(themeMode: mode).terminalPalette,
          HarnessPalette.graphite,
          reason: mode.name,
        );
        expect(
          AppearancePrefs(
            palette: HarnessPalette.forest,
            themeMode: mode,
          ).terminalPalette,
          HarnessPalette.forest,
          reason: 'a dark palette chosen in App colors stays: ${mode.name}',
        );
        expect(
          AppearancePrefs(
            palette: HarnessPalette.paper,
            themeMode: mode,
          ).terminalPalette,
          HarnessPalette.graphite,
          reason: 'never light: ${mode.name}',
        );
      }
    });

    test('is written beside the palette and read back', () async {
      final storage = _Memory();
      final store = AppearancePrefsStore(storage: storage);
      var repaints = 0;
      store.addListener(() => repaints++);

      await store.setThemeMode(AppThemeMode.light);
      expect(repaints, 1);
      expect(storage.values['app_theme_mode'], 'light');
      expect(store.value.palette, HarnessPalette.graphite, reason: 'kept');

      final again = AppearancePrefsStore(storage: storage);
      await again.load();
      expect(again.value.themeMode, AppThemeMode.light);
    });

    test('the mode already on is no write', () async {
      final storage = _Memory();
      final store = AppearancePrefsStore(storage: storage);
      await store.setThemeMode(AppThemeMode.dark);
      final writes = storage.writes.length;
      await store.setThemeMode(AppThemeMode.dark);
      expect(storage.writes, hasLength(writes));
    });

    test('a mode from another build is no mode: the palette decides', () async {
      final store = AppearancePrefsStore(
        storage: _Memory({'app_theme_mode': 'sepia'}),
      );
      await store.load();
      expect(store.value.themeMode, isNull);
      expect(AppThemeMode.fromId(null), isNull);
      for (final mode in AppThemeMode.values) {
        expect(AppThemeMode.fromId(mode.name), mode);
      }
    });

    test('taps faster than the disk end on the LAST one', () async {
      final storage = _Memory()..gate = Completer<void>();
      final store = AppearancePrefsStore(storage: storage);

      final first = store.setThemeMode(AppThemeMode.light);
      final second = store.setThemeMode(AppThemeMode.system);
      final third = store.setPalette(HarnessPalette.ember);
      final fourth = store.setThemeMode(AppThemeMode.dark);
      expect(
        identical(first, second) &&
            identical(second, third) &&
            identical(third, fourth),
        isTrue,
        reason: 'one save in flight, which the later taps ride on',
      );

      storage.gate!.complete();
      await fourth;
      expect(storage.values['app_theme_mode'], 'dark');
      expect(storage.values['app_color_palette'], 'ember');
      expect(store.value.themeMode, AppThemeMode.dark);
    });

    test('App colors hands light and dark back to the palette — even the '
        'palette that was already on', () async {
      final storage = _Memory();
      final store = AppearancePrefsStore(storage: storage);
      await store.setThemeMode(AppThemeMode.light);
      expect(store.value.paletteFor(Brightness.dark), HarnessPalette.paper);

      // Graphite is the stored palette already; Light had it drawn as Paper.
      await store.setPalette(HarnessPalette.graphite);
      expect(store.value.themeMode, isNull);
      expect(store.value.paletteFor(Brightness.light), HarnessPalette.graphite);
      expect(storage.values.containsKey('app_theme_mode'), isFalse);
    });

    test('reset forgets it', () async {
      final storage = _Memory();
      final store = AppearancePrefsStore(storage: storage);
      await store.setThemeMode(AppThemeMode.system);
      await store.reset();
      expect(store.value.themeMode, isNull);
      expect(storage.values.containsKey('app_theme_mode'), isFalse);
    });

    test('a disk that fails keeps the mode for this run', () async {
      final store = AppearancePrefsStore(storage: _Memory()..failing = true);
      await store.setThemeMode(AppThemeMode.light);
      expect(store.value.themeMode, AppThemeMode.light);
    });

    test("applyAppearance puts the app's palette and the terminal's on "
        'AppTheme', () {
      expect(
        applyAppearance(
          const AppearancePrefs(themeMode: AppThemeMode.light),
          platform: Brightness.dark,
        ),
        HarnessPalette.paper,
      );
      expect(AppTheme.palette.value, HarnessPalette.paper);
      expect(AppTheme.terminalPaletteOverride.value, HarnessPalette.graphite);
      expect(AppTheme.terminalPalette, HarnessPalette.graphite);

      // Dark: the two agree, so there is no override to carry.
      applyAppearance(
        const AppearancePrefs(themeMode: AppThemeMode.dark),
        platform: Brightness.light,
      );
      expect(AppTheme.palette.value, HarnessPalette.graphite);
      expect(AppTheme.terminalPaletteOverride.value, isNull);

      // App colors' Paper: the terminal is light with the app, as before.
      applyAppearance(
        const AppearancePrefs(palette: HarnessPalette.paper),
        platform: Brightness.dark,
      );
      expect(AppTheme.palette.value, HarnessPalette.paper);
      expect(AppTheme.terminalPalette, HarnessPalette.paper);
    });
  });

  test('prefs compare by value, so an unchanged load repaints nothing', () {
    const a = AppearancePrefs(uiFamily: 'Inter', uiSize: 15);
    expect(a, const AppearancePrefs(uiFamily: 'Inter', uiSize: 15));
    expect(
      a.hashCode,
      const AppearancePrefs(uiFamily: 'Inter', uiSize: 15).hashCode,
    );
    expect(a == const AppearancePrefs(uiSize: 15), isFalse);
    expect(a.copyWith(clearUiFamily: true).uiFamily, isNull);
    expect(a.copyWith(palette: HarnessPalette.dusk).uiFamily, 'Inter');

    final light = a.copyWith(themeMode: AppThemeMode.light);
    expect(light == a, isFalse, reason: 'the mode is part of the value');
    expect(light.copyWith(uiSize: 16).themeMode, AppThemeMode.light);
    expect(light.copyWith(clearThemeMode: true), a);
  });
}
