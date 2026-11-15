/**
 * The terminal apps whose tabs the dial follows, and the tty that names a tab. A tty reaches Harness Device's fixed
 * AppleScript handlers as a parameter, so every hop checks it against TAB_TTY and the app against TAB_APPS.
 */
import { execFile } from 'node:child_process'

export const TAB_APPS = ['terminal-app', 'iterm', 'ghostty'] as const
export type TabApp = (typeof TAB_APPS)[number]

export const TAB_TTY = /^\/dev\/ttys[0-9]{1,4}$/

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

/** The tty of a pid's terminal; an agent with none (`??`) or one the check refuses has no tab to follow. */
export async function readTty(pid: number, run: RunPs = runPs): Promise<string | undefined> {
  if (!Number.isInteger(pid) || pid <= 0) return undefined
  const out = await run(['-o', 'tty=', '-p', String(pid)], { timeout: 1_000, maxBuffer: 256 })
  if (out === null) return undefined
  const tty = `/dev/${out.trim()}`
  return TAB_TTY.test(tty) ? tty : undefined
}
