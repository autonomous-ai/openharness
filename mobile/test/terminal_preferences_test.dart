import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/core/local_key_value_store.dart';
import 'package:harness_mobile/terminal/terminal_font_store.dart';
import 'package:harness_mobile/terminal/terminal_theme_store.dart';
import 'package:harness_mobile/terminal/terminal_typography.dart';

class _Store implements LocalKeyValueStore {
  final values = <String, String>{};
  bool fail = false;
  int writes = 0;

  @override
  Future<String?> read(String key) async {
    if (fail) throw StateError('storage unavailable');
    return values[key];
  }

  @override
  Future<void> write(String key, String value) async {
    writes++;
    if (fail) throw StateError('storage unavailable');
    values[key] = value;
  }

  @override
  Future<void> delete(String key) async => values.remove(key);
}

void main() {
  test(
    'font choices persist, reset, and leave unrelated preferences alone',
    () async {
      final storage = _Store()..values['unrelated'] = 'kept';
      final font = TerminalFontStore(storage: storage);
      addTearDown(font.dispose);
      expect(font.value.symbolFontFamily, terminalIconFontFamily);
      await font.setFamily(TerminalFontChoice.courierNew);
      await font.setSize(18);
      final restored = TerminalFontStore(storage: storage);
      addTearDown(restored.dispose);
      await restored.load();
      expect(restored.family, TerminalFontChoice.courierNew);
      expect(restored.size, 18);
      expect(restored.isDefault, isFalse);
      await restored.reset();
      await font.load();
      expect(font.isDefault, isTrue);
      expect(storage.values['unrelated'], 'kept');
    },
  );

  test(
    'font bounds make further stepper taps silent, without another write',
    () async {
      final storage = _Store();
      final font = TerminalFontStore(storage: storage);
      addTearDown(font.dispose);
      var notifications = 0;
      font.addListener(() => notifications++);
      await font.setSize(100);
      expect(font.size, TerminalFontStore.maxSize);
      final largest = font.value;
      final writes = storage.writes;
      await font.increaseSize();
      expect(font.value, same(largest));
      expect(storage.writes, writes);
      expect(notifications, 1);
      await font.setSize(-1);
      await font.decreaseSize();
      expect(font.size, TerminalFontStore.minSize);
      expect(notifications, 2);
      await font.setSize(100);
      expect(
        font.value,
        same(largest),
        reason: 'returning to a style reuses its render identity',
      );
    },
  );

  test('unknown or unreadable saved typography falls back safely', () async {
    final storage = _Store()
      ..values.addAll({
        'terminal_font_family': 'removed-font',
        'terminal_font_size': 'corrupt',
      });
    final font = TerminalFontStore(storage: storage);
    addTearDown(font.dispose);
    await font.load();
    expect(font.isDefault, isTrue);
    storage.values['terminal_font_size'] = '1000';
    await font.load();
    expect(font.size, TerminalFontStore.maxSize);
    storage.fail = true;
    await font.load();
    expect(font.size, terminalFontSize);
    expect(font.isDefault, isTrue);
    await font.setSize(19);
    expect(
      font.size,
      19,
      reason: 'a failed save keeps the choice for this run',
    );
  });

  group('the faces each OS ships', () {
    test('Android offers its own two, and opens on Droid Sans Mono', () async {
      // Offered the Linux list, every pick drew the same face on Android.
      expect(TerminalFontChoice.availableOn(TerminalFontHost.android), [
        TerminalFontChoice.droidSansMono,
        TerminalFontChoice.cutiveMono,
      ]);
      // The names Android's `fonts.xml` declares — its faces' own names
      // resolve to nothing there.
      expect(TerminalFontChoice.droidSansMono.fontFamily, 'monospace');
      expect(TerminalFontChoice.cutiveMono.fontFamily, 'serif-monospace');

      final font = TerminalFontStore(
        storage: _Store(),
        host: TerminalFontHost.android,
      );
      addTearDown(font.dispose);
      expect(font.family, TerminalFontChoice.droidSansMono);
      expect(font.value.fontFamily, 'monospace');
      expect(font.isDefault, isTrue);
      await font.load();
      expect(font.family, TerminalFontChoice.droidSansMono);
    });

    test(
      'a Linux face saved on Android comes back as Android\'s default',
      () async {
        final storage = _Store()
          ..values.addAll({
            'terminal_font_family': TerminalFontChoice.dejaVuSansMono.name,
            'terminal_font_size': '16',
          });
        final font = TerminalFontStore(
          storage: storage,
          host: TerminalFontHost.android,
        );
        addTearDown(font.dispose);
        await font.load();
        expect(font.family, TerminalFontChoice.droidSansMono);
        expect(font.value.fontFamily, 'monospace');
        expect(font.size, 16, reason: 'the size was never the problem');

        // An Apple face is no better on Android.
        storage.values['terminal_font_family'] = TerminalFontChoice.sfMono.name;
        await font.load();
        expect(font.family, TerminalFontChoice.droidSansMono);

        // Android's own second face loads as it was saved.
        await font.setFamily(TerminalFontChoice.cutiveMono);
        final restored = TerminalFontStore(
          storage: storage,
          host: TerminalFontHost.android,
        );
        addTearDown(restored.dispose);
        await restored.load();
        expect(restored.family, TerminalFontChoice.cutiveMono);
        expect(restored.isDefault, isFalse);
        await restored.reset();
        expect(restored.family, TerminalFontChoice.droidSansMono);
      },
    );

    test('Apple and Linux keep their lists, and load any saved face', () async {
      expect(TerminalFontChoice.availableOn(TerminalFontHost.apple), [
        TerminalFontChoice.sfMono,
        TerminalFontChoice.menlo,
        TerminalFontChoice.monaco,
        TerminalFontChoice.courierNew,
      ]);
      expect(
        TerminalFontChoice.defaultOn(TerminalFontHost.apple),
        TerminalFontChoice.sfMono,
      );
      expect(
        TerminalFontChoice.availableOn(TerminalFontHost.other),
        isNot(contains(TerminalFontChoice.droidSansMono)),
      );
      expect(
        TerminalFontChoice.defaultOn(TerminalFontHost.other),
        TerminalFontChoice.dejaVuSansMono,
      );

      // Unchanged on iOS: a face saved from another list still loads.
      final storage = _Store()
        ..values['terminal_font_family'] =
            TerminalFontChoice.dejaVuSansMono.name;
      final font = TerminalFontStore(
        storage: storage,
        host: TerminalFontHost.apple,
      );
      addTearDown(font.dispose);
      expect(font.family, TerminalFontChoice.sfMono);
      await font.load();
      expect(font.family, TerminalFontChoice.dejaVuSansMono);
    });
  });

  test(
    'terminal colors persist and reset without notifying on a no-op',
    () async {
      final storage = _Store();
      final theme = TerminalThemeStore(storage: storage);
      addTearDown(theme.dispose);
      var notifications = 0;
      theme.addListener(() => notifications++);
      await theme.set(TerminalThemeChoice.tango);
      await theme.set(TerminalThemeChoice.tango);
      expect(notifications, 1);
      expect(storage.writes, 1);
      final restored = TerminalThemeStore(storage: storage);
      addTearDown(restored.dispose);
      await restored.load();
      expect(restored.value, TerminalThemeChoice.tango);
      expect(restored.isDefault, isFalse);
      await restored.reset();
      await theme.load();
      expect(theme.isDefault, isTrue);
    },
  );

  test('unknown colors and storage failures keep a usable theme', () async {
    final storage = _Store()..values['terminal_theme'] = 'removed-theme';
    final theme = TerminalThemeStore(storage: storage);
    addTearDown(theme.dispose);
    await theme.load();
    expect(theme.isDefault, isTrue);
    storage.fail = true;
    await theme.set(TerminalThemeChoice.tango);
    expect(theme.value, TerminalThemeChoice.tango);
    await theme.load();
    expect(theme.isDefault, isTrue);
  });
}
