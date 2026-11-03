import '../core/runtime_platform.dart';

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
/// Sans Mono, the only monospace `ubuntu-desktop-minimal` depends on.
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

/// Bundled with the app: CanvasKit cannot resolve the browser's system fonts.
const webTerminalFontFamily = 'Roboto Mono';

const linuxTerminalFontFallback = <String>[
  'Ubuntu Sans Mono',
  'Noto Sans Mono',
  'Liberation Mono',
  'monospace',
];

/// The face used by the standard Windows PowerShell terminal.
const windowsTerminalFontFamily = 'Consolas';

const windowsTerminalFontFallback = <String>[
  'Cascadia Mono',
  'Courier New',
  'monospace',
];

/// The default face for the platform this build is running on.
///
/// A getter, not a `const`: the answer depends on the host. The per-platform
/// constants above stay `const` so `TerminalFontChoice` can still name them
/// from its const constructor.
String terminalFontFamilyFor(String operatingSystem) {
  if (operatingSystem == 'web') return webTerminalFontFamily;
  if (operatingSystem == 'macos' || operatingSystem == 'ios') {
    return macTerminalFontFamily;
  }
  if (operatingSystem == 'windows') return windowsTerminalFontFamily;
  return linuxTerminalFontFamily;
}

List<String> terminalFontFallbackFor(String operatingSystem) {
  if (operatingSystem == 'web') return const [];
  if (operatingSystem == 'macos' || operatingSystem == 'ios') {
    return macTerminalFontFallback;
  }
  if (operatingSystem == 'windows') return windowsTerminalFontFallback;
  return linuxTerminalFontFallback;
}

String get terminalFontFamily =>
    terminalFontFamilyFor(RuntimePlatform.operatingSystem);

List<String> get terminalFontFallback =>
    terminalFontFallbackFor(RuntimePlatform.operatingSystem);

/// The default terminal font size — the same on every platform.
const terminalFontSize = 13.0;

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
