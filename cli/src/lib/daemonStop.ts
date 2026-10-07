/**
 * `harness stop`'s core, shared by `stop`, `reset`, `logout`, `update` and `flash`.
 *
 * Takes the spawn lock first, so a stop can never land in the middle of an update handoff — the one
 * window where "the daemon" is two processes and killing the pid on file leaves the other one
 * running. It waits its turn, but not forever: stop is the escape hatch for everything else here, so
 * a holder that has been busy for longer than the wait is reported and then overridden.
 */

import { rmSync } from 'fs'
import { HARNESSD_REEXEC_FILE, PID_FILE, isAlive, readPid } from './daemonState.js'
import { readMarker, removeMarker } from '../harnessd/reexec.js'
import { acquireSpawnLock, describeSpawnLockFailure, describeSpawnLockOwner, SPAWN_LOCK_WAIT_MS } from './daemonSpawnLock.js'
import { PLATFORM_STOP_WAIT_MS, stopUnderPlatform, type PlatformStop } from './platformDaemon.js'

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

/** SIGTERM the daemon named by the pid file, SIGKILL if it lingers. Returns what was stopped. */
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
    try { deps.kill(pid, 'SIGTERM') } catch { /* already gone */ }
    const deadline = deps.now() + STOP_GRACE_MS
    while (deps.now() < deadline && deps.isAlive(pid)) await deps.sleep(150)
    if (deps.isAlive(pid)) { try { deps.kill(pid, 'SIGKILL') } catch { /* ignore */ } }
    // Only if it is still OUR daemon's file: a SIGTERM'd daemon removes its own pid on the way out
    // (shutdown), and a daemon that came up meanwhile — impossible under the lock, but cheap to
    // respect — must not lose its record to us.
    if (deps.readPid() === pid) { try { rmSync(PID_FILE, { force: true }) } catch { /* ignore */ } }
    if (!deps.isAlive(pid)) clearReexecMarker(pid)
    return { pid, stopped: true }
  } finally {
    release()
  }
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
