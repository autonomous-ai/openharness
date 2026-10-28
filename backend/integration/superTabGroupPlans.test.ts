import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { MongoMemoryReplSet } from 'mongodb-memory-server-core'
import { PrismaClient, type Prisma } from '@prisma/client'
import type { AuthUser } from '../src/lib/ssoAuth.js'
import { SuperTabStore, transaction } from '../src/superTabs/store.js'
import { migrateSwarm } from '../src/superTabs/migration/migrate.js'
import { HostReads } from '../src/superTabs/read/host.js'
import { DIRECT, readLight } from '../src/superTabs/cachedReads.js'
import * as parts from '../src/superTabs/parts/index.js'
import { recentDormantGroups } from '../src/superTabs/leaderboard/read.js'
import { decisionsWaiting, listDecisions } from '../src/superTabs/decisions.js'
import { GROUP_INDEX, groupsBy, listGroupIndexes, retryStaleIndex } from '../src/superTabs/parts/indexed.js'
import { logger } from '../src/utils/logger.js'
import type { SuperTabState } from '../src/superTabs/model.js'
import { writeLegacySwarm } from '../scripts/swarm-parts/legacy.js'
import { NOW, owner as ownerActor, swarm } from '../src/superTabs/read/fixture.test-support.js'
import { PROFILE_STAGES, queryShape } from './bench/profile.js'

// Prod's slow log (2026-10-28): SwarmGroup reads spent ~200 ms each planning. Prisma sends its filters as $expr, and a filter
// several indexes could serve is planned again whenever the plan cache misses, a race of every candidate index that a big
// Swarm's rows make slow, and that can pick an index which reads every quiet conversation to return none. Each hot read here
// runs under Mongo's profiler with the plan cache emptied first: it must name its index (never planned, no $expr), read only
// the documents it returns, and return the same rows as before. A fresh loopback replica set; never DATABASE_URL.
let replica: MongoMemoryReplSet
let db: PrismaClient
let store: SuperTabStore
let clock = NOW
const owner: AuthUser = { sub: ownerActor.userId, email: ownerActor.email, autonomousEnv: 'prod', role: 'user' }
const MIGRATED = NOW - 60_000
const DAY = 86_400_000
/** A busy Swarm's quiet conversations: prod's read 446 documents to return none. */
const QUIET_LEAD = 300, QUIET_OTHER = 60, OPEN = 140

beforeAll(async () => {
  replica = await MongoMemoryReplSet.create({ binary: { version: '7.0.24', downloadDir: join(tmpdir(), 'harness-super-tab-mongodb-binaries') },
    replSet: { count: 1, ip: '127.0.0.1', storageEngine: 'wiredTiger' } })
  const uri = replica.getUri(`swarm_group_plans_test_${randomUUID().replaceAll('-', '_')}`)
  await promisify(execFile)(join(process.cwd(), 'node_modules/.bin/prisma'), ['db', 'push', '--skip-generate'], {
    env: { ...process.env, DATABASE_URL: uri }, timeout: 60000,
  })
  db = new PrismaClient({ datasources: { db: { url: uri } } })
  await db.user.create({ data: { id: owner.sub, externalId: `fixture-${owner.sub}`, email: owner.email, autonomousEnv: 'prod' } })
  store = new SuperTabStore(db, () => clock)
})
afterAll(async () => {
  await db?.$disconnect()
  await replica?.stop()
})

/** A Swarm on two machines of the owner's: a Lead with a digest due, a worker running work on the other, a finished
 *  conversation, a second project and a third with no conversations; then QUIET_LEAD and QUIET_OTHER quiet conversations,
 *  the n-th last active n days ago (mod 28), and OPEN open ones without work. */
