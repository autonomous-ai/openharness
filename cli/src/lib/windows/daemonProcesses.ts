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

/**
 * What the CLI knows of the process besides its pid, and must know: the argv alone would accept another same-user
 * daemon (another install, another data folder) that the pid was given to since. The master's: when the pid file
 * was written, ms since the epoch. The core's: the master's pid.
 */
export type DaemonProcessClaim = { role: 'master'; claimedAtMs: number } | { role: 'core'; parentPid: number }

/** A FILETIME is exact; this covers a clock that moved and a file system's own rounding. */
const CLAIM_SLACK_MS = 2_000

function runsAs(argv: readonly string[], role: DaemonRole): boolean {
  if (role === 'core') return argv.includes('__run')
  // `harness start -f` runs the master in that process (masterProcess.ts startMasterInForeground).
  return argv.includes('__harnessd') || (argv.includes('start') && (argv.includes('-f') || argv.includes('--foreground')))
}

/** What the table shows of [pid] against [claim]: the daemon's process (with its start marker), proven not to be
 *  (gone from the table, another command, started after the claim, another parent), or nothing either way. */
export type DaemonProcessVerdict = { verdict: 'is'; startMarker: string } | { verdict: 'not' } | { verdict: 'unknown' }

export function judgeDaemonProcess(rows: readonly ProcessRow[], pid: number, claim: DaemonProcessClaim): DaemonProcessVerdict {
  const row = rows.find((candidate) => candidate.pid === pid)
  if (!row) return { verdict: 'not' }
  // By time first: a master that started after the claim was given the pid since, whatever its argv shows.
  const started = startMarkerMs(row.startMarker)
  if (claim.role === 'master' && started !== null && started > claim.claimedAtMs + CLAIM_SLACK_MS) return { verdict: 'not' }
  // The kernel's argv only: split from `args`, an agent's prompt text could pose as a `__run` token. The host gives
  // every row one (pty/src/ps.rs): `[executable]` when the command line could not be read, which shows nothing.
  if (!row.startMarker || !row.nativeArgv) return { verdict: 'unknown' }
  if (row.nativeArgv.length === 1 && row.nativeArgv[0] === row.executable) return { verdict: 'unknown' }
  if (!runsAs(row.nativeArgv, claim.role)) return { verdict: 'not' }
  const is = { verdict: 'is', startMarker: row.startMarker } as const
  if (claim.role === 'core') return row.parentPid === claim.parentPid ? is : { verdict: 'not' }
  if (started === null || !Number.isFinite(claim.claimedAtMs)) return { verdict: 'unknown' }
  return started <= claim.claimedAtMs + CLAIM_SLACK_MS ? is : { verdict: 'not' }
}

/** The start marker of [pid] when it is the daemon's [claim.role]; null when it is not, or cannot be shown to be. */
export function identifyDaemonProcess(rows: readonly ProcessRow[], pid: number, claim: DaemonProcessClaim): string | null {
  const judged = judgeDaemonProcess(rows, pid, claim)
  return judged.verdict === 'is' ? judged.startMarker : null
}

/**
 * Whose pid the pid file holds. Harnessd's master claims it; a core no master runs claims it for itself
 * (core/main.ts), and is Harness too. `is`: the master, which `harness stop` may end. `not`: proven another process
 * (gone, another command, or started after the file was written: Windows reissues a freed pid quickly). `unknown`: a
 * core no master runs, or a row that cannot be read; never ended, and the file is kept.
 */
export function judgePidFileOwner(rows: readonly ProcessRow[], pid: number, claimedAtMs: number): DaemonProcessVerdict {
  const asMaster = judgeDaemonProcess(rows, pid, { role: 'master', claimedAtMs })
  if (asMaster.verdict !== 'not') return asMaster
  const row = rows.find((candidate) => candidate.pid === pid)
  if (!row?.nativeArgv || !runsAs(row.nativeArgv, 'core')) return asMaster
  const started = startMarkerMs(row.startMarker)
  return started !== null && started <= claimedAtMs + CLAIM_SLACK_MS ? { verdict: 'unknown' } : asMaster
}

