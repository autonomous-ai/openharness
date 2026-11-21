/**
 * On-disk daemon state that BOTH the daemon (`core/main.ts`) and short-lived CLI commands need to read —
 * the pid file, the saved credential, and this user's recorded loopback control port.
 *
 * Kept in its own module so management commands can inspect daemon state without importing `cli.ts`,
 * which would execute the command dispatcher.
 */

import { readFileSync, rmSync, statSync } from 'fs'
import { homedir, hostname } from 'os'
import { join } from 'path'
import { env } from '../config/env.js'
import { hasAuthSession } from './authSession.js'
import { readOrMintComputerId } from './computerIdentity.js'
import { savedDaemonPort } from './daemonRecord.js'
import { errorKind } from './log.js'
import { atomicWriteFile, probeState, StateFileUnreadable } from './secureState.js'

export const PID_FILE = join(env.ADAPTER_DATA_DIR, 'adapter.pid')
/** The daemon's console: the master's and its core's stdout and stderr. Capped (lib/log.ts). */
export const DAEMON_LOG_FILE = join(env.ADAPTER_DATA_DIR, 'harness.log')
/** What harnessd's master last said about itself, for `harness status` when no core answers. */
export const HARNESSD_STATUS_FILE = join(env.ADAPTER_DATA_DIR, 'harnessd-status.json')
/** Where a master re-executing on a new bundle leaves word of it, until that master's core is up (harnessd/reexec.ts). */
export const HARNESSD_REEXEC_FILE = join(env.ADAPTER_DATA_DIR, 'harnessd-reexec.json')

/** This user's recorded TCP port; the configured port still names its private Unix socket. */
export function daemonPort(): number {
  return savedDaemonPort(env.ADAPTER_DATA_DIR, env.PORT)
}

export type PidFileRead = { state: 'pid'; pid: number } | { state: 'missing' } | { state: 'unreadable' }

/** Digits with whitespace around them, a safe integer above 0; anything else is no pid. */
export function parsePid(text: string): number | null {
  const digits = text.trim()
  if (!/^\d+$/.test(digits)) return null
  const pid = Number(digits)
  // 0 names a process group: kill(0, 0) always succeeds.
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null
}

/** [parsePid] for the state readers (secureState.ts), which take a file whose text is no pid as unreadable. */
export function pidOrThrow(text: string): number {
  const pid = parsePid(text)
  if (pid === null) throw new TypeError('not a pid')
  return pid
}

/** The pid file: a pid, missing, or unreadable, which is never "no daemon": a file mid-write, or a broken one, can
 *  belong to a daemon that runs. Read with the retry; logs nothing and moves nothing, since only the daemon can say
 *  whether the file is its own. */
export function readPidFile(file: string = PID_FILE): PidFileRead {
  const read = probeState(file, pidOrThrow)
  if (read.state === 'ok') return { state: 'pid', pid: read.value }
  return { state: read.state }
}

/** Written whole: a reader in another process never finds it empty or half there. */
export function writePidFile(pid: number, file: string = PID_FILE): void {
  atomicWriteFile(file, `${pid}\n`, 'cache')
}

let answeredPid: number | null = null

/** The master pid the daemon itself answered with while its pid file could not be read; null takes it back. */
export function setAnsweredPid(pid: number | null): void {
  answeredPid = pid
}

/** The pid file's pid; for a file that cannot be read, the answered pid; else null. */
export function readPid(): number | null {
  const read = readPidFile()
  if (read.state === 'pid') return read.pid
  return read.state === 'unreadable' ? answeredPid : null
}

/** When the pid file was written; null when there is none, or when the pid in use is the daemon's answer. On Windows
 *  the time tells the master from a process given its pid since: a file that cannot be read was not its claim. */
export function pidFileWrittenMs(): number | null {
  if (readPidFile().state !== 'pid') return null
  try { return statSync(PID_FILE).mtimeMs } catch { return null }
}

export function isAlive(pid: number): boolean {
  return processAlive(pid)
}

export interface ProcessAliveDeps {
  platform?: NodeJS.Platform
  /** `kill -0`: whether the pid can be signalled. */
  signal?: (pid: number) => boolean
  /** `/proc/<pid>/stat` on Linux. */
  readStat?: (pid: number) => string
}

/**
 * Whether [pid] runs. On Linux a zombie or a dead entry (`Z`, `X` in /proc/<pid>/stat) is gone, though `kill -0` still
 * reaches it: in a container with no init a stopped master stays a zombie of PID 1, and `harness uninstall` waited on it
 * and removed nothing (G6, docs/testing/windows-cli-e2e.md). A zombie holds nothing: no socket, no lock, no pane. When
 * /proc cannot say, the signal decides, as before.
 */
