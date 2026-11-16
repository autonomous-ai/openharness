/**
 * The terminal apps whose tabs the dial follows, and the tty that names a tab. A tty reaches Harness Device's fixed
 * AppleScript handlers as a parameter, so every hop checks it against TAB_TTY and the app against TAB_APPS.
 */
import { execFile } from 'node:child_process'
// Types only, and hostDetect's constants (a file that imports nothing): the CLI's watch loads this file, and it must
// load nothing of the daemon.
import type { HostAdapter, Pane, Place } from './adapter.js'
import { UNKNOWN_APP } from './hostDetect.js'
import type { PaneSwitch } from './types.js'

export const TAB_APPS = ['terminal-app', 'iterm', 'ghostty'] as const
export type TabApp = (typeof TAB_APPS)[number]

export const TAB_TTY = /^\/dev\/ttys[0-9]{1,4}$/

/** The devices listener's last line on a stream a newer watch took, as its watch reads it. */
export const REPLACED_LINE = '{"replaced":true}'

export interface Tab {
  app: TabApp
  tty: string
}

export function isTabApp(app: unknown): app is TabApp {
  return typeof app === 'string' && (TAB_APPS as readonly string[]).includes(app)
}

/** A line's `app` and `tty` when both pass; its other keys never travel on. */
export function tabOf(value: unknown): Tab | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const { app, tty } = value as { app?: unknown; tty?: unknown }
  if (!isTabApp(app) || typeof tty !== 'string' || !TAB_TTY.test(tty)) return null
  return { app, tty }
}

/** ps's stdout, or null when the run failed. */
export type RunPs = (args: string[], bounds: { timeout: number; maxBuffer: number }) => Promise<string | null>

const runPs: RunPs = (args, bounds) => new Promise((resolve) => {
  execFile('/bin/ps', args, { ...bounds, killSignal: 'SIGKILL' }, (error, stdout) => resolve(error === null ? stdout : null))
})

/**
 * The tty of a pid's terminal; an agent with none (`??`) or one the check refuses has no tab to follow. A run that failed
 * (a timeout, a spawn error, a non-zero exit) rejects: it said nothing of the tty, so it may be asked again.
 */
export async function readTty(pid: number, run: RunPs = runPs): Promise<string | undefined> {
  if (!Number.isInteger(pid) || pid <= 0) return undefined
  const out = await run(['-o', 'tty=', '-p', String(pid)], { timeout: 1_000, maxBuffer: 256 })
  if (out === null) throw new Error('ps failed')
  const tty = `/dev/${out.trim()}`
  return TAB_TTY.test(tty) ? tty : undefined
}

/** The tabs stream a watch holds open (services/devicesListener.ts tabsStream). */
export interface TabsDeps {
  isOpen(): boolean
  /** One line for the watch to select the tab; false with no stream open. */
  select(tab: Tab, raise: boolean): boolean
}

/** A tab's pane id, read back: the app before the first `:`, the tty after it, both checked again. */
function paneTab(pane: Pane): Tab | null {
  const at = pane.id.indexOf(':')
  return at < 0 ? null : tabOf({ app: pane.id.slice(0, at), tty: pane.id.slice(at + 1) })
}

/** A tab of Terminal, iTerm2 or Ghostty, by its tty: a watch selects it, once its app is in front for a tap. */
export function createTabsAdapter(deps: TabsDeps): HostAdapter & Required<Pick<HostAdapter, 'canShow' | 'show'>> {
  const select = (pane: Pane, raise: boolean): boolean => {
    const tab = paneTab(pane)
    return tab !== null && deps.select(tab, raise)
  }
  return {
    id: 'tabs',
    tap: 'after',
    paneOf(place: Place): Pane | undefined {
      // In a multiplexer inside the tab app the agent's tty is that pane's, which no tab holds. A session the open scan
      // found has no host named yet, and its parents named the app.
      if (place.host !== place.app && place.host !== UNKNOWN_APP) return undefined
      const tab = tabOf({ app: place.app, tty: place.tty })
      return tab ? { adapter: 'tabs', id: `${tab.app}:${tab.tty}` } : undefined
    },
    // Asked at each look: a watch may have opened or closed the stream since the last one.
    canFocus: () => deps.isOpen(),
    canShow: () => deps.isOpen(),
    // The line is written before the answer: a select is the watch's to run, and nothing waits on it.
    focus: async (pane) => select(pane, true),
    show: async (pane): Promise<PaneSwitch> => (select(pane, false) ? 'ok' : 'failed'),
  }
}
