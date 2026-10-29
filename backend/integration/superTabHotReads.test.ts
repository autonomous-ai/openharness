import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MongoMemoryReplSet } from 'mongodb-memory-server-core'
import { PrismaClient } from '@prisma/client'
import type { AuthUser } from '../src/lib/ssoAuth.js'
import { SuperTabStore } from '../src/superTabs/store.js'
import { listGroupIndexes } from '../src/superTabs/parts/indexed.js'
import { migrateSwarm } from '../src/superTabs/migration/migrate.js'
import { waitingIn } from '../src/superTabs/decisions.js'
import { HostReads } from '../src/superTabs/read/host.js'
import { SwarmReads } from '../src/superTabs/read/service.js'
import { cursorFor } from '../src/superTabs/read/cursor.js'
import { lastChangedAt } from '../src/superTabs/parts/index.js'
import { swarmReadCache } from '../src/superTabs/cache.js'
import type { SuperTabState } from '../src/superTabs/model.js'
import { writeLegacySwarm } from '../scripts/swarm-parts/legacy.js'
import { NOW, outsider, owner as ownerActor, peer, swarm } from '../src/superTabs/read/fixture.test-support.js'
import { PROFILE_STAGES, profileEntry, queryShape, type ProfileEntry } from './bench/profile.js'

// The hot reads of the roadmap's 2.7 (indexes) under Mongo's profiler: each must read only the documents it returns, never
// the rest of its Swarm's rows, and never scan a collection. A fresh loopback replica set; never DATABASE_URL.
let replica: MongoMemoryReplSet
let db: PrismaClient
let store: SuperTabStore
let clock = NOW
const owner: AuthUser = { sub: ownerActor.userId, email: ownerActor.email, autonomousEnv: 'prod', role: 'user' }
const MIGRATED = NOW - 60_000
const DAY = 86_400_000
/** Rows of the same Swarm that none of the reads below return: a read that walks the Swarm's rows reads these too. */
const OTHERS = 8

beforeAll(async () => {
  replica = await MongoMemoryReplSet.create({ binary: { version: '7.0.24', downloadDir: join(tmpdir(), 'harness-super-tab-mongodb-binaries') },
    replSet: { count: 1, ip: '127.0.0.1', storageEngine: 'wiredTiger' } })
  const uri = replica.getUri(`swarm_indexes_test_${randomUUID().replaceAll('-', '_')}`)
  await promisify(execFile)(join(process.cwd(), 'node_modules/.bin/prisma'), ['db', 'push', '--skip-generate'], {
    env: { ...process.env, DATABASE_URL: uri }, timeout: 60000,
  })
  db = new PrismaClient({ datasources: { db: { url: uri } } })
  await db.user.create({ data: { id: owner.sub, externalId: `fixture-${owner.sub}`, email: owner.email, autonomousEnv: 'prod' } })
  store = new SuperTabStore(db, () => clock)
  await listGroupIndexes(db)
})
afterAll(async () => {
  await db?.$disconnect()
  await replica?.stop()
})

/** A Swarm on two machines of the owner's: a Lead, and on the other a worker with running work, finished work, and OTHERS quiet conversations,
 *  closed deliveries of other messages to other agents, and open decisions in other conversations. */
