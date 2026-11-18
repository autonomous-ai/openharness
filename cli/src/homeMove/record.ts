import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { harnessRoot } from '../config/harnessHome.js'
import type { Reason } from './conditions.js'
import { writeWhole } from './journal.js'
import { OWN_FILES } from './plan.js'

/** Where the move stands, for `harness status` and the fleet scan: counts and times, no path and no name. */
export interface MoveRecord { version: 1; state: 'moved' | 'bridged' | 'waiting' | 'failed' | 'skipped-override'; reason?: Reason
  entries: number; bytesCopied: number; panes: number; oldProcesses: number; at: number; failedAt?: number
  /** A ~/.harness that is not the bridge sits beside the data root: said once, when this is first written. */
  stray?: true }

// Every field, and only these: whatever else a caller's object carries stays out of the file.
const FIELDS: (keyof MoveRecord)[] = ['version', 'state', 'reason', 'entries', 'bytesCopied', 'panes', 'oldProcesses', 'at', 'failedAt', 'stray']

/** The record in the state root the rule reads: the XDG one once moved, ~/.harness before. */
export function readMoveRecord(home: string, env: NodeJS.ProcessEnv): MoveRecord | null {
  return readRecord(join(harnessRoot('state', home, 'linux', { env, exists: existsSync }), OWN_FILES.record))
}

/**
 * False, with nothing written, when the state, the reason and the count of old processes the bridge waits on are the ones
 * on disk (and the stray mark, said once). A failed move's try time is written at each try: the next one waits an hour
 * from the last (start.ts).
 */
export function writeMoveRecord(folder: string, next: MoveRecord): boolean {
  const path = join(folder, OWN_FILES.record)
  const now = readRecord(path)
  if (now && now.state === next.state && now.reason === next.reason && now.oldProcesses === next.oldProcesses && now.stray === next.stray
    && now.failedAt === next.failedAt) return false
  writeWhole(path, JSON.stringify(next, FIELDS))
  return true
}

function readRecord(path: string): MoveRecord | null {
  try {
    const record = JSON.parse(readFileSync(path, 'utf8')) as MoveRecord
    return record.version === 1 ? record : null
  } catch {
    return null
  }
}
