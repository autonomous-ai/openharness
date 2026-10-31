import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Readable } from 'node:stream'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MongoMemoryReplSet } from 'mongodb-memory-server-core'
import { PrismaClient } from '@prisma/client'
import type { AuthUser } from '../src/lib/ssoAuth.js'
import { SuperTabStore, type SwarmChanged } from '../src/superTabs/store.js'
import { MemoryAttachmentStore, type Attachments } from '../src/superTabs/attachments.js'
import type { Command } from '../src/superTabs/commands.js'
import { SwarmReads } from '../src/superTabs/read/service.js'
import { machineSwarms } from '../src/superTabs/swarmRows.js'
import { SuperTabError } from '../src/superTabs/model.js'
import { PERSONAL_SWARM_OPERATION, SWARM_DELETE_GRACE_MS } from '../src/superTabs/deletion.js'
import { PURGE_MARGIN_MS, PURGED_BY_TAB_ID, purgeDeletedSwarms, purgeFiles } from '../src/superTabs/purge.js'
import { rosterRows } from './hostRows.test-support.js'

// Deleting a Swarm through the real store and Mongo (superTabs/deletion.ts, purge.ts): it leaves every list at once, every
// member's apps are told, its agents stop through their hosts and its machines are cleaned up, its owner alone restores it
// during the grace, and the purge after the grace removes its records and files and nobody else's.
let replica: MongoMemoryReplSet
let db: PrismaClient
const user = (n: number, name: string): AuthUser => ({ sub: `50000000000000000000000${n}`, email: `${name}@example.com`, autonomousEnv: 'prod', role: 'user' })
const owner = user(1, 'owner'), member = user(2, 'member'), host = user(3, 'host'), invitee = user(4, 'invitee')
const config = { engine: 'codex', model: 'gpt-6.1-sol', effort: 'high', contextWindow: 200000, engineVersion: 'fixture' } as const

beforeAll(async () => {
  replica = await MongoMemoryReplSet.create({ binary: { version: '7.0.24', downloadDir: join(tmpdir(), 'harness-super-tab-mongodb-binaries') },
    replSet: { count: 1, ip: '127.0.0.1', storageEngine: 'wiredTiger' } })
  const uri = replica.getUri(`swarm_deletion_test_${randomUUID().replaceAll('-', '_')}`)
  await promisify(execFile)(join(process.cwd(), 'node_modules/.bin/prisma'), ['db', 'push', '--skip-generate'], {
    env: { ...process.env, DATABASE_URL: uri }, timeout: 60000,
  })
  db = new PrismaClient({ datasources: { db: { url: uri } } })
  for (const u of [owner, member, host, invitee]) await db.user.create({ data: { id: u.sub, externalId: `fixture-${u.sub}`, email: u.email, autonomousEnv: u.autonomousEnv } })
})
afterAll(async () => {
  await db?.$disconnect()
  await replica?.stop()
})

/** A store on its own clock, telling what it would push to apps and observer sockets. */
function world(start = 1_800_000_000_000) {
  let now = start
  const files = new MemoryAttachmentStore()
  const attachments: Attachments = { store: files, prefix: 'super-tabs', publicBase: 'https://cdn.example.test' }
  const changed: SwarmChanged[] = [], access: string[] = []
  const store = new SuperTabStore(db, () => now, attachments, { swarmChanged: change => changed.push(change), accessChanged: tabId => access.push(tabId) })
  const reads = new SwarmReads(store)
  return { store, reads, files, attachments, changed, access, clock: { get now() { return now }, set now(value: number) { now = value } } }
}

