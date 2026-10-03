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
