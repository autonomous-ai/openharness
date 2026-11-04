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
import { configureSwarmStamps, swarmTransaction, SwarmCache } from '../src/superTabs/cache.js'
import { MemoryStamps } from '../src/superTabs/cache.test-support.js'
import { cacheDigest, startsOfRule } from '../src/superTabs/cachePatch.js'
import * as parts from '../src/superTabs/parts/index.js'
import { guardedWrite, startFinished } from '../src/superTabs/parts/write.js'
import { DIRECT, deriveLight, readChanged, readDelta, readLastChangedAt, readLight, readParts, type ReadNamed } from '../src/superTabs/cachedReads.js'
import { migrateSwarm } from '../src/superTabs/migration/migrate.js'
import { stableId, type SuperTabState } from '../src/superTabs/model.js'
import { writeLegacySwarm } from '../scripts/swarm-parts/legacy.js'
import { outsider as outsiderActor, owner as ownerActor, peer as peerActor, richSwarm } from '../src/superTabs/read/fixture.test-support.js'

// The read cache patched from deltas (spec docs/superpowers/specs/2026-11-02-swarm-cache-delta-design.md, Phases 1-2) against
// reads with no cache, after real writes, on a fresh loopback replica set. Setup as integration/superTabCache.test.ts.
let replica: MongoMemoryReplSet
let db: PrismaClient
let stamps: MemoryStamps
const person = (actor: { userId: string; email: string }): AuthUser => ({ sub: actor.userId, email: actor.email, autonomousEnv: 'prod', role: 'user' })
const people = { owner: person(ownerActor), peer: person(peerActor), outsider: person(outsiderActor) }

