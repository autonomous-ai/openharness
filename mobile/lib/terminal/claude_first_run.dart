import 'package:xterm/xterm.dart';

/// Whether Claude Code's first-run screens are on [terminal]'s screen: "Let's get started. Choose the text style…", the
/// login it asks for next, and the folder's "Quick safety check" (Is this a project you trust?). A harness waiting there
/// takes no message ("prompt_hidden"), and Chat UI cannot show the screens, so it offers Sign in or Continue instead
/// (`chat/engine_sign_in.dart`; Claude Code 2.1, MSI, 2026-11-26).
bool claudeFirstRunOnScreen(Terminal terminal) {
  final lines = terminal.buffer.lines;
  final bottom = lines.length;
  final top = bottom - terminal.viewHeight < 0
      ? 0
      : bottom - terminal.viewHeight;
  for (var index = bottom - 1; index >= top; index--) {
    final text = lines[index].getText();
    if (text.contains('Choose the text style') ||
        text.contains('Select login method') ||
        text.contains('Quick safety check')) {
      return true;
    }
  }
  return false;
}
