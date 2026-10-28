import { randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import type { PrismaClient } from '@prisma/client'
import type { AuthUser } from '../src/lib/ssoAuth.js'
import { localDatabase, type LocalDatabase } from './bench/mongo.js'
import { DEFAULT_CONFIG } from './bench/config.js'
import { DRIVERS } from './bench/bench.js'
import { machineId, seedAccounts } from './bench/fixtures.js'
import { plan } from './bench/plan.js'
import { seedSwarm, AGENT_CONFIGURATION, type Swarm } from './bench/seed.js'

// The harness shares list (routes/harnessShares.ts) against a Swarm-sized database. Prod 2026-10-28: CLI daemons' list calls
// took half the backend's busy time in spike minutes (p95 13.4 s), each share loading its whole Swarm to check it. Every
// permission read here is real; Redis is replaced by "every machine is running".
const shared = vi.hoisted(() => ({ db: null as unknown as PrismaClient }))
vi.mock('../src/lib/prisma.js', async original => ({ ...await original<typeof import('../src/lib/prisma.js')>(), get prisma() { return shared.db } }))
vi.mock('../src/lib/bus.js', async original => ({ ...await original<typeof import('../src/lib/bus.js')>(),
  getAgentPresenceMany: async (ids: string[]) => new Map(ids.map(id => [id, 'running'])) }))
const { harnessShareRoutes } = await import('../src/routes/harnessShares.js')
const { SuperTabStore } = await import('../src/superTabs/store.js')

/** The Swarm the benchmark runs on, with 40 workers over 6 machines, most of them shared with the recipient. */
const CONFIG = { ...structuredClone(DEFAULT_CONFIG), groups: 200, doneShare: 0.8, workers: 40 }
const RUNS = 30, WAVE = 20

let database: LocalDatabase
let app: FastifyInstance
let swarm: Swarm
let recipient: AuthUser
/** The shares the recipient must be listed, by hand: each worker not on its own machine, and the ordinary share. */
let expected: string[]
/** Every share addressed to the recipient that the list must leave out, by why. */
let hidden: Record<string, string>

const list = async () => {
  const res = await app.inject({ method: 'GET', url: '/api/harness-shares' })
  expect(res.statusCode).toBe(200)
  return (res.json().data.machines as Array<{ machineId: string; shares: Array<{ id: string }> }>)
}
const listedIds = (machines: Awaited<ReturnType<typeof list>>) => machines.flatMap(m => m.shares.map(s => s.id)).sort()
const percentile = (values: number[], p: number) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * p))]!

interface Profiled { collection: string; plans: string[]; docsExamined: number; returned: number }
/** What Mongo did for each collection while `read` ran: plans, documents examined and rows returned. */
async function profiled(read: () => Promise<unknown>): Promise<Profiled[]> {
  const db = database.db
  await db.$runCommandRaw({ profile: 2 })
  await read()
  await db.$runCommandRaw({ profile: 0 })
  const found = await db.$runCommandRaw({ find: 'system.profile', filter: { 'command.profile': { $exists: false } }, batchSize: 10000 }) as
    unknown as { cursor: { firstBatch: Array<{ ns: string; planSummary?: string; docsExamined?: number; nreturned?: number }> } }
  await db.$runCommandRaw({ drop: 'system.profile' })
  const byCollection = new Map<string, Profiled>()
  for (const row of found.cursor.firstBatch) {
    const collection = row.ns.slice(row.ns.indexOf('.') + 1)
    if (collection.startsWith('system.') || collection.startsWith('$cmd')) continue
    const entry = byCollection.get(collection) ?? { collection, plans: [], docsExamined: 0, returned: 0 }
    if (row.planSummary && !entry.plans.includes(row.planSummary)) entry.plans.push(row.planSummary)
    entry.docsExamined += row.docsExamined ?? 0
    entry.returned += row.nreturned ?? 0
    byCollection.set(collection, entry)
  }
  return [...byCollection.values()]
}

