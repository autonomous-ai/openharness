/**
 * A pid file that cannot be read (empty, torn, not a pid) is never "no daemon": a file mid-write, or a broken one, can
 * belong to a daemon that runs, and every command that judges the daemon needs a pid. So the daemon is asked: its local
 * status answers with its master's pid, which is then used as if read from the file (daemonState.ts `readPid`). A
 * master between cores (a restart's backoff, safe mode after a crash loop) has no core to answer: the master its status
 * file names is used the same way while it is proven to run, or a second `harness start` would start a second master.
 * With neither, and no other process holding the spawn lock, the file is set aside as a cache file is, and the command
 * goes on as for a missing one. While another process holds the lock it may be writing the file, which is left: that
 * read has no pid, and a command that changes the daemon settles again under its own lock.
 */
import { execFile } from 'node:child_process'
import { lstatSync, readFileSync, statSync } from 'node:fs'
import { basename } from 'node:path'
import { env } from '../config/env.js'
import { psEnv } from './childLocale.js'
import { localDaemonStatus } from './daemonEndpoint.js'
import { SPAWN_LOCK_DIR, spawnLockHeldHere } from './daemonSpawnLock.js'
import { HARNESSD_STATUS_FILE, isAlive, PID_FILE, pidOrThrow, readPidFile, setAnsweredPid, type PidFileRead } from './daemonState.js'
import { patientExec } from './patientExec.js'
import { startedNoLaterThan } from './processProof.js'
import type { ProcessRow } from './processTable.js'
import { readState } from './secureState.js'
import { judgePidFileOwner } from './windows/daemonProcesses.js'
import { windowsProcessRows } from './windows/processTable.js'

const run = patientExec(execFile)

export interface SettleDeps {
  read(): PidFileRead
  /** The daemon's local status (lib/daemonEndpoint.ts localDaemonStatus); null when none answers. */
  status(): Promise<Record<string, unknown> | null>
  /** The master harnessd's status file names (harnessd/master.ts `writeStatusFile`); null when it names none. */
  statusMaster(): number | null
  /** Whether [pid] is proven to be harnessd's master, started before it last wrote its status file (`provenMaster`). */
  masterRuns(pid: number): Promise<boolean>
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

/** The master's pid in the status file, read whole: the master renames it into place. */
function statusFileMaster(): number | null {
  try {
    return pidValue((JSON.parse(readFileSync(HARNESSD_STATUS_FILE, 'utf8')) as { masterPid?: unknown } | null)?.masterPid)
  } catch {
    return null
  }
}

function statusFileWrittenMs(): number | null {
  try { return statSync(HARNESSD_STATUS_FILE).mtimeMs } catch { return null }
}

/** What `provenMaster` reads of this computer. */
export interface MasterIo {
  isAlive(pid: number): boolean
  /** macOS and Linux: what `ps -p <pid> -o lstart=,comm=` printed; null when it failed or timed out. */
  ps(pid: number): Promise<string | null>
  /** Windows: the process table (./windows/processTable.ts); null when it cannot be read. */
  rows(): Promise<readonly ProcessRow[] | null>
}

function processMasterIo(): MasterIo {
  return {
    isAlive,
    // comm last: macOS cuts a column that is not the last at 16 bytes.
    ps: (pid) => new Promise((resolve) => {
      run('ps', ['-p', String(pid), '-o', 'lstart=,comm='], { timeout: 2_000, env: psEnv() }, (error, stdout) => resolve(error ? null : stdout))
    }),
    rows: () => windowsProcessRows(null),
  }
}

/**
 * Whether [pid] is harnessd's master, proven: it runs harnessd's master, and it started before the status file was last
 * written, which the master did while it ran. The status file outlives its master, and its pid may have been given to
 * another program since, which a stop would then signal: what cannot be proven (no table, no ps, a command line it could
 * not show, a master that runs as plain `node`) is not the master.
 */
async function provenMaster(pid: number, platform: NodeJS.Platform, io: MasterIo): Promise<boolean> {
  const writtenMs = statusFileWrittenMs()
  if (writtenMs === null || !io.isAlive(pid)) return false
  if (platform === 'win32') {
    const rows = await io.rows()
    return rows !== null && judgePidFileOwner(rows, pid, writtenMs).verdict === 'is'
  }
  const read = /^\s*(\S+\s+\S+\s+\d{1,2}\s+\d{1,2}:\d{2}:\d{2}\s+\d{4})\s+(.+?)\s*$/.exec(await io.ps(pid) ?? '')
  // macOS names it by the file it ran (…/libexec/harnessd/harnessd), Linux by that file's name (harnessd/processName.ts).
  return read !== null && basename(read[2]!) === 'harnessd' && startedNoLaterThan({ startMarker: read[1]! }, writtenMs)
}

/** This computer's; [platform] and [io] are what the master's proof reads (`provenMaster`). */
export function processSettleDeps(platform: NodeJS.Platform = process.platform, io: Partial<MasterIo> = {}): SettleDeps {
  return {
    read: () => readPidFile(),
    status: () => localDaemonStatus(env.ADAPTER_DATA_DIR, env.PORT),
    statusMaster: () => statusFileMaster(),
    masterRuns: (pid) => provenMaster(pid, platform, { ...processMasterIo(), ...io }),
    lockFree: () => spawnLockHeldHere() || lockAbsent(),
    // Through the reader, as every cache file is set aside: it reads the file once more, renames it and logs the line.
    setAside: () => { readState(PID_FILE, 'cache', pidOrThrow) },
    answer: (pid) => setAnsweredPid(pid),
  }
}

/** A pid as the daemon gives one: a safe integer above 0, or none. */
function pidValue(pid: unknown): number | null {
  return typeof pid === 'number' && Number.isSafeInteger(pid) && pid > 0 ? pid : null
}

/** The master the status file names, while it runs. */
async function runningMaster(deps: SettleDeps): Promise<number | null> {
  const pid = deps.statusMaster()
  return pid !== null && await deps.masterRuns(pid) ? pid : null
}

export async function settlePidFile(deps: SettleDeps = processSettleDeps()): Promise<Settled> {
  const read = deps.read()
  if (read.state !== 'unreadable') {
    deps.answer(null)
    return read.state === 'pid' ? { state: 'pid', pid: read.pid, from: 'file' } : { state: 'missing' }
  }
  const pid = pidValue((await deps.status())?.pid) ?? await runningMaster(deps)
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
