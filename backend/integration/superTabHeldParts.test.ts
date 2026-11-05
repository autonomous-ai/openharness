import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { MongoMemoryReplSet } from 'mongodb-memory-server-core'
import { PrismaClient } from '@prisma/client'
import { configureSwarmStamps, swarmTransaction } from '../src/superTabs/cache.js'
import { MemoryStamps } from '../src/superTabs/cache.test-support.js'
import * as parts from '../src/superTabs/parts/index.js'
import { HeldParts } from '../src/superTabs/parts/held.js'
import { guardedWrite } from '../src/superTabs/parts/write.js'
import { migrateSwarm } from '../src/superTabs/migration/migrate.js'
import type { SuperTabState } from '../src/superTabs/model.js'
import { writeLegacySwarm } from '../scripts/swarm-parts/legacy.js'
import { richSwarm } from '../src/superTabs/read/fixture.test-support.js'
import { profiled } from './plans.test-support.js'

// A full machine report reads the parts it already holds at their exact version from memory (B3, #2597): what it loads must
// equal what a server holding nothing loads, after every kind of write a part can take. A fresh loopback replica set; this
// suite never reads DATABASE_URL.
let replica: MongoMemoryReplSet
let db: PrismaClient

beforeAll(async () => {
  replica = await MongoMemoryReplSet.create({ binary: { version: '7.0.24', downloadDir: join(tmpdir(), 'harness-super-tab-mongodb-binaries') },
    replSet: { count: 1, ip: '127.0.0.1', storageEngine: 'wiredTiger' } })
  const uri = replica.getUri(`swarm_held_parts_test_${randomUUID().replaceAll('-', '_')}`)
  await promisify(execFile)(join(process.cwd(), 'node_modules/.bin/prisma'), ['db', 'push', '--skip-generate'], {
    env: { ...process.env, DATABASE_URL: uri }, timeout: 60000,
  })
  db = new PrismaClient({ datasources: { db: { url: uri } } })
})
afterAll(async () => {
  await db?.$disconnect()
  await replica?.stop()
})
beforeEach(() => configureSwarmStamps(new MemoryStamps()))
afterEach(() => configureSwarmStamps(null))

async function scene(): Promise<string> {
  const s = richSwarm(Date.now())
  s.contribute('spare')
  const tabId = `tab-${randomUUID()}`
  await writeLegacySwarm(db, { state: { ...structuredClone(s.state), id: tabId } as SuperTabState, revision: 10 })
  const report = await migrateSwarm(db, tabId)
  if (!report.ok) throw new Error(report.error)
  return tabId
}

/** One write, committed as a command commits it: in a Swarm transaction, guarded by the version read in it. */
async function write(tabId: string, pick: (all: parts.SwarmParts) => parts.PartWrite | null, stamp = Date.now()): Promise<boolean> {
  return swarmTransaction(db, async tx => {
    const change = pick(await parts.loadAll(tx, tabId))
    if (!change) return false
    await guardedWrite(tx, tabId, change, stamp)
    return true
  })
}

const liveOf = <T>(list: parts.Part<T>[]) => list.filter(p => !p.deleted)
const observed = (tabId: string, held: HeldParts) => db.$transaction(tx => parts.loadObserved(tx, tabId, 'host', held))
/** A command's load (store.ts loadRow), naming one quiet conversation as a command naming it does. */
const commanded = (tabId: string, held: HeldParts, groupIds: string[] = []) => db.$transaction(tx => parts.loadActive(tx, tabId, { groupIds }, held))