beforeAll(async () => {
  database = await localDatabase()
  const db = shared.db = database.db
  const people = await seedAccounts(db, CONFIG.machines)
  const driver = await DRIVERS.parts!(db, () => people)
  swarm = (await seedSwarm(driver, CONFIG, plan(CONFIG), people)).swarm
  await driver.close()
  recipient = people[1]!
  const share = (id: string, data: { superTabId: string | null; owner: number; agentId: string; recipientEmail?: string; expiresAt?: Date; revokedAt?: Date }) =>
    db.harnessShare.create({ data: { id, superTabId: data.superTabId, ownerId: people[data.owner]!.sub, machineId: machineId(data.owner),
      agentId: data.agentId, recipientEmail: data.recipientEmail ?? recipient.email, autonomousEnv: 'prod', name: data.agentId,
      ownerPublicKey: 'fixture-key', expiresAt: data.expiresAt ?? new Date(Date.now() + 86_400_000), revokedAt: data.revokedAt ?? null } })
  expected = []
  for (const worker of swarm.workers) {
    if (worker.machine === 1) continue
    const id = randomUUID()
    await share(id, { superTabId: swarm.tabId, owner: worker.machine, agentId: worker.harnessId })
    expected.push(id)
  }
  const plain = randomUUID()
  await share(plain, { superTabId: null, owner: 2, agentId: 'plain-harness' })
  expected.push(plain)
  expected.sort()
  // A Swarm the recipient is not in, with one agent shared through it, and its Lead, shared outside any Swarm.
  const store = new SuperTabStore(db)
  const other = (await store.create(people[0]!, randomUUID(), 'Elsewhere')).id
  await store.execute(people[0]!, other, { operationId: randomUUID(), command: { type: 'machine.contribute', machineId: machineId(0), name: 'Bench machine 0',
    cwd: '/bench/repo', engines: ['codex'], maxAgents: 4 } })
  await store.execute(people[0]!, other, { operationId: randomUUID(), command: { type: 'agent.add', conversationId: 'lead', machineId: machineId(0),
    harnessId: 'elsewhere-worker', name: 'Elsewhere', configuration: AGENT_CONFIGURATION, lead: false } })
  await store.execute(people[0]!, other, { operationId: randomUUID(), command: { type: 'agent.add', conversationId: 'lead', machineId: machineId(0),
    harnessId: 'elsewhere-lead', name: 'Lead', configuration: AGENT_CONFIGURATION, lead: true } })
  hidden = {}
  const hide = async (why: string, data: Parameters<typeof share>[1]) => { const id = randomUUID(); hidden[id] = why; await share(id, data) }
  await hide('the Lead is a confidential session', { superTabId: swarm.tabId, owner: 0, agentId: 'bench-lead' })
  await hide('an ordinary share of a confidential session', { superTabId: null, owner: 0, agentId: 'elsewhere-lead' })
  await hide('a Swarm the recipient is not in', { superTabId: other, owner: 0, agentId: 'elsewhere-worker' })
  await hide('an agent not in the Swarm', { superTabId: swarm.tabId, owner: 2, agentId: 'gone-worker' })
  await hide('expired', { superTabId: null, owner: 3, agentId: 'expired-harness', expiresAt: new Date(Date.now() - 1000) })
  await hide('revoked', { superTabId: null, owner: 3, agentId: 'revoked-harness', revokedAt: new Date() })
  await share(randomUUID(), { superTabId: swarm.tabId, owner: 2, agentId: swarm.workers.find(w => w.machine === 2)!.harnessId, recipientEmail: 'someone-else@example.com' })
  app = Fastify()
  app.decorateRequest('user', null)
  app.addHook('onRequest', async req => { req.user = recipient })
  await app.register(harnessShareRoutes)
  await app.ready()
}, 300_000)
afterAll(async () => {
  await app?.close()
  await database?.stop()
})

describe('the harness shares list on a Swarm-sized database', () => {
  it('lists exactly the shares the recipient may open, as each share alone would answer', async () => {
    expect(listedIds(await list())).toEqual(expected)
    const store = new SuperTabStore(database.db)
    const all = await database.db.harnessShare.findMany({ where: { recipientEmail: recipient.email, revokedAt: null, expiresAt: { gt: new Date() } } })
    const alone = []
    for (const share of all) if (await store.mayOpenShare(recipient, share)) alone.push(share.id)
    expect(alone.sort()).toEqual(expected)
    for (const id of Object.keys(hidden)) expect(expected).not.toContain(id)
  })

  it('answers well under 200 ms at p95, alone and in a wave of daemons asking at once', async () => {
    await list()
    const alone: number[] = []
    for (let i = 0; i < RUNS; i++) {
      const started = performance.now()
      await list()
      alone.push(performance.now() - started)
    }
    const started = performance.now()
    await Promise.all(Array.from({ length: WAVE }, () => list()))
    const wave = performance.now() - started
    const numbers = { shares: expected.length + Object.keys(hidden).length, p50Ms: Math.round(percentile(alone, 0.5)), p95Ms: Math.round(percentile(alone, 0.95)),
      waveOf20Ms: Math.round(wave) }
    process.stdout.write(`harness shares list: ${JSON.stringify(numbers)}\n`)
    expect(numbers.p95Ms).toBeLessThan(100)
    expect(numbers.waveOf20Ms).toBeLessThan(1000)
  })

  it('reads every collection through an index, examining about as many documents as it returns', async () => {
    const reads = await profiled(list)
    process.stdout.write(`harness shares list reads: ${JSON.stringify(reads)}\n`)
    for (const read of reads) {
      expect(read.plans.filter(p => p.startsWith('COLLSCAN')), read.collection).toEqual([])
      // Prisma's `in` is planned as one index scan per value (an OR of N branches), each read planned anew: one $in scan instead.
      expect(read.plans.filter(p => p.includes('}, IXSCAN')), read.collection).toEqual([])
      expect(read.docsExamined, read.collection).toBeLessThanOrEqual(read.returned + 2)
    }
  })
})
