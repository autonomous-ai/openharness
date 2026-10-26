import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DerivedGrant, HarnessGrant } from '../sharing/grants.js'
import { identifier, object } from './wire.js'

type Wanted = Omit<DerivedGrant, 'ownerPublicKey'>
const PREFIX = 'super:'
export function superTabOf(grant: Pick<HarnessGrant, 'tab'>): string | null {
  return grant.tab?.startsWith(PREFIX) ? grant.tab.slice(PREFIX.length) : null
}
/** How long a published roster authorizes its observers, counted from the roster read that answered: the host's
 *  refresh cadence (superTabs/host.ts reads the roster each second) plus a margin for a slow read. It was 2.5 s from
 *  the moment a read was ASKED, while the roster read took 1 to 2.8 s: measured 2026-10-23 on MacBookPro2021, the
 *  snapshot lapsed 4 times in 30 s, every lapse closed each member's view ("Reconnecting · View only", reloading
 *  forever) and withdrew and sent again every invitation, which told each member's apps to read their machine lists
 *  again about 1.5 times a second. A removed member still loses the view at the next answer, which no longer lists
 *  them, and the backend checks membership again for every observer connection (routes/harnessShares.ts). */
export const OBSERVER_REFRESH_MS = 1_000, OBSERVER_SLOW_READ_MS = 10_000
export const OBSERVER_VALID_MS = OBSERVER_REFRESH_MS + OBSERVER_SLOW_READ_MS
export function observerSnapshotFile(dataDir: string, machineId: string) {
  return join(dataDir, 'super-tabs', `observers-${machineId}.json`)
}
/** The sessions the last snapshot recorded as confidential (a Lead, or in a private chat, in some Swarm). */
function savedConfidential(file: string, machineId: string): string[] {
  try {
    const saved = object(JSON.parse(readFileSync(file, 'utf8')))
    return saved.machineId === machineId && Array.isArray(saved.confidential) ? saved.confidential.filter(identifier) : []
  } catch { return [] }
}

/** Ephemeral authorization, not a durable grant. A stalled or dead producer's
 * snapshot expires; restarting Share never extends it from the clock alone.
 * Confidential sessions are the exception: a session a roster marked confidential keeps refusing every share, ordinary ones
 * too, through an empty or lapsed roster, until a roster lists it as not confidential (final review, Critical 1). */
export function publishObservers(dataDir: string, machineId: string, rows: unknown[], until: number) {
  const wanted: Wanted[] = []
  const dir = join(dataDir, 'super-tabs'), file = observerSnapshotFile(dataDir, machineId)
  const confidential = new Set(savedConfidential(file, machineId)), marked = new Set<string>(), cleared = new Set<string>()
  for (const value of rows) {
    const row = object(value), agent = object(row.agent)
    if (identifier(agent.harnessId) && agent.machineId === machineId && typeof row.confidential === 'boolean') {
      (row.confidential ? marked : cleared).add(agent.harnessId)
    }
    if (!identifier(row.tabId) || !identifier(agent.harnessId) || agent.machineId !== machineId || !Array.isArray(row.observers)) continue
    for (const observer of row.observers.map(object)) {
      if (typeof observer.email !== 'string') continue
      wanted.push({ tab: `${PREFIX}${row.tabId}`, agentId: agent.harnessId, email: observer.email.trim().toLowerCase(),
        name: typeof agent.name === 'string' ? agent.name : 'Agent', engine: typeof object(agent.configuration).engine === 'string' ? String(object(agent.configuration).engine) : null })
    }
  }
  for (const id of cleared) if (!marked.has(id)) confidential.delete(id)
  for (const id of marked) confidential.add(id)
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
    /** What the host's last roster wants, or null when no roster is in force (its host stalled, or the file cannot be
     *  read): that says nothing about who is a member, so Share keeps the invitations it holds rather than withdrawing
     *  and sending them all again. Viewing is still withheld meanwhile (`allows`). A host that stops publishes an
     *  empty roster that is in force, which does withdraw them. */
    known: (): Wanted[] | null => { const rows = read(); return live() ? rows : null },
    /** A confidential session refuses every share, Swarm or ordinary; another Swarm share needs the roster in force. */
    allows: (grant: HarnessGrant): boolean => { read(); return !confidential.includes(grant.agentId) && (!superTabOf(grant) || current().some(w =>
      w.tab === grant.tab && w.agentId === grant.agentId && w.email === grant.recipientEmail)) },
  }
}