export function processAlive(pid: number, deps: ProcessAliveDeps = {}): boolean {
  const signal = deps.signal ?? ((target: number) => { try { process.kill(target, 0); return true } catch { return false } })
  if (!signal(pid)) return false
  if ((deps.platform ?? process.platform) !== 'linux') return true
  let stat: string
  try { stat = (deps.readStat ?? ((target: number) => readFileSync(`/proc/${target}/stat`, 'utf8')))(pid) } catch { return true }
  // `<pid> (<comm>) <state> …`: the name may hold spaces and parentheses, so the state follows the LAST `)`.
  const state = /^\s*(\S)/.exec(stat.slice(stat.lastIndexOf(')') + 1))?.[1]
  return !(stat.includes(')') && (state === 'Z' || state === 'X'))
}

/** Whether a durable SSO session exists for this computer. */
export function hasSavedAuthSession(): boolean { return hasAuthSession() }

/** Remove the pid file only if it still names `pid`. A spawner that deletes unconditionally after ITS
 *  child failed can erase the record of the daemon that actually won the port. */
export function removePidFileIf(pid: number | undefined, deps: { readPid: () => number | null } = { readPid }): boolean {
  if (pid === undefined || deps.readPid() !== pid) return false
  try { rmSync(PID_FILE, { force: true }) } catch { /* ignore */ }
  return true
}

/** What a failed start says when another daemon serves its data folder, in fixed words: the error's own words name
 *  the socket's path. */
const SERVED_ELSEWHERE = ' · another Harness daemon serves this data folder'

/** How a command fails: say why, let go of the pid file if it is this process's, and exit. Commands alone fail
 *  this way, on the terminal of the person who ran one; a daemon's start fails through [failForegroundStart]. */
export const onError = (err: unknown, code = 1): never =>
  exitSaying(err, code, () => console.error('Failed to start adapter:', err))

/** How a daemon's start fails: `harness start --foreground`, which launchd and systemd run, and the core's, which does
 *  not stay up (core/main.ts), also one a command runs in its own process (`runCoreInForeground`). What either prints
 *  is the daemon's log, which Export logs sends. So an error says its kind, never its words, its stack or a path; the
 *  one a person meets starting by hand (`harness start -f`, `harness login`) says why, in fixed words. */
export const failForegroundStart = (err: unknown, code = 1): never =>
  exitSaying(err, code, () => {
    const why = (err as { code?: unknown } | null | undefined)?.code === 'EADDRINUSE' ? SERVED_ELSEWHERE : ''
    console.error(`Failed to start adapter: ${errorKind(err)}${why}`)
  })

function exitSaying(err: unknown, code: number, sayFault: () => void): never {
  // A trust file that cannot be read is the person's to move aside, not a fault in Harness: no stack, and the
  // file's full path is in `harness status`, kept out of the error itself.
  if (err instanceof StateFileUnreadable) {
    console.error(`✗ ${err.message}`)
    console.error('  harness status shows where it is')
  } else {
    sayFault()
  }
  // A pid file left naming a process that is gone, the next `harness start` would refuse on. Only ours, though.
  removePidFileIf(process.pid)
  process.exit(code)
}

// Pre-rename name. Adopted (renamed, keeping the inode) the first time a daemon opens the log, so a
// machine that updates mid-run keeps its history instead of stranding it in a file nobody tails.
// The log has had three names; this slot holds the OLDEST. The middle one (`machine.log`) is adopted
// earlier and elsewhere — by the table in config/env.ts, which runs at module load, before any daemon
// opens this file. Two mechanisms, one ancestor each, in the right order.
export const LEGACY_LOG_FILE = join(env.ADAPTER_DATA_DIR, 'adapter.log')

// NOT under ADAPTER_DATA_DIR — see config/env.ts. `reset` wipes that dir, so an id kept there
// regenerates and the next `harness login` mints a SECOND machine for a box that already has one.
export const COMPUTER_ID_FILE = env.ADAPTER_COMPUTER_ID_FILE

// The machine's display name, mirrored from the backend (`machine_meta` on connect + web renames) by the
// daemon so the separate `harness status` process can print it. Absent = unnamed machine.
export const MACHINE_NAME_FILE = join(env.ADAPTER_DATA_DIR, 'machine-name')

/** Compact a home-relative path with `~` for display. */
export function tildify(p: string): string {
  const h = homedir()
  return p.startsWith(h) ? '~' + p.slice(h.length) : p
}

/** This computer's identity — see lib/computerIdentity.ts. Sent on connect so the backend can enforce
 *  one machine per computer, and used by `harness start` to reconnect to the machine already
 *  bound to this box instead of minting a second one. */
export function computerId(): string {
  return readOrMintComputerId(COMPUTER_ID_FILE, env.ADAPTER_COMPUTER_ID)
}

/** The name this machine goes by in the account's device list — what the daemon registers itself as. */
export const thisDeviceLabel = (): string => hostname().slice(0, 60)
