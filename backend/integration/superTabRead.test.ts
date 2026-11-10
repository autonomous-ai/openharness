import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { storeOldLeads } from '../src/superTabs/leads.test-support.js'
import { MongoMemoryReplSet } from 'mongodb-memory-server-core'
import { PrismaClient } from '@prisma/client'
import Fastify, { type FastifyInstance } from 'fastify'
import type { AuthUser } from '../src/lib/ssoAuth.js'
import { SuperTabStore } from '../src/superTabs/store.js'
import { superTabRoutes } from '../src/routes/superTabs.js'
import { errorHandler } from '../src/middlewares/errorHandler.js'
import * as parts from '../src/superTabs/parts/index.js'
import { noteChange, swarmTransaction } from '../src/superTabs/cache.js'
import { guardedWrite } from '../src/superTabs/parts/write.js'
import { migrateSwarm } from '../src/superTabs/migration/migrate.js'
import { SwarmReads } from '../src/superTabs/read/service.js'
import { writeReadMark } from '../src/superTabs/readMarks.js'
import { HostReads } from '../src/superTabs/read/host.js'
import type { Conversation, SuperTabState } from '../src/superTabs/model.js'
import { sendsEmptyIn, watched, type Query } from '../src/lib/queryRecorder.test-support.js'
import { writeLegacySwarm } from '../scripts/swarm-parts/legacy.js'
import { NOW, outsider as outsiderActor, owner as ownerActor, peer as peerActor, swarm } from '../src/superTabs/read/fixture.test-support.js'
import { storedAssignment, storedStatus } from '../src/superTabs/storedWork.test-support.js'
import { PROFILE_STAGES, profileEntry, type ProfileEntry } from './bench/profile.js'

// A fresh loopback replica set, created here. This suite never reads DATABASE_URL or an existing database.
let replica: MongoMemoryReplSet
let db: PrismaClient
let app: FastifyInstance
let clock = NOW
const user = (actor: { userId: string; email: string }): AuthUser => ({ sub: actor.userId, email: actor.email, autonomousEnv: 'prod', role: 'user' })
const [owner, peer, outsider] = [ownerActor, peerActor, outsiderActor].map(user) as [AuthUser, AuthUser, AuthUser]
const R = 700
const MIGRATED = NOW - 60_000
const DAY = 86_400_000

beforeAll(async () => {
  replica = await MongoMemoryReplSet.create({ binary: { version: '7.0.24', downloadDir: join(tmpdir(), 'harness-super-tab-mongodb-binaries') },
    replSet: { count: 1, ip: '127.0.0.1', storageEngine: 'wiredTiger' } })
  // The driver's heartbeat (every ten seconds, two answers of about 745 bytes) is traffic the byte count of 'what a read costs' would
  // take for a read's: this client asks once an hour instead. The one node never changes, so nothing here needs the heartbeat.
  const uri = `${replica.getUri(`swarm_read_test_${randomUUID().replaceAll('-', '_')}`)}&heartbeatFrequencyMS=3600000`
  await promisify(execFile)(join(process.cwd(), 'node_modules/.bin/prisma'), ['db', 'push', '--skip-generate'], {
    env: { ...process.env, DATABASE_URL: uri }, timeout: 60000,
  })
  db = new PrismaClient({ datasources: { db: { url: uri } } })
  for (const each of [owner, peer, outsider]) await db.user.create({ data: { id: each.sub, externalId: `fixture-${each.sub}`, email: each.email, autonomousEnv: 'prod' } })
  // The owner's own machine runs the Swarm's agents, so reading as one of them needs no machine share.
  await db.machine.create({ data: { machineId: 'host', userId: owner.sub, apiKey: 'fixture-only', managerId: 'fixture', autonomousEnv: 'prod', authMode: 'remote' } })
  const store = new SuperTabStore(db)
  app = Fastify()
  app.setErrorHandler(errorHandler)
  // External SSO is replaced with fixture accounts; every permission and transaction below is real.
  app.addHook('onRequest', async (request, reply) => {
    const found = [owner, peer, outsider].find(u => `Bearer ${u.sub}` === request.headers.authorization)
    if (!found) return reply.code(401).send({ success: false })
    request.user = found
  })
  await app.register(superTabRoutes, { store, github: null, reads: new SwarmReads(store, { now: () => clock }),
    hosts: new HostReads(store, { now: () => clock }) })
  await app.ready()
})
afterAll(async () => {
  await app?.close()
  await db?.$disconnect()
  await replica?.stop()
})

/** A Swarm in parts: two projects (one private to its owner), a Lead and a worker on the owner's machine, finished work
 *  quiet for two days (dormant), and a private conversation for `peer`. */
