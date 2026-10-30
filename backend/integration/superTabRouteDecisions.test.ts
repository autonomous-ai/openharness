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
import { swarmTransaction } from '../src/superTabs/cache.js'
import { migrateSwarm } from '../src/superTabs/migration/migrate.js'
import { writeLegacySwarm } from '../scripts/swarm-parts/legacy.js'
import { author, type SuperTabState } from '../src/superTabs/model.js'
import { refuseBuddyRouting } from '../src/superTabs/buddies.js'
import { canReadGroup } from '../src/superTabs/projects.js'
import { recentDecisions, timedDecisionOf } from '../src/superTabs/routeDecisions.js'
import { listNamedIndexes } from '../src/superTabs/parts/indexed.js'
import { NOW, outsider as outsiderActor, owner as ownerActor, peer as peerActor, swarm } from '../src/superTabs/read/fixture.test-support.js'

// A fresh loopback replica set, created here. This suite never reads DATABASE_URL or an existing database.
// The Lead's route command reads the route-decision list on every route (prod watch 10-29: 13% of slow Swarm reads). The read
// used to load every group the Swarm ever made, dormant ones too, to learn which the reader may read: 6.7 MB per call for 1,200
// groups. These tests hold the answer to exactly what that read gave every reader, and the cost to the groups the decisions name.
let replica: MongoMemoryReplSet
let db: PrismaClient
let store: SuperTabStore
const user = (actor: { userId: string; email: string }): AuthUser => ({ sub: actor.userId, email: actor.email, autonomousEnv: 'prod', role: 'user' })
const [owner, peer, outsider] = [ownerActor, peerActor, outsiderActor].map(user) as [AuthUser, AuthUser, AuthUser]
const MIGRATED = NOW - 60_000
const DAY = 86_400_000

beforeAll(async () => {
  replica = await MongoMemoryReplSet.create({ binary: { version: '7.0.24', downloadDir: join(tmpdir(), 'harness-super-tab-mongodb-binaries') },
    replSet: { count: 1, ip: '127.0.0.1', storageEngine: 'wiredTiger' } })
  const uri = replica.getUri(`swarm_route_decisions_test_${randomUUID().replaceAll('-', '_')}`)
  await promisify(execFile)(join(process.cwd(), 'node_modules/.bin/prisma'), ['db', 'push', '--skip-generate'], {
    env: { ...process.env, DATABASE_URL: uri }, timeout: 60000,
  })
  db = new PrismaClient({ datasources: { db: { url: uri } } })
  for (const each of [owner, peer, outsider]) await db.user.create({ data: { id: each.sub, externalId: `fixture-${each.sub}`, email: each.email, autonomousEnv: 'prod' } })
  await db.machine.create({ data: { machineId: 'host', userId: owner.sub, apiKey: 'fixture-only', managerId: 'fixture', autonomousEnv: 'prod', authMode: 'remote' } })
  // The server lists the indexes hot reads name at start (watchGroupIndexes): a read names one only once it is listed.
  await listNamedIndexes(db)
  store = new SuperTabStore(db)
}, 120000)
afterAll(async () => {
  await db?.$disconnect()
  await replica?.stop()
})

/** A Swarm in parts: a Lead and a worker on the owner's machine, the Web group (active), a private project, the Docs project
 *  whose only worker is stored with no project of its own and whose only conversation is finished and quiet (dormant), a
 *  closed Chat with PM and a Buddy chat of the peer, and `quiet` finished public groups quiet for two days (dormant). */
