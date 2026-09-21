/// What `Ctrl` + a character sends down a pty.
///
/// A software keyboard has no modifier to hold and produces TEXT rather than
/// key events, so a phone cannot reach a control chord the way a keymap does.
/// The pane's key bar arms the modifier instead and the next character typed is
/// translated here, on its way out — see [TerminalSession.armControl].
String? controlChordFor(String character) {
  final runes = character.runes;
  if (runes.length != 1) return null;
  final code = runes.first;

  // The control block IS the printable block minus 0x40, in order: @ A-Z [ \ ] ^ _
  if (code >= 0x40 && code <= 0x5f) return String.fromCharCode(code - 0x40);
  // A phone types lowercase, and Ctrl has never cared about case.
  if (code >= 0x61 && code <= 0x7a) return String.fromCharCode(code - 0x60);
  // The two that table cannot reach, and that shells lean on anyway.
  if (code == 0x20) return '\x00'; // Ctrl+Space — NUL, set-mark in emacs/readline
  if (code == 0x3f) return '\x7f'; // Ctrl+? — DEL

  return null;
}