async function scene<T = void>(extra: (s: ReturnType<typeof swarm>, ids: { web: string; done: string; lead: string; secret: string }) => T = () => undefined as T, machineId = 'host') {
  const s = swarm(MIGRATED)
  s.join(peerActor)
  s.join(outsiderActor)
  const lead = s.add('lead-harness', 'lead', true, ownerActor, machineId, owner.sub)
  const secret = s.run({ type: 'project.create', name: 'Secret', visibility: 'private', brief: '' }).projectId as string
  const web = s.group('Web')
  const worker = s.add('worker-harness', web, false, ownerActor, machineId, owner.sub)
  s.edit(state => { storedAssignment(state, web, worker, MIGRATED) })
  const done = s.group('Done work')
  const secretGroup = s.group('Secret work', secret)
  // peer's Chat with PM from before Swarm v4 (closed: nobody reads it), and peer's 1:1 chat with an agent of theirs.
  const privateId = s.group('Peer and PM')
  const peerChat = s.group('Peer\'s agent')
  s.edit(state => {
    const generation = state.people.find(p => p.id === peer.sub)!.generation
    state.conversations.find(c => c.id === privateId)!.audience = { people: [{ id: peer.sub, generation }] }
    Object.assign(state.conversations.find(c => c.id === peerChat)!, { kind: 'agent-chat', leadId: null, agentIds: [],
      audience: { people: [{ id: peer.sub, generation }] } })
    const finished = state.conversations.find(c => c.id === done)!
    finished.assignment = { ...state.conversations.find(c => c.id === web)!.assignment!, id: 'old-work', status: 'done' }
  })
  const more = extra(s, { web, done, lead, secret })
  // Stored before its removal: the Swarm-wide Leads conversation, with the Lead in it; no read sends it now (model.ts leadsRemoved).
  s.edit(state => storeOldLeads(state, [lead]))
  const tabId = `tab-${randomUUID()}`
  const state = { ...structuredClone(s.state), id: tabId } as SuperTabState
  await writeLegacySwarm(db, { state, revision: R, messages: [{ id: `${tabId}-m1`, conversationId: done, sequence: 5, text: 'Done',
    author: { kind: 'person', id: owner.sub, name: owner.email, membershipGeneration: tabId }, createdAt: new Date(MIGRATED - 2 * DAY) }] })
  const report = await migrateSwarm(db, tabId, { now: () => MIGRATED })
  if (!report.ok) throw new Error(report.error)
  return { tabId, lead, worker, web, done, secretGroup, privateId, peerChat, secret, leads: state.leadsConversationId!, more }
}
const get = async (url: string, as: AuthUser = owner) => {
  const response = await app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${as.sub}` } })
  return { status: response.statusCode, body: response.json() as { data: any; error?: { code: string; message: string } } }
}
const keys = (list: Array<{ key: string }>) => list.map(p => p.key)
/** A later write of one group by a command, as group 2's store does it, stamped `at`. */
async function writeGroup(tabId: string, key: string, at: number, change: (group: Conversation) => void, op: 'update' | 'remove' = 'update') {
  await swarmTransaction(db, async tx => {
    const current = (await parts.loadActive(tx, tabId, { groupIds: [key] })).groups.find(g => g.key === key)!
    const data = structuredClone(current.data!) as Conversation
    change(data)
    await guardedWrite(tx, tabId, { op, kind: 'group', key, seen: current.version, data }, at)
  })
}

describe('first load (design 4.3)', () => {


  it('answers the design\'s shape: cursor 30 s before the read, epoch, newest change, the reader\'s parts and derived values', async () => {
    const s = await scene()
    clock = NOW
    const { status, body } = await get(`/api/super-tabs/${s.tabId}/parts`, peer)
    expect(status).toBe(200)
    expect(Object.keys(body.data).sort()).toEqual(['agents', 'cursor', 'derived', 'derivedEtag', 'epoch', 'format', 'groups', 'head', 'lastChangedAt',
      'machines', 'members', 'progress', 'serverTime', 'starts', 'tabId'].sort())
    expect(body.data).toMatchObject({ format: 2, tabId: s.tabId, serverTime: NOW, epoch: 1, lastChangedAt: MIGRATED,
      head: { key: 'head', version: R, changedAt: MIGRATED, data: { id: s.tabId, name: 'Pilot' } } })
    expect(JSON.parse(Buffer.from(body.data.cursor, 'base64url').toString())).toEqual({ v: 2, t: NOW - 30_000, e: 1 })
    expect(keys(body.data.members)).toEqual([owner.sub, peer.sub, outsider.sub])
    expect(keys(body.data.groups)).toEqual(['lead', s.web, s.peerChat])
    expect(body.data.derived).toMatchObject({ agents: { [s.lead]: { downSince: null }, [s.worker]: { workDecision: null } } })
    expect(body.data.derived).not.toHaveProperty('mentionsWaiting')
  })

  it('keeps a 1:1 chat and the private project from every reader outside them, the PM included, and a closed Chat with PM from all', async () => {
    const s = await scene()
    const groups = async (as: AuthUser, agent?: string) =>
      keys((await get(`/api/super-tabs/${s.tabId}/parts${agent ? `?asAgentId=${agent}` : ''}`, as)).body.data.groups)
    expect(await groups(peer)).toContain(s.peerChat)
    expect(await groups(outsider)).not.toContain(s.secretGroup)
    expect(await groups(owner)).toContain(s.secretGroup)
    for (const [as, agent] of [[outsider], [owner], [owner, s.lead], [owner, s.worker]] as const) expect(await groups(as, agent)).not.toContain(s.peerChat)
    for (const [as, agent] of [[peer], [outsider], [owner], [owner, s.lead]] as const) expect(await groups(as, agent)).not.toContain(s.privateId)
  })

  it('migrates a Swarm still in one row on first access', async () => {
    const s = swarm(MIGRATED)
    const tabId = `tab-${randomUUID()}`
    await writeLegacySwarm(db, { state: { ...structuredClone(s.state), id: tabId }, revision: 3 })
    const { status, body } = await get(`/api/super-tabs/${tabId}/parts`)
    expect(status).toBe(200)
    expect(body.data.head.version).toBe(3)
    expect(await db.superTab.findUnique({ where: { id: tabId } })).toMatchObject({ format: 2 })
  })

  it('opens a legacy Swarm with deleted-conversation history without exposing that history', async () => {
    const s = swarm(MIGRATED)
    const tabId = `tab-${randomUUID()}`
    await writeLegacySwarm(db, { state: { ...structuredClone(s.state), id: tabId }, revision: 3 })
    await db.superTabMessage.create({ data: { id: `${tabId}-orphan`, tabId, conversationId: 'gone', sequence: 1, author: {}, text: 'x', recipientIds: [], mentions: [] } })
    const { status, body } = await get(`/api/super-tabs/${tabId}/parts`)
    expect(status).toBe(200)
    expect(keys(body.data.groups)).not.toContain('gone')
    expect((await get(`/api/super-tabs/${tabId}/conversations/gone/messages`)).status).toBe(404)
    expect((await db.superTabMessage.findUnique({ where: { id: `${tabId}-orphan` } }))?.text).toBe('x')
  })

  it('answers "being upgraded" when a Swarm cannot be migrated yet, and every client retries that', async () => {
    const s = swarm(MIGRATED)
    const tabId = `tab-${randomUUID()}`
    await writeLegacySwarm(db, { state: { ...structuredClone(s.state), id: tabId, version: 2 as 1 }, revision: 3 })
    const { status, body } = await get(`/api/super-tabs/${tabId}/parts`)
    expect(status).toBe(503)
    expect(body.error!.code).toBe('SWARM_MIGRATING')
  })
})

describe('changes since a cursor (design 4.2, 4.4)', () => {
  async function firstLoad(tabId: string, as: AuthUser, at: number) {
    clock = at
    return (await get(`/api/super-tabs/${tabId}/parts`, as)).body.data.cursor as string
  }
  const changes = async (tabId: string, cursor: string, as: AuthUser, at: number) => {
    clock = at
    return get(`/api/super-tabs/${tabId}/changes?cursor=${cursor}`, as)
  }

  it('sends only what changed, whole, to the readers who may see it', async () => {
    const s = await scene()
    const [peerCursor, outsiderCursor] = [await firstLoad(s.tabId, peer, NOW), await firstLoad(s.tabId, outsider, NOW)]
    expect((await changes(s.tabId, peerCursor, peer, NOW + 1_000)).body.data).toMatchObject({ reload: false, head: null, groups: [], agents: [] })
    await writeGroup(s.tabId, s.web, NOW + 2_000, g => { g.title = 'Web 2' })
    await writeGroup(s.tabId, s.peerChat, NOW + 2_000, g => { g.title = 'Private 2' })
    await writeGroup(s.tabId, s.privateId, NOW + 2_000, g => { g.title = 'Closed 2' })
    const seen = (await changes(s.tabId, peerCursor, peer, NOW + 3_000)).body.data
    expect(seen).toMatchObject({ format: 2, reload: false, serverTime: NOW + 3_000, epoch: 1, lastChangedAt: NOW + 2_000 })
    expect(seen.groups.map((g: { key: string; version: number; data: { title: string } }) => [g.key, g.version, g.data.title]))
      .toEqual([[s.web, R + 1, 'Web 2'], [s.peerChat, R + 1, 'Private 2']])
    expect(keys((await changes(s.tabId, outsiderCursor, outsider, NOW + 3_000)).body.data.groups)).toEqual([s.web])
  })

  it('leaves out a conversation of a kind this release does not know, in changes as in a first load (rolling deploys)', async () => {
    const s = await scene()
    clock = Date.now()
    const cursor = (await get(`/api/super-tabs/${s.tabId}/parts`, owner)).body.data.cursor
    // A newer release wrote a conversation of a kind this one parks (model.ts parkLaterConversations).
    await db.$transaction(tx => guardedWrite(tx, s.tabId, { op: 'insert', kind: 'group', key: 'later-kind', ordinal: Date.now(), first: R + 1,
      data: { id: 'later-kind', kind: 'board', title: 'Board', leadId: null, agentIds: [], archived: false, brief: 'Not for this release', checks: [],
        assignment: null, lastMessageSequence: 0 } }, Date.now()))
    clock = Date.now()
    expect(keys((await get(`/api/super-tabs/${s.tabId}/parts`, owner)).body.data.groups)).not.toContain('later-kind')
    expect(keys((await get(`/api/super-tabs/${s.tabId}/changes?cursor=${cursor}`, owner)).body.data.groups)).not.toContain('later-kind')
  })

  /** Derived values from a whole first load and from a change read in the same moment must agree (parts/light.ts). */
  async function derivedBoth(tabId: string, as: AuthUser) {
    clock = Date.now()
    const first = (await get(`/api/super-tabs/${tabId}/parts`, as)).body.data
    const changed = (await get(`/api/super-tabs/${tabId}/changes?cursor=${first.cursor}`, as)).body.data
    return { full: first.derived, light: changed.derived }
  }
  /** The web group's task was lost, then cancelled: its worker keeps no decision (liveness.ts, commands.ts work.cancel). */
  const lostThenCancelled = (state: SuperTabState, web: string, worker: string) => {
    const group = state.conversations.find(c => c.id === web)!
    group.assignment = { ...group.assignment!, status: 'cancelled', result: 'Gone quiet', lost: { reason: 'no progress seen', at: MIGRATED } }
    group.lostAttempt = { id: group.assignment.id, agentId: worker }
    delete state.agents.find(a => a.id === worker)!.workDecision
  }
  /** After the migration (which stores derived decisions), the worker has none: as a loss after it leaves it. */
  async function noDecision(tabId: string, agentId: string) {
    await db.$transaction(async tx => {
      const agent = (await parts.loadActive(tx, tabId)).agents.find(a => a.key === agentId)!
      const { workDecision: _gone, ...data } = agent.data!
      await guardedWrite(tx, tabId, { op: 'update', kind: 'agent', key: agentId, seen: agent.version, data }, MIGRATED + 1)
    })
  }

  it('derives the same decisions from a change read as from a first load after a task was lost, then cancelled', async () => {
    const s = await scene((f, ids) => f.edit(state => lostThenCancelled(state, ids.web, state.agents.find(a => a.name === 'worker-harness')!.id)))
    await noDecision(s.tabId, s.worker)
    const { full, light } = await derivedBoth(s.tabId, peer)
    expect(full.agents[s.worker].workDecision).toBeNull()
    expect(light).toEqual(full)
  })

  it('and when that worker also has an earlier ordinary finished task, which the first load does count', async () => {
    const s = await scene((f, ids) => {
      const earlier = f.group('Earlier work')
      f.edit(state => {
        const worker = state.agents.find(a => a.name === 'worker-harness')!.id
        lostThenCancelled(state, ids.web, worker)
        const group = state.conversations.find(c => c.id === earlier)!
        group.agentIds.push(worker)
        group.assignment = { ...state.conversations.find(c => c.id === ids.web)!.assignment!, id: 'earlier-work', status: 'done', result: 'Shipped' }
        delete group.assignment.lost
      })
    })
    await noDecision(s.tabId, s.worker)
    const { full, light } = await derivedBoth(s.tabId, peer)
    expect(full.agents[s.worker].workDecision).toBe('awaiting')
    expect(light).toEqual(full)
  })

  it('never sends a private conversation\'s removal to a reader outside it', async () => {
    const s = await scene()
    const [peerCursor, outsiderCursor] = [await firstLoad(s.tabId, peer, NOW), await firstLoad(s.tabId, outsider, NOW)]
    await writeGroup(s.tabId, s.peerChat, NOW + 2_000, () => {}, 'remove')
    expect((await changes(s.tabId, peerCursor, peer, NOW + 3_000)).body.data.groups).toEqual([{ key: s.peerChat, version: R + 1, changedAt: NOW + 2_000, deleted: true }])
    expect((await changes(s.tabId, outsiderCursor, outsider, NOW + 3_000)).body.data.groups).toEqual([])
  })

  it('still delivers a write that committed after the read but was stamped inside the 30 s overlap', async () => {
    const s = await scene()
    const cursor = await firstLoad(s.tabId, peer, NOW)
    // A command that started before the read and committed after it, 10 s later than its stamp.
    await writeGroup(s.tabId, s.web, NOW - 10_000, g => { g.title = 'Late' })
    // One stamped before the overlap would be missed; transactions are cut at 15 s, so that never commits.
    await writeGroup(s.tabId, s.done, NOW - 30_001, g => { g.title = 'Too late' })
    expect(keys((await changes(s.tabId, cursor, peer, NOW + 3_000)).body.data.groups)).toEqual([s.web])
  })

  it('asks for a full reload when the cursor is older than tombstones are kept, or from another epoch', async () => {
    const s = await scene()
    const cursor = await firstLoad(s.tabId, peer, NOW)
    expect((await changes(s.tabId, cursor, peer, NOW - 30_000 + 7 * DAY)).body.data).toEqual({ reload: true })
    await swarmTransaction(db, async tx => { noteChange(tx, s.tabId, 'main'); await tx.swarmHead.updateMany({ where: { tabId: s.tabId }, data: { visibilityEpoch: 2 } }) })
    expect((await changes(s.tabId, cursor, peer, NOW + 1_000)).body.data).toEqual({ reload: true })
    expect((await changes(s.tabId, 'not-a-cursor', peer, NOW + 1_000)).body.data).toEqual({ reload: true })
  })
})

describe('dormant groups on demand (design 4.5)', () => {
  it('pages dormant groups newest first, 50 at a time, without the ones the reader may not see', async () => {
    const s = await scene(f => {
      for (let i = 0; i < 52; i++) f.run({ type: 'conversation.archive', conversationId: f.group(`Old ${i}`), archived: true })
    })
    await writeGroup(s.tabId, s.peerChat, NOW, g => { g.dormant = true; g.lastActivityAt = new Date(NOW).toISOString() })
    const first = (await get(`/api/super-tabs/${s.tabId}/groups?dormant=1`, outsider)).body.data
    // A group the reader may not see never shortens a page, and the cursor names the last group it got, never a hidden
    // one (security review 2 of #2115).
    expect(first.groups).toHaveLength(50)
    expect(first.groups.every((g: { data: { dormant: boolean } }) => g.data.dormant)).toBe(true)
    expect(keys(first.groups)).not.toContain(s.peerChat)
    expect(JSON.parse(Buffer.from(first.next, 'base64url').toString()).k).toBe(keys(first.groups).at(-1))
    const second = (await get(`/api/super-tabs/${s.tabId}/groups?dormant=1&before=${first.next}`, outsider)).body.data
    expect(second).toMatchObject({ next: null })
    expect(second.groups).toHaveLength(3)
    expect(new Set([...keys(first.groups), ...keys(second.groups)]).size).toBe(53)
    expect(keys((await get(`/api/super-tabs/${s.tabId}/groups?dormant=1`, peer)).body.data.groups)[0]).toBe(s.peerChat)
  })

  it('reads one group by id, dormant or not, and 404s one the reader may not see', async () => {
    const s = await scene()
    expect((await get(`/api/super-tabs/${s.tabId}/groups/${s.done}`, outsider)).body.data.group)
      .toMatchObject({ key: s.done, version: R, data: { id: s.done, dormant: true, messageSeq: R } })
    expect((await get(`/api/super-tabs/${s.tabId}/groups/${s.peerChat}`, peer)).status).toBe(200)
    for (const [id, as] of [[s.peerChat, outsider], [s.peerChat, owner], [s.privateId, peer], [s.secretGroup, outsider], ['missing', owner]] as const) {
      const { status, body } = await get(`/api/super-tabs/${s.tabId}/groups/${id}`, as)
      expect([status, body.error!.code]).toEqual([404, 'NOT_FOUND'])
    }
  })
})

describe('what a reader can tell of a task\'s merge (task #2558)', () => {
  // Backlog sorts on these: shippedAt says only that the task reached Done; a pull request card's mergedAt says it merged.
  it('a Done task with an open pull request reads as shipped with no merge', async () => {
    const pullRequest = 'https://github.com/example/app/pull/7'
    // Done with its pull request open, as its worker's Done left it before Swarm v4 (work.status is gone, 2026-11-10).
    const s = await scene((f, ids) => f.edit(state => {
      const task = state.conversations.find(c => c.id === ids.web)!
      storedStatus(state, ids.web, 'done', `Ready: ${pullRequest}`)
      task.pullRequestUrls = [pullRequest]
      task.ledger = { ...task.ledger, shippedAt: MIGRATED }
    }))
    clock = Date.now()
    const unmerged = (await get(`/api/super-tabs/${s.tabId}/groups/${s.web}`)).body.data.group.data
    expect(unmerged.shippedAt).toEqual(expect.any(Number))
    expect(unmerged.pullRequestUrls).toEqual([pullRequest])
    expect(unmerged.cards?.pullRequests?.some((card: { mergedAt?: number }) => card.mergedAt !== undefined) ?? false).toBe(false)
  })
})

describe('a dormant group\'s required machines', () => {
  it('names to each reader only the machines that reader sees, in the dormant list and read by id', async () => {
    const s = await scene((f, ids) => {
      // Only an agent of the private project runs on 'secret-mac', so the outsider does not see that machine.
      f.add('secret-harness', f.group('Secret 2', ids.secret), false, ownerActor, 'secret-mac', owner.sub)
      f.edit(state => { state.conversations.find(c => c.id === ids.done)!.task = { goal: 'g', changes: 'c', constraints: 'k', owns: ['o'],
        requires: { machines: ['secret-mac', 'host'] } } })
    })
    const requires = async (as: AuthUser) => [
      (await get(`/api/super-tabs/${s.tabId}/groups?dormant=1`, as)).body.data.groups.find((g: { key: string }) => g.key === s.done).data.task.requires,
      (await get(`/api/super-tabs/${s.tabId}/groups/${s.done}`, as)).body.data.group.data.task.requires]
    expect(await requires(owner)).toEqual([{ machines: ['secret-mac', 'host'] }, { machines: ['secret-mac', 'host'] }])
    expect(await requires(outsider)).toEqual([{ machines: ['host'], unseenMachines: 1 }, { machines: ['host'], unseenMachines: 1 }])
  })
})

describe('Swarm list and old routes (design 4.9, 4.11)', () => {
  it('lists the caller\'s Swarms with their newest change', async () => {
    const s = await scene()
    const { body } = await get('/api/super-tabs/list', outsider)
    expect(body.data.tabs).toContainEqual({ id: s.tabId, name: 'Pilot', ownerId: owner.sub, paused: false, lastChangedAt: MIGRATED })
  })

  it('sends no empty id list to the database, for a person with no Swarm or with Swarms all in parts', async () => {
    await scene()
    const queries: Query[] = []
    const reads = new SwarmReads(new SuperTabStore(watched(db, queries)), { now: () => clock })

    expect((await reads.list(outsider)).tabs.length).toBeGreaterThan(0)
    expect((await reads.list({ ...outsider, sub: 'u-without-swarms' })).tabs).toEqual([])

    expect(queries.some(q => q.model === 'superTab')).toBe(true)
    expect(queries.filter(sendsEmptyIn)).toEqual([])
  })

  it('reads each Swarm\'s newest change over all its parts, without a groupBy (it once panicked the engine on Mongo)', async () => {
    const [a, b] = [await scene(), await scene()]
    await writeGroup(b.tabId, b.web, MIGRATED + 5_000, group => { group.title = 'Web, renamed' })
    const newest = await db.$transaction(tx => parts.lastChangedAt(tx, [a.tabId, b.tabId, 'tab-with-no-parts']))
    expect(Object.fromEntries(newest)).toEqual({ [a.tabId]: MIGRATED, [b.tabId]: MIGRATED + 5_000 })
    expect((await db.$transaction(tx => parts.lastChangedAt(tx, []))).size).toBe(0)
  })
})

describe('host form (design 4.10)', () => {
  /** The owner's machine `host` contributed to the Swarm, a third agent whose only group is dormant, a queued start. */
  let machine = 'host'
  /** Each test has its own machine, so other tests' Swarms never show up in its host reads. */
  /** [webRequester]: who asked for the Web work this machine's worker runs; the owner contributes the machine. */
  const hostScene = async (webRequester = owner.sub) => {
    machine = `m-${randomUUID().slice(0, 8)}`
    await db.machine.create({ data: { machineId: machine, userId: owner.sub, apiKey: 'fixture-only', managerId: 'fixture', autonomousEnv: 'prod', authMode: 'remote' } })
    return scene((s, ids) => {
    s.contribute(machine, 'swarm')
    const idle = s.add('idle-harness', ids.done, false, ownerActor, machine, owner.sub)
    // An agent whose only group has nothing else of this machine in it (no Lead, no running work here).
    const lonerGroup = s.group('Loner home', ids.secret)
    const loner = s.add('loner-harness', lonerGroup, false, ownerActor, machine, owner.sub)
    // In the project without a Lead, so no agent of this machine is in it.
    const archived = s.group('Archived, no agent here', ids.secret)
    s.run({ type: 'conversation.archive', conversationId: archived, archived: true })
    s.edit(state => {
      const pool = state.machines!.find(m => m.machineId === machine)!
      state.conversations.find(c => c.id === ids.web)!.requesterId = webRequester
      // These checks send real-time host readings. Keep their running task fresh: its migrated timestamp would now trigger
      // the all-worker 3-hour return clock, a real work change rather than the unchanged heartbeat this fixture tests.
      state.conversations.find(c => c.id === ids.web)!.assignment!.progressAt = Date.now()
      // One in a running group, one in a dormant group none of its agents is in: the host still has to settle it.
      state.starts = [[ids.web, 'queued'], [archived, 'queued-in-dormant']].map(([conversationId, id]) => ({ id: id!, creationId: 'c',
        actorKey: `person:${owner.sub}`, contributorId: owner.sub, membershipGeneration: pool.membershipGeneration,
        machineOwnerId: owner.sub, hostGrant: null, harnessId: null, dispatched: false, error: null, poolGeneration: pool.generation,
        request: { conversationId: conversationId!, machineId: machine, engine: 'codex', name: 'Builder', cwd: '/repo', worktree: false,
          requirements: { memoryBytes: 0, diskBytes: 0, maxCpuPercent: 100, tools: [], devices: [], quotaRequired: false } } }))
    })
    return { idle, loner, lonerGroup }
  }, machine)
  }
  const host = async (cursor?: string, full = false, as: AuthUser = owner) =>
    get(`/api/super-tabs/hosts/${machine}/changes?${[cursor && `cursor=${cursor}`, full && 'full=1'].filter(Boolean).join('&')}`, as)
  type Row = { agent?: { id: string }; lead?: boolean; active?: boolean; leadsConversationId?: string; observers?: Array<{ userId: string }>; lastChangedAt?: number }

  it('gives a full read of the machine\'s Swarm: today\'s roster, pool and assignment rows, from the parts', async () => {
    const s = await hostScene()
    clock = NOW
    const { status, body } = await host(undefined, true)
    expect(status).toBe(200)
    expect(body.data).toMatchObject({ format: 2, full: true, removedTabIds: [] })
    const tab = body.data.tabs.find((t: { tabId: string }) => t.tabId === s.tabId)
    expect(tab.lastChangedAt).toBe(MIGRATED)
    const rows = new Map<string, Row>(tab.roster.filter((r: Row) => r.agent).map((r: Row) => [r.agent!.id, r]))
    expect([...rows.keys()].sort()).toEqual([s.lead, s.worker, s.more.idle, s.more.loner].sort())
    // A Lead's readers watch it, view only (Ken, 2026-10-28), as a Builder's do; marked, its host lets nobody else.
    const readers = [{ email: peer.email, userId: peer.sub }, { email: outsider.email, userId: outsider.sub }]
    expect(rows.get(s.lead)).toMatchObject({ lead: true, active: true, leadsConversationId: null, lastChangedAt: MIGRATED, observers: readers,
      confidential: true, membersWatch: true })
    // The chat a PM's host rebuilds its start prompt from when it switches it, a real id (2026-11-02, both reviews of #2527).
    expect((rows.get(s.lead) as Row & { ledConversationId?: string }).ledConversationId).toBe('lead')
    expect(rows.get(s.worker)).toMatchObject({ ledConversationId: null })
    expect(rows.get(s.worker)).toMatchObject({ observers: readers, confidential: false, membersWatch: false })
    // Its only group is finished and dormant, yet not archived: the host must not hand it to automatic cleanup.
    expect(rows.get(s.more.idle)).toMatchObject({ lead: false, active: true })
    expect(tab.pool).toMatchObject({ tabId: s.tabId, machine: { machineId: machine }, starts: [{ id: 'queued' }, { id: 'queued-in-dormant' }] })
    expect(tab.pool.projects[0].conversationIds).toContain(s.web)
    expect(tab.pool.projects[0].conversationIds).not.toContain(s.privateId)
    expect(tab.assignments).toEqual([{ tabId: s.tabId, assignmentId: expect.any(String), harnessId: 'worker-harness' }])
  })

  it('wakes the host only for changes that concern its machine', async () => {
    const s = await hostScene()
    const { cursor } = await fullRead(s.tabId)
    clock = Date.now()
    expect((await host(cursor)).body.data).toMatchObject({ full: false, tabs: [], removedTabIds: [] })
    await command(s.tabId, { type: 'conversation.rename', conversationId: s.secretGroup, title: 'Not this machine' })
    clock = Date.now()
    expect((await host(cursor)).body.data.tabs).toEqual([])
    await command(s.tabId, { type: 'conversation.rename', conversationId: s.web, title: 'Its worker\'s group' })
    clock = Date.now()
    expect((await host(cursor)).body.data.tabs.map((t: { tabId: string }) => t.tabId)).toEqual([s.tabId])
  })

  /** The machine's reading, through the store as its host sends it every 15 s. */
  async function reading(tabId: string, generation: string) {
    await new SuperTabStore(db).observeMachine(owner, tabId, machine, { generation, resources: { cpuPercent: 5, memoryTotalBytes: null,
      memoryUsedBytes: null, diskFreeBytes: null, diskTotalBytes: null, projectDiskFreeBytes: null, deviceType: null, chip: null, os: null,
      gpuPercent: null }, tools: {}, quotas: [], runningHarnessIds: ['lead-harness', 'worker-harness', 'idle-harness', 'loner-harness'],
      stoppedHarnessIds: [] })
  }
  const command = (tabId: string, body: Record<string, unknown>) => new SuperTabStore(db).execute(owner, tabId, { operationId: randomUUID(), command: body as never })
  /** A full read on the real clock (the store stamps with it): its cursor and the machine's contribution generation. */
  async function fullRead(tabId: string) {
    clock = Date.now()
    const data = (await host(undefined, true)).body.data
    return { cursor: data.cursor as string, generation: data.tabs.find((t: { tabId: string }) => t.tabId === tabId).pool.machine.generation as string }
  }
  const poolOf = async (tabId: string, cursor: string) => {
    clock = Date.now()
    return (await host(cursor)).body.data.tabs.find((t: { tabId: string }) => t.tabId === tabId)?.pool as { machine: { paused: boolean } } | undefined
  }

  // WS roadmap Phase 2a: the host reads its changes only when told (lib/swarmHostPushes.ts), so every commit its read would
  // wake for must tell it, and a commit that concerns other machines, or only this machine's reading, must not.
  it('tells this machine\'s host after a commit exactly when its host read would wake for it', async () => {
    const s = await hostScene()
    const { generation } = await fullRead(s.tabId)
    const told: Array<{ tabId: string; machineIds: string[]; lastChangedAt: number }> = []
    const store = new SuperTabStore(db, Date.now, null, { hostsChanged: change => { told.push(change) } })
    const run = (body: Record<string, unknown>) => store.execute(owner, s.tabId, { operationId: randomUUID(), command: body as never })
    const toldHere = () => told.filter(t => t.tabId === s.tabId && t.machineIds.includes(machine))
    await run({ type: 'conversation.rename', conversationId: s.secretGroup, title: 'Not this machine' })
    expect(toldHere()).toEqual([])
    await store.observeMachine(owner, s.tabId, machine, { generation, resources: { cpuPercent: 5, memoryTotalBytes: null,
      memoryUsedBytes: null, diskFreeBytes: null, diskTotalBytes: null, projectDiskFreeBytes: null, deviceType: null, chip: null, os: null,
      gpuPercent: null }, tools: {}, quotas: [], runningHarnessIds: ['lead-harness', 'worker-harness', 'idle-harness', 'loner-harness'],
      stoppedHarnessIds: [] })
    expect(toldHere()).toEqual([])
    const before = Date.now()
    await run({ type: 'conversation.rename', conversationId: s.web, title: 'Its worker\'s group' })
    expect(toldHere()).toEqual([{ tabId: s.tabId, machineIds: expect.arrayContaining([machine]), lastChangedAt: expect.any(Number) }])
    expect(toldHere()[0]!.lastChangedAt).toBeGreaterThanOrEqual(before)
    await run({ type: 'machine.pause', machineId: machine, paused: true })
    expect(toldHere()).toHaveLength(2)
  })

  // WS roadmap Phase 2a, client reads: a member's apps read a Swarm when told (lib/swarmClientPushes.ts). The Lead's rule: a
  // member removed by a commit hears that commit and nothing after it; someone not in the Swarm hears nothing.
  it('tells the Swarm\'s people after each commit, a removed one once more and never again', async () => {
    const s = await hostScene()
    const { generation } = await fullRead(s.tabId)
    const told: Array<{ tabId: string; userIds: string[]; lastChangedAt: number; parts: string[] }> = []
    const store = new SuperTabStore(db, Date.now, null, { swarmChanged: change => { told.push(change) } })
    const run = (body: Record<string, unknown>) => store.execute(owner, s.tabId, { operationId: randomUUID(), command: body as never })
    await run({ type: 'conversation.rename', conversationId: s.secretGroup, title: 'Renamed' })
    expect(told).toEqual([{ tabId: s.tabId, userIds: expect.arrayContaining([owner.sub, peer.sub, outsider.sub]), lastChangedAt: expect.any(Number), parts: ['main'] }])
    expect(told[0]!.userIds).toHaveLength(3)
    await store.observeMachine(owner, s.tabId, machine, { generation, resources: { cpuPercent: 5, memoryTotalBytes: null,
      memoryUsedBytes: null, diskFreeBytes: null, diskTotalBytes: null, projectDiskFreeBytes: null, deviceType: null, chip: null, os: null,
      gpuPercent: null }, tools: {}, quotas: [], runningHarnessIds: ['lead-harness', 'worker-harness', 'idle-harness', 'loner-harness'],
      stoppedHarnessIds: [] })
    expect(told.at(-1)!.parts).toEqual(['machine'])
    await run({ type: 'member.remove', userId: outsider.sub })
    expect(told.at(-1)!.userIds).toContain(outsider.sub)
    await run({ type: 'conversation.rename', conversationId: s.web, title: 'After the removal' })
    expect(told.at(-1)!.userIds.sort()).toEqual([owner.sub, peer.sub].sort())
  })

  it('wakes the host for a pause even when a reading lands after it, before the host polls', async () => {
    const s = await hostScene()
    const { cursor, generation } = await fullRead(s.tabId)
    await command(s.tabId, { type: 'machine.pause', machineId: machine, paused: true })
    await reading(s.tabId, generation)
    expect((await poolOf(s.tabId, cursor))?.machine.paused).toBe(true)
  })

  it('wakes the host for a pause made right after a reading', async () => {
    const s = await hostScene()
    const { cursor, generation } = await fullRead(s.tabId)
    await reading(s.tabId, generation)
    await command(s.tabId, { type: 'machine.pause', machineId: machine, paused: true })
    expect((await poolOf(s.tabId, cursor))?.machine.paused).toBe(true)
  })

  it('wakes an agent\'s host when the agent leaves its last group, so the host sees it inactive', async () => {
    const s = await hostScene()
    const { cursor } = await fullRead(s.tabId)
    await command(s.tabId, { type: 'conversation.agent', conversationId: s.more.lonerGroup, agentId: s.more.loner, present: false, lead: false })
    clock = Date.now()
    const tab = (await host(cursor)).body.data.tabs.find((t: { tabId: string }) => t.tabId === s.tabId)
    expect(tab?.roster.find((r: { agent?: { id: string } }) => r.agent?.id === s.more.loner)).toMatchObject({ active: false })
  })

  it('still wakes the departed agent\'s host when the group is renamed after the removal, before the host polls', async () => {
    const s = await hostScene()
    const { cursor } = await fullRead(s.tabId)
    await command(s.tabId, { type: 'conversation.agent', conversationId: s.more.lonerGroup, agentId: s.more.loner, present: false, lead: false })
    await command(s.tabId, { type: 'conversation.rename', conversationId: s.more.lonerGroup, title: 'Renamed after the removal' })
    clock = Date.now()
    const tab = (await host(cursor)).body.data.tabs.find((t: { tabId: string }) => t.tabId === s.tabId)
    expect(tab?.roster.find((r: { agent?: { id: string } }) => r.agent?.id === s.more.loner)).toMatchObject({ active: false })
  })

  it('still wakes it after two more writes to the group', async () => {
    const s = await hostScene()
    const { cursor } = await fullRead(s.tabId)
    await command(s.tabId, { type: 'conversation.agent', conversationId: s.more.lonerGroup, agentId: s.more.loner, present: false, lead: false })
    await command(s.tabId, { type: 'conversation.rename', conversationId: s.more.lonerGroup, title: 'Once' })
    await command(s.tabId, { type: 'conversation.rename', conversationId: s.more.lonerGroup, title: 'Twice' })
    clock = Date.now()
    const tab = (await host(cursor)).body.data.tabs.find((t: { tabId: string }) => t.tabId === s.tabId)
    expect(tab?.roster.find((r: { agent?: { id: string } }) => r.agent?.id === s.more.loner)).toMatchObject({ active: false })
  })

  /** The host form by POST, with the hashes the host holds for each Swarm's rows. */
  const hostPost = async (body: { cursor?: string; full?: boolean; held?: Record<string, string> }) => {
    clock = Date.now()
    const response = await app.inject({ method: 'POST', url: `/api/super-tabs/hosts/${machine}/changes`, headers: { authorization: `Bearer ${owner.sub}` }, payload: body })
    return { status: response.statusCode, bytes: response.body.length, data: response.json().data as { cursor: string; tabs: Array<Record<string, unknown>> } }
  }
  const entry = (data: { tabs: Array<Record<string, unknown>> }, tabId: string) => data.tabs.find(t => t.tabId === tabId)!

  it('answers "unchanged" for an active Swarm whose rows the host already holds, and sends the rows once one changes', async () => {
    const s = await hostScene()
    const first = await hostPost({ full: true })
    const etag = entry(first.data, s.tabId).etag as string
    expect(etag).toMatch(/^[A-Za-z0-9_-]{16,64}$/)
    // Active: a change that concerns this host (its worker's group), but leaves its rows as they were.
    await command(s.tabId, { type: 'conversation.rename', conversationId: s.web, title: 'Same rows' })
    const same = await hostPost({ cursor: first.data.cursor, held: { [s.tabId]: etag } })
    expect(entry(same.data, s.tabId)).toEqual({ tabId: s.tabId, etag, unchanged: true, lastChangedAt: expect.any(Number) })
    expect(same.bytes).toBeLessThan(first.bytes / 4)
    // One row changes: the machine is paused, so its pool row does.
    await command(s.tabId, { type: 'machine.pause', machineId: machine, paused: true })
    const changed = entry((await hostPost({ cursor: first.data.cursor, held: { [s.tabId]: etag } })).data, s.tabId)
    expect(changed.unchanged).toBeUndefined()
    expect(changed.etag).not.toBe(etag)
    expect(changed).toMatchObject({ pool: { machine: { paused: true } }, roster: expect.any(Array), assignments: expect.any(Array) })
  })

  it('keeps the same hash through the host\'s own reading, and honours held hashes on the full read too', async () => {
    const s = await hostScene()
    const first = await hostPost({ full: true })
    const { etag, pool } = entry(first.data, s.tabId) as { etag: string; pool: { machine: { generation: string } } }
    await reading(s.tabId, pool.machine.generation)
    expect(entry((await hostPost({ full: true, held: { [s.tabId]: etag } })).data, s.tabId)).toMatchObject({ unchanged: true, etag })
  })

  it('rebuilds the rows on a full read even when every version still matches: emails and grants live outside the parts', async () => {
    const s = await hostScene()
    const first = await hostPost({ full: true })
    const etag = entry(first.data, s.tabId).etag as string
    await db.user.update({ where: { id: peer.sub }, data: { email: 'peer-renamed@example.com' } })
    try {
      const full = entry((await hostPost({ full: true, held: { [s.tabId]: etag } })).data, s.tabId) as { unchanged?: true; roster: Array<{ observers?: Array<{ email: string }> }> }
      expect(full.unchanged).toBeUndefined()
      expect(full.roster.flatMap(r => r.observers ?? []).map(o => o.email)).toContain('peer-renamed@example.com')
    } finally { await db.user.update({ where: { id: peer.sub }, data: { email: peer.email } }) }
  })

  it('refuses a malformed held map', async () => {
    await hostScene()
    clock = Date.now()
    const response = await app.inject({ method: 'POST', url: `/api/super-tabs/hosts/${machine}/changes`, headers: { authorization: `Bearer ${owner.sub}` },
      payload: { held: { 'not a tab id!': 'x' } } })
    expect(response.statusCode).toBe(400)
  })

  it('sleeps through a real reading sent through the store', async () => {
    const s = await hostScene()
    const { cursor, generation } = await fullRead(s.tabId)
    await reading(s.tabId, generation)
    clock = Date.now()
    expect((await host(cursor)).body.data).toMatchObject({ tabs: [], removedTabIds: [] })
  })

  it('sleeps through the Lent hours a reading credits to the machine\'s running workers', async () => {
    // Lent counts only work for someone else (leaderboard/lent.ts).
    const s = await hostScene(peer.sub)
    await reading(s.tabId, (await fullRead(s.tabId)).generation)
    const { cursor, generation } = await fullRead(s.tabId)
    await reading(s.tabId, generation)
    const lent = await db.$transaction(async tx => (await parts.loadActive(tx, s.tabId)).machines.find(m => m.key === machine)!.data!.contribution?.lent)
    expect(lent?.[0]?.busyMs).toBeGreaterThan(0)
    clock = Date.now()
    expect((await host(cursor)).body.data).toMatchObject({ tabs: [], removedTabIds: [] })
  })

  it('names a Swarm that no longer lists the machine', async () => {
    const s = await hostScene()
    clock = NOW
    const cursor = (await host(undefined, true)).body.data.cursor
    await db.superTab.update({ where: { id: s.tabId }, data: { machineIds: [], cleanupMachineIds: [] } })
    await db.$transaction(async tx => {
      const stored = (await parts.loadActive(tx, s.tabId)).machines.find(m => m.key === machine)!
      // As the commit writes it: the contribution ended, so the settings marker moves (parts/commit.ts).
      await guardedWrite(tx, s.tabId, { op: 'update', kind: 'machine', key: machine, seen: stored.version, data: { ...stored.data!, contribution: null },
        host: { hostChangedAt: new Date(NOW + 1_000) } }, NOW + 1_000)
    })
    clock = NOW + 2_000
    expect((await host(cursor)).body.data).toMatchObject({ tabs: [], removedTabIds: [s.tabId] })
  })

  it('refuses a machine the caller does not own', async () => {
    await hostScene()
    const { status, body } = await host(undefined, true, peer)
    expect([status, body.error!.code]).toEqual([403, 'HOST_UNAVAILABLE'])
  })
})

describe('a real command through the store by parts (design 4.7)', () => {
  it('replies with the parts it wrote, and the next poll sends exactly those versions', async () => {
    const s = await scene()
    // The store stamps with the real clock; readers here keep to it too.
    clock = Date.now()
    const cursor = (await get(`/api/super-tabs/${s.tabId}/parts`, peer)).body.data.cursor
    const response = await app.inject({ method: 'POST', url: `/api/super-tabs/${s.tabId}/commands`, headers: { authorization: `Bearer ${owner.sub}` },
      payload: { operationId: randomUUID(), command: { type: 'conversation.rename', conversationId: s.web, title: 'Renamed for real' } } })
    expect(response.statusCode, response.body).toBe(200)
    const reply = response.json().data as { result: unknown; parts: Array<{ kind: string; key: string; version: number }>; lastChangedAt: number }
    expect(Object.keys(reply).sort()).toEqual(['lastChangedAt', 'parts', 'result'])
    const written = reply.parts.find(p => p.kind === 'group' && p.key === s.web)!
    expect(written.version).toBeGreaterThan(R)
    clock = Date.now()
    const seen = (await get(`/api/super-tabs/${s.tabId}/changes?cursor=${cursor}`, peer)).body.data
    // The task's message in its project chat is never edited (plain chat, task #2294): only the task is written.
    expect(reply.parts.filter(p => p.kind === 'group').map(p => [p.key, p.version])).toEqual([[s.web, written.version]])
    expect(seen.groups.map((g: { key: string; version: number; data: { title: string } }) => [g.key, g.version, g.data.title]))
      .toEqual([[s.web, written.version, 'Renamed for real']])
    expect(seen.lastChangedAt).toBe(reply.lastChangedAt)
  })
})

// Task #2906: an unchanged poll leaves out the machine and agent summary the reader already holds (12 KB a poll at 36
// machines, 92 KB at 360). A released client, which echoes no etag, still gets it whole.
describe('the summary only when it changed (derivedEtag)', () => {
  const read = async (url: string, as: AuthUser) => { clock = Date.now(); return (await get(url, as)).body.data }
  const poll = (tabId: string, cursor: string, as: AuthUser, etag?: string) =>
    read(`/api/super-tabs/${tabId}/changes?cursor=${cursor}${etag ? `&derivedEtag=${etag}` : ''}`, as)
  /** The agent marked down, written to its part as a reading would: a command would leave its notices and wakes running into the
   *  next tests, whose database-byte counts (group 3b) then count them. */
  const down = async (tabId: string, agentId: string) => {
    await swarmTransaction(db, async tx => {
      const agent = (await parts.loadActive(tx, tabId)).agents.find(a => a.key === agentId)!
      await guardedWrite(tx, tabId, { op: 'update', kind: 'agent', key: agentId, seen: agent.version,
        data: { ...agent.data!, downSince: new Date().toISOString() } }, Date.now())
    })
  }

  it('stamps a first load and a change read alike, and an echoed etag gets no summary', async () => {
    const s = await scene()
    const first = await read(`/api/super-tabs/${s.tabId}/parts`, peer)
    expect(first.derivedEtag).toMatch(/^[A-Za-z0-9_-]{22}$/)
    const unchanged = await poll(s.tabId, first.cursor, peer, first.derivedEtag)
    expect(unchanged).toMatchObject({ reload: false, derivedEtag: first.derivedEtag, derivedUnchanged: true })
    expect(Object.keys(unchanged.derived).filter(k => !['readMarks', 'unreadMarks', 'threadMarks', 'chatSettings'].includes(k))).toEqual([])
  })

  it('sends the whole summary to a client that echoes none, or another etag', async () => {
    const s = await scene()
    const first = await read(`/api/super-tabs/${s.tabId}/parts`, peer)
    for (const etag of [undefined, 'not-the-etag']) {
      const reply = await poll(s.tabId, first.cursor, peer, etag)
      expect(reply.derivedUnchanged, String(etag)).toBeUndefined()
      expect(reply.derivedEtag, String(etag)).toBe(first.derivedEtag)
      expect(reply.derived, String(etag)).toEqual(first.derived)
    }
  })

  it('a summary change after an unchanged poll sends it whole, with a new etag', async () => {
    const s = await scene()
    const first = await read(`/api/super-tabs/${s.tabId}/parts`, peer)
    expect(first.derived.agents[s.lead].downSince).toBeNull()
    const quiet = await poll(s.tabId, first.cursor, peer, first.derivedEtag)
    expect(quiet.derivedUnchanged).toBe(true)
    await down(s.tabId, s.lead)
    const moved = await poll(s.tabId, quiet.cursor, peer, quiet.derivedEtag)
    expect(moved.derivedUnchanged).toBeUndefined()
    expect(moved.derivedEtag).not.toBe(first.derivedEtag)
    expect(moved.derived.agents[s.lead].downSince).toEqual(expect.any(String))
    expect((await poll(s.tabId, moved.cursor, peer, moved.derivedEtag)).derivedUnchanged).toBe(true)
  })

  it('an unchanged poll still sends the reader\'s moved marks', async () => {
    const s = await scene()
    const first = await read(`/api/super-tabs/${s.tabId}/parts`, peer)
    await writeReadMark(db, { tabId: s.tabId, personId: peer.sub, conversationId: s.web, sequence: 3, now: Date.now() })
    const reply = await poll(s.tabId, first.cursor, peer, first.derivedEtag)
    expect(reply.derivedUnchanged).toBe(true)
    expect(reply.derived).toEqual({ readMarks: { [s.web]: 3 } })
  })

  it('an etag is the reader\'s own: another reader\'s summary never matches it', async () => {
    const s = await scene()
    const [mine, theirs] = [await read(`/api/super-tabs/${s.tabId}/parts`, peer), await read(`/api/super-tabs/${s.tabId}/parts`, owner)]
    expect(mine.derivedEtag).not.toBe(theirs.derivedEtag)
    const reply = await poll(s.tabId, mine.cursor, peer, theirs.derivedEtag)
    expect(reply.derivedUnchanged).toBeUndefined()
    expect(reply.derived).toEqual(mine.derived)
  })
})

describe('routes given only a store', () => {
  it('read from that store\'s database, not the app-wide client', async () => {
    // On a machine of its own: the full host read loads every Swarm of the machine, and 'host' holds one for each test before this.
    const machineId = `m-${randomUUID().slice(0, 8)}`
    await db.machine.create({ data: { machineId, userId: owner.sub, apiKey: 'fixture-only', managerId: 'fixture', autonomousEnv: 'prod', authMode: 'remote' } })
    const s = await scene(f => { f.contribute(machineId, 'swarm') }, machineId)
    const plain = Fastify()
    plain.setErrorHandler(errorHandler)
    plain.addHook('onRequest', async request => { request.user = owner })
    await plain.register(superTabRoutes, { store: new SuperTabStore(db), github: null })
    await plain.ready()
    try {
      expect((await plain.inject({ method: 'GET', url: `/api/super-tabs/${s.tabId}/parts` })).statusCode).toBe(200)
      const hosts = await plain.inject({ method: 'GET', url: `/api/super-tabs/hosts/${machineId}/changes?full=1` })
      expect(hosts.statusCode).toBe(200)
      // Only this test's own Swarm: a machine shared with every earlier test's Swarm made this read take 4 s here and 10 s on CI.
      expect(hosts.json().data.tabs.map((t: { tabId: string }) => t.tabId)).toEqual([s.tabId])
    } finally { await plain.close() }
  }, 10_000)
})

describe('what a read costs the database (group 3b)', () => {
  /** What MongoDB sent this process, as the benchmark's isolated poll measures it (integration/bench/probe.ts). */
  const sent = async () => {
    const out = ((await db.$runCommandRaw({ serverStatus: 1 })) as { network: { bytesOut: unknown } }).network.bytesOut
    return typeof out === 'number' ? out : Number((out as { $numberLong?: string; $numberInt?: string }).$numberLong ?? (out as { $numberInt?: string }).$numberInt)
  }
  /** The model calls this client has begun and not finished, and when it last began or finished one. A read that load holds
   *  back sends nothing yet, so the byte count alone cannot tell it from quiet; the call itself can. Raw commands (the byte
   *  count's own) carry no model and are left out. */
  let running = 0, lastBusy = 0
  /** A model call held back before it goes out, as CPU load holds one back: a test stalls a read with it and lets it go. */
  let hold: Promise<void> | null = null
  beforeAll(() => {
    db.$use(async (params, next) => {
      if (!params.model) return next(params)
      running++
      lastBusy = Date.now()
      try {
        if (hold) await hold
        return await next(params)
      } finally { running--; lastBusy = Date.now() }
    })
  })
  /** Waits until nothing else is reading or writing: for four tenths of a second no model call began, ended or was running,
   *  and what MongoDB sends in a tenth of a second (the first read's own answer and whatever else lands meanwhile) is the
   *  same four times running. Earlier tests' background work (a command's notices and wakes, a read a timed-out test left
   *  going, one that load has not let out yet) would otherwise land in the next test's count. */
  const quiet = async () => {
    let last = -1, steady = 0
    for (let tries = 0; tries < 300 && steady < 4; tries++) {
      const windowStart = Date.now()
      const before = await sent()
      await new Promise(done => setTimeout(done, 100))
      const sentSince = await sent() - before
      const still = running === 0 && lastBusy < windowStart
      steady = still && sentSince === last ? steady + 1 : 0
      last = sentSince
    }
    if (steady < 4) throw new Error('The database never went quiet: something keeps reading or writing.')
  }
  async function databaseBytes(call: () => Promise<unknown>): Promise<number> {
    await quiet()
    const before = await sent(), own = await sent() - before
    const start = await sent()
    await call()
    return Math.max(0, await sent() - start - own)
  }
  /** The whole Swarm as stored: what a read that reassembles it loads. */
  const swarmBytes = async (tabId: string) => {
    const all = await db.$transaction(tx => parts.loadAll(tx, tabId))
    return [all.head, ...all.members, ...all.agents, ...all.groups, ...all.machines, ...all.starts, ...all.progress].reduce((n, p) => n + JSON.stringify(p.data).length, 0)
  }
  /** Sixty more conversations with long briefs, as a busy Swarm's history makes them (about half a megabyte). */
  const bulky = (s: ReturnType<typeof swarm>) => {
    for (let i = 0; i < 60; i++) s.run({ type: 'conversation.create', title: `Old work ${i}`, brief: `${'Long brief text. '.repeat(470)}${i}`, checks: [] })
  }

  it('counts none of the reads an earlier test left running', async () => {
    const s = await scene(f => bulky(f))
    // What a test that ends before its own background work does: reads of the whole Swarm, still going into the next one.
    let underway = () => {}
    const begun = new Promise<void>(done => { underway = done })
    const leftover = (async () => { for (let i = 0; i < 40; i++) { await db.$transaction(tx => parts.loadAll(tx, s.tabId)); underway() } })()
    // A transaction that load has not started yet is no model call to see: wait until the reads are going, then for them to end.
    await begun
    expect(await databaseBytes(() => new Promise(done => setTimeout(done, 200)))).toBeLessThan(1_000)
    await leftover
  })

  it('counts none of the reads an earlier test left that had not reached the database yet', async () => {
    const s = await scene(f => bulky(f))
    // A read held back by load: it sends nothing until it is let go, so the database looks quiet while it is still coming.
    let release = () => {}
    hold = new Promise<void>(done => { release = done })
    const letGo = () => { hold = null; release() }
    const timer = setTimeout(letGo, 1_500)
    const leftover = (async () => { for (let i = 0; i < 40; i++) await db.$transaction(tx => parts.loadAll(tx, s.tabId)) })()
    try {
      // The test's own call lets the held read go, the moment counting starts: a count that began while it was still held counts it.
      expect(await databaseBytes(() => { letGo(); return new Promise(done => setTimeout(done, 200)) })).toBeLessThan(1_000)
    } finally { clearTimeout(timer); letGo() }
    await leftover
  })

  it('counts none of the driver\'s own heartbeat answers: an idle database sends nothing for longer than one heartbeat', async () => {
    // The driver asks MongoDB how it is every ten seconds and the answer, two of them about 745 bytes each, lands in whatever window
    // is open (1,490 bytes in the batch of 11-06): a window longer than the heartbeat period always holds a whole pair.
    await scene()
    expect(await databaseBytes(() => new Promise(done => setTimeout(done, 11_500)))).toBeLessThan(1_000)
  }, 30_000)

  it('a Desktop change read with nothing changed loads a few tens of KB, not the Swarm', async () => {
    const s = await scene(f => bulky(f))
    const whole = await swarmBytes(s.tabId)
    expect(whole).toBeGreaterThan(400_000)
    clock = Date.now()
    const cursor = (await get(`/api/super-tabs/${s.tabId}/parts`, peer)).body.data.cursor
    clock = Date.now()
    const bytes = await databaseBytes(() => get(`/api/super-tabs/${s.tabId}/changes?cursor=${cursor}`, peer))
    expect(bytes).toBeLessThan(25_000)
  })

  it('still sends a new start in a conversation with no work yet', async () => {
    const s = await scene(f => ({ idle: f.group('Not started yet') }))
    clock = Date.now()
    const cursor = (await get(`/api/super-tabs/${s.tabId}/parts`, owner)).body.data.cursor
    const generation = (await db.swarmMember.findFirst({ where: { tabId: s.tabId, key: owner.sub } }))!.data as { generation: string }
    await db.$transaction(tx => guardedWrite(tx, s.tabId, { op: 'insert', kind: 'start', key: 'queued-start', ordinal: Date.now(), first: R + 1, data: {
      id: 'queued-start', creationId: 'c', actorKey: `person:${owner.sub}`, contributorId: owner.sub, membershipGeneration: generation.generation,
      machineOwnerId: owner.sub, hostGrant: null, harnessId: null, dispatched: false, error: null,
      request: { conversationId: s.more.idle, machineId: 'host', engine: 'codex', name: 'Builder', cwd: '/repo', worktree: false,
        requirements: { memoryBytes: 0, diskBytes: 0, maxCpuPercent: 100, tools: [], devices: [], quotaRequired: false } } } }, Date.now()))
    clock = Date.now()
    expect(keys((await get(`/api/super-tabs/${s.tabId}/changes?cursor=${cursor}`, owner)).body.data.starts)).toEqual(['queued-start'])
  })

  it('still shows the owner an invitation that lands in a conversation with no work', async () => {
    const s = await scene(f => ({ idle: f.group('Landing') }))
    clock = Date.now()
    const cursor = (await get(`/api/super-tabs/${s.tabId}/parts`, owner)).body.data.cursor
    await new SuperTabStore(db).execute(owner, s.tabId, { operationId: randomUUID(),
      command: { type: 'invite.create', email: 'new@example.com', role: 'viewer', conversationId: s.more.idle } })
    clock = Date.now()
    const head = (await get(`/api/super-tabs/${s.tabId}/changes?cursor=${cursor}`, owner)).body.data.head
    expect(head.data.invitations.map((i: { email: string }) => i.email)).toEqual(['new@example.com'])
  })

  it('after one post it loads about what changed', async () => {
    const s = await scene(f => bulky(f))
    clock = Date.now()
    const cursor = (await get(`/api/super-tabs/${s.tabId}/parts`, peer)).body.data.cursor
    // The worker's post: only agents post in a task's chat (agentsOnly.test.ts).
    await new SuperTabStore(db).execute(owner, s.tabId, { operationId: randomUUID(),
      command: { type: 'message.send', conversationId: s.web, text: 'One post', replyTo: null, recipientIds: [] } }, s.worker)
    clock = Date.now()
    let groups: string[] = []
    const bytes = await databaseBytes(async () => {
      groups = (await get(`/api/super-tabs/${s.tabId}/changes?cursor=${cursor}`, peer)).body.data.groups.map((g: { key: string }) => g.key)
    })
    // The task alone: no board pulse on its project's chat moves with it (Swarm v4).
    expect(groups).toEqual([s.web])
    expect(bytes).toBeLessThan(30_000)
  })

  it('the host form answers "unchanged" after a post in its agent\'s group without loading conversation bodies', async () => {
    const machineId = `m-${randomUUID().slice(0, 8)}`
    await db.machine.create({ data: { machineId, userId: owner.sub, apiKey: 'fixture-only', managerId: 'fixture', autonomousEnv: 'prod', authMode: 'remote' } })
    const s = await scene(f => { f.contribute(machineId, 'swarm'); bulky(f) }, machineId)
    const post = (body: Record<string, unknown>) => app.inject({ method: 'POST', url: `/api/super-tabs/hosts/${machineId}/changes`,
      headers: { authorization: `Bearer ${owner.sub}` }, payload: body })
    clock = Date.now()
    const first = (await post({ full: true })).json().data as { cursor: string; tabs: Array<{ tabId: string; etag: string }> }
    const etag = first.tabs.find(t => t.tabId === s.tabId)!.etag
    await new SuperTabStore(db).execute(owner, s.tabId, { operationId: randomUUID(),
      command: { type: 'message.send', conversationId: s.web, text: 'Busy', replyTo: null, recipientIds: [] } }, s.worker)
    clock = Date.now()
    let answer: Record<string, unknown> | undefined
    const bytes = await databaseBytes(async () => {
      answer = ((await post({ cursor: first.cursor, held: { [s.tabId]: etag } })).json().data.tabs as Array<Record<string, unknown>>).find(t => t.tabId === s.tabId)
    })
    expect(answer).toMatchObject({ unchanged: true, etag: expect.stringMatching(/^[A-Za-z0-9_-]{44}$/) })
    // From version columns alone: building the rows from light conversations costs about 39 KB here, this about 10 KB.
    expect(bytes).toBeLessThan(20_000)
  })

  // Every host reads each second (a production backend went to 5 pods on it, 2026-10-27): a Swarm with no change for it
  // must not cost the newest-change aggregate, seven groupBy over all its parts.
  it('the host poll reads a Swarm that keeps an old state without ever loading that state', async () => {
    const machineId = `m-${randomUUID().slice(0, 8)}`
    await db.machine.create({ data: { machineId, userId: owner.sub, apiKey: 'fixture-only', managerId: 'fixture', autonomousEnv: 'prod', authMode: 'remote' } })
    const s = await scene(f => { f.contribute(machineId, 'swarm') }, machineId)
    const padding = 'old-state-'.repeat(2_000)
    await db.superTab.update({ where: { id: s.tabId }, data: { legacyState: { padding } } })
    const reads: Array<{ operation: string; select: Record<string, unknown> | undefined }> = []
    const rawRows: Array<Record<string, unknown>> = []
    // A named-index read (parts/indexed.ts readBy) names its fields in the $project that ends its pipeline: only an inclusion
    // projection counts, since one that only leaves fields out (`{ _id: 0 }`, `{ padding: 0 }`) still returns the old state.
    const included = (stage: { $project?: Record<string, unknown> } | undefined) => {
      const fields = Object.entries(stage?.$project ?? {})
      return fields.some(([, on]) => on === 1 || on === true)
        && fields.every(([field, on]) => on === 1 || on === true || (field === '_id' && (on === 0 || on === false))) ? stage!.$project : undefined
    }
    const client = db.$extends({ query: { $allModels: { async $allOperations({ model, operation, args, query }) {
      const raw = operation === 'aggregateRaw'
      if (model === 'SuperTab') {
        reads.push({ operation, select: raw ? included((args as { pipeline?: Array<{ $project?: Record<string, unknown> }> }).pipeline?.at(-1))
          : (args as { select?: Record<string, unknown> }).select })
      }
      const result = await query(args)
      // And what the database answered: no raw row holds the old state, whatever the pipeline says.
      if (model === 'SuperTab' && raw) rawRows.push(...result as unknown as Array<Record<string, unknown>>)
      return result
    } } } }) as unknown as PrismaClient
    const hosts = new HostReads(new SuperTabStore(client), { now: () => clock })
    clock = Date.now()

    const first = await hosts.changes(owner, machineId, { full: true })
    clock = Date.now()
    const idle = await hosts.changes(owner, machineId, { cursor: first.cursor })

    expect(first.tabs).toHaveLength(1)
    expect(JSON.stringify([first, idle])).not.toContain('old-state-')
    // The poll reads the Swarm's row for its list and its owner, each time by naming the fields (Prisma's select, or a raw
    // read's closing inclusion $project): none is the old state, and no raw row the database returned holds it.
    expect(reads.length).toBeGreaterThan(0)
    for (const read of reads) expect(read.select, read.operation).toBeDefined()
    for (const read of reads) expect(read.select).not.toHaveProperty('legacyState')
    for (const row of rawRows) expect(Object.keys(row)).not.toContain('legacyState')
  })

  it('the host form asks for the newest change only of the Swarms it answers for', async () => {
    const machineId = `m-${randomUUID().slice(0, 8)}`
    await db.machine.create({ data: { machineId, userId: owner.sub, apiKey: 'fixture-only', managerId: 'fixture', autonomousEnv: 'prod', authMode: 'remote' } })
    const s = await scene(f => { f.contribute(machineId, 'swarm') }, machineId)
    const ops: string[] = []
    const client = db.$extends({ query: { $allModels: { async $allOperations({ model, operation, args, query }) {
      ops.push(`${model}.${operation}${operation === 'aggregateRaw' && JSON.stringify(args).includes('"$first":"$changedAt"') ? ':newest' : ''}`)
      return query(args)
    } } } }) as unknown as PrismaClient
    const hosts = new HostReads(new SuperTabStore(client), { now: () => clock })
    clock = Date.now()
    // The newest change is one Mongo `$group` per part kind, and never a Prisma groupBy.
    const newestReads = () => ops.filter(op => /^Swarm(Head|Member|Agent|Group|Machine|Start|Progress)\.aggregateRaw:newest$/.test(op))
    const first = await hosts.changes(owner, machineId, { full: true })
    expect(newestReads()).toHaveLength(7)
    expect(ops.filter(op => op.endsWith('.groupBy'))).toEqual([])
    ops.length = 0
    clock = Date.now()
    const idle = await hosts.changes(owner, machineId, { cursor: first.cursor })
    expect(idle.tabs).toEqual([])
    expect(newestReads()).toEqual([])
    await new SuperTabStore(db).execute(owner, s.tabId, { operationId: randomUUID(),
      command: { type: 'message.send', conversationId: s.web, text: 'Busy', replyTo: null, recipientIds: [] } }, s.worker)
    clock = Date.now()
    const woken = (await hosts.changes(owner, machineId, { cursor: idle.cursor })).tabs
    const posted = (await db.swarmGroup.findFirst({ where: { tabId: s.tabId, key: s.web } }))!.changedAt.getTime()
    expect(woken).toMatchObject([{ tabId: s.tabId, lastChangedAt: posted }])
  })

describe('a change poll reads only the starts it can send (prod 10-29)', () => {
  /** A busy week's finished starts: prod's largest Swarm held 763 on 10-29 and adds about 300 a day, kept 7 days. */
  const FINISHED = 1000
  type StartRow = { id: string; harnessId: string | null }
  const startOf = (id: string, conversationId: string, harnessId: string | null, generation: string) => ({ id, creationId: `c-${id}`,
    actorKey: `person:${owner.sub}`, contributorId: owner.sub, membershipGeneration: generation, machineOwnerId: owner.sub, hostGrant: null,
    harnessId, dispatched: !!harnessId, error: null,
    request: { conversationId, machineId: 'host', engine: 'codex' as const, name: 'Builder', cwd: '/repo', worktree: false,
      requirements: { memoryBytes: 0, diskBytes: 0, maxCpuPercent: 100, tools: [], devices: [], quotaRequired: false } } })

  /** The host machine lists, as stopped, a harness of a finished start that never became an agent ("ghost"), one of a finished
   *  start in the owner's private project ("secret-old") and one nobody's ("stale"). Finished starts: FINISHED old ones, ghost,
   *  secret-old and one to be removed. Unfinished: "finishing" (it finishes after the cursor) and "queued". */
  const startsScene = () => scene((f, ids) => {
    f.contribute('host', 'swarm')
    // Active conversations: a reader never sees the starts of a dormant one, in a full read or a poll.
    const publicStarts = f.group('Starts'), secretStarts = f.group('Secret starts', ids.secret)
    f.edit(state => {
      const generation = state.people.find(p => p.id === owner.sub)!.generation
      const pool = state.machines!.find(m => m.machineId === 'host')!
      pool.observation = { generation: pool.generation, receivedAt: MIGRATED,
        resources: { cpuPercent: null, memoryTotalBytes: null, memoryUsedBytes: null, diskFreeBytes: null, diskTotalBytes: null, projectDiskFreeBytes: null,
          deviceType: null, chip: null, os: null, gpuPercent: null }, tools: {}, quotas: [],
        runningHarnessIds: ['worker-harness'], stoppedHarnessIds: ['ghost-harness', 'secret-harness', 'stale-harness'] } as never
      state.starts = [
        ...Array.from({ length: FINISHED }, (_, i) => startOf(`old-${i}`, publicStarts, `old-harness-${i}`, generation)),
        startOf('ghost', publicStarts, 'ghost-harness', generation),
        startOf('secret-old', secretStarts, 'secret-harness', generation),
        startOf('removed', secretStarts, 'removed-harness', generation),
        startOf('finishing', publicStarts, null, generation),
        startOf('queued', publicStarts, null, generation),
      ] as never
    })
    return { publicStarts, secretStarts }
  })

  /** After the cursor: "finishing" gets its harness (finished), "removed" is removed, and the host reports again. */
  async function changeAfterCursor(tabId: string) {
    const at = Date.now()
    await swarmTransaction(db, async tx => {
      const row = (key: string) => tx.swarmStart.findUniqueOrThrow({ where: { id: `${tabId}:${key}` } })
      const finishing = await row('finishing'), removed = await row('removed')
      await guardedWrite(tx, tabId, { op: 'update', kind: 'start', key: 'finishing', seen: finishing.version,
        data: { ...(finishing.data as object), harnessId: 'finishing-harness', dispatched: true } as never }, at)
      await guardedWrite(tx, tabId, { op: 'remove', kind: 'start', key: 'removed', seen: removed.version, data: removed.data as never }, at)
      const machine = await tx.swarmMachine.findUniqueOrThrow({ where: { id: `${tabId}:host` } })
      const data = structuredClone(machine.data) as { contribution: { observation: { receivedAt: number } } }
      data.contribution.observation.receivedAt = at
      await guardedWrite(tx, tabId, { op: 'update', kind: 'machine', key: 'host', seen: machine.version, data: data as never }, at)
    })
  }
  const stopped = (machines: Array<{ key: string; data: { observation?: { stoppedHarnessIds: string[]; runningHarnessIds: string[] } } }>) =>
    machines.filter(m => m.key === 'host').map(m => ({ running: m.data.observation?.runningHarnessIds, stopped: m.data.observation?.stoppedHarnessIds }))

  it('each reader gets exactly the starts and machine record a full read gives them', async () => {
    const s = await startsScene()
    clock = Date.now()
    const cursors = { owner: (await get(`/api/super-tabs/${s.tabId}/parts`, owner)).body.data.cursor, peer: (await get(`/api/super-tabs/${s.tabId}/parts`, peer)).body.data.cursor }
    await changeAfterCursor(s.tabId)
    clock = Date.now()
    for (const [name, reader] of [['owner', owner], ['peer', peer]] as const) {
      const changes = (await get(`/api/super-tabs/${s.tabId}/changes?cursor=${cursors[name]}`, reader)).body.data
      const full = (await get(`/api/super-tabs/${s.tabId}/parts`, reader)).body.data
      // What the old full read sent: the changed start as a first load shows it, and the machine record as a first load shows it.
      expect(changes.starts.filter((p: { deleted?: boolean }) => !p.deleted), name).toEqual(full.starts.filter((p: { key: string }) => p.key === 'finishing'))
      expect(changes.machines.filter((m: { key: string }) => m.key === 'host'), name).toEqual(full.machines.filter((m: { key: string }) => m.key === 'host'))
      if (name === 'owner') {
        // The owner reads the private project: its removed start's stub, and its finished start's harness on the machine.
        expect(changes.starts.map((p: { key: string; deleted?: boolean }) => [p.key, !!p.deleted]).sort()).toEqual([['finishing', false], ['removed', true]])
        expect(stopped(changes.machines)).toEqual([{ running: ['worker-harness'], stopped: ['ghost-harness', 'secret-harness'] }])
      } else {
        // A collaborator outside it: no stub, no harness, nothing that names the private project's starts.
        expect(changes.starts.map((p: { key: string }) => p.key)).toEqual(['finishing'])
        expect(stopped(changes.machines)).toEqual([{ running: ['worker-harness'], stopped: ['ghost-harness'] }])
        expect(JSON.stringify(changes)).not.toMatch(/secret-harness|removed-harness|secret-old/)
      }
    }
  })

  it('an agent stored with no project stays hidden from a collaborator when only a finished start holds its private conversation', async () => {
    const s = await scene((f, ids) => {
      f.contribute('host', 'swarm')
      const secretStarts = f.group('Secret starts', ids.secret)
      const loner = f.add('loner-harness', secretStarts, false, ownerActor, 'host', owner.sub)
      f.edit(state => {
        const generation = state.people.find(p => p.id === owner.sub)!.generation
        state.starts = [startOf('loner-start', secretStarts, 'loner-harness', generation)] as never
      })
      return { loner, secretStarts }
    })
    clock = Date.now()
    const cursors = { owner: (await get(`/api/super-tabs/${s.tabId}/parts`, owner)).body.data.cursor, peer: (await get(`/api/super-tabs/${s.tabId}/parts`, peer)).body.data.cursor }
    await swarmTransaction(db, async tx => {
      const agent = await tx.swarmAgent.findUniqueOrThrow({ where: { id: `${s.tabId}:${s.more.loner}` } })
      // As prod still holds some (6 of 48 live agents, 10-29): no stored project, so it is read from the conversation it is in
      // (projects.ts agentProjectId). Migration stores one, so the part loses it here.
      const { projectId: _stored, ...data } = agent.data as { projectId?: string }
      await guardedWrite(tx, s.tabId, { op: 'update', kind: 'agent', key: s.more.loner, seen: agent.version,
        // Kept after its work: an agent with no stored decision has its active conversations loaded anyway (light.ts undecidedWork).
        data: { ...data, name: 'Loner, renamed', workDecision: 'keep' } as never }, Date.now())
    })
    clock = Date.now()
    const changes = async (reader: AuthUser, cursor: string) => (await get(`/api/super-tabs/${s.tabId}/changes?cursor=${cursor}`, reader)).body.data
    expect(keys((await changes(owner, cursors.owner)).agents)).toEqual([s.more.loner])
    const seen = await changes(peer, cursors.peer)
    expect(keys(seen.agents)).toEqual([])
    expect(JSON.stringify(seen)).not.toMatch(/Loner|loner-harness/)
  })

  it(`a change poll of a Swarm with ${FINISHED} finished starts reads a few tens of KB, not every start`, async () => {
    const s = await startsScene()
    const starts = (await db.swarmStart.findMany({ where: { tabId: s.tabId } })).reduce((n, row) => n + JSON.stringify(row.data).length, 0)
    expect(starts).toBeGreaterThan(400_000)
    clock = Date.now()
    const cursor = (await get(`/api/super-tabs/${s.tabId}/parts`, peer)).body.data.cursor
    clock = Date.now()
    const bytes = await databaseBytes(() => get(`/api/super-tabs/${s.tabId}/changes?cursor=${cursor}`, peer))
    expect(bytes).toBeLessThan(25_000)
  })

  it('reads its starts by index: whole ones only as many as it returns, and no collection scan', async () => {
    const s = await startsScene()
    clock = Date.now()
    const cursor = (await get(`/api/super-tabs/${s.tabId}/parts`, owner)).body.data.cursor
    await changeAfterCursor(s.tabId)
    clock = Date.now()
    await db.$runCommandRaw({ profile: 0 })
    await db.$runCommandRaw({ drop: 'system.profile' }).catch(() => {})
    await db.$runCommandRaw({ create: 'system.profile', capped: true, size: 16 * 1024 * 1024 })
    await db.$runCommandRaw({ profile: 2, slowms: 0 })
    try {
      expect((await get(`/api/super-tabs/${s.tabId}/changes?cursor=${cursor}`, owner)).status).toBe(200)
    } finally { await db.$runCommandRaw({ profile: 0 }) }
    const reply = await db.$runCommandRaw({ aggregate: 'system.profile', pipeline: [{ $match: { ns: { $regex: '\\.SwarmStart$' } } },
      { $set: { distinct: '$command.distinct' } }, { $project: { ...PROFILE_STAGES[0]!.$project, distinct: 1 } }], cursor: {} }) as unknown as
      { cursor: { firstBatch: Array<ProfileEntry & { distinct?: string }> } }
    const reads = reply.cursor.firstBatch.map(row => ({ ...profileEntry(row), distinct: !!row.distinct }))
    expect(reads.length).toBeGreaterThan(0)
    expect(reads.filter(r => r.planSummary === 'COLLSCAN')).toEqual([])
    // Whole starts: the unfinished one, the two changed (the change feed's own read), and those a machine lists (ghost,
    // secret-old). The Swarm's newest change reads index keys only (docs 0).
    const whole = reads.filter(r => !r.distinct && (r.docsExamined ?? 0) > 0)
    expect(whole.reduce((n, r) => n + (r.nreturned ?? 0), 0)).toBeLessThanOrEqual(5)
    for (const r of whole) expect(r.docsExamined, JSON.stringify(r)).toBeLessThanOrEqual((r.nreturned ?? 0) + 1)
    // No read over every live start, not even of their conversation ids (DB 2.3).
    expect(reads.filter(r => r.distinct)).toEqual([])
  })

  describe('a change poll reads only what its reply needs (DB 2.3)', () => {
    /** After the migration (which stores derived decisions), the agent has none, as a loss after it leaves it. */
    async function withoutDecision(tabId: string, agentId: string) {
      await swarmTransaction(db, async tx => {
        const agent = await tx.swarmAgent.findUniqueOrThrow({ where: { id: `${tabId}:${agentId}` } })
        const { workDecision: _gone, ...data } = agent.data as { workDecision?: string }
        await guardedWrite(tx, tabId, { op: 'update', kind: 'agent', key: agentId, seen: agent.version, data: data as never }, Date.now())
      })
    }

    it('reads an agent that is only a member of running work as awaiting its decision, as a full read does', async () => {
      // X finished work alone in an active conversation with no start, and is a member (not the worker) of running work.
      const s = await scene((f, ids) => {
        const alone = f.group('Finished alone')
        const member = f.add('member-harness', alone, false, ownerActor, 'host', owner.sub)
        f.edit(state => {
          storedAssignment(state, alone, member, MIGRATED)
          const group = state.conversations.find(c => c.id === alone)!
          group.assignment = { ...group.assignment!, status: 'done', result: 'Shipped' }
          state.conversations.find(c => c.id === ids.web)!.agentIds.push(member)
        })
        return { alone, member }
      })
      await withoutDecision(s.tabId, s.more.member)
      clock = Date.now()
      const cursor = (await get(`/api/super-tabs/${s.tabId}/parts`, owner)).body.data.cursor
      await writeGroup(s.tabId, s.web, Date.now(), g => { g.title = 'Web, renamed' })
      clock = Date.now()
      const changes = (await get(`/api/super-tabs/${s.tabId}/changes?cursor=${cursor}`, owner)).body.data
      const full = (await get(`/api/super-tabs/${s.tabId}/parts`, owner)).body.data
      expect(keys(full.groups)).toContain(s.more.alone)
      expect(full.derived.agents[s.more.member].workDecision).toBe('awaiting')
      expect(changes.derived.agents[s.more.member].workDecision).toBe('awaiting')
    })

    /** A reply's derived values without what differs by design: a first load sends every read mark (and avatar link), a
     *  change read only the marks moved since its cursor. */
    const derivedOf = ({ readMarks: _marks, threadMarks: _threads, avatars: _avatars, ...rest }: Record<string, unknown>) => rest
    /** The agent's part as prod still holds some (6 of 66 live agents, 10-30): no stored project (projects.ts agentProjectId). */
    async function withoutProject(tabId: string, agentId: string) {
      await swarmTransaction(db, async tx => {
        const agent = await tx.swarmAgent.findUniqueOrThrow({ where: { id: `${tabId}:${agentId}` } })
        const { projectId: _stored, ...data } = agent.data as { projectId?: string }
        await guardedWrite(tx, tabId, { op: 'update', kind: 'agent', key: agentId, seen: agent.version, data: data as never }, Date.now())
      })
    }

    it('gives every reader the derived values a full read gives', async () => {
      const s = await scene((f, ids) => {
        f.contribute('host', 'swarm')
        const oldStarts = f.group('Old starts'), liveStarts = f.group('Starts'), quietSecret = f.group('Quiet secret starts', ids.secret)
        const secretTalk = f.group('Secret talk', ids.secret), alone = f.group('Finished alone')
        // Stored with no project below: it takes the private project from the conversation it is in.
        const legacy = f.add('legacy-harness', secretTalk, false, ownerActor, 'host', owner.sub)
        // No stored decision below: finished work alone, and a member (not the worker) of running work.
        const member = f.add('member-harness', alone, false, ownerActor, 'host', owner.sub)
        f.edit(state => {
          storedAssignment(state, alone, member, MIGRATED)
          const group = state.conversations.find(c => c.id === alone)!
          group.assignment = { ...group.assignment!, status: 'done', result: 'Shipped' }
          state.conversations.find(c => c.id === ids.web)!.agentIds.push(member)
          const generation = state.people.find(p => p.id === owner.sub)!.generation
          const pool = state.machines!.find(m => m.machineId === 'host')!
          pool.observation = { generation: pool.generation, receivedAt: MIGRATED,
            resources: { cpuPercent: null, memoryTotalBytes: null, memoryUsedBytes: null, diskFreeBytes: null, diskTotalBytes: null, projectDiskFreeBytes: null,
              deviceType: null, chip: null, os: null, gpuPercent: null }, tools: {}, quotas: [],
            runningHarnessIds: ['worker-harness'], stoppedHarnessIds: ['listed-harness', 'quiet-secret-harness'] } as never
          // Finished starts a machine lists: one in an active conversation no light base holds, one in a private conversation
          // that goes quiet. In a public one that goes quiet: one that changes after the cursor, and one removed.
          state.starts = [startOf('listed', liveStarts, 'listed-harness', generation), startOf('quiet-secret', quietSecret, 'quiet-secret-harness', generation),
            startOf('changing', oldStarts, 'changing-harness', generation), startOf('old', oldStarts, 'old-harness', generation)] as never
        })
        return { oldStarts, quietSecret, secretTalk, legacy, member, alone }
      })
      const { tabId, more } = s
      for (const key of [more.oldStarts, more.quietSecret]) await writeGroup(tabId, key, Date.now(), g => { g.dormant = true })
      await withoutProject(tabId, more.legacy)
      await withoutDecision(tabId, more.member)

      const readers = [['owner', owner, undefined], ['peer', peer, undefined], ['worker', owner, s.worker],
        ['legacy agent', owner, more.legacy]] as const
      const query = (agentId?: string) => agentId ? `asAgentId=${agentId}` : ''
      clock = Date.now()
      const cursors = new Map<string, string>()
      for (const [name, reader, agentId] of readers) {
        const first = await get(`/api/super-tabs/${tabId}/parts?${query(agentId)}`, reader)
        expect(first.status, name).toBe(200)
        cursors.set(name, first.body.data.cursor)
      }

      // After the cursor: a post, a start changed and one removed in the quiet conversation, a machine report, a progress
      // part, and both people's read marks moved in a quiet conversation.
      const at = Date.now()
      await writeGroup(tabId, s.web, at, g => { g.title = 'Web, renamed' })
      await swarmTransaction(db, async tx => {
        const start = (key: string) => tx.swarmStart.findUniqueOrThrow({ where: { id: `${tabId}:${key}` } })
        const changing = await start('changing'), old = await start('old')
        await guardedWrite(tx, tabId, { op: 'update', kind: 'start', key: 'changing', seen: changing.version,
          data: { ...(changing.data as object), error: 'Stopped by its host' } as never }, at)
        await guardedWrite(tx, tabId, { op: 'remove', kind: 'start', key: 'old', seen: old.version, data: old.data as never }, at)
        const machine = await tx.swarmMachine.findUniqueOrThrow({ where: { id: `${tabId}:host` } })
        const data = structuredClone(machine.data) as { contribution: { observation: { receivedAt: number } } }
        data.contribution.observation.receivedAt = at
        await guardedWrite(tx, tabId, { op: 'update', kind: 'machine', key: 'host', seen: machine.version, data: data as never }, at)
        const progress = { since: at, summarizedFloor: 0, summarized: {}, requestedFloor: 0, requested: {} }
        const held = await tx.swarmProgress.findUnique({ where: { id: `${tabId}:lead` } })
        await guardedWrite(tx, tabId, held ? { op: 'update', kind: 'progress', key: 'lead', seen: held.version, data: progress }
          : { op: 'insert', kind: 'progress', key: 'lead', data: progress, ordinal: 1 }, at)
      })
      for (const personId of [owner.sub, peer.sub]) await writeReadMark(db, { tabId, personId, conversationId: s.done, sequence: 5, now: at })

      clock = Date.now()
      for (const [name, reader, agentId] of readers) {
        const changes = (await get(`/api/super-tabs/${tabId}/changes?cursor=${cursors.get(name)}&${query(agentId)}`, reader)).body.data
        const full = (await get(`/api/super-tabs/${tabId}/parts?${query(agentId)}`, reader)).body.data
        expect(changes.reload, name).toBe(false)
        expect(derivedOf(changes.derived), name).toEqual(derivedOf(full.derived))
        const sent = new Set(changes.starts.map((p: { key: string }) => p.key))
        expect(changes.starts.filter((p: { deleted?: boolean }) => !p.deleted), name).toEqual(full.starts.filter((p: { key: string }) => sent.has(p.key)))
        expect(changes.machines, name).toEqual(full.machines.filter((p: { key: string }) => p.key === 'host'))
        // A quiet conversation is in no first load, so neither its starts nor their harnesses are, the private one's included.
        expect(JSON.stringify(changes), name).not.toMatch(/quiet-secret|changing-harness/)
        expect(changes.progress, name).toEqual(full.progress.filter((p: { key: string }) => p.key === 'lead'))
        // Its project is the private one, read from its conversation: only the owner and the agent itself see it.
        expect(Object.keys(changes.derived.agents).includes(more.legacy), name).toBe(name === 'owner' || name === 'legacy agent')
        if (name === 'owner') expect(changes.derived.agents[more.member].workDecision).toBe('awaiting')
      }
    })
  })
})
})

