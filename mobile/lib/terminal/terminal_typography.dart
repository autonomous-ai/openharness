import 'package:flutter/foundation.dart';

/// The default terminal face, per platform.
///
/// Every family named here has to actually resolve on the OS it is named for,
/// and a *monospace* one: the renderer measures one cell by laying out ten `m`
/// glyphs and dividing by ten (`TerminalPainter._measureCharSize`), so a
/// proportional substitute misaligns every column a TUI draws.
///
/// Asking for a face the system does not have is not a loud failure. Measured
/// on Ubuntu 26.04 with a real Linux build (`TextPainter`, 13px, advance width
/// of `m` vs `i` — equal means monospace):
///
/// ```text
/// DejaVu Sans Mono                m=7.83  i=7.83   ← monospace
/// Ubuntu Sans Mono                m=7.28  i=7.28   ← monospace
/// Liberation Mono                 m=7.80  i=7.80   ← monospace
/// .AppleSystemUIFontMonospaced    m=11.22 i=3.16   ← PROPORTIONAL
/// Menlo                           m=11.22 i=3.16   ← PROPORTIONAL
/// monospace  (the generic)        m=11.22 i=3.16   ← PROPORTIONAL
/// NoSuchFamilyXYZ                 m=11.22 i=3.16   ← the engine's own default
/// ```
///
/// Two things follow. The old macOS-only stack rendered the terminal in a
/// proportional face on Linux, at 3.5× the width for `m` over `i` — that is the
/// broken grid. And **the trailing `'monospace'` is inert**: Flutter resolves
/// families through Skia, which does not honour fontconfig's generic aliases,
/// so it measures exactly like a family that does not exist. It stays in the
/// lists as a last resort for other engines, but it is not a safety net — every
/// chain has to name a real face it can reach. On Linux that anchor is DejaVu
/// Sans Mono, the only monospace `ubuntu-desktop-minimal` depends on. On
/// Android it is `monospace` itself — see [androidTerminalFontFamily].
///
/// The live, user-chosen typography lives in `terminalFontStore`, not here;
/// these are what a fresh install opens with and what `reset()` returns to.

/// SF Mono's CoreText family name.
///
/// Flutter does not reliably resolve the human-facing `SF Mono` name on macOS;
/// this is the system alias that CoreText resolves to Apple's monospaced face.
const macTerminalFontFamily = '.AppleSystemUIFontMonospaced';

const macTerminalFontFallback = <String>[
  'Menlo',
  'Monaco',
  'Courier New',
  'monospace',
];

/// DejaVu Sans Mono, and why it leads on Linux.
///
/// It is the only monospace `ubuntu-desktop-minimal` *depends* on — the Ubuntu
/// and Noto mono packages are recommendations, which an install can decline —
/// and the only one of them carrying `✔ ✗ ● ╭ ▏`, the glyphs an agent's TUI
/// draws. That matters more than it sounds: a glyph missing from the primary
/// face is fetched from a fallback at a different advance width, and the grid
/// goes ragged in exactly the places a coding agent puts its output.
const linuxTerminalFontFamily = 'DejaVu Sans Mono';

const linuxTerminalFontFallback = <String>[
  'Ubuntu Sans Mono',
  'Noto Sans Mono',
  'Liberation Mono',
  'monospace',
];

/// Droid Sans Mono, by the only name Android gives it.
///
/// Android ships two monospace faces and no others: Droid Sans Mono, which its
/// `fonts.xml` declares as the family `monospace`, and Cutive Mono, declared as
/// `serif-monospace`. Skia's Android font manager looks families up by the
/// names `fonts.xml` declares, so those generic names are the real families
/// here — the opposite of Linux, where Skia ignores fontconfig's generic
/// aliases and `monospace` is inert (above). Every Linux and Apple face names
/// nothing on a phone, so before Android had a list of its own each of them
/// fell through to this same face: the Font sheet offered five names for one
/// font.
///
/// No fallback of its own: Cutive Mono covers less than this does, and a glyph
/// missing here goes to the system's own fallback chain.
const androidTerminalFontFamily = 'monospace';

const androidTerminalFontFallback = <String>[];

/// The default terminal font size: 13 on a desktop, 14 on a phone.
///
/// Tried on an iPhone: 13 read as small print, 16 as far too big. Monospace is wider than the
/// proportional faces reading apps use — X sets posts at about 15 — so 14 here reads about as large
/// as those, and keeps about 43 columns on a 390pt iPhone.
double get terminalFontSize => switch (defaultTargetPlatform) {
  TargetPlatform.iOS || TargetPlatform.android => 14.0,
  _ => 13.0,
};

/// Bundled icon face for private-use glyphs (Nerd Font / codicons).
///
/// Claude Code prints those icons as one column. None of the text faces above
/// contain them, and Flutter will not go looking through fonts that were not
/// named. This face contains only the icons, each one em wide, so the painter
/// scales it to the cell measured from the text face.
const terminalIconFontFamily = 'Symbols Nerd Font Mono';

/// Whether [family] is a Nerd Font. Its own icons are sized for its cell, so
/// the terminal draws them rather than [terminalIconFontFamily]'s.
///
/// Nerd Fonts' patcher adds `Nerd Font`, `Nerd Font Mono` or `Nerd Font Propo`
/// to the family it patches, or `NF`, `NFM` or `NFP` where the long name is too
/// long. Fonts that ship the icons themselves (Cascadia Code NF,
/// powerlevel10k's MesloLGS NF, Maple Mono NF) follow the same convention.
bool isNerdFontFamily(String family) => _nerdFontName.hasMatch(family);

final _nerdFontName = RegExp(r'(?:^|\s)(?:Nerd Font|NFM?|NFP)(?:\s|$)');
