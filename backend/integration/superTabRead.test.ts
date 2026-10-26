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
    // An agent whose only group has nothing else of this machine in it (no Lead, no running work here).
    const lonerGroup = s.group('Loner home', ids.secret)
    const loner = s.add('loner-harness', lonerGroup, false, ownerActor, machine, owner.sub)
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
})
