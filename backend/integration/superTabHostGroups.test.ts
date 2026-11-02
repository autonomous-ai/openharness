import { createHash, randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MongoMemoryReplSet } from 'mongodb-memory-server-core'
import type { PrismaClient } from '@prisma/client'
import type { AuthUser } from '../src/lib/ssoAuth.js'
import { SuperTabStore } from '../src/superTabs/store.js'
import { configureSwarmStamps, swarmTransaction, SwarmCache } from '../src/superTabs/cache.js'
import { MemoryStamps } from '../src/superTabs/cache.test-support.js'
import * as parts from '../src/superTabs/parts/index.js'
import { guardedWrite } from '../src/superTabs/parts/write.js'
import { listNamedIndexes } from '../src/superTabs/parts/indexed.js'
import { DIRECT, readDelta } from '../src/superTabs/cachedReads.js'
import { hostInputs } from '../src/superTabs/read/hostInputs.js'
import { migrateSwarm } from '../src/superTabs/migration/migrate.js'
import type { SuperTabState } from '../src/superTabs/model.js'
import { writeLegacySwarm } from '../scripts/swarm-parts/legacy.js'
import { owner as ownerActor, richSwarm, swarm } from '../src/superTabs/read/fixture.test-support.js'
import { HostReads } from '../src/superTabs/read/host.js'
import { planDatabase, profiled, reads } from './plans.test-support.js'

// The host signature's conversations (read/hostInputs.ts) through the patched read cache, against the `$group` pipeline it
// replaced (prod's slow log, 2026-11-02: 76 slow, 24 s): the same string after every kind of write, changing exactly when a
// host-relevant conversation does, and a check after one change reading that one conversation, not the Swarm's. A fresh
// loopback replica set; never DATABASE_URL.
let replica: MongoMemoryReplSet
let db: PrismaClient
let stamps: MemoryStamps
const owner: AuthUser = { sub: ownerActor.userId, email: ownerActor.email, autonomousEnv: 'prod', role: 'user' }
/** Conversations added to the fixture's few, so a read of all of them is plainly more than a read of one. */
const EXTRA = 150

beforeAll(async () => {
  ;({ replica, db } = await planDatabase('swarm_host_groups_test'))
  await db.user.create({ data: { id: owner.sub, externalId: `fixture-${owner.sub}`, email: owner.email, autonomousEnv: 'prod' } })
  // As each server does at startup (server.ts): reads name only the indexes the database has.
  await listNamedIndexes(db)
})
afterAll(async () => {
  configureSwarmStamps(null)
  await db?.$disconnect()
  await replica?.stop()
})
beforeEach(() => { stamps = new MemoryStamps(); configureSwarmStamps(stamps) })
afterEach(() => configureSwarmStamps(null))

async function scene() {
  const s = richSwarm(Date.now())
  const tabId = `tab-${randomUUID()}`
  await writeLegacySwarm(db, { state: { ...structuredClone(s.state), id: tabId } as SuperTabState, revision: 10 })
  const report = await migrateSwarm(db, tabId)
  if (!report.ok) throw new Error(report.error)
  await swarmTransaction(db, async tx => {
    const all = await parts.loadAll(tx, tabId)
    const model = all.groups.find(g => g.key === s.web)!
    for (let i = 0; i < EXTRA; i++) {
      const key = `extra-${i}`
      await guardedWrite(tx, tabId, { op: 'insert', kind: 'group', key, ordinal: 10_000 + i, data: { ...model.data!, id: key, title: `Extra ${i}`, assignment: null } }, Date.now())
    }
  })
  await age(tabId)
  return { tabId, web: s.web }
}

/** Every conversation last changed ten minutes ago, as a Swarm's quiet ones are: the cache's overlap re-reads the newest few seconds. */
const age = (tabId: string) => db.swarmGroup.updateMany({ where: { tabId }, data: { changedAt: new Date(Date.now() - 600_000) } })

/** One write, committed as a command commits: in a Swarm transaction, guarded by the version read in it. */
async function write(tabId: string, pick: (all: parts.SwarmParts) => parts.PartWrite | null, stamp = Date.now()): Promise<boolean> {
  return swarmTransaction(db, async tx => {
    const change = pick(await parts.loadAll(tx, tabId))
    if (!change) return false
    await guardedWrite(tx, tabId, change, stamp)
    return true
  })
}
const group = (all: parts.SwarmParts, key: string) => all.groups.find(g => g.key === key && !g.deleted)!
const update = (key: string, change: (data: parts.GroupData) => parts.GroupData) => (all: parts.SwarmParts): parts.PartWrite =>
  ({ op: 'update', kind: 'group', key, seen: group(all, key).version, data: change(group(all, key).data!) })

