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
  stamps = new MemoryStamps()
  configureSwarmStamps(stamps, { reads: false })
  const store = new SuperTabStore(db, Date.now, null, { readCache: new SwarmCache(stamps, { delta: readDelta(db) }) })
  app = Fastify()
  app.setErrorHandler(errorHandler)
  // External SSO is replaced with fixture accounts; every permission and transaction below is real.
  app.addHook('onRequest', async (request, reply) => {
    const found = [owner, peer, outsider].find(u => `Bearer ${u.sub}` === request.headers.authorization)
    if (!found) return reply.code(401).send({ success: false })
    request.user = found
  })
  await app.register(superTabRoutes, { store, github: null, reads: new SwarmReads(store), hosts: new HostReads(store) })
  await app.ready()
})
afterAll(async () => {
  configureSwarmStamps(null)
  await app?.close()
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

const read = async (tabId: string, id: string, asAgentId?: string, as: AuthUser = owner) => {
  const response = await app.inject({ method: 'GET', url: `/api/super-tabs/${tabId}/groups/${id}${asAgentId ? `?asAgentId=${asAgentId}` : ''}`,
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
const describeRows = (rows: ProfileEntry[]) => rows.filter(r => r.op !== 'getmore').map(r =>
  `  ${r.ns.split('.').at(-1)} ${r.op} ${(r.planSummary ?? '').slice(0, 60)} docs=${r.docsExamined ?? 0} returned=${r.nreturned ?? 0} bytes=${r.responseLength ?? 0}`).join('\n')

describe('one group read by id (task #2875)', () => {
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
      // One group row by its key, never the Swarm's active groups.
      const groupRows = rows.filter(r => r.ns.endsWith('.SwarmGroup') && r.op !== 'getmore')
      expect(groupRows.reduce((n, r) => n + (r.nreturned ?? 0), 0), describeRows(groupRows)).toBeLessThanOrEqual(asAgentId ? 4 : 1)
    }
  }, 120_000)

  it(`answers a burst of 1,000 reads of ${QUIET} quiet groups by ${AGENTS} agents while the Swarm moves, without its change feeds`, async () => {
    const s = await scene()
    for (const agent of s.agents) expect((await read(s.tabId, s.quiet[0]!, agent)).status).toBe(200)
    const times: number[] = []
    const { rows } = await profiled(async () => {
      for (let wave = 0; wave < 10; wave++) {
        // The Swarm moves between waves, as a busy one does every second.
        await touch(s.tabId, s.busy[wave % s.busy.length]!)
        await Promise.all(Array.from({ length: 100 }, async (_, i) => {
          const started = performance.now()
          const answer = await read(s.tabId, s.quiet[(wave * 100 + i) % QUIET]!, s.agents[i % AGENTS])
          times.push(performance.now() - started)
          expect(answer.status).toBe(200)
        }))
      }
    })
    times.sort((a, b) => a - b)
    const feeds = feedReads(rows)
    console.info(`burst of 1,000 one group reads: ${rows.filter(r => r.op !== 'getmore').length} database reads, ${bytes(rows)} bytes, ` +
      `${dbMs(rows)} ms in the database; change feed reads ${feeds.length}, ${bytes(feeds)} bytes; per call p50 ${times[499]!.toFixed(1)} ms, ` +
      `p95 ${times[949]!.toFixed(1)} ms`)
    expect(feeds.length, describeRows(feeds)).toBe(0)
  }, 300_000)
})