beforeAll(async () => {
  replica = await MongoMemoryReplSet.create({ binary: { version: '7.0.24', downloadDir: join(tmpdir(), 'harness-super-tab-mongodb-binaries') },
    replSet: { count: 1, ip: '127.0.0.1', storageEngine: 'wiredTiger' } })
  const uri = replica.getUri(`swarm_cache_delta_test_${randomUUID().replaceAll('-', '_')}`)
  await promisify(execFile)(join(process.cwd(), 'node_modules/.bin/prisma'), ['db', 'push', '--skip-generate'], {
    env: { ...process.env, DATABASE_URL: uri }, timeout: 60000,
  })
  db = new PrismaClient({ datasources: { db: { url: uri } } })
  for (const each of Object.values(people)) await db.user.create({ data: { id: each.sub, externalId: `fixture-${each.sub}`, email: each.email, autonomousEnv: 'prod' } })
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
  return { tabId, web: s.web, secret: s.secret }
}

/** A seeded generator, so a failure replays. */
function seeded(seed: number) {
  let x = seed
  return () => { x = (x * 1_103_515_245 + 12_345) % 2_147_483_648; return x / 2_147_483_648 }
}

/** One write, committed as a command commits: in a Swarm transaction, guarded by the version read in it. */
async function write(tabId: string, pick: (all: parts.SwarmParts) => parts.PartWrite | null, stamp = Date.now()): Promise<boolean> {
  return swarmTransaction(db, async tx => {
    const change = pick(await parts.loadAll(tx, tabId))
    if (!change) return false
    await guardedWrite(tx, tabId, change, stamp)
    return true
  })
}

const liveOf = <T>(list: parts.Part<T>[]) => list.filter(p => !p.deleted)

describe('the patched cache answers as reads with no cache do', () => {
  it('patched entries equal fresh loads after every write', { timeout: 120_000 }, async () => {
    const sceneStart = Date.now() - 60_000
    const { tabId, web, secret } = await scene()
    const delta = vi.fn(readDelta(db))
    const cache = new SwarmCache(stamps, { delta })
    const store = new SuperTabStore(db, Date.now, null, { readCache: cache })
    const random = seeded(20261102)
    const one = <T>(list: T[]): T | undefined => list[Math.floor(random() * list.length)]
    let n = 0

    const ops: Array<() => Promise<unknown>> = [
      // A conversation renamed.
      () => write(tabId, all => { const g = one(liveOf(all.groups)); return g ? { op: 'update', kind: 'group', key: g.key, seen: g.version, data: { ...g.data!, title: `T${++n}` } } : null }),
      // Put to sleep, and woken.
      () => write(tabId, all => { const g = one(liveOf(all.groups).filter(x => !x.dormant && x.key !== 'lead')); return g ? { op: 'update', kind: 'group', key: g.key, seen: g.version, data: { ...g.data!, dormant: true } } : null }),
      () => write(tabId, all => { const g = one(liveOf(all.groups).filter(x => x.dormant)); return g ? { op: 'update', kind: 'group', key: g.key, seen: g.version, data: { ...g.data!, dormant: false } } : null }),
      // An agent leaves a conversation (as its removal rewrites each conversation it is in).
      () => write(tabId, all => { const g = one(liveOf(all.groups).filter(x => x.data!.agentIds.length)); return g ? { op: 'update', kind: 'group', key: g.key, seen: g.version, data: { ...g.data!, agentIds: g.data!.agentIds.slice(1) } } : null }),
      // A start begins, finishes, and expires.
      () => write(tabId, all => ({ op: 'insert', kind: 'start', key: `s-${++n}`, ordinal: 1_000 + n, data: { id: `s-${n}`, harnessId: null, createdAt: new Date().toISOString(),
        request: { machineId: 'host', conversationId: web, harnessId: `h-${n}` } } })),
      () => write(tabId, all => { const s = one(liveOf(all.starts).filter(x => !x.data!.harnessId)); return s ? { op: 'update', kind: 'start', key: s.key, seen: s.version, data: { ...s.data!, harnessId: `${s.key}-harness` } } : null }),
      () => write(tabId, all => { const s = one(liveOf(all.starts).filter(x => !!x.data!.harnessId)); return s ? { op: 'remove', kind: 'start', key: s.key, seen: s.version, data: s.data } : null }),
      // An agent renamed; the head renamed.
      () => write(tabId, all => { const a = one(liveOf(all.agents)); return a ? { op: 'update', kind: 'agent', key: a.key, seen: a.version, data: { ...a.data!, name: `A${++n}` } } : null }),
      () => write(tabId, all => ({ op: 'update', kind: 'head', key: 'head', seen: all.head.version, data: { ...all.head.data!, name: `S${++n}` } })),
      // A machine's own reading (machine stamp only).
      () => write(tabId, all => { const m = one(liveOf(all.machines)); return m ? { op: 'update', kind: 'machine', key: m.key, seen: m.version, data: m.data } : null }),
      // A real command. Refused once earlier steps left the conversation with no agent to address: a refusal writes nothing.
      () => store.execute(people.owner, tabId, { operationId: `send-${randomUUID()}`, command: { type: 'message.send', conversationId: web, text: `m${++n}`, replyTo: null, recipientIds: [] } })
        .catch((error: { code?: string }) => { if (!error.code) throw error }),
    ]

    /** Every named form a read takes, from what the Swarm holds now. */
    async function namedForms(): Promise<ReadNamed[]> {
      const all = await parts.loadAll(db, tabId)
      const agents = liveOf(all.agents).map(a => a.key)
      const finished = liveOf(all.starts).filter(s => !!s.data!.harnessId)
      const dormant = liveOf(all.groups).filter(g => g.dormant).map(g => g.key)
      return [{}, { includeRecentStarts: true }, { startIds: finished.slice(0, 1).map(s => s.key) },
        { startAgentIds: finished.slice(0, 2).map(s => stableId(s.data!.request.machineId, s.data!.harnessId!)) },
        { agentIds: agents.slice(0, 1) }, { agentIds: agents.slice(0, 3) }, { projectIds: ['lead'] }, { projectIds: [secret, 'lead'] },
        { allGroups: true }, { groupIds: dormant.slice(0, 2) }]
    }

    const check = async (step: string) => {
      for (const named of await namedForms()) {
        const cached = await readParts(db, await cache.at([tabId]), tabId, named)
        const fresh = await readParts(db, DIRECT, tabId, named)
        expect(cacheDigest(cached), `${step} ${JSON.stringify(named)}`).toBe(cacheDigest(fresh))
        const active = await db.$transaction(tx => parts.loadActive(tx, tabId, named))
        expect(cacheDigest(fresh), `loadActive ${step} ${JSON.stringify(named)}`).toBe(cacheDigest(active))
      }
      expect(await readLastChangedAt(db, await cache.at([tabId]), tabId)).toBe(await readLastChangedAt(db, DIRECT, tabId))
      // Spec 2026-11-02 poll cost, Part 1: the change feed, the light base, each machine's host state and the starts of
      // listed agents, through the patching cache, against direct loads.
      const view = await cache.at([tabId])
      expect(cacheDigest(await readChanged(db, view, tabId, sceneStart)), `feed ${step}`).toBe(cacheDigest(await readChanged(db, DIRECT, tabId, sceneStart)))
      expect(cacheDigest(await readLight(db, view, tabId, { groups: 'working' })), `light ${step}`)
        .toBe(cacheDigest(await readLight(db, DIRECT, tabId, { groups: 'working' })))
      const all = await parts.loadAll(db, tabId)
      for (const machineId of new Set(liveOf(all.agents).map(a => (a.data as { machineId: string }).machineId))) {
        const agentIds = liveOf(all.agents).filter(a => (a.data as { machineId: string }).machineId === machineId).map(a => a.key)
        const starts = liveOf(all.starts).filter(s => !startFinished(s.data!) && s.data!.request.machineId === machineId)
        const groupIds = [...new Set(starts.map(s => s.data!.request.conversationId))]
        const projectIds = [...new Set(liveOf(all.groups).filter(g => groupIds.includes(g.key)).map(g => g.data!.projectId ?? 'lead'))]
        const fresh = await db.$transaction(tx => parts.loadLight(tx, tabId, { groups: 'working', agentIds, groupIds, projectIds, machines: false }))
        // Machines come from their own entry (read/host.ts tabState); the light load leaves them empty.
        expect(cacheDigest({ ...await deriveLight(db, view, tabId, { groups: 'working', machineId }), machines: [] }), `host state ${machineId} ${step}`)
          .toBe(cacheDigest(fresh))
      }
      const listed = [...new Set(liveOf(all.starts).filter(s => !!s.data!.harnessId).map(s => stableId(s.data!.request.machineId, s.data!.harnessId!)))].sort()
      if (listed.length) {
        const named = await view.get(tabId, `startsOf:${JSON.stringify(listed)}`, 'main', () => parts.loadStartsOfAgents(db, tabId, listed), startsOfRule(listed))
        expect(cacheDigest(named), `startsOf ${step}`).toBe(cacheDigest(await parts.loadStartsOfAgents(db, tabId, listed)))
      }
    }

    await check('start')
    for (let i = 0; i < 60; i++) {
      const op = Math.floor(random() * ops.length)
      await ops[op]!()
      await check(`step ${i} (op ${op})`)
    }
    // The cache patched rather than loaded again: one delta per Swarm and stamp, so about one per write that changed something.
    expect(delta.mock.calls.length).toBeGreaterThan(30)
  })

  it('a host state reads its agents\' quiet conversations light, as the host rows read them (B4, #2597)', async () => {
    const { tabId } = await scene()
    // A quiet conversation of an agent on the host, with the brief and checks a whole read would carry.
    const all = await parts.loadAll(db, tabId)
    const agent = liveOf(all.agents).find(a => (a.data as { machineId: string }).machineId === 'host')!.key
    const quiet = liveOf(all.groups).find(g => g.key !== 'lead' && g.data!.agentIds.includes(agent))!
    expect(await write(tabId, () => ({ op: 'update', kind: 'group', key: quiet.key, seen: quiet.version,
      data: { ...quiet.data!, dormant: true, brief: 'b'.repeat(20_000), checks: [{ id: 'c1', description: 'd'.repeat(5_000), independent: false, status: 'pending' }] } }))).toBe(true)
    const cache = new SwarmCache(stamps, { delta: readDelta(db) })
    await db.$runCommandRaw({ profile: 2 })
    const since = new Date()
    let state: Awaited<ReturnType<typeof deriveLight>>
    try {
      state = await deriveLight(db, await cache.at([tabId]), tabId, { groups: 'working', machineId: 'host' })
    } finally {
      await db.$runCommandRaw({ profile: 0 })
    }
    const rows = await db.$runCommandRaw({ find: 'system.profile', filter: { ts: { $gte: { $date: since.toISOString() } }, ns: { $regex: '\\.SwarmGroup$' },
      'command.pipeline.0.$match.agentIds': { $exists: true } }, projection: { _id: 0, responseLength: 1 } }) as { cursor: { firstBatch: Array<{ responseLength: number }> } }
    expect(state!.groups.map(g => g.key)).toContain(quiet.key)
    // The agent's read: light, so well under the brief it would carry whole.
    const bytes = rows.cursor.firstBatch.reduce((n, r) => n + r.responseLength, 0)
    expect(bytes).toBeGreaterThan(0)
    expect(bytes).toBeLessThan(10_000)
  })

  it('a write committed after the load but stamped 20 s earlier is in the next patch', async () => {
    const { tabId, web } = await scene()
    const cache = new SwarmCache(stamps, { delta: readDelta(db) })
    await readParts(db, await cache.at([tabId]), tabId)
    // A transaction that began 20 s ago commits now: its parts carry the time it wrote them.
    await write(tabId, all => { const g = all.groups.find(x => x.key === web)!; return { op: 'update', kind: 'group', key: web, seen: g.version, data: { ...g.data!, title: 'Late' } } },
      Date.now() - 20_000)
    const read = await readParts(db, await cache.at([tabId]), tabId)
    expect(read.groups.find(g => g.key === web)!.data!.title).toBe('Late')
  })
})
