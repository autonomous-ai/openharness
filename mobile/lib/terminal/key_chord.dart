import 'package:xterm/xterm.dart';

/// A key as a terminal program's own hint names it — `shift+←`, `ctrl+]`,
/// `⌥+↓` — and what it takes to press it on [Terminal].
///
/// ⚠️ **Read off the hint, never assumed.** Codex's keymap is the person's to
/// change (`tui.keymap` in its config), so the key a hint shows is the only one
/// known to do what the hint says. A chord this cannot resolve is reported as
/// null rather than guessed at: pressing the default on a remapped TUI sends a
/// key that means something else there.
class KeyChord {
  const KeyChord._({
    this.key,
    this.char,
    this.shift = false,
    this.alt = false,
    this.ctrl = false,
  });

  /// A named key — an arrow, Tab, a function key. Null when [char] is set.
  final TerminalKey? key;

  /// A single printable character, when the chord ends in one (`ctrl+]`).
  final String? char;

  final bool shift;
  final bool alt;
  final bool ctrl;

  /// Held with a modifier — Shift, Alt or Ctrl.
  bool get modified => shift || alt || ctrl;

  /// Whether [send] has bytes for it. False only for a Ctrl chord on a
  /// character outside the control range — there is nothing a terminal sends
  /// for `ctrl+ä`, so a button for it would press nothing.
  bool get sendable {
    final char = this.char;
    return key != null || !ctrl || (char != null && _controlCode(char) != null);
  }

  /// Parse the key part of a hint: `shift+←`, `shift + ←`, `⇧←`, `ctrl+]`.
  ///
  /// Null for anything this cannot press — an unknown key name, or a modifier a
  /// terminal has no way to send (`cmd`, `⌘`).
  static KeyChord? parse(String text) {
    // The glyph modifiers are written straight onto their key (`⇧←`); give
    // them the `+` the spelled-out ones carry, so both split the same way.
    final spaced = text.trim().replaceAllMapped(
      RegExp(r'([⇧⌃⌥])(?!\s*\+)'),
      (m) => '${m[1]}+',
    );
    final parts = spaced
        .split('+')
        .map((part) => part.trim())
        .toList(growable: false);
    // `ctrl++` names the plus key itself: the split leaves it as two empties.
    final keyName =
        parts.length >= 3 &&
            parts.last.isEmpty &&
            parts[parts.length - 2].isEmpty
        ? '+'
        : parts.last;
    final modifiers = parts.sublist(
      0,
      keyName == '+' ? parts.length - 2 : parts.length - 1,
    );
    if (keyName.isEmpty) return null;
    var shift = false;
    var alt = false;
    var ctrl = false;
    for (final modifier in modifiers) {
      switch (modifier.toLowerCase()) {
        case 'shift' || '⇧':
          shift = true;
        case 'ctrl' || 'control' || 'ctl' || '⌃' || '^':
          ctrl = true;
        case 'alt' || 'option' || 'opt' || 'meta' || '⌥':
          alt = true;
        default:
          // `cmd`/`⌘` and anything unrecognised: not a key a terminal sends.
          return null;
      }
    }
    final named = _namedKeys[keyName.toLowerCase()];
    if (named != null) {
      return KeyChord._(key: named, shift: shift, alt: alt, ctrl: ctrl);
    }
    // One character, pressed as itself. Anything longer is a key name this
    // does not know.
    if (keyName.runes.length != 1) return null;
    return KeyChord._(
      char: keyName.toLowerCase(),
      shift: shift,
      alt: alt,
      ctrl: ctrl,
    );
  }

  /// Press it: the bytes the far program reads for this chord.
  ///
  /// Returns false when nothing was sent — xterm has no sequence for that
  /// combination of key and modifiers.
  bool send(Terminal terminal) {
    final key = this.key;
    if (key != null) {
      // ⚠️ **A navigation key with a modifier is written out, not looked up.**
      // xterm's keytab answers these for a local terminal, not for a TUI on
      // the far side: Shift+↑/↓ scroll this view and send nothing at all, and
      // any other modifier on ↑/↓ comes out as Ctrl (`\E[1;5A`). The standard
      // xterm form — `CSI 1 ; 1+mods final` — is what both CLIs read.
      // Shift+← is the same bytes either way (`\E[1;2D`).
      final csi = _modifiedNavigation[key];
      if (csi != null && modified) {
        final code = 1 + (shift ? 1 : 0) + (alt ? 2 : 0) + (ctrl ? 4 : 0);
        terminal.textInput(csi(code));
        return true;
      }
      return terminal.keyInput(key, shift: shift, alt: alt, ctrl: ctrl);
    }
    final char = this.char;
    if (char == null) return false;
    var out = char;
    if (shift) out = out.toUpperCase();
    if (ctrl) {
      final code = _controlCode(char);
      if (code == null) return false;
      out = String.fromCharCode(code);
    }
    // ⚠️ Written out rather than left to `charInput`: the session's terminal
    // is set up as macOS (see `terminal_session.dart`), and there xterm leaves
    // Alt to the OS keyboard and sends nothing for it.
    if (alt) out = '\x1b$out';
    terminal.textInput(out);
    return true;
  }

