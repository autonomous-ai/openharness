import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Readable } from 'node:stream'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MongoMemoryReplSet } from 'mongodb-memory-server-core'
import { Prisma, PrismaClient } from '@prisma/client'
import type { AuthUser } from '../src/lib/ssoAuth.js'
import { SuperTabStore, type SwarmChanged } from '../src/superTabs/store.js'
import { MemoryAttachmentStore, type Attachments } from '../src/superTabs/attachments.js'
import type { Command } from '../src/superTabs/commands.js'
import { SwarmReads } from '../src/superTabs/read/service.js'
import { machineSwarms } from '../src/superTabs/swarmRows.js'
import { SuperTabError } from '../src/superTabs/model.js'
import { PERSONAL_SWARM_OPERATION, SWARM_DELETE_GRACE_MS } from '../src/superTabs/deletion.js'
import { PURGE_MARGIN_MS, PURGE_RETRY_MS, PURGED_BY_TAB_ID, purgeDeletedSwarms, purgeFiles } from '../src/superTabs/purge.js'
import { sweepSwarms } from '../src/superTabs/sweeps.js'
import { sweepThreadMarks } from '../src/superTabs/readMarks.js'
import { sweepChatSettings } from '../src/superTabs/chatSettings.js'
import { backfillThreads } from '../src/superTabs/threadBackfill.js'
import { archiveFinishedGroups } from '../src/superTabs/archive.js'
import { beforeFirstWrite } from './interleave.test-support.js'
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
  const hello = String((await execute({ type: 'message.send', conversationId: 'lead', text: 'hello', replyTo: null, recipientIds: [] })).result.messageId)
  await w.store.upload(member, tab, 'lead', { name: 'notes.txt', mime: 'text/plain', body: Readable.from(Buffer.from('notes')) })
  return { tab, execute, machineId, lead, worker, hello }
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
    // Tried again only once its retry is due, so it never holds back a Swarm newly due.
    await purgeDeletedSwarms(db, purgeFiles(w.attachments), w.clock.now + SWARM_DELETE_GRACE_MS + PURGE_MARGIN_MS)
    expect(await db.superTab.count({ where: { id: g.tab } })).toBe(1)
    await purgeDeletedSwarms(db, purgeFiles(w.attachments), w.clock.now + SWARM_DELETE_GRACE_MS + PURGE_MARGIN_MS + PURGE_RETRY_MS)
    expect(await db.superTab.count({ where: { id: g.tab } })).toBe(0)
  })
})

