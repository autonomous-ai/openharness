/**
 * Which row of the Windows process table is harnessd's master or its core, for a CLI that has only a pid from a file
 * (the pid file, the master's status file). Before anything is ended, the pid must run the daemon's command, and:
 * the master must have started before it claimed the pid file (it claims it once its core has bound; a process
 * that started later was given the pid since); the core must be the master's child. The row's start marker is what
 * `terminateVerified` then checks again, right before the end.
 */
import type { ProcessRow } from '../processTable.js'
import { startMarkerMs } from '../processProof.js'

export type DaemonRole = 'master' | 'core'

export interface DaemonProcessClaim {
  role: DaemonRole
  /** The core's: the master's pid. */
  parentPid?: number
  /** The master's: when the pid file was written, ms since the epoch. */
  claimedAtMs?: number
}

/** A FILETIME is exact; this covers a clock that moved and a file system's own rounding. */
const CLAIM_SLACK_MS = 2_000

function runsAs(argv: readonly string[], role: DaemonRole): boolean {
  if (role === 'core') return argv.includes('__run')
  // `harness start -f` runs the master in that process (masterProcess.ts startMasterInForeground).
  return argv.includes('__harnessd') || (argv.includes('start') && (argv.includes('-f') || argv.includes('--foreground')))
}

/** The start marker of [pid] when it is the daemon's [claim.role]; null when it is not, or cannot be shown to be. */
export function identifyDaemonProcess(rows: readonly ProcessRow[], pid: number, claim: DaemonProcessClaim): string | null {
  const row = rows.find((candidate) => candidate.pid === pid)
  if (!row || !row.startMarker) return null
  const argv = row.nativeArgv ?? row.args.split(/\s+/).filter(Boolean)
  if (!runsAs(argv, claim.role)) return null
  if (claim.parentPid !== undefined && row.parentPid !== claim.parentPid) return null
  if (claim.claimedAtMs !== undefined) {
    const started = startMarkerMs(row.startMarker)
    if (started === null || started > claim.claimedAtMs + CLAIM_SLACK_MS) return null
  }
  return row.startMarker
}
