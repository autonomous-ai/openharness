// Which app an agent runs in, from the few environment values the hook sends. Own variables of a
// multiplexer or terminal come first: they name the nearest host, while TERM_PROGRAM names the outermost one.

import { HC_TERMINAL } from './hcClient.js'

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
  cmux: 'com.cmuxterm.app',
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
  cmux: 'cmux',
  vscode: 'VS Code',
  cursor: 'Cursor',
  warp: 'Warp',
  claude: 'Claude',
  codex: 'ChatGPT',
  terminal: 'Terminal',
}

/** The apps an agent can run in, the dial's pages: the hosts, in the order of their names. Eighteen ids; the firmware
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

/** The multiplexers' own variables: one started in an hc terminal keeps its HC_TERMINAL_ID, and is the nearer host. */
const NEARER_HOSTS = ['HERDR_PANE_ID', 'REX_BLOCK', 'ZELLIJ', 'TMUX_PANE']

/** The agent runs in Herdr Core's own terminal (hc, hcClient.ts), the one HC_TERMINAL_ID names. Every program started
 *  there inherits that variable (`code .`, tmux, zellij, herdr), and in it the address is the terminal the program was
 *  started from, whose agent is another: so only with hc's own TERM_PROGRAM (`ghostty`) or none, and no nearer host's
 *  variable. */
export function inHerdr(hints: Readonly<Record<string, string>>): boolean {
  const program = hints.TERM_PROGRAM ?? ''
  return HC_TERMINAL.test(hints.HC_TERMINAL_ID ?? '') && (program === '' || program === 'ghostty')
    && !NEARER_HOSTS.some((own) => hints[own])
}

/** A cmux id's form, a UUID, with no anchors: a cmux pane's id holds two (cmuxApp.ts). */
export const CMUX_UUID = '[0-9A-Fa-f]{8}(-[0-9A-Fa-f]{4}){3}-[0-9A-Fa-f]{12}'
/** A cmux surface's or workspace's id. */
export const CMUX_ID = new RegExp(`^${CMUX_UUID}$`)

/** The terminals' own variables, beside the multiplexers': a terminal started from a cmux terminal keeps its CMUX_*. */
const NOT_CMUX = [...NEARER_HOSTS, 'HC_TERMINAL_ID', 'KITTY_WINDOW_ID', 'WEZTERM_PANE', 'ORCA_AGENT_SESSION_ID', 'ORCA_TERMINAL_HANDLE']

/** The bundle ids a cmux terminal carries: the release app's, or Ghostty's, which cmux is built on. cmux NIGHTLY sets the
 *  same variables, and a tap's link goes to the release app alone, which has no such surface. */
const CMUX_BUNDLES = ['', APP_BUNDLES.cmux, APP_BUNDLES.ghostty]

/** The agent runs in cmux's own terminal. Every program started there inherits cmux's variables (`code .`, WezTerm,
 *  kitty, tmux), so only with both ids in form, cmux's own TERM_PROGRAM (`ghostty`) or none, its own bundle id or none,
 *  and no nearer or other app's variable. */
export function inCmux(hints: Readonly<Record<string, string>>): boolean {
  const program = hints.TERM_PROGRAM ?? ''
  return CMUX_ID.test(hints.CMUX_SURFACE_ID ?? '') && CMUX_ID.test(hints.CMUX_WORKSPACE_ID ?? '')
    && (program === '' || program === 'ghostty') && CMUX_BUNDLES.includes(hints.__CFBundleIdentifier ?? '')
    && !NOT_CMUX.some((own) => hints[own])
}

/** The outermost app an agent runs in. The bundle id and TERM_PROGRAM name it, unlike a multiplexer's own variables,
 *  which name the nearest host; with neither set, the nearest host is the only one known. */
export function detectApp(hints: Record<string, string>): string {
  const bundle = hints.__CFBundleIdentifier ?? ''
  const program = hints.TERM_PROGRAM ?? ''
  // Herdr Core (hc) gives its programs TERM_PROGRAM=ghostty and its own bundle is dev.herdr.core, so neither can name
  // it: its own terminal decides first.
  if (inHerdr(hints)) return 'herdr'
  // cmux is built on Ghostty: its terminals say TERM_PROGRAM=ghostty and may carry Ghostty's bundle id, so its own
  // terminal decides first.
  if (inCmux(hints)) return 'cmux'
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
  if (inHerdr(hints)) return 'herdr'
  if (inCmux(hints)) return 'cmux'
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
