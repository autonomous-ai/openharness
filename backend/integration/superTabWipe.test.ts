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
import { SuperTabError } from '../src/superTabs/model.js'
import { PERSONAL_SWARM_OPERATION, SWARM_DELETE_GRACE_MS } from '../src/superTabs/deletion.js'
import { purgeFiles } from '../src/superTabs/purge.js'
import { WIPE_CUTOFF, wipeOnce } from '../src/superTabs/migration/wipeJob.js'
import { rosterRows } from './hostRows.test-support.js'

// The one-time wipe of every Swarm from before Swarm v4 (superTabs/migration/wipeJob.ts), through the real store and Mongo: an old
// Swarm goes as its owner deleting it would, its hosts stop its agents, and then everything it kept goes; a Swarm made after the
// cut-off and everything that is not a Swarm's stays. A fresh loopback replica set, created here.
let replica: MongoMemoryReplSet
let db: PrismaClient
const user = (n: number, name: string): AuthUser => ({ sub: `60000000000000000000000${n}`, email: `${name}@example.com`, autonomousEnv: 'prod', role: 'user' })
const owner = user(1, 'owner'), member = user(2, 'member'), host = user(3, 'host'), invitee = user(4, 'invitee')
const config = { engine: 'codex', model: 'gpt-6.1-sol', effort: 'high', contextWindow: 200000, engineVersion: 'fixture' } as const
const DAY = 24 * 60 * 60 * 1000

