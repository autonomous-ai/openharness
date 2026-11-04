/**
 * What three per-request reads cost (task #2674, Ken's prod scan of 2026-11-04 12:00 VN): the decisions list, the leaderboard
 * and the mentions list. Each answers exactly what a read straight from Mongo answers (a store without the read cache), and
 * reads only what changed since its Swarm's last stamp.
 */
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { MongoMemoryReplSet } from 'mongodb-memory-server-core'
import type { PrismaClient } from '@prisma/client'
import type { AuthUser } from '../src/lib/ssoAuth.js'
import { SuperTabStore } from '../src/superTabs/store.js'
import { migrateSwarm } from '../src/superTabs/migration/migrate.js'
import * as parts from '../src/superTabs/parts/index.js'
import { swarmTransaction } from '../src/superTabs/cache.js'
import { guardedWrite } from '../src/superTabs/parts/write.js'
import { SwarmReads } from '../src/superTabs/read/service.js'
import { stableId, type Author, type Conversation, type SuperTabState } from '../src/superTabs/model.js'
import type { DecisionList } from '../src/superTabs/decisions.js'
import { WEEK_MS, weekStart } from '../src/superTabs/leaderboard/week.js'
import { writeLegacySwarm } from '../scripts/swarm-parts/legacy.js'
import { NOW, owner as ownerActor, peer as peerActor, swarm } from '../src/superTabs/read/fixture.test-support.js'
import { filterOf, planDatabase, profiled } from './plans.test-support.js'
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
 *  still active, a worker waiting on the owner, the owner's open and answered decisions (one in the dormant chat) and three
 *  tags of the owner's, one a reply in a thread. */
async function scene() {
  const s = swarm(NOW)
  s.join(peerActor)
  const lead = s.add('lead-harness', 'lead', true)
  const fresh = s.group('Fresh'), old = s.group('Old'), lastWeek = s.group('Last week'), waiting = s.group('Waiting')
  const worker = s.add('worker-harness', waiting)
  s.run({ type: 'work.assign', conversationId: waiting, agentId: worker })
  s.edit(state => {
    const done = { id: 'done', agentId: worker, status: 'done' as const, result: PR, configuration: state.agents[0]!.configuration,
      execution: { machineId: 'host', harnessId: 'h', machineOwnerId: owner.sub } }
    const ship = (id: string, shippedAt: number) => Object.assign(state.conversations.find(c => c.id === id)!,
      { requesterId: peer.sub, assignment: done, pullRequestUrls: [PR], ledger: { askedAt: shippedAt - 2 * HOUR, shippedAt } })
    ship(fresh, NOW - HOUR)
    ship(old, WEEK - WEEK_MS - DAY)
    ship(lastWeek, WEEK - 2 * DAY)
    Object.assign(state.conversations.find(c => c.id === old)!, { dormant: true, lastActivityAt: new Date(WEEK - WEEK_MS - DAY).toISOString() })
  })
  const tabId = `tab-${randomUUID()}`
  await writeLegacySwarm(db, { state: { ...structuredClone(s.state), id: tabId } as SuperTabState, revision: 50 })
  const report = await migrateSwarm(db, tabId, { now: () => NOW - 60_000 })
  if (!report.ok) throw new Error(report.error)
  const decision = (id: string, conversationId: string, answered: boolean) => db.superTabDecision.create({ data: { id: `${tabId}-${id}`, tabId,
    batchId: `${tabId}-batch-${id}`, projectId: 'lead', conversationId, assignmentId: null, personId: owner.sub, askerAgentId: worker,
    question: `Question ${id}?`, options: ['Yes', 'No'], recommended: 0, unblocks: 'the work', createdAt: new Date(NOW - DAY),
    ...answered ? { answeredAt: new Date(NOW - HOUR), choice: 1 } : {} } })
  await decision('open', waiting, false)
  await decision('quiet', old, false)
  await decision('answered', waiting, true)
  const agent: Author = { kind: 'agent', id: worker, name: 'Worker', membershipGeneration: 'fixture' }
  const root = await say(tabId, waiting, agent, [owner])
  await say(tabId, waiting, agent, [owner], root)
  await say(tabId, fresh, agent, [owner])
  return { tabId, lead, worker, fresh, old, lastWeek, waiting }
}

