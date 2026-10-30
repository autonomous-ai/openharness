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
import { PLATFORM_STOP_WAIT_MS, clearTaskStopped, stopUnderPlatform, waitGone, type PlatformStop } from './platformDaemon.js'
import { identifyDaemonProcess, judgePidFileOwner, type DaemonProcessVerdict } from './windows/daemonProcesses.js'
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
  /** Forget the task's stop marker (harnessd/platform.ts TASK_STOPPED_FILE), which `stop()` writes before the stop. */
  forgetStop?(): void
}

/** How long the master has to stop its core (2.5 s, then it ends it) and its services beside it, and exit. */
export const WINDOWS_STOP_WAIT_MS = 8_000
/** How long a core whose master was ended has to leave by itself: it stops once its master's channel closes. */
export const ORPHAN_CORE_WAIT_MS = 5_000
/** How long an ended process has to finish going. */
export const ENDED_WAIT_MS = 2_000

export function defaultWindowsStopDeps(): WindowsStopDeps {
  return {
    ask: () => askDaemonToStop(processStopCallDeps(env.ADAPTER_DATA_DIR, env.PORT)),
    rows: () => windowsProcessRows(null),
    terminate: (pid, startMarker) => terminateVerified(pid, startMarker),
    pidFileWrittenMs: () => { try { return statSync(PID_FILE).mtimeMs } catch { return null } },
    corePid: (masterPid) => readStatusFile(HARNESSD_STATUS_FILE, masterPid)?.corePid ?? null,
    forgetStop: () => clearTaskStopped(),
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

export interface StopResult { pid: number | null; stopped: boolean }

/** What a person reads when Harness could not be stopped: from `harness stop`, and from every command that stops it
 *  first. Only Windows gets here (`stopOnWindows`), where a process that cannot be confirmed is never ended. */
export function didNotStopSentence(pid: number): string {
  return `Harness could not be stopped: pid ${pid} could not be checked or ended. Try again, or restart the computer.`
}

/** A stop that found Harness running and left it so. */
export function leftRunning(result: StopResult): result is { pid: number; stopped: false } {
  return result.pid !== null && !result.stopped
}

export interface StopOrExitDeps {
  stop?: () => Promise<StopResult>
  say?: (line: string) => void
  exit?: (code: number) => never
}

/**
 * `stopDaemonProcess` for a command that must not go on over a Harness still running — `reset` clearing its pid file
 * under it, `logout` its session, an update or a sign-in launching beside it: says so and exits 1 when it did not
 * stop. Otherwise what was stopped.
 */
export async function stopDaemonOrExit(deps: StopOrExitDeps = {}): Promise<StopResult> {
  const result = await (deps.stop ?? (() => stopDaemonProcess()))()
  if (leftRunning(result)) {
    (deps.say ?? ((line) => console.error(line)))(`\n  ✗ ${didNotStopSentence(result.pid)}\n`)
    return (deps.exit ?? ((code) => process.exit(code)))(1)
  }
  return result
}

/** SIGTERM the daemon named by the pid file, SIGKILL if it lingers; on Windows, `stopOnWindows`. Returns what was stopped. */
export async function stopDaemonProcess(deps: StopDeps = defaultStopDeps()): Promise<StopResult> {
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
    if (deps.windows) {
      const result = await stopOnWindows(deps, deps.windows, pid)
      // The task's stop marker was written before this stop (harnessd/platform.ts `stop`). Harness still runs, so it is
      // forgotten: kept, a daemon that died later would not be started again by either task until the next boot.
      if (leftRunning(result)) deps.windows.forgetStop?.()
      return result
    }
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
async function stopOnWindows(deps: StopDeps, windows: WindowsStopDeps, pid: number): Promise<{ pid: number | null; stopped: boolean }> {
  // Looked up before anything is asked: once the master goes, its core has no parent to be told by.
  const rows = await windows.rows().catch(() => null)
  // The time the pid file was written is what tells the master from a process given its pid since. Without it, or
  // without a table, nothing is known: its command alone would match another same-user daemon (B3.7).
  const claimedAtMs = windows.pidFileWrittenMs()
  const master: DaemonProcessVerdict = rows && claimedAtMs !== null ? judgePidFileOwner(rows, pid, claimedAtMs) : { verdict: 'unknown' }
  const corePid = windows.corePid(pid)
  const core = rows && corePid !== null ? identifyDaemonProcess(rows, corePid, { role: 'core', parentPid: pid }) : null
  // Asked even under a pid file that names no master: a core no master runs answers, and stops itself.
  const asked = await windows.ask()
  const gone = asked && await waitGone(deps, pid, WINDOWS_STOP_WAIT_MS)
  if (!gone) {
    // Windows hands a freed pid to the next process quickly: a pid file whose pid is proven another process's now is
    // debris, as a dead pid's is (`stopDaemonProcess`), and Harness is not running under it.
    if (master.verdict === 'not') {
      if (deps.readPid() === pid) { try { rmSync(PID_FILE, { force: true }) } catch { /* ignore */ } }
      return { pid: null, stopped: false }
    }
    // Could not tell: left running, and the pid file kept, so a `harness stop` tried again still finds it.
    if (master.verdict === 'unknown') return { pid, stopped: false }
    if (!asked) deps.warn('  ! Harness did not stop when asked — ending its processes')
    // `mismatch`: another process has the pid now, the table could not be read again, or the end was refused.
    if (await windows.terminate(pid, master.startMarker) === 'mismatch') return { pid, stopped: false }
    // TerminateProcess returns before the process has finished going.
    await waitGone(deps, pid, ENDED_WAIT_MS)
  }
  if (core && corePid !== null && !await waitGone(deps, corePid, ORPHAN_CORE_WAIT_MS)) await windows.terminate(corePid, core)
  // A master still there keeps its pid file, as one that could not be ended does.
  if (deps.isAlive(pid)) return { pid, stopped: false }
  forgetPid(deps, pid)
  return { pid, stopped: true }
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
