/**
 * Whether the process a file names is proven gone, before anything dials the endpoint the file names. Used for the
 * pty host's discovery file (ptyHost/launch.ts `discoveredHostDead`) and the daemon's record on Windows
 * (windows/daemonPipe.ts `daemonPipe`). Once its process is gone, any user can create a pipe of the name the file gives.
 */
import { statSync } from 'node:fs'

/** Whether process [pid] exists (EPERM is one that does, another user's). */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** A process table row, as far as the liveness proof reads it (processTable.ts `ProcessRow`). */
export interface HostProcessRow { pid: number; executable: string; startMarker: string }

/**
 * How a recorded process is proven dead: whether its pid runs, and, when given, the process table. Callers pass the
 * table on Windows only (ptyHostBackend.ts, windows/daemonPipe.ts).
 */
export interface HostLiveness {
  alive(pid: number): boolean
  rows?: () => Promise<readonly HostProcessRow[] | null>
}

/** When a process started, in ms since the epoch, from its start marker (`w:<FILETIME>`, or a C-locale `lstart`). */
export function startMarkerMs(marker: string): number | null {
  const windows = /^w:(\d+)$/.exec(marker)
  // FILETIME: 100 ns intervals since 1601-01-01.
  if (windows) return Number(BigInt(windows[1]!) / 10_000n) - 11_644_473_600_000
  const parsed = Date.parse(marker)
  return Number.isFinite(parsed) ? parsed : null
}

/** A marker read to the second (`lstart`) may be up to this much early; a FILETIME is exact. */
export const START_SLACK_MS = 2_000

/**
 * Whether [row]'s process started no later than [writtenMs] (when a file its process wrote was written), within
 * START_SLACK_MS. False when its start cannot be read: a caller that ends a process on this proof fails closed
 * (uninstall/ptyHosts.ts).
 */
export function startedNoLaterThan(row: Pick<HostProcessRow, 'startMarker'>, writtenMs: number): boolean {
  const started = row.startMarker ? startMarkerMs(row.startMarker) : null
  return started !== null && started <= writtenMs + START_SLACK_MS
}

/**
 * Whether the process [pid] that wrote [file] is proven dead. It is proven when the pid runs no process, when the
 * process table has no such pid, or when the process with that pid started after [file] was written (the pid has
 * been given to another process since). No proof (a table that cannot be read, a file that cannot be stat'ed) is not
 * death. The endpoint is dialled as before, and the caller's own check of what answers decides.
 */
export async function recordedProcessDead(file: string, pid: number, liveness: HostLiveness): Promise<boolean> {
  if (!liveness.alive(pid)) return true
  if (!liveness.rows) return false
  const rows = await liveness.rows().catch(() => null)
  if (!rows) return false
  const row = rows.find((candidate) => candidate.pid === pid)
  if (!row) return true
  let written: number
  try {
    written = statSync(file).mtimeMs
  } catch {
    return false
  }
  const started = startMarkerMs(row.startMarker)
  return started !== null && started > written + START_SLACK_MS
}
