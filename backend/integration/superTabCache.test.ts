import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { MongoMemoryReplSet } from 'mongodb-memory-server-core'
import { PrismaClient } from '@prisma/client'
import type { AuthUser } from '../src/lib/ssoAuth.js'
import { SuperTabStore } from '../src/superTabs/store.js'
import { configureSwarmStamps, swarmReadCache, swarmTransaction } from '../src/superTabs/cache.js'
import { MemoryStamps } from '../src/superTabs/cache.test-support.js'
import * as parts from '../src/superTabs/parts/index.js'
import { guardedWrite } from '../src/superTabs/parts/write.js'
import type { HeadData, MachineData } from '../src/superTabs/parts/index.js'
import { sweepSwarms } from '../src/superTabs/sweeps.js'
import { SwarmCache } from '../src/superTabs/cache.js'
import { readParts } from '../src/superTabs/cachedReads.js'
import { SwarmReads } from '../src/superTabs/read/service.js'
import { migrateSwarm } from '../src/superTabs/migration/migrate.js'
import type { SuperTabState } from '../src/superTabs/model.js'
import { writeLegacySwarm } from '../scripts/swarm-parts/legacy.js'
import { outsider as outsiderActor, owner as ownerActor, peer as peerActor, richSwarm } from '../src/superTabs/read/fixture.test-support.js'

// The per-process Swarm cache (superTabs/cache.ts, Stability Roadmap 2.2) on a fresh loopback replica set; Redis is
// MemoryStamps, one store of stamps every "pod" here shares. This suite never reads DATABASE_URL or an existing database.
let replica: MongoMemoryReplSet
let db: PrismaClient
let stamps: MemoryStamps
const user = (n: number): AuthUser => ({ sub: `6a00000000000000000000${String(n).padStart(2, '0')}`, email: `cache-${n}@example.com`, autonomousEnv: 'prod', role: 'user' })
const [owner] = [user(0)]
const person = (actor: { userId: string; email: string }): AuthUser => ({ sub: actor.userId, email: actor.email, autonomousEnv: 'prod', role: 'user' })
const people = { owner: person(ownerActor), peer: person(peerActor), outsider: person(outsiderActor) }

beforeAll(async () => {
  replica = await MongoMemoryReplSet.create({ binary: { version: '7.0.24', downloadDir: join(tmpdir(), 'harness-super-tab-mongodb-binaries') },
    replSet: { count: 1, ip: '127.0.0.1', storageEngine: 'wiredTiger' } })
  const uri = replica.getUri(`swarm_cache_test_${randomUUID().replaceAll('-', '_')}`)
  await promisify(execFile)(join(process.cwd(), 'node_modules/.bin/prisma'), ['db', 'push', '--skip-generate'], {
    env: { ...process.env, DATABASE_URL: uri }, timeout: 60000,
  })
  db = new PrismaClient({ datasources: { db: { url: uri } } })
  for (const each of [owner, people.owner, people.peer, people.outsider]) await db.user.create({ data: { id: each.sub, externalId: `fixture-${each.sub}`, email: each.email, autonomousEnv: 'prod' } })
})
afterAll(async () => {
  configureSwarmStamps(null)
  await db?.$disconnect()
  await replica?.stop()
})
beforeEach(() => { stamps = new MemoryStamps(); configureSwarmStamps(stamps) })
afterEach(() => configureSwarmStamps(null))

async function newSwarm(store = new SuperTabStore(db)) {
  const { id } = await store.create(owner, `create-${randomUUID()}`, 'Cache')
  const { state } = await store.read(owner, id)
  return { store, tabId: id, lead: state.conversations.find(c => !c.kind)!.id }
}
const bumpsOf = (tabId: string) => stamps.bumps.filter(b => b.tabId === tabId).map(b => b.scopes)
const send = (store: SuperTabStore, tabId: string, conversationId: string, text = 'hello') =>
  store.execute(owner, tabId, { operationId: `send-${randomUUID()}`, command: { type: 'message.send', conversationId, text, replyTo: null, recipientIds: [] } })

