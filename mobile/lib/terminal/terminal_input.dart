import 'package:xterm/xterm.dart';

/// Makes ⌥⏎ a newline inside the engine's prompt instead of a submit.
///
/// Claude Code, Codex and every other Ink/readline prompt read Meta+Enter — `ESC` followed by the
/// ordinary Return bytes — as "add a line, do not send this turn yet". A real terminal produces
/// that only when it is configured to treat ⌥ as Meta (iTerm's "Esc+", Terminal.app's "Use Option
/// as Meta Key"); xterm.dart has no such setting, and its [AltInputHandler] deliberately does
/// nothing on macOS so ⌥ stays the compose key for `å`/`ø`/`¬`. So ⌥⏎ fell through to the keytab,
/// which matches on `Return` alone and answers `\r` — the submit. The key the shortcuts sheet
/// promises (`kTerminalOwnedKeys`) sent the turn instead of breaking the line.
///
/// ⌥ is Meta for THIS ONE KEY, not for the keyboard: Enter carries no character to compose, so
/// prefixing it costs nothing that ⌥-as-compose needs, and the rest of the alphabet is untouched.
///
/// The base bytes are asked of [_inner] rather than written out here, because Return is not always
/// `\r`: under LNM (`lineFeedMode`) the keytab answers `\r\n`, and a caller may pass a keytab of
/// its own. Alt and Shift are cleared for that question — Alt so the keytab does not see the very
/// modifier being translated, Shift so ⌥⇧⏎ yields a prefixed Return rather than a prefixed `\EOM`,
/// which no prompt would recognise.
class MetaEnterInputHandler implements TerminalInputHandler {
  const MetaEnterInputHandler(this._inner);

  final TerminalInputHandler _inner;

  @override
  String? call(TerminalKeyboardEvent event) {
    final isEnter =
        event.key == TerminalKey.enter || event.key == TerminalKey.numpadEnter;
    // Ctrl+Alt+Enter is left alone: that chord belongs to whatever is running, not to this.
    if (!isEnter || !event.alt || event.ctrl) return _inner(event);
    final base = _inner(event.copyWith(alt: false, shift: false));
    if (base == null) return null;
    return '\x1b$base';
  }
}

/// The handler every pane's [Terminal] is built with — xterm's default behaviour, plus ⌥⏎.
const TerminalInputHandler harnessInputHandler = MetaEnterInputHandler(
  defaultInputHandler,
);
