/**
 * On-disk daemon state that BOTH the daemon (`core/main.ts`) and short-lived CLI commands need to read —
 * the pid file, the saved credential, and this user's recorded loopback control port.
 *
 * Kept in its own module so management commands can inspect daemon state without importing `cli.ts`,
 * which would execute the command dispatcher.
 */

import { readFileSync } from 'fs'
import { homedir, hostname } from 'os'
import { join } from 'path'
import { env } from '../config/env.js'
import { hasAuthSession } from './authSession.js'
import { readOrMintComputerId } from './computerIdentity.js'
import { savedDaemonPort } from './daemonEndpoint.js'

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
  try { process.kill(pid, 0); return true } catch { return false }
}

/** Whether a durable SSO session exists for this computer. */
export function hasSavedAuthSession(): boolean { return hasAuthSession() }

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