async function scene({ sharedMachine, edit }: { sharedMachine?: string; edit?: (s: ReturnType<typeof swarm>) => void } = {}) {
  const [machineId, leadMachine] = [sharedMachine ?? `m-${randomUUID().slice(0, 8)}`, `l-${randomUUID().slice(0, 8)}`]
  for (const id of sharedMachine ? [leadMachine] : [machineId, leadMachine]) {
    await db.machine.create({ data: { machineId: id, userId: owner.sub, apiKey: 'fixture-only', managerId: 'fixture', autonomousEnv: 'prod', authMode: 'remote' } })
  }
  const s = swarm(MIGRATED)
  s.contribute(machineId, 'swarm')
  // The Lead is in every conversation, so it runs on another of the owner's machines: the host reads below are this one's.
  const lead = s.add('lead-harness', 'lead', true, ownerActor, leadMachine, owner.sub)
  const web = s.group('Web')
  const worker = s.add('worker-harness', web, false, ownerActor, machineId, owner.sub)
  s.run({ type: 'work.assign', conversationId: web, agentId: worker })
  const done = s.group('Done work')
  const quiet = Array.from({ length: OTHERS }, (_, i) => s.group(`Quiet ${i}`))
  edit?.(s)
  s.edit(state => {
    state.conversations.find(c => c.id === done)!.assignment = { ...state.conversations.find(c => c.id === web)!.assignment!, id: 'old-work', status: 'done' }
  })
  const tabId = `tab-${randomUUID()}`
  const state = { ...structuredClone(s.state), id: tabId } as SuperTabState
  const message = `${tabId}-m1`
  await writeLegacySwarm(db, { state, revision: 700, messages: [{ id: message, conversationId: done, sequence: 5, text: 'Done',
    author: { kind: 'person', id: owner.sub, name: owner.email, membershipGeneration: tabId }, createdAt: new Date(MIGRATED - 2 * DAY) }] })
  const report = await migrateSwarm(db, tabId, { now: () => MIGRATED })
  if (!report.ok) throw new Error(report.error)
  await db.swarmGroup.updateMany({ where: { tabId, key: { in: quiet } }, data: { dormant: true } })
  const delivery = { tabId, conversationId: done, machineId, membershipGeneration: tabId, authorKind: 'person', authorId: owner.sub,
    authorGeneration: tabId, status: 'confirmed' }
  await db.superTabDelivery.createMany({ data: Array.from({ length: OTHERS }, (_, i) => ({ ...delivery, id: `${tabId}-d${i}`, agentId: `${tabId}-agent-${i}`, messageId: `${tabId}-other-${i}`, assignmentId: `${tabId}-old-work-${i}` })) })
  await db.superTabDecision.createMany({ data: quiet.map((conversationId, i) => ({ id: `${tabId}-q${i}`, tabId, batchId: 'b', projectId: 'lead', conversationId,
    personId: owner.sub, askerAgentId: lead, question: 'Which?', options: ['A', 'B'], recommended: 0, unblocks: 'Work', createdAt: new Date(MIGRATED) })) })
  return { tabId, machineId, lead, worker, web, done, message }
}

/** Every operation `run` sends, as the profiler records it. */
async function profiled(run: () => Promise<unknown>): Promise<ProfileEntry[]> {
  await db.$runCommandRaw({ profile: 0 })
  await db.$runCommandRaw({ drop: 'system.profile' }).catch(() => {})
  await db.$runCommandRaw({ create: 'system.profile', capped: true, size: 64 * 1024 * 1024 })
  await db.$runCommandRaw({ profile: 2, slowms: 0 })
  try {
    await run()
  } finally {
    await db.$runCommandRaw({ profile: 0 })
  }
  const reply = await db.$runCommandRaw({ aggregate: 'system.profile', pipeline: [
    { $project: { ...PROFILE_STAGES[0]!.$project, 'command.hint': 1 } }], cursor: { batchSize: 100000 } }) as unknown as { cursor: { firstBatch: ProfileEntry[] } }
  return reply.cursor.firstBatch.map(profileEntry)
}

/** The profiled reads of one collection whose filter mentions every field of `fields` and none of `not`. */
function reads(entries: ProfileEntry[], collection: string, fields: string[], not: string[] = []): ProfileEntry[] {
  const mentions = (shape: string, field: string) => shape.includes(`"$${field}"`) || shape.includes(`"${field}":`)
  return entries.filter(e => e.ns.endsWith(`.${collection}`)).filter(e => {
    const filter = (e.command?.pipeline as Array<{ $match?: unknown }> | undefined)?.[0]?.$match ?? e.command?.filter ?? e.command?.q
    if (filter === undefined) return false
    const shape = queryShape(filter)
    return fields.every(f => mentions(shape, f)) && !not.some(f => mentions(shape, f))
  })
}
const plan = (rows: ProfileEntry[]) => rows.map(r => ({ plan: r.planSummary, docsExamined: r.docsExamined, keysExamined: r.keysExamined, returned: r.nreturned }))

