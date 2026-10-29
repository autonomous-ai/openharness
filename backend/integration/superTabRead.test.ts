import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
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
import { decisionsWaiting } from '../src/superTabs/decisions.js'
import { buddyChatId } from '../src/superTabs/buddies.js'
import { HostReads } from '../src/superTabs/read/host.js'
import type { Conversation, SuperTabState } from '../src/superTabs/model.js'
import { writeLegacySwarm } from '../scripts/swarm-parts/legacy.js'
import { NOW, outsider as outsiderActor, owner as ownerActor, peer as peerActor, swarm } from '../src/superTabs/read/fixture.test-support.js'

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
  const uri = replica.getUri(`swarm_read_test_${randomUUID().replaceAll('-', '_')}`)
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
  s.run({ type: 'work.assign', conversationId: web, agentId: worker })
  const done = s.group('Done work')
  const secretGroup = s.group('Secret work', secret)
  // peer's Chat with PM from before Buddies replaced it (closed: nobody reads it), and peer's Buddy chat.
  const privateId = s.group('Peer and PM')
  // The Buddy chat keeps the id the backend gives it (buddies.ts buddyChatId), as the PM's lines find it by that id.
  let buddyId = s.group('Peer\'s Buddy')
  s.edit(state => {
    const generation = state.people.find(p => p.id === peer.sub)!.generation
    state.conversations.find(c => c.id === privateId)!.audience = { people: [{ id: peer.sub, generation }] }
    const chat = state.conversations.find(c => c.id === buddyId)!
    buddyId = buddyChatId(chat.projectId ?? 'lead', { id: peer.sub, generation })
    Object.assign(chat, { id: buddyId, kind: 'buddy', leadId: null, agentIds: [], audience: { people: [{ id: peer.sub, generation }] } })
    const finished = state.conversations.find(c => c.id === done)!
    finished.assignment = { ...state.conversations.find(c => c.id === web)!.assignment!, id: 'old-work', status: 'done' }
  })
  const more = extra(s, { web, done, lead, secret })
  const tabId = `tab-${randomUUID()}`
  const state = { ...structuredClone(s.state), id: tabId } as SuperTabState
  await writeLegacySwarm(db, { state, revision: R, messages: [{ id: `${tabId}-m1`, conversationId: done, sequence: 5, text: 'Done',
    author: { kind: 'person', id: owner.sub, name: owner.email, membershipGeneration: tabId }, createdAt: new Date(MIGRATED - 2 * DAY) }] })
  const report = await migrateSwarm(db, tabId, { now: () => MIGRATED })
  if (!report.ok) throw new Error(report.error)
  return { tabId, lead, worker, web, done, secretGroup, privateId, buddyId, secret, leads: state.leadsConversationId!, more }
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
    expect(Object.keys(body.data).sort()).toEqual(['agents', 'cursor', 'derived', 'epoch', 'format', 'groups', 'head', 'lastChangedAt',
      'machines', 'members', 'progress', 'serverTime', 'starts', 'tabId'].sort())
    expect(body.data).toMatchObject({ format: 2, tabId: s.tabId, serverTime: NOW, epoch: 1, lastChangedAt: MIGRATED,
      head: { key: 'head', version: R, changedAt: MIGRATED, data: { id: s.tabId, name: 'Pilot' } } })
    expect(JSON.parse(Buffer.from(body.data.cursor, 'base64url').toString())).toEqual({ v: 2, t: NOW - 30_000, e: 1 })
    expect(keys(body.data.members)).toEqual([owner.sub, peer.sub, outsider.sub])
    expect(keys(body.data.groups)).toEqual(['lead', s.web, s.buddyId, s.leads])
    expect(body.data.derived).toMatchObject({ agents: { [s.lead]: { downSince: null }, [s.worker]: { workDecision: null } }, mentionsWaiting: 0 })
  })

  it('keeps a Buddy chat and the private project from every reader outside them, the PM included, and a closed Chat with PM from all', async () => {
    const s = await scene()
    const groups = async (as: AuthUser, agent?: string) =>
      keys((await get(`/api/super-tabs/${s.tabId}/parts${agent ? `?asAgentId=${agent}` : ''}`, as)).body.data.groups)
    expect(await groups(peer)).toContain(s.buddyId)
    expect(await groups(outsider)).not.toContain(s.secretGroup)
    expect(await groups(owner)).toContain(s.secretGroup)
    for (const [as, agent] of [[outsider], [owner], [owner, s.lead], [owner, s.worker]] as const) expect(await groups(as, agent)).not.toContain(s.buddyId)
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
    await writeGroup(s.tabId, s.buddyId, NOW + 2_000, g => { g.title = 'Private 2' })
    await writeGroup(s.tabId, s.privateId, NOW + 2_000, g => { g.title = 'Closed 2' })
    const seen = (await changes(s.tabId, peerCursor, peer, NOW + 3_000)).body.data
    expect(seen).toMatchObject({ format: 2, reload: false, serverTime: NOW + 3_000, epoch: 1, lastChangedAt: NOW + 2_000 })
    expect(seen.groups.map((g: { key: string; version: number; data: { title: string } }) => [g.key, g.version, g.data.title]))
      .toEqual([[s.web, R + 1, 'Web 2'], [s.buddyId, R + 1, 'Private 2']])
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
  const mention = (tabId: string, conversationId: string, personId: string) => db.superTabMention.create({ data: { id: `${tabId}-${conversationId}-m`,
    tabId, conversationId, messageId: `${tabId}-msg`, personId, projectId: 'lead', authorAgentId: 'lead-agent', createdAt: new Date() } })

  it('derives the same decisions from a change read as from a first load after a task was lost, then cancelled', async () => {
    const s = await scene((f, ids) => f.edit(state => lostThenCancelled(state, ids.web, state.agents.find(a => a.name === 'worker-harness')!.id)))
    await noDecision(s.tabId, s.worker)
    await mention(s.tabId, s.web, peer.sub)
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
    await writeGroup(s.tabId, s.buddyId, NOW + 2_000, () => {}, 'remove')
    expect((await changes(s.tabId, peerCursor, peer, NOW + 3_000)).body.data.groups).toEqual([{ key: s.buddyId, version: R + 1, changedAt: NOW + 2_000, deleted: true }])
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
    await writeGroup(s.tabId, s.buddyId, NOW, g => { g.dormant = true; g.lastActivityAt = new Date(NOW).toISOString() })
    const first = (await get(`/api/super-tabs/${s.tabId}/groups?dormant=1`, outsider)).body.data
    // A group the reader may not see never shortens a page, and the cursor names the last group it got, never a hidden
    // one (security review 2 of #2115).
    expect(first.groups).toHaveLength(50)
    expect(first.groups.every((g: { data: { dormant: boolean } }) => g.data.dormant)).toBe(true)
    expect(keys(first.groups)).not.toContain(s.buddyId)
    expect(JSON.parse(Buffer.from(first.next, 'base64url').toString()).k).toBe(keys(first.groups).at(-1))
    const second = (await get(`/api/super-tabs/${s.tabId}/groups?dormant=1&before=${first.next}`, outsider)).body.data
    expect(second).toMatchObject({ next: null })
    expect(second.groups).toHaveLength(3)
    expect(new Set([...keys(first.groups), ...keys(second.groups)]).size).toBe(53)
    expect(keys((await get(`/api/super-tabs/${s.tabId}/groups?dormant=1`, peer)).body.data.groups)[0]).toBe(s.buddyId)
  })

  it('reads one group by id, dormant or not, and 404s one the reader may not see', async () => {
    const s = await scene()
    expect((await get(`/api/super-tabs/${s.tabId}/groups/${s.done}`, outsider)).body.data.group)
      .toMatchObject({ key: s.done, version: R, data: { id: s.done, dormant: true, messageSeq: R } })
    expect((await get(`/api/super-tabs/${s.tabId}/groups/${s.buddyId}`, peer)).status).toBe(200)
    for (const [id, as] of [[s.buddyId, outsider], [s.buddyId, owner], [s.privateId, peer], [s.secretGroup, outsider], ['missing', owner]] as const) {
      const { status, body } = await get(`/api/super-tabs/${s.tabId}/groups/${id}`, as)
      expect([status, body.error!.code]).toEqual([404, 'NOT_FOUND'])
    }
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
    expect(body.data.tabs).toContainEqual({ id: s.tabId, name: 'Pilot', ownerId: owner.sub, workspaceId: null, paused: false, lastChangedAt: MIGRATED })
  })

  it('reads each Swarm\'s newest change over all its parts, without a groupBy (it once panicked the engine on Mongo)', async () => {
    const [a, b] = [await scene(), await scene()]
    await writeGroup(b.tabId, b.web, MIGRATED + 5_000, group => { group.title = 'Web, renamed' })
    const newest = await db.$transaction(tx => parts.lastChangedAt(tx, [a.tabId, b.tabId, 'tab-with-no-parts']))
    expect(Object.fromEntries(newest)).toEqual({ [a.tabId]: MIGRATED, [b.tabId]: MIGRATED + 5_000 })
    expect((await db.$transaction(tx => parts.lastChangedAt(tx, []))).size).toBe(0)
  })

  it.each(['/api/super-tabs', '/api/super-tabs/TAB', '/api/super-tabs/hosts/host', '/api/super-tabs/hosts/host/pools', '/api/super-tabs/hosts/host/assignments'])(
    'answers %s with 426 Update required', async url => {
      const s = await scene()
      const { status, body } = await get(url.replace('TAB', s.tabId))
      expect(status).toBe(426)
      expect(body.error).toEqual({ code: 'UPDATE_REQUIRED', message: 'Update Harness to keep using this Swarm.' })
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
    expect(rows.get(s.lead)).toMatchObject({ lead: true, active: true, leadsConversationId: s.leads, lastChangedAt: MIGRATED, observers: readers,
      confidential: true, membersWatch: true })
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
    await command(s.tabId, { type: 'message.send', conversationId: s.more.lonerGroup, text: 'Twice', replyTo: null, recipientIds: [] })
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
    expect(seen.groups.map((g: { key: string; version: number; data: { title: string } }) => [g.key, g.version, g.data.title]))
      .toEqual([[s.web, written.version, 'Renamed for real']])
    expect(seen.lastChangedAt).toBe(reply.lastChangedAt)
  })
})

