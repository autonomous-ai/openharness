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

/// A 42×12 screen with [text] written to it as a program would write it.
Terminal _raw(String text) => Terminal()
  ..resize(42, 12)
  ..write(text);

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

  group('a dialog drawn where the prompt was', () {
    // Claude Code with an MCP server's Accept/Decline open, as captured from a live pane
    // (openharness#1272): the prompt hidden, the cursor parked on the blank row under the footer.
    const dialog = [
      '  output',
      '',
      '────────────────────────────────────────',
      '  MCP server “x” requests your input',
      '',
      '  This SQL includes destructive op…',
      '',
      '  ❯ Accept    Decline',
      '',
      '  Esc to cancel · ↑/↓ to navigate',
      '',
      '',
    ];

    test('counts whole, from the rule over it down', () {
      final terminal = _screen(dialog, cursorLine: 10);
      expect(_promptRows(terminal).first, 2);
      // The buttons themselves, which the cursor alone left out.
      expect(isPromptTap(terminal.buffer, 7), isTrue);
      expect(isPromptTap(terminal.buffer, 1), isFalse);
    });

    test('keeps the cursor\'s zone where the host answers its rows itself', () {
      final terminal = _screen(dialog, cursorLine: 10);
      expect(isPromptTap(terminal.buffer, 7, wholeDialog: false), isFalse);
      expect(isPromptTap(terminal.buffer, 9, wholeDialog: false), isTrue);
    });

    test('a rule with no footer under it is output, not a dialog', () {
      final terminal = _screen([
        for (var i = 0; i < 4; i++) 'output $i',
        '----------------------------------------',
        'build ok',
        'tests ok',
        'lint ok',
        'deploy ok',
        'done',
        '',
        '',
      ], cursorLine: 11);
      expect(isPromptTap(terminal.buffer, 6), isFalse);
    });

    test('the prompt box under its rule is the prompt, not a dialog', () {
      final terminal = _screen(
        [
          '  answer',
          '',
          '────────────────────────────────────────',
          '❯ ',
          '────────────────────────────────────────',
          '  ⏵⏵ auto mode on (shift+tab to cycle)',
        ],
        cursorLine: 3,
        alt: true,
      );
      expect(_promptRows(terminal).first, 2);
      expect(isPromptTap(terminal.buffer, 1), isFalse);
    });
  });

  group('typedPromptText', () {
    test("reads Claude Code's prompt, its wrapped rows joined", () {
      final terminal = _raw(
        '─' * 42 +
            '\r\n❯ make a small web page that shows the date\r\n'
                '  and the time\r\n${'─' * 42}\r\n  ? for shortcuts\x1b[3;15H',
      );
      expect(
        typedPromptText(terminal.buffer, 'claude'),
        'make a small web page that shows the date and the time',
      );
    });

    test("reads Codex's prompt", () {
      final terminal = _raw('\r\n› Explain this project to me\r\n\x1b[2;29H');
      expect(
        typedPromptText(terminal.buffer, 'codex'),
        'Explain this project to me',
      );
    });

    test("reads OpenCode's box", () {
      final terminal = _raw(
        '  ┃\r\n  ┃  Run the tests\r\n  ┃\r\n  ┃  Build · Claude\x1b[2;19H',
      );
      expect(typedPromptText(terminal.buffer, 'opencode'), 'Run the tests');
    });

    test('nothing for an empty prompt or a placeholder', () {
      expect(typedPromptText(_raw('❯ \x1b[1;3H').buffer, 'claude'), isNull);
      final placeholder = _raw(
        '❯ \x1b[2mTry "fix lint errors"\x1b[0m\x1b[1;3H',
      );
      expect(typedPromptText(placeholder.buffer, 'claude'), isNull);
    });
  });

  group('emptyPromptAtCursor', () {
    test(
      'true on an empty prompt, and on one showing only its placeholder',
      () {
        expect(emptyPromptAtCursor(_raw('❯ \x1b[1;3H').buffer), isTrue);
        expect(
          emptyPromptAtCursor(
            _raw('› \x1b[2mAsk Codex to do anything\x1b[0m\x1b[1;3H').buffer,
          ),
          isTrue,
        );
      },
    );

    test('false once something is typed', () {
      expect(emptyPromptAtCursor(_raw('❯ hi\x1b[1;5H').buffer), isFalse);
    });

    test('false before the prompt is drawn, or with the cursor off it', () {
      expect(emptyPromptAtCursor(_raw('').buffer), isFalse);
      expect(
        emptyPromptAtCursor(_raw('Starting Claude Code…\r\n').buffer),
        isFalse,
      );
    });
  });

  group('cursorInPrompt', () {
    test("on Claude Code's and Codex's prompt, typed in or empty", () {
      expect(
        cursorInPrompt(_raw('❯ hello world\x1b[1;14H').buffer, 'claude'),
        isTrue,
      );
      expect(cursorInPrompt(_raw('❯ \x1b[1;3H').buffer, 'claude'), isTrue);
      expect(
        cursorInPrompt(_raw('› hello world\x1b[1;14H').buffer, 'codex'),
        isTrue,
      );
    });

    test('on a row the typed text wrapped onto', () {
      final terminal = _raw('❯ a long line that\r\n  wrapped\x1b[2;10H');
      expect(cursorInPrompt(terminal.buffer, 'claude'), isTrue);
    });

    test("inside OpenCode's box, and not left of its side", () {
      final box = '  ┃\r\n  ┃  hello world\r\n  ┃';
      expect(cursorInPrompt(_raw('$box\x1b[2;17H').buffer, 'opencode'), isTrue);
      expect(cursorInPrompt(_raw('$box\x1b[2;1H').buffer, 'opencode'), isFalse);
    });

    test('not on a status line under the prompt', () {
      final terminal = _raw(
        '${'─' * 42}\r\n❯ hi\r\n${'─' * 42}\r\n  ? for shortcuts\x1b[4;18H',
      );
      expect(cursorInPrompt(terminal.buffer, 'claude'), isFalse);
    });

    test('never for another engine', () {
      expect(cursorInPrompt(_raw('❯ hi\x1b[1;5H').buffer, 'gemini'), isFalse);
      expect(cursorInPrompt(_raw('❯ hi\x1b[1;5H').buffer, null), isFalse);
    });
  });

  group('a dialog where the prompt was', () {
    test(
      "a question's answer the cursor sits on is no prompt, empty or not",
      () {
        final dialog = _raw(
          ' Do you trust the files in this folder?\r\n\r\n'
          '❯ 1. Yes, proceed\r\n  2. No, exit\x1b[3;3H',
        );
        expect(emptyPromptAtCursor(dialog.buffer), isFalse);
        expect(cursorInPrompt(dialog.buffer, 'claude'), isFalse);
        expect(typedPromptText(dialog.buffer, 'claude'), isNull);
      },
    );
  });

  group('holdsPasteMarker', () {
    test("Claude Code's and Codex's paste markers", () {
      expect(holdsPasteMarker('fix [Pasted text #1 +12 lines]'), isTrue);
      expect(holdsPasteMarker('what is in [Image #2]'), isTrue);
      expect(holdsPasteMarker('[Pasted Content 1200 chars] read this'), isTrue);
    });

    test('nothing else', () {
      expect(holdsPasteMarker('make a small web page'), isFalse);
      expect(holdsPasteMarker('see [the docs] #1'), isFalse);
    });
  });
}