async function scene() {
  const [machineId, leadMachine] = [`m-${randomUUID().slice(0, 8)}`, `l-${randomUUID().slice(0, 8)}`]
  for (const id of [machineId, leadMachine]) {
    await db.machine.create({ data: { machineId: id, userId: owner.sub, apiKey: 'fixture-only', managerId: 'fixture', autonomousEnv: 'prod', authMode: 'remote' } })
  }
  const s = swarm(MIGRATED)
  s.contribute(machineId, 'swarm')
  const lead = s.add('lead-harness', 'lead', true, ownerActor, leadMachine, owner.sub)
  const other = s.run({ type: 'project.create', name: 'Other', visibility: 'public', brief: '' }).projectId as string
  const empty = s.run({ type: 'project.create', name: 'Empty', visibility: 'public', brief: '' }).projectId as string
  const web = s.group('Web')
  const worker = s.add('worker-harness', web, false, ownerActor, machineId, owner.sub)
  s.run({ type: 'work.assign', conversationId: web, agentId: worker })
  const done = s.group('Done work')
  // A Reviewer kept for more work, in the conversations that go quiet below: the Lead's poll reads those (store.ts fullDeliveries).
  const reviewer = s.add('reviewer-harness', done, false, ownerActor, machineId, owner.sub)
  s.edit(state => {
    state.projects![0]!.digest = { time: '00:00', timeZone: 'UTC' }
    Object.assign(state.agents.find(a => a.id === reviewer)!, { role: 'reviewer', workDecision: 'keep' })
  })
  const tabId = `tab-${randomUUID()}`
  const state = { ...structuredClone(s.state), id: tabId } as SuperTabState
  await writeLegacySwarm(db, { state, revision: 700, messages: [] })
  const report = await migrateSwarm(db, tabId, { now: () => MIGRATED })
  if (!report.ok) throw new Error(report.error)
  const { id: _id, ...row } = (await db.swarmGroup.findFirst({ where: { tabId, key: done } }))!
  const bulk = (prefix: string, n: number, projectId: string, dormant: boolean) => Array.from({ length: n }, (_, i) => {
    const key = `${prefix}${String(i).padStart(3, '0')}`
    return { ...row, id: `${tabId}:${key}`, key, projectId, dormant, ordinal: 100 + i, changedAt: new Date(MIGRATED - (i + 1) * 60_000),
      lastActivityAt: new Date(MIGRATED - (i % 28) * DAY), data: { ...row.data as object, id: key, projectId, title: key, brief: 'b'.repeat(2000) } }
  })
  const quietLead = bulk('ql', QUIET_LEAD, 'lead', true), quietOther = bulk('qo', QUIET_OTHER, other, true), open = bulk('op', OPEN, 'lead', false)
  await db.swarmGroup.createMany({ data: [...quietLead, ...quietOther, ...open] })
  // Every project's Lead conversation and the Leads' one: a host's light load always reads them (parts/light.ts).
  const leadConversations = [...state.projects!.map(p => p.leadConversationId), ...state.leadsConversationId ? [state.leadsConversationId] : []]
  const active = [...leadConversations, web, done, ...open.map(r => r.key)]
  return { tabId, machineId, lead, worker, reviewer, web, done, other, empty, quietLead, quietOther, leadConversations, active }
}

/** One read as the profiler saw it: its command and every getMore (they share a query hash). */
interface Read { shape: string; plans: string[]; multiPlanned: boolean; planningMicros: number; docsExamined: number; returned: number }
interface Row { ns: string; op: string; match?: unknown; planSummary?: string; docsExamined?: number; nreturned?: number; queryHash?: string
  fromMultiPlanner?: boolean; planningTimeMicros?: number; command?: { filter?: unknown; q?: unknown } }

/** The SwarmGroup reads `run` sends, with the plan cache emptied first: a read the planner would serve from its cache in a
 *  test is planned again in prod whenever the cache misses. */