/** Stores a message tagging `tags` as the store stores one (numbered after the chat's newest), with its tags; answers its id. */
async function say(tabId: string, conversationId: string, author: Author, tags: AuthUser[], thread?: string) {
  const id = `m-${randomUUID()}`
  await swarmTransaction(db, async tx => {
    const current = (await parts.loadActive(tx, tabId, { groupIds: [conversationId] })).groups.find(g => g.key === conversationId)!
    const data = structuredClone(current.data!) as Conversation
    const sequence = (data.messageSeq ?? 0) + 1
    data.messageSeq = data.lastMessageSequence = sequence
    if (!thread) data.lastMainSequence = sequence
    await tx.superTabMessage.create({ data: { id, tabId, conversationId, sequence, author: author as never, text: `Please look ${sequence}.`,
      thread: thread ?? id, recipientIds: [], mentions: tags.map(t => t.sub), createdAt: new Date(NOW - sequence * 60_000) } })
    await guardedWrite(tx, tabId, { op: 'update', kind: 'group', key: conversationId, seen: current.version, data }, Date.now())
    for (const tagged of tags) {
      await tx.superTabMention.create({ data: { id: stableId(tabId, id, tagged.sub), tabId, personId: tagged.sub, projectId: 'lead', conversationId,
        messageId: id, authorAgentId: author.id, createdAt: new Date(NOW - sequence * 60_000), resolvedAt: null, resolvedBy: null } })
    }
  })
  return id
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

describe('the decisions list (GET /decisions)', () => {
  it('reads no Swarm part again at an unchanged stamp, and answers as a read straight from Mongo', async () => {
    const s = await scene()
    for (const list of ['open', 'answered', 'settled'] as DecisionList[]) {
      const first = await cached.decisions(owner, s.tabId, list)
      expect(first, list).toEqual(await direct.decisions(owner, s.tabId, list))
      const again = await partReads(() => cached.decisions(owner, s.tabId, list))
      expect(again.value, list).toEqual(first)
      // Only the quiet conversation a decision names, by its key; never the members, agents, machines, starts or active groups.
      expect(again.byCollection, list).toEqual(list === 'answered' ? {} : { SwarmGroup: 1 })
    }
    expect((await cached.decisions(owner, s.tabId, 'open')).decisions.map(d => d.question).toSorted()).toEqual(['Question open?', 'Question quiet?'])
  })

  it('answers as a direct read after the Swarm changes', async () => {
    const s = await scene()
    await cached.decisions(owner, s.tabId, 'open')
    await edit(s.tabId, s.waiting, group => { group.title = 'Waiting, renamed' })
    expect(await cached.decisions(owner, s.tabId, 'open')).toEqual(await direct.decisions(owner, s.tabId, 'open'))
    expect((await cached.decisions(owner, s.tabId, 'open')).decisions.map(d => d.conversationTitle)).toContain('Waiting, renamed')
  })
})

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

describe('the mentions list (GET /mentions)', () => {
  it('reads the tagged messages by one plain $in on their ids, through the id index, and answers as before', async () => {
    const s = await scene()
    const expected = await direct.mentions(owner, s.tabId, 'waiting')
    expect(expected.mentions).toHaveLength(3)
    let answer: Awaited<ReturnType<SuperTabStore['mentions']>> | undefined
    const entries = await profiled(db, async () => { answer = await cached.mentions(owner, s.tabId, 'waiting') })
    expect(answer).toEqual(expected)
    // The tagged messages' read: Prisma's `id: { in }` went as an `$expr` OR of one branch per id (slow planning on prod).
    const byId = entries.filter(e => e.ns.endsWith('.SuperTabMessage') && JSON.stringify(filterOf(e)).includes(expected.mentions[0]!.messageId))
    expect(byId).toHaveLength(1)
    const filter = JSON.stringify(filterOf(byId[0]!))
    expect(filter).not.toMatch(/\$expr|\$or/)
    expect(filter).toMatch(/"_id":\{"\$in":/)
    expect(byId[0]!.planSummary).toMatch(/^IXSCAN/)
  })
})
