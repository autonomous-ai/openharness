import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { performance } from 'node:perf_hooks'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MongoMemoryReplSet } from 'mongodb-memory-server-core'
import { PrismaClient } from '@prisma/client'
import Fastify, { type FastifyInstance } from 'fastify'
import type { AuthUser } from '../src/lib/ssoAuth.js'
import { SuperTabStore } from '../src/superTabs/store.js'
import { superTabRoutes } from '../src/routes/superTabs.js'
import { errorHandler } from '../src/middlewares/errorHandler.js'
import * as parts from '../src/superTabs/parts/index.js'
import { configureSwarmStamps, swarmTransaction, SwarmCache } from '../src/superTabs/cache.js'
import { MemoryStamps } from '../src/superTabs/cache.test-support.js'
import { readDelta } from '../src/superTabs/cachedReads.js'
import { guardedWrite } from '../src/superTabs/parts/write.js'
import { migrateSwarm } from '../src/superTabs/migration/migrate.js'
import { SwarmReads } from '../src/superTabs/read/service.js'
import { HostReads } from '../src/superTabs/read/host.js'
import type { Conversation, SuperTabState } from '../src/superTabs/model.js'
import { buddyChatId } from '../src/superTabs/buddies.js'
import { storeOldLeads } from '../src/superTabs/leads.test-support.js'
import { writeLegacySwarm } from '../scripts/swarm-parts/legacy.js'
import { NOW, outsider as outsiderActor, owner as ownerActor, peer as peerActor, swarm } from '../src/superTabs/read/fixture.test-support.js'
import { PROFILE_STAGES, profileEntry, type ProfileEntry } from './bench/profile.js'

// GET /api/super-tabs/:tabId/groups/:conversationId (task #2875). Ken's report of 11-04 17:13 VN: ~1,500 of these in two minutes
// each read the Swarm's change feeds (SwarmGroup and SwarmProgress by changedAt, SwarmMachine by readAt), 1.33 GB in all.
// The read cache patches from deltas here, as in production (server.ts, SWARM_CACHE_DELTA=on). A fresh loopback replica set,
// created here; this suite never reads DATABASE_URL or an existing database.
let replica: MongoMemoryReplSet
let db: PrismaClient
let app: FastifyInstance
/** Backend processes, each with its own read cache: production runs five at least. */
const PODS = 5
let pods: FastifyInstance[]
let stamps: MemoryStamps
const user = (actor: { userId: string; email: string }): AuthUser => ({ sub: actor.userId, email: actor.email, autonomousEnv: 'prod', role: 'user' })
const [owner, peer, outsider] = [ownerActor, peerActor, outsiderActor].map(user) as [AuthUser, AuthUser, AuthUser]
const MIGRATED = NOW - 60_000
/** The Swarm's quiet conversations the burst reads, and its agents that read them. */
const QUIET = 100
const AGENTS = 10

beforeAll(async () => {
  replica = await MongoMemoryReplSet.create({ binary: { version: '7.0.24', downloadDir: join(tmpdir(), 'harness-super-tab-mongodb-binaries') },
    replSet: { count: 1, ip: '127.0.0.1', storageEngine: 'wiredTiger' } })
  const uri = replica.getUri(`swarm_one_group_test_${randomUUID().replaceAll('-', '_')}`)
  await promisify(execFile)(join(process.cwd(), 'node_modules/.bin/prisma'), ['db', 'push', '--skip-generate'], {
    env: { ...process.env, DATABASE_URL: uri }, timeout: 60000,
  })
  db = new PrismaClient({ datasources: { db: { url: uri } } })
  for (const each of [owner, peer, outsider]) await db.user.create({ data: { id: each.sub, externalId: `fixture-${each.sub}`, email: each.email, autonomousEnv: 'prod' } })
  // The owner's own machine runs the Swarm's agents, so reading as one of them needs no machine share.
  await db.machine.create({ data: { machineId: 'host', userId: owner.sub, apiKey: 'fixture-only', managerId: 'fixture', autonomousEnv: 'prod', authMode: 'remote' } })
  await db.machine.create({ data: { machineId: 'peer-mac', userId: peer.sub, apiKey: 'fixture-only-peer', managerId: 'fixture', autonomousEnv: 'prod', authMode: 'remote' } })
  stamps = new MemoryStamps()
  configureSwarmStamps(stamps, { reads: false })
  pods = await Promise.all(Array.from({ length: PODS }, () => pod()))
  app = pods[0]!
})
/** One backend process: its own read cache over the shared stamps, as each production pod has. */
async function pod(): Promise<FastifyInstance> {
  const store = new SuperTabStore(db, Date.now, null, { readCache: new SwarmCache(stamps, { delta: readDelta(db) }) })
  const server = Fastify()
  server.setErrorHandler(errorHandler)
  // External SSO is replaced with fixture accounts; every permission and transaction below is real.
  server.addHook('onRequest', async (request, reply) => {
    const found = [owner, peer, outsider].find(u => `Bearer ${u.sub}` === request.headers.authorization)
    if (!found) return reply.code(401).send({ success: false })
    request.user = found
  })
  await server.register(superTabRoutes, { store, github: null, reads: new SwarmReads(store), hosts: new HostReads(store) })
  await server.ready()
  return server
}