/** Timestamp scans match only tabId; the indexed wake query also bounds changedAt and hostMachineIds. */
function timestampScans(entries: ProfileEntry[]) {
  return entries.filter(e => /^Swarm(Head|Member|Agent|Group|Machine|Start|Progress)$/.test(e.command?.aggregate as string))
    .flatMap(e => {
      const match = (e.command?.pipeline as Array<{ $match?: { tabId?: { $in?: string[] } } }>)?.[0]?.$match
      return match?.tabId?.$in && Object.keys(match).length === 1 ? [{ collection: e.command!.aggregate, ids: match.tabId.$in }] : []
    })
}

it('batches cold host timestamp misses across Swarms and leaves warm timestamps out of the batch', async () => {
  const a = await scene(), b = await scene({ sharedMachine: a.machineId })
  for (const s of [a, b]) swarmReadCache()!.drop(s.tabId)
  const hosts = new HostReads(store, { now: () => Date.now() })
  const expected = await lastChangedAt(db, [a.tabId, b.tabId])
  const cold = await profiled(async () => {
    const concurrent = await Promise.all([hosts.changes(owner, a.machineId, { full: true }), hosts.changes(owner, a.machineId, { full: true })])
    for (const result of concurrent) expect(new Map(result.tabs.map(t => [t.tabId, t.lastChangedAt]))).toEqual(expected)
  })
  expect(timestampScans(cold)).toHaveLength(7)
  for (const scan of timestampScans(cold)) expect(new Set(scan.ids)).toEqual(new Set([a.tabId, b.tabId]))
  expect(timestampScans(await profiled(() => hosts.changes(owner, a.machineId, { full: true })))).toEqual([])

  const c = await scene({ sharedMachine: a.machineId })
  swarmReadCache()!.drop(c.tabId)
  const mixed = timestampScans(await profiled(() => hosts.changes(owner, a.machineId, { full: true })))
  expect(mixed).toHaveLength(7)
  for (const scan of mixed) expect(scan.ids).toEqual([c.tabId])

  const direct = new HostReads(new SuperTabStore(db, () => clock, null, { readCache: null }))
  const uncached = await profiled(async () => {
    expect((await direct.changes(owner, a.machineId, { full: true })).tabs)
      .toEqual((await hosts.changes(owner, a.machineId, { full: true })).tabs)
  })
  expect(timestampScans(uncached)).toHaveLength(7)
  for (const scan of timestampScans(uncached)) expect(new Set(scan.ids)).toEqual(new Set([a.tabId, b.tabId, c.tabId]))
})

it('reuses the host timestamp at the same stamp, including a repeated wake with a held etag', async () => {
  const s = await scene()
  const hosts = new HostReads(store, { now: () => Date.now() })
  const first = await hosts.changes(owner, s.machineId, { full: true })
  const held = Object.fromEntries(first.tabs.map(tab => [tab.tabId, tab.etag]))
  // An older cursor wakes this Swarm again without another write or stamp bump.
  const entries = await profiled(async () => {
    const second = await hosts.changes(owner, s.machineId, { cursor: cursorFor(MIGRATED - 1, 0), held })
    expect(second.tabs).toEqual(first.tabs.map(tab => ({ tabId: tab.tabId, etag: tab.etag,
      lastChangedAt: tab.lastChangedAt, unchanged: true })))
  })
  expect(timestampScans(entries)).toEqual([])

  // A committed change invalidates the timestamp along with the host inputs; a cold/direct read agrees.
  clock = Date.now()
  await store.execute(owner, s.tabId, { operationId: randomUUID(), command: {
    type: 'message.send', conversationId: s.web, text: 'A newer change', replyTo: null, recipientIds: [] } })
  const changed = await hosts.changes(owner, s.machineId, { full: true })
  const newest = (await lastChangedAt(db, [s.tabId])).get(s.tabId)
  expect(newest).toBeGreaterThan(first.tabs[0]!.lastChangedAt!)
  expect(changed.tabs[0]!.lastChangedAt).toBe(newest)
  const direct = new HostReads(new SuperTabStore(db, () => clock, null, { readCache: null }))
  expect((await direct.changes(owner, s.machineId, { full: true })).tabs).toEqual(changed.tabs)
})

