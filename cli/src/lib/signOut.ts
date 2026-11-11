/**
 * Who may take this computer's sign-in away, and the record of each time it goes.
 *
 * 10-27: a desktop test ran the real `harness logout` with no person anywhere near it, seven times, and each
 * run signed the whole Mac out, every agent on it with it, for hours. The sign-in now goes only when a person
 * asks for it on this computer: at a terminal, or through the desktop app's Sign out button, which says so
 * with [SIGN_OUT_BUTTON_FLAG]. An app from before the flag is known by its process. Nothing automatic deletes
 * it (an expired token, a refused refresh, a revoke): those report the computer signed out and wait for a
 * sign-in. Every removal is written to harness.log with the command and the processes above it.
 */
import { execFileSync } from 'child_process'
import { appendFileSync, existsSync, mkdirSync, readlinkSync } from 'fs'
import { dirname, join } from 'path'
import { env } from '../config/env.js'
import { clearAuthSession } from './authSession.js'

/** What the desktop app's Sign out button passes to `harness logout`: a person asked, in the app. */
export const SIGN_OUT_BUTTON_FLAG = '--from-sign-out-button'

/** A process, as harness.log names it. */
export interface Asker { pid: number; command: string }

/** How a person asked: at a terminal, with the app's button, or through an app from before the flag. */
export type SignOutAsked = 'terminal' | 'sign-out button' | 'desktop app'

/**
 * How a person asked for the sign-in to go, or null when nothing says one did: a test, an agent, a script.
 * [ancestors] reads the processes above this one, nearest first, and is called only when the button's flag
 * or a terminal has not decided: on Windows it asks PowerShell, which takes a while (review of #1866).
 */
export function signOutAsked(opts: {
  interactive: boolean
  flags: readonly string[]
  ancestors: () => readonly Asker[]
  isApp?: (asker: Asker) => boolean
}): SignOutAsked | null {
  if (opts.flags.includes(SIGN_OUT_BUTTON_FLAG)) return 'sign-out button'
  if (opts.interactive) return 'terminal'
  const isApp = opts.isApp ?? ((asker: Asker): boolean => isDesktopApp(asker))
  if (opts.ancestors().some((asker) => isApp(asker))) return 'desktop app'
  return null
}

/** [ancestors], read at most once: what decides a sign-out and what its log line names are the same. */
export function ancestorsOnce(): () => Asker[] {
  let read: Asker[] | undefined
  return () => read ??= ancestors()
}

/**
 * Whether [asker] is the Harness desktop app. On a Mac its bundle's executable; on Windows `harness-desktop.exe`.
 * Linux names the app `harness`, as the CLI is, so there it is the `harness` that sits beside a Flutter bundle.
 */
export function isDesktopApp(asker: Asker, platform: NodeJS.Platform = process.platform): boolean {
  if (platform === 'darwin') return /\/Harness[^/]*\.app\/Contents\/MacOS\//.test(asker.command)
  if (platform === 'win32') return /(^|[\\/"])harness-desktop\.exe\b/i.test(asker.command)
  try {
    return existsSync(join(dirname(readlinkSync(`/proc/${asker.pid}/exe`)), 'data', 'flutter_assets'))
  } catch {
    return false
  }
}

/** The processes above this one, nearest first, at most [depth]: who ran this command, and who ran that. */
export function ancestors(depth = 3): Asker[] {
  const found: Asker[] = []
  let pid = process.ppid
  for (let i = 0; i < depth && pid > 1; i++) {
    const read = readProcess(pid)
    if (!read) break
    found.push({ pid, command: read.command })
    pid = read.parent
  }
  return found
}

function readProcess(pid: number): { parent: number; command: string } | null {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-Command',
        `Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" | Select-Object ParentProcessId,CommandLine | ConvertTo-Json -Compress`,
      ], { encoding: 'utf8', timeout: 5_000, windowsHide: true })
      const row = JSON.parse(out) as { ParentProcessId?: number; CommandLine?: string | null }
      return { parent: row.ParentProcessId ?? 0, command: row.CommandLine ?? '' }
    }
    const out = execFileSync('ps', ['-o', 'ppid=,command=', '-p', String(pid)], { encoding: 'utf8', timeout: 5_000 })
    const match = /^\s*(\d+)\s+(.*)$/.exec(out.trim())
    return match ? { parent: Number(match[1]), command: match[2] } : null
  } catch {
    return null
  }
}

/** The line harness.log gets for one removal of the sign-in: why, how a person asked, and who ran it. */
export function removalLine(opts: {
  reason: string
  asked: string
  self: Asker
  ancestors: readonly Asker[]
  now?: Date
}): string {
  const [parent, ...above] = opts.ancestors
  const named = (asker: Asker): string => `${asker.pid} (${asker.command || 'unknown'})`
  return [
    `${stamp(opts.now ?? new Date())} [auth] sign-in removed`,
    `reason=${opts.reason}`,
    `asked=${opts.asked}`,
    `pid=${named(opts.self)}`,
    `parent=${parent ? named(parent) : 'unknown'}`,
    ...above.map((asker) => `above=${named(asker)}`),
  ].join(' · ')
}

/** harness.log's own time format: local time, to the millisecond. */
function stamp(at: Date): string {
  const two = (n: number): string => String(n).padStart(2, '0')
  return `${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())} `
    + `${two(at.getHours())}:${two(at.getMinutes())}:${two(at.getSeconds())}.${String(at.getMilliseconds()).padStart(3, '0')}`
}

/**
 * Takes this computer's sign-in away, after writing to harness.log why, how a person asked, and which
 * processes ran it. The one way the CLI deletes it: [signOutAsked] said a person asked first. A log that
 * cannot be written does not keep the person signed in.
 */
export function removeSignIn(reason: string, asked: SignOutAsked, chain: () => readonly Asker[] = ancestorsOnce()): void {
  try {
    const self = { pid: process.pid, command: process.argv.join(' ') }
    // `harness reset` has just emptied the folder the log lives in.
    mkdirSync(env.ADAPTER_DATA_DIR, { recursive: true })
    appendFileSync(join(env.ADAPTER_DATA_DIR, 'harness.log'), removalLine({ reason, asked, self, ancestors: chain() }) + '\n')
  } catch { /* the log is a record, not a gate */ }
  clearAuthSession()
}
