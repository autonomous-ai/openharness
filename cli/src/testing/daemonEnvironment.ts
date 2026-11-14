import { isAgentSessionVariable } from '../lib/agentSessionEnv.js'

/**
 * A test daemon starts its own supervisor; it must not inherit the host daemon's topology or token, nor the session of
 * an agent running the tests: its harnesses would all look like that agent (agentClient/model.ts `outsideCaller`), and
 * only on the developer's machine, never in CI.
 */
/** A GitHub login in the environment would let a test daemon's `gh` act as the developer. */
const GITHUB_CREDENTIALS = ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN']
/** The app the tests run in, as the hook names it (hook/notify.mjs HOST_HINTS): a fake engine with the developer's
 *  ORCA_TERMINAL_HANDLE would have its daemon type into, or bring forward, the developer's own Orca terminal. Every
 *  ORCA_ variable goes, not only today's hints. */
const HOST_HINTS = ['TERM_PROGRAM', '__CFBundleIdentifier', 'HERDR_PANE_ID', 'REX_BLOCK', 'ZELLIJ', 'KITTY_WINDOW_ID', 'WEZTERM_PANE']
const borrowed = (key: string) => key.startsWith('HARNESSD_') || key.startsWith('ORCA_') || isAgentSessionVariable(key) ||
  GITHUB_CREDENTIALS.includes(key) || HOST_HINTS.includes(key)
export function daemonEnvironment(inherited: NodeJS.ProcessEnv, own: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const clean = Object.fromEntries(Object.entries(inherited).filter(([key]) => !borrowed(key)))
  return { ...clean, ...own }
}