describe('stamps after commit', () => {
  it('bumps a Swarm\'s main stamp once per command, after the command committed', async () => {
    const { store, tabId, lead } = await newSwarm()
    expect(bumpsOf(tabId)).toEqual([['main']])
    const seen: Array<Promise<number>> = []
    stamps.subscribe(id => { if (id === tabId) seen.push(db.superTabMessage.count({ where: { tabId, text: 'after commit' } })) })
    await send(store, tabId, lead, 'after commit')
    expect(bumpsOf(tabId)).toEqual([['main'], ['main']])
    expect(await Promise.all(seen)).toEqual([1])
  })

  it('bumps nothing for a command that was refused', async () => {
    const { store, tabId } = await newSwarm()
    await expect(send(store, tabId, 'no-such-conversation')).rejects.toThrow()
    expect(bumpsOf(tabId)).toEqual([['main']])
  })

  it('moves only the machine stamp for a machine part whose reading alone changed, and the main one for its settings', async () => {
    const { tabId } = await newSwarm()
    const machine: MachineData = { machineId: 'm1', contribution: null, reservations: [], released: [], closingSessions: [], cleanups: [] }
    await swarmTransaction(db, tx => guardedWrite(tx, tabId, { op: 'insert', kind: 'machine', key: 'm1', data: machine, ordinal: 1 }, parts.clock.next()))
    await swarmTransaction(db, tx => guardedWrite(tx, tabId, { op: 'update', kind: 'machine', key: 'm1', seen: 1, data: machine }, parts.clock.next()))
    await swarmTransaction(db, tx => guardedWrite(tx, tabId, { op: 'update', kind: 'machine', key: 'm1', seen: 2, data: machine,
      host: { hostChangedAt: new Date() } }, parts.clock.next()))
    expect(bumpsOf(tabId).slice(1)).toEqual([['main'], ['machine'], ['main']])
  })

  it('bumps nothing for a touch alone', async () => {
    const { tabId } = await newSwarm()
    const head = (await db.swarmHead.findUniqueOrThrow({ where: { id: `${tabId}:head` } }))
    await swarmTransaction(db, tx => guardedWrite(tx, tabId, { op: 'touch', kind: 'head', key: 'head', seen: head.version }, parts.clock.next()))
    expect(bumpsOf(tabId)).toEqual([['main']])
  })

  it('bumps the Swarms an expiry sweep changed', async () => {
    const { tabId } = await newSwarm()
    const head = await db.swarmHead.findUniqueOrThrow({ where: { id: `${tabId}:head` } })
    const data = head.data as unknown as HeadData
    await swarmTransaction(db, tx => guardedWrite(tx, tabId, { op: 'update', kind: 'head', key: 'head', seen: head.version,
      data: { ...data, invitations: [{ id: 'i1', email: 'late@example.com', role: 'viewer', conversationId: 'lead', expiresAt: 1 }] },
      head: { groupCounter: head.groupCounter, visibilityEpoch: head.visibilityEpoch, sequenceBase: head.sequenceBase } }, parts.clock.next()))
    await sweepSwarms(db)
    expect(bumpsOf(tabId)).toEqual([['main'], ['main'], ['main']])
  })

  it('keeps a command that committed when its bump fails, and forgets the Swarm in this process', async () => {
    const { store, tabId, lead } = await newSwarm()
    await (await swarmReadCache()!.at([tabId])).get(tabId, 'probe', 'main', async () => ({ held: true }))
    expect(swarmReadCache()!.size.entries).toBeGreaterThan(0)
    const bump = stamps.bump.bind(stamps)
    stamps.bump = async () => { throw new Error('Redis is unreachable') }
    await expect(send(store, tabId, lead, 'committed anyway')).resolves.toMatchObject({ result: { messageId: expect.any(String) } })
    expect(await db.superTabMessage.count({ where: { tabId, text: 'committed anyway' } })).toBe(1)
    expect(swarmReadCache()!.size.entries).toBe(0)
    stamps.bump = bump
    // Owed, and paid once Redis answers again: every process then sees the commit.
    await vi.waitFor(() => expect(bumpsOf(tabId)).toEqual([['main'], ['main']]), { timeout: 5_000 })
  })
})

