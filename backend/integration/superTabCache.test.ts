import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
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

// The per-process Swarm cache (superTabs/cache.ts, Stability Roadmap 2.2) on a fresh loopback replica set; Redis is
// MemoryStamps, one store of stamps every "pod" here shares. This suite never reads DATABASE_URL or an existing database.
let replica: MongoMemoryReplSet
let db: PrismaClient
let stamps: MemoryStamps
const user = (n: number): AuthUser => ({ sub: `6a00000000000000000000${String(n).padStart(2, '0')}`, email: `cache-${n}@example.com`, autonomousEnv: 'prod', role: 'user' })
const [owner] = [user(0)]

beforeAll(async () => {
  replica = await MongoMemoryReplSet.create({ binary: { version: '7.0.24', downloadDir: join(tmpdir(), 'harness-super-tab-mongodb-binaries') },
    replSet: { count: 1, ip: '127.0.0.1', storageEngine: 'wiredTiger' } })
  const uri = replica.getUri(`swarm_cache_test_${randomUUID().replaceAll('-', '_')}`)
  await promisify(execFile)(join(process.cwd(), 'node_modules/.bin/prisma'), ['db', 'push', '--skip-generate'], {
    env: { ...process.env, DATABASE_URL: uri }, timeout: 60000,
  })
  db = new PrismaClient({ datasources: { db: { url: uri } } })
  for (const each of [owner]) await db.user.create({ data: { id: each.sub, externalId: `fixture-${each.sub}`, email: each.email, autonomousEnv: 'prod' } })
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
    expect(swarmReadCache()!.size.entries).toBe(1)
    const bump = stamps.bump.bind(stamps)
    stamps.bump = async () => { throw new Error('Redis is unreachable') }
    await expect(send(store, tabId, lead, 'committed anyway')).resolves.toMatchObject({ result: { messageId: expect.any(String) } })
    stamps.bump = bump
    expect(await db.superTabMessage.count({ where: { tabId, text: 'committed anyway' } })).toBe(1)
    expect(swarmReadCache()!.size.entries).toBe(0)
  })
})

