import 'package:flutter/material.dart';
import 'package:xterm/xterm.dart';

import '../shared/theme/color_palette.dart';
import 'terminal_theme_store.dart';

/// The colours a terminal pane draws itself in.
///
/// ⚠️ Returns a CACHED (or `const`) instance, never a fresh one. The vendored
/// renderer short-circuits on identity before repainting, so a new
/// [TerminalTheme] built per rebuild reads as "the colours changed" every
/// frame — the same trap [TerminalFontStore] documents for [TerminalStyle].
TerminalTheme terminalThemeFor(
  HarnessPalette palette,
  TerminalThemeChoice choice,
) => switch (choice) {
  // A whole scheme of its own: the app palette is not consulted at all, which
  // is the entire point of offering it.
  TerminalThemeChoice.tango => tangoTerminalTheme,
  TerminalThemeChoice.matchApp => _matchApp(palette),
};

/// Cached per palette. Switching colors repaints the existing terminal view;
/// it does not replace its controller, buffer, input connection or font.
TerminalTheme _matchApp(HarnessPalette palette) => _palettes.putIfAbsent(
  palette,
  () => TerminalTheme(
    cursor: palette.accent,
    selection: palette.accent.withValues(alpha: 0.3),
    foreground: palette.foreground,
    background: palette.background,
    black: darkTerminalTheme.black,
    red: darkTerminalTheme.red,
    green: darkTerminalTheme.green,
    yellow: darkTerminalTheme.yellow,
    blue: darkTerminalTheme.blue,
    magenta: darkTerminalTheme.magenta,
    cyan: darkTerminalTheme.cyan,
    white: darkTerminalTheme.white,
    brightBlack: darkTerminalTheme.brightBlack,
    brightRed: darkTerminalTheme.brightRed,
    brightGreen: darkTerminalTheme.brightGreen,
    brightYellow: darkTerminalTheme.brightYellow,
    brightBlue: darkTerminalTheme.brightBlue,
    brightMagenta: darkTerminalTheme.brightMagenta,
    brightCyan: darkTerminalTheme.brightCyan,
    brightWhite: darkTerminalTheme.brightWhite,
    searchHitBackground: darkTerminalTheme.searchHitBackground,
    searchHitBackgroundCurrent: darkTerminalTheme.searchHitBackgroundCurrent,
    searchHitForeground: darkTerminalTheme.searchHitForeground,
  ),
);

final _palettes = <HarnessPalette, TerminalTheme>{};

/// Harness owns the terminal's *default* appearance.
///
/// Terminal streams provide ANSI attributes, not the source application's
/// complete colour scheme.  The default foreground, background, and ANSI ramp
/// must therefore follow Harness's own (dark-only) appearance.  Explicit ANSI
/// and true-colour cells remain untouched by xterm, so a TUI keeps the colours
/// it deliberately emits.
const darkTerminalTheme = TerminalTheme(
  cursor: Color(0xffaeafad),
  // Translucent, not opaque: this is painted over the glyphs after they're drawn (see
  // render.dart's _paint), so an opaque fill here erased the selected text instead of
  // highlighting it, unlike every native terminal's selection. ~40% of the theme's own
  // brightBlue below, matching the tinted-overlay look those terminals use.
  selection: Color(0x663B8EEA),
  foreground: Color(0xffffffff),
  background: Color(0xff181818),
  black: Color(0xff000000),
  red: Color(0xffcd3131),
  green: Color(0xff0dbc79),
  yellow: Color(0xffe5e510),
  blue: Color(0xff2472c8),
  magenta: Color(0xffbc3fbc),
  cyan: Color(0xff11a8cd),
  white: Color(0xffe5e5e5),
  brightBlack: Color(0xff666666),
  brightRed: Color(0xfff14c4c),
  brightGreen: Color(0xff23d18b),
  brightYellow: Color(0xfff5f543),
  brightBlue: Color(0xff3b8eea),
  brightMagenta: Color(0xffd670d6),
  brightCyan: Color(0xff29b8db),
  brightWhite: Color(0xffffffff),
  searchHitBackground: Color(0xffffff2b),
  searchHitBackgroundCurrent: Color(0xff31ff26),
  searchHitForeground: Color(0xff000000),
);

/// The Tango palette, as GNOME Terminal ships it — what an agent looks like on
/// a stock Ubuntu desktop.
///
/// ⚠️ The sixteen ANSI slots below are Tango's, unmodified. The GROUND is not:
/// `#300A24` is Ubuntu's own aubergine, which it sets as a custom text colour
/// over this palette, and `#ffffff` the foreground that goes with it. Tango's
/// own dark is `#2e3436` and it is still here, as `black`, where a program
/// asking for colour 0 will find it. Swapping the ground for `black` would be
/// "more correct" and would stop looking like the thing people recognise.
///
/// `selection` is translucent for the reason [darkTerminalTheme] gives — it is
/// painted OVER the glyphs — at the same ~40% of this scheme's own brightBlue.
///
/// The three `searchHit*` colours are deliberately Harness's, shared with
/// [darkTerminalTheme]: find-in-terminal is this app's affordance, not
/// something the scheme has an opinion about, and a highlight that moved with
/// the palette would be a different colour to hunt for per scheme.
const tangoTerminalTheme = TerminalTheme(
  cursor: Color(0xffffffff),
  selection: Color(0x66729fcf),
  foreground: Color(0xffffffff),
  background: Color(0xff300a24),
  black: Color(0xff2e3436),
  red: Color(0xffcc0000),
  green: Color(0xff4e9a06),
  yellow: Color(0xffc4a000),
  blue: Color(0xff3465a4),
  magenta: Color(0xff75507b),
  cyan: Color(0xff06989a),
  white: Color(0xffd3d7cf),
  brightBlack: Color(0xff555753),
  brightRed: Color(0xffef2929),
  brightGreen: Color(0xff8ae234),
  brightYellow: Color(0xfffce94f),
  brightBlue: Color(0xff729fcf),
  brightMagenta: Color(0xffad7fa8),
  brightCyan: Color(0xff34e2e2),
  brightWhite: Color(0xffeeeeec),
  searchHitBackground: Color(0xffffff2b),
  searchHitBackgroundCurrent: Color(0xff31ff26),
  searchHitForeground: Color(0xff000000),
);