async function profiled(run: () => Promise<unknown>): Promise<Read[]> {
  await db.$runCommandRaw({ planCacheClear: 'SwarmGroup' })
  await db.$runCommandRaw({ profile: 0 })
  await db.$runCommandRaw({ drop: 'system.profile' }).catch(() => {})
  await db.$runCommandRaw({ create: 'system.profile', capped: true, size: 64 * 1024 * 1024 })
  await db.$runCommandRaw({ profile: 2, slowms: 0 })
  try {
    await run()
  } finally {
    await db.$runCommandRaw({ profile: 0 })
  }
  const stages = [{ $match: { ns: { $regex: '\\.SwarmGroup$' }, op: { $in: ['command', 'getmore', 'query'] } } },
    { $project: { ...PROFILE_STAGES[0]!.$project, op: 1, queryHash: 1, fromMultiPlanner: 1, planningTimeMicros: 1 } }]
  const rows = (await db.$runCommandRaw({ aggregate: 'system.profile', pipeline: stages, cursor: { batchSize: 100000 } }) as unknown as
    { cursor: { firstBatch: Row[] } }).cursor.firstBatch
  const reads = new Map<string, Read>()
  for (const row of rows) {
    const id = row.queryHash ?? `${reads.size}`
    const filter = row.match ?? row.command?.filter ?? row.command?.q
    const read = reads.get(id) ?? { shape: '', plans: [], multiPlanned: false, planningMicros: 0, docsExamined: 0, returned: 0 }
    if (filter !== undefined && !read.shape) read.shape = queryShape(filter)
    if (row.planSummary && !read.plans.includes(row.planSummary)) read.plans.push(row.planSummary)
    read.multiPlanned ||= !!row.fromMultiPlanner
    read.planningMicros += Number(row.planningTimeMicros ?? 0)
    read.docsExamined += Number(row.docsExamined ?? 0)
    read.returned += Number(row.nreturned ?? 0)
    reads.set(id, read)
  }
  return [...reads.values()]
}

const mentions = (shape: string, field: string) => shape.includes(`"$${field}"`) || shape.includes(`"${field}":`)
/** The reads whose filter mentions every field of `fields`. */
const where = (reads: Read[], fields: string[]) => reads.filter(r => fields.every(f => mentions(r.shape, f)))

/** Each read examined only the documents it returned. */
function expectOnlyReturned(reads: Read[]) {
  for (const read of reads) expect(read.docsExamined, JSON.stringify(read)).toBeLessThanOrEqual(read.returned)
}

/** Named its index: never raced against the others, never through $expr. */
function expectIndexed(reads: Read[]) {
  for (const read of reads) {
    expect(read.multiPlanned, JSON.stringify(read)).toBe(false)
    expect(read.shape, JSON.stringify(read)).not.toContain('$expr')
  }
}