async function world(quiet = 0) {
  const s = swarm(MIGRATED)
  s.join(peerActor)
  s.join(outsiderActor)
  const lead = s.add('lead-harness', 'lead', true, ownerActor, 'host', owner.sub)
  const secret = s.run({ type: 'project.create', name: 'Secret', visibility: 'private', brief: '' }).projectId as string
  const secretLead = s.add('secret-lead', s.state.projects!.find(p => p.id === secret)!.leadConversationId, true, ownerActor, 'host', owner.sub)
  const docs = s.run({ type: 'project.create', name: 'Docs', visibility: 'public', brief: '' }).projectId as string
  const web = s.group('Web')
  const worker = s.add('worker-harness', web, false, ownerActor, 'host', owner.sub)
  s.run({ type: 'work.assign', conversationId: web, agentId: worker })
  const secretGroup = s.group('Secret work', secret)
  const secretWorker = s.add('secret-worker', secretGroup, false, ownerActor, 'host', owner.sub)
  s.run({ type: 'work.assign', conversationId: secretGroup, agentId: secretWorker })
  const docsGroup = s.group('Docs work', docs)
  const docsWorker = s.add('docs-worker', docsGroup, false, ownerActor, 'host', owner.sub)
  s.run({ type: 'work.assign', conversationId: docsGroup, agentId: docsWorker })
  const peerChat = s.group('Peer and PM')
  const buddyChat = s.group('Peer\'s Buddy')
  const finished = Array.from({ length: quiet }, (_, i) => s.group(`Done ${i}`))
  s.edit(state => {
    const peerGeneration = state.people.find(p => p.id === peer.sub)!.generation
    state.conversations.find(c => c.id === peerChat)!.audience = { people: [{ id: peer.sub, generation: peerGeneration }] }
    Object.assign(state.conversations.find(c => c.id === buddyChat)!, { kind: 'buddy', leadId: null, agentIds: [], audience: { people: [{ id: peer.sub, generation: peerGeneration }] } })
    const done = (group: string, as: string) => { state.conversations.find(c => c.id === group)!.assignment = { ...state.conversations.find(c => c.id === web)!.assignment!, id: as, status: 'done' } }
    done(docsGroup, 'docs-done')
    finished.forEach((group, i) => done(group, `done-${i}`))
  })
  const tabId = `tab-${randomUUID()}`
  const state = { ...structuredClone(s.state), id: tabId } as SuperTabState
  const quietIds = [docsGroup, ...finished]
  await writeLegacySwarm(db, { state, revision: 700, messages: quietIds.map((id, i) => ({ id: `${tabId}-m${i}`, conversationId: id, sequence: i + 5, text: 'Done',
    author: { kind: 'person' as const, id: owner.sub, name: owner.email, membershipGeneration: tabId }, createdAt: new Date(MIGRATED - 2 * DAY) })) })
  const report = await migrateSwarm(db, tabId, { now: () => MIGRATED })
  if (!report.ok) throw new Error(report.error)
  // An agent stored with no project takes it from its first conversation (projects.ts agentProjectId); the migration gives every
  // agent of a Swarm with projects its own, so the part is changed as an older write left it.
  const stored = await db.swarmAgent.findFirstOrThrow({ where: { tabId, key: docsWorker } })
  const { projectId: _project, ...legacy } = stored.data as Record<string, unknown>
  await db.swarmAgent.update({ where: { id: stored.id }, data: { data: legacy as never } })
  expect((await db.swarmGroup.findFirst({ where: { tabId, key: docsGroup } }))?.dormant, 'the Docs worker\'s only conversation is quiet').toBe(true)
  return { tabId, lead, worker, docsWorker, secretWorker, secretLead, web, docsGroup, secretGroup, peerChat, buddyChat, finished }
}
type World = Awaited<ReturnType<typeof world>>

/** Decisions, oldest first: `runs` lists each conversation and how many decisions it gets, in order, the last run newest. The
 *  text of those in `hidden` conversations is what no one outside them may see. */
async function decide(w: World, runs: Array<[group: string, count: number]>, hidden: string[] = []) {
  let n = 0
  const rows = runs.flatMap(([conversationId, count]) => Array.from({ length: count }, () => {
    const i = n++
    return { id: `${w.tabId}-d${String(i).padStart(4, '0')}`, tabId: w.tabId, conversationId, record: { why: `${hidden.includes(conversationId) ? 'hidden' : 'shown'}-text-of-${conversationId}-${i}`, candidates: [] },
      createdAt: new Date(NOW - 40 * DAY + i * 1000) }
  }))
  for (let i = 0; i < rows.length; i += 500) await db.superTabRouteDecision.createMany({ data: rows.slice(i, i + 500) })
  return rows
}

/** What the list gave every reader before: every group of the Swarm loaded, the ones the reader may read kept, and the newest
 *  100 decisions of those. */
