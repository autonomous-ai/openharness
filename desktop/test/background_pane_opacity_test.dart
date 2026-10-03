import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/local_key_value_store.dart';
import 'package:harness/settings/appearance/wallpaper_section.dart';
import 'package:harness/shared/theme/appearance_prefs_store.dart';
import 'package:harness/shared/theme/harness_background.dart';
import 'package:harness/widgets/box_chrome.dart';

class _Storage implements LocalKeyValueStore {
  final values = <String, String>{};
  @override
  Future<String?> read(String key) async => values[key];
  @override
  Future<void> write(String key, String value) async => values[key] = value;
  @override
  Future<void> delete(String key) async => values.remove(key);
}

const _key = 'harness_background_behind_harnesses';

HarnessBackground get _artwork => HarnessBackground.gallery.firstWhere(
  (background) => background != HarnessBackground.plain,
);

void main() {
  group('prefs', () {
    test('Blank by default, at 50%', () {
      const prefs = AppearancePrefs();
      expect(prefs.showsBackground, isFalse);
      expect(prefs.paneOpacity, 0.5);
      expect(prefs.effectivePaneOpacity, 1);
    });

    test('round-trips through storage', () async {
      final storage = _Storage();
      final store = AppearancePrefsStore(storage: storage);
      await store.setPaneOpacity(0.6);

      final reloaded = AppearancePrefsStore(storage: storage);
      await reloaded.load();
      expect(reloaded.value.paneOpacity, 0.6);
    });

    test('an older build\'s off switch is ignored', () async {
      final storage = _Storage()
        ..values[_key] = '{"on": false, "opacity": 0.3}';
      final store = AppearancePrefsStore(storage: storage);
      await store.load();
      await store.setBackground(_artwork);
      expect(store.value.showsBackground, isTrue);
      expect(store.value.effectivePaneOpacity, 0.3);
    });

    test('opacity is clamped, and garbage lands on the default', () async {
      final storage = _Storage();
      final store = AppearancePrefsStore(storage: storage);
      await store.setPaneOpacity(-1);
      expect(store.value.paneOpacity, AppearancePrefs.paneOpacityMin);
      await store.setPaneOpacity(7);
      expect(store.value.paneOpacity, 1);

      storage.values[_key] = '{"opacity": "NaN"}';
      await store.load();
      expect(store.value.paneOpacity, AppearancePrefs.paneOpacityDefault);

      storage.values[_key] = 'not json';
      await store.load();
      expect(store.value.paneOpacity, AppearancePrefs.paneOpacityDefault);
    });

    test('any Background but Blank shows through the panes', () async {
      final store = AppearancePrefsStore(storage: _Storage());
      await store.setPaneOpacity(0.7);
      expect(store.value.showsBackground, isFalse);
      expect(store.value.effectivePaneOpacity, 1);

      await store.setBackground(_artwork);
      expect(store.value.showsBackground, isTrue);
      expect(store.value.effectivePaneOpacity, 0.7);

      await store.setBackground(HarnessBackground.plain);
      expect(store.value.showsBackground, isFalse);
      expect(store.value.effectivePaneOpacity, 1);
    });

    test('reset forgets it', () async {
      final storage = _Storage();
      final store = AppearancePrefsStore(storage: storage);
      await store.setPaneOpacity(0.2);
      await store.reset();
      expect(store.value.paneOpacity, AppearancePrefs.paneOpacityDefault);
      expect(storage.values.containsKey(_key), isFalse);
    });
  });

  testWidgets('pane opacity shows for artwork only', (tester) async {
    final store = AppearancePrefsStore(storage: _Storage());
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: SingleChildScrollView(child: WallpaperSection(store: store)),
        ),
      ),
    );
    final slider = find.byKey(const ValueKey('background-pane-opacity'));
    expect(slider, findsNothing, reason: 'Blank has nothing to show');

    await store.setBackground(_artwork);
    await tester.pumpAndSettle();
    expect(slider, findsOneWidget);
    expect(find.text('50%'), findsOneWidget);
  });

  testWidgets('PaneOpacity scales fills, and is solid outside a workspace', (
    tester,
  ) async {
    late Color inside, outside;
    await tester.pumpWidget(
      Column(
        children: [
          Builder(
            builder: (context) {
              outside = PaneOpacity.fill(context, const Color(0xff202020));
              return const SizedBox();
            },
          ),
          PaneOpacity(
            opacity: 0.5,
            child: Builder(
              builder: (context) {
                inside = PaneOpacity.fill(context, const Color(0xff202020));
                return const SizedBox();
              },
            ),
          ),
        ],
      ),
    );
    expect(outside.a, 1);
    expect(inside.a, closeTo(0.5, 0.01));
  });
}