describe('hot SwarmGroup reads name their index and read only what they return (prod slow log, 2026-10-28)', () => {
  let s: Awaited<ReturnType<typeof scene>>
  beforeAll(async () => {
    // Another Swarm of the same size: a read not bounded by its Swarm reads that one's rows too.
    await scene()
    s = await scene()
    // As each server does at startup (server.ts): reads name only the indexes the database has.
    await listGroupIndexes(db)
  })

  it('the host\'s light load reads the Lead conversations, running work and the named conversations, nothing else', async () => {
    let groups: string[] = []
    const reads = await profiled(async () => {
      const loaded = await db.$transaction(tx => parts.loadLight(tx, s.tabId, { groups: 'working', agentIds: [s.worker], groupIds: [s.done], machines: false }))
      groups = loaded.groups.map(g => g.key)
    })
    expect(groups.sort()).toEqual([...s.leadConversations, s.web, s.done].sort())
    expect(reads.length).toBeGreaterThan(0)
    expectIndexed(reads)
    const docs = reads.reduce((n, r) => n + r.docsExamined, 0)
    // The worker's conversation is also running work: read once per branch at most.
    expect(docs, JSON.stringify(reads)).toBeLessThanOrEqual(groups.length + 1)
  })

  it('a command loads the Swarm\'s open conversations and those it names, each read through its index', async () => {
    const quiet = s.quietLead[5]!.key
    for (const [named, expected] of [
      [{ groupIds: [quiet] }, [...s.active, quiet]],
      // An agent's conversations and a project's, quiet ones too (store.ts moreNamed, namedFor).
      [{ agentIds: [s.worker], projectIds: [s.other] }, [...s.active, ...s.quietOther.map(r => r.key)]],
    ] as const) {
      let keys: string[] = []
      const reads = await profiled(async () => { keys = (await db.$transaction(tx => parts.loadActive(tx, s.tabId, named))).groups.map(g => g.key) })
      expect(keys.sort()).toEqual([...new Set(expected)].sort())
      expectIndexed(reads)
      expectOnlyReturned(reads)
    }
  })

  it('the read cache\'s base loads the Swarm\'s open conversations through the dormancy index', async () => {
    let keys: string[] = []
    const reads = await profiled(async () => { keys = (await db.$transaction(tx => parts.loadReadBase(tx, s.tabId))).groups.map(g => g.key) })
    expect(keys.sort()).toEqual([...s.active].sort())
    expect(reads).toHaveLength(1)
    expectIndexed(reads)
    expectOnlyReturned(reads)
  })

  it('the mentions panel reads a tagged quiet conversation by id, never every quiet conversation', async () => {
    const tagged = s.quietLead[3]!.key
    await db.superTabMention.create({ data: { id: `${s.tabId}-tag`, tabId: s.tabId, personId: owner.sub, projectId: 'lead', conversationId: tagged,
      messageId: `${s.tabId}-tagged`, authorAgentId: s.lead, createdAt: new Date(Date.now() - 60_000) } })
    let listed: Array<{ conversationId: string }> = []
    const reads = await profiled(async () => { listed = (await store.mentions(owner, s.tabId, 'waiting')).mentions })
    expect(listed.map(m => m.conversationId)).toEqual([tagged])
    expectIndexed(reads)
    expectOnlyReturned(reads)
    // The open conversations and the tagged one, at most: never the Swarm's QUIET_LEAD + QUIET_OTHER quiet ones.
    expect(reads.reduce((n, r) => n + r.docsExamined, 0), JSON.stringify(reads)).toBeLessThanOrEqual(s.active.length + 1)
  })

  it('a person\'s decisions read the quiet conversations they wait in by id', async () => {
    const quiet = s.quietLead[4]!.key
    await db.superTabDecision.create({ data: { id: `${s.tabId}-ask`, tabId: s.tabId, batchId: 'b', projectId: 'lead', conversationId: quiet, personId: owner.sub,
      askerAgentId: s.lead, question: 'Which?', options: ['A', 'B'], recommended: 0, unblocks: 'Work', createdAt: new Date(MIGRATED) } })
    const state = parts.reassemble(await db.$transaction(tx => parts.loadActive(tx, s.tabId)))
    const actor = { kind: 'person' as const, userId: owner.sub, email: owner.email }
    let count = 0, listed: Array<{ conversationId: string }> = []
    const reads = await profiled(async () => {
      count = (await db.$transaction(tx => decisionsWaiting(tx, s.tabId, state, actor))).count
      listed = (await db.$transaction(tx => listDecisions(tx, s.tabId, state, actor, 'open'))).decisions
    })
    expect(count).toBe(1)
    expect(listed.map(d => d.conversationId)).toEqual([quiet])
    expect(reads.length).toBeGreaterThan(0)
    expectIndexed(reads)
    expectOnlyReturned(reads)
  })

  // Folded from #1964: a later page started at no bound, so each page read every newer quiet conversation again.
  it('each page of a project\'s quiet conversations reads the 50 it returns, newest activity first', async () => {
    const order = [...s.quietLead].sort((a, b) => b.lastActivityAt.getTime() - a.lastActivityAt.getTime() || (a.key < b.key ? 1 : -1))
    const pages: string[][] = []
    const reads = await profiled(async () => {
      const first = await db.$transaction(tx => parts.loadDormant(tx, s.tabId, { projectId: 'lead' }))
      const last = order.find(r => r.key === first.at(-1)!.key)!
      const second = await db.$transaction(tx => parts.loadDormant(tx, s.tabId, { projectId: 'lead', before: { lastActivityAt: last.lastActivityAt.getTime(), key: last.key } }))
      pages.push(first.map(g => g.key), second.map(g => g.key))
    })
    expect(pages).toEqual([order.slice(0, 50).map(r => r.key), order.slice(50, 100).map(r => r.key)])
    expect(reads.length).toBeGreaterThan(0)
    expectIndexed(reads)
    expectOnlyReturned(reads)
  })

  it('the leaderboard reads a project\'s quiet conversations of the weeks it sums, and only those', async () => {
    const since = MIGRATED - 13 * DAY
    const recent = (rows: typeof s.quietLead) => rows.filter(r => r.lastActivityAt.getTime() >= since).map(r => r.key).sort()
    for (const [projectId, expected] of [['lead', recent(s.quietLead)], [s.other, recent(s.quietOther)], [s.empty, []]] as const) {
      let found: string[] = []
      const reads = await profiled(async () => { found = (await db.$transaction(tx => recentDormantGroups(tx, s.tabId, projectId, since))).map(g => g.id).sort() })
      expect(found).toEqual(expected)
      expect(reads).toHaveLength(1)
      expectIndexed(reads)
      expect(reads[0]!.docsExamined, `${projectId} ${JSON.stringify(reads)}`).toBeLessThanOrEqual(expected.length)
    }
  })

  it('a Lead\'s poll with a digest due reads the quiet conversations its project finished since the last one, and those its Reviewers are in, by index', async () => {
    clock = MIGRATED + 60_000
    const expected = s.quietLead.filter(r => r.lastActivityAt.getTime() >= clock - DAY).length
    const all = await profiled(() => store.deliveries(owner, s.tabId, s.lead))
    const reads = where(all, ['tabId', 'dormant', 'lastActivityAt'])
    expect(reads).toHaveLength(1)
    expectIndexed(reads)
    expect(reads[0]!.returned).toBe(expected)
    expect(reads[0]!.docsExamined, JSON.stringify(reads)).toBeLessThanOrEqual(expected)
    // The same poll reads the quiet conversations its project's kept Reviewer is in (every quiet one here), through the
    // Reviewer's conversations: no index has both.
    const asleep = where(all, ['tabId', 'dormant', 'agentIds'])
    expect(asleep).toHaveLength(1)
    expectIndexed(asleep)
    expect(asleep[0]!.returned).toBe(s.quietLead.length + s.quietOther.length)
    const its = await db.swarmGroup.count({ where: { tabId: s.tabId, agentIds: { has: s.reviewer } } })
    expect(asleep[0]!.docsExamined, JSON.stringify(asleep)).toBeLessThanOrEqual(its)
  })

  it('the host\'s wake check finds a change that concerns its machine, reading only the conversations changed since the cursor', async () => {
    const hosts = new HostReads(store, { now: () => clock })
    clock = Date.now()
    const first = await hosts.changes(owner, s.machineId, { full: true })
    // Ten conversations another machine's host was told about since: this host's wake check reads none of them (review of #1994).
    await db.swarmGroup.updateMany({ where: { tabId: s.tabId, key: { in: s.quietOther.slice(0, 10).map(r => r.key) } },
      data: { changedAt: new Date(Date.now() + 500), hostMachineIds: ['other-host'] } })
    clock = Date.now()
    let quiet: Awaited<ReturnType<HostReads['changes']>> | undefined
    const idle = where(await profiled(async () => { quiet = await hosts.changes(owner, s.machineId, { cursor: first.cursor }) }), ['tabId', 'changedAt', 'hostMachineIds'])
    expect(idle).toHaveLength(1)
    expectIndexed(idle)
    // None of its conversations changed for this machine since the cursor: it reads none, not even those changed for others.
    expect(idle[0]!.returned).toBe(0)
    expectOnlyReturned(idle)
    // A write that concerns this machine's host, as parts/commit.ts marks it.
    clock = Date.now() + 1000
    await db.swarmGroup.updateMany({ where: { tabId: s.tabId, key: s.web }, data: { changedAt: new Date(clock), hostMachineIds: [s.machineId] } })
    let woken: Awaited<ReturnType<HostReads['changes']>> | undefined
    const reads = where(await profiled(async () => { woken = await hosts.changes(owner, s.machineId, { cursor: quiet!.cursor }) }), ['tabId', 'changedAt', 'hostMachineIds'])
    expect(woken!.tabs.map(t => t.tabId)).toEqual([s.tabId])
    expect(reads).toHaveLength(1)
    expectIndexed(reads)
    expect(reads[0]!.returned).toBe(1)
    expectOnlyReturned(reads)
  })
})

