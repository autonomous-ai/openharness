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
import { migrateSwarm } from '../src/superTabs/migration/migrate.js'
import { waitingIn } from '../src/superTabs/decisions.js'
import { HostReads } from '../src/superTabs/read/host.js'
import { cursorFor } from '../src/superTabs/read/cursor.js'
import { lastChangedAt } from '../src/superTabs/parts/index.js'
import type { SuperTabState } from '../src/superTabs/model.js'
import { writeLegacySwarm } from '../scripts/swarm-parts/legacy.js'
import { NOW, owner as ownerActor, swarm } from '../src/superTabs/read/fixture.test-support.js'
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
})
afterAll(async () => {
  await db?.$disconnect()
  await replica?.stop()
})

/** A Swarm on two machines of the owner's: a Lead, and on the other a worker with running work, finished work, and OTHERS quiet conversations,
 *  closed deliveries of other messages to other agents, and open decisions in other conversations. */
async function scene() {
  const [machineId, leadMachine] = [`m-${randomUUID().slice(0, 8)}`, `l-${randomUUID().slice(0, 8)}`]
  for (const id of [machineId, leadMachine]) {
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
  const reply = await db.$runCommandRaw({ aggregate: 'system.profile', pipeline: PROFILE_STAGES, cursor: { batchSize: 100000 } }) as unknown as { cursor: { firstBatch: ProfileEntry[] } }
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
  const scans = entries.filter(e => /^Swarm(Head|Member|Agent|Group|Machine|Start|Progress)$/.test(e.command?.aggregate as string))
    .filter(e => {
      const match = (e.command?.pipeline as Array<{ $match?: { tabId?: { $in?: unknown } } }>)?.[0]?.$match
      // Timestamp scans match only tabId; the host's indexed wake query also bounds changedAt and hostMachineIds.
      return match?.tabId?.$in && Object.keys(match).length === 1
    })
  expect(scans.map(e => e.command?.aggregate)).toEqual([])

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
