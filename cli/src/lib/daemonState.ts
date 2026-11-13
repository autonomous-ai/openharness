/**
 * On-disk daemon state that BOTH the daemon (`core/main.ts`) and short-lived CLI commands need to read —
 * the pid file, the saved credential, and this user's recorded loopback control port.
 *
 * Kept in its own module so management commands can inspect daemon state without importing `cli.ts`,
 * which would execute the command dispatcher.
 */

import { readFileSync, rmSync } from 'fs'
import { homedir, hostname } from 'os'
import { join } from 'path'
import { env } from '../config/env.js'
import { hasAuthSession } from './authSession.js'
import { readOrMintComputerId } from './computerIdentity.js'
import { savedDaemonPort } from './daemonRecord.js'

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

export function readPid(): number | null {
  try {
    const pid = parseInt(readFileSync(PID_FILE, 'utf-8').trim(), 10)
    return Number.isFinite(pid) ? pid : null
  } catch { return null }
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

/** How a command fails, and a core that will not stay up after a failed start: say why, let go of the pid
 *  file if it is this process's, and exit. The CLI's commands and the core's entry both fail this way. */
export const onError = (err: unknown, code = 1): never => {
  console.error('Failed to start adapter:', err)
  // A daemon that claimed the pid file (port bound) and then failed to finish starting must not leave
  // that file naming a corpse — the next `harness start` would refuse on it. Only ours, though.
  removePidFileIf(process.pid)
  process.exit(code)
}

/** Is the background daemon process alive right now? (pid file present AND that pid still exists) */
export function isDaemonRunning(): boolean {
  const pid = readPid()
  return pid !== null && isAlive(pid)
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