  /// The control byte for `ctrl` + [char]: letters, and `@ [ \ ] ^ _` —
  /// the C0 range a control key reaches. Null for anything else.
  static int? _controlCode(String char) {
    final code = char.toUpperCase().codeUnitAt(0);
    if (code >= 0x40 && code <= 0x5f) return code - 0x40;
    if (char == ' ') return 0;
    // What xterm and every terminal after it send for Ctrl+/: the same byte as
    // Ctrl+_. Codex binds it (its side conversation).
    if (char == '/') return 0x1f;
    return null;
  }

  @override
  bool operator ==(Object other) =>
      other is KeyChord &&
      other.key == key &&
      other.char == char &&
      other.shift == shift &&
      other.alt == alt &&
      other.ctrl == ctrl;

  @override
  int get hashCode => Object.hash(key, char, shift, alt, ctrl);

  @override
  String toString() => [
    if (ctrl) 'ctrl',
    if (alt) 'alt',
    if (shift) 'shift',
    key?.name ?? char ?? '?',
  ].join('+');
}

/// The navigation keys whose modified forms [KeyChord.send] writes itself, by
/// the xterm modifier code (`1 + shift + 2·alt + 4·ctrl`).
final Map<TerminalKey, String Function(int)> _modifiedNavigation = {
  TerminalKey.arrowUp: (m) => '\x1b[1;${m}A',
  TerminalKey.arrowDown: (m) => '\x1b[1;${m}B',
  TerminalKey.arrowRight: (m) => '\x1b[1;${m}C',
  TerminalKey.arrowLeft: (m) => '\x1b[1;${m}D',
  TerminalKey.home: (m) => '\x1b[1;${m}H',
  TerminalKey.end: (m) => '\x1b[1;${m}F',
  TerminalKey.pageUp: (m) => '\x1b[5;$m~',
  TerminalKey.pageDown: (m) => '\x1b[6;$m~',
  TerminalKey.delete: (m) => '\x1b[3;$m~',
};

/// The names a hint gives its keys, spelled out and as glyphs.
const Map<String, TerminalKey> _namedKeys = {
  '←': TerminalKey.arrowLeft,
  'left': TerminalKey.arrowLeft,
  '→': TerminalKey.arrowRight,
  'right': TerminalKey.arrowRight,
  '↑': TerminalKey.arrowUp,
  'up': TerminalKey.arrowUp,
  '↓': TerminalKey.arrowDown,
  'down': TerminalKey.arrowDown,
  'tab': TerminalKey.tab,
  '⇥': TerminalKey.tab,
  'enter': TerminalKey.enter,
  'return': TerminalKey.enter,
  '⏎': TerminalKey.enter,
  '↵': TerminalKey.enter,
  'esc': TerminalKey.escape,
  'escape': TerminalKey.escape,
  'space': TerminalKey.space,
  'backspace': TerminalKey.backspace,
  '⌫': TerminalKey.backspace,
  'delete': TerminalKey.delete,
  'del': TerminalKey.delete,
  'home': TerminalKey.home,
  'end': TerminalKey.end,
  'pageup': TerminalKey.pageUp,
  'pgup': TerminalKey.pageUp,
  'pagedown': TerminalKey.pageDown,
  'pgdn': TerminalKey.pageDown,
  'f1': TerminalKey.f1,
  'f2': TerminalKey.f2,
  'f3': TerminalKey.f3,
  'f4': TerminalKey.f4,
  'f5': TerminalKey.f5,
  'f6': TerminalKey.f6,
  'f7': TerminalKey.f7,
  'f8': TerminalKey.f8,
  'f9': TerminalKey.f9,
  'f10': TerminalKey.f10,
  'f11': TerminalKey.f11,
  'f12': TerminalKey.f12,
};
