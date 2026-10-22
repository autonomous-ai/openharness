import 'package:flutter_test/flutter_test.dart';
import 'package:xterm/xterm.dart';
import 'package:harness_mobile/terminal/terminal_prompt_zone.dart';

void main() {
  test(
    'reads the real OpenCode starter at phone width, without its model footer',
    () {
      // Captured in OpenCode 1.19.0 on macOS, 42 columns, 2026-10-22.
      final terminal = Terminal()..resize(42, 32);
      terminal.write(
        '  ┃\r\n  ┃  make a small web page that shows\r\n'
        "  ┃  today's date\r\n  ┃\r\n  ┃  Build ·Claude Opus 5.5 Anthropic\r\n"
        '  ┃\r\n  ╹▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀\x1b[3;17H',
      );
      expect(
        openCodePromptText(terminal.buffer),
        "make a small web page that shows today's date",
      );
      terminal.write(
        '\x1b[2J\x1b[H  ┃\r\n  ┃  Ask anything… "Fix broken tests"\r\n  ┃\x1b[2;6H',
      );
      expect(
        openCodePromptText(terminal.buffer),
        isNull,
        reason: 'a placeholder is not a task',
      );
    },
  );
}
