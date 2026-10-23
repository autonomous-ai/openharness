import 'package:flutter_test/flutter_test.dart';
import 'package:xterm/xterm.dart';
import 'package:harness_mobile/terminal/terminal_prompt_zone.dart';

void main() {
  Terminal screen(String text, {int cols = 42, int rows = 12}) => Terminal()
    ..resize(cols, rows)
    ..write(text);

  group('typedPromptText', () {
    test("reads Claude Code's prompt, its wrapped rows joined", () {
      final terminal = screen(
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
      final terminal = screen('\r\n› Explain this project to me\r\n\x1b[2;29H');
      expect(
        typedPromptText(terminal.buffer, 'codex'),
        'Explain this project to me',
      );
    });

    test("reads OpenCode's box", () {
      final terminal = screen(
        '  ┃\r\n  ┃  Run the tests\r\n  ┃\r\n  ┃  Build · Claude\x1b[2;19H',
      );
      expect(typedPromptText(terminal.buffer, 'opencode'), 'Run the tests');
    });

    test('nothing for an empty prompt or a placeholder', () {
      expect(typedPromptText(screen('❯ \x1b[1;3H').buffer, 'claude'), isNull);
      final placeholder = screen(
        '❯ \x1b[2mTry "fix lint errors"\x1b[0m\x1b[1;3H',
      );
      expect(typedPromptText(placeholder.buffer, 'claude'), isNull);
    });
  });

  group('emptyPromptAtCursor', () {
    test(
      'true on an empty prompt, and on one showing only its placeholder',
      () {
        expect(emptyPromptAtCursor(screen('❯ \x1b[1;3H').buffer), isTrue);
        expect(
          emptyPromptAtCursor(
            screen('› \x1b[2mAsk Codex to do anything\x1b[0m\x1b[1;3H').buffer,
          ),
          isTrue,
        );
      },
    );

    test('false once something is typed', () {
      expect(emptyPromptAtCursor(screen('❯ hi\x1b[1;5H').buffer), isFalse);
    });

    test('false before the prompt is drawn, or with the cursor off it', () {
      expect(emptyPromptAtCursor(screen('').buffer), isFalse);
      expect(
        emptyPromptAtCursor(screen('Starting Claude Code…\r\n').buffer),
        isFalse,
      );
    });
  });

  group('cursorInPrompt', () {
    test("on Claude Code's and Codex's prompt, typed in or empty", () {
      expect(
        cursorInPrompt(screen('❯ hello world\x1b[1;14H').buffer, 'claude'),
        isTrue,
      );
      expect(cursorInPrompt(screen('❯ \x1b[1;3H').buffer, 'claude'), isTrue);
      expect(
        cursorInPrompt(screen('› hello world\x1b[1;14H').buffer, 'codex'),
        isTrue,
      );
    });

    test('on a row the typed text wrapped onto', () {
      final terminal = screen('❯ a long line that\r\n  wrapped\x1b[2;10H');
      expect(cursorInPrompt(terminal.buffer, 'claude'), isTrue);
    });

    test("inside OpenCode's box, and not left of its side", () {
      final box = '  ┃\r\n  ┃  hello world\r\n  ┃';
      expect(
        cursorInPrompt(screen('$box\x1b[2;17H').buffer, 'opencode'),
        isTrue,
      );
      expect(
        cursorInPrompt(screen('$box\x1b[2;1H').buffer, 'opencode'),
        isFalse,
      );
    });

    test('not on a status line under the prompt', () {
      final terminal = screen(
        '${'─' * 42}\r\n❯ hi\r\n${'─' * 42}\r\n  ? for shortcuts\x1b[4;18H',
      );
      expect(cursorInPrompt(terminal.buffer, 'claude'), isFalse);
    });

    test('never for another engine', () {
      expect(cursorInPrompt(screen('❯ hi\x1b[1;5H').buffer, 'gemini'), isFalse);
      expect(cursorInPrompt(screen('❯ hi\x1b[1;5H').buffer, null), isFalse);
    });
  });
}
