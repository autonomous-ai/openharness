import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { MongoMemoryReplSet } from 'mongodb-memory-server-core'
import type { PrismaClient } from '@prisma/client'
import type { AuthUser } from '../src/lib/ssoAuth.js'
import { SuperTabStore } from '../src/superTabs/store.js'
import { listGroupIndexes } from '../src/superTabs/parts/indexed.js'
import { RETENTION_MS } from '../src/superTabs/parts/types.js'
import { sweepSwarms } from '../src/superTabs/sweeps.js'
import type { ProfileEntry } from './bench/profile.js'
import { planDatabase, plan, profiled, reads } from './plans.test-support.js'

// Roadmap Phase 3.6: the hourly Swarm sweeps read across every Swarm, so a sweep no index bounds reads every part of every
// Swarm. Each sweep's read here examines only the parts it changes. A fresh loopback replica set; never DATABASE_URL.
let replica: MongoMemoryReplSet
let db: PrismaClient
let store: SuperTabStore
const NOW = Date.parse('2026-10-29T08:00:00Z')
const DAY = 86_400_000
const OLD = new Date(NOW - 30 * DAY)
const maker: AuthUser = { sub: randomUUID().replaceAll('-', '').slice(0, 24), email: 'sweeper@example.com', autonomousEnv: 'prod', role: 'user' }
let tabs: string[]
let entries: ProfileEntry[]
let result: Awaited<ReturnType<typeof sweepSwarms>>
/** Parts that no sweep changes, in each collection a sweep reads: an unbounded sweep examines these too. */
const QUIET = 10

const part = (tabId: string, key: string, fields: Record<string, unknown> = {}) => ({ id: `${tabId}:${key}`, tabId, key, version: 1, changedAt: OLD,
  ordinal: 1, data: { id: key }, ...fields })

beforeAll(async () => {
  ({ replica, db } = await planDatabase('swarm_sweep_plans_test'))
  store = new SuperTabStore(db, () => NOW)
  await listGroupIndexes(db)
  await db.user.create({ data: { id: maker.sub, externalId: `fixture-${maker.sub}`, email: maker.email, autonomousEnv: 'prod' } })
  tabs = []
  for (let i = 0; i < 4; i++) tabs.push((await store.create(maker, randomUUID(), `Swept ${i}`)).id)
  const [tab] = tabs as [string]
  const due = new Date(NOW - DAY), later = new Date(NOW + DAY)
  // Tombstones of people, agents and machines: two past their purge time, one not yet, and quiet live parts.
  const agent = { machineId: 'm', machineOwnerId: maker.sub, contributorId: maker.sub }
  const machine = { machineId: 'm', cleanupOwnerIds: [] }
  for (const [model, extra] of [['swarmMember', {}], ['swarmAgent', agent], ['swarmMachine', machine]] as const) {
    await (db[model] as unknown as { createMany(args: unknown): Promise<unknown> }).createMany({ data: [
      part(tab, `${model}:due-1`, { ...extra, deleted: true, purgeAt: due }), part(tab, `${model}:due-2`, { ...extra, deleted: true, purgeAt: due }),
      part(tab, `${model}:later`, { ...extra, deleted: true, purgeAt: later }),
      // Compacted by an earlier sweep: its purge time is gone, and it is never compacted again.
      part(tab, `${model}:compacted`, { ...extra, deleted: true, purgeAt: null, data: {} }),
      ...Array.from({ length: QUIET }, (_, i) => part(tab, `${model}:live-${i}`, { ...extra, deleted: false, purgeAt: null })),
    ] })
  }
  // Starts: two finished past retention, finished ones already removed (tombstones until their purge), and running ones.
  const start = { machineId: 'm', conversationId: 'c', agentId: null }
  await db.swarmStart.createMany({ data: [
    part(tab, 'start:expired-1', { ...start, finishedAt: new Date(NOW - RETENTION_MS - DAY), deleted: false }),
    part(tab, 'start:expired-2', { ...start, finishedAt: new Date(NOW - RETENTION_MS - DAY), deleted: false }),
    ...Array.from({ length: QUIET }, (_, i) => part(tab, `start:removed-${i}`, { ...start, finishedAt: new Date(NOW - RETENTION_MS - DAY), deleted: true, purgeAt: later })),
    ...Array.from({ length: QUIET }, (_, i) => part(tab, `start:running-${i}`, { ...start, finishedAt: null, deleted: false })),
  ] })
  // One Swarm has an invitation that has expired, and its row's invitation index names it (parts/commit.ts).
  const head = await db.swarmHead.findUniqueOrThrow({ where: { id: `${tabs[1]}:head` } })
  await db.swarmHead.update({ where: { id: head.id }, data: { data: { ...head.data as object, invitations: [{ id: 'i1', email: 'late@example.com', role: 'viewer',
    conversationId: 'lead', invitedBy: maker.sub, expiresAt: NOW - DAY }] } } })
  await db.superTab.update({ where: { id: tabs[1]! }, data: { invitedEmails: { set: ['late@example.com'] } } })
  entries = await profiled(db, async () => { result = await sweepSwarms(db, NOW) })
})
afterAll(async () => {
  await db?.$disconnect()
  await replica?.stop()
})