/** A Swarm with a member, a pending invitation, a message, a file, and a host's machine running its Product Manager and a worker. */
async function swarm(w: ReturnType<typeof world>, name = 'Lampos') {
  const tab = (await w.store.create(owner, randomUUID(), name, 'public')).id
  const execute = (command: Command, as = owner) => w.store.execute(as, tab, { operationId: randomUUID(), command })
  for (const u of [member, host]) {
    const invitation = await execute({ type: 'invite.create', email: u.email, role: 'collaborator', conversationId: 'lead' })
    await execute({ type: 'invite.accept', inviteId: invitation.result.inviteId as string }, u)
  }
  await execute({ type: 'invite.create', email: invitee.email, role: 'viewer', conversationId: 'lead' })
  const machineId = `host-${tab}`
  await db.machine.create({ data: { machineId, userId: host.sub, apiKey: `fixture-${machineId}`, managerId: 'fixture', autonomousEnv: 'prod', authMode: 'remote' } })
  await execute({ type: 'machine.contribute', machineId, name: 'Studio', cwd: '/repo', engines: ['codex'], maxAgents: 4 }, host)
  const lead = String((await execute({ type: 'agent.add', conversationId: 'lead', machineId, harnessId: randomUUID(), name: 'PM', configuration: config, lead: true }, host)).result.agentId)
  const worker = String((await execute({ type: 'agent.add', conversationId: 'lead', machineId, harnessId: randomUUID(), name: 'Builder', configuration: config, lead: false }, host)).result.agentId)
  await execute({ type: 'message.send', conversationId: 'lead', text: 'hello', replyTo: null, recipientIds: [] })
  await w.store.upload(member, tab, 'lead', { name: 'notes.txt', mime: 'text/plain', body: Readable.from(Buffer.from('notes')) })
  return { tab, execute, machineId, lead, worker }
}

const refusal = async (body: () => Promise<unknown>) => {
  try { await body(); return 'answered' } catch (error) {
    // Only a Swarm refusal counts: a bug that throws anything else must fail the test, not pass it.
    if (!(error instanceof SuperTabError)) throw error
    const e = error as { code?: string; status?: number; unreachable?: boolean }
    return { code: e.code, status: e.status, unreachable: e.unreachable }
  }
}
// Word for word what the store answers about a Swarm that does not exist (checked below against a made-up id).
const MISSING = { code: 'NOT_FOUND', status: 404, unreachable: false }
const listed = async (w: ReturnType<typeof world>, who: AuthUser) => [...(await w.store.list(who)).tabs.map(t => t.id), ...(await w.reads.list(who)).tabs.map(t => t.id)]

