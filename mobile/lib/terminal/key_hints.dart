import 'package:xterm/xterm.dart';

import 'key_chord.dart';

/// A key a CLI's own chrome offers — `(shift+tab to cycle)`, `ctrl+] skip`,
/// `⌥+↓ main prompt` — that a phone has no way to press.
///
/// ⚠️ **Why read them off the screen at all.** A phone keyboard has no Shift,
/// Ctrl, Alt or function keys to hold, and the key strip carries only the
/// handful of keys every pane needs. What each CLI binds to those modifiers is
/// its own, changes between versions, and is the person's to remap (Codex's
/// `tui.keymap`) — so the key the CLI prints next to what it does is the one
/// reliable source for both halves. Measured on Codex 0.156.1 and Claude Code
/// 2.1.281, where the chords that stranded a phone were `shift+←` (a queued
/// question), `ctrl+]` and `⌥+↓` (leaving one), and `shift+tab` (Claude's
/// permission modes).
class KeyHint {
  const KeyHint({
    required this.chord,
    required this.keyText,
    required this.action,
  });

  final KeyChord chord;

  /// The key as the chrome printed it — `ctrl+]`, `⌥+↓`, `shift + ←` — for the
  /// button to repeat word for word, so it reads as the hint beside it rather
  /// than as a translation of it.
  final String keyText;

  /// What the hint says the key does, as the CLI worded it — `cycle`,
  /// `main prompt`.
  final String action;

  @override
  bool operator ==(Object other) =>
      other is KeyHint &&
      other.chord == chord &&
      other.keyText == keyText &&
      other.action == action;

  @override
  int get hashCode => Object.hash(chord, keyText, action);

  @override
  String toString() => '$keyText $action';
}

/// How many of the pane's last non-blank lines count as its live chrome.
///
/// ⚠️ **Only the bottom, never the transcript.** Both CLIs draw their live
/// chrome — the status line, a dialog's footer, the spinner's key hints —
/// under everything else; what is above is conversation, where a model
/// explaining a shortcut would otherwise grow a button. Five covers Claude's
/// footer wrapped over three lines on a phone-width pane plus the status line.
const int _chromeLines = 5;

/// How far up from the bottom the walk may go looking for those lines.
///
/// ⚠️ A whole phone pane and more, not a handful: a short conversation leaves
/// every row under its prompt blank, and on a 50-row pane that is most of the
/// screen. Skipping a blank row costs nothing.
const int _chromeScan = 60;

/// The most hints offered at once. More would be a second key strip, and the
/// point is the one or two a screen is actually asking for.
const int _maxHints = 4;

/// A key as the chrome writes one: modifiers joined to a key by `+`, or a bare
/// function key. Modifiers are required for everything else — a plain `esc`
/// or `tab` is a key the phone already has.
final RegExp _chord = RegExp(
  r'(?<![\w+])'
  r'((?:(?:shift|ctrl|control|alt|option|opt|meta|[⇧⌃⌥])\s*\+\s*)+'
  r"(?:tab|enter|return|esc|escape|space|backspace|delete|del|up|down|left|right|home|end|pageup|pagedown|pgup|pgdn|f(?:1[0-2]|[1-9])|[←→↑↓]|[a-z0-9]|[\]\[\\/.,;'`=\-])"
  r'|f(?:1[0-2]|[1-9]))'
  r'(?![\w])',
  caseSensitive: false,
);

/// What follows a key: `to cycle`, `skip`, `main prompt` — words joined by
/// single spaces, ended by the separators the chrome puts between hints
/// (`·`, `|`, a bracket, a comma, a run of spaces) or by the line's end.
final RegExp _action = RegExp(
  r"^\s*(?:to\s+)?([a-z][a-z']*(?: [a-z][a-z']*){0,2})",
  caseSensitive: false,
);

/// Chords never offered as a button, however the chrome describes them: the
/// process-control keys. One tap from a glance must not be the key that quits
/// the agent, drops its session or suspends it.
bool _isProcessControl(KeyChord chord) =>
    chord.ctrl &&
    !chord.alt &&
    !chord.shift &&
    chord.key == null &&
    const {'c', 'd', 'z', '\\'}.contains(chord.char);

/// Words that make a hint an irreversible act. Offered as a button, each would
/// be one tap from a glance at the screen — a confirm-by-pressing-again prompt
/// (`ctrl+x again to delete`) exists precisely to take more than that.
final RegExp _destructive = RegExp(
  r'\b(exit|quit|kill|delete|discard|remove|suspend|abort|stop|uninstall|reset)\b',
  caseSensitive: false,
);

/// Whether a phone can already press [chord] — the software keyboard or the
/// key strip has it — so a hint for it would only repeat a key on screen.
bool _phoneHas(KeyChord chord) {
  if (chord.modified) return false;
  final key = chord.key;
  if (key == null) return true;
  return const {
    TerminalKey.escape,
    TerminalKey.tab,
    TerminalKey.enter,
    TerminalKey.space,
    TerminalKey.backspace,
    TerminalKey.arrowLeft,
    TerminalKey.arrowRight,
    TerminalKey.arrowUp,
    TerminalKey.arrowDown,
  }.contains(key);
}

/// The hints in the pane's live chrome that a phone cannot press itself, in
/// reading order, one per key.
List<KeyHint> parseKeyHints(List<String> lines) {
  final chrome = <String>[];
  for (
    var i = lines.length - 1;
    i >= 0 && lines.length - i <= _chromeScan && chrome.length < _chromeLines;
    i--
  ) {
    if (lines[i].trim().isNotEmpty) chrome.insert(0, lines[i]);
  }
  final hints = <KeyHint>[];
  for (final line in chrome) {
    for (final match in _chord.allMatches(line)) {
      final chord = KeyChord.parse(match.group(1)!);
      if (chord == null ||
          !chord.sendable ||
          _phoneHas(chord) ||
          _isProcessControl(chord)) {
        continue;
      }
      final words = _action.firstMatch(line.substring(match.end));
      // A key with nothing said about it is a name in a sentence, not a hint.
      if (words == null) continue;
      final action = words.group(1)!.toLowerCase();
      if (_destructive.hasMatch(action)) continue;
      if (hints.any((hint) => hint.chord == chord)) continue;
      hints.add(
        KeyHint(
          chord: chord,
          // Spacing collapsed, nothing else touched: `shift + ←` stays as the
          // pane drew it.
          keyText: match.group(1)!.trim().replaceAll(RegExp(r'\s+'), ' '),
          action: action,
        ),
      );
      if (hints.length == _maxHints) return hints;
    }
  }
  return hints;
}