function listedBefore(w: World, reader: AuthUser, asAgentId?: string) {
  return swarmTransaction(db, async tx => {
    const { state } = await store.load(tx, reader, w.tabId, { allGroups: true })
    const actor = await store.actor(tx, reader, state, asAgentId)
    author(state, actor)
    refuseBuddyRouting(state, actor)
    const groups = state.conversations.filter(c => canReadGroup(state, actor, c)).map(c => c.id)
    return (await recentDecisions(tx, w.tabId, groups)).map(timedDecisionOf)
  })
}
const settle = async <T>(read: () => Promise<T>) => read().then(value => ({ value }), (error: Error) => ({ error: error.message }))
const readers = (w: World): Array<[string, AuthUser, string | undefined]> => [['the owner', owner, undefined], ['a collaborator', peer, undefined],
  ['a member outside the private project', outsider, undefined], ['the Lead', owner, w.lead], ['a worker', owner, w.worker], ['the Docs worker with no project of its own', owner, w.docsWorker],
  ['the Secret project\'s worker', owner, w.secretWorker], ['the Lead of the Secret project', owner, w.secretLead]]

/** Every reader gets, for the same Swarm, exactly what the list gave before. */
async function sameAnswers(w: World) {
  const got: Record<string, Awaited<ReturnType<typeof settle<unknown[]>>>> = {}
  for (const [name, reader, agent] of readers(w)) {
    const now = await settle(() => store.routeDecisions(reader, w.tabId, agent))
    expect(now, name).toEqual(await settle(() => listedBefore(w, reader, agent)))
    got[name] = now
  }
  return got
}
const ids = (answer: { value?: Array<{ id: string }> } | undefined) => (answer?.value ?? []).map(d => d.id)

