import { randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { MongoMemoryReplSet } from 'mongodb-memory-server-core'
import type { PrismaClient } from '@prisma/client'
import { AVATAR_PURPOSE, MemoryAttachmentStore, SharedAvatarStore } from '../src/superTabs/attachments.js'
import { removeAvatars } from '../src/superTabs/migration/avatarRemoval.js'
import { removeRetiredNotices } from '../src/superTabs/migration/retiredNotices.js'
import { SuperTabStore } from '../src/superTabs/store.js'
import type { AuthUser } from '../src/lib/ssoAuth.js'
import { planDatabase, plan, profiled, reads } from './plans.test-support.js'

// The one-time jobs that remove what Swarm v4 no longer writes from collections it still uses (superTabs/migration/retiredNotices.ts,
// avatarRemoval.ts), against a real database: each read goes by the index meant for it, examines what it returns, and leaves every
// v4 row as it was. A fresh loopback replica set, created here. This suite never reads DATABASE_URL or an existing database.
let replica: MongoMemoryReplSet
let db: PrismaClient
const owner: AuthUser = { sub: '300000000000000000000007', email: 'retired-owner@example.com', autonomousEnv: 'prod', role: 'user' }
beforeAll(async () => {
  ({ replica, db } = await planDatabase('swarm_retired_rows_test'))
  await db.user.create({ data: { id: owner.sub, externalId: 'fixture-retired-owner', email: owner.email, autonomousEnv: 'prod' } })
})
afterAll(async () => {
  await db?.$disconnect()
  await replica?.stop()
})

const raw = (command: object) => db.$runCommandRaw(command as never)
const ids = async (collection: string) => ((await raw({ find: collection, filter: {}, projection: { _id: 1 }, sort: { _id: 1 }, limit: 10_000 })) as
  { cursor: { firstBatch: Array<{ _id: string }> } }).cursor.firstBatch.map(doc => doc._id)

describe('the stored notices of retired kinds', () => {
  it('go as their author\'s delete would take them, read by the _id index; every other message stays, and a finished walk does not walk again', async () => {
    const store = new SuperTabStore(db)
    const tab = (await store.create(owner, randomUUID(), 'Retired notices')).id
    await db.machine.create({ data: { machineId: 'notice-host', userId: owner.sub, apiKey: 'fixture-only', managerId: 'fixture', autonomousEnv: 'prod', authMode: 'remote' } })
    const lead = String((await store.execute(owner, tab, { operationId: randomUUID(), command: { type: 'agent.add', conversationId: 'lead', machineId: 'notice-host',
      harnessId: randomUUID(), name: 'Lead', configuration: { engine: 'codex', model: null, effort: null, contextWindow: null, engineVersion: null }, lead: true } })).result.agentId)
    const post = async (text: string, replyTo: string | null = null) => String((await store.execute(owner, tab, { operationId: randomUUID(),
      command: { type: 'message.send', conversationId: 'lead', text, replyTo, recipientIds: [] } }, lead)).result.messageId)
    const alert = await post('An old terminal alert'), stalled = await post('An old stalled notice'), kept = await post('Kept')
    const reply = await post('A reply under the stalled notice', stalled)
    const newest = await post('An old terminal input')
    const kind = (id: string, value: string) => raw({ update: 'SuperTabMessage', updates: [{ q: { _id: id }, u: { $set: { source: { kind: value } } } }] })
    await kind(alert, 'terminal-alert')
    await kind(stalled, 'work-stalled')
    await kind(newest, 'terminal-input')
    const group = async () => (await store.read(owner, tab)).state.conversations.find(c => c.id === 'lead')!
    const before = await group()

    const entries = await profiled(db, async () => {
      let pass
      do pass = await removeRetiredNotices(db, store, { pages: 1 }); while (!pass.done)
    })
    const rows = await db.superTabMessage.findMany({ where: { tabId: tab }, select: { id: true, text: true, deletedAt: true } })
    // The Swarm's own notice of the agent joining stays too.
    expect(rows.map(r => r.id)).toEqual(expect.arrayContaining([stalled, kept, reply]))
    expect(rows.map(r => r.id).filter(id => id === alert || id === newest)).toEqual([])
    expect(rows).toHaveLength(4)
    // A notice with a reply under it stays as a deleted message, as its author's delete keeps it.
    expect(rows.find(r => r.id === stalled)).toMatchObject({ text: 'This message was deleted.', deletedAt: expect.any(Date) })
    // The chat's newest message went: its counter steps back to the reply, and readers are told the group changed.
    const after = await group()
    expect(after.lastMessageSequence).toBeLessThan(before.lastMessageSequence)
    expect(after.reactionSeq ?? 0).toBeGreaterThan(before.reactionSeq ?? 0)

    const finds = reads(entries, 'SuperTabMessage', ['_id']).filter(entry => entry.command?.find)
    expect(finds.length, JSON.stringify(plan(finds))).toBeGreaterThan(0)
    for (const find of finds) {
      expect(find.planSummary, JSON.stringify(plan(finds))).toMatch(/IXSCAN \{ _id: 1 \}/)
      expect(find.docsExamined, JSON.stringify(plan(finds))).toBeLessThanOrEqual(find.nreturned ?? 0)
    }
    expect(await removeRetiredNotices(db, store)).toEqual({ examined: 0, removed: 0, gone: 0, failed: 0, codes: {}, done: true })
  })
})

describe('the avatars still stored', () => {
  it('go, object and record, by the (purpose, createdAt) index; chat files and their records stay', async () => {
    const files = new MemoryAttachmentStore()
    const put = (key: string) => files.put(key, { name: 'a.png', mime: 'image/png' }, Readable.from([Buffer.from('x')]), 10)
    const row = (id: string, purpose: string | null, objectKey: string) => ({ _id: id, tabId: 't', conversationId: '', actorKey: 'person:p', name: 'a.png',
      mime: 'image/png', size: 1, objectKey, usedBy: null, proposedBy: null, purpose, createdAt: { $date: new Date(0).toISOString() } })
    for (let i = 0; i < 5; i++) await put(`avatars/t/${i}/a.png`)
    await put('super-tabs/t/chat/notes.txt')
    await raw({ insert: 'SuperTabAttachment', documents: [...Array.from({ length: 5 }, (_, i) => row(`avatar-${i}`, AVATAR_PURPOSE, `avatars/t/${i}/a.png`)),
      row('chat-file', null, 'super-tabs/t/chat/notes.txt')] })

    const entries = await profiled(db, () => removeAvatars(db, { store: new SharedAvatarStore(files), prefix: 'avatars' }))
    expect([...files.objects.keys()]).toEqual(['super-tabs/t/chat/notes.txt'])
    expect(await ids('SuperTabAttachment')).toEqual(['chat-file'])
    // Each chunk: its ids by the (purpose, createdAt) index, then exactly those by _id (lib/chunkSweep.ts removeChunk).
    const chunks = reads(entries, 'SuperTabAttachment', ['purpose'])
    expect(chunks.map(entry => entry.planSummary), JSON.stringify(plan(chunks))).toEqual(['IXSCAN { purpose: 1, createdAt: 1 }', 'IXSCAN { _id: 1 }'])
    expect(chunks[0]!.docsExamined).toBe(chunks[0]!.nreturned)
    expect(await removeAvatars(db, { store: new SharedAvatarStore(files), prefix: 'avatars' })).toEqual({ objects: 0, failed: 0, records: 0, done: true })
  })
})
