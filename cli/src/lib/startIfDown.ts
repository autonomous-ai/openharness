/**
 * `harness start --if-down`: what the scheduled task runs at logon and every five minutes on Windows
 * (harnessd/platform.ts `taskSchedulerXml`), in place of launchd's KeepAlive and systemd's Restart=. It starts the
 * daemon when none runs, and otherwise does nothing, silently: a master runs; someone holds the spawn lock (a start,
 * a stop, an update is under way, and waiting on it every five minutes would only pile up); or `harness stop`
 * stopped it since this computer started, which a person meant to last. The logon task's start (`--at-logon`) forgets
 * such a stop first, as launchd loads an agent booted out at the next login: with Fast Startup a Shut down keeps the
 * uptime the boot time is read from, and a stop outlived the next power-on (final review R1b-2).
 */
import { rmSync, statSync } from 'node:fs'
import { PID_FILE, isAlive, readPid } from './daemonState.js'
import {
  describeSpawnLockOwner, readSpawnLockOwner, releaseAbandonedSpawnLock, spawnLockOwnerReused, type SpawnLockOwner,
} from './daemonSpawnLock.js'
import { clearTaskStopped, taskStoppedThisBoot } from './platformDaemon.js'
import { lockOwnerAlive, lockStartMarker } from './processLiveness.js'
import type { ProcessRow } from './processTable.js'
import { judgePidFileOwner } from './windows/daemonProcesses.js'
import { windowsProcessRows } from './windows/processTable.js'

export type IfDown = { start: true } | { start: false; why: string }

export interface IfDownDeps {
  readPid(): number | null
  /** Whether [pid] runs harnessd's master. */
  masterRuns(pid: number): Promise<boolean>
  /** The spawn lock's owner, null when it is free; throws for something that is not a lock. */
  lockOwner(): SpawnLockOwner | null
  ownerRuns(owner: SpawnLockOwner): Promise<boolean>
  stoppedThisBoot(): boolean
  /** Forget a `harness stop`: the logon task's start does. */
  forgetStop(): void
}

export async function startIfDown(deps: IfDownDeps, options: { atLogon?: boolean } = {}): Promise<IfDown> {
  if (options.atLogon) deps.forgetStop()
  else if (deps.stoppedThisBoot()) return { start: false, why: '`harness stop` stopped it since this computer started; `harness start` starts it again' }
  const pid = deps.readPid()
  if (pid !== null && await deps.masterRuns(pid)) return { start: false, why: `it runs (pid ${pid})` }
  let owner: SpawnLockOwner | null
  try {
    owner = deps.lockOwner()
  } catch (error) {
    return { start: false, why: `the daemon spawn lock is unusable (${error instanceof Error ? error.message : String(error)})` }
  }
  if (owner && await deps.ownerRuns(owner)) return { start: false, why: `the daemon is ${describeSpawnLockOwner(owner)}` }
  return { start: true }
}

/**
 * The same judge for a plain `harness start` on Windows: the pid of the daemon that runs, or null. A pid file whose
 * pid is proven another process now is forgotten on the way (`masterRuns`), and the start goes ahead; one that cannot
 * be told counts as running.
 */
export async function runningDaemon(deps: Pick<IfDownDeps, 'readPid' | 'masterRuns'>): Promise<number | null> {
  const pid = deps.readPid()
  return pid !== null && await deps.masterRuns(pid) ? pid : null
}

/**
 * Before a plain `harness start` waits on the spawn lock: a lock whose owner's pid was given to another process since
 * is released (`ownerRuns`, judged again as it goes), where waiting on it would only time out. A lock that cannot be
 * read is left to the start, which says what it is.
 */
export async function releaseAbandonedLock(deps: Pick<IfDownDeps, 'lockOwner' | 'ownerRuns'>): Promise<void> {
  let owner: SpawnLockOwner | null
  try {
    owner = deps.lockOwner()
  } catch {
    return
  }
  if (owner) await deps.ownerRuns(owner)
}