describe('deleting a Swarm', () => {
  it('takes it off every member\'s and invitee\'s list in the same write, tells their apps, and reads like a missing Swarm', async () => {
    const w = world(), f = await swarm(w)
    for (const who of [owner, member, host]) expect(await listed(w, who)).toContain(f.tab)
    expect((await w.store.invitations(invitee)).map(i => i.tabId)).toContain(f.tab)
    expect((await w.store.workspaceList(owner)).workspaces.flatMap(o => o.swarms.map(s => s.id))).toContain(f.tab)
    w.changed.length = 0
    await f.execute({ type: 'swarm.delete', name: 'Lampos' })

    for (const who of [owner, member, host]) expect(await listed(w, who)).not.toContain(f.tab)
    expect((await w.store.invitations(invitee)).map(i => i.tabId)).not.toContain(f.tab)
    expect((await w.store.workspaceList(owner)).workspaces.flatMap(o => o.swarms.map(s => s.id))).not.toContain(f.tab)
    // Every person's apps are told at once, and its observer sockets check again.
    expect(new Set(w.changed.filter(c => c.tabId === f.tab).flatMap(c => c.userIds))).toEqual(new Set([owner.sub, member.sub, host.sub]))
    expect(w.access).toContain(f.tab)
    // Every read, its owner's included, answers as a Swarm that does not exist; so do a message page and a file upload.
    for (const who of [owner, member]) {
      expect(await refusal(() => w.reads.firstLoad(who, f.tab))).toEqual(MISSING)
      expect(await refusal(() => w.store.read(who, f.tab))).toEqual(MISSING)
      expect(await refusal(() => w.store.messages(who, f.tab, 'lead', {}))).toEqual(MISSING)
      expect(await refusal(() => w.store.upload(who, f.tab, 'lead', { name: 'late.txt', mime: 'text/plain', body: Readable.from(Buffer.from('x')) }))).toEqual(MISSING)
    }
    const missing = randomUUID().replaceAll('-', '').slice(0, 24)
    expect(await refusal(() => w.reads.firstLoad(owner, missing))).toEqual(MISSING)
    // Only its owner sees it under Recently deleted, with its name and when it goes.
    expect((await w.store.deletedList(owner)).tabs).toContainEqual({ id: f.tab, name: 'Lampos', deletedAt: w.clock.now, purgeAt: w.clock.now + SWARM_DELETE_GRACE_MS })
    expect((await w.store.deletedList(member)).tabs).toEqual([])
  })

  it('is refused alike to a member, its agents and a made-up agent, and to anyone for the owner\'s Personal Swarm', async () => {
    const w = world(), f = await swarm(w)
    const del = { operationId: randomUUID(), command: { type: 'swarm.delete', name: 'Lampos' } as Command }
    for (const [who, as] of [[member, undefined], [host, f.lead], [host, f.worker], [host, 'ffffffffffffffffffffffff']] as const) {
      expect(await refusal(() => w.store.execute(who, f.tab, { ...del, operationId: randomUUID() }, as))).toEqual(MISSING)
    }
    expect(await listed(w, member)).toContain(f.tab)
    const personal = (await w.store.create(owner, PERSONAL_SWARM_OPERATION, 'Personal')).id
    expect(await refusal(() => w.store.execute(owner, personal, { operationId: randomUUID(), command: { type: 'swarm.delete', name: 'Personal' } })))
      .toEqual({ code: 'PERSONAL_SWARM', status: 409, unreachable: false })
    expect(await listed(w, owner)).toContain(personal)
  })

  it('stops its agents through their host and releases the machine, whose host still confirms both', async () => {
    const w = world(), f = await swarm(w)
    await f.execute({ type: 'swarm.delete', name: 'Lampos' })
    const rows = (await rosterRows(w.store, host, f.machineId)).filter(r => r.tabId === f.tab)
    // The Product Manager and the worker each close; the machine is cleaned up; nothing else of the Swarm reaches the host.
    const closing = rows.filter(r => r.closeSession).map(r => r.agent!.id)
    expect(new Set(closing)).toEqual(new Set([f.lead, f.worker]))
    const cleanup = rows.find(r => r.cleanup)!.cleanup!
    expect(rows.filter(r => !r.closeSession && !r.cleanup)).toEqual([])
    for (const row of rows.filter(r => r.closeSession)) {
      await w.store.execute(host, f.tab, { operationId: randomUUID(), command: { type: 'agent.sessionClosed', agentId: row.agent!.id, harnessId: row.agent!.harnessId } as Command })
    }
    await w.store.execute(host, f.tab, { operationId: randomUUID(), command: { type: 'machine.cleaned', machineId: f.machineId, removalId: cleanup.removalId } })
    // Done: the host no longer finds the Swarm at all.
    expect(await machineSwarms(db, 'prod', f.machineId, 100)).not.toContain(f.tab)
    expect((await rosterRows(w.store, host, f.machineId)).filter(r => r.tabId === f.tab)).toEqual([])
  })

  it('is restored by its owner alone during the grace, with its people, chats and files and without agents', async () => {
    const w = world(), f = await swarm(w)
    await f.execute({ type: 'swarm.delete', name: 'Lampos' })
    const restore = (who: AuthUser, as?: string) => w.store.execute(who, f.tab, { operationId: randomUUID(), command: { type: 'swarm.restore' } }, as)
    for (const [who, as] of [[member, undefined], [host, f.lead], [invitee, undefined]] as const) expect(await refusal(() => restore(who, as))).toEqual(MISSING)
    w.clock.now += SWARM_DELETE_GRACE_MS - 1
    w.changed.length = 0
    expect((await restore(owner)).result).toEqual({ restored: true })
    for (const who of [owner, member, host]) expect(await listed(w, who)).toContain(f.tab)
    expect(new Set(w.changed.filter(c => c.tabId === f.tab).flatMap(c => c.userIds))).toEqual(new Set([owner.sub, member.sub, host.sub]))
    expect((await w.store.read(member, f.tab)).state.agents).toEqual([])
    await w.reads.firstLoad(member, f.tab)
    expect((await w.store.messages(member, f.tab, 'lead', {})).messages.some(m => m.text === 'hello')).toBe(true)
    expect(w.files.objects.size).toBe(1)
    expect((await w.store.deletedList(owner)).tabs.map(t => t.id)).not.toContain(f.tab)
  })

  it('cannot be restored once its grace is over', async () => {
    const w = world(), f = await swarm(w)
    await f.execute({ type: 'swarm.delete', name: 'Lampos' })
    w.clock.now += SWARM_DELETE_GRACE_MS
    expect(await refusal(() => f.execute({ type: 'swarm.restore' }))).toEqual(MISSING)
    expect((await w.store.deletedList(owner)).tabs.map(t => t.id)).not.toContain(f.tab)
    expect(await listed(w, owner)).not.toContain(f.tab)
  })
})

