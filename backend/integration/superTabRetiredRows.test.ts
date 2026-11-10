import { randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { MongoMemoryReplSet } from 'mongodb-memory-server-core'
import type { PrismaClient } from '@prisma/client'
import { AVATAR_PURPOSE, MemoryAttachmentStore, SharedAvatarStore } from '../src/superTabs/attachments.js'
import { removeAvatars } from '../src/superTabs/migration/avatarRemoval.js'
import { removeRetiredNotices } from '../src/superTabs/migration/retiredNotices.js'
import { planDatabase, plan, profiled, reads } from './plans.test-support.js'

// The one-time jobs that remove what Swarm v4 no longer writes from collections it still uses (superTabs/migration/retiredNotices.ts,
// avatarRemoval.ts), against a real database: each read goes by the index meant for it, examines what it returns, and leaves every
// v4 row as it was. A fresh loopback replica set, created here. This suite never reads DATABASE_URL or an existing database.
let replica: MongoMemoryReplSet
let db: PrismaClient
beforeAll(async () => { ({ replica, db } = await planDatabase('swarm_retired_rows_test')) })
afterAll(async () => {
  await db?.$disconnect()
  await replica?.stop()
})

const raw = (command: object) => db.$runCommandRaw(command as never)
const ids = async (collection: string, filter: object = {}) => ((await raw({ find: collection, filter, projection: { _id: 1 }, sort: { _id: 1 }, limit: 10_000 })) as
  { cursor: { firstBatch: Array<{ _id: string }> } }).cursor.firstBatch.map(doc => doc._id)

describe('the stored notices of retired kinds', () => {
  it('go with their deliveries and receipts, by the _id and [tabId, messageId] indexes; every other message stays, and a second walk removes nothing', async () => {
    const tab = `tab-${randomUUID()}`, other = `tab-${randomUUID()}`
    const kinds = [undefined, 'terminal-alert', 'system', 'work-stalled', 'github', undefined, 'terminal-input', 'pair-loop']
    const messages = Array.from({ length: 40 }, (_, i) => ({ _id: `${tab}-m${String(i).padStart(3, '0')}`, tabId: i % 2 ? tab : other, conversationId: 'chat',
      sequence: i, text: `message ${i}`, author: { kind: 'agent', id: 'a' }, recipientIds: [], mentions: [], createdAt: { $date: new Date(0).toISOString() },
      ...(kinds[i % kinds.length] ? { source: { kind: kinds[i % kinds.length] } } : {}) }))
    await raw({ insert: 'SuperTabMessage', documents: messages })
    await raw({ insert: 'SuperTabDelivery', documents: messages.map(m => ({ _id: `d-${m._id}`, tabId: m.tabId, messageId: m._id, agentId: 'a', status: 'delivered' })) })
    await raw({ insert: 'SuperTabReceipt', documents: messages.map(m => ({ _id: m._id, tabId: m.tabId, conversationId: 'chat', receipts: {}, deliveryIds: [] })) })
    const retired = messages.filter(m => ['terminal-alert', 'work-stalled', 'terminal-input'].includes(m.source?.kind ?? '')).map(m => m._id)
    const kept = messages.map(m => m._id).filter(id => !retired.includes(id))

    // Two pages a walk, so the cursor moves between finds.
    const entries = await profiled(db, async () => {
      const cursor = { after: '' }
      let pass
      do pass = await removeRetiredNotices(db, cursor, { pages: 1 }); while (!pass.done)
    })
    expect(await ids('SuperTabMessage', { tabId: { $in: [tab, other] } })).toEqual(kept)
    expect(await ids('SuperTabDelivery', { tabId: { $in: [tab, other] } })).toEqual(kept.map(id => `d-${id}`).sort())
    expect(await ids('SuperTabReceipt', { tabId: { $in: [tab, other] } })).toEqual(kept)

    const finds = reads(entries, 'SuperTabMessage', ['_id'], ['source.kind'])
    expect(finds.length, JSON.stringify(plan(finds))).toBeGreaterThan(0)
    for (const find of finds) {
      expect(find.planSummary, JSON.stringify(plan(finds))).toMatch(/IXSCAN \{ _id: 1 \}/)
      expect(find.docsExamined, JSON.stringify(plan(finds))).toBeLessThanOrEqual(find.nreturned ?? 0)
    }
    const deliveries = reads(entries, 'SuperTabDelivery', ['tabId', 'messageId'])
    expect(deliveries.length).toBeGreaterThan(0)
    for (const write of deliveries) expect(write.planSummary, JSON.stringify(plan(deliveries))).toMatch(/IXSCAN \{ tabId: 1, messageId: 1 \}/)

    expect(await removeRetiredNotices(db, { after: '' })).toMatchObject({ removed: 0, deliveries: 0, receipts: 0, done: true })
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
