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
  claude: 'com.anthropic.claudefordesktop',
  codex: 'com.openai.codex',
}

const NAMES: Record<string, string> = {
  harness: 'Harness',
  orca: 'Orca',
  herdr: 'herdr',
  rex: 'Rex',
  zellij: 'Zellij',
  tmux: 'tmux',
  kitty: 'kitty',
  wezterm: 'WezTerm',
  iterm: 'iTerm2',
  'terminal-app': 'Terminal',
  ghostty: 'Ghostty',
  vscode: 'VS Code',
  cursor: 'Cursor',
  warp: 'Warp',
  claude: 'Claude',
  codex: 'ChatGPT',
  terminal: 'Terminal',
}

/** The apps an agent can run in, the dial's pages: the hosts, in the order of their names. Seventeen ids; the firmware
 *  holds 16 (`CABLE_MAX_APPS`), and the `apps` frame holds to it (`APP_LIMIT`, select.ts). */
export const APP_IDS: readonly string[] = Object.keys(NAMES)

/** An agent in a terminal the daemon does not know. */
export const UNKNOWN_APP = 'terminal'

/** Harness Desktop's bundle id. */
export const HARNESS_BUNDLE = 'ai.autonomous.harness'

// The outermost app by its bundle id: each host's app, and Harness Desktop's, which stays out of APP_BUNDLES because no
// hint's bundle id ever opens Harness: a tap on a Harness agent with no window starts it by this id alone (open.ts
// `desktop`).
export const BUNDLE_APPS: Readonly<Record<string, string>> = {
  ...Object.fromEntries(Object.entries(APP_BUNDLES).map(([id, bundle]) => [bundle, id])),
  [HARNESS_BUNDLE]: 'harness',
}

// kitty sets no TERM_PROGRAM: off macOS its own variable names it (detectApp).
const PROGRAM_APPS: Readonly<Record<string, string>> = {
  'iTerm.app': 'iterm',
  Apple_Terminal: 'terminal-app',
  ghostty: 'ghostty',
  vscode: 'vscode',
  WarpTerminal: 'warp',
  WezTerm: 'wezterm',
  tmux: 'tmux',
}

export function hostDisplayName(id: string): string {
  return NAMES[id] ?? 'Terminal'
}

/** "Other" for the unknown app, so its page never reads as Apple's Terminal; a host's own name for the rest. */
export function appDisplayName(id: string): string {
  return id === UNKNOWN_APP ? 'Other' : hostDisplayName(id)
}

/** The outermost app an agent runs in. The bundle id and TERM_PROGRAM name it, unlike a multiplexer's own variables,
 *  which name the nearest host; with neither set, the nearest host is the only one known. */
export function detectApp(hints: Record<string, string>): string {
  const bundle = hints.__CFBundleIdentifier ?? ''
  const program = hints.TERM_PROGRAM ?? ''
  // Cursor is a VS Code fork and reports TERM_PROGRAM=vscode, so the bundle id decides first. A hint is outside text:
  // only a table's own key names an app, never one an object inherits (`constructor`).
  if (Object.hasOwn(BUNDLE_APPS, bundle)) return BUNDLE_APPS[bundle]
  if (Object.hasOwn(PROGRAM_APPS, program)) return PROGRAM_APPS[program]
  if (bundle || program) return UNKNOWN_APP
  if (hints.KITTY_WINDOW_ID) return 'kitty'
  return detectHost(hints)
}

export function detectHost(hints: Record<string, string>): string {
  const has = (key: string): boolean => !!hints[key]
  const bundle = hints.__CFBundleIdentifier ?? ''
  const program = hints.TERM_PROGRAM ?? ''
  if (has('HERDR_PANE_ID')) return 'herdr'
  if (has('REX_BLOCK')) return 'rex'
  if (has('ZELLIJ')) return 'zellij'
  if (has('TMUX_PANE')) return 'tmux'
  if (has('KITTY_WINDOW_ID')) return 'kitty'
  if (has('WEZTERM_PANE')) return 'wezterm'
  if (has('ORCA_AGENT_SESSION_ID') || bundle === APP_BUNDLES.orca) return 'orca'
  // Cursor is a VS Code fork and reports TERM_PROGRAM=vscode, so its bundle id decides first.
  if (bundle === APP_BUNDLES.cursor) return 'cursor'
  if (bundle === APP_BUNDLES.claude) return 'claude'
  if (bundle === APP_BUNDLES.codex) return 'codex'
  if (program === 'iTerm.app' || bundle === APP_BUNDLES.iterm) return 'iterm'
  if (program === 'Apple_Terminal' || bundle === APP_BUNDLES['terminal-app']) return 'terminal-app'
  if (program === 'ghostty' || bundle === APP_BUNDLES.ghostty) return 'ghostty'
  if (program === 'vscode' || bundle === APP_BUNDLES.vscode) return 'vscode'
  if (program === 'WarpTerminal' || bundle === APP_BUNDLES.warp) return 'warp'
  return 'terminal'
}