describe('delivery authority reads', () => {
  it.each(['person', 'agent'] as const)('claim, hold and ack from a %s leave unrelated conversations and machine parts unread', async sender => {
    const s = await scene()
    // Keep unrelated conversations active: dormant rows already escape loadActive.
    await db.swarmGroup.updateMany({ where: { tabId: s.tabId }, data: { dormant: false } })
    await store.execute(owner, s.tabId, { operationId: randomUUID(), command: { type: 'message.send',
      conversationId: s.web, text: 'Please continue.', recipientIds: [s.worker], replyTo: null } }, sender === 'agent' ? s.lead : undefined)
    const delivery = await db.superTabDelivery.findFirstOrThrow({ where: { tabId: s.tabId, agentId: s.worker, status: 'queued' } })
    for (const action of [{ type: 'claim', claimId: 'bounded' },
      { type: 'hold', claimId: 'bounded', reason: 'team_waiting_idle' },
      { type: 'ack', claimId: 'bounded', receipt: 'typed', uncertain: false }] as const) {
      const entries = await profiled(() => store.delivery(owner, s.tabId, s.worker, delivery.id, action))
      const groups = entries.filter(e => e.ns.endsWith('.SwarmGroup') && e.op !== 'update')
      const returned = groups.reduce((sum, e) => sum + (e.nreturned ?? 0), 0)
      console.log(`delivery ${action.type}: groups=${returned}, docs=${entries.reduce((sum, e) => sum + (e.docsExamined ?? 0), 0)}`)
      // The project and Swarm Lead conversations plus the receiver's group; no quiet groups or finished work.
      expect(returned, `${action.type}: ${JSON.stringify(plan(groups))}`).toBe(3)
      expect(groups.every(e => !!e.command?.hint), 'delivery reads use the installed group indexes').toBe(true)
      expect(entries.filter(e => e.ns.endsWith('.SwarmMachine'))).toEqual([])
    }
  })
})

