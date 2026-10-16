/**
 * `harness stop`'s core, shared by `stop`, `reset`, `logout`, `update` and `flash`.
 *
 * Takes the spawn lock first, so a stop can never land in the middle of an update handoff — the one
 * window where "the daemon" is two processes and killing the pid on file leaves the other one
 * running. It waits its turn, but not forever: stop is the escape hatch for everything else here, so
 * a holder that has been busy for longer than the wait is reported and then overridden.
 */

import { rmSync, statSync } from 'fs'
import { env } from '../config/env.js'
import { readStatusFile } from '../harnessd/master.js'
import type { ProcessRow } from './processTable.js'
import { HARNESSD_REEXEC_FILE, HARNESSD_STATUS_FILE, PID_FILE, isAlive, readPid } from './daemonState.js'
import { readMarker, removeMarker } from '../harnessd/reexec.js'
import { acquireSpawnLock, describeSpawnLockFailure, describeSpawnLockOwner, SPAWN_LOCK_WAIT_MS } from './daemonSpawnLock.js'
import { PLATFORM_STOP_WAIT_MS, stopUnderPlatform, waitGone, type PlatformStop } from './platformDaemon.js'
import { identifyDaemonProcess } from './windows/daemonProcesses.js'
import { askDaemonToStop, processStopCallDeps } from './windows/daemonStopCall.js'
import { windowsProcessRows } from './windows/processTable.js'
import { terminateVerified, type TerminateOutcome } from './windows/terminate.js'

export interface StopDeps {
  readPid: () => number | null
  isAlive: (pid: number) => boolean
  kill: (pid: number, signal: NodeJS.Signals) => void
  sleep: (ms: number) => Promise<void>
  now: () => number
  /** Acquire the spawn lock; resolves to a release. Injected so the stop sequence is testable alone. */
  lock: () => Promise<() => void>
  warn: (message: string) => void
  /**
   * Ask launchd or systemd to stop the master when it runs it (`harness service install`,
   * lib/platformDaemon.ts); null when it does not, and nothing was asked. Left out, nothing is.
   */
  stopPlatform?: () => PlatformStop | null
  /** Windows has no signals: how the daemon is stopped there (`stopOnWindows`). Left out, signals. */
  windows?: WindowsStopDeps
}

export interface WindowsStopDeps {
  /** POST /api/daemon/stop over the pipe (./windows/daemonStopCall.ts): whether the daemon took it. */
  ask(): Promise<boolean>
  rows(): Promise<readonly ProcessRow[] | null>
  terminate(pid: number, startMarker: string): Promise<TerminateOutcome>
  /** When the pid file was written: the master claimed it after it started. */
  pidFileWrittenMs(): number | null
  /** The core the master's status file names. */
  corePid(masterPid: number): number | null
}

/** How long the master has to stop its core (2.5 s, then it ends it) and its services beside it, and exit. */
export const WINDOWS_STOP_WAIT_MS = 8_000
/** How long a core whose master was ended has to leave by itself: it stops once its master's channel closes. */
export const ORPHAN_CORE_WAIT_MS = 5_000

export function defaultWindowsStopDeps(): WindowsStopDeps {
  return {
    ask: () => askDaemonToStop(processStopCallDeps(env.ADAPTER_DATA_DIR, env.PORT)),
    rows: () => windowsProcessRows(null),
    terminate: (pid, startMarker) => terminateVerified(pid, startMarker),
    pidFileWrittenMs: () => { try { return statSync(PID_FILE).mtimeMs } catch { return null } },
    corePid: (masterPid) => readStatusFile(HARNESSD_STATUS_FILE, masterPid)?.corePid ?? null,
  }
}

export function defaultStopDeps(): StopDeps {
  return {
    readPid,
    isAlive,
    kill: (pid, signal) => process.kill(pid, signal),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => Date.now(),
    lock: async () => {
      try {
        return await acquireSpawnLock('stop', {
          waitMs: SPAWN_LOCK_WAIT_MS,
          onWaiting: (owner) => console.log(`  the daemon is ${describeSpawnLockOwner(owner)} — waiting for it to finish…`),
        })
      } catch (error) {
        // ANY failure to take the lock — a holder that outlived the wait, a directory that is not a
        // lock at all — ends the same way: stop proceeds. It is the escape hatch for everything else
        // here, and an escape hatch that can be locked is not one.
        console.warn(`  ! the daemon spawn lock is ${describeSpawnLockFailure(error)} — stopping anyway`)
        return () => {}
      }
    },
    warn: (m) => console.warn(m),
    stopPlatform: () => stopUnderPlatform(),
    ...(process.platform === 'win32' ? { windows: defaultWindowsStopDeps() } : {}),
  }
}

export const STOP_GRACE_MS = 3_000

/**
 * A re-execution marker that names the master just stopped. A master stopped in the moment after it
 * re-executed on a new bundle, before its code has its signal handlers, dies of the signal and leaves
 * the marker it would have cleared; the next start took that for a re-execution that never came up,
 * rolled the update back and rejected its version (harnessd/reexec.ts recoverFailedReexec). A stop is
 * not a failure.
 */
function clearReexecMarker(pid: number): void {
  if (readMarker(HARNESSD_REEXEC_FILE)?.pid === pid) removeMarker(HARNESSD_REEXEC_FILE)
}

