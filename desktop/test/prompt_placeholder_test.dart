import 'package:flutter_test/flutter_test.dart';
import 'package:xterm/src/ui/prompt_placeholder.dart';
import 'package:xterm/xterm.dart';

/// The cursor sits after `› ` (column 2), the way an empty agent prompt shows.
int placeholderEndAfterPrompt(String rest) {
  final terminal = Terminal(maxLines: 200, reflowEnabled: false)
    ..resize(80, 12);
  terminal.write('› $rest\x1b[1;3H');
  return promptPlaceholderEnd(
    terminal.buffer.currentLine,
    terminal.buffer.cursorX,
  );
}

void main() {
  test('covers a dim placeholder up to its last character', () {
    expect(
      placeholderEndAfterPrompt('\x1b[2mAsk Codex to do anything\x1b[0m'),
      2 + 'Ask Codex to do anything'.length,
    );
  });

  test('ignores the plain blanks a prompt pads its row with', () {
    expect(
      placeholderEndAfterPrompt('\x1b[2mTry "edit"\x1b[0m        '),
      2 + 'Try "edit"'.length,
    );
  });

  test('never covers real text after the cursor', () {
    expect(placeholderEndAfterPrompt('rest of the line'), 2);
    expect(placeholderEndAfterPrompt('\x1b[2mdim\x1b[0m and real'), 2);
  });

  test('covers nothing on an empty row', () {
    expect(placeholderEndAfterPrompt(''), 2);
  });
}