afterAll(async () => {
  configureSwarmStamps(null)
  for (const each of pods ?? []) await each.close()
  await db?.$disconnect()
  await replica?.stop()
})

/** A busy Swarm in parts: a Lead and AGENTS workers on the owner's machine in "Web", QUIET archived conversations, a private
 *  project, and the owner's machine contributed. */
async function scene() {
  const s = swarm(MIGRATED)
  s.join(peerActor)
  s.join(outsiderActor)
  s.contribute('host')
  const lead = s.add('lead-harness', 'lead', true, ownerActor, 'host', owner.sub)
  const web = s.group('Web')
  const agents = Array.from({ length: AGENTS }, (_, i) => s.add(`worker-${i}`, web, false, ownerActor, 'host', owner.sub))
  const quiet = Array.from({ length: QUIET }, (_, i) => {
    const id = s.group(`Old task ${i}`)
    s.run({ type: 'conversation.archive', conversationId: id, archived: true })
    return id
  })
  const busy = Array.from({ length: 20 }, (_, i) => s.group(`Busy ${i}`))
  // Briefs about a task's size, so the change feeds carry what a busy Swarm's do.
  s.edit(state => { for (const c of state.conversations) c.brief = `${c.title}: ${'what to build and why. '.repeat(80)}` })
  const tabId = `tab-${randomUUID()}`
  await writeLegacySwarm(db, { state: { ...structuredClone(s.state), id: tabId } as SuperTabState, revision: 700 })
  const report = await migrateSwarm(db, tabId, { now: () => MIGRATED })
  if (!report.ok) throw new Error(report.error)
  return { tabId, lead, web, agents, quiet, busy }
}

/** A command's write of one group, committed as the store commits one: it moves the Swarm's stamp. */
async function touch(tabId: string, key: string) {
  await swarmTransaction(db, async tx => {
    const current = (await parts.loadActive(tx, tabId, { groupIds: [key] })).groups.find(g => g.key === key)!
    const data = structuredClone(current.data!) as Conversation
    data.brief = `${data.brief} .`
    await guardedWrite(tx, tabId, { op: 'update', kind: 'group', key, seen: current.version, data }, Date.now())
  })
}

/** A machine's part rewritten, as a reading or a setting changes it: the machine feed moves too. */
async function touchMachine(tabId: string, machineId: string) {
  await swarmTransaction(db, async tx => {
    const current = (await parts.loadActive(tx, tabId)).machines.find(m => m.key === machineId)!
    const data = structuredClone(current.data!)
    data.contribution!.name = `${machineId} ${Date.now()}`
    await guardedWrite(tx, tabId, { op: 'update', kind: 'machine', key: machineId, seen: current.version, data }, Date.now())
  })
}

const read = async (tabId: string, id: string, asAgentId?: string, as: AuthUser = owner, on: FastifyInstance = app) => {
  const response = await on.inject({ method: 'GET', url: `/api/super-tabs/${tabId}/groups/${id}${asAgentId ? `?asAgentId=${asAgentId}` : ''}`,
    headers: { authorization: `Bearer ${as.sub}` } })
  return { status: response.statusCode, body: response.json() as { data: any; error?: { code: string } } }
}