/** SIGTERM the daemon named by the pid file, SIGKILL if it lingers; on Windows, `stopOnWindows`. Returns what was stopped. */
export async function stopDaemonProcess(deps: StopDeps = defaultStopDeps()): Promise<{ pid: number | null; stopped: boolean }> {
  const release = await deps.lock()
  try {
    const stopped = await stopThroughPlatform(deps)
    if (stopped !== null) { clearReexecMarker(stopped); return { pid: stopped, stopped: true } }
    const pid = deps.readPid()
    if (!pid || !deps.isAlive(pid)) {
      // A pid file naming nothing is debris from a crash; nobody else can be relying on it.
      try { rmSync(PID_FILE, { force: true }) } catch { /* ignore */ }
      return { pid: null, stopped: false }
    }
    if (deps.windows) return await stopOnWindows(deps, deps.windows, pid)
    try { deps.kill(pid, 'SIGTERM') } catch { /* already gone */ }
    const deadline = deps.now() + STOP_GRACE_MS
    while (deps.now() < deadline && deps.isAlive(pid)) await deps.sleep(150)
    if (deps.isAlive(pid)) { try { deps.kill(pid, 'SIGKILL') } catch { /* ignore */ } }
    forgetPid(deps, pid)
    return { pid, stopped: true }
  } finally {
    release()
  }
}

/** Only if it is still OUR daemon's file: a stopped daemon removes its own pid on the way out, and a daemon that
 *  came up meanwhile — impossible under the lock, but cheap to respect — must not lose its record to us. */
function forgetPid(deps: StopDeps, pid: number): void {
  if (deps.readPid() === pid) { try { rmSync(PID_FILE, { force: true }) } catch { /* ignore */ } }
  if (!deps.isAlive(pid)) clearReexecMarker(pid)
}

/**
 * Windows: no SIGTERM to send. The core is asked over its pipe (POST /api/daemon/stop), and asks its master, which
 * stops the services and the core in order and exits. A daemon that does not take it, or does not go in time, is
 * ended one process at a time with TerminateProcess, and only a process identified first (./windows/daemonProcesses.ts):
 * the master, then a core its end left behind. Never by tree: the pty host's parent is the core, and every agent
 * lives under it.
 */
async function stopOnWindows(deps: StopDeps, windows: WindowsStopDeps, pid: number): Promise<{ pid: number; stopped: boolean }> {
  // Looked up before anything is asked: once the master goes, its core has no parent to be told by.
  const rows = await windows.rows().catch(() => null)
  // The time the pid file was written is what tells the master from a process given its pid since. Without it the
  // master is not identified: its command alone would match another same-user daemon (B3.7).
  const claimedAtMs = windows.pidFileWrittenMs()
  const master = rows && claimedAtMs !== null ? identifyDaemonProcess(rows, pid, { role: 'master', claimedAtMs }) : null
  const corePid = windows.corePid(pid)
  const core = rows && corePid !== null ? identifyDaemonProcess(rows, corePid, { role: 'core', parentPid: pid }) : null
  const asked = await windows.ask()
  if (!asked) deps.warn('  ! the daemon did not take the stop over its pipe — ending it')
  if (!asked || !await waitGone(deps, pid, WINDOWS_STOP_WAIT_MS)) {
    if (!master) {
      deps.warn(`  ! pid ${pid} could not be shown to be harnessd's master — it was left running`)
      return { pid, stopped: false }
    }
    if (await windows.terminate(pid, master) === 'mismatch') deps.warn(`  ! pid ${pid} is no longer harnessd's master — it was left running`)
  }
  if (core && corePid !== null && !await waitGone(deps, corePid, ORPHAN_CORE_WAIT_MS)) await windows.terminate(corePid, core)
  forgetPid(deps, pid)
  return { pid, stopped: !deps.isAlive(pid) }
}

/**
 * The platform's half of a stop, when launchd or systemd runs the master: it is asked to stop it, and
 * keeps it stopped, where a signal from here would read to it as a crash and bring the master back.
 * Returns the pid it stopped; null when it was not asked, stopped nothing, or has not stopped it in
 * time, and the signals in `stopDaemonProcess` take it from there.
 */
async function stopThroughPlatform(deps: StopDeps): Promise<number | null> {
  if (!deps.stopPlatform) return null
  const outcome = deps.stopPlatform()
  if (!outcome) return null
  if (!outcome.ok) {
    deps.warn(`  ! ${outcome.detail} — stopping it directly`)
    return null
  }
  const master = outcome.stopped
  if (master === null) return null
  // bootout and `systemctl stop` can return before the master has finished its own ordered stop.
  const deadline = deps.now() + PLATFORM_STOP_WAIT_MS
  while (deps.isAlive(master)) {
    if (deps.now() >= deadline) return null
    await deps.sleep(150)
  }
  const pid = deps.readPid()
  if (pid === master) { try { rmSync(PID_FILE, { force: true }) } catch { /* ignore */ } }
  // A daemon `harness start` spawned beside the platform's (two supervisors, which `harness service`
  // exists to prevent) is the signals' to stop.
  if (pid !== null && pid !== master && deps.isAlive(pid)) return null
  return master
}