describe('decisions asked of one person (v2)', () => {
  const post = async (tabId: string, command: Record<string, unknown>, as: AuthUser = owner, asAgentId?: string) => {
    const response = await app.inject({ method: 'POST', url: `/api/super-tabs/${tabId}/commands`, headers: { authorization: `Bearer ${as.sub}` },
      payload: { operationId: randomUUID(), command, ...(asAgentId ? { asAgentId } : {}) } })
    return { status: response.statusCode, body: response.json() as { data: { result: Record<string, unknown> }; error?: { code: string } } }
  }
  const decisions = async (tabId: string, as: AuthUser, state = 'open', agent?: string) =>
    (await get(`/api/super-tabs/${tabId}/decisions?state=${state}${agent ? `&asAgentId=${agent}` : ''}`, as)).body.data.decisions as Array<Record<string, any>>
  const question = (text: string) => ({ question: text, options: ['Behind a flag', 'To everyone'], recommended: 0, unblocks: 'The release' })
  /** Decisions the PM asked peer in their Chat with PM before it closed, as rows: none can be asked there now. */
  const askedBefore = async (tabId: string, conversationId: string, lead: string, texts: string[]) => {
    const ids = texts.map(() => `before-${randomUUID()}`)
    await db.superTabDecision.createMany({ data: texts.map((text, i) => ({ id: ids[i]!, tabId, batchId: `${conversationId}-before`, projectId: 'lead',
      conversationId, assignmentId: null, personId: peer.sub, askerAgentId: lead, ...question(text), createdAt: new Date() })) })
    return ids
  }

  it('shows a decision only to the person asked and the agent that asked, and counts it on their first load', async () => {
    const s = await scene()
    clock = Date.now()
    const asked = await post(s.tabId, { type: 'decision.ask', conversationId: s.web, personId: peer.sub, questions: [question('Ship how?'), question('Name it?')] }, owner, s.lead)
    expect(asked.status, JSON.stringify(asked.body)).toBe(200)
    const seen = await decisions(s.tabId, peer)
    expect(seen.map(d => d.question).sort()).toEqual(['Name it?', 'Ship how?'])
    for (const d of seen) expect(d).toMatchObject({ options: ['Behind a flag', 'To everyone'], recommended: 0, unblocks: 'The release', conversationTitle: 'Web', askerAgentId: s.lead })
    expect(new Set(seen.map(d => d.batchId)).size).toBe(1)
    // Not the Swarm's owner, another member, or another agent; the asking Lead does.
    expect(await decisions(s.tabId, owner)).toEqual([])
    expect(await decisions(s.tabId, outsider)).toEqual([])
    expect(await decisions(s.tabId, owner, 'open', s.worker)).toEqual([])
    expect((await decisions(s.tabId, owner, 'open', s.lead)).length).toBe(2)
    expect((await get(`/api/super-tabs/${s.tabId}/parts`, peer)).body.data.derived.decisionsWaiting).toBe(2)
    expect((await get(`/api/super-tabs/${s.tabId}/parts`, owner)).body.data.derived.decisionsWaiting).toBe(0)
  })

  it('takes the person\'s one-tap answer once, and the answer reaches the asking worker and the Lead', async () => {
    const s = await scene()
    clock = Date.now()
    const assignmentId = (await get(`/api/super-tabs/${s.tabId}/parts`, owner)).body.data.groups.find((g: { key: string }) => g.key === s.web).data.assignment.id
    const needs = await post(s.tabId, { type: 'work.status', conversationId: s.web, assignmentId, status: 'needs_human', result: 'Ship to everyone?',
      ask: { personId: peer.sub, options: ['Behind a flag', 'To everyone'], recommended: 0, unblocks: 'Turning it on' } }, owner, s.worker)
    expect(needs.status, JSON.stringify(needs.body)).toBe(200)
    const [open] = await decisions(s.tabId, peer)
    expect(open).toMatchObject({ assignmentId, askerAgentId: s.worker, question: 'Ship to everyone?' })
    const answered = await post(s.tabId, { type: 'decision.answer', decisionId: open!.id, choice: 1, note: 'Go.' }, peer)
    expect(answered.status, JSON.stringify(answered.body)).toBe(200)
    expect(await decisions(s.tabId, peer)).toEqual([])
    expect(await decisions(s.tabId, peer, 'answered')).toEqual([expect.objectContaining({ id: open!.id, choice: 1, note: 'Go.' })])
    expect(await decisions(s.tabId, owner, 'answered', s.worker)).toEqual([expect.objectContaining({ id: open!.id, choice: 1 })])
    const notice = await db.superTabMessage.findUnique({ where: { id: answered.body.data.result.messageId as string } })
    expect(notice).toMatchObject({ conversationId: s.web, recipientIds: [s.worker, s.lead], source: { kind: 'agent-only', decisionId: open!.id } })
    expect((await db.superTabDelivery.findMany({ where: { tabId: s.tabId, messageId: notice!.id } })).map(d => d.agentId).sort()).toEqual([s.lead, s.worker].sort())
    // Once only, and only by the person asked.
    expect((await post(s.tabId, { type: 'decision.answer', decisionId: open!.id, choice: 0 }, peer)).body.error?.code).toBe('DECISION_ANSWERED')
    expect((await post(s.tabId, { type: 'decision.answer', decisionId: open!.id, choice: 0 }, owner)).status).toBe(404)
  })

  it('tells the asker and the Lead with a notice only they read, and puts nothing of the answer where other readers look', async () => {
    const s = await scene()
    clock = Date.now()
    const asked = await post(s.tabId, { type: 'decision.ask', conversationId: s.web, personId: peer.sub, questions: [question('Secret plan?')] }, owner, s.lead)
    const id = (asked.body.data.result.decisionIds as string[])[0]!
    const before = (await get(`/api/super-tabs/${s.tabId}/parts`, owner)).body.data
    const answered = await post(s.tabId, { type: 'decision.answer', decisionId: id, choice: 1, note: 'Only for the Lead.' }, peer)
    expect(answered.status, JSON.stringify(answered.body)).toBe(200)
    const leaks = ['Secret plan?', 'To everyone', 'Only for the Lead.', 'decided']
    const shows = (value: unknown) => leaks.filter(text => JSON.stringify(value).includes(text))
    // Another member who reads the conversation: its messages, a first load and a change read show none of it, and no unread mark.
    const messages = (await get(`/api/super-tabs/${s.tabId}/conversations/${s.web}/messages`, owner)).body.data
    expect(shows(messages)).toEqual([])
    const first = (await get(`/api/super-tabs/${s.tabId}/parts`, owner)).body.data
    expect(shows(first)).toEqual([])
    expect(first.groups.find((g: { key: string }) => g.key === s.web).data.lastMessageSequence)
      .toBe(before.groups.find((g: { key: string }) => g.key === s.web).data.lastMessageSequence)
    clock = Date.now()
    expect(shows((await get(`/api/super-tabs/${s.tabId}/changes?cursor=${before.cursor}`, owner)).body.data)).toEqual([])
    // Nor the person who answered, beyond their own decision; nor the worker, which neither asked nor leads.
    expect(shows((await get(`/api/super-tabs/${s.tabId}/conversations/${s.web}/messages`, peer)).body.data)).toEqual([])
    expect(shows((await get(`/api/super-tabs/${s.tabId}/conversations/${s.web}/messages?asAgentId=${s.worker}`, owner)).body.data)).toEqual([])
    // The Lead gets a notice with no content, pointing to the decisions read, which has the answer.
    const lead = (await get(`/api/super-tabs/${s.tabId}/conversations/${s.web}/messages?asAgentId=${s.lead}`, owner)).body.data.messages as Array<{ id: string; text: string }>
    const notice = lead.find(m => m.id === answered.body.data.result.messageId)!
    expect(shows(notice)).toEqual([])
    expect(notice.text).toContain('harness super-tab decisions --answered')
    expect(await decisions(s.tabId, owner, 'answered', s.lead)).toEqual([expect.objectContaining({ id, choice: 1, note: 'Only for the Lead.' })])
  })

  it('takes an answer to a decision asked in a closed Chat with PM, and refuses one once its person left it, also when retried', async () => {
    const s = await scene()
    clock = Date.now()
    expect((await post(s.tabId, { type: 'decision.ask', conversationId: s.privateId, personId: peer.sub, questions: [question('New?')] }, owner, s.lead)).status).toBe(404)
    const [first, second] = await askedBefore(s.tabId, s.privateId, s.lead, ['Keep it?', 'Ship it?'])
    const retry = { operationId: randomUUID(), command: { type: 'decision.answer', decisionId: first, choice: 0 } }
    const send = (body: unknown) => app.inject({ method: 'POST', url: `/api/super-tabs/${s.tabId}/commands`, headers: { authorization: `Bearer ${peer.sub}` }, payload: body as object })
    expect((await send(retry)).statusCode).toBe(200)
    // The peer stays in the Swarm but leaves the private conversation's audience.
    await writeGroup(s.tabId, s.privateId, Date.now(), group => { group.audience = { people: [] } })
    expect((await post(s.tabId, { type: 'decision.answer', decisionId: second, choice: 0 }, peer)).status).toBe(404)
    expect((await send(retry)).statusCode).toBe(404)
    expect(await decisions(s.tabId, owner, 'open', s.lead)).toEqual([expect.objectContaining({ id: second })])
  })

  it('leaves a decision to the PM: the recommended option, listed as the PM\'s, and the PM\'s line in the person\'s quiet Buddy chat', async () => {
    const s = await scene()
    clock = Date.now()
    const asked = await post(s.tabId, { type: 'decision.ask', conversationId: s.web, personId: peer.sub,
      questions: [{ ...question('Ship how?'), recommended: 1 }] }, owner, s.lead)
    const id = (asked.body.data.result.decisionIds as string[])[0]!
    // The person's Buddy chat went quiet: it is not in a command's usual load.
    await writeGroup(s.tabId, s.buddyId, Date.now(), group => { group.dormant = true })
    const left = await post(s.tabId, { type: 'decision.answer', decisionId: id, delegate: true }, peer)
    expect(left.status, JSON.stringify(left.body)).toBe(200)
    expect(await db.superTabDecision.findUnique({ where: { id } })).toMatchObject({ choice: 1, delegated: true })
    const listed = { id, choice: 1, delegated: true, answer: 'PM decided: To everyone' }
    expect(await decisions(s.tabId, peer, 'settled')).toEqual([expect.objectContaining(listed)])
    // An older Desktop reads the person's answered decisions and labels each "You chose": it is not given this one.
    expect(await decisions(s.tabId, peer, 'answered')).toEqual([])
    // Agents read it as answered, as before, now saying who decided.
    expect(await decisions(s.tabId, owner, 'answered', s.lead)).toEqual([expect.objectContaining(listed)])
    const line = (await db.superTabMessage.findMany({ where: { tabId: s.tabId, conversationId: s.buddyId } })).at(-1)
    expect(line).toMatchObject({ text: 'PM decided: To everyone — Ship how?', recipientIds: [], source: { kind: 'decision-delegated', decisionId: id } })
    expect(line!.author).toMatchObject({ kind: 'agent', id: s.lead })
    // Only the person asked may leave it to the PM, and only while it is open.
    expect((await post(s.tabId, { type: 'decision.answer', decisionId: id, delegate: true }, peer)).body.error?.code).toBe('DECISION_ANSWERED')
    expect((await post(s.tabId, { type: 'decision.answer', decisionId: id, delegate: true }, owner)).status).toBe(404)
    // A person's own answer is listed as theirs.
    const mine = ((await post(s.tabId, { type: 'decision.ask', conversationId: s.web, personId: peer.sub, questions: [question('Name it?')] }, owner, s.lead))
      .body.data.result.decisionIds as string[])[0]!
    await post(s.tabId, { type: 'decision.answer', decisionId: mine, choice: 0 }, peer)
    expect((await decisions(s.tabId, peer, 'settled')).find(d => d.id === mine)).toMatchObject({ delegated: false, answer: 'Behind a flag' })
    expect((await decisions(s.tabId, peer, 'answered')).map(d => d.id)).toEqual([mine])
  })

  it('takes an answer in a conversation that went quiet and was archived, counts it on a fresh first load, and tells both agents', async () => {
    const s = await scene()
    clock = Date.now()
    const assignmentId = (await get(`/api/super-tabs/${s.tabId}/parts`, owner)).body.data.groups.find((g: { key: string }) => g.key === s.web).data.assignment.id
    await post(s.tabId, { type: 'work.status', conversationId: s.web, assignmentId, status: 'needs_human', result: 'Ship to everyone?',
      ask: { personId: peer.sub, options: ['Behind a flag', 'To everyone'], recommended: 0, unblocks: 'Turning it on' } }, owner, s.worker)
    await writeGroup(s.tabId, s.web, Date.now(), group => { group.assignment = { ...group.assignment!, status: 'done' }; group.archived = true; group.dormant = true })
    const first = (await get(`/api/super-tabs/${s.tabId}/parts`, peer)).body.data
    expect(first.groups.map((g: { key: string }) => g.key)).not.toContain(s.web)
    expect(first.derived.decisionsWaiting).toBe(1)
    const [open] = await decisions(s.tabId, peer)
    const answered = await post(s.tabId, { type: 'decision.answer', decisionId: open!.id, choice: 0 }, peer)
    expect(answered.status, JSON.stringify(answered.body)).toBe(200)
    expect((await db.superTabDelivery.findMany({ where: { tabId: s.tabId, messageId: answered.body.data.result.messageId as string } }))
      .map(d => d.agentId).sort()).toEqual([s.lead, s.worker].sort())
    expect((await get(`/api/super-tabs/${s.tabId}/parts`, peer)).body.data.derived.decisionsWaiting).toBe(0)
  })

  it('reads only the conversations its decisions are in: a quiet one the reader still reads, not one they left, and no other quiet history', async () => {
    const s = await scene()
    clock = Date.now()
    const ask = async (conversationId: string, text: string) => (await post(s.tabId, { type: 'decision.ask', conversationId, personId: peer.sub,
      questions: [question(text)] }, owner, s.lead)).body.data.result.decisionIds as string[]
    const [kept] = await ask(s.web, 'Ship how?')
    await askedBefore(s.tabId, s.privateId, s.lead, ['Keep it?'])
    // Both go quiet; the peer then leaves the private one.
    await writeGroup(s.tabId, s.web, Date.now(), group => { group.archived = true; group.dormant = true })
    await writeGroup(s.tabId, s.privateId, Date.now(), group => { group.dormant = true; group.audience = { people: [] } })
    const read: string[] = []
    const counted = new SuperTabStore(db.$extends({ query: { swarmGroup: { async findMany({ args, query }) {
      const rows = await query(args)
      read.push(...rows.map(row => row.key))
      return rows
    } } } }) as unknown as PrismaClient)
    expect((await counted.decisions(peer, s.tabId, 'open')).decisions.map(d => d.id)).toEqual([kept])
    // The finished work stays quiet and holds no decision: the list does not read it, as it would by loading every conversation.
    expect(read).not.toContain(s.done)
  })

  it('marks which decisions wait, so an answer elsewhere and a new question read again though the count stays', async () => {
    const s = await scene()
    clock = Date.now()
    const ask = async (conversationId: string, text: string) => ((await post(s.tabId, { type: 'decision.ask', conversationId, personId: peer.sub,
      questions: [question(text)] }, owner, s.lead)).body.data.result.decisionIds as string[])[0]!
    const derived = async () => (await get(`/api/super-tabs/${s.tabId}/parts`, peer)).body.data.derived
    const first = await ask(s.web, 'Ship how?')
    const before = await derived()
    expect(before).toMatchObject({ decisionsWaiting: 1, decisionsDigest: expect.any(String) })
    expect((await derived()).decisionsDigest).toBe(before.decisionsDigest)
    expect(before.decisionsDigest).not.toContain(first)
    // Answered on another device, and another question asked: still one waiting, another one.
    expect((await post(s.tabId, { type: 'decision.answer', decisionId: first, choice: 0 }, peer)).status).toBe(200)
    await askedBefore(s.tabId, s.privateId, s.lead, ['Keep it?'])
    const replaced = await derived()
    expect(replaced.decisionsWaiting).toBe(1)
    expect(replaced.decisionsDigest).not.toBe(before.decisionsDigest)
    // The reader leaving the conversation moves it; with none left it is the same as for anyone with none.
    await writeGroup(s.tabId, s.privateId, Date.now(), group => { group.audience = { people: [] } })
    const left = await derived()
    expect(left).toMatchObject({ decisionsWaiting: 0 })
    expect(left.decisionsDigest).not.toBe(replaced.decisionsDigest)
    expect((await get(`/api/super-tabs/${s.tabId}/parts`, owner)).body.data.derived.decisionsDigest).toBe(left.decisionsDigest)
  })

  it('marks which tags wait, so an answer and a new tag read again though the count stays, an unrelated post not', async () => {
    const s = await scene()
    clock = Date.now()
    const tag = async (conversationId: string) => expect((await post(s.tabId, { type: 'message.send', conversationId, text: 'Please look.', replyTo: null,
      recipientIds: [], mentions: [peer.sub] }, owner, s.lead)).status).toBe(200)
    const derived = async (as: AuthUser = peer) => (await get(`/api/super-tabs/${s.tabId}/parts`, as)).body.data
    await tag(s.web)
    const before = await derived()
    expect(before.derived).toMatchObject({ mentionsWaiting: 1, mentionsDigest: expect.any(String) })
    const [mention] = (await get(`/api/super-tabs/${s.tabId}/mentions?state=waiting`, peer)).body.data.mentions as Array<{ id: string }>
    expect(before.derived.mentionsDigest).not.toContain(mention!.id)
    // Someone else's post changes the Swarm and no tag.
    expect((await post(s.tabId, { type: 'message.send', conversationId: s.web, text: 'Unrelated.', replyTo: null, recipientIds: [] })).status).toBe(200)
    const changes = (await get(`/api/super-tabs/${s.tabId}/changes?cursor=${before.cursor}`, peer)).body.data
    expect(changes.derived).toMatchObject({ mentionsWaiting: 1, mentionsDigest: before.derived.mentionsDigest })
    // Answered by the person's reply, and tagged in another conversation: still one waiting, another one.
    expect((await post(s.tabId, { type: 'message.send', conversationId: s.web, text: 'Looked.', replyTo: null, recipientIds: [] }, peer)).status).toBe(200)
    await tag('lead')
    const replaced = (await derived()).derived
    expect(replaced.mentionsWaiting).toBe(1)
    expect(replaced.mentionsDigest).not.toBe(before.derived.mentionsDigest)
    // 30 days on it expires; with none left it is the same as for anyone with none.
    clock = Date.now() + 30 * DAY + 1000
    const expired = (await derived()).derived
    expect(expired.mentionsWaiting).toBe(0)
    expect(expired.mentionsDigest).not.toBe(replaced.mentionsDigest)
    expect((await derived(owner)).derived.mentionsDigest).toBe(expired.mentionsDigest)
  })

  it('counts every open decision the reader can open, past 200, reading only which ones and where', async () => {
    const s = await scene()
    clock = Date.now()
    // 150 in finished work gone quiet, which the peer still reads; then 100 newer in a conversation they have left, quiet too:
    // both are read for their access fields alone, and the left one is filtered on those.
    await writeGroup(s.tabId, s.web, Date.now(), group => { group.archived = true; group.dormant = true })
    await writeGroup(s.tabId, s.privateId, Date.now(), group => { group.audience = { people: [] }; group.dormant = true })
    const asked = (conversationId: string, n: number, from: number) => Array.from({ length: n }, (_, i) => ({ id: `${conversationId}-${i}`,
      tabId: s.tabId, batchId: `${conversationId}-batch`, projectId: 'lead', conversationId, assignmentId: null, personId: peer.sub,
      askerAgentId: s.lead, question: `Question ${i}?`, options: ['Yes', 'No'], recommended: 0, unblocks: 'The release', createdAt: new Date(from + i) }))
    await db.superTabDecision.createMany({ data: [...asked(s.web, 150, NOW), ...asked(s.privateId, 100, NOW + 1000)] })
    expect((await get(`/api/super-tabs/${s.tabId}/parts`, peer)).body.data.derived.decisionsWaiting).toBe(150)

    const reads: unknown[] = [], whole: string[] = [], quiet: Array<{ key: string; data: Record<string, unknown> }> = []
    const counted = db.$extends({ query: {
      superTabDecision: { async findMany({ args, query }) { reads.push(args); return query(args) } },
      swarmGroup: {
        async findMany({ args, query }) { const rows = await query(args); whole.push(...rows.map(row => row.key)); return rows },
        async aggregateRaw({ args, query }) { const rows = await query(args); quiet.push(...rows as unknown as typeof quiet); return rows },
      },
    } })
    const waiting = await counted.$transaction(async tx => {
      const state = parts.reassemble(await parts.loadActive(tx, s.tabId))
      whole.length = 0
      quiet.length = 0
      return decisionsWaiting(tx, s.tabId, state, { kind: 'person', userId: peer.sub, email: peer.email })
    })
    expect(waiting.count).toBe(150)
    // Neither what they ask nor a cap; and each quiet conversation's access fields, not its whole record.
    expect(reads).toEqual([expect.objectContaining({ select: { id: true, conversationId: true } })])
    expect(reads[0]).not.toHaveProperty('take')
    expect(whole).toEqual([])
    expect(quiet.map(row => row.key).sort()).toEqual([s.web, s.privateId].sort())
    for (const row of quiet) expect(['id', 'kind', 'projectId', 'audience']).toEqual(expect.arrayContaining(Object.keys(row.data)))
    expect(quiet.find(row => row.key === s.privateId)!.data).toEqual({ id: s.privateId, projectId: 'lead', audience: { people: [] } })
  })

  it('keeps one answer when two arrive at once, returns the same receipt for a retried answer, and refuses a person removed from the Swarm', async () => {
    const s = await scene()
    clock = Date.now()
    const [one, two] = (await post(s.tabId, { type: 'decision.ask', conversationId: s.web, personId: peer.sub,
      questions: [question('First?'), question('Second?')] }, owner, s.lead)).body.data.result.decisionIds as string[]
    const answer = (choice: number, operationId = randomUUID(), decisionId = one) => app.inject({ method: 'POST', url: `/api/super-tabs/${s.tabId}/commands`,
      headers: { authorization: `Bearer ${peer.sub}` }, payload: { operationId, command: { type: 'decision.answer', decisionId, choice } } })
    const both = await Promise.all([answer(0), answer(1)])
    expect(both.map(r => r.statusCode).sort()).toEqual([200, 409])
    const [kept] = await decisions(s.tabId, peer, 'answered')
    expect((await db.superTabMessage.count({ where: { tabId: s.tabId, source: { equals: { kind: 'agent-only', decisionId: one } } } }))).toBe(1)
    // A lost reply retried with the same operation: the same receipt, nothing written twice.
    const op = randomUUID()
    const first = await answer(0, op, two), again = await answer(0, op, two)
    expect([first.statusCode, again.statusCode]).toEqual([200, 200])
    expect(again.json().data.result).toEqual(first.json().data.result)
    expect(await decisions(s.tabId, peer, 'answered')).toHaveLength(2)
    expect(kept!.choice).toBe(both[0]!.statusCode === 200 ? 0 : 1)
    // Removed from the Swarm, the person can no longer answer, nor retry a saved answer.
    const [three] = (await post(s.tabId, { type: 'decision.ask', conversationId: s.web, personId: peer.sub, questions: [question('Third?')] }, owner, s.lead))
      .body.data.result.decisionIds as string[]
    expect((await post(s.tabId, { type: 'member.remove', userId: peer.sub })).status).toBe(200)
    expect([403, 404]).toContain((await answer(0, randomUUID(), three)).statusCode)
    expect([403, 404]).toContain((await answer(0, op, two)).statusCode)
  })

  it('asks a person an open question once, however often the same ask is repeated', async () => {
    const s = await scene()
    clock = Date.now()
    const ask = async () => (await post(s.tabId, { type: 'decision.ask', conversationId: s.web, personId: peer.sub, questions: [question('Ship how?')] }, owner, s.lead))
      .body.data.result.decisionIds as string[]
    const [first] = await ask()
    expect(await ask()).toEqual([first])
    expect(await decisions(s.tabId, peer)).toEqual([expect.objectContaining({ id: first })])
  })

  it('refuses a 21st open decision from one asker to one person, still taking a repeat, and takes it once one is answered', async () => {
    const s = await scene()
    clock = Date.now()
    const ask = (texts: string[]) => post(s.tabId, { type: 'decision.ask', conversationId: s.web, personId: peer.sub, questions: texts.map(question) }, owner, s.lead)
    const batch = (from: number) => Array.from({ length: 10 }, (_, i) => `Question ${from + i}?`)
    const ids = [...(await ask(batch(1))).body.data.result.decisionIds as string[], ...(await ask(batch(11))).body.data.result.decisionIds as string[]]
    expect(ids).toHaveLength(20)
    const refused = await ask(['Question 21?'])
    expect(refused).toMatchObject({ status: 409, body: { error: { code: 'DECISIONS_FULL' } } })
    expect(await decisions(s.tabId, peer)).toHaveLength(20)
    // A repeat of an open one is that decision again, not a new one.
    expect((await ask(['Question 1?'])).body.data.result.decisionIds).toEqual([ids[0]])
    expect((await post(s.tabId, { type: 'decision.answer', decisionId: ids[0], choice: 0 }, peer)).status).toBe(200)
    expect((await ask(['Question 21?'])).status).toBe(200)
  })

  it('at the cap, a worker\'s needs-human update still records its status, tells the Lead and renews its lease, asking nothing new', async () => {
    const s = await scene()
    clock = Date.now()
    const assignment = async () => (await get(`/api/super-tabs/${s.tabId}/parts`, owner)).body.data.groups.find((g: { key: string }) => g.key === s.web).data.assignment
    const assignmentId = (await assignment()).id as string
    await db.superTabDecision.createMany({ data: Array.from({ length: 20 }, (_, i) => ({ id: `full-${s.tabId}-${i}`, tabId: s.tabId, batchId: 'full',
      projectId: 'lead', conversationId: s.web, assignmentId, personId: peer.sub, askerAgentId: s.worker, question: `Question ${i + 1}?`,
      options: ['Behind a flag', 'To everyone'], recommended: 0, unblocks: 'The release', createdAt: new Date() })) })
    const before = (await assignment()).leaseUntil as number
    const needs = await post(s.tabId, { type: 'work.status', conversationId: s.web, assignmentId, status: 'needs_human', result: 'Ship how?',
      ask: { personId: peer.sub, options: ['Behind a flag', 'To everyone'], recommended: 0, unblocks: 'The release' } }, owner, s.worker)
    expect(needs.status, JSON.stringify(needs.body)).toBe(200)
    const notAsked = `Not asked ${peer.email}: 20 decisions you asked them are still open, and at most 20 can be. Wait for answers before asking more.`
    expect(needs.body.data.result.notAsked).toBe(notAsked)
    const after = await assignment()
    expect(after).toMatchObject({ status: 'needs_human', result: 'Ship how?' })
    expect(after.leaseUntil).toBeGreaterThan(before)
    const notice = await db.superTabMessage.findFirst({ where: { tabId: s.tabId, conversationId: s.web }, orderBy: { sequence: 'desc' } })
    expect(notice).toMatchObject({ text: `Needs a human\n\nShip how?\n\n${notAsked}`, recipientIds: [s.lead] })
    expect(await db.superTabDecision.count({ where: { tabId: s.tabId, askerAgentId: s.worker } })).toBe(20)
    // A repeat of one still open is that decision again, so it is asked as before.
    const repeat = await post(s.tabId, { type: 'work.status', conversationId: s.web, assignmentId, status: 'needs_human', result: 'Question 1?',
      ask: { personId: peer.sub, options: ['Behind a flag', 'To everyone'], recommended: 0, unblocks: 'The release' } }, owner, s.worker)
    expect(repeat.body.data.result.notAsked).toBeUndefined()
    expect((await db.superTabMessage.findFirst({ where: { tabId: s.tabId, conversationId: s.web }, orderBy: { sequence: 'desc' } }))!.text)
      .toBe(`Needs a human\n\nQuestion 1?\n\nAsked ${peer.email}.`)
    expect(await db.superTabDecision.count({ where: { tabId: s.tabId, askerAgentId: s.worker } })).toBe(20)
  })

  it('removes answered decisions older than the leaderboard\'s 5 weeks when it writes new ones, keeping newer and open ones', async () => {
    const s = await scene()
    clock = Date.now()
    const now = Date.now(), weeks = (n: number) => new Date(now - n * 7 * DAY)
    const row = (id: string, createdAt: Date, answeredAt?: Date) => ({ id, tabId: s.tabId, batchId: 'old', projectId: 'lead', conversationId: s.web,
      assignmentId: null, personId: peer.sub, askerAgentId: s.lead, question: `${id}?`, options: ['Yes', 'No'], recommended: 0, unblocks: 'The release',
      createdAt, ...answeredAt ? { choice: 0, answeredAt } : {} })
    await db.superTabDecision.createMany({ data: [row('expired', weeks(8), new Date(weeks(5).getTime() - DAY)),
      row('recent', weeks(8), new Date(weeks(5).getTime() + DAY)), row('waiting', weeks(8))] })
    expect((await post(s.tabId, { type: 'decision.ask', conversationId: s.web, personId: peer.sub, questions: [question('Ship how?')] }, owner, s.lead)).status).toBe(200)
    const left = await db.superTabDecision.findMany({ where: { tabId: s.tabId }, select: { id: true } })
    expect(left.map(d => d.id)).not.toContain('expired')
    expect(left.map(d => d.id)).toEqual(expect.arrayContaining(['recent', 'waiting']))
  })

  it('keeps a decision of its own for another asker, another task, or other options with the same question text', async () => {
    const s = await scene()
    clock = Date.now()
    const [lead] = (await post(s.tabId, { type: 'decision.ask', conversationId: s.web, personId: peer.sub, questions: [question('Ship how?')] }, owner, s.lead))
      .body.data.result.decisionIds as string[]
    const [other] = (await post(s.tabId, { type: 'decision.ask', conversationId: s.web, personId: peer.sub,
      questions: [{ ...question('Ship how?'), options: ['Today', 'Next week'] }] }, owner, s.lead)).body.data.result.decisionIds as string[]
    const assignmentId = (await get(`/api/super-tabs/${s.tabId}/parts`, owner)).body.data.groups.find((g: { key: string }) => g.key === s.web).data.assignment.id
    expect((await post(s.tabId, { type: 'work.status', conversationId: s.web, assignmentId, status: 'needs_human', result: 'Ship how?',
      ask: { personId: peer.sub, options: ['Behind a flag', 'To everyone'], recommended: 0, unblocks: 'The release' } }, owner, s.worker)).status).toBe(200)
    const open = await decisions(s.tabId, peer)
    expect(open).toHaveLength(3)
    expect(new Set([lead, other, ...open.map(d => d.id)]).size).toBe(3)
    // The worker reads its own question, and its answer reaches it.
    const [mine] = await decisions(s.tabId, owner, 'open', s.worker)
    expect(mine).toMatchObject({ askerAgentId: s.worker, assignmentId, options: ['Behind a flag', 'To everyone'] })
  })

  it('counts an open decision in a quiet conversation on a change read, which loads only some conversations', async () => {
    const s = await scene()
    clock = Date.now()
    expect((await post(s.tabId, { type: 'decision.ask', conversationId: s.done, personId: peer.sub, questions: [question('Reopen it?')] }, owner, s.lead)).status).toBe(200)
    const first = (await get(`/api/super-tabs/${s.tabId}/parts`, peer)).body.data
    clock = Date.now()
    expect((await get(`/api/super-tabs/${s.tabId}/changes?cursor=${first.cursor}`, peer)).body.data.derived.decisionsWaiting).toBe(1)
  })
})

