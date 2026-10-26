import { createHash } from 'node:crypto'
import type { HostTabRows } from './contract.js'

/** JSON with sorted keys, so equal rows hash equal whatever order their records were built in. */
const sorted = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item as Record<string, unknown>).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item)

/**
 * A Swarm's host rows as a short hash (design 4.10, Lead's ruling after group 5's run: an active Swarm cost a full roster
 * per tick). Equal rows, equal hash. Left out: the host's own machine reading, which it sent, and each row's change time,
 * which moves with any change in the Swarm; the entry's own `lastChangedAt` still comes with every answer.
 */
export function hostEtag(tab: Omit<HostTabRows, 'etag'>): string {
  const roster = tab.roster.map(row => 'lastChangedAt' in row ? { ...row, lastChangedAt: undefined } : row)
  const pool = tab.pool && { ...tab.pool, machine: { ...tab.pool.machine, observation: undefined } }
  return createHash('sha256').update(sorted({ roster, pool, assignments: tab.assignments })).digest('base64url').slice(0, 22)
}
