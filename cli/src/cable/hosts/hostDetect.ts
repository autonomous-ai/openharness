// Which app an agent runs in, from the few environment values the hook sends. Own variables of a
// multiplexer or terminal come first: they name the nearest host, while TERM_PROGRAM names the outermost one.

import type { DialOtherApp } from '../../lib/dialUsageContract.js'
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
  // The Rex app's (its Info.plist, 2026-11-25). Its panes carry no __CFBundleIdentifier: TERM_PROGRAM names it there.
  rex: 'com.superlogical.rex',
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
  opencode: 'opencode',
  terminal: 'Terminal',
}

/** The apps an agent can run in, the dial's pages: the hosts, in the order of their names. Nineteen ids; the firmware
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
  // Rex's blocks (docs/specs/2026-11-25-dial-rex.md): Rex is the app the person sees, with no terminal around it.
  rex: 'rex',
}

export function hostDisplayName(id: string): string {
  return NAMES[id] ?? 'Terminal'
}

/** The name of where an agent is: its host's, or its app's when the host is a terminal the daemon does not know. On Linux
 *  no bundle names the Claude app or VS Code, so an agent there has that host while its app came from its process. */
export function agentPlaceName(agent: { host: string; app: string }): string {
  return hostDisplayName(agent.host === UNKNOWN_APP ? agent.app : agent.host)
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

/** The word Claude Code's extension gives the sessions of its tab, in VS Code and in its forks alike. */
export const EXTENSION_TAB = 'claude-vscode'
/** The word the Claude app gives the Claude Code it starts. */
const CLAUDE_APP_ENTRYPOINT = 'claude-desktop'

/** The hints of the app an agent's own terminal or tab is in. An editor started with `code .` or `cursor .` from another
 *  app inherits that app's bundle id, while its own terminals say TERM_PROGRAM=vscode and its extension's tab says
 *  EXTENSION_TAB: the bundle id named Terminal, and its agent sat on Terminal's page, a tap opening Terminal (eval V11).
 *  A bundle id beside either word that is no editor's is dropped, and the editor is learnt from the caller's parents
 *  (observed.ts walked). */
export function ownHints(hints: Record<string, string>): Record<string, string> {
  const bundle = hints.__CFBundleIdentifier
  const inEditor = hints.TERM_PROGRAM === 'vscode' || hints.CLAUDE_CODE_ENTRYPOINT === EXTENSION_TAB
  if (!inEditor || bundle === undefined || bundle === APP_BUNDLES.vscode || bundle === APP_BUNDLES.cursor) return hints
  const { __CFBundleIdentifier: _inherited, ...own } = hints
  return own
}

/** Orca named by its TERM_PROGRAM alone. Orca sets it in every terminal it spawns (stablyai/orca
 *  src/main/daemon/pty-subprocess/spawn-environment.ts, local-pty-spawn-environment.ts), and off macOS no bundle id names
 *  it: without it an Orca agent sat on Other's page (Ken's Dell, Win11 x64, 2026-11-25, chain claude.exe < powershell <
 *  powershell < Orca.exe < Orca.exe). A program started there that sets no TERM_PROGRAM of its own keeps Orca's
 *  (Alacritty, the Claude and ChatGPT apps): a bundle id, which the hook sends on Windows too (notify.mjs
 *  lookUpWindowsApp), names that app instead, and on Linux the caller's parents do (observed.ts walked). So does the
 *  word a session gives of where it runs: the extension's tab and the Claude app's sessions are in no terminal. */
export function inOrca(hints: Readonly<Record<string, string>>): boolean {
  const entrypoint = hints.CLAUDE_CODE_ENTRYPOINT
  return hints.TERM_PROGRAM === 'Orca' && !hints.__CFBundleIdentifier && entrypoint !== EXTENSION_TAB
    && entrypoint !== CLAUDE_APP_ENTRYPOINT
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
  if (inOrca(hints)) return 'orca'
  if (Object.hasOwn(PROGRAM_APPS, program)) return PROGRAM_APPS[program]
  if (bundle || program) return UNKNOWN_APP
  if (hints.KITTY_WINDOW_ID) return 'kitty'
  return detectHost(hints)
}

// The apps behind the Other page the dial's counts name, each id from the app's own Info.plist, build config or source
// (Nova's and Windsurf's from their Homebrew casks). Alacritty sets no TERM_PROGRAM; the hook names its bundle id on
// Windows too (notify.mjs lookUpWindowsApp).
const OTHER_BUNDLES: Readonly<Record<string, DialOtherApp>> = {
  'dev.zed.Zed': 'zed',
  'dev.zed.Zed-Preview': 'zed',
  'org.alacritty': 'alacritty',
  'co.zeit.hyper': 'hyper',
  'org.tabby': 'tabby',
  'com.raphaelamorim.rio': 'rio',
  'dev.commandline.waveterm': 'wave',
  'com.panic.Nova': 'nova',
  'com.exafunction.windsurf': 'windsurf',
}
const OTHER_PROGRAMS: Readonly<Record<string, DialOtherApp>> = {
  zed: 'zed',
  Hyper: 'hyper',
  Tabby: 'tabby',
  rio: 'rio',
  waveterm: 'wave',
}
/** Every JetBrains IDE's bundle id: one per product (com.jetbrains.intellij, com.jetbrains.pycharm, …). */
const JETBRAINS_BUNDLE = 'com.jetbrains.'

/** The product behind the Other page, for the dial's counts: the raw bundle id or TERM_PROGRAM stops here, as either
 *  could name a person's own build, and only a name of the fixed list leaves (docs/plans/2026-11-23-dial-usage-counts-design.md).
 *  A hint is outside text: only a table's own key names a product, never one an object inherits (`constructor`). */
export function otherProduct(hints: Readonly<Record<string, string>>): DialOtherApp {
  const bundle = Object.hasOwn(hints, '__CFBundleIdentifier') ? hints.__CFBundleIdentifier : ''
  const program = Object.hasOwn(hints, 'TERM_PROGRAM') ? hints.TERM_PROGRAM : ''
  if (bundle) {
    if (Object.hasOwn(OTHER_BUNDLES, bundle)) return OTHER_BUNDLES[bundle]
    return bundle.startsWith(JETBRAINS_BUNDLE) ? 'jetbrains' : 'unlisted'
  }
  if (program) return Object.hasOwn(OTHER_PROGRAMS, program) ? OTHER_PROGRAMS[program] : 'unlisted'
  return 'unknown'
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
  // Orca's TERM_PROGRAM names it off macOS too, where a claude typed by hand has no agent session (inOrca).
  if (has('ORCA_AGENT_SESSION_ID') || bundle === APP_BUNDLES.orca || inOrca(hints)) return 'orca'
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
