import type { PrismaClient } from '@prisma/client'
import type { AuthUser } from '../../src/lib/ssoAuth.js'
import { superTabRoutes } from '../../src/routes/superTabs.js'
import { SuperTabStore } from '../../src/superTabs/store.js'
import type { CommandResult, Reader, Snapshot, SwarmDriver } from './driver.js'
import { benchApp, caller, type Call } from './http.js'

const base = '/api/super-tabs'

/** Today's store: one `SuperTab` document per Swarm, read in full by every poll (store.ts, routes/superTabs.ts). */
export async function legacyDriver(db: PrismaClient, users: () => readonly AuthUser[]): Promise<SwarmDriver> {
  const store = new SuperTabStore(db)
  // No GitHub App: the bench never reaches GitHub.
  const app = await benchApp(users, async scope => superTabRoutes(scope, { store, github: null }))
  const call: Call = caller(app)
  const reader = (label: string, user: AuthUser, url: string): Reader => ({ label, poll: () => call(user, 'GET', url) })
  return {
    name: 'legacy',
    close: () => app.close(),
    createSwarm: (owner, operationId, name) => call(owner, 'POST', base, { operationId, name }),
    execute: (tabId, user, operationId, command, asAgentId) =>
      call<CommandResult>(user, 'POST', `${base}/${tabId}/commands`, { operationId, command, ...(asAgentId ? { asAgentId } : {}) }),
    async snapshot(tabId, user) {
      const reply = await call<{ state: Snapshot }>(user, 'GET', `${base}/${tabId}`)
      if (!reply.data) throw new Error(`Snapshot failed: ${reply.code}`)
      return reply.data.state
    },
    async machineGeneration(tabId, host, machineId) {
      const reply = await call<Array<{ tabId: string; machine: { generation: string } }>>(host, 'GET', `${base}/hosts/${machineId}/pools`)
      const row = reply.data?.find(r => r.tabId === tabId)
      if (!row) throw new Error(`No contribution of ${machineId}: ${reply.code}`)
      return row.machine.generation
    },
    observeMachine: (tabId, host, machineId, observation) => call(host, 'POST', `${base}/${tabId}/machines/${machineId}`, observation),
    openNative: (tabId, opener, input) => call(opener, 'POST', `${base}/${tabId}/native`, input),
    appendNative: (tabId, host, contextId, event) => call(host, 'POST', `${base}/${tabId}/native/${contextId}`, event),
    deliveries: (tabId, host, agentId) => call(host, 'GET', `${base}/${tabId}/agents/${agentId}/deliveries`),
    delivery: (tabId, host, agentId, deliveryId, action) => call(host, 'POST', `${base}/${tabId}/agents/${agentId}/deliveries/${deliveryId}`, action),
    desktopReader: (tabId, person) => reader(`desktop:${person.email}`, person, `${base}/${tabId}`),
    hostReader: (host, machineId) => reader(`host:${machineId}`, host, `${base}/hosts/${machineId}`),
    async stateSize(tabId) {
      const result = await db.$runCommandRaw({ aggregate: 'SuperTab', cursor: {},
        pipeline: [{ $match: { _id: tabId } }, { $project: { size: { $bsonSize: '$$ROOT' } } }] }) as { cursor: { firstBatch: Array<{ size: number }> } }
      const rows = result.cursor.firstBatch
      return { bytes: rows.reduce((sum, r) => sum + r.size, 0), documents: rows.length }
    },
  }
}