/** What `processIfDownDeps` reads of this computer, and the two things it may remove. */
export interface IfDownIo {
  readPid(): number | null
  isAlive(pid: number): boolean
  /** When the pid file was written, which is when the master claimed it; null when it cannot be read. */
  pidFileWrittenMs(): number | null
  /** Remove the pid file, only while it still names [pid]. */
  forgetPid(pid: number): void
  rows(): Promise<readonly ProcessRow[] | null>
  readLockOwner(): SpawnLockOwner | null
  lockOwnerAlive(owner: SpawnLockOwner): boolean
  /** Remove the lock [owner] held, only while it is still that lock and still judged abandoned against [row]. */
  releaseAbandoned(owner: SpawnLockOwner, row: { pid: number; startMarker: string }): boolean
  stoppedThisBoot(): boolean
  forgetStop(): void
}

function defaultIfDownIo(): IfDownIo {
  return {
    readPid,
    isAlive,
    pidFileWrittenMs: () => { try { return statSync(PID_FILE).mtimeMs } catch { return null } },
    forgetPid: (pid) => { if (readPid() === pid) { try { rmSync(PID_FILE, { force: true }) } catch { /* the next tick looks again */ } } },
    rows: () => windowsProcessRows(null),
    readLockOwner: () => readSpawnLockOwner(),
    lockOwnerAlive: (owner) => lockOwnerAlive(owner.pid, lockStartMarker(owner)),
    releaseAbandoned: (owner, row) => releaseAbandonedSpawnLock(owner, row),
    stoppedThisBoot: () => taskStoppedThisBoot(),
    forgetStop: () => clearTaskStopped(),
  }
}

/**
 * This computer's. On Windows a pid is checked against the process table: a pid file or a lock whose pid was given to
 * another process since must not stand for a running daemon, or the task would never start one again. Only what is
 * proven goes: a pid file whose pid the table shows is another process now is forgotten (as `harness stop` forgets it,
 * lib/daemonStop.ts), or the start that follows would read it as a running daemon all the same, but only by a caller
 * that holds the spawn lock (`forget`): outside it, a start that holds the lock may write a fresh pid file between the
 * read and the remove, and its file would be lost. A lock is released only while it is still the lock judged. What cannot be told (no table, no time the pid file was written, a command
 * line that cannot be read) proves nothing either way, and the pid's liveness decides, as elsewhere: the master's
 * command line alone would match another daemon of this user's (B3.7).
 */
export function processIfDownDeps(
  platform: NodeJS.Platform = process.platform, overrides: Partial<IfDownIo> = {}, options: { forget?: boolean } = {},
): IfDownDeps {
  const io = { ...defaultIfDownIo(), ...overrides }
  const windows = platform === 'win32'
  return {
    readPid: () => io.readPid(),
    masterRuns: async (pid) => {
      if (!io.isAlive(pid)) return false
      if (!windows) return true
      const rows = await io.rows()
      const claimedAtMs = io.pidFileWrittenMs()
      if (!rows || claimedAtMs === null) return true
      if (judgePidFileOwner(rows, pid, claimedAtMs).verdict !== 'not') return true
      if (options.forget) io.forgetPid(pid)
      return false
    },
    lockOwner: () => io.readLockOwner(),
    ownerRuns: async (owner) => {
      if (!io.lockOwnerAlive(owner)) return false
      if (!windows) return true
      const row = (await io.rows())?.find((candidate) => candidate.pid === owner.pid) ?? null
      if (!row || !spawnLockOwnerReused(owner, row)) return true
      // Released only while it is still this lock, judged again as it is removed: a lock that changed hands meanwhile
      // has a live holder, and this start leaves it to the next tick.
      return !io.releaseAbandoned(owner, row)
    },
    stoppedThisBoot: () => windows && io.stoppedThisBoot(),
    forgetStop: () => { if (windows) io.forgetStop() },
  }
}