/** One backend process: its own cache over the stamps every process shares. */
function pod(options: { cache?: SwarmCache | null } = {}) {
  const cache = options.cache === undefined ? new SwarmCache(stamps) : options.cache
  const store = new SuperTabStore(db, Date.now, null, { readCache: cache })
  return { store, reads: new SwarmReads(store), cache }
}

/** The rich fixture Swarm in parts, with a conversation private to `peer` (and the project's Lead). */
async function privateScene() {
  const s = richSwarm(Date.now())
  const privateId = s.group('Peer and PM')
  s.edit(state => {
    const generation = state.people.find(p => p.id === peerActor.userId)!.generation
    state.conversations.find(c => c.id === privateId)!.audience = { people: [{ id: peerActor.userId, generation }] }
  })
  const tabId = `tab-${randomUUID()}`
  await writeLegacySwarm(db, { state: { ...structuredClone(s.state), id: tabId } as SuperTabState, revision: 10 })
  const report = await migrateSwarm(db, tabId)
  if (!report.ok) throw new Error(report.error)
  return { tabId, privateId, secretGroup: s.secretGroup, web: s.web, lead: s.lead }
}
const groupKeys = (read: { groups: Array<{ key: string }> }) => read.groups.map(g => g.key)

/** The part collections' reads MongoDB served while `run` ran (its profiler, every operation). */
async function partReads<T>(run: () => Promise<T>): Promise<{ value: T; reads: number }> {
  await db.$runCommandRaw({ profile: 2 })
  const since = new Date()
  try {
    const value = await run()
    const rows = await db.$runCommandRaw({ find: 'system.profile', filter: { ts: { $gte: { $date: since.toISOString() } },
      ns: { $regex: '\\.Swarm(Head|Member|Agent|Group|Machine|Start|Progress)$' } } }) as { cursor: { firstBatch: unknown[] } }
    return { value, reads: rows.cursor.firstBatch.length }
  } finally {
    await db.$runCommandRaw({ profile: 0 })
  }
}