describe('routes given only a store', () => {
  it('read from that store\'s database, not the app-wide client', async () => {
    const s = await scene()
    const plain = Fastify()
    plain.setErrorHandler(errorHandler)
    plain.addHook('onRequest', async request => { request.user = owner })
    await plain.register(superTabRoutes, { store: new SuperTabStore(db), github: null })
    await plain.ready()
    try {
      expect((await plain.inject({ method: 'GET', url: `/api/super-tabs/${s.tabId}/parts` })).statusCode).toBe(200)
      expect((await plain.inject({ method: 'GET', url: '/api/super-tabs/hosts/host/changes?full=1' })).statusCode).toBe(200)
    } finally { await plain.close() }
  }, 10_000)
})

describe('what a read costs the database (group 3b)', () => {
  /** What MongoDB sent this process, as the benchmark's isolated poll measures it (integration/bench/probe.ts). */
  const sent = async () => {
    const out = ((await db.$runCommandRaw({ serverStatus: 1 })) as { network: { bytesOut: unknown } }).network.bytesOut
    return typeof out === 'number' ? out : Number((out as { $numberLong?: string; $numberInt?: string }).$numberLong ?? (out as { $numberInt?: string }).$numberInt)
  }
  async function databaseBytes(call: () => Promise<unknown>): Promise<number> {
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
    await new SuperTabStore(db).execute(owner, s.tabId, { operationId: randomUUID(),
      command: { type: 'message.send', conversationId: s.web, text: 'One post', replyTo: null, recipientIds: [] } })
    clock = Date.now()
    let groups = 0
    const bytes = await databaseBytes(async () => { groups = (await get(`/api/super-tabs/${s.tabId}/changes?cursor=${cursor}`, peer)).body.data.groups.length })
    expect(groups).toBe(1)
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
      command: { type: 'message.send', conversationId: s.web, text: 'Busy', replyTo: null, recipientIds: [] } })
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
  it('the host form asks for the newest change only of the Swarms it answers for', async () => {
    const machineId = `m-${randomUUID().slice(0, 8)}`
    await db.machine.create({ data: { machineId, userId: owner.sub, apiKey: 'fixture-only', managerId: 'fixture', autonomousEnv: 'prod', authMode: 'remote' } })
    const s = await scene(f => { f.contribute(machineId, 'swarm') }, machineId)
    const ops: string[] = []
    const client = db.$extends({ query: { $allModels: { async $allOperations({ model, operation, args, query }) {
      ops.push(`${model}.${operation}${operation === 'aggregateRaw' && JSON.stringify(args).includes('"$max"') ? ':max' : ''}`)
      return query(args)
    } } } }) as unknown as PrismaClient
    const hosts = new HostReads(new SuperTabStore(client), { now: () => clock })
    clock = Date.now()
    // The newest change is one Mongo `$group` per part kind, and never a Prisma groupBy.
    const newestReads = () => ops.filter(op => /^Swarm(Head|Member|Agent|Group|Machine|Start|Progress)\.aggregateRaw:max$/.test(op))
    const first = await hosts.changes(owner, machineId, { full: true })
    expect(newestReads()).toHaveLength(7)
    expect(ops.filter(op => op.endsWith('.groupBy'))).toEqual([])
    ops.length = 0
    clock = Date.now()
    const idle = await hosts.changes(owner, machineId, { cursor: first.cursor })
    expect(idle.tabs).toEqual([])
    expect(newestReads()).toEqual([])
    await new SuperTabStore(db).execute(owner, s.tabId, { operationId: randomUUID(),
      command: { type: 'message.send', conversationId: s.web, text: 'Busy', replyTo: null, recipientIds: [] } })
    clock = Date.now()
    const woken = (await hosts.changes(owner, machineId, { cursor: idle.cursor })).tabs
    const posted = (await db.swarmGroup.findFirst({ where: { tabId: s.tabId, key: s.web } }))!.changedAt.getTime()
    expect(woken).toMatchObject([{ tabId: s.tabId, lastChangedAt: posted }])
  })
})
