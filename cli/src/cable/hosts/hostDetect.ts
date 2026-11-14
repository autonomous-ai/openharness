// Which app an agent runs in, from the few environment values the hook sends. Own variables of a
// multiplexer or terminal come first: they name the nearest host, while TERM_PROGRAM names the outermost one.

/** Each host's macOS app by the bundle id its Info.plist gives it: how `__CFBundleIdentifier` names the app, and how a
 *  tap brings it forward (open.ts). */
export const APP_BUNDLES: Readonly<Record<string, string>> = {
  orca: 'com.stablyai.orca',
  herdr: 'dev.herdr.app',
  kitty: 'net.kovidgoyal.kitty',
  wezterm: 'com.github.wez.wezterm',
  iterm: 'com.googlecode.iterm2',
  'terminal-app': 'com.apple.Terminal',
  ghostty: 'com.mitchellh.ghostty',
  vscode: 'com.microsoft.VSCode',
  cursor: 'com.todesktop.230313mzl4w4u92',
  warp: 'dev.warp.Warp-Stable',
}

const NAMES: Record<string, string> = {
  harness: 'Harness',
  orca: 'Orca',
  herdr: 'herdr',
  rex: 'Rex',
  zellij: 'Zellij',
  kitty: 'kitty',
  wezterm: 'WezTerm',
  iterm: 'iTerm2',
  'terminal-app': 'Terminal',
  ghostty: 'Ghostty',
  vscode: 'VS Code',
  cursor: 'Cursor',
  warp: 'Warp',
  terminal: 'Terminal',
}

export function hostDisplayName(id: string): string {
  return NAMES[id] ?? 'Terminal'
}

export function detectHost(hints: Record<string, string>): string {
  const has = (key: string): boolean => !!hints[key]
  const bundle = hints.__CFBundleIdentifier ?? ''
  const program = hints.TERM_PROGRAM ?? ''
  if (has('HERDR_PANE_ID')) return 'herdr'
  if (has('REX_BLOCK')) return 'rex'
  if (has('ZELLIJ')) return 'zellij'
  if (has('KITTY_WINDOW_ID')) return 'kitty'
  if (has('WEZTERM_PANE')) return 'wezterm'
  if (has('ORCA_AGENT_SESSION_ID') || bundle === APP_BUNDLES.orca) return 'orca'
  // Cursor is a VS Code fork and reports TERM_PROGRAM=vscode, so its bundle id decides first.
  if (bundle === APP_BUNDLES.cursor) return 'cursor'
  if (program === 'iTerm.app' || bundle === APP_BUNDLES.iterm) return 'iterm'
  if (program === 'Apple_Terminal' || bundle === APP_BUNDLES['terminal-app']) return 'terminal-app'
  if (program === 'ghostty' || bundle === APP_BUNDLES.ghostty) return 'ghostty'
  if (program === 'vscode' || bundle === APP_BUNDLES.vscode) return 'vscode'
  if (program === 'WarpTerminal' || bundle === APP_BUNDLES.warp) return 'warp'
  return 'terminal'
}