describe('a full report\'s held parts (B3, #2597)', () => {
  it('load what a server holding nothing loads, after every kind of write', { timeout: 120_000 }, async () => {
    const tabId = await scene()
    // One server that keeps what it read, and one whose cap holds almost nothing.
    const warm = new HeldParts(), tiny = new HeldParts(1)
    let n = 0
    const at = () => Date.now() + ++n
    const cases: Array<[string, () => Promise<boolean>]> = [
      ['another machine\'s settings', () => write(tabId, all => { const m = liveOf(all.machines).find(x => x.key !== 'host')!
        return { op: 'update', kind: 'machine', key: m.key, seen: m.version, data: { ...m.data!, contribution: { ...m.data!.contribution!, name: `M${n}` } },
          host: { hostChangedAt: new Date() } } }, at())],
      ['another machine\'s reading alone (dated readAt)', () => write(tabId, all => { const m = liveOf(all.machines).find(x => x.key !== 'host')!
        return { op: 'update', kind: 'machine', key: m.key, seen: m.version, data: { ...m.data!, ordinalNote: n } as never } }, at())],
      ['the reporting machine\'s reading', () => write(tabId, all => { const m = liveOf(all.machines).find(x => x.key === 'host')!
        return { op: 'update', kind: 'machine', key: m.key, seen: m.version, data: { ...m.data!, ordinalNote: n } as never } }, at())],
      ['a part touched (its version alone moves)', () => write(tabId, all => { const m = liveOf(all.machines).find(x => x.key !== 'host')!
        return { op: 'touch', kind: 'machine', key: m.key, seen: m.version } }, at())],
      ['a machine removed', () => write(tabId, all => { const m = liveOf(all.machines).find(x => x.key === 'spare')!
        return { op: 'remove', kind: 'machine', key: m.key, seen: m.version, data: m.data } }, at())],
      ['a machine added again under its key', () => write(tabId, all => { const m = all.machines.find(x => x.key === 'spare')!
        return { op: 'insert', kind: 'machine', key: m.key, ordinal: m.ordinal, data: m.data } }, at())],
      ['a new machine', () => write(tabId, all => { const m = liveOf(all.machines).find(x => x.key === 'spare')!
        return { op: 'insert', kind: 'machine', key: `new-${n}`, ordinal: 900 + n, data: { ...m.data!, machineId: `new-${n}` } } }, at())],
      ['a post in running work', () => write(tabId, all => { const g = liveOf(all.groups).find(x => x.data!.assignment?.status === 'working')!
        return { op: 'update', kind: 'group', key: g.key, seen: g.version, data: { ...g.data!, title: `T${n}` } } }, at())],
      ['running work ends', () => write(tabId, all => { const g = liveOf(all.groups).find(x => x.data!.assignment?.status === 'working')!
        return { op: 'update', kind: 'group', key: g.key, seen: g.version, data: { ...g.data!, assignment: { ...g.data!.assignment!, status: 'done' } } } }, at())],
      ['a Lead conversation put to sleep', () => write(tabId, all => { const g = liveOf(all.groups).find(x => x.key === 'lead')!
        return { op: 'update', kind: 'group', key: g.key, seen: g.version, data: { ...g.data!, dormant: true } } }, at())],
      ['and woken', () => write(tabId, all => { const g = liveOf(all.groups).find(x => x.key === 'lead')!
        return { op: 'update', kind: 'group', key: g.key, seen: g.version, data: { ...g.data!, dormant: false } } }, at())],
      ['running work removed', () => write(tabId, all => { const g = liveOf(all.groups).find(x => !!x.data!.assignment?.execution && x.key !== 'lead')
        return g ? { op: 'remove', kind: 'group', key: g.key, seen: g.version, data: g.data } : null }, at())],
      ['new running work', () => write(tabId, all => { const g = all.groups.find(x => !!x.data!.assignment?.execution)!
        return { op: 'insert', kind: 'group', key: `g-${n}`, ordinal: 900 + n, data: { ...g.data!, id: `g-${n}`, assignment: { ...g.data!.assignment!, status: 'working' } } } }, at())],
      ['a part rewritten at the version it had, under a new date (purged, then added again)', async () => {
        const row = await db.swarmMachine.findFirstOrThrow({ where: { tabId, key: { not: 'host' }, deleted: false } })
        await db.swarmMachine.update({ where: { id: row.id }, data: { changedAt: new Date(at()), data: { ...row.data as object, ordinalNote: 'rewritten' } } })
        return true
      }],
    ]
    expect(await observed(tabId, warm)).toEqual(await observed(tabId, new HeldParts()))
    for (const [name, change] of cases) {
      expect(await change(), name).toBe(true)
      const fresh = await observed(tabId, new HeldParts())
      expect(await observed(tabId, warm), name).toEqual(fresh)
      expect(await observed(tabId, tiny), name).toEqual(fresh)
    }
  })

  it('reads the machines\' columns through the Swarm\'s index, examining only what it returns, and whole only the one that changed', async () => {
    const tabId = await scene()
    await scene()
    const held = new HeldParts()
    await observed(tabId, held)
    await write(tabId, all => { const m = liveOf(all.machines).find(x => x.key === 'host')!
      return { op: 'update', kind: 'machine', key: m.key, seen: m.version, data: m.data } })
    const entries = (await profiled(db, () => observed(tabId, held))).filter(e => e.ns.endsWith('.SwarmMachine'))
    const live = (await db.swarmMachine.count({ where: { tabId, deleted: false } }))
    expect(entries.map(e => [e.planSummary?.startsWith('IXSCAN') || e.planSummary === 'IDHACK' || e.planSummary === 'EXPRESS_IXSCAN', e.docsExamined, e.nreturned]))
      .toEqual([[true, live, live], [true, 1, 1]])
  })
})