describe('hot reads read only what they return (roadmap 2.7)', () => {
  let entries: ProfileEntry[]
  let s: Awaited<ReturnType<typeof scene>>
  beforeAll(async () => {
    // Another Swarm with running work: a read not bounded by its Swarm reads that one's rows too.
    await scene()
    s = await scene()
    const hosts = new HostReads(store, { now: () => clock })
    clock = Date.now()
    entries = await profiled(async () => {
      const first = await hosts.changes(owner, s.machineId, { full: true })
      clock = Date.now()
      await hosts.changes(owner, s.machineId, { cursor: first.cursor })
      await store.deliveries(owner, s.tabId, s.lead)
      await db.$transaction(tx => waitingIn(tx, s.tabId, s.web))
      // Last: ending the running work releases its run record and open deliveries.
      const work = ((await db.swarmGroup.findFirst({ where: { tabId: s.tabId, key: s.web } }))!.data as { assignment: { id: string } }).assignment.id
      await store.execute(owner, s.tabId, { operationId: randomUUID(),
        command: { type: 'work.cancel', conversationId: s.web, assignmentId: work, reason: 'No longer needed.' } })
    })
  })

  it('the host signature reads every conversation\'s digest and dormancy from the index alone', () => {
    const rows = reads(entries, 'SwarmGroup', ['tabId', 'deleted'], ['key', 'dormant', 'changedAt', 'executionMachineId', 'agentIds'])
    expect(rows).toHaveLength(1)
    expect(plan(rows)).toEqual([expect.objectContaining({ docsExamined: 0 })])
  })

  it('the host\'s light load of running work reads only this Swarm\'s running conversations', () => {
    const rows = reads(entries, 'SwarmGroup', ['tabId', 'executionMachineId'])
    expect(rows).toHaveLength(1)
    expect(rows[0]!.docsExamined, JSON.stringify(plan(rows))).toBeLessThanOrEqual(rows[0]!.nreturned!)
  })

  it('the host\'s wake check reads only machines whose settings changed since the cursor', () => {
    const rows = reads(entries, 'SwarmMachine', ['tabId', 'hostChangedAt'])
    expect(rows).toHaveLength(1)
    expect(rows[0]!.docsExamined, JSON.stringify(plan(rows))).toBeLessThanOrEqual(rows[0]!.nreturned!)
  })

  it('the Lead\'s poll reads only the Swarm\'s open deliveries, not each agent\'s closed ones', () => {
    const rows = reads(entries, 'SuperTabDelivery', ['tabId', 'status'], ['agentId', 'messageId', 'assignmentId', 'conversationId'])
    expect(rows).toHaveLength(1)
    // One key past the last of each open status at most: never one per agent.
    expect(rows[0]!.keysExamined, JSON.stringify(plan(rows))).toBeLessThanOrEqual(rows[0]!.nreturned! + 3)
  })

  it('ending work reads only its own open deliveries, never the Swarm\'s others', () => {
    const rows = reads(entries, 'SuperTabDelivery', ['tabId', 'assignmentId', 'status'])
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) expect(row.docsExamined, JSON.stringify(plan(rows))).toBeLessThanOrEqual(row.nreturned!)
  })

  it('whether a decision waits in a conversation reads only that conversation\'s decisions', () => {
    const rows = reads(entries, 'SuperTabDecision', ['tabId', 'conversationId'], ['personId'])
    expect(rows).toHaveLength(1)
    expect(rows[0]!.docsExamined, JSON.stringify(plan(rows))).toBeLessThanOrEqual(rows[0]!.nreturned!)
  })

  it('no read of these scans a whole collection', () => {
    const scans = entries.filter(e => e.planSummary === 'COLLSCAN' && !e.ns.includes('.system.'))
    expect(scans.map(e => `${e.ns.slice(e.ns.indexOf('.') + 1)} ${queryShape((e.command?.pipeline as Array<{ $match?: unknown }> | undefined)?.[0]?.$match ?? e.command?.filter ?? e.command?.q)}`)).toEqual([])
  })
})

// Diego's backend review, item 5 (2026-10-28): which machines are signed in as a team account is the same answer for every
// reader, and machines report every 15 s, so the read API asks for it at most once per 15 s per Swarm and machine list.
describe('which machines take teammates\' work is read once per 15 s per Swarm', () => {
  it('two polls within 15 s read the team machines once; a machine turning team shows 15 s after the read', async () => {
    const s = await scene()
    const swarmReads = new SwarmReads(store, { now: () => clock })
    const teamReads = (entries: ProfileEntry[]) => reads(entries, 'machines', ['machineId', 'sessionKind'])
    const teamWork = (read: { derived: { machines: Record<string, { teamWork: unknown }> } }) => read.derived.machines[s.machineId]!.teamWork
    clock = Date.now()
    const readAt = clock
    let cursor = ''
    const within = await profiled(async () => {
      const first = await swarmReads.firstLoad(owner, s.tabId)
      expect(teamWork(first)).toEqual({ allowed: true })
      clock += 3_000
      cursor = (await swarmReads.changes(owner, s.tabId, first.cursor)).cursor
      // The machine's account turns team: a team machine that never reported is offline for teammates' work.
      await db.machine.update({ where: { machineId: s.machineId }, data: { sessionKind: 'team' } })
      clock += 3_000
      const polled = await swarmReads.changes(owner, s.tabId, cursor)
      expect(teamWork(polled)).toEqual({ allowed: true })
      cursor = polled.cursor
    })
    expect(teamReads(within)).toHaveLength(1)
    clock = readAt + 15_000
    const later = await profiled(async () => {
      expect(teamWork(await swarmReads.changes(owner, s.tabId, cursor))).toMatchObject({ allowed: false, code: 'MACHINE_OFFLINE' })
    })
    expect(teamReads(later)).toHaveLength(1)
  })
})

