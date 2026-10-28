import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DerivedGrant, HarnessGrant } from '../sharing/grants.js'
import { observerSnapshotFile, savedConfidential, superTabOf } from '../sharing/swarmMarks.js'
import { identifier, object } from './wire.js'

// Which grants are a Super Tab's, and the confidential marks: read by Share with the Swarm off too (sharing/swarmMarks.ts).
export { observerSnapshotFile, superTabOf }

type Wanted = Omit<DerivedGrant, 'ownerPublicKey'>
const PREFIX = 'super:'
/** How long a published roster authorizes its observers, counted from the roster read that answered: the host's
 *  refresh cadence (superTabs/host.ts reads the roster each second) plus a margin for a slow read. It was 2.5 s from
 *  the moment a read was ASKED, while the roster read took 1 to 2.8 s: measured 2026-10-23 on MacBookPro2021, the
 *  snapshot lapsed 4 times in 30 s, every lapse closed each member's view ("Reconnecting · View only", reloading
 *  forever) and withdrew and sent again every invitation, which told each member's apps to read their machine lists
 *  again about 1.5 times a second. A removed member still loses the view at the next answer, which no longer lists
 *  them, and the backend checks membership again for every observer connection (routes/harnessShares.ts). */
export const OBSERVER_REFRESH_MS = 1_000, OBSERVER_SLOW_READ_MS = 10_000
export const OBSERVER_VALID_MS = OBSERVER_REFRESH_MS + OBSERVER_SLOW_READ_MS

/** Ephemeral authorization, not a durable grant. A stalled or dead producer's
 * snapshot expires; restarting Share never extends it from the clock alone.
 * Confidential sessions are the exception: a session a roster marked confidential keeps refusing every share, ordinary ones
 * too, until it closes on this machine (`live` says it no longer runs), whatever later rosters from any Swarm say (final
 * review, Critical 1). Without `live` nothing is cleared. */
export function publishObservers(dataDir: string, machineId: string, rows: unknown[], until: number, live?: (harnessId: string) => boolean) {
  const wanted: Wanted[] = []
  const dir = join(dataDir, 'super-tabs'), file = observerSnapshotFile(dataDir, machineId)
  const confidential = new Set(savedConfidential(file, machineId).filter(id => !live || live(id)))
  for (const value of rows) {
    const row = object(value), agent = object(row.agent)
    if (identifier(agent.harnessId) && agent.machineId === machineId && row.confidential === true) confidential.add(agent.harnessId)
    if (!identifier(row.tabId) || !identifier(agent.harnessId) || agent.machineId !== machineId || !Array.isArray(row.observers)) continue
    for (const observer of row.observers.map(object)) {
      if (typeof observer.email !== 'string') continue
      wanted.push({ tab: `${PREFIX}${row.tabId}`, agentId: agent.harnessId, email: observer.email.trim().toLowerCase(),
        name: typeof agent.name === 'string' ? agent.name : 'Agent', engine: typeof object(agent.configuration).engine === 'string' ? String(object(agent.configuration).engine) : null })
    }
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  writeFileSync(`${file}.next`, JSON.stringify({ machineId, until, wanted, confidential: [...confidential] }), { mode: 0o600 })
  renameSync(`${file}.next`, file)
}
export function observerSource(dataDir: string, machine: () => string, now = Date.now) {
  let readAt = -Infinity, id = '', until = 0, wanted: Wanted[] = [], confidential: string[] = []
  const read = (): Wanted[] => {
    const machineId = machine(), time = now()
    if (time - readAt >= 200 || machineId !== id) {
      id = machineId; readAt = time; until = 0; wanted = []
      if (identifier(machineId)) try {
        const raw = readFileSync(observerSnapshotFile(dataDir, machineId), 'utf8')
        if (raw.length <= 4 * 1024 * 1024) {
          const saved = object(JSON.parse(raw))
          // Kept whatever the snapshot's age: a lapsed roster must not reopen a confidential session.
          confidential = saved.machineId === machineId && Array.isArray(saved.confidential) ? saved.confidential.filter(identifier) : confidential
          if (saved.machineId === machineId && typeof saved.until === 'number' && saved.until <= time + OBSERVER_VALID_MS + 500 && Array.isArray(saved.wanted)) {
            until = saved.until
            wanted = saved.wanted.filter(w => {
              const value = object(w)
              return typeof value.tab === 'string' && value.tab.startsWith(PREFIX) && identifier(value.agentId)
                && typeof value.email === 'string' && typeof value.name === 'string' && (value.engine === null || typeof value.engine === 'string')
            }) as Wanted[]
          }
        }
      } catch { /* An unavailable or partially replaced authority file withholds viewing. */ }
    }
    return wanted
  }
  const live = () => now() < until
  const current = (): Wanted[] => { const rows = read(); return live() ? rows : [] }
  return {
    current,
    /** What the host's last roster wants, or null when no roster is in force (its host stalled or stopped, or the file
     *  cannot be read): that says nothing about who is a member, so Share keeps the invitations it holds rather than
     *  withdrawing and sending them all again. Viewing is still withheld meanwhile (`allows`). The next roster in force
     *  withdraws those of members it no longer lists. */
    known: (): Wanted[] | null => { const rows = read(); return live() ? rows : null },
    /** A confidential session refuses every share, Swarm or ordinary; another Swarm share needs the roster in force. */
    allows: (grant: HarnessGrant): boolean => { read(); return !confidential.includes(grant.agentId) && (!superTabOf(grant) || current().some(w =>
      w.tab === grant.tab && w.agentId === grant.agentId && w.email === grant.recipientEmail)) },
    /** A Swarm share withheld only because no roster is in force (its host is starting, or restarting for an update): the
     *  next roster decides it, so its viewer is told to try again rather than that sharing ended. A confidential session's
     *  is refused for good. */
    paused: (grant: HarnessGrant): boolean => { read(); return !!superTabOf(grant) && !confidential.includes(grant.agentId) && !live() },
  }
}