/** What `run` asked of the database, every operation, under the profiler. */
async function profiled<T>(run: () => Promise<T>): Promise<{ value: T; rows: ProfileEntry[] }> {
  await db.$runCommandRaw({ profile: 0 })
  await db.$runCommandRaw({ drop: 'system.profile' }).catch(() => {})
  await db.$runCommandRaw({ create: 'system.profile', capped: true, size: 256 * 1024 * 1024 })
  await db.$runCommandRaw({ profile: 2, slowms: 0 })
  let value: T
  try { value = await run() } finally { await db.$runCommandRaw({ profile: 0 }) }
  const rows: ProfileEntry[] = []
  for (;;) {
    const page = (await db.$runCommandRaw({ aggregate: 'system.profile', pipeline: [{ $match: { ns: { $not: { $regex: 'system\\.' } } } },
      { $skip: rows.length }, { $limit: 5000 }, ...PROFILE_STAGES], cursor: { batchSize: 5000 } }) as unknown as { cursor: { firstBatch: ProfileEntry[] } })
      .cursor.firstBatch.map(profileEntry)
    rows.push(...page)
    if (page.length < 5000) break
  }
  return { value, rows }
}

/** The Swarm's change feeds the incident named: a read of groups or progress by changedAt, or of machines by readAt. */
const FEEDS = /\.(SwarmGroup|SwarmProgress|SwarmMachine)$/
function feedReads(rows: ProfileEntry[]): ProfileEntry[] {
  return rows.filter(r => FEEDS.test(r.ns) && r.op !== 'getmore' && (() => {
    const match = JSON.stringify((r.command?.pipeline as Array<{ $match?: unknown }> | undefined)?.[0]?.$match ?? r.command?.filter ?? {})
    return /"(changedAt|readAt)":\{"\$gt"/.test(match)
  })())
}
const bytes = (rows: ProfileEntry[]) => rows.reduce((n, r) => n + (r.responseLength ?? 0), 0)
const dbMs = (rows: ProfileEntry[]) => rows.reduce((n, r) => n + r.millis, 0)
/** Reads and bytes per collection and operation kind, largest first. */
function byCollection(rows: ProfileEntry[]): string {
  const sums = new Map<string, { reads: number; bytes: number }>()
  for (const r of rows) {
    if (r.op === 'getmore') continue
    const name = `${r.ns.split('.').at(-1)} ${(r.planSummary ?? r.op).split(' {')[0]} ${(r.planSummary ?? '').match(/\{[^}]*\}/)?.[0] ?? ''}`
    const sum = sums.get(name) ?? { reads: 0, bytes: 0 }
    sums.set(name, { reads: sum.reads + 1, bytes: sum.bytes + (r.responseLength ?? 0) })
  }
  return [...sums].sort((a, b) => b[1].bytes - a[1].bytes).map(([name, sum]) => `  ${name}: ${sum.reads} reads, ${sum.bytes} bytes`).join('\n')
}
const describeRows = (rows: ProfileEntry[]) => rows.filter(r => r.op !== 'getmore').map(r =>
  `  ${r.ns.split('.').at(-1)} ${r.op} ${(r.planSummary ?? '').slice(0, 60)} docs=${r.docsExamined ?? 0} returned=${r.nreturned ?? 0} bytes=${r.responseLength ?? 0}`).join('\n')

/** Every kind of group and reader a read check tells apart: two projects (one private to the owner, one shared with peer), a
 *  Lead and workers, one stored with no project (28 of 143 agents on prod, 11-04), a Buddy of peer's, a quiet task with
 *  required machines, a closed Chat with PM, peer's Buddy chat, the removed Leads conversation and quiet work. */
async function everyKind() {
  const s = swarm(MIGRATED)
  s.join(peerActor)
  s.join(outsiderActor)
  s.contribute('host')
  const lead = s.add('lead-harness', 'lead', true, ownerActor, 'host', owner.sub)
  const secret = s.run({ type: 'project.create', name: 'Secret', visibility: 'private', brief: '' }).projectId as string
  const shared = s.run({ type: 'project.create', name: 'Shared', visibility: 'private', brief: '' }).projectId as string
  s.run({ type: 'project.sharing', projectId: shared, visibility: 'private', memberIds: [peer.sub] })
  const web = s.group('Web')
  const worker = s.add('worker-harness', web, false, ownerActor, 'host', owner.sub)
  s.run({ type: 'work.assign', conversationId: web, agentId: worker })
  const secretGroup = s.group('Secret work', secret)
  const secretWorker = s.add('secret-harness', secretGroup, false, ownerActor, 'host', owner.sub)
  const sharedGroup = s.group('Shared work', shared)
  const sharedLead = s.add('shared-lead-harness', sharedGroup, false, ownerActor, 'host', owner.sub)
  const old = s.group('Old work')
  const unprojected = s.add('old-harness', old, false, ownerActor, 'host', owner.sub)
  const done = s.group('Done work')
  const needs = s.group('Needs a machine')
  const privateId = s.group('Peer and PM')
  const quietSecret = s.group('Quiet secret', secret)
  const legacy = s.group('Legacy work')
  const quietLegacy = s.group('Quiet legacy work')
  for (const id of [done, needs, quietSecret, quietLegacy]) s.run({ type: 'conversation.archive', conversationId: id, archived: true })
  let buddyChat = ''
  const buddy = 'peer-buddy'
  s.edit(state => {
    const generation = state.people.find(p => p.id === peer.sub)!.generation
    state.conversations.find(c => c.id === privateId)!.audience = { people: [{ id: peer.sub, generation }] }
    // An agent stored before agents named their project: its project is its first conversation's (projects.ts agentProjectId).
    delete (state.agents.find(a => a.id === unprojected) as { projectId?: string }).projectId
    // The shared project's Lead is this agent (projects.ts ledProject).
    const sharedProject = state.projects!.find(p => p.id === shared)!
    state.conversations.find(c => c.id === sharedProject.leadConversationId)!.leadId = sharedLead
    state.conversations.find(c => c.id === needs)!.task = { goal: 'g', changes: 'c', constraints: 'k', owns: ['o'], requires: { machines: ['host', 'other-mac'] } }
    const projectId = state.projects![0]!.id
    buddyChat = buddyChatId(projectId, { id: peer.sub, generation })
    // On peer's own machine, so peer reads as it; the owner may not.
    state.agents.push({ ...structuredClone(state.agents.find(a => a.id === worker)!), id: buddy, harnessId: 'buddy-harness', name: 'Buddy', projectId,
      machineId: 'peer-mac', machineOwnerId: peer.sub, contributorId: peer.sub, membershipGeneration: generation, buddyOf: { personId: peer.sub, generation } })
    state.conversations.push({ id: buddyChat, kind: 'buddy', projectId, title: 'Buddy', leadId: null, agentIds: [buddy], archived: false,
      brief: '', checks: [], assignment: null, lastMessageSequence: 0, audience: { people: [{ id: peer.sub, generation }] } })
    storeOldLeads(state, [lead])
  })
  const tabId = `tab-${randomUUID()}`
  const state = { ...structuredClone(s.state), id: tabId } as SuperTabState
  await writeLegacySwarm(db, { state, revision: 700 })
  const report = await migrateSwarm(db, tabId, { now: () => MIGRATED })
  if (!report.ok) throw new Error(report.error)
  // Stored without a number, as 111 live groups on prod are (11-04): a whole read numbers an awake one after every other
  // (model.ts numberConversations); a quiet one reads without. Migration numbers them, so the number goes after it.
  await db.$runCommandRaw({ update: 'SwarmGroup', updates: [{ q: { tabId, key: { $in: [legacy, quietLegacy] } }, u: { $unset: { 'data.number': '' } }, multi: true }] })
  const groups = (await parts.loadAll(db, tabId)).groups.filter(g => !g.deleted).map(g => g.key)
  return { tabId, groups, readers: [[owner], [peer], [outsider], [owner, lead], [owner, worker], [owner, secretWorker], [owner, sharedLead],
    [owner, unprojected], [owner, buddy], [peer, buddy], [owner, 'no-such-agent']] as Array<[AuthUser, string?]> }
}

/** What the whole-Swarm reads say of one group for a reader: its first load's entry for an active group, the dormant list's
 *  for a quiet one, else nothing; or the refusal both give. */
async function wholeRead(tabId: string, id: string, as: AuthUser, asAgentId?: string) {
  const agent = asAgentId ? `asAgentId=${asAgentId}` : ''
  const get = async (url: string) => {
    const response = await app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${as.sub}` } })
    return { status: response.statusCode, body: response.json() as { data: any; error?: { code: string } } }
  }
  const first = await get(`/api/super-tabs/${tabId}/parts${agent ? `?${agent}` : ''}`)
  if (first.status !== 200) return { status: first.status, code: first.body.error?.code }
  const active = first.body.data.groups.find((g: { key: string }) => g.key === id)
  if (active) return { status: 200, group: active }
  for (let before: string | null = null; ;) {
    const page = await get(`/api/super-tabs/${tabId}/groups?dormant=1${agent ? `&${agent}` : ''}${before ? `&before=${before}` : ''}`)
    const found = page.body.data.groups.find((g: { key: string }) => g.key === id)
    if (found) return { status: 200, group: found }
    if (!(before = page.body.data.next)) return { status: 404, code: 'NOT_FOUND' }
  }
}

describe('one group read by id (task #2875)', () => {
  it('answers every reader of every group as the whole-Swarm reads do, or refuses as they do', async () => {
    const s = await everyKind()
    let compared = 0
    const outcomes = new Map<string, number>()
    for (const [as, asAgentId] of s.readers) {
      for (const id of [...s.groups, 'missing']) {
        const one = await read(s.tabId, id, asAgentId, as)
        const whole = await wholeRead(s.tabId, id, as, asAgentId)
        const label = `${id} as ${as.email}${asAgentId ? ` / ${asAgentId}` : ''}`
        if (whole.status === 200) expect({ status: one.status, group: one.body.data?.group }, label).toEqual(whole)
        else expect({ status: one.status, code: one.body.error?.code }, label).toEqual(whole)
        const outcome = whole.status === 200 ? (whole.group.data.dormant ? 'dormant' : 'active') : `${whole.status} ${whole.code}`
        outcomes.set(outcome, (outcomes.get(outcome) ?? 0) + 1)
        compared++
      }
    }
    expect(compared).toBe(s.readers.length * (s.groups.length + 1))
    console.info(`compared ${compared} reads: ${JSON.stringify(Object.fromEntries(outcomes))}`)
    // Readers and groups the checks tell apart: active and quiet groups read, hidden ones refused, unknown agents refused.
    expect([...outcomes.keys()].sort()).toEqual(expect.arrayContaining(['active', 'dormant', '404 NOT_FOUND']))
    expect([...outcomes.keys()].some(o => o.startsWith('403'))).toBe(true)
  }, 300_000)

  it('reads that group and what its read check needs, never the Swarm\'s change feeds, after the Swarm moved', async () => {
    const s = await scene()
    const [quiet] = s.quiet
    // Warm: the Swarm read once by each reader, then a command elsewhere moves its stamp.
    expect((await read(s.tabId, quiet!, s.agents[0])).status).toBe(200)
    expect((await read(s.tabId, quiet!)).status).toBe(200)
    await touch(s.tabId, s.busy[0]!)
    for (const [label, asAgentId] of [['an agent', s.agents[0]], ['a person', undefined]] as const) {
      await touch(s.tabId, s.busy[1]!)
      const started = performance.now()
      const { value, rows } = await profiled(() => read(s.tabId, quiet!, asAgentId))
      const ms = performance.now() - started
      console.info(`one group read as ${label} after a write: ${rows.filter(r => r.op !== 'getmore').length} reads, ${bytes(rows)} bytes, ` +
        `${dbMs(rows)} ms in the database, ${ms.toFixed(1)} ms in all\n${describeRows(rows)}`)
      expect(value.status).toBe(200)
      expect(value.body.data.group).toMatchObject({ key: quiet, data: { id: quiet, dormant: true } })
      expect(feedReads(rows), describeRows(feedReads(rows))).toEqual([])
      // One group row by its key, never the Swarm's active groups (backend/AGENTS.md rule 3: its index, examined = returned).
      const groupRows = rows.filter(r => r.ns.endsWith('.SwarmGroup') && r.op !== 'getmore')
      expect(groupRows.reduce((n, r) => n + (r.nreturned ?? 0), 0), describeRows(groupRows)).toBeLessThanOrEqual(asAgentId ? 4 : 1)
      const byKey = groupRows.filter(r => /^IXSCAN \{ tabId: 1, deleted: 1, key: 1/.test(r.planSummary ?? ''))
      expect(byKey, describeRows(groupRows)).toHaveLength(1)
      expect(byKey[0]!.docsExamined).toBe(1)
      // An agent's machine: its account fields by _id, one document.
      const machineRows = rows.filter(r => r.ns.endsWith('.SwarmMachine') && r.op !== 'getmore')
      expect(machineRows.map(r => [r.planSummary, r.docsExamined]), describeRows(machineRows)).toEqual(asAgentId ? [['IXSCAN { _id: 1 }', 1]] : [])
    }
  }, 120_000)

  // Security review 1 of #3002, Minor 4: a key made again after its tombstone was purged starts at version 1 again.
  it('never serves the row it kept for a key made again at the same version', async () => {
    const s = await scene()
    const [quiet] = s.quiet
    const first = await read(s.tabId, quiet!)
    expect(first.body.data.group.data.title).toBe('Old task 0')
    // The same key and version, written anew with other data at a later time.
    await db.$runCommandRaw({ update: 'SwarmGroup', updates: [{ q: { tabId: s.tabId, key: quiet },
      u: { $set: { 'data.title': 'Made again', changedAt: { $date: new Date(Date.now() + 1_000).toISOString() } } } }] })
    const again = await read(s.tabId, quiet!)
    expect(again.body.data.group.version).toBe(first.body.data.group.version)
    expect(again.body.data.group.data.title).toBe('Made again')
  }, 120_000)

  it('makes one read for identical reads in flight on one process, and each reader its own', async () => {
    const s = await scene()
    const [quiet] = s.quiet
    expect((await read(s.tabId, quiet!, s.agents[0])).status).toBe(200)
    const { value, rows } = await profiled(() => Promise.all([
      ...Array.from({ length: 50 }, () => read(s.tabId, quiet!, s.agents[0])),
      read(s.tabId, quiet!, s.agents[1]), read(s.tabId, quiet!)]))
    expect(value.map(r => r.status)).toEqual(Array(52).fill(200))
    expect(new Set(value.map(r => JSON.stringify(r.body.data.group))).size).toBe(1)
    // The 50 alike share one read of the group; the other agent and the person read their own.
    const groupReads = rows.filter(r => r.ns.endsWith('.SwarmGroup') && r.op !== 'getmore')
    expect(groupReads.length, describeRows(groupReads)).toBe(3)
  }, 120_000)

  it(`answers a burst of 1,000 reads of ${QUIET} quiet groups by ${AGENTS} agents on ${PODS} pods while the Swarm moves, without its change feeds`, async () => {
    const s = await scene()
    for (const [i, agent] of s.agents.entries()) expect((await read(s.tabId, s.quiet[0]!, agent, owner, pods[i % PODS])).status).toBe(200)
    const times: number[] = [], rows: ProfileEntry[] = []
    for (let wave = 0; wave < 10; wave++) {
      // The Swarm moves between waves, as a busy one does every second: five tasks and a machine. Only the reads are measured.
      for (let i = 0; i < 5; i++) await touch(s.tabId, s.busy[(wave * 5 + i) % s.busy.length]!)
      await touchMachine(s.tabId, 'host')
      rows.push(...(await profiled(() => Promise.all(Array.from({ length: 100 }, async (_, i) => {
        const started = performance.now()
        const answer = await read(s.tabId, s.quiet[(wave * 100 + i) % QUIET]!, s.agents[i % AGENTS], owner, pods[i % PODS])
        times.push(performance.now() - started)
        expect(answer.status).toBe(200)
      })))).rows)
    }
    times.sort((a, b) => a - b)
    const feeds = feedReads(rows)
    console.info(`burst of 1,000 one group reads: ${rows.filter(r => r.op !== 'getmore').length} database reads, ${bytes(rows)} bytes, ` +
      `${dbMs(rows)} ms in the database; change feed reads ${feeds.length}, ${bytes(feeds)} bytes; per call p50 ${times[499]!.toFixed(1)} ms, ` +
      `p95 ${times[949]!.toFixed(1)} ms\n${byCollection(rows)}`)
    expect(feeds.length, describeRows(feeds)).toBe(0)
  }, 300_000)
})