// Security review 2 of #2457: what a deleted Swarm must keep, refuse or skip while it waits for its restore or its purge.
describe('while a Swarm is deleted', () => {
  const workspaceOf = async (w: ReturnType<typeof world>, tab: string) => (await w.store.read(owner, tab)).state.workspaceId!

  it('a restore leaves out whoever lost the Workspace meanwhile', async () => {
    const w = world(), f = await swarm(w)
    const workspaceId = await workspaceOf(w, f.tab)
    await f.execute({ type: 'swarm.delete', name: 'Lampos' })
    // The member loses the Workspace, and no removal has reached this Swarm (a removal still open, say).
    await db.swarmWorkspaceMember.update({ where: { id: `${workspaceId}:${member.sub}` }, data: { removedAt: new Date(), removedBy: owner.sub } })
    await f.execute({ type: 'swarm.restore' })
    expect((await w.store.read(owner, f.tab)).state.people.map(p => p.id)).not.toContain(member.sub)
    expect(await listed(w, member)).not.toContain(f.tab)
    expect(await listed(w, host)).toContain(f.tab)
  })

  it('a Workspace removal takes the person out of a deleted Swarm too, so coming back to the Workspace does not bring them back', async () => {
    const w = world(), f = await swarm(w)
    const workspaceId = await workspaceOf(w, f.tab)
    await f.execute({ type: 'swarm.delete', name: 'Lampos' })
    expect(await w.store.workspaces.remove(owner, workspaceId, member.sub)).toEqual({ userId: member.sub, pending: 0 })
    expect(await db.swarmMember.findUnique({ where: { id: `${f.tab}:${member.sub}` }, select: { deleted: true } })).toEqual({ deleted: true })
    // Back in the Workspace before the restore: still not back in this Swarm.
    await db.swarmWorkspaceMember.update({ where: { id: `${workspaceId}:${member.sub}` }, data: { removedAt: null, removedBy: null, purgeAt: null } })
    await f.execute({ type: 'swarm.restore' })
    expect((await w.store.read(owner, f.tab)).state.people.map(p => p.id)).not.toContain(member.sub)
    expect(await listed(w, member)).not.toContain(f.tab)
  })

  it('the hourly invitation sweep never writes it back onto an invitee\'s list, and the list never shows it', async () => {
    const w = world(), f = await swarm(w)
    const late = user(5, 'late')
    await db.user.upsert({ where: { id: late.sub }, create: { id: late.sub, externalId: `fixture-${late.sub}`, email: late.email, autonomousEnv: 'prod' }, update: {} })
    // Two invitations, a day apart: at the sweep's time the first has expired and the second has not.
    w.clock.now += 24 * 60 * 60 * 1000
    await f.execute({ type: 'invite.create', email: late.email, role: 'viewer', conversationId: 'lead' })
    await f.execute({ type: 'swarm.delete', name: 'Lampos' })
    // A sweep that read the invitation index before the delete still finds the Swarm by it.
    await db.superTab.update({ where: { id: f.tab }, data: { invitedEmails: [invitee.email, late.email] } })
    const before = (await db.swarmHead.findUniqueOrThrow({ where: { id: `${f.tab}:head` } })).data as { invitations: unknown[] }
    const firstExpiry = Math.min(...(before.invitations as Array<{ expiresAt: number }>).map(i => i.expiresAt))
    await sweepSwarms(db, firstExpiry + 1)
    expect(((await db.swarmHead.findUniqueOrThrow({ where: { id: `${f.tab}:head` } })).data as { invitations: unknown[] }).invitations).toHaveLength(2)
    w.clock.now = firstExpiry + 1
    expect((await w.store.invitations(late)).map(i => i.tabId)).not.toContain(f.tab)
  })

  it('keeps everyone\'s thread follows and chat settings through the hourly sweeps, and a restore brings them back', async () => {
    const w = world(), f = await swarm(w)
    await w.reads.followThread(member, f.tab, 'lead', f.hello, true)
    await w.reads.setChatNotify(member, f.tab, 'lead', 'all')
    const kept = async () => [await db.superTabThreadMark.count({ where: { tabId: f.tab } }), await db.superTabChatSetting.count({ where: { tabId: f.tab } })]
    expect(await kept()).toEqual([1, 1])
    await f.execute({ type: 'swarm.delete', name: 'Lampos' })
    await sweepThreadMarks(db, w.clock.now)
    await sweepChatSettings(db, w.clock.now)
    expect(await kept()).toEqual([1, 1])
    await f.execute({ type: 'swarm.restore' })
    expect((await w.reads.setChatNotify(member, f.tab, 'lead', 'all')).notify).toBe('all')
  })

  it('refuses a person\'s write that lands at the moment of the delete', async () => {
    const w = world(), tab = (await w.store.create(owner, randomUUID(), 'Racing', 'public')).id
    const invitation = await w.store.execute(owner, tab, { operationId: randomUUID(), command: { type: 'invite.create', email: member.email, role: 'collaborator', conversationId: 'lead' } })
    await w.store.execute(member, tab, { operationId: randomUUID(), command: { type: 'invite.accept', inviteId: invitation.result.inviteId as string } })
    // The member's post read the Swarm before the delete committed, and writes after it.
    let deleted = false
    const racing = new SuperTabStore(beforeFirstWrite(db, async () => {
      if (deleted) return
      deleted = true
      await w.store.execute(owner, tab, { operationId: randomUUID(), command: { type: 'swarm.delete', name: 'Racing' } })
    }), () => w.clock.now)
    expect(await refusal(() => racing.execute(member, tab, { operationId: randomUUID(),
      command: { type: 'message.send', conversationId: 'lead', text: 'after the delete', replyTo: null, recipientIds: [] } }))).toEqual(MISSING)
    expect(deleted).toBe(true)
    expect(await db.superTabMessage.count({ where: { tabId: tab, text: 'after the delete' } })).toBe(0)
  })

  /** A Swarm with an archived group whose reports are all summarized (so it may sleep), a finished start past its keeping,
   *  a decision still waiting in that finished group, and a group finished weeks ago with a merged pull request; deleted or
   *  not. Each background job changes the live one, so a check on the deleted one can fail (re-check 2 of #2457). */
  async function quietSwarm(w: ReturnType<typeof world>, name: string, deleted: boolean) {
    const f = await swarm(w, name)
    const group = String((await f.execute({ type: 'conversation.create', title: 'Old work', brief: 'Done long ago.',
      checks: [{ description: 'Done', independent: false }] })).result.conversationId)
    await f.execute({ type: 'conversation.archive', conversationId: group, archived: true })
    const progress = await db.swarmProgress.findUniqueOrThrow({ where: { id: `${f.tab}:lead` } })
    await db.swarmProgress.update({ where: { id: progress.id }, data: { data: { ...(progress.data as object), summarizedFloor: 1e9 } } })
    const prGroup = String((await f.execute({ type: 'conversation.create', title: 'Merged work', brief: 'Merged.',
      checks: [{ description: 'Done', independent: false }] })).result.conversationId)
    await db.superTabThreadBackfill.deleteMany({ where: { id: f.tab } })
    if (deleted) await f.execute({ type: 'swarm.delete', name })
    // Written as the records of work finished weeks ago would be.
    const old = new Date(w.clock.now - 30 * 24 * 60 * 60 * 1000)
    const row = await db.swarmGroup.findUniqueOrThrow({ where: { tabId_key: { tabId: f.tab, key: prGroup } } })
    await db.swarmGroup.update({ where: { id: row.id }, data: { workFinished: true, lastActivityAt: old,
      data: { ...(row.data as object), assignment: { id: 'a1', agentId: 'gone', status: 'done', assignedAt: new Date(0).toISOString() },
        pullRequestUrls: [`https://github.com/example/${name}/pull/1`] } } })
    await db.swarmStart.create({ data: { id: `${f.tab}:start-old`, tabId: f.tab, key: 'start-old', version: 1, changedAt: old, ordinal: 0,
      machineId: f.machineId, conversationId: 'lead', finishedAt: old,
      data: { id: 'start-old', creationId: 'c', actorKey: `person:${owner.sub}`, contributorId: owner.sub, membershipGeneration: 'g', machineOwnerId: host.sub,
        hostGrant: null, error: 'It failed long ago.', request: { conversationId: 'lead', machineId: f.machineId, engine: 'codex', name: 'Builder', cwd: '/repo',
          worktree: true, requirements: { memoryBytes: 0, diskBytes: 0, maxCpuPercent: 100, tools: [], devices: [], quotaRequired: false } } } } })
    await db.superTabDecision.create({ data: { id: `${f.tab}:decision`, tabId: f.tab, batchId: 'b', projectId: 'lead', conversationId: group,
      personId: owner.sub, askerAgentId: f.lead, question: 'Ship it?', options: ['Yes', 'No'], recommended: 0, unblocks: 'Shipping', createdAt: old } })
    return { ...f, group }
  }

  it('is left alone by the background jobs, which change a live Swarm set up alike', async () => {
    const w = world(), live = await quietSwarm(w, 'Live', false), gone = await quietSwarm(w, 'Gone', true)
    const later = w.clock.now + 30 * 24 * 60 * 60 * 1000
    const state = async (f: typeof live) => ({
      asleep: (await db.swarmGroup.findUniqueOrThrow({ where: { tabId_key: { tabId: f.tab, key: f.group } } })).dormant,
      startKept: !(await db.swarmStart.findUniqueOrThrow({ where: { id: `${f.tab}:start-old` } })).deleted,
      decisionWaits: !(await db.superTabDecision.findUniqueOrThrow({ where: { id: `${f.tab}:decision` } })).answeredAt,
      backfilled: !!await db.superTabThreadBackfill.count({ where: { id: f.tab } }),
    })
    expect(await state(live)).toEqual({ asleep: false, startKept: true, decisionWaits: true, backfilled: false })
    expect(await state(gone)).toEqual({ asleep: false, startKept: true, decisionWaits: true, backfilled: false })

    // The archive pass first: the sleep sweep's write would make the merged group look recently active.
    const read: string[] = []
    await archiveFinishedGroups(db, w.store, { state: async url => { read.push(url); return 'merged' }, done: async () => {} }, w.clock.now)
    await sweepSwarms(db, later)
    await w.store.withdrawEndedDecisions()
    await backfillThreads(db, w.clock.now)

    expect(await state(live)).toEqual({ asleep: true, startKept: false, decisionWaits: false, backfilled: true })
    expect(await state(gone)).toEqual({ asleep: false, startKept: true, decisionWaits: true, backfilled: false })
    expect(read).toEqual(['https://github.com/example/Live/pull/1'])
  })
})