describe('the owner\'s grid poll', () => {
  it('reads each Swarm\'s head and only the people of those with Local models, never their groups, agents, machines or starts', async () => {
    const off = await scene({ edit: s => s.edit(state => { delete state.localModels }) })
    const on = await scene({ edit: s => s.join(peer) })
    let grids: Awaited<ReturnType<SuperTabStore['hostGrids']>> = []
    const entries = await profiled(async () => { grids = await store.hostGrids(owner) })
    expect(grids.filter(g => g.tabId === off.tabId)).toEqual([])
    const head = await db.swarmHead.findFirstOrThrow({ where: { tabId: on.tabId } })
    expect(grids.filter(g => g.tabId === on.tabId)).toEqual([{ tabId: on.tabId, grid: (head.data as { localModels: { grid: string } }).localModels.grid,
      enabled: true, ready: null, members: [peer.email] }])
    const heavy = entries.filter(e => /\.Swarm(Group|Agent|Machine|Start|Progress)$/.test(e.ns))
    expect(heavy.map(e => e.ns.slice(e.ns.indexOf('.') + 1))).toEqual([])
    // The people read asks for the Swarms with Local models only.
    const people = entries.filter(e => e.ns.endsWith('.SwarmMember'))
    expect(people.length).toBeGreaterThan(0)
    expect(JSON.stringify(people.map(e => e.command))).not.toContain(off.tabId)
  })

  it('leaves out someone removed from a Swarm with Local models', async () => {
    const s = await scene({ edit: s => { s.join(peer); s.join(outsider) } })
    clock = Date.now()
    await store.execute(owner, s.tabId, { operationId: randomUUID(), command: { type: 'member.remove', userId: outsider.userId } })
    expect(await db.swarmMember.findFirst({ where: { tabId: s.tabId, key: outsider.userId }, select: { deleted: true } })).toEqual({ deleted: true })
    expect((await store.hostGrids(owner)).find(g => g.tabId === s.tabId)!.members).toEqual([peer.email])
  })
})

// Roadmap Phase 3.1: the host poll's Swarm lookup, once a second per host. Prisma sent `machineIds has` OR `cleanupMachineIds has`
// as $expr, sorted by updatedAt, which no index held: the slow log showed 17 Swarms examined per one returned.
describe('the host poll\'s Swarm lookup', () => {
  it('reads only the Swarms that list this machine, newest first, by the machine indexes', async () => {
    // Swarms of other machines: a lookup the machine does not bound examines these too.
    for (let i = 0; i < 6; i++) await scene()
    const s = await scene(), also = await scene({ sharedMachine: s.machineId })
    // A Swarm that removed this machine still lists it for cleanup until its host has cleaned up.
    const cleanup = await scene()
    await db.superTab.update({ where: { id: cleanup.tabId }, data: { machineIds: { set: [cleanup.machineId] }, cleanupMachineIds: { set: [s.machineId] } } })
    await db.superTab.update({ where: { id: also.tabId }, data: { updatedAt: new Date(Date.now() + 60_000) } })
    const hosts = new HostReads(store, { now: () => Date.now() })
    let tabs: string[] = []
    const entries = await profiled(async () => { tabs = (await hosts.changes(owner, s.machineId, { full: true })).tabs.map(t => t.tabId) })
    expect(new Set(tabs)).toEqual(new Set([also.tabId, s.tabId, cleanup.tabId]))
    const lookups = entries.filter(e => e.ns.endsWith('.SuperTab')).filter(e => /machineIds|cleanupMachineIds/.test(JSON.stringify(e.command?.pipeline ?? e.command?.filter ?? {})))
    expect(lookups.length, JSON.stringify(plan(lookups))).toBe(2)
    for (const lookup of lookups) {
      expect(lookup.docsExamined, JSON.stringify(plan(lookups))).toBeLessThanOrEqual(lookup.nreturned!)
      expect(lookup.command?.hint, `the lookup names its index: ${JSON.stringify(plan(lookups))}`).toBeTruthy()
    }
  })
})