beforeAll(async () => {
  replica = await MongoMemoryReplSet.create({ binary: { version: '7.0.24', downloadDir: join(tmpdir(), 'harness-super-tab-mongodb-binaries') },
    replSet: { count: 1, ip: '127.0.0.1', storageEngine: 'wiredTiger' } })
  const uri = replica.getUri(`swarm_wipe_test_${randomUUID().replaceAll('-', '_')}`)
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

/** A store on its own clock after the cut-off, telling what it would push to apps and observer sockets. */
function world(start = WIPE_CUTOFF + DAY) {
  let now = start
  const files = new MemoryAttachmentStore()
  const attachments: Attachments = { store: files, prefix: 'super-tabs', publicBase: 'https://cdn.example.test' }
  const changed: SwarmChanged[] = [], access: string[] = []
  const store = new SuperTabStore(db, () => now, attachments, { swarmChanged: change => changed.push(change), accessChanged: tabId => access.push(tabId) })
  return { store, reads: new SwarmReads(store), files, attachments, changed, access, clock: { get now() { return now }, set now(value: number) { now = value } } }
}
type World = ReturnType<typeof world>

/** A Swarm with a member, a pending invitation, a message, a file, and a host's machine running its Product Manager and a worker,
 *  made before the cut-off unless [made] says otherwise. */
async function swarm(w: World, name: string, made = WIPE_CUTOFF - DAY) {
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
  await db.superTab.update({ where: { id: tab }, data: { createdAt: new Date(made) } })
  return { tab, execute, machineId, lead, worker }
}

/** What [machineId]'s host reads of [tab]: the sessions to close, the cleanups to do, and anything else. */
async function hostRows(w: World, machineId: string, tab: string) {
  const rows = (await rosterRows(w.store, host, machineId)).filter(r => r.tabId === tab)
  return { closes: rows.flatMap(r => 'closeSession' in r ? [r.agent] : []), cleanups: rows.flatMap(r => 'cleanup' in r ? [r.cleanup] : []),
    others: rows.filter(r => !('closeSession' in r) && !('cleanup' in r)) }
}

/** The host confirms every close and cleanup its roster names for [tab], as a daemon does once it stopped the agents. */
async function hostConfirms(w: World, machineId: string, tab: string) {
  const { closes, cleanups } = await hostRows(w, machineId, tab)
  for (const agent of closes) {
    await w.store.execute(host, tab, { operationId: randomUUID(), command: { type: 'agent.sessionClosed', agentId: agent.id, harnessId: agent.harnessId } })
  }
  for (const cleanup of cleanups) {
    await w.store.execute(host, tab, { operationId: randomUUID(), command: { type: 'machine.cleaned', machineId, removalId: cleanup.removalId } })
  }
}

const refusal = async (body: () => Promise<unknown>) => {
  try { await body(); return 'answered' } catch (error) {
    if (!(error instanceof SuperTabError)) throw error
    const e = error as { code?: string; status?: number; unreachable?: boolean }
    return { code: e.code, status: e.status, unreachable: e.unreachable }
  }
}
const MISSING = { code: 'NOT_FOUND', status: 404, unreachable: false }
const listed = async (w: World, who: AuthUser) => [...(await w.store.list(who)).tabs.map(t => t.id), ...(await w.reads.list(who)).tabs.map(t => t.id)]
const pass = (w: World, store = w.store) => wipeOnce(db, store, purgeFiles(w.attachments), { now: () => w.clock.now })

/** Every collection that names a Swarm, from the schema itself: one added later is wiped, or this fails. Agent Messages' desk tabs
 *  name a desk tab, never a Swarm. */
const SWARM_KEYED = Prisma.dmmf.datamodel.models.flatMap(model => {
  const field = model.fields.find(f => f.name === 'tabId' || f.name === 'superTabId')
  const unique = [...new Set([...model.fields.filter(f => f.isUnique).map(f => f.name), ...model.uniqueFields.flat()])].filter(name => name !== field?.name && name !== 'id')
  return field && !['AgentMessageTab', 'AgentMessageShare'].includes(model.name) ? [{ model: model.name, collection: model.dbName ?? model.name, field: field.name, unique }] : []
})
/** Every other collection: none of its rows is a Swarm's, so the wipe removes none. A Swarm's thread backfill marker is kept by the
 *  Swarm's own id (threadBackfill.ts), checked apart. */
const NOT_SWARM_KEYED = Prisma.dmmf.datamodel.models.filter(model => !['SuperTab', 'SuperTabThreadBackfill'].includes(model.name)
  && !SWARM_KEYED.some(k => k.model === model.name))
  .map(model => ({ model: model.name, collection: model.dbName ?? model.name,
    unique: [...new Set([...model.fields.filter(f => f.isUnique).map(f => f.name), ...model.uniqueFields.flat()])].filter(name => name !== 'id') }))

const rows = async (collection: string, query: Record<string, unknown> = {}) => Number((await db.$runCommandRaw({ count: collection, query } as never) as { n: unknown }).n)
const seed = async (collection: string, doc: Record<string, unknown>) =>
  expect(await db.$runCommandRaw({ insert: collection, documents: [doc] } as never), collection).toMatchObject({ n: 1 })
/** What is left of [tab] in every collection that names a Swarm, its backfill marker and its row. */
async function leftOf(tab: string) {
  const found: string[] = []
  for (const t of SWARM_KEYED) if (await rows(t.collection, { [t.field]: tab })) found.push(t.model)
  if (await rows('SuperTabThreadBackfill', { _id: tab })) found.push('SuperTabThreadBackfill')
  if (await rows('SuperTab', { _id: tab })) found.push('SuperTab')
  return found
}

describe('the wipe of every Swarm from before Swarm v4', () => {
  it('deletes each as its owner would, Personal ones too, tells its hosts to stop its agents, and then removes everything it kept', async () => {
    const w = world(), gone = await swarm(w, 'Lamp'), kept = await swarm(w, 'New', WIPE_CUTOFF + 1)
    const personal = (await w.store.create(owner, PERSONAL_SWARM_OPERATION, 'Personal')).id
    await db.superTab.update({ where: { id: personal }, data: { createdAt: new Date(WIPE_CUTOFF - DAY) } })
    const keptBefore = await leftOf(kept.tab)
    expect(w.files.objects.size).toBe(2)
    w.changed.length = 0

    expect(await pass(w)).toMatchObject({ deleted: 2, purged: 0, failed: 0 })
    // Off every member's and invitee's list in that write, their apps told, its observer sockets checking again.
    for (const who of [owner, member, host]) expect(await listed(w, who)).not.toContain(gone.tab)
    expect(await listed(w, owner)).not.toContain(personal)
    expect((await w.store.invitations(invitee)).map(i => i.tabId)).not.toContain(gone.tab)
    expect(new Set(w.changed.filter(c => c.tabId === gone.tab).flatMap(c => c.userIds))).toEqual(new Set([owner.sub, member.sub, host.sub]))
    expect(w.access).toContain(gone.tab)
    // Every read answers as for a Swarm that does not exist; its owner cannot restore it, nor find it under Recently deleted.
    expect(await refusal(() => w.reads.firstLoad(owner, gone.tab))).toEqual(MISSING)
    expect(await refusal(() => gone.execute({ type: 'swarm.restore' }))).toEqual(MISSING)
    expect((await w.store.deletedList(owner)).tabs).toEqual([])
    // Its host is told to close the PM's and the worker's sessions and clean up its folders, as a deletion does.
    const told = await hostRows(w, gone.machineId, gone.tab)
    expect(new Set(told.closes.map(a => a.id))).toEqual(new Set([gone.lead, gone.worker]))
    expect(told.cleanups).toHaveLength(1)
    expect(told.others).toEqual([])

    // The Personal Swarm, on no machine, goes on the next pass. The other waits for its host to confirm; then the next pass removes
    // every record, file and row it had.
    expect(await pass(w)).toMatchObject({ deleted: 0, purged: 1, hosts: 1, failed: 0 })
    expect(await leftOf(personal)).toEqual([])
    expect(await leftOf(gone.tab)).toContain('SuperTab')
    await hostConfirms(w, gone.machineId, gone.tab)
    expect(await pass(w)).toMatchObject({ deleted: 0, purged: 1, left: 0, failed: 0 })
    expect(await leftOf(gone.tab)).toEqual([])
    const keptKey = (await db.superTabAttachment.findFirstOrThrow({ where: { tabId: kept.tab }, select: { objectKey: true } })).objectKey
    expect([...w.files.objects.keys()]).toEqual([keptKey])

    // The Swarm made after the cut-off is untouched, its agents still at work.
    expect(await leftOf(kept.tab)).toEqual(keptBefore)
    for (const who of [owner, member, host]) expect(await listed(w, who)).toContain(kept.tab)
    expect((await w.store.read(member, kept.tab)).state.agents.map(a => a.id).sort()).toEqual([kept.lead, kept.worker].sort())
    // Nothing is left to do, and a pass again changes nothing.
    expect(await pass(w)).toEqual({ deleted: 0, purged: 0, left: 0, hosts: 0, files: 0, failed: 0, codes: {} })
    expect(await leftOf(kept.tab)).toEqual(keptBefore)
    // A person's new Personal Swarm is a fresh one.
    const fresh = (await w.store.create(owner, PERSONAL_SWARM_OPERATION, 'Personal')).id
    expect(await listed(w, owner)).toContain(fresh)
    expect(await db.superTab.count({ where: { id: fresh, createdAt: { gte: new Date(WIPE_CUTOFF) } } })).toBe(1)
  })

  it('waits for a host that has not read the deletion until its 7 days are over, and then removes it all the same', async () => {
    const w = world(), gone = await swarm(w, 'Offline')
    await pass(w)
    w.clock.now += SWARM_DELETE_GRACE_MS - 1
    expect(await pass(w)).toMatchObject({ hosts: 1, purged: 0 })
    expect(await leftOf(gone.tab)).toContain('SuperTab')
    w.clock.now += 1
    expect(await pass(w)).toMatchObject({ hosts: 0, purged: 1, left: 0 })
    expect(await leftOf(gone.tab)).toEqual([])
  })

  it('also takes a Swarm its owner deleted before the cut-off, which can no longer be restored', async () => {
    const w = world(), gone = await swarm(w, 'Deleted')
    await gone.execute({ type: 'swarm.delete', name: 'Deleted' })
    expect(await refusal(() => gone.execute({ type: 'swarm.restore' }))).toEqual(MISSING)
    expect((await w.store.deletedList(owner)).tabs.map(t => t.id)).not.toContain(gone.tab)
    await hostConfirms(w, gone.machineId, gone.tab)
    expect(await pass(w)).toMatchObject({ purged: 1, failed: 0 })
    expect(await leftOf(gone.tab)).toEqual([])
  })

  it('removes a record of the old Swarm from every collection that names one, none of a new Swarm, and no row that is not a Swarm\'s', async () => {
    const w = world(), gone = await swarm(w, 'Gone'), kept = await swarm(w, 'Kept', WIPE_CUTOFF + 1)
    expect(SWARM_KEYED.length).toBeGreaterThan(30)
    await pass(w)
    await hostConfirms(w, gone.machineId, gone.tab)
    // A record in every collection that names a Swarm, for each of the two; one row in every other collection.
    for (const tab of [gone.tab, kept.tab]) {
      for (const t of SWARM_KEYED) await seed(t.collection, { _id: `seed-${tab}-${t.model}`, [t.field]: tab,
        ...Object.fromEntries(t.unique.map(name => [name, `seed-${tab}-${name}`])),
        // Its stored file is outside the Swarm's folder: the record goes, no file is touched.
        ...t.model === 'SuperTabAttachment' ? { objectKey: `elsewhere/${tab}/seed.txt` } : {} })
      await db.$runCommandRaw({ insert: 'SuperTabThreadBackfill', documents: [{ _id: tab, through: { $date: new Date(0).toISOString() } }] })
    }
    for (const t of NOT_SWARM_KEYED) {
      if (await rows(t.collection, { _id: `seed-${t.model}` })) continue
      await seed(t.collection, { _id: `seed-${t.model}`, ...Object.fromEntries(t.unique.map(name => [name, `seed-${t.model}-${name}`])) })
    }
    const others = async () => Object.fromEntries(await Promise.all(NOT_SWARM_KEYED.map(async t => [t.model, await rows(t.collection)] as const)))
    const othersBefore = await others()
    const keptBefore = await leftOf(kept.tab)
    expect(keptBefore.length).toBe(SWARM_KEYED.length + 2)

    expect(await pass(w)).toMatchObject({ purged: 1, left: 0, failed: 0 })
    expect(await leftOf(gone.tab)).toEqual([])
    expect(await leftOf(kept.tab)).toEqual(keptBefore)
    // Accounts, machines and devices, terminals, Agent Messages, Models and the rest: every row is still there.
    expect(await others()).toEqual(othersBefore)
    for (const u of [owner, member, host, invitee]) expect(await db.user.count({ where: { id: u.sub } })).toBe(1)
    expect(await db.machine.count({ where: { machineId: gone.machineId } })).toBe(1)
  })

  it('reads Swarms by their id index, and an owner\'s deleted list still by its own', async () => {
    const w = world(), f = await swarm(w, 'Plans', WIPE_CUTOFF + 1)
    await f.execute({ type: 'swarm.delete', name: 'Plans' })
    const plans = async (read: () => Promise<unknown>) => {
      await db.$runCommandRaw({ profile: 2 })
      await read()
      await db.$runCommandRaw({ profile: 0 })
      const found = await db.$runCommandRaw({ find: 'system.profile', filter: { ns: { $regex: '\\.SuperTab$' }, 'command.profile': { $exists: false } }, batchSize: 1000 }) as
        unknown as { cursor: { firstBatch: Array<{ planSummary?: string; command?: { pipeline?: unknown } }> } }
      await db.$runCommandRaw({ drop: 'system.profile' })
      return [...new Set(found.cursor.firstBatch.flatMap(row => row.planSummary && row.command?.pipeline ? [row.planSummary] : []))]
    }
    expect(await plans(() => pass(w))).toEqual(['IXSCAN { _id: 1 }'])
    expect(await plans(() => w.store.deletedList(owner))).toEqual(['IXSCAN { autonomousEnv: 1, ownerId: 1, _id: 1 }'])
    // Deleted after the cut-off, it is its owner's to restore, as any deleted Swarm is.
    expect((await w.store.deletedList(owner)).tabs.map(t => t.id)).toContain(f.tab)
    expect((await f.execute({ type: 'swarm.restore' })).result).toEqual({ restored: true })
  })

  it('never lets an owner\'s wiped Swarms waiting for their purge take Recently deleted\'s places from one they can restore', async () => {
    const w = world(), f = await swarm(w, 'Restorable', WIPE_CUTOFF + 1)
    await f.execute({ type: 'swarm.delete', name: 'Restorable' })
    // More old deleted Swarms than the list reads, all before it in id order.
    const old = new Date(WIPE_CUTOFF - DAY).toISOString(), purge = new Date(w.clock.now + DAY).toISOString()
    await db.$runCommandRaw({ insert: 'SuperTab', documents: Array.from({ length: 101 }, (_, i) => ({ _id: `0wiped${String(i).padStart(4, '0')}`,
      ownerId: owner.sub, autonomousEnv: 'prod', memberIds: [], invitedEmails: [], machineIds: ['m'], format: 2, state: { version: 2 },
      createdAt: { $date: old }, deletedAt: { $date: old }, purgeAt: { $date: purge } })) } as never)
    expect((await w.store.deletedList(owner)).tabs.map(t => t.id)).toContain(f.tab)
    await db.$runCommandRaw({ delete: 'SuperTab', deletes: [{ q: { _id: { $regex: '^0wiped' } }, limit: 0 }] } as never)
  })

  it('run by two workers at once, deletes and removes each Swarm once and fails nowhere', async () => {
    const w = world(), second = new SuperTabStore(db, () => w.clock.now, w.attachments)
    const old = await Promise.all(['One', 'Two', 'Three'].map(name => swarm(w, name)))
    const [a, b] = await Promise.all([pass(w), pass(w, second)])
    expect(a.failed + b.failed).toBe(0)
    expect(a.deleted + b.deleted).toBe(old.length)
    for (const f of old) await hostConfirms(w, f.machineId, f.tab)
    const [c, d] = await Promise.all([pass(w), pass(w, second)])
    expect(c.failed + d.failed).toBe(0)
    for (const f of old) expect(await leftOf(f.tab)).toEqual([])
    expect(await pass(w)).toMatchObject({ left: 0, failed: 0 })
  })
})
