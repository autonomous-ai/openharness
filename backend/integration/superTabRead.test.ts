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
import { guardedWrite } from '../src/superTabs/parts/write.js'
import { migrateSwarm } from '../src/superTabs/migration/migrate.js'
import { SwarmReads } from '../src/superTabs/read/service.js'
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
  await app.register(superTabRoutes, { store, github: null, reads: new SwarmReads(db, store, { now: () => clock }),
    hosts: new HostReads(db, store, { now: () => clock }) })
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
  const privateId = s.group('Peer and PM')
  s.edit(state => {
    const generation = state.people.find(p => p.id === peer.sub)!.generation
    state.conversations.find(c => c.id === privateId)!.audience = { people: [{ id: peer.sub, generation }] }
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
  return { tabId, lead, worker, web, done, secretGroup, privateId, secret, leads: state.leadsConversationId!, more }
}
const get = async (url: string, as: AuthUser = owner) => {
  const response = await app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${as.sub}` } })
  return { status: response.statusCode, body: response.json() as { data: any; error?: { code: string; message: string } } }
}
const keys = (list: Array<{ key: string }>) => list.map(p => p.key)
/** A later write of one group by a command, as group 2's store does it, stamped `at`. */
async function writeGroup(tabId: string, key: string, at: number, change: (group: Conversation) => void, op: 'update' | 'remove' = 'update') {
  await db.$transaction(async tx => {
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
    expect(keys(body.data.groups)).toEqual(['lead', s.web, s.privateId, s.leads])
    expect(body.data.derived).toMatchObject({ agents: { [s.lead]: { downSince: null }, [s.worker]: { workDecision: null } }, mentionsWaiting: 0 })
  })

  it('keeps the private conversation and the private project from every reader outside them', async () => {
    const s = await scene()
    const groups = async (as: AuthUser, agent?: string) =>
      keys((await get(`/api/super-tabs/${s.tabId}/parts${agent ? `?asAgentId=${agent}` : ''}`, as)).body.data.groups)
    expect(await groups(outsider)).not.toContain(s.privateId)
    expect(await groups(outsider)).not.toContain(s.secretGroup)
    expect(await groups(owner)).not.toContain(s.privateId)
    expect(await groups(owner)).toContain(s.secretGroup)
    expect(await groups(owner, s.lead)).toContain(s.privateId)
    expect(await groups(owner, s.worker)).not.toContain(s.privateId)
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

  it('answers "being upgraded" when a Swarm cannot be migrated yet, and every client retries that', async () => {
    const s = swarm(MIGRATED)
    const tabId = `tab-${randomUUID()}`
    await writeLegacySwarm(db, { state: { ...structuredClone(s.state), id: tabId }, revision: 3 })
    await db.superTabMessage.create({ data: { id: `${tabId}-orphan`, tabId, conversationId: 'gone', sequence: 1, author: {}, text: 'x', recipientIds: [], mentions: [] } })
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
    await writeGroup(s.tabId, s.privateId, NOW + 2_000, g => { g.title = 'Private 2' })
    const seen = (await changes(s.tabId, peerCursor, peer, NOW + 3_000)).body.data
    expect(seen).toMatchObject({ format: 2, reload: false, serverTime: NOW + 3_000, epoch: 1, lastChangedAt: NOW + 2_000 })
    expect(seen.groups.map((g: { key: string; version: number; data: { title: string } }) => [g.key, g.version, g.data.title]))
      .toEqual([[s.web, R + 1, 'Web 2'], [s.privateId, R + 1, 'Private 2']])
    expect(keys((await changes(s.tabId, outsiderCursor, outsider, NOW + 3_000)).body.data.groups)).toEqual([s.web])
  })

  it('never sends a private conversation\'s removal to a reader outside it', async () => {
    const s = await scene()
    const [peerCursor, outsiderCursor] = [await firstLoad(s.tabId, peer, NOW), await firstLoad(s.tabId, outsider, NOW)]
    await writeGroup(s.tabId, s.privateId, NOW + 2_000, () => {}, 'remove')
    expect((await changes(s.tabId, peerCursor, peer, NOW + 3_000)).body.data.groups).toEqual([{ key: s.privateId, version: R + 1, changedAt: NOW + 2_000, deleted: true }])
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
    await db.swarmHead.updateMany({ where: { tabId: s.tabId }, data: { visibilityEpoch: 2 } })
    expect((await changes(s.tabId, cursor, peer, NOW + 1_000)).body.data).toEqual({ reload: true })
    expect((await changes(s.tabId, 'not-a-cursor', peer, NOW + 1_000)).body.data).toEqual({ reload: true })
  })
})

describe('dormant groups on demand (design 4.5)', () => {
  it('pages dormant groups newest first, 50 at a time, without the ones the reader may not see', async () => {
    const s = await scene(f => {
      for (let i = 0; i < 52; i++) f.run({ type: 'conversation.archive', conversationId: f.group(`Old ${i}`), archived: true })
    })
    await writeGroup(s.tabId, s.privateId, NOW, g => { g.dormant = true; g.lastActivityAt = new Date(NOW).toISOString() })
    const first = (await get(`/api/super-tabs/${s.tabId}/groups?dormant=1`, outsider)).body.data
    expect(first.groups).toHaveLength(49)
    expect(first.groups.every((g: { data: { dormant: boolean } }) => g.data.dormant)).toBe(true)
    expect(keys(first.groups)).not.toContain(s.privateId)
    const second = (await get(`/api/super-tabs/${s.tabId}/groups?dormant=1&before=${first.next}`, outsider)).body.data
    expect(second).toMatchObject({ next: null })
    expect(new Set([...keys(first.groups), ...keys(second.groups)]).size).toBe(53)
    expect(keys((await get(`/api/super-tabs/${s.tabId}/groups?dormant=1`, peer)).body.data.groups)[0]).toBe(s.privateId)
  })

  it('reads one group by id, dormant or not, and 404s one the reader may not see', async () => {
    const s = await scene()
    expect((await get(`/api/super-tabs/${s.tabId}/groups/${s.done}`, outsider)).body.data.group)
      .toMatchObject({ key: s.done, version: R, data: { id: s.done, dormant: true, messageSeq: R } })
    expect((await get(`/api/super-tabs/${s.tabId}/groups/${s.privateId}`, peer)).status).toBe(200)
    for (const [id, as] of [[s.privateId, outsider], [s.privateId, owner], [s.secretGroup, outsider], ['missing', owner]] as const) {
      const { status, body } = await get(`/api/super-tabs/${s.tabId}/groups/${id}`, as)
      expect([status, body.error!.code]).toEqual([404, 'NOT_FOUND'])
    }
  })
})

describe('Swarm list and old routes (design 4.9, 4.11)', () => {
  it('lists the caller\'s Swarms with their newest change', async () => {
    const s = await scene()
    const { body } = await get('/api/super-tabs/list', outsider)
    expect(body.data.tabs).toContainEqual({ id: s.tabId, name: 'Pilot', ownerId: owner.sub, paused: false, lastChangedAt: MIGRATED })
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
  const hostScene = async () => {
    machine = `m-${randomUUID().slice(0, 8)}`
    await db.machine.create({ data: { machineId: machine, userId: owner.sub, apiKey: 'fixture-only', managerId: 'fixture', autonomousEnv: 'prod', authMode: 'remote' } })
    return scene((s, ids) => {
    s.contribute(machine, 'swarm')
    const idle = s.add('idle-harness', ids.done, false, ownerActor, machine, owner.sub)
    // In the project without a Lead, so no agent of this machine is in it.
    const archived = s.group('Archived, no agent here', ids.secret)
    s.run({ type: 'conversation.archive', conversationId: archived, archived: true })
    s.edit(state => {
      const pool = state.machines!.find(m => m.machineId === machine)!
      // One in a running group, one in a dormant group none of its agents is in: the host still has to settle it.
      state.starts = [[ids.web, 'queued'], [archived, 'queued-in-dormant']].map(([conversationId, id]) => ({ id: id!, creationId: 'c',
        actorKey: `person:${owner.sub}`, contributorId: owner.sub, membershipGeneration: pool.membershipGeneration,
        machineOwnerId: owner.sub, hostGrant: null, harnessId: null, dispatched: false, error: null, poolGeneration: pool.generation,
        request: { conversationId: conversationId!, machineId: machine, engine: 'codex', name: 'Builder', cwd: '/repo', worktree: false,
          requirements: { memoryBytes: 0, diskBytes: 0, maxCpuPercent: 100, tools: [], devices: [], quotaRequired: false } } }))
    })
    return { idle }
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
    expect([...rows.keys()].sort()).toEqual([s.lead, s.worker, s.more.idle].sort())
    expect(rows.get(s.lead)).toMatchObject({ lead: true, active: true, leadsConversationId: s.leads, lastChangedAt: MIGRATED,
      observers: [{ email: peer.email, userId: peer.sub }, { email: outsider.email, userId: outsider.sub }] })
    // Its only group is finished and dormant, yet not archived: the host must not hand it to automatic cleanup.
    expect(rows.get(s.more.idle)).toMatchObject({ lead: false, active: true })
    expect(tab.pool).toMatchObject({ tabId: s.tabId, machine: { machineId: machine }, starts: [{ id: 'queued' }, { id: 'queued-in-dormant' }] })
    expect(tab.pool.projects[0].conversationIds).toContain(s.web)
    expect(tab.pool.projects[0].conversationIds).not.toContain(s.privateId)
    expect(tab.assignments).toEqual([{ tabId: s.tabId, assignmentId: expect.any(String), harnessId: 'worker-harness' }])
  })

  it('wakes the host only for changes that concern its machine', async () => {
    const s = await hostScene()
    clock = NOW
    const cursor = (await host(undefined, true)).body.data.cursor
    clock = NOW + 1_000
    expect((await host(cursor)).body.data).toMatchObject({ full: false, tabs: [], removedTabIds: [] })
    await writeGroup(s.tabId, s.secretGroup, NOW + 1_000, g => { g.title = 'Not this machine' })
    clock = NOW + 2_000
    expect((await host(cursor)).body.data.tabs).toEqual([])
    await writeGroup(s.tabId, s.web, NOW + 2_000, g => { g.title = 'Its worker\'s group' })
    clock = NOW + 3_000
    expect((await host(cursor)).body.data.tabs.map((t: { tabId: string }) => t.tabId)).toEqual([s.tabId])
  })

  it('names a Swarm that no longer lists the machine', async () => {
    const s = await hostScene()
    clock = NOW
    const cursor = (await host(undefined, true)).body.data.cursor
    await db.superTab.update({ where: { id: s.tabId }, data: { machineIds: [], cleanupMachineIds: [] } })
    await db.$transaction(async tx => {
      const stored = (await parts.loadActive(tx, s.tabId)).machines.find(m => m.key === machine)!
      await guardedWrite(tx, s.tabId, { op: 'update', kind: 'machine', key: machine, seen: stored.version, data: { ...stored.data!, contribution: null } }, NOW + 1_000)
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
