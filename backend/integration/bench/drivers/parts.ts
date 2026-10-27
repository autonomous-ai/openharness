import type { PrismaClient } from '@prisma/client'
import type { AuthUser } from '../../../src/lib/ssoAuth.js'
import type { Changes, FirstLoad, HostChanges, HostChangesRequest } from '../../../src/superTabs/read/contract.js'
import type { Reader, Reply, Snapshot, SwarmDriver } from '../driver.js'
import { legacyDriver, storeRoutes } from '../legacyDriver.js'

const base = '/api/super-tabs'
/** The parts' collections (backend/prisma/schema.prisma, Swarm state by parts). */
const PARTS = ['SwarmHead', 'SwarmMember', 'SwarmGroup', 'SwarmAgent', 'SwarmMachine', 'SwarmStart', 'SwarmProgress']
/** A host asks for its whole form at least this often (cli/src/superTabs/hostFeed.ts `HOST_FULL_MS`). */
const HOST_FULL_MS = 60_000

/**
 * The store by parts (#1726 groups 2 and 3), read through the new read API the way the merged clients read it. Commands,
 * machine reports, terminals and deliveries go through the same routes as `legacyDriver`; only the reads differ:
 * - setup facts come from a first load, and a machine's generation from its host form;
 * - a Desktop window loads the Swarm once, then reads the changes since its cursor (desktop/lib/super_tabs controller); a
 *   `reload` answer is followed by a first load in the same poll;
 * - a host reads its form (cli/src/superTabs/hostFeed.ts): in full at start and at least every minute, by change in
 *   between, naming the etag of the rows it holds so an unchanged Swarm comes back without them;
 * - the state's size is its live parts: every part except tombstones and dormant groups.
 */
export async function partsDriver(db: PrismaClient, users: () => readonly AuthUser[], options: { now?: () => number } = {}): Promise<SwarmDriver> {
  const now = options.now ?? Date.now
  // One app and store behind the writes and the reads, as in one backend process.
  const routes = await storeRoutes(db, users), { call } = routes
  const legacy = await legacyDriver(db, users, routes)
  const firstLoad = (tabId: string, user: AuthUser) => call<FirstLoad>(user, 'GET', `${base}/${tabId}/parts`)
  const hostForm = (host: AuthUser, machineId: string, request: HostChangesRequest) => Object.keys(request.held ?? {}).length
    ? call<HostChanges>(host, 'POST', `${base}/hosts/${machineId}/changes`, request)
    : call<HostChanges>(host, 'GET', `${base}/hosts/${machineId}/changes?${request.full ? 'full=1' : `cursor=${request.cursor}`}`)

  const desktopReader = (tabId: string, person: AuthUser): Reader => {
    let cursor: string | null = null
    const load = async (spent: number): Promise<Reply> => {
      const reply = await firstLoad(tabId, person)
      cursor = reply.data?.cursor ?? null
      return { ...reply, bytes: spent + reply.bytes }
    }
    return { label: `desktop:${person.email}`, async poll() {
      if (cursor === null) return load(0)
      const reply = await call<Changes>(person, 'GET', `${base}/${tabId}/changes?cursor=${cursor}`)
      if (reply.data?.reload) return load(reply.bytes)
      if (reply.data) cursor = reply.data.cursor
      return reply
    } }
  }

  const hostReader = (host: AuthUser, machineId: string): Reader => {
    let cursor: string | null = null, fullAt = -Infinity
    let held: Record<string, string> = {}
    return { label: `host:${machineId}`, async poll() {
      const full = cursor === null || now() - fullAt >= HOST_FULL_MS, startedAt = now()
      const reply = await hostForm(host, machineId, full ? { full: true, held } : { cursor: cursor!, held })
      const answer = reply.data
      if (!answer) return reply
      // As the CLI keeps them: a full answer replaces every Swarm; one it answers unchanged keeps the etag it already had.
      const next: Record<string, string> = answer.full ? {} : { ...held }
      for (const tabId of answer.removedTabIds) delete next[tabId]
      for (const tab of answer.tabs) {
        if (!tab.unchanged || held[tab.tabId]) next[tab.tabId] = tab.etag
        else delete next[tab.tabId]
      }
      held = next
      cursor = answer.cursor
      if (answer.full) fullAt = startedAt
      return reply
    } }
  }

  return {
    ...legacy,
    name: 'parts',
    async snapshot(tabId, user) {
      const reply = await firstLoad(tabId, user)
      if (!reply.data) throw new Error(`First load failed: ${reply.code}`)
      return { conversations: reply.data.groups.map(g => g.data), agents: reply.data.agents.map(a => a.data) } satisfies Snapshot
    },
    async machineGeneration(tabId, host, machineId) {
      const reply = await hostForm(host, machineId, { full: true })
      const tab = reply.data?.tabs.find(t => t.tabId === tabId)
      if (!tab || tab.unchanged || !tab.pool) throw new Error(`No contribution of ${machineId}: ${reply.code}`)
      return tab.pool.machine.generation
    },
    desktopReader,
    hostReader,
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
