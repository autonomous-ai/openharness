import type { PrismaClient } from '@prisma/client'
import type { AuthUser } from '../../../src/lib/ssoAuth.js'
import { loadChanged } from '../../../src/superTabs/parts/index.js'
import type { Reader, Reply, SwarmDriver } from '../driver.js'
import { legacyDriver } from '../legacyDriver.js'

/** The parts' collections (backend/prisma/schema.prisma, Swarm state by parts). */
const PARTS = ['SwarmHead', 'SwarmMember', 'SwarmGroup', 'SwarmAgent', 'SwarmMachine', 'SwarmStart', 'SwarmProgress']
/** A reader's next cursor is its read's start time minus this overlap (design section 3.3). */
const OVERLAP_MS = 30_000

/**
 * The store by parts (#1726 group 2). Commands, machine reports, terminals and deliveries go through the same routes as
 * `legacyDriver`, which the parts store serves now. What differs is how a client reads and what the state costs:
 * - a Desktop reader loads the Swarm once, then asks only for the parts changed since its cursor (design section 4.4).
 *   Until group 3's changes route lands, it reads them with the store's `loadChanged` in process and counts their JSON
 *   as the response; group 3's route adds the reader's view and `derived` to that;
 * - a host reader still reads today's roster route (group 3's host form replaces it);
 * - the state's size is its live parts: every part except tombstones and dormant groups.
 */
export async function partsDriver(db: PrismaClient, users: () => readonly AuthUser[]): Promise<SwarmDriver> {
  const legacy = await legacyDriver(db, users)
  const desktopReader = (tabId: string, person: AuthUser): Reader => {
    const first = legacy.desktopReader(tabId, person)
    let cursor: number | null = null
    return { label: first.label, async poll(): Promise<Reply> {
      const started = Date.now()
      if (cursor === null) {
        const reply = await first.poll()
        if (!reply.code) cursor = started - OVERLAP_MS
        return reply
      }
      const since = new Date(cursor)
      const changed = await db.$transaction(tx => loadChanged(tx, [tabId], since))
      cursor = started - OVERLAP_MS
      const body = JSON.stringify({ success: true, data: { parts: changed.get(tabId) ?? [] } })
      return { status: 200, code: null, data: null, bytes: Buffer.byteLength(body) }
    } }
  }
  return {
    ...legacy,
    name: 'parts',
    desktopReader,
    async stateSize(tabId) {
      let bytes = 0, documents = 0
      for (const collection of PARTS) {
        const match = collection === 'SwarmGroup' ? { tabId, deleted: false, dormant: false } : { tabId, deleted: false }
        const result = await db.$runCommandRaw({ aggregate: collection, cursor: {},
          pipeline: [{ $match: match }, { $group: { _id: null, bytes: { $sum: { $bsonSize: '$$ROOT' } }, documents: { $sum: 1 } } }] }) as
          { cursor: { firstBatch: Array<{ bytes: number; documents: number }> } }
        bytes += result.cursor.firstBatch[0]?.bytes ?? 0
        documents += result.cursor.firstBatch[0]?.documents ?? 0
      }
      return { bytes, documents }
    },
  }
}
