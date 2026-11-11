import type { PrismaClient } from '@prisma/client'
import type { AuthUser } from '../../../src/lib/ssoAuth.js'
import { superTabRoutes } from '../../../src/routes/superTabs.js'
import { SuperTabStore } from '../../../src/superTabs/store.js'
import type { Changes, FirstLoad, HostChanges, HostChangesRequest } from '../../../src/superTabs/read/contract.js'
import type { CommandResult, Reader, Reply, SwarmDriver } from '../driver.js'
import { benchApp, caller, type Call } from '../http.js'

const base = '/api/super-tabs'
/** The parts' collections (backend/prisma/schema.prisma, Swarm state by parts). */
const PARTS = ['SwarmHead', 'SwarmMember', 'SwarmGroup', 'SwarmAgent', 'SwarmMachine', 'SwarmStart']
/** A host asks for its whole form at least this often (cli/src/superTabs/hostFeed.ts `HOST_FULL_MS`). */
const HOST_FULL_MS = 60_000

/** The Super Tab routes on one store, in process. Callers that share them share the store and its in-process state. */
export interface StoreRoutes { call: Call; close(): Promise<void> }

export async function storeRoutes(db: PrismaClient, users: () => readonly AuthUser[]): Promise<StoreRoutes> {
  const store = new SuperTabStore(db)
  // No GitHub App: the bench never reaches GitHub.
  const app = await benchApp(users, async scope => superTabRoutes(scope, { store, github: null }))
  return { call: caller(app), close: () => app.close() }
}

/**
 * The Swarm's clients, through the routes they call:
 * - commands, machine reports and deliveries as the CLI and Desktop send them;
 * - a Desktop window loads the Swarm once, then reads the changes since its cursor (desktop/lib/super_tabs controller); a
 *   `reload` answer is followed by a first load in the same poll;
 * - a host reads its form (cli/src/superTabs/hostFeed.ts): in full at start and at least every minute, by change in
 *   between, naming the etag of the rows it holds so an unchanged Swarm comes back without them;
 * - the state's size is its live parts: every part except tombstones and dormant groups.
 */
export async function partsDriver(db: PrismaClient, users: () => readonly AuthUser[], options: { now?: () => number } = {}): Promise<SwarmDriver> {
  const now = options.now ?? Date.now
  // One app and store behind the writes and the reads, as in one backend process.
  const { call, close } = await storeRoutes(db, users)
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
    close,
    createSwarm: (owner, operationId, name) => call(owner, 'POST', base, { operationId, name }),
    execute: (tabId, user, operationId, command, asAgentId) =>
      call<CommandResult>(user, 'POST', `${base}/${tabId}/commands`, { operationId, command, ...(asAgentId ? { asAgentId } : {}) }),
    async agentChats(tabId, person) {
      const reply = await firstLoad(tabId, person)
      if (!reply.data) throw new Error(`First load failed: ${reply.code}`)
      return new Map(reply.data.groups.flatMap(g => g.data.kind === 'agent-chat' ? g.data.agentIds.map(id => [id, g.data.id] as const) : []))
    },
    async machineGeneration(tabId, host, machineId) {
      const reply = await hostForm(host, machineId, { full: true })
      const tab = reply.data?.tabs.find(t => t.tabId === tabId)
      if (!tab || tab.unchanged || !tab.pool) throw new Error(`No contribution of ${machineId}: ${reply.code}`)
      return tab.pool.machine.generation
    },
    observeMachine: (tabId, host, machineId, observation) => call(host, 'POST', `${base}/${tabId}/machines/${machineId}`, observation),
    deliveries: (tabId, host, agentId) => call(host, 'GET', `${base}/${tabId}/agents/${agentId}/deliveries`),
    delivery: (tabId, host, agentId, deliveryId, action) => call(host, 'POST', `${base}/${tabId}/agents/${agentId}/deliveries/${deliveryId}`, action),
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