describe('what the route-decision list gives each reader', () => {
  it('is what it gave before, for every kind of reader, over groups they may and may not read', async () => {
    const w = await world(5)
    // Newest last. Every kind of group, interleaved, with the secrets in the middle of the newest hundred.
    const all = [w.web, w.secretGroup, w.docsGroup, w.peerChat, w.buddyChat, ...w.finished, 'no-such-group']
    await decide(w, Array.from({ length: 130 }, (_, i) => [all[i % all.length]!, 1] as [string, number]))
    const got = await sameAnswers(w)
    // The test must tell readers apart, or "same as before" proves little.
    const seen = Object.fromEntries(Object.entries(got).map(([name, answer]) => [name, new Set((answer.value ?? []).map(d => (d as { conversationId: string }).conversationId))]))
    expect(seen['the owner']!.has(w.secretGroup)).toBe(true)
    expect(seen['a member outside the private project']!.has(w.secretGroup)).toBe(false)
    expect(seen['a collaborator']!.has(w.buddyChat)).toBe(true)
    expect(seen['the owner']!.has(w.buddyChat)).toBe(false)
    expect(seen['the Lead']!.has('no-such-group')).toBe(false)
    // The Docs worker reads the Docs project through its finished group, which is not loaded unless asked for by agent.
    expect(seen['the Docs worker with no project of its own']!.has(w.docsGroup)).toBe(true)
    expect(seen['the Docs worker with no project of its own']!.has(w.web)).toBe(false)
  })

  it('is what it gave before when the newest hundred are mostly the reader\'s unreadable ones: a wider window of decisions', async () => {
    const w = await world(60)
    await decide(w, [[w.web, 120], [w.secretGroup, 150]])
    const got = await sameAnswers(w)
    // The collaborator's read is the wider window, still without loading the Swarm's quiet groups.
    const [answer, profile] = await profiled(() => store.routeDecisions(peer, w.tabId))
    expect(profile.SuperTabRouteDecision!.plans).toContain('IXSCAN { tabId: 1, createdAt: 1 }')
    expect(profile.SuperTabRouteDecision!.hinted, 'the index scans name their index').toBe(true)
    // The wider window is read as conversation ids only: the replies hold the newest hundred whole, the answer's hundred, and ids.
    expect(profile.SuperTabRouteDecision!.bytes).toBeLessThan(3 * JSON.stringify(answer).length)
    expect(profile.SwarmGroup!.docsExamined).toBeLessThan(await db.swarmGroup.count({ where: { tabId: w.tabId, deleted: false } }))
    // The collaborator and the outsider read only Web: its newest 100 reach back past 150 secret decisions.
    expect(ids(got['a collaborator'])).toHaveLength(100)
    expect(ids(got['a member outside the private project'])).toHaveLength(100)
    expect(ids(got['the owner']).every(id => Number(id.slice(-4)) >= 170)).toBe(true)
  })

  it('is what it gave before when even a wider window holds fewer than a hundred of the reader\'s: the whole Swarm is read', async () => {
    const w = await world(60)
    await decide(w, [[w.web, 60], [w.secretGroup, 600]])
    const got = await sameAnswers(w)
    // Both windows, then every group.
    const [, profile] = await profiled(() => store.routeDecisions(peer, w.tabId))
    expect(profile.SwarmGroup!.docsExamined).toBeGreaterThanOrEqual(await db.swarmGroup.count({ where: { tabId: w.tabId, deleted: false } }))
    expect(ids(got['a collaborator'])).toHaveLength(60)
    expect(ids(got['the owner'])).toHaveLength(100)
  })

  it('is what it gave before for a project\'s worker and Lead who read fewer than a hundred: only its project\'s groups are read, not the Swarm\'s', async () => {
    const w = await world(60)
    await decide(w, [[w.secretGroup, 30], [w.web, 600]])
    const got = await sameAnswers(w)
    expect(ids(got['the Secret project\'s worker'])).toHaveLength(30)
    expect(ids(got['the Lead of the Secret project'])).toHaveLength(30)
    const all = await db.swarmGroup.count({ where: { tabId: w.tabId, deleted: false } })
    for (const agent of [w.secretWorker, w.secretLead]) {
      const [, profile] = await profiled(() => store.routeDecisions(owner, w.tabId, agent))
      expect(profile.SwarmGroup!.docsExamined, 'the quiet groups of other projects stay unread').toBeLessThan(all / 2)
    }
  })

  it('finds the reader\'s older decisions in a group the newest 500 never name, when it reads between 1 and 99 of them', async () => {
    const w = await world(5)
    // Newest last: 70 in a quiet public group, then 480 the collaborator and the workers of Web cannot read, then 30 in Web.
    await decide(w, [[w.finished[0]!, 70], [w.secretGroup, 480], [w.web, 30]])
    const got = await sameAnswers(w)
    for (const reader of ['a collaborator', 'a worker', 'the Lead']) expect(ids(got[reader]), reader).toHaveLength(100)
    expect(new Set((got['a collaborator']!.value as Array<{ conversationId: string }>).map(d => d.conversationId))).toEqual(new Set([w.web, w.finished[0]]))
  })

  it('finds a quiet group stored with no project in a default-project agent\'s project, when the newest 500 name none of it', async () => {
    const w = await world(5)
    const quiet = w.finished[0]!
    // A group from before projects: no project in its data or its listing, which belongs to the Swarm's first (groupProject).
    await db.$runCommandRaw({ update: 'SwarmGroup', updates: [{ q: { tabId: w.tabId, key: quiet }, u: { $set: { projectId: null }, $unset: { 'data.projectId': '' } } }] })
    await decide(w, [[quiet, 20], [w.secretGroup, 600]])
    const got = await sameAnswers(w)
    expect(ids(got['a worker']), 'the worker of the default project reads it').toHaveLength(20)
    expect(ids(got['the Lead'])).toHaveLength(20)
    expect(ids(got['the Secret project\'s worker'])).toHaveLength(100)
  })

  it('stops at one window of decisions when the Swarm holds no more than that, even if the reader reads fewer than a hundred of them', async () => {
    const w = await world(5)
    await decide(w, [[w.secretGroup, 60], [w.web, 40]], [w.secretGroup])
    const got = await sameAnswers(w)
    expect(ids(got['a member outside the private project'])).toHaveLength(40)
    const [, profile] = await profiled(() => store.routeDecisions(outsider, w.tabId))
    expect(profile.SuperTabRouteDecision!.docsExamined, 'a hundred decisions are all there are: no wider window to read').toBe(100)
  })

  it('names nothing of a conversation the reader may not read, whether it is private, another project\'s, a Buddy\'s or gone', async () => {
    const w = await world(2)
    await decide(w, [[w.secretGroup, 5], [w.buddyChat, 5], [w.peerChat, 5], ['gone-group', 5], [w.web, 5]], [w.secretGroup, w.buddyChat, w.peerChat, 'gone-group'])
    const as = async (reader: AuthUser, agent?: string) => JSON.stringify(await store.routeDecisions(reader, w.tabId, agent))
    for (const hidden of [w.secretGroup, w.buddyChat, w.peerChat, 'gone-group']) {
      expect(await as(outsider), hidden).not.toContain(hidden)
      expect(await as(owner, w.worker), hidden).not.toContain(hidden)
    }
    expect(await as(outsider)).not.toContain('hidden-text-of-')
    expect(JSON.parse(await as(outsider))).toHaveLength(5)
    expect(JSON.parse(await as(peer))).toHaveLength(10)
  })

  it('refuses a reader who has left the Swarm, with no decision in the answer', async () => {
    const w = await world(1)
    await decide(w, [[w.web, 3]], [w.web])
    await db.swarmMember.updateMany({ where: { tabId: w.tabId, key: outsider.sub }, data: { deleted: true } })
    const left = await settle(() => store.routeDecisions(outsider, w.tabId))
    expect(left).toEqual({ error: expect.any(String) })
    expect(left).toEqual(await settle(() => listedBefore(w, outsider)))
    expect(JSON.stringify(left)).not.toContain('hidden-text-of-')
  })
})