describe('reads through the cache', () => {
  it('reads a Swarm whose stamp did not move without asking Mongo for its parts', async () => {
    const { tabId } = await privateScene()
    const { reads } = pod()
    await reads.firstLoad(people.owner, tabId)
    const second = await partReads(() => reads.firstLoad(people.owner, tabId))
    expect(second.reads).toBe(0)
    const first = await partReads(() => pod().reads.firstLoad(people.owner, tabId))
    expect(first.reads).toBeGreaterThan(0)
  })

  it('shows a commit on one process to the next read on another (stale after commit, two pods)', async () => {
    const { tabId } = await privateScene()
    const a = pod(), b = pod()
    const before = await b.reads.firstLoad(people.owner, tabId)
    const { result } = await a.store.execute(people.owner, tabId, { operationId: `create-${randomUUID()}`,
      command: { type: 'conversation.create', title: 'Made on A', brief: '', checks: [] } })
    const created = result.conversationId as string
    expect(groupKeys(await b.reads.firstLoad(people.owner, tabId))).toContain(created)
    const changes = await b.reads.changes(people.owner, tabId, before.cursor)
    expect('reload' in changes && changes.reload).toBe(false)
    expect(groupKeys(changes as { groups: Array<{ key: string }> })).toContain(created)
    // And the other way: a message on B's Swarm, read on A.
    await b.store.execute(people.owner, tabId, { operationId: `send-${randomUUID()}`,
      command: { type: 'message.send', conversationId: created, text: 'from B', replyTo: null, recipientIds: [] } })
    const messages = await a.store.messages(people.owner, tabId, created, {})
    expect(messages.messages.map(m => m.text)).toEqual(['from B'])
  })

  it('never shows one reader what only another may read, whichever reads first', async () => {
    const { tabId, privateId, secretGroup } = await privateScene()
    for (const order of [[people.peer, people.outsider], [people.outsider, people.peer]]) {
      const { reads } = pod()
      const seen = new Map<string, string[]>()
      for (const reader of order) seen.set(reader.sub, groupKeys(await reads.firstLoad(reader, tabId)))
      expect(seen.get(people.peer.sub)).toContain(privateId)
      expect(seen.get(people.outsider.sub)).not.toContain(privateId)
      expect(seen.get(people.outsider.sub)).not.toContain(secretGroup)
      expect(seen.get(people.peer.sub)).not.toContain(secretGroup)
    }
    const { reads } = pod()
    await reads.firstLoad(people.owner, tabId)
    const owners = await reads.firstLoad(people.owner, tabId)
    const outsiders = await reads.firstLoad(people.outsider, tabId)
    expect(groupKeys(owners)).toContain(secretGroup)
    expect(groupKeys(outsiders)).not.toContain(secretGroup)
    await expect(pod().store.messages(people.outsider, tabId, privateId, {})).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('reads Mongo directly while Redis is down, and stays right across writes', async () => {
    const { tabId } = await privateScene()
    const { reads, store, cache } = pod()
    await reads.firstLoad(people.owner, tabId)
    stamps.down = true
    const { result } = await store.execute(people.owner, tabId, { operationId: `create-${randomUUID()}`,
      command: { type: 'conversation.create', title: 'Redis down', brief: '', checks: [] } })
    const read = await partReads(() => reads.firstLoad(people.owner, tabId))
    expect(groupKeys(read.value)).toContain(result.conversationId)
    expect(read.reads).toBeGreaterThan(0)
    // This process held the Swarm from before the write, whose bump Redis missed: it is paid once Redis is back.
    expect(cache!.size.entries).toBeGreaterThan(0)
    stamps.down = false
    await vi.waitFor(async () => expect(groupKeys(await reads.firstLoad(people.owner, tabId))).toContain(result.conversationId), { timeout: 5_000 })
  })

  it('reads directly with the read cache switched off', async () => {
    const { tabId } = await privateScene()
    const { reads } = pod({ cache: null })
    await reads.firstLoad(people.owner, tabId)
    expect((await partReads(() => reads.firstLoad(people.owner, tabId))).reads).toBeGreaterThan(0)
  })
})

describe('composing a read from what the cache holds', () => {
  it('gives the state loadActive gives, for every way a read names what it needs', async () => {
    const { tabId, web, lead } = await privateScene()
    // A quiet conversation with the Lead in it, and a finished start.
    const quiet = (await db.swarmGroup.findFirstOrThrow({ where: { tabId, key: { notIn: [web, 'lead'] }, kind: null, dormant: false } })).key
    await db.swarmGroup.update({ where: { id: `${tabId}:${quiet}` }, data: { dormant: true } })
    const asLoaded = (p: parts.SwarmParts) => {
      const state = parts.reassemble(p)
      return { ...state, conversations: [...state.conversations].sort((a, b) => a.id.localeCompare(b.id)) }
    }
    const cache = new SwarmCache(stamps)
    for (const named of [{}, { includeRecentStarts: true }, { groupIds: [quiet] }, { groupIds: [quiet, 'missing'] }, { agentIds: [lead] },
      { projectIds: ['lead'] }, { allGroups: true }, { startIds: ['none'] }]) {
      const direct = await db.$transaction(tx => parts.loadActive(tx, tabId, named))
      const view = await cache.at([tabId])
      expect(asLoaded(await readParts(db, view, tabId, named)), JSON.stringify(named)).toEqual(asLoaded(direct))
    }
  })
})
