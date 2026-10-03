import 'package:flutter/material.dart';
import 'package:xterm/xterm.dart';

import '../shared/theme/color_palette.dart';
import 'terminal_theme_store.dart';

/// Semantic colours for terminal-styled chrome, derived from the scheme's own
/// foreground rather than a hardcoded white. The terminal-dialogs design system
/// says to derive muted text from the foreground, so these are the foreground
/// blended toward the background at increasing strength. They are additive
/// getters, so they never change how an existing theme resolves.
extension TerminalThemeSemantics on TerminalTheme {
  /// Dark ink on a light ground needs more of itself to stand out as far as
  /// light ink does on a dark one, so the blends below are stronger there.
  /// Measured on the grounds they sit on (tool/contrast.py):
  ///
  /// ```
  ///                  graphite #181818   paper #fafaf9   mist workspace #e1e7f0
  /// muted  .54 / .70       5.51              5.97              5.4
  /// faded  .40 / .58       3.61              4.06              3.72
  /// ```
  bool get _lightGround => background.computeLuminance() > .5;

  /// Low-importance text: meta, labels, timestamps, hints, secondary lines.
  Color get muted => foreground.withValues(alpha: _lightGround ? .70 : .54);

  /// Lower still: disabled or strongly receding text. Kept separate from
  /// [muted] so a real hierarchy has more than two levels on the same size.
  Color get faded => foreground.withValues(alpha: _lightGround ? .58 : .40);

  /// The scheme's interactive accent — the cursor colour, which the match-app
  /// theme sets to the app palette's accent.
  Color get accent => cursor;
}

/// The colours a terminal pane's SCREEN draws itself in — the scheme the person
/// chose, exactly. Only what paints the terminal itself reads this (the
/// `TerminalView`, a highlight laid on it, the colours tmux is told, the
/// scheme's own sample in Settings).
///
/// ⚠️ Returns a CACHED (or `const`) instance, never a fresh one. The vendored
/// renderer short-circuits on identity before repainting, so a new
/// [TerminalTheme] built per rebuild reads as "the colours changed" every
/// frame — the same trap [TerminalFontStore] documents for [TerminalStyle].
TerminalTheme terminalScreenThemeFor(
  HarnessPalette palette,
  TerminalThemeChoice choice,
) => switch (choice) {
  // A whole scheme of its own: the app palette is not consulted at all, which
  // is the entire point of offering it.
  TerminalThemeChoice.tango => tangoTerminalTheme,
  TerminalThemeChoice.dark => darkTerminalTheme,
  TerminalThemeChoice.light => lightTerminalTheme,
  TerminalThemeChoice.matchApp => _matchApp(palette),
};

/// The terminal-styled CHROME's colours — pickers, dialogs, headers, status
/// lines — which are drawn on the app palette's grounds or on a ground they
/// take from this same theme.
///
/// The chosen scheme while it agrees with the palette about light and dark;
/// the palette's own match-app theme when it does not. Tango and Dark are dark
/// schemes: under a light palette their white ink would land on the app's
/// light grounds at about 1:1 — every header and picker unreadable — and Light
/// under a dark palette is the same trap the other way round. The terminal
/// screen itself still wears the chosen scheme ([terminalScreenThemeFor]).
///
/// Cached, like [terminalScreenThemeFor]: both return the same instances.
TerminalTheme terminalThemeFor(
  HarnessPalette palette,
  TerminalThemeChoice choice,
) {
  final screen = terminalScreenThemeFor(palette, choice);
  final screenDark = screen.background.computeLuminance() <= .5;
  return screenDark == palette.isDark ? screen : _matchApp(palette);
}

/// Cached per palette. Switching colors repaints the existing terminal view;
/// it does not replace its controller, buffer, input connection or font.
///
/// The ANSI ramp follows the palette's brightness: the dark ramp's pale yellow
/// and white are unreadable on a light ground, and the light ramp's deep ones
/// vanish on a dark one.
TerminalTheme _matchApp(HarnessPalette palette) => _palettes.putIfAbsent(
  palette,
  () {
    final ramp = palette.isDark ? darkTerminalTheme : lightTerminalTheme;
    return TerminalTheme(
      cursor: palette.accent,
      selection: palette.accent.withValues(alpha: 0.3),
      foreground: palette.foreground,
      background: palette.background,
      black: ramp.black,
      red: ramp.red,
      green: ramp.green,
      yellow: ramp.yellow,
      blue: ramp.blue,
      magenta: ramp.magenta,
      cyan: ramp.cyan,
      white: ramp.white,
      brightBlack: ramp.brightBlack,
      brightRed: ramp.brightRed,
      brightGreen: ramp.brightGreen,
      brightYellow: ramp.brightYellow,
      brightBlue: ramp.brightBlue,
      brightMagenta: ramp.brightMagenta,
      brightCyan: ramp.brightCyan,
      brightWhite: ramp.brightWhite,
      searchHitBackground: ramp.searchHitBackground,
      searchHitBackgroundCurrent: ramp.searchHitBackgroundCurrent,
      searchHitForeground: ramp.searchHitForeground,
    );
  },
);

final _palettes = <HarnessPalette, TerminalTheme>{};

/// The ANSI ramp a light palette's terminal uses: GitHub Light's, with the five
/// slots it leaves under text contrast on a near-white ground darkened (same
/// hue) until every one of the sixteen reads at ≥4.6:1 on both light palettes'
/// grounds — white, brightBlue, brightMagenta, brightCyan and brightWhite, the
/// last of which was 2.9:1. Any of them can be a line of an agent's output.
/// Ground and ink come from the palette; [_matchApp] takes only the ramp and
/// search colours.
const lightTerminalTheme = TerminalTheme(
  cursor: Color(0xff0969da),
  selection: Color(0x4d0969da),
  foreground: Color(0xff1f2328),
  background: Color(0xffffffff),
  black: Color(0xff24292f),
  red: Color(0xffcf222e),
  green: Color(0xff116329),
  yellow: Color(0xff4d2d00),
  blue: Color(0xff0969da),
  magenta: Color(0xff8250df),
  cyan: Color(0xff1b7c83),
  white: Color(0xff5c6570),
  brightBlack: Color(0xff57606a),
  brightRed: Color(0xffa40e26),
  brightGreen: Color(0xff1a7f37),
  brightYellow: Color(0xff633c01),
  brightBlue: Color(0xff006ce3),
  brightMagenta: Color(0xff8749f7),
  brightCyan: Color(0xff297a8e),
  brightWhite: Color(0xff69737d),
  searchHitBackground: Color(0xffffff2b),
  searchHitBackgroundCurrent: Color(0xff31ff26),
  searchHitForeground: Color(0xff000000),
);

/// Harness owns the terminal's *default* appearance.
///
/// Terminal streams provide ANSI attributes, not the source application's
/// complete colour scheme.  The default foreground, background, and ANSI ramp
/// must therefore follow Harness's own appearance — this ramp for a dark
/// palette, [lightTerminalTheme]'s for a light one.  Explicit ANSI and
/// true-colour cells remain untouched by xterm, so a TUI keeps the colours it
/// deliberately emits.
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