/** The signature as the `$group` pipeline gave it before (read/host.ts inputs, v1.3.86). */
async function pipeline(tabId: string): Promise<string | null> {
  const live = { tabId, deleted: false }, stamp = { key: true, changedAt: true } as const
  const [head, members, agents, starts, machines, digests] = await Promise.all([
    db.swarmHead.findUnique({ where: { id: `${tabId}:head` }, select: { changedAt: true } }),
    db.swarmMember.findMany({ where: live, select: stamp }), db.swarmAgent.findMany({ where: live, select: stamp }),
    db.swarmStart.findMany({ where: live, select: stamp }),
    db.swarmMachine.findMany({ where: live, select: { key: true, hostChangedAt: true } }),
    db.swarmGroup.aggregateRaw({ pipeline: [{ $match: { tabId, deleted: false } }, { $sort: { key: 1 } },
      { $group: { _id: null, missing: { $sum: { $cond: [{ $ifNull: ['$hostDigest', false] }, 0, 1] } },
        all: { $push: { $concat: [{ $ifNull: ['$hostDigest', ''] }, { $cond: ['$dormant', '1', '0'] }] } } } },
      { $project: { _id: 0, missing: 1, all: { $reduce: { input: '$all', initialValue: '', in: { $concat: ['$$value', '$$this'] } } } } }] }),
  ])
  const groups = (digests as unknown as Array<{ missing: number; all: string }>)[0] ?? { missing: 0, all: '' }
  if (!head || groups.missing) return null
  const keyed = <T extends { key: string }>(rows: T[]) => rows.sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
  return createHash('sha256').update(JSON.stringify([head.changedAt, keyed(members), keyed(agents), keyed(starts), keyed(machines), groups.all]))
    .digest('base64url').slice(0, 22)
}

/** The signature through the cache, as a host check reads it. */
const cachedInputs = async (cache: SwarmCache, tabId: string) => hostInputs(db, await cache.at([tabId]), tabId)