describe('the purge', () => {
  const counts = async (tabId: string) => {
    const each: Record<string, number> = {}
    for (const model of [...PURGED_BY_TAB_ID, 'superTabAttachment'] as const) {
      each[model] = await (db[model] as unknown as { count(args: { where: { tabId: string } }): Promise<number> }).count({ where: { tabId } })
    }
    return each
  }

  it('removes a deleted Swarm\'s records and files after its grace, and nothing of another Swarm', async () => {
    const w = world(), gone = await swarm(w, 'Gone'), kept = await swarm(w, 'Kept')
    await gone.execute({ type: 'swarm.delete', name: 'Gone' })
    const keptBefore = await counts(kept.tab)
    expect(Object.values(await counts(gone.tab)).some(n => n > 0)).toBe(true)
    expect(w.files.objects.size).toBe(2)
    const files = purgeFiles(w.attachments)

    // Within the grace, and its margin after, nothing goes.
    // (Other tests' deleted Swarms share this database, so each pass is judged by these two Swarms' records.)
    expect(await purgeDeletedSwarms(db, files, w.clock.now + SWARM_DELETE_GRACE_MS + PURGE_MARGIN_MS - 1)).toMatchObject({ waiting: 0 })
    expect(await db.superTab.count({ where: { id: gone.tab } })).toBe(1)
    expect(await db.superTabMessage.count({ where: { tabId: gone.tab } })).toBeGreaterThan(0)

    expect(await purgeDeletedSwarms(db, files, w.clock.now + SWARM_DELETE_GRACE_MS + PURGE_MARGIN_MS)).toMatchObject({ waiting: 0 })
    expect(Object.entries(await counts(gone.tab)).filter(([, n]) => n > 0)).toEqual([])
    expect(await db.superTab.count({ where: { id: gone.tab } })).toBe(0)
    const keptKey = (await db.superTabAttachment.findFirstOrThrow({ where: { tabId: kept.tab }, select: { objectKey: true } })).objectKey
    expect([...w.files.objects.keys()]).toEqual([keptKey])
    expect(await counts(kept.tab)).toEqual(keptBefore)
    expect(await listed(w, member)).toContain(kept.tab)
    // A second pass finds nothing left.
    expect(await purgeDeletedSwarms(db, files, w.clock.now + SWARM_DELETE_GRACE_MS + PURGE_MARGIN_MS)).toEqual({ purged: 0, waiting: 0 })
  })

  it('keeps a restored Swarm, and keeps a Swarm whose file could not be removed for the next pass', async () => {
    const w = world(), f = await swarm(w)
    await f.execute({ type: 'swarm.delete', name: 'Lampos' })
    await f.execute({ type: 'swarm.restore' })
    const after = w.clock.now + SWARM_DELETE_GRACE_MS + PURGE_MARGIN_MS
    await purgeDeletedSwarms(db, purgeFiles(w.attachments), after)
    expect(await listed(w, member)).toContain(f.tab)
    expect(await db.superTabMessage.count({ where: { tabId: f.tab } })).toBeGreaterThan(0)

    const g = await swarm(w, 'Flaky')
    await g.execute({ type: 'swarm.delete', name: 'Flaky' })
    const broken = { chat: { delete: async () => { throw Object.assign(new Error('storage down'), { code: 503 }) } }, prefix: 'super-tabs', avatars: null, avatarPrefix: 'super-tabs' }
    expect((await purgeDeletedSwarms(db, broken, w.clock.now + SWARM_DELETE_GRACE_MS + PURGE_MARGIN_MS)).waiting).toBeGreaterThanOrEqual(1)
    expect(await db.superTabAttachment.count({ where: { tabId: g.tab } })).toBe(1)
    expect(await db.superTab.count({ where: { id: g.tab } })).toBe(1)
    await purgeDeletedSwarms(db, purgeFiles(w.attachments), w.clock.now + SWARM_DELETE_GRACE_MS + PURGE_MARGIN_MS)
    expect(await db.superTab.count({ where: { id: g.tab } })).toBe(0)
  })
})
