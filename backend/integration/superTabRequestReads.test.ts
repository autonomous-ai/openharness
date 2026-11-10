/**
 * What a per-request read costs (task #2674, Ken's prod scan of 2026-11-04 12:00 VN): the leaderboard. It answers exactly what a
 * read straight from Mongo answers (a store without the read cache), and reads only what changed since its Swarm's last stamp.
 */
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { MongoMemoryReplSet } from 'mongodb-memory-server-core'
import type { PrismaClient } from '@prisma/client'
import type { AuthUser } from '../src/lib/ssoAuth.js'
import { SuperTabStore } from '../src/superTabs/store.js'
import * as parts from '../src/superTabs/parts/index.js'
import { swarmTransaction } from '../src/superTabs/cache.js'
import { guardedWrite } from '../src/superTabs/parts/write.js'
import { SwarmReads } from '../src/superTabs/read/service.js'
import { type Conversation, type SuperTabState } from '../src/superTabs/model.js'
import { WEEK_MS, weekStart } from '../src/superTabs/leaderboard/week.js'
import { storeSwarm } from './storedSwarm.test-support.js'
import { NOW, owner as ownerActor, peer as peerActor, swarm } from '../src/superTabs/read/fixture.test-support.js'
import { storedAssignment } from '../src/superTabs/storedWork.test-support.js'
import { planDatabase } from './plans.test-support.js'
import { profiledReads } from './profiledReads.test-support.js'

let replica: MongoMemoryReplSet
let db: PrismaClient
let cached: SuperTabStore, direct: SuperTabStore
let cachedReads: SwarmReads, directReads: SwarmReads
const user = (actor: { userId: string; email: string }): AuthUser => ({ sub: actor.userId, email: actor.email, autonomousEnv: 'prod', role: 'user' })
const [owner, peer] = [ownerActor, peerActor].map(user) as [AuthUser, AuthUser]
const WEEK = weekStart(NOW), HOUR = 3_600_000, DAY = 86_400_000
const PR = 'https://github.com/o/r/pull/9'

beforeAll(async () => {
  ({ replica, db } = await planDatabase('swarm_request_reads'))
  for (const each of [owner, peer]) await db.user.create({ data: { id: each.sub, externalId: `fixture-${each.sub}`, email: each.email, autonomousEnv: 'prod' } })
  // The read cache is on in these suites (cacheOn.test-support.ts); `direct` reads Mongo every time, as the answers to match.
  cached = new SuperTabStore(db, () => NOW)
  direct = new SuperTabStore(db, () => NOW, null, { readCache: null })
  cachedReads = new SwarmReads(cached, { now: () => NOW })
  directReads = new SwarmReads(direct, { now: () => NOW })
})
afterAll(async () => {
  await db?.$disconnect()
  await replica?.stop()
})

/** The Swarm part collections' reads MongoDB served while `run` ran, by collection. */
const partReads = <T>(run: () => Promise<T>) => profiledReads(db, /\.Swarm(Head|Member|Agent|Group|Machine|Start|Progress)$/, run)

/** A Swarm in parts: requests of peer's shipped this week and two weeks ago (dormant since), a third shipped last week and
 *  still active, a worker waiting on the owner, and three tags of the owner's, one a reply in a thread. */
async function scene() {
  const s = swarm(NOW)
  s.join(peerActor)
  const lead = s.add('lead-harness', 'lead', true)
  const fresh = s.group('Fresh'), old = s.group('Old'), lastWeek = s.group('Last week'), waiting = s.group('Waiting')
  const worker = s.add('worker-harness', waiting)
  s.edit(state => { storedAssignment(state, waiting, worker, NOW) })
  s.edit(state => {
    const done = { id: 'done', agentId: worker, status: 'done' as const, result: PR, configuration: state.agents[0]!.configuration,
      execution: { machineId: 'host', harnessId: 'h', machineOwnerId: owner.sub } }
    const ship = (id: string, shippedAt: number) => Object.assign(state.conversations.find(c => c.id === id)!,
      { requesterId: peer.sub, assignment: done, pullRequestUrls: [PR], ledger: { askedAt: shippedAt - 2 * HOUR, shippedAt, mergedAt: shippedAt } })
    ship(fresh, NOW - HOUR)
    ship(old, WEEK - WEEK_MS - DAY)
    ship(lastWeek, WEEK - 2 * DAY)
    Object.assign(state.conversations.find(c => c.id === old)!, { dormant: true, lastActivityAt: new Date(WEEK - WEEK_MS - DAY).toISOString() })
  })
  const tabId = `tab-${randomUUID()}`
  await storeSwarm(db, { state: { ...structuredClone(s.state), id: tabId } as SuperTabState, revision: 50 }, NOW - 60_000)
  return { tabId, lead, worker, fresh, old, lastWeek, waiting }
}

/** Changes one conversation's stored data as a command would, in a transaction that moves the Swarm's stamp. */
async function edit(tabId: string, conversationId: string, change: (group: Conversation) => void) {
  await swarmTransaction(db, async tx => {
    const [row] = await parts.loadGroups(tx, tabId, 'key', { key: conversationId })
    const data = structuredClone(row!.data!) as Conversation
    change(data)
    await guardedWrite(tx, tabId, { op: 'update', kind: 'group', key: conversationId, seen: row!.version, data }, Date.now())
  })
}

describe('the leaderboard (GET /leaderboard)', () => {
  const boards = (s: { tabId: string }, reads: SwarmReads) => Promise.all([
    reads.leaderboard(owner, s.tabId, 'lead'),
    reads.leaderboard(owner, s.tabId, 'lead', WEEK - WEEK_MS),
    reads.leaderboard(owner, s.tabId, 'lead', WEEK - 2 * WEEK_MS),
    reads.leaderboard(owner, s.tabId, 'lead', undefined, undefined, true),
  ])

  it('reads no dormant group again at an unchanged stamp, and answers as a read straight from Mongo', async () => {
    const s = await scene()
    const first = await boards(s, cachedReads)
    expect(first).toEqual(await boards(s, directReads))
    const again = await partReads(() => cachedReads.leaderboard(owner, s.tabId, 'lead', WEEK - 2 * WEEK_MS))
    expect(again.value).toEqual(first[2])
    expect(again.byCollection.SwarmGroup ?? 0).toBe(0)
  })

  it('answers as a direct read after a conversation goes quiet, wakes, gets newer activity or is removed', async () => {
    const s = await scene()
    await boards(s, cachedReads)
    const same = async (what: string) => expect(await boards(s, cachedReads), what).toEqual(await boards(s, directReads))
    await edit(s.tabId, s.lastWeek, group => Object.assign(group, { dormant: true, lastActivityAt: new Date(WEEK - 2 * DAY).toISOString() }))
    await same('last week\'s request went quiet')
    await edit(s.tabId, s.old, group => { group.lastActivityAt = new Date(WEEK - DAY).toISOString() })
    await same('a quiet one got newer activity')
    await edit(s.tabId, s.old, group => { delete group.dormant })
    await same('a quiet one woke')
    await swarmTransaction(db, async tx => {
      const [row] = await parts.loadGroups(tx, s.tabId, 'key', { key: s.lastWeek })
      await guardedWrite(tx, s.tabId, { op: 'remove', kind: 'group', key: s.lastWeek, seen: row!.version, data: row!.data }, Date.now())
    })
    await same('a quiet one was removed')
  })
})