describe('the hourly sweeps', () => {
  it('compacts only tombstones past their purge time, each collection by its purge index', async () => {
    expect(result.tombstonesCompacted).toBe(6)
    for (const collection of ['SwarmMember', 'SwarmAgent', 'SwarmMachine']) {
      // The due tombstones are found by the purge index, then compacted by id.
      const found = reads(entries, collection, ['purgeAt']).filter(e => e.op !== 'update')
      expect(found, `${collection}: ${JSON.stringify(plan(found))}`).toHaveLength(1)
      expect(found[0]!.docsExamined, `${collection}: ${JSON.stringify(plan(found))}`).toBeLessThanOrEqual(2)
      expect(found[0]!.planSummary, collection).toMatch(/IXSCAN \{ purgeAt: 1 \}/)
      const written = reads(entries, collection, ['purgeAt']).filter(e => e.op === 'update')
      expect(written.map(e => e.docsExamined), `${collection}: ${JSON.stringify(plan(written))}`).toEqual([2])
    }
    const kept = await db.swarmMember.findUniqueOrThrow({ where: { id: `${tabs[0]}:swarmMember:later` } })
    expect(kept.data).toEqual({ id: 'swarmMember:later' })
  })

  it('never removes a start that has not finished', async () => {
    const running = await db.swarmStart.findMany({ where: { tabId: tabs[0]!, key: { startsWith: 'start:running-' } }, select: { key: true, deleted: true } })
    expect(running.filter(r => r.deleted).map(r => r.key)).toEqual([])
  })

  it('expires only finished starts past retention, never reading removed or running ones', async () => {
    expect(result.startsExpired).toBe(2)
    const rows = reads(entries, 'SwarmStart', ['finishedAt'])
    expect(rows, JSON.stringify(plan(rows))).toHaveLength(1)
    expect(rows[0]!.docsExamined, JSON.stringify(plan(rows))).toBeLessThanOrEqual(2)
    expect(rows[0]!.command?.hint, `the read names its index: ${JSON.stringify(plan(rows))}`).toBeTruthy()
  })

  it('reads the heads of only the Swarms with invitations', async () => {
    expect(result.invitationsExpired).toBe(1)
    expect((await db.superTab.findUniqueOrThrow({ where: { id: tabs[1]! } })).invitedEmails).toEqual([])
    const heads = entries.filter(e => e.ns.endsWith('.SwarmHead') && e.op !== 'update')
    const examined = heads.reduce((sum, e) => sum + (e.docsExamined ?? 0), 0)
    // The invited Swarm's head, read once to expire and once by its guarded write; never the other three.
    expect(examined, JSON.stringify(plan(heads))).toBeLessThanOrEqual(2)
    const invited = reads(entries, 'SuperTab', ['invitedEmails'])
    expect(invited, JSON.stringify(plan(invited))).toHaveLength(1)
    expect(invited[0]!.docsExamined, JSON.stringify(plan(invited))).toBeLessThanOrEqual(1)
  })
})