describe('a hot read whose index the database lacks', () => {
  let s: Awaited<ReturnType<typeof scene>>
  beforeAll(async () => { s = await scene() })

  it('reads without it, in a transaction too, and says so; once the index is built it names it again', async () => {
    const read = () => db.$transaction(tx => groupsBy(tx, 'running', [{ $match: { tabId: s.tabId, executionMachineId: { $ne: null } } }, { $project: { _id: 0, key: 1 } }]))
    const said = vi.spyOn(logger, 'error')
    await db.$runCommandRaw({ dropIndexes: 'SwarmGroup', index: GROUP_INDEX.running })
    try {
      await listGroupIndexes(db)
      expect(said).toHaveBeenCalledWith(expect.stringContaining('lacks indexes'), { missing: [GROUP_INDEX.running] })
      expect(await read()).toEqual([{ key: s.web }])
    } finally {
      said.mockRestore()
      await db.$runCommandRaw({ createIndexes: 'SwarmGroup', indexes: [{ key: GROUP_INDEX.running, name: 'SwarmGroup_tabId_executionMachineId_idx' }] })
    }
    await listGroupIndexes(db)
    const reads = await profiled(async () => expect(await read()).toEqual([{ key: s.web }]))
    expect(reads).toHaveLength(1)
    expectIndexed(reads)
  })

  // Review of #1994: listed first, then removed (a rollback, an index replaced). The listing still names it until the next one.
  describe('removed after the last listing', () => {
    const match = () => [{ $match: { tabId: s.tabId, agentIds: s.worker } }, { $project: { _id: 0, key: 1 } }]
    /** Listed, then removed, then `run`; with `before`, that runs between the listing and the removal and hands `run` its result. */
    async function removed<T, B = undefined>(...steps: [run: () => Promise<T>] | [before: () => Promise<B>, run: (started: B) => Promise<T>]): Promise<T> {
      await listGroupIndexes(db)
      const started = steps.length === 2 ? await steps[0]() : undefined as B
      await db.$runCommandRaw({ dropIndexes: 'SwarmGroup', index: GROUP_INDEX.agents })
      try {
        return await (steps.length === 2 ? steps[1](started) : steps[0]())
      } finally {
        await db.$runCommandRaw({ createIndexes: 'SwarmGroup', indexes: [{ key: GROUP_INDEX.agents, name: 'SwarmGroup_tabId_agentIds_idx' }] })
        await listGroupIndexes(db)
      }
    }

    it('a read outside a transaction says so and answers without it at once', async () => {
      const said = vi.spyOn(logger, 'error')
      expect(await removed(() => groupsBy(db, 'agents', match()))).toEqual([{ key: s.web }])
      expect(said).toHaveBeenCalledWith(expect.stringContaining('lacks an index'), expect.anything())
      said.mockRestore()
    })

    it('a store transaction runs again without it and answers', async () => {
      expect(await removed(() => transaction(db, tx => groupsBy(tx, 'agents', match())))).toEqual([{ key: s.web }])
    })

    // Re-check of #1994: a listing whose reply was read before the removal lands after a read dropped the listing.
    it('a listing that started before the removal does not name it again once it lands', async () => {
      let land!: () => void
      const landed = new Promise<void>(resolve => { land = resolve })
      const slow = { $runCommandRaw: async (command: Prisma.InputJsonObject) => { const reply = await db.$runCommandRaw(command); await landed; return reply } } as unknown as PrismaClient
      const rows = await removed(async () => {
        const late = listGroupIndexes(slow)
        // The reply is read (index still there) before the removal below: give the command time to come back.
        await new Promise(resolve => setTimeout(resolve, 200))
        return { late }
      }, async ({ late }) => {
        expect(await groupsBy(db, 'agents', match())).toEqual([{ key: s.web }])
        land()
        await late
        // A transaction opened directly, no runner to run it again: it answers only if nothing names the removed index.
        return db.$transaction(tx => groupsBy(tx, 'agents', match()))
      })
      expect(rows).toEqual([{ key: s.web }])
    })

    it('a store transaction\'s rerun names no index, even if a listing names the removed one again meanwhile', async () => {
      let attempts = 0
      const rows = await removed(async () => transaction(db, async tx => { attempts++; return groupsBy(tx, 'agents', match()) }, async () => {
        // Between the attempts the index comes back, is listed, and goes again (an index rebuilt during a rollout).
        await db.$runCommandRaw({ createIndexes: 'SwarmGroup', indexes: [{ key: GROUP_INDEX.agents, name: 'SwarmGroup_tabId_agentIds_idx' }] })
        await listGroupIndexes(db)
        await db.$runCommandRaw({ dropIndexes: 'SwarmGroup', index: GROUP_INDEX.agents })
      }))
      expect(rows).toEqual([{ key: s.web }])
      expect(attempts).toBe(2)
    })

    // The reviewer's probe (re-check of #1994): an older listing reply, read before the removal, lands after the failed attempt.
    it('a directly opened transaction\'s rerun names no index when an older listing reply lands before it', async () => {
      let attempts = 0
      const rows = await removed(async () => ({ older: await db.$runCommandRaw({ listIndexes: 'SwarmGroup' }) }), ({ older }) => retryStaleIndex(async () => {
        attempts++
        try {
          return await db.$transaction(tx => groupsBy(tx, 'agents', match()))
        } finally {
          if (attempts === 1) await listGroupIndexes({ $runCommandRaw: async () => older } as unknown as PrismaClient)
        }
      }))
      expect(rows).toEqual([{ key: s.web }])
      expect(attempts).toBe(2)
    })

    it('a directly opened transaction\'s rerun names no index, even if a listing names the removed one again meanwhile', async () => {
      let attempts = 0
      const rows = await removed(() => retryStaleIndex(async () => {
        if (++attempts === 2) {
          await db.$runCommandRaw({ createIndexes: 'SwarmGroup', indexes: [{ key: GROUP_INDEX.agents, name: 'SwarmGroup_tabId_agentIds_idx' }] })
          await listGroupIndexes(db)
          await db.$runCommandRaw({ dropIndexes: 'SwarmGroup', index: GROUP_INDEX.agents })
        }
        return db.$transaction(tx => groupsBy(tx, 'agents', match()))
      }))
      expect(rows).toEqual([{ key: s.web }])
      expect(attempts).toBe(2)
    })

    it('the read cache\'s own transaction runs again without it and answers', async () => {
      const loaded = await removed(() => readLight(db, DIRECT, s.tabId, { groups: 'working', agentIds: [s.worker] }))
      expect(loaded.groups.map(g => g.key).sort()).toEqual([...s.leadConversations, s.web].sort())
    })
  })
})
