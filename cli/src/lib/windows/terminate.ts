/**
 * Ending one Windows process harnessd started, and that one only: TerminateProcess, once the process table says the
 * pid is still the process that was meant (pid plus start marker, A's identity proof, ./processTable.ts). A pid
 * alone is not enough: Windows hands a freed pid to the next process quickly.
 *
 * Never `taskkill /T`. The pty host's parent is the core, and the agents are the host's: ending the core's tree ends
 * every agent (spec section 3, "Stop"). Node's `process.kill` on Windows is TerminateProcess on that pid alone,
 * whatever the signal, which is all this calls. What is left is the moment between the table's read and the call;
 * the pid would have to exit and be reissued inside it.
 */
import type { ProcessRow } from '../processTable.js'
import { windowsProcessRows } from './processTable.js'

export type TerminateOutcome = 'ended' | 'gone' | 'mismatch'

export interface TerminateDeps {
  /** The process table: A's host `ps` (./processTable.ts); null when it cannot be read. */
  rows(): Promise<readonly ProcessRow[] | null>
  /** TerminateProcess on [pid]. */
  kill(pid: number): void
}

export const defaultTerminateDeps: TerminateDeps = {
  rows: () => windowsProcessRows(null),
  kill: (pid) => { process.kill(pid, 'SIGKILL') },
}

/** End [pid] if it still started at [startMarker]: `ended`; `gone` when nothing runs as it; `mismatch` when it is
 *  another process now, or could not be identified (no table, no marker), and was left alone. */
export async function terminateVerified(pid: number, startMarker: string, deps: TerminateDeps = defaultTerminateDeps): Promise<TerminateOutcome> {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid || !startMarker) return 'mismatch'
  const rows = await deps.rows().catch(() => null)
  if (!rows) return 'mismatch'
  const row = rows.find((candidate) => candidate.pid === pid)
  if (!row) return 'gone'
  if (row.startMarker !== startMarker) return 'mismatch'
  try {
    deps.kill(pid)
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'gone' : 'mismatch'
  }
  return 'ended'
}
