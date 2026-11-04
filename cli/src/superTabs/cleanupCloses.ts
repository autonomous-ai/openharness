/** The sessions this machine's agent cleanup closed (services/agentCleanup.ts `closed`), which its report names apart from
 *  the other stopped ones (machines.ts `closedHarnessIds`). The backend refuses new work only for such a session
 *  (backend superTabs/closedAgents.ts sessionClosed): on 11-04 the cleanup closed Tern on the Mac Studio and the PM assigned
 *  it six seconds later (task #2744), while a session Change agent stopped before its rebind, or one a host mid-restart lists
 *  stopped, still takes work (review of #2953).
 *
 * Written by the Swarm's side of the cleanup, in whichever process the cleanup runs, read by the machine's report. A close is
 * kept CLEANUP_CLOSED_KEEP_MS, long after its agent has left the roster (backend closedAgents.ts, 30 s), and a session that
 * runs again is never named, whatever this says. */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { identifier, object } from './wire.js'

export const CLEANUP_CLOSED_KEEP_MS = 10 * 60_000
/** At most this many, the newest: one machine closes a few an hour. */
export const CLEANUP_CLOSED_MAX = 1_000
export const cleanupClosesFile = (dataDir: string) => join(dataDir, 'super-tabs', 'cleanup-closed.json')

function read(dataDir: string, now: number): Map<string, number> {
  try {
    const saved = object(object(JSON.parse(readFileSync(cleanupClosesFile(dataDir), 'utf8'))).closed)
    return new Map(Object.entries(saved).filter((entry): entry is [string, number] =>
      identifier(entry[0]) && typeof entry[1] === 'number' && now - entry[1] < CLEANUP_CLOSED_KEEP_MS))
  } catch { return new Map() }
}

export function cleanupClosed(dataDir: string, now = Date.now()): Set<string> {
  return new Set(read(dataDir, now).keys())
}

/** Records that the cleanup closed [harnessId]; false when it could not, which the cleanup says. It never throws: the close is
 *  done either way, and a session it could not record is only listed stopped, as before this file. */
export function recordCleanupClose(dataDir: string, harnessId: string, now = Date.now()): boolean {
  const closed = read(dataDir, now)
  closed.delete(harnessId)
  closed.set(harnessId, now)
  for (const oldest of closed.keys()) {
    if (closed.size <= CLEANUP_CLOSED_MAX) break
    closed.delete(oldest)
  }
  const file = cleanupClosesFile(dataDir)
  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
    // Written whole and renamed: the report never reads half of it.
    writeFileSync(`${file}.next`, JSON.stringify({ version: 1, closed: Object.fromEntries(closed) }), { mode: 0o600 })
    renameSync(`${file}.next`, file)
    return true
  } catch { return false }
}
