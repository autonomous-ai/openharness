import 'dart:math';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/terminal/terminal_prompt_zone.dart';
import 'package:xterm/xterm.dart';

/// A 40×12 screen holding [lines], with the cursor put on [cursorLine] the way
/// the program would put it there. Lines past the screen's height scroll into
/// history, so a line's index is its absolute buffer row either way.
Terminal _screen(
  List<String> lines, {
  required int cursorLine,
  bool alt = false,
}) {
  const rows = 12;
  final terminal = Terminal(maxLines: 200)..resize(40, rows);
  if (alt) terminal.write('\x1b[?1049h');
  terminal.write(lines.join('\r\n'));
  final firstOnScreen = max(0, lines.length - rows);
  terminal.write('\x1b[${cursorLine - firstOnScreen + 1};3H');
  return terminal;
}

List<int> _promptRows(Terminal terminal) => [
  for (var row = 0; row < terminal.buffer.height; row++)
    if (isPromptTap(terminal.buffer, row)) row,
];

void main() {
  test('Codex: the prompt, a row of slack, and the footer under it', () {
    // As captured from a live Codex pane: the cursor sits on `› `.
    final terminal = _screen([
      for (var i = 0; i < 15; i++) '  answer line $i',
      '',
      '',
      '› Ask Codex to do anything',
      '',
      '  gpt-5.6-terra default · ~/work',
    ], cursorLine: 17);
    expect(_promptRows(terminal), [16, 17, 18, 19]);
  });

  test('a dictated sentence that wrapped counts from its first line', () {
    final terminal = _screen([
      '  the answer',
      '',
      '› check the payment flow and then',
      '  tell me which tests are failing',
      '  on the remote box',
      '',
      '  gpt-5.6-terra default · ~/work',
    ], cursorLine: 4);
    expect(_promptRows(terminal).first, 1);
    expect(isPromptTap(terminal.buffer, 0), isFalse);
  });

  test(
    'Claude Code: the rule over the box is the edge, not the text above',
    () {
      // As captured from a live Claude Code pane: alternate screen, cursor on `❯ `.
      final terminal = _screen(
        [
          '  Claude Code',
          '  ~/work',
          '',
          '',
          '─────────────────────',
          '❯ ',
          '─────────────────────',
          '  ⏵⏵ auto mode on',
        ],
        cursorLine: 5,
        alt: true,
      );
      expect(_promptRows(terminal).first, 4);
      expect(isPromptTap(terminal.buffer, 3), isFalse);
    },
  );

  test(
    'a cursor left under the input still reaches the foot of the screen',
    () {
      final terminal = _screen([
        for (var i = 0; i < 9; i++) 'output $i',
        '> type here',
        'footer',
        '',
      ], cursorLine: 11);
      expect(isPromptTap(terminal.buffer, 9), isTrue);
      expect(isPromptTap(terminal.buffer, 8), isFalse);
    },
  );
}
