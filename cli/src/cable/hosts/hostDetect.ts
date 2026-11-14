// Which app an agent runs in, from the few environment values the hook sends. Own variables of a
// multiplexer or terminal come first: they name the nearest host, while TERM_PROGRAM names the outermost one.

const CURSOR_BUNDLE = 'com.todesktop.230313mzl4w4u92'

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
  if (has('ORCA_AGENT_SESSION_ID') || bundle === 'com.stablyai.orca') return 'orca'
  // Cursor is a VS Code fork and reports TERM_PROGRAM=vscode, so its bundle id decides first.
  if (bundle === CURSOR_BUNDLE) return 'cursor'
  if (program === 'iTerm.app' || bundle === 'com.googlecode.iterm2') return 'iterm'
  if (program === 'Apple_Terminal' || bundle === 'com.apple.Terminal') return 'terminal-app'
  if (program === 'ghostty' || bundle === 'com.mitchellh.ghostty') return 'ghostty'
  if (program === 'vscode' || bundle === 'com.microsoft.VSCode') return 'vscode'
  if (program === 'WarpTerminal' || bundle === 'dev.warp.Warp-Stable') return 'warp'
  return 'terminal'
}
