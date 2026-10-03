import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/terminal/key_hints.dart';

void main() {
  test(
    "Claude Code's shift+tab to cycle becomes a key; its other chrome does not",
    () {
      final hints = parseKeyHints([
        '╭──────────────────────────────────────────╮',
        '│ >                                        │',
        '╰──────────────────────────────────────────╯',
        '  ⏵⏵ accept edits on (shift+tab to cycle)',
      ]);
      expect(hints, hasLength(1));
      expect(hints.single.action, 'cycle');
      expect(hints.single.keyText, 'shift+tab');
    },
  );

  test('esc to interrupt is not a hint: the phone already has esc', () {
    expect(parseKeyHints(['✻ Thinking… (3s · esc to interrupt)']), isEmpty);
  });
}
