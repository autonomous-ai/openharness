import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DerivedGrant, HarnessGrant } from '../sharing/grants.js'
import { identifier, object } from './wire.js'

type Wanted = Omit<DerivedGrant, 'ownerPublicKey'>
const PREFIX = 'super:'
export function superTabOf(grant: Pick<HarnessGrant, 'tab'>): string | null {
  return grant.tab?.startsWith(PREFIX) ? grant.tab.slice(PREFIX.length) : null
}
export function observerSnapshotFile(dataDir: string, machineId: string) {
  return join(dataDir, 'super-tabs', `observers-${machineId}.json`)
}
/** Ephemeral authorization, not a durable grant. A stalled or dead producer's
 * snapshot expires; restarting Share never extends it from the clock alone. */
export function publishObservers(dataDir: string, machineId: string, rows: unknown[], until: number) {
  const wanted: Wanted[] = []
  for (const value of rows) {
    const row = object(value), agent = object(row.agent)
    if (!identifier(row.tabId) || !identifier(agent.harnessId) || agent.machineId !== machineId || !Array.isArray(row.observers)) continue
    for (const observer of row.observers.map(object)) {
      if (typeof observer.email !== 'string') continue
      wanted.push({ tab: `${PREFIX}${row.tabId}`, agentId: agent.harnessId, email: observer.email.trim().toLowerCase(),
        name: typeof agent.name === 'string' ? agent.name : 'Agent', engine: typeof object(agent.configuration).engine === 'string' ? String(object(agent.configuration).engine) : null })
    }
  }
  const dir = join(dataDir, 'super-tabs'), file = observerSnapshotFile(dataDir, machineId)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  writeFileSync(`${file}.next`, JSON.stringify({ machineId, until, wanted }), { mode: 0o600 })
  renameSync(`${file}.next`, file)
}
export function observerSource(dataDir: string, machine: () => string, now = Date.now) {
  let readAt = -Infinity, id = '', until = 0, wanted: Wanted[] = []
  const current = (): Wanted[] => {
    const machineId = machine(), time = now()
    if (time - readAt >= 200 || machineId !== id) {
      id = machineId; readAt = time; until = 0; wanted = []
      if (identifier(machineId)) try {
        const raw = readFileSync(observerSnapshotFile(dataDir, machineId), 'utf8')
        if (raw.length <= 4 * 1024 * 1024) {
          const saved = object(JSON.parse(raw))
          if (saved.machineId === machineId && typeof saved.until === 'number' && saved.until <= time + 3000 && Array.isArray(saved.wanted)) {
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
    return time < until ? wanted : []
  }
  return {
    current,
    allows: (grant: HarnessGrant): boolean => !superTabOf(grant) || current().some(w =>
      w.tab === grant.tab && w.agentId === grant.agentId && w.email === grant.recipientEmail),
  }
}
