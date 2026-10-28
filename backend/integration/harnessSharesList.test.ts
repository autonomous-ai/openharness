import { randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import type { PrismaClient } from '@prisma/client'
import type { AuthUser } from '../src/lib/ssoAuth.js'
import type { Command } from '../src/superTabs/commands.js'
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
/** Who the next list call is made as. */
let viewer: AuthUser
/** The shares the recipient must be listed, by hand: each worker not on its own machine, the Swarm's Lead, and the ordinary share. */
let expected: string[]
/** Every share addressed to the recipient that the list must leave out, by why. */
let hidden: Record<string, string>

const list = async (as: AuthUser = recipient) => {
  viewer = as
  const res = await app.inject({ method: 'GET', url: '/api/harness-shares' })
  expect(res.statusCode).toBe(200)
  return (res.json().data.machines as Array<{ machineId: string; shares: Array<{ id: string }> }>)
}
const listedIds = (machines: Awaited<ReturnType<typeof list>>) => machines.flatMap(m => m.shares.map(s => s.id)).sort()
const percentile = (values: number[], p: number) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * p))]!

interface Profiled { collection: string; plans: string[]; keysExamined: number; docsExamined: number; returned: number }
/** What Mongo did for each collection while `read` ran: plans, documents examined and rows returned. */
async function profiled(read: () => Promise<unknown>): Promise<Profiled[]> {
  const db = database.db
  await db.$runCommandRaw({ profile: 2 })
  await read()
  await db.$runCommandRaw({ profile: 0 })
  const found = await db.$runCommandRaw({ find: 'system.profile', filter: { 'command.profile': { $exists: false } }, batchSize: 10000 }) as
    unknown as { cursor: { firstBatch: Array<{ ns: string; planSummary?: string; keysExamined?: number; docsExamined?: number; nreturned?: number }> } }
  await db.$runCommandRaw({ drop: 'system.profile' })
  const byCollection = new Map<string, Profiled>()
  for (const row of found.cursor.firstBatch) {
    const collection = row.ns.slice(row.ns.indexOf('.') + 1)
    if (collection.startsWith('system.') || collection.startsWith('$cmd')) continue
    const entry = byCollection.get(collection) ?? { collection, plans: [], keysExamined: 0, docsExamined: 0, returned: 0 }
    if (row.planSummary && !entry.plans.includes(row.planSummary)) entry.plans.push(row.planSummary)
    entry.keysExamined += row.keysExamined ?? 0
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
  // The Swarm's current Lead is open to its readers (projects.ts watchClosed); confidential, it is closed everywhere else.
  const lead = randomUUID()
  await share(lead, { superTabId: swarm.tabId, owner: 0, agentId: 'bench-lead' })
  expected.push(lead)
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
  // Agents of 200 other Swarms, as production holds them: a read of these agents' keys must not walk theirs.
  const { id: _row, ...template } = await db.swarmAgent.findFirstOrThrow({ where: { tabId: swarm.tabId } })
  await db.swarmAgent.createMany({ data: Array.from({ length: 200 }, (_, i) => ({ ...template, id: `crowd-${i}`, tabId: `crowd-tab-${i}`,
    key: `crowd-agent-${i}`, data: template.data as object })) })
  hidden = {}
  const hide = async (why: string, data: Parameters<typeof share>[1]) => { const id = randomUUID(); hidden[id] = why; await share(id, data) }
  await hide('an ordinary share of a confidential session', { superTabId: null, owner: 0, agentId: 'elsewhere-lead' })
  await hide('a Swarm the recipient is not in', { superTabId: other, owner: 0, agentId: 'elsewhere-worker' })
  await hide('an agent not in the Swarm', { superTabId: swarm.tabId, owner: 2, agentId: 'gone-worker' })
  await hide('expired', { superTabId: null, owner: 3, agentId: 'expired-harness', expiresAt: new Date(Date.now() - 1000) })
  await hide('revoked', { superTabId: null, owner: 3, agentId: 'revoked-harness', revokedAt: new Date() })
  await share(randomUUID(), { superTabId: swarm.tabId, owner: 2, agentId: swarm.workers.find(w => w.machine === 2)!.harnessId, recipientEmail: 'someone-else@example.com' })
  app = Fastify()
  app.decorateRequest('user', null)
  app.addHook('onRequest', async req => { req.user = viewer })
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
      // Keys too: an agent read by key that walks the (tabId, key) index costs every other Swarm in production.
      expect(read.keysExamined, read.collection).toBeLessThanOrEqual(read.returned + 10)
    }
  })
})

