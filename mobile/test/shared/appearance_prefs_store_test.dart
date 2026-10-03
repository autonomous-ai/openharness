import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/core/local_key_value_store.dart';
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
  });
}
