// Task #3006 (Dee, 11-05): Light / Dark / Match macOS, each with the light and
// the dark theme it uses chosen separately. Match macOS follows the system
// setting live.
import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/local_key_value_store.dart';
import 'package:harness/shared/theme/appearance_prefs_store.dart';
import 'package:harness/shared/theme/color_palette.dart';

class _Storage implements LocalKeyValueStore {
  final values = <String, String>{};
  Completer<void>? gate;
  @override
  Future<String?> read(String key) async => values[key];
  @override
  Future<void> delete(String key) async => values.remove(key);
  @override
  Future<void> write(String key, String value) async {
    await gate?.future;
    values[key] = value;
  }
}

void main() {
  test('someone who never opens Appearance keeps Graphite, in Dark', () async {
    const prefs = AppearancePrefs();
    expect(prefs.mode, AppearanceMode.dark);
    expect(prefs.palette, HarnessPalette.graphite);
    expect(prefs.darkPalette, HarnessPalette.graphite);
    expect(prefs.lightPalette, HarnessPalette.cloud);
    final store = AppearancePrefsStore(storage: _Storage());
    addTearDown(store.dispose);
    await store.load();
    expect(store.value, const AppearancePrefs());
  });

  test('Light and Dark each show their own chosen theme', () async {
    final store = AppearancePrefsStore(storage: _Storage());
    addTearDown(store.dispose);
    await store.setMode(AppearanceMode.light);
    expect(store.value.palette, HarnessPalette.cloud);
    await store.setPalette(HarnessPalette.plum);
    expect(store.value.palette, HarnessPalette.plum);
    expect(store.value.lightPalette, HarnessPalette.plum);
    await store.setMode(AppearanceMode.dark);
    expect(store.value.palette, HarnessPalette.graphite);
    // Choosing a dark theme in Light moves to Dark; the light choice stays.
    await store.setMode(AppearanceMode.light);
    await store.setPalette(HarnessPalette.storm);
    expect(store.value.mode, AppearanceMode.dark);
    expect(store.value.palette, HarnessPalette.storm);
    expect(store.value.lightPalette, HarnessPalette.plum);
    await store.setPalette(HarnessPalette.paper);
    expect(store.value.mode, AppearanceMode.light);
    expect(store.value.palette, HarnessPalette.paper);
    expect(store.value.darkPalette, HarnessPalette.storm);
  });

  testWidgets('Match macOS follows the system setting live, and only then', (
    tester,
  ) async {
    final dispatcher = tester.platformDispatcher;
    dispatcher.platformBrightnessTestValue = Brightness.light;
    addTearDown(dispatcher.clearPlatformBrightnessTestValue);
    final store = AppearancePrefsStore(storage: _Storage());
    addTearDown(store.dispose);
    store.followSystemBrightness();
    await store.setPalette(HarnessPalette.plum);
    await store.setPalette(HarnessPalette.night);
    await store.setMode(AppearanceMode.system);
    expect(store.value.palette, HarnessPalette.plum);

    dispatcher.platformBrightnessTestValue = Brightness.dark;
    expect(store.value.palette, HarnessPalette.night);
    dispatcher.platformBrightnessTestValue = Brightness.light;
    expect(store.value.palette, HarnessPalette.plum);

    // In Match, choosing a theme only sets its slot: the Mac decides which.
    await store.setPalette(HarnessPalette.storm);
    expect(store.value.mode, AppearanceMode.system);
    expect(store.value.palette, HarnessPalette.plum);
    dispatcher.platformBrightnessTestValue = Brightness.dark;
    expect(store.value.palette, HarnessPalette.storm);

    // Out of Match, a system flip changes nothing.
    await store.setMode(AppearanceMode.light);
    dispatcher.platformBrightnessTestValue = Brightness.light;
    dispatcher.platformBrightnessTestValue = Brightness.dark;
    expect(store.value.palette, HarnessPalette.plum);
  });

  testWidgets('a closed store stops following the system', (tester) async {
    final dispatcher = tester.platformDispatcher;
    addTearDown(dispatcher.clearPlatformBrightnessTestValue);
    final store = AppearancePrefsStore(storage: _Storage());
    store.followSystemBrightness();
    store.followSystemBrightness(); // Once is enough; twice is harmless.
    await store.setMode(AppearanceMode.system);
    store.dispose();
    dispatcher.platformBrightnessTestValue = Brightness.dark;
    dispatcher.platformBrightnessTestValue = Brightness.light;
    expect(tester.takeException(), isNull);
  });

  test(
    'choices survive a relaunch, and the old key keeps what shows',
    () async {
      final storage = _Storage()..gate = Completer<void>();
      final store = AppearancePrefsStore(storage: storage);
      addTearDown(store.dispose);
      final saving = store.setPalette(HarnessPalette.plum);
      store.setPalette(HarnessPalette.storm);
      store.setMode(AppearanceMode.system);
      store.setMode(AppearanceMode.light);
      storage.gate!.complete();
      await saving;
      await Future<void>.delayed(Duration.zero);
      final reopened = AppearancePrefsStore(storage: storage);
      addTearDown(reopened.dispose);
      await reopened.load();
      expect(reopened.value.mode, AppearanceMode.light);
      expect(reopened.value.lightPalette, HarnessPalette.plum);
      expect(reopened.value.darkPalette, HarnessPalette.storm);
      expect(reopened.value.palette, HarnessPalette.plum);
      // An older build reads only this key: it opens in the same look.
      expect(storage.values['app_color_palette'], 'plum');
      await reopened.reset();
      expect(storage.values.keys, isNot(contains('app_theme_mode')));
      expect(storage.values.keys, isNot(contains('app_light_palette')));
      expect(storage.values.keys, isNot(contains('app_dark_palette')));
      expect(reopened.value, const AppearancePrefs());
    },
  );

  test('a save from before the switch keeps its look', () async {
    for (final (saved, mode, light, dark) in [
      (
        'paper',
        AppearanceMode.light,
        HarnessPalette.paper,
        HarnessPalette.graphite,
      ),
      (
        'mist',
        AppearanceMode.light,
        HarnessPalette.mist,
        HarnessPalette.graphite,
      ),
      (
        'forest',
        AppearanceMode.dark,
        HarnessPalette.cloud,
        HarnessPalette.forest,
      ),
    ]) {
      final storage = _Storage()..values['app_color_palette'] = saved;
      final store = AppearancePrefsStore(storage: storage);
      addTearDown(store.dispose);
      await store.load();
      expect(store.value.mode, mode, reason: saved);
      expect(store.value.lightPalette, light, reason: saved);
      expect(store.value.darkPalette, dark, reason: saved);
      expect(store.value.palette.name, saved);
    }
  });

  test('hand-edited choices land on usable themes', () async {
    final storage = _Storage()
      ..values.addAll({
        'app_theme_mode': 'sepia',
        'app_light_palette': 'graphite', // a dark theme in the light slot
        'app_dark_palette': 'nonsense',
        'app_color_palette': 'storm',
      });
    final store = AppearancePrefsStore(storage: storage);
    addTearDown(store.dispose);
    await store.load();
    expect(store.value.mode, AppearanceMode.dark);
    expect(store.value.lightPalette, HarnessPalette.cloud);
    expect(store.value.darkPalette, HarnessPalette.storm);
    expect(store.value.palette, HarnessPalette.storm);
  });
}