describe('the host signature\'s conversations through the patched cache', () => {
  it('gives the pipeline\'s string after every kind of write, patching rather than loading again', { timeout: 120_000 }, async () => {
    const { tabId, web } = await scene()
    const delta = vi.fn(readDelta(db))
    const cache = new SwarmCache(stamps, { delta })
    const store = new SuperTabStore(db, Date.now, null, { readCache: cache })
    let n = 0
    const steps: Array<[string, () => Promise<unknown>]> = [
      ['rename', () => write(tabId, update(web, g => ({ ...g, title: `T${++n}` })))],
      ['sleep', () => write(tabId, update('extra-1', g => ({ ...g, dormant: true })))],
      ['wake', () => write(tabId, update('extra-1', g => ({ ...g, dormant: false })))],
      ['archive', () => write(tabId, update('extra-2', g => ({ ...g, archived: true })))],
      ['agent leaves', () => write(tabId, all => { const g = all.groups.find(x => !x.deleted && x.data!.agentIds.length); return g ? update(g.key, d => ({ ...d, agentIds: d.agentIds.slice(1) }))(all) : null })],
      ['new conversation', () => write(tabId, all => ({ op: 'insert', kind: 'group', key: `late-${++n}`, ordinal: 20_000 + n, data: { ...group(all, web).data!, id: `late-${n}`, assignment: null } }))],
      ['conversation removed', () => write(tabId, all => ({ op: 'remove', kind: 'group', key: 'extra-3', seen: group(all, 'extra-3').version, data: group(all, 'extra-3').data }))],
      ['a post', () => store.execute(owner, tabId, { operationId: `send-${randomUUID()}`, command: { type: 'message.send', conversationId: web, text: `m${++n}`, replyTo: null, recipientIds: [] } })],
    ]
    expect(await cachedInputs(cache, tabId)).toBe(await pipeline(tabId))
    for (const [name, step] of steps) {
      await step()
      const expected = await pipeline(tabId)
      expect(expected, name).not.toBeNull()
      expect(await cachedInputs(cache, tabId), `${name}, patched`).toBe(expected)
      expect(await hostInputs(db, DIRECT, tabId), `${name}, no cache`).toBe(expected)
    }
    // After the first load every refresh was a delta, not a read of the Swarm.
    expect(delta.mock.calls.length).toBeGreaterThanOrEqual(steps.length - 1)
  })

  it('changes exactly when a host-relevant conversation changes: not for a rename or a post, for everything its rows read', { timeout: 60_000 }, async () => {
    const { tabId, web } = await scene()
    const cache = new SwarmCache(stamps, { delta: readDelta(db) })
    const store = new SuperTabStore(db, Date.now, null, { readCache: cache })
    const relevant: Array<[string, () => Promise<unknown>]> = [
      ['put to sleep', () => write(tabId, update('extra-1', g => ({ ...g, dormant: true })))],
      ['woken', () => write(tabId, update('extra-1', g => ({ ...g, dormant: false })))],
      ['archived', () => write(tabId, update('extra-2', g => ({ ...g, archived: true })))],
      ['an agent added', () => write(tabId, update('extra-4', g => ({ ...g, agentIds: [...g.agentIds, 'someone'] })))],
      ['added', () => write(tabId, all => ({ op: 'insert', kind: 'group', key: 'added', ordinal: 30_000, data: { ...group(all, web).data!, id: 'added', assignment: null } }))],
      ['removed', () => write(tabId, all => ({ op: 'remove', kind: 'group', key: 'extra-3', seen: group(all, 'extra-3').version, data: group(all, 'extra-3').data }))],
    ]
    const irrelevant: Array<[string, () => Promise<unknown>]> = [
      ['renamed', () => write(tabId, update('extra-5', g => ({ ...g, title: 'Another name' })))],
      ['a post', () => store.execute(owner, tabId, { operationId: `send-${randomUUID()}`, command: { type: 'message.send', conversationId: web, text: 'hello', replyTo: null, recipientIds: [] } })],
    ]
    let held = await cachedInputs(cache, tabId)
    for (const [name, step] of relevant) {
      await step()
      const now = await cachedInputs(cache, tabId)
      expect(now, name).not.toBe(held)
      held = now
    }
    for (const [name, step] of irrelevant) {
      await step()
      expect(await cachedInputs(cache, tabId), name).toBe(held)
    }
  })

  it('reads the Swarm\'s conversations once, from the index alone, and afterwards only the one that changed', async () => {
    const { tabId, web } = await scene()
    const cache = new SwarmCache(stamps, { delta: readDelta(db) })
    const groupReads = (entries: Awaited<ReturnType<typeof profiled>>) => entries.filter(e => e.ns.endsWith('.SwarmGroup'))
    const commands = (entries: Awaited<ReturnType<typeof profiled>>) => entries.filter(e => e.op !== 'getmore')
    const sum = (entries: Awaited<ReturnType<typeof profiled>>, field: 'keysExamined' | 'docsExamined' | 'nreturned') => entries.reduce((n, e) => n + (e[field] ?? 0), 0)
    let first: string | null = null
    const cold = groupReads(await profiled(db, async () => { first = await cachedInputs(cache, tabId) }))
    expect(first).not.toBeNull()
    expect(commands(cold)).toHaveLength(1)
    // Every conversation's key, digest and dormancy from the index: no document is read.
    expect(sum(cold, 'keysExamined')).toBeGreaterThanOrEqual(EXTRA)
    expect(sum(cold, 'docsExamined')).toBe(0)

    const idle = groupReads(await profiled(db, async () => { expect(await cachedInputs(cache, tabId)).toBe(first) }))
    expect(idle).toHaveLength(0)

    await write(tabId, update(web, g => ({ ...g, archived: true })))
    let next: string | null = null
    const patched = groupReads(await profiled(db, async () => { next = await cachedInputs(cache, tabId) }))
    expect(next).not.toBe(first)
    expect(next).toBe(await pipeline(tabId))
    // One read of the conversations changed since the last check, and it examines only them.
    expect(commands(patched)).toHaveLength(1)
    expect(sum(patched, 'nreturned')).toBe(1)
    expect(sum(patched, 'docsExamined')).toBeLessThanOrEqual(2)
    expect(sum(patched, 'keysExamined')).toBeLessThanOrEqual(2)
    expect(reads(patched, 'SwarmGroup', ['changedAt'])).toHaveLength(1)
  })

  it('is null while a conversation has no digest, and the string again once it has one', async () => {
    const { tabId } = await scene()
    const cache = new SwarmCache(stamps, { delta: readDelta(db) })
    expect(await cachedInputs(cache, tabId)).not.toBeNull()
    // A conversation written before the digest existed, as such a part is stored.
    await db.swarmGroup.updateMany({ where: { tabId, key: 'extra-7' }, data: { hostDigest: null, changedAt: new Date() } })
    await stamps.bump(tabId, ['main'])
    expect(await cachedInputs(cache, tabId)).toBeNull()
    expect(await hostInputs(db, DIRECT, tabId)).toBeNull()
    expect(await pipeline(tabId)).toBeNull()
    await write(tabId, update('extra-7', g => ({ ...g, title: 'Rewritten' })))
    expect(await cachedInputs(cache, tabId)).toBe(await pipeline(tabId))
    expect(await cachedInputs(cache, tabId)).not.toBeNull()
  })

  it('a write committed after the load but stamped 20 s earlier is in the next patch', async () => {
    const { tabId } = await scene()
    const cache = new SwarmCache(stamps, { delta: readDelta(db) })
    const before = await cachedInputs(cache, tabId)
    await write(tabId, update('extra-6', g => ({ ...g, archived: true })), Date.now() - 20_000)
    const after = await cachedInputs(cache, tabId)
    expect(after).not.toBe(before)
    expect(after).toBe(await pipeline(tabId))
  })
})