/**
 * The list against each share asked alone (mayOpenShare), and against what each person must see by hand, as people and
 * permissions change under a warm read cache (review of #1973): a Lead and its private conversation, a session confidential
 * here or in another Swarm, a private project, a Lead's replacement, a removed member, and a machine grant taken back. Two members ask in turn, each after the other's change.
 */
describe('the harness shares list as permissions change', () => {
  const fixture = (n: number): AuthUser => ({ sub: (0x200000000000000000000001n + BigInt(n)).toString(16).padStart(24, '0'),
    email: `perm-${n}@example.com`, autonomousEnv: 'prod', role: 'user' })
  /** The Swarm's owner, who adds every agent; the host whose machine is shared with the owner; and two members. */
  const owner = fixture(0), host = fixture(1), a = fixture(2), b = fixture(3)
  let store: InstanceType<typeof SuperTabStore>
  let cases = 0

  beforeAll(async () => {
    const db = database.db
    store = new SuperTabStore(db)
    for (const user of [owner, host, a, b]) await db.user.create({ data: { id: user.sub, externalId: `perm-${user.sub}`, email: user.email, autonomousEnv: 'prod' } })
    for (const [machine, user] of [['grant-host', host], ['own-host', owner]] as const) {
      await db.machine.create({ data: { machineId: machine, userId: user.sub, apiKey: 'fixture-only', managerId: 'fixture', autonomousEnv: 'prod', authMode: 'remote' } })
    }
  })

  /** A Swarm of the owner with both members, and three Builders shared with each member: X and Y on the host's machine
   *  (the owner's through its grant), Z on the owner's own machine. */
  async function swarmWithShares() {
    const db = database.db, n = ++cases
    await db.machineShare.upsert({ where: { machineId: 'grant-host' }, create: { machineId: 'grant-host', ownerId: host.sub, autonomousEnv: 'prod', emails: [owner.email] },
      update: { emails: [owner.email] } })
    const tab = (await store.create(owner, randomUUID(), `Permissions ${n}`)).id
    const run = (command: Command, as = owner) => store.execute(as, tab, { operationId: randomUUID(), command })
    for (const person of [a, b]) {
      const invitation = await run({ type: 'invite.create', email: person.email, role: 'collaborator', conversationId: 'lead' })
      await run({ type: 'invite.accept', inviteId: invitation.result.inviteId as string }, person)
    }
    const agents: Record<string, string> = {}
    const shares: Record<string, { name: string; to: AuthUser }> = {}
    /** Adds agent `name` to `conversationId` on the host's machine through the owner's grant, and shares it with both members. */
    const shared = async (name: string, conversationId = 'lead', lead = false, [machine, machineOwner] = ['grant-host', host] as const,
      claimedOwner: AuthUser = machineOwner) => {
      const harnessId = `perm-${n}-${name}`
      agents[name] = (await run({ type: 'agent.add', conversationId, machineId: machine, harnessId, name: `Builder ${name}`,
        configuration: AGENT_CONFIGURATION, lead })).result.agentId as string
      for (const to of [a, b]) {
        const id = randomUUID()
        shares[id] = { name, to }
        await db.harnessShare.create({ data: { id, superTabId: tab, ownerId: claimedOwner.sub, machineId: machine, agentId: harnessId,
          recipientEmail: to.email, autonomousEnv: 'prod', name, ownerPublicKey: 'fixture-key', expiresAt: new Date(Date.now() + 86_400_000), revokedAt: null } })
      }
    }
    await shared('X')
    await shared('Y')
    await shared('Z', 'lead', false, ['own-host', owner])
    /** What `as` is listed of this Swarm, by agent name; first checked against each share asked alone. */
    const sees = async (as: AuthUser) => {
      const listed = new Set(listedIds(await list(as)))
      const mine = Object.keys(shares).filter(id => shares[id]!.to === as)
      const rows = await db.harnessShare.findMany({ where: { id: { in: mine } } })
      const alone = new Set<string>()
      for (const share of rows) if (await store.mayOpenShare(as, share)) alone.add(share.id)
      expect(mine.filter(id => listed.has(id)).sort(), `${as.email}: the list and each share alone`).toEqual([...alone].sort())
      // The store's answer too, before the route's own machine filter could hide a share it let through.
      expect((await store.openableShares(as, rows)).map(share => share.id).sort(), `${as.email}: the store's batch and each share alone`).toEqual([...alone].sort())
      return mine.filter(id => listed.has(id)).map(id => shares[id]!.name).sort().join('')
    }
    return { tab, run, agents, sees, shared }
  }

  /** Marks agent `agentId` of this Swarm confidential in another Swarm too, as a registration there would have left it. */
  async function confidentialElsewhere(tab: string, agentId: string) {
    const { id, ...row } = await database.db.swarmAgent.findFirstOrThrow({ where: { tabId: tab, key: agentId } })
    await database.db.swarmAgent.create({ data: { ...row, id: `elsewhere-${id}`, tabId: `elsewhere-${tab}`, data: { ...row.data as object, confidential: true } } })
  }

  it('keeps the Swarm\'s current Lead open to its readers, in a private conversation too, and closes it once confidential elsewhere', async () => {
    const { tab, run, agents, sees } = await swarmWithShares()
    expect([await sees(a), await sees(b)]).toEqual(['XYZ', 'XYZ'])
    await run({ type: 'conversation.agent', conversationId: 'lead', agentId: agents.X!, present: true, lead: true })
    expect([await sees(b), await sees(a)]).toEqual(['XYZ', 'XYZ'])
    const chat = (await run({ type: 'conversation.create', title: 'Private', brief: 'Owner and A only.', checks: [], audience: { personIds: [owner.sub, a.sub] } }))
      .result.conversationId as string
    await run({ type: 'conversation.agent', conversationId: chat, agentId: agents.X!, present: true, lead: false })
    expect([await sees(a), await sees(b)]).toEqual(['XYZ', 'XYZ'])
    await confidentialElsewhere(tab, agents.X!)
    expect([await sees(b), await sees(a)]).toEqual(['YZ', 'YZ'])
  })

  it('closes a session confidential in another Swarm, though it is an ordinary Builder here', async () => {
    const { tab, agents, sees } = await swarmWithShares()
    expect([await sees(a), await sees(b)]).toEqual(['XYZ', 'XYZ'])
    await confidentialElsewhere(tab, agents.Z!)
    expect([await sees(b), await sees(a)]).toEqual(['XY', 'XY'])
  })

  it('closes a session marked confidential that no longer leads here', async () => {
    const { tab, agents, sees } = await swarmWithShares()
    // Written before any list of this Swarm, so no read holds the agent as it was: a mark a Lead or private member leaves.
    const part = await database.db.swarmAgent.findFirstOrThrow({ where: { tabId: tab, key: agents.Y! } })
    await database.db.swarmAgent.update({ where: { id: part.id }, data: { data: { ...part.data as object, confidential: true } } })
    expect([await sees(a), await sees(b)]).toEqual(['XZ', 'XZ'])
  })

  it('shows a project\'s Lead to the Swarm\'s readers, and the next project\'s Lead once the first project is deleted', async () => {
    // A Lead leaves only with its project (commands.ts protectLead): replacing one is a new project with a new Lead.
    const { run, sees, shared } = await swarmWithShares()
    const first = (await run({ type: 'project.create', name: 'First', visibility: 'public', brief: '' })).result as { projectId: string; conversationId: string }
    await shared('L', first.conversationId, true)
    expect([await sees(a), await sees(b)]).toEqual(['LXYZ', 'LXYZ'])
    await run({ type: 'project.delete', projectId: first.projectId })
    expect([await sees(b), await sees(a)]).toEqual(['XYZ', 'XYZ'])
    const next = (await run({ type: 'project.create', name: 'Next', visibility: 'public', brief: '' })).result as { projectId: string; conversationId: string }
    await shared('M', next.conversationId, true)
    await shared('W', next.conversationId)
    expect([await sees(a), await sees(b)]).toEqual(['MWXYZ', 'MWXYZ'])
  })

  it('shows a private project only to its members, and again to everyone once it is shared', async () => {
    const { run, sees } = await swarmWithShares()
    expect([await sees(b), await sees(a)]).toEqual(['XYZ', 'XYZ'])
    await run({ type: 'project.sharing', projectId: 'lead', visibility: 'private', memberIds: [owner.sub, a.sub] })
    expect([await sees(b), await sees(a)]).toEqual(['', 'XYZ'])
    await run({ type: 'project.sharing', projectId: 'lead', visibility: 'public', memberIds: [] })
    expect([await sees(a), await sees(b)]).toEqual(['XYZ', 'XYZ'])
  })

  it('lists nothing of the Swarm to a removed member, and the same to the member who stays', async () => {
    const { run, sees } = await swarmWithShares()
    expect([await sees(a), await sees(b)]).toEqual(['XYZ', 'XYZ'])
    await run({ type: 'member.remove', userId: b.sub })
    expect([await sees(b), await sees(a)]).toEqual(['', 'XYZ'])
  })

  it('hides the agents a machine grant ran once the host takes it back, and only those', async () => {
    const { sees } = await swarmWithShares()
    expect([await sees(a), await sees(b)]).toEqual(['XYZ', 'XYZ'])
    await database.db.machineShare.update({ where: { machineId: 'grant-host' }, data: { emails: [] } })
    expect([await sees(b), await sees(a)]).toEqual(['Z', 'Z'])
    await database.db.machineShare.update({ where: { machineId: 'grant-host' }, data: { emails: [owner.email] } })
    expect([await sees(a), await sees(b)]).toEqual(['XYZ', 'XYZ'])
  })

  it('hides the Swarm from a member taken out of its Workspace, and only from them', async () => {
    const { tab, sees } = await swarmWithShares()
    expect([await sees(a), await sees(b)]).toEqual(['XYZ', 'XYZ'])
    const { workspaceId } = await database.db.superTab.findUniqueOrThrow({ where: { id: tab }, select: { workspaceId: true } })
    await database.db.swarmWorkspaceMember.update({ where: { id: `${workspaceId}:${b.sub}` }, data: { removedAt: new Date(), removedBy: owner.sub } })
    expect([await sees(b), await sees(a)]).toEqual(['', 'XYZ'])
  })

  it('hides an agent its contributor must share again, as when they left and came back', async () => {
    const { tab, agents, sees } = await swarmWithShares()
    // Written before any list of this Swarm, so no read holds the agent as it was.
    const part = await database.db.swarmAgent.findFirstOrThrow({ where: { tabId: tab, key: agents.X! } })
    await database.db.swarmAgent.update({ where: { id: part.id }, data: { data: { ...part.data as object, membershipGeneration: 'an-earlier-membership' } } })
    expect([await sees(a), await sees(b)]).toEqual(['YZ', 'YZ'])
  })

  it('hides a share whose owner is not the machine\'s owner, though it names a session of the Swarm', async () => {
    const { shared, sees } = await swarmWithShares()
    await shared('V', 'lead', false, ['grant-host', host], owner)
    expect([await sees(a), await sees(b)]).toEqual(['XYZ', 'XYZ'])
  })
})