interface Profiled { plans: string[]; docsExamined: number; returned: number; bytes: number; hinted: boolean }
/** What Mongo did for each collection while `read` ran: its plans, the documents it examined and the rows it returned. */
async function profiled<T>(read: () => Promise<T>): Promise<[T, Record<string, Profiled>]> {
  await db.$runCommandRaw({ profile: 2 })
  const result = await read()
  await db.$runCommandRaw({ profile: 0 })
  const found = await db.$runCommandRaw({ find: 'system.profile', filter: { 'command.profile': { $exists: false } },
    // Only the fields read: a pipeline in the profile can hold a `$type` expression, which Prisma reads back as a tagged value.
    projection: { ns: 1, planSummary: 1, docsExamined: 1, nreturned: 1, responseLength: 1, 'command.hint': 1 }, batchSize: 10000 }) as
    unknown as { cursor: { firstBatch: Array<{ ns: string; planSummary?: string; docsExamined?: number; nreturned?: number; responseLength?: number; command?: { hint?: unknown } }> } }
  await db.$runCommandRaw({ drop: 'system.profile' })
  const by: Record<string, Profiled> = {}
  for (const row of found.cursor.firstBatch) {
    const profile = by[row.ns.split('.').pop()!] ??= { plans: [], docsExamined: 0, returned: 0, bytes: 0, hinted: false }
    if (row.planSummary && !profile.plans.includes(row.planSummary)) profile.plans.push(row.planSummary)
    profile.docsExamined += row.docsExamined ?? 0
    profile.returned += row.nreturned ?? 0
    profile.bytes += row.responseLength ?? 0
    profile.hinted ||= row.command?.hint !== undefined
  }
  return [result, by]
}

describe('what the route-decision list costs the database', () => {
  const QUIET = 400
  it('reads the newest hundred decisions by index and only the groups they name, however many groups the Swarm has made', async () => {
    const w = await world(QUIET)
    // 300 decisions over 300 different quiet groups: the newest hundred name a hundred of them.
    await decide(w, w.finished.slice(0, 300).map(group => [group, 1] as [string, number]))
    const live = await db.swarmGroup.count({ where: { tabId: w.tabId, deleted: false, dormant: false } })
    const all = await db.swarmGroup.count({ where: { tabId: w.tabId, deleted: false } })
    expect(all - live).toBeGreaterThanOrEqual(QUIET)
    const [answer, profile] = await profiled(() => store.routeDecisions(owner, w.tabId, w.lead))
    const groups = profile.SwarmGroup!
    expect(answer).toHaveLength(100)
    expect(profile.SuperTabRouteDecision).toMatchObject({ plans: ['IXSCAN { tabId: 1, createdAt: 1 }'], docsExamined: 101, returned: 101, hinted: true })
    // The live groups, the Lead's own, and the hundred the decisions name: not the quiet ones nobody asked about.
    expect(groups.docsExamined).toBeLessThanOrEqual(live + 1 + 100)
    expect(groups.docsExamined).toBeLessThan(all / 2)
    // The answer is what it was.
    expect(answer).toEqual(await listedBefore(w, owner, w.lead))
  })

  it('reads the groups the decisions name with only the fields access needs, not their briefs and tasks', async () => {
    const w = await world(QUIET)
    const brief = 'x'.repeat(4000)
    await db.$runCommandRaw({ update: 'SwarmGroup', updates: [{ q: { tabId: w.tabId }, u: { $set: { 'data.brief': brief } }, multi: true }] })
    await decide(w, w.finished.slice(0, 300).map(group => [group, 1] as [string, number]))
    const [answer, profile] = await profiled(() => store.routeDecisions(owner, w.tabId, w.lead))
    expect(answer).toHaveLength(100)
    // A hundred groups with a 4 KB brief each are 400 KB whole; the live groups come whole with the Swarm's base.
    expect(profile.SwarmGroup!.bytes).toBeLessThan(200_000)
    expect(answer).toEqual(await listedBefore(w, owner, w.lead))
  })
})