describe('a host check', () => {
  /** A Swarm with a host: a Lead and a worker on its machine, and EXTRA more conversations, each with a digest of its own. */
  async function hosted() {
    const machineId = `m-${randomUUID().slice(0, 8)}`
    await db.machine.create({ data: { machineId, userId: owner.sub, apiKey: 'fixture-only', managerId: 'fixture', autonomousEnv: 'prod', authMode: 'remote' } })
    const s = swarm(Date.now())
    s.contribute(machineId, 'swarm')
    s.add('lead-harness', 'lead', true, ownerActor, machineId, owner.sub)
    const web = s.group('Web')
    s.add('worker-harness', web, false, ownerActor, machineId, owner.sub)
    const tabId = `tab-${randomUUID()}`
    await writeLegacySwarm(db, { state: { ...structuredClone(s.state), id: tabId } as SuperTabState, revision: 10 })
    const report = await migrateSwarm(db, tabId)
    if (!report.ok) throw new Error(report.error)
    const { id: _id, ...row } = (await db.swarmGroup.findFirst({ where: { tabId, key: web } }))!
    await db.swarmGroup.createMany({ data: Array.from({ length: EXTRA }, (_, i) => {
      const key = `more-${String(i).padStart(3, '0')}`
      return { ...row, id: `${tabId}:${key}`, key, ordinal: 100 + i, hostDigest: `digest-${String(i).padStart(3, '0')}`, data: { ...row.data as object, id: key, title: key } }
    }) })
    await age(tabId)
    return { tabId, machineId }
  }

  it('after one conversation changed reads that conversation, not every live one, and gives the rows\' etag as before', async () => {
    const { tabId, machineId } = await hosted()
    const cache = new SwarmCache(stamps, { delta: readDelta(db) })
    const hosts = new HostReads(new SuperTabStore(db, Date.now, null, { readCache: cache }))
    const first = await hosts.changes(owner, machineId, { full: true })
    const etag = first.tabs.find(t => t.tabId === tabId)!.etag
    // A conversation of the host's changes, as parts/commit.ts marks a write that concerns it.
    await write(tabId, all => ({ op: 'update', kind: 'group', key: 'more-007', seen: group(all, 'more-007').version, data: { ...group(all, 'more-007').data!, archived: true },
      host: { hostMachineIds: [machineId] } }))
    let answer: Awaited<ReturnType<HostReads['changes']>> | undefined
    const entries = (await profiled(db, async () => { answer = await hosts.changes(owner, machineId, { cursor: first.cursor, held: { [tabId]: etag } }) }))
      .filter(e => e.ns.endsWith('.SwarmGroup'))
    const tab = answer!.tabs.find(t => t.tabId === tabId)!
    expect(tab.etag.slice(22)).toBe((await pipeline(tabId))!)
    // The old check was a $group over every live conversation: at least all EXTRA keys examined.
    expect(entries.reduce((sum, e) => sum + (e.keysExamined ?? 0), 0)).toBeLessThan(EXTRA / 2)
  })
})