describe('the purge, everywhere', () => {
  /** Every collection that names a Swarm, from the schema itself: a model added later is purged, or this fails. */
  const SWARM_KEYED = Prisma.dmmf.datamodel.models.flatMap(model => {
    const field = model.fields.find(f => f.name === 'tabId' || f.name === 'superTabId')
    // Fields of its unique indexes besides the Swarm's id: each seed fills them, so two seeds never collide.
    const unique = [...new Set([...model.fields.filter(f => f.isUnique).map(f => f.name), ...model.uniqueFields.flat()])]
      .filter(name => name !== field?.name && name !== 'id')
    return field ? [{ model: model.name, collection: model.dbName ?? model.name, field: field.name, unique }] : []
  })
  // Agent Messages' desk tabs (AgentMessageTab, AgentMessageShare) name a desk tab, never a Swarm.
  const NOT_SWARMS = new Set(['AgentMessageTab', 'AgentMessageShare'])

  it('removes a record of the deleted Swarm from every collection that names one, and none of another Swarm', async () => {
    const w = world(), gone = await swarm(w, 'Gone'), kept = await swarm(w, 'Kept')
    await gone.execute({ type: 'swarm.delete', name: 'Gone' })
    const targets = SWARM_KEYED.filter(t => !NOT_SWARMS.has(t.model))
    expect(targets.length).toBeGreaterThan(30)
    for (const tabId of [gone.tab, kept.tab]) {
      // An attachment record names its stored file, outside the Swarm's folder here: the record goes, no file is touched.
      for (const t of targets) {
        const reply = await db.$runCommandRaw({ insert: t.collection, documents: [{ _id: `seed-${tabId}-${t.model}`, [t.field]: tabId,
          ...Object.fromEntries(t.unique.map(name => [name, `seed-${tabId}-${name}`])),
          ...t.model === 'SuperTabAttachment' ? { objectKey: `elsewhere/${tabId}/seed.txt` } : {} }] }) as { n?: number; writeErrors?: unknown }
        expect(reply, `${t.model}: ${JSON.stringify(reply).slice(0, 300)}`).toMatchObject({ n: 1 })
      }
      await db.$runCommandRaw({ insert: 'SuperTabThreadBackfill', documents: [{ _id: tabId, through: { $date: new Date(0).toISOString() } }] })
    }
    const left = async (tabId: string) => {
      const found: string[] = []
      for (const t of targets) {
        const n = Number((await db.$runCommandRaw({ count: t.collection, query: { [t.field]: tabId } }) as { n: unknown }).n)
        if (n) found.push(t.model)
      }
      if (Number((await db.$runCommandRaw({ count: 'SuperTabThreadBackfill', query: { _id: tabId } }) as { n: unknown }).n)) found.push('SuperTabThreadBackfill')
      return found
    }
    const keptBefore = await left(kept.tab)
    await purgeDeletedSwarms(db, purgeFiles(w.attachments), w.clock.now + SWARM_DELETE_GRACE_MS + PURGE_MARGIN_MS)
    expect(await left(gone.tab)).toEqual([])
    expect(await left(kept.tab)).toEqual(keptBefore)
    expect(keptBefore.length).toBe(targets.length + 1)
  })

  it('reads the due Swarms, an owner\'s deleted list and a Workspace\'s deleted Swarms by their indexes', async () => {
    const w = world(), f = await swarm(w)
    // Someone in this Swarm alone, so removing them from the Workspace touches no other test's Swarms.
    const leaver = user(6, 'leaver')
    await db.user.upsert({ where: { id: leaver.sub }, create: { id: leaver.sub, externalId: `fixture-${leaver.sub}`, email: leaver.email, autonomousEnv: 'prod' }, update: {} })
    const invitation = await f.execute({ type: 'invite.create', email: leaver.email, role: 'viewer', conversationId: 'lead' })
    await f.execute({ type: 'invite.accept', inviteId: invitation.result.inviteId as string }, leaver)
    await f.execute({ type: 'swarm.delete', name: 'Lampos' })
    const plans = async (read: () => Promise<unknown>) => {
      await db.$runCommandRaw({ profile: 2 })
      await read()
      await db.$runCommandRaw({ profile: 0 })
      const found = await db.$runCommandRaw({ find: 'system.profile', filter: { ns: { $regex: '\\.SuperTab$' }, 'command.profile': { $exists: false } }, batchSize: 1000 }) as
        unknown as { cursor: { firstBatch: Array<{ planSummary?: string; command?: { pipeline?: unknown } }> } }
      await db.$runCommandRaw({ drop: 'system.profile' })
      return [...new Set(found.cursor.firstBatch.flatMap(row => row.planSummary && row.command?.pipeline ? [row.planSummary] : []))]
    }
    expect(await plans(() => w.store.deletedList(owner))).toEqual(['IXSCAN { autonomousEnv: 1, ownerId: 1, _id: 1 }'])
    expect(await plans(() => purgeDeletedSwarms(db, null, w.clock.now))).toEqual(['IXSCAN { purgeAt: 1 }'])
    // A Workspace removal reads the person's Swarms by the member index and the Workspace's deleted ones by its own.
    const workspaceId = (await db.superTab.findUniqueOrThrow({ where: { id: f.tab }, select: { workspaceId: true } })).workspaceId!
    const removal = await plans(async () => expect(await w.store.workspaces.remove(owner, workspaceId, leaver.sub)).toEqual({ userId: leaver.sub, pending: 0 }))
    expect(removal).toEqual(expect.arrayContaining(['IXSCAN { autonomousEnv: 1, memberIds: 1, _id: 1 }', 'IXSCAN { autonomousEnv: 1, workspaceId: 1 }']))
    expect(removal.filter(plan => !plan.startsWith('IXSCAN'))).toEqual([])
  })

  it('never lets Swarms it cannot finish hold back one newly due', async () => {
    // Earlier than every other test's Swarms, so theirs are never due in these passes.
    const w = world(1_700_000_000_000), stuck = await swarm(w, 'Stuck'), fresh = await swarm(w, 'Fresh')
    await stuck.execute({ type: 'swarm.delete', name: 'Stuck' })
    w.clock.now += 1000
    await fresh.execute({ type: 'swarm.delete', name: 'Fresh' })
    const after = w.clock.now + SWARM_DELETE_GRACE_MS + PURGE_MARGIN_MS
    const broken = { chat: { delete: async () => { throw Object.assign(new Error('storage down'), { code: 503 }) } }, prefix: 'super-tabs', avatars: null, avatarPrefix: 'super-tabs' }
    // The stuck one fails first; afterwards, with room for one Swarm a pass, the fresh one is next, not the stuck one again.
    await db.superTabAttachment.deleteMany({ where: { tabId: fresh.tab } })
    await purgeDeletedSwarms(db, broken, after - 1000, 1)
    expect(await db.superTab.count({ where: { id: stuck.tab } })).toBe(1)
    await purgeDeletedSwarms(db, broken, after, 1)
    expect(await db.superTab.count({ where: { id: fresh.tab } })).toBe(0)
  })
})