describe('a command\'s held conversations (#3146)', () => {
  it('load what a server holding nothing loads, after every kind of conversation write', { timeout: 120_000 }, async () => {
    const tabId = await scene()
    const warm = new HeldParts(), tiny = new HeldParts(1)
    let n = 0
    const at = () => Date.now() + ++n
    const someGroup = (all: parts.SwarmParts) => liveOf(all.groups).find(x => !x.dormant && x.key !== 'lead')!
    const cases: Array<[string, () => Promise<boolean>]> = [
      ['a post in a conversation', () => write(tabId, all => { const g = someGroup(all)
        return { op: 'update', kind: 'group', key: g.key, seen: g.version, data: { ...g.data!, title: `T${n}` } } }, at())],
      ['a conversation touched (its version alone moves)', () => write(tabId, all => { const g = someGroup(all)
        return { op: 'touch', kind: 'group', key: g.key, seen: g.version } }, at())],
      ['a conversation put to sleep', () => write(tabId, all => { const g = liveOf(all.groups).find(x => x.key === 'lead')!
        return { op: 'update', kind: 'group', key: g.key, seen: g.version, data: { ...g.data!, dormant: true } } }, at())],
      ['and woken', () => write(tabId, all => { const g = liveOf(all.groups).find(x => x.key === 'lead')!
        return { op: 'update', kind: 'group', key: g.key, seen: g.version, data: { ...g.data!, dormant: false } } }, at())],
      ['a conversation removed', () => write(tabId, all => { const g = someGroup(all)
        return { op: 'remove', kind: 'group', key: g.key, seen: g.version, data: g.data } }, at())],
      ['a new conversation', () => write(tabId, all => { const g = someGroup(all)
        return { op: 'insert', kind: 'group', key: `g-${n}`, ordinal: 900 + n, data: { ...g.data!, id: `g-${n}`, title: `New ${n}` } } }, at())],
      ['a conversation rewritten at the version it had, under a new date', async () => {
        const row = await db.swarmGroup.findFirstOrThrow({ where: { tabId, deleted: false, dormant: false, key: { not: 'lead' } } })
        await db.swarmGroup.update({ where: { id: row.id }, data: { changedAt: new Date(at()), data: { ...row.data as object, title: 'rewritten' } } })
        return true
      }],
    ]
    expect(await commanded(tabId, warm)).toEqual(await commanded(tabId, new HeldParts()))
    for (const [name, change] of cases) {
      expect(await change(), name).toBe(true)
      const fresh = await commanded(tabId, new HeldParts())
      expect(await commanded(tabId, warm), name).toEqual(fresh)
      expect(await commanded(tabId, tiny), name).toEqual(fresh)
      // A command naming a quiet conversation loads it too, and the next one without it does not.
      const quiet = (await db.swarmGroup.findFirst({ where: { tabId, deleted: false, dormant: true } }))?.key
      if (quiet) {
        expect(await commanded(tabId, warm, [quiet]), name).toEqual(await commanded(tabId, new HeldParts(), [quiet]))
        expect(await commanded(tabId, warm), name).toEqual(fresh)
      }
    }
  })
})
