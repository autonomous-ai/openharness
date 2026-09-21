import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/widgets/box_chrome.dart';

import 'keymap_host_test.dart' show key;

void main() {
  Future<TextEditingController> editor(
    WidgetTester tester, {
    bool enabled = true,
  }) async {
    final controller = TextEditingController();
    addTearDown(controller.dispose);
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: ReadlineKeys(
            enabled: enabled,
            controller: controller,
            onChanged: (_) {},
            child: TextField(
              autofocus: true,
              controller: controller,
              maxLines: 5,
            ),
          ),
        ),
      ),
    );
    await tester.pump();
    return controller;
  }

  for (final backwards in [true, false]) {
    testWidgets(
      'Ctrl-${backwards ? 'H' : 'D'} deletes one visible character',
      variant: TargetPlatformVariant({
        TargetPlatform.macOS,
        TargetPlatform.linux,
      }),
      (tester) async {
        final controller = await editor(tester);
        for (final character in ['🐙', '👩🏽‍💻', 'e\u0301', '🇻🇳']) {
          controller.value = TextEditingValue(
            text: 'a${character}b',
            selection: TextSelection.collapsed(
              offset: backwards ? 1 + character.length : 1,
            ),
          );
          await key(
            tester,
            backwards ? LogicalKeyboardKey.keyH : LogicalKeyboardKey.keyD,
            ctrl: true,
          );
          expect(controller.text, 'ab', reason: character);
          expect(
            controller.selection,
            const TextSelection.collapsed(offset: 1),
          );
        }
        await tester.pumpWidget(const SizedBox());
      },
    );
  }

  testWidgets('kill word respects lines and path segments, and can be yanked', (
    tester,
  ) async {
    final controller = await editor(tester);
    await tester.enterText(find.byType(TextField), 'first line\nsecond');
    await key(tester, LogicalKeyboardKey.keyW, ctrl: true);
    expect(controller.text, 'first line\n');
    await key(tester, LogicalKeyboardKey.keyY, ctrl: true);
    expect(controller.text, 'first line\nsecond');
    await tester.enterText(find.byType(TextField), '/work/emoji-🐙/source\t');
    await key(tester, LogicalKeyboardKey.keyW, ctrl: true);
    expect(controller.text, '/work/emoji-🐙/');
    await key(tester, LogicalKeyboardKey.keyY, ctrl: true);
    expect(controller.text, '/work/emoji-🐙/source\t');
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('kill line keeps preceding task lines and restores with Ctrl-Y', (
    tester,
  ) async {
    final controller = await editor(tester);
    controller.value = const TextEditingValue(
      text: 'first line\nedit here\nlast line',
      selection: TextSelection.collapsed(offset: 15),
    );
    await key(tester, LogicalKeyboardKey.keyU, ctrl: true);
    expect(controller.text, 'first line\n here\nlast line');
    await key(tester, LogicalKeyboardKey.keyY, ctrl: true);
    expect(controller.text, 'first line\nedit here\nlast line');
    expect(controller.selection, const TextSelection.collapsed(offset: 15));
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('editing keys preserve composition and a locked prompt', (
    tester,
  ) async {
    for (final enabled in [true, false]) {
      final controller = await editor(tester, enabled: enabled);
      final value = TextEditingValue(
        text: '日本語 🐙',
        selection: const TextSelection.collapsed(offset: 2),
        composing: enabled
            ? const TextRange(start: 0, end: 3)
            : TextRange.empty,
      );
      controller.value = value;
      for (final letter in [
        LogicalKeyboardKey.keyH,
        LogicalKeyboardKey.keyD,
        LogicalKeyboardKey.keyW,
        LogicalKeyboardKey.keyU,
        LogicalKeyboardKey.keyY,
      ]) {
        await key(tester, letter, ctrl: true);
        expect(controller.value, value);
      }
      await tester.pumpWidget(const SizedBox());
    }
  });
}
