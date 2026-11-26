import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/terminal/claude_first_run.dart';
import 'package:xterm/xterm.dart';

Terminal _screen(String text) => Terminal(maxLines: 50)
  ..resize(60, 12)
  ..write(text.replaceAll('\n', '\r\n'));

void main() {
  test('sees Claude Code\'s first-run screens, and only those', () {
    // As Claude Code 2.1 draws them on MSI (2026-11-26), a new harness signed in elsewhere or not at all.
    expect(
      claudeFirstRunOnScreen(
        _screen(
          " Let's get started.\n\n"
          ' Choose the text style that looks best with your terminal\n'
          ' To change this later, run /theme\n\n'
          ' ❯ ✔ Auto (match terminal)\n   Dark mode',
        ),
      ),
      isTrue,
    );
    expect(
      claudeFirstRunOnScreen(
        _screen(' Select login method:\n\n ❯ 1. Claude account'),
      ),
      isTrue,
    );
    // Claude Code 2.1.332 on MSI, 2026-11-26, after a factory reset: signed in, in a folder never trusted.
    expect(
      claudeFirstRunOnScreen(
        _screen(
          ' Accessing workspace:\n\n /home/me/projects/claude-1\n\n'
          ' Quick safety check: Is this a project you created or one you trust?\n\n'
          ' ❯ No, exit\n   Yes, I trust this folder',
        ),
      ),
      isTrue,
    );
    // Its prompt, ready for words.
    expect(
      claudeFirstRunOnScreen(
        _screen(' ╭──────╮\n │ > Try "fix lint errors" │\n ╰──────╯'),
      ),
      isFalse,
    );
  });

  test('reads only the screen, not what scrolled above it', () {
    final terminal = _screen(' Choose the text style that looks best');
    terminal.write('\r\n' * 30);
    expect(claudeFirstRunOnScreen(terminal), isFalse);
  });
}
