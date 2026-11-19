/**
 * A pid file that cannot be read (empty, torn, not a pid) is never "no daemon": a file mid-write, or a broken one, can
 * belong to a daemon that runs, and every command that judges the daemon needs a pid. So the daemon is asked: its local
 * status answers with its master's pid, which is then used as if read from the file (daemonState.ts `readPid`). When
 * none answers and no other process holds the spawn lock, the file is set aside as a cache file is, and the command
 * goes on as for a missing one. While another process holds the lock it may be writing the file, which is left: that
 * read has no pid, and a command that changes the daemon settles again under its own lock.
 */
import { lstatSync } from 'node:fs'
import { env } from '../config/env.js'
import { localDaemonStatus } from './daemonEndpoint.js'
import { SPAWN_LOCK_DIR, spawnLockHeldHere } from './daemonSpawnLock.js'
import { isAlive, PID_FILE, pidOrThrow, readPidFile, setAnsweredPid, type PidFileRead } from './daemonState.js'
import { readState } from './secureState.js'

export interface SettleDeps {
  read(): PidFileRead
  /** The daemon's local status (lib/daemonEndpoint.ts localDaemonStatus); null when none answers. */
  status(): Promise<Record<string, unknown> | null>
  /** The spawn lock is free, or this process holds it. False for another holder, or a lock that cannot be read. */
  lockFree(): boolean
  setAside(): void
  answer(pid: number | null): void
}

export type Settled = { state: 'pid'; pid: number; from: 'file' | 'daemon' } | { state: 'missing' } | { state: 'busy' }

/** No lock there at all. One that cannot be looked at is not known to be free. */
function lockAbsent(): boolean {
  try {
    lstatSync(SPAWN_LOCK_DIR)
    return false
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
  }
}

export function processSettleDeps(): SettleDeps {
  return {
    read: () => readPidFile(),
    status: () => localDaemonStatus(env.ADAPTER_DATA_DIR, env.PORT),
    lockFree: () => spawnLockHeldHere() || lockAbsent(),
    // Through the reader, as every cache file is set aside: it reads the file once more, renames it and logs the line.
    setAside: () => { readState(PID_FILE, 'cache', pidOrThrow) },
    answer: (pid) => setAnsweredPid(pid),
  }
}

/** The master's pid in the daemon's status: a safe integer above 0, or none. */
function answeredPid(status: Record<string, unknown> | null): number | null {
  const pid = status?.pid
  return typeof pid === 'number' && Number.isSafeInteger(pid) && pid > 0 ? pid : null
}

export async function settlePidFile(deps: SettleDeps = processSettleDeps()): Promise<Settled> {
  const read = deps.read()
  if (read.state !== 'unreadable') {
    deps.answer(null)
    return read.state === 'pid' ? { state: 'pid', pid: read.pid, from: 'file' } : { state: 'missing' }
  }
  const pid = answeredPid(await deps.status())
  deps.answer(pid)
  if (pid !== null) return { state: 'pid', pid, from: 'daemon' }
  if (!deps.lockFree()) return { state: 'busy' }
  // Read once more: launchd starts a master without the spawn lock, and its claim may have landed since.
  const again = deps.read()
  if (again.state === 'pid') return { state: 'pid', pid: again.pid, from: 'file' }
  if (again.state === 'unreadable') deps.setAside()
  return { state: 'missing' }
}

/** Whether the daemon runs: the settled pid is alive. Here, not in daemonState.ts, which the core loads: the settle
 *  asks the daemon, and the core never loads that. */
export async function isDaemonRunning(deps: SettleDeps = processSettleDeps()): Promise<boolean> {
  const settled = await settlePidFile(deps)
  return settled.state === 'pid' && isAlive(settled.pid)
}
