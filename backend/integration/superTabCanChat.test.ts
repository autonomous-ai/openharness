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
import { SuperTabStore } from '../src/superTabs/store.js'
import { storeBoardSettings } from './storedWork.test-support.js'
import { MemoryAttachmentStore } from '../src/superTabs/attachments.js'
import type { Command } from '../src/superTabs/commands.js'

// Task #3819: in a project switched to the Board way of working, only its owners and the people granted Can chat write in its
// chat, through the store's own paths too (an upload is a message), so no app, old or new, writes past it.
let replica: MongoMemoryReplSet
let db: PrismaClient
const owner: AuthUser = { sub: '340000000000000000000001', email: 'owner@example.com', autonomousEnv: 'prod', role: 'user' }
const peer: AuthUser = { sub: '340000000000000000000002', email: 'peer@example.com', autonomousEnv: 'prod', role: 'user' }

beforeAll(async () => {
  replica = await MongoMemoryReplSet.create({ binary: { version: '7.0.24', downloadDir: join(tmpdir(), 'harness-super-tab-mongodb-binaries') },
    replSet: { count: 1, ip: '127.0.0.1', storageEngine: 'wiredTiger' } })
  const uri = replica.getUri(`swarm_can_chat_test_${randomUUID().replaceAll('-', '_')}`)
  await promisify(execFile)(join(process.cwd(), 'node_modules/.bin/prisma'), ['db', 'push', '--skip-generate'], {
    env: { ...process.env, DATABASE_URL: uri }, timeout: 60000,
  })
  db = new PrismaClient({ datasources: { db: { url: uri } } })
  for (const user of [owner, peer]) await db.user.create({ data: { id: user.sub, externalId: `fixture-${user.sub}`, email: user.email, autonomousEnv: user.autonomousEnv } })
})
afterAll(async () => {
  await db?.$disconnect()
  await replica?.stop()
})

describe('Can chat, through the store', () => {
  it('refuses an upload and a message into a switched project\'s chat from a member without it, and takes them once granted', async () => {
    const store = new SuperTabStore(db, () => Date.now(), { store: new MemoryAttachmentStore(), prefix: 'super-tabs', publicBase: 'https://cdn.example.test' })
    const tab = (await store.create(owner, randomUUID(), 'Board', 'public')).id
    const execute = (command: Command, user = owner) => store.execute(user, tab, { operationId: randomUUID(), command })
    const invitation = await execute({ type: 'invite.create', email: peer.email, role: 'collaborator', conversationId: 'lead' })
    await execute({ type: 'invite.accept', inviteId: invitation.result.inviteId as string }, peer)
    const web = (await execute({ type: 'project.create', name: 'Web', visibility: 'public', brief: '' })).result as { projectId: string; conversationId: string }
    const upload = () => store.upload(peer, tab, web.conversationId, { name: 'plan.txt', mime: 'text/plain', body: Readable.from([Buffer.from('plan')]) })
    const say = () => execute({ type: 'message.send', conversationId: web.conversationId, text: 'Hello', replyTo: null, recipientIds: [] }, peer)

    // Not switched: as today.
    await upload()
    await storeBoardSettings(db, tab, web.projectId, { boardMode: true })
    await expect(upload()).rejects.toMatchObject({ code: 'CHAT_NOT_ALLOWED', status: 403 })
    await expect(say()).rejects.toMatchObject({ code: 'CHAT_NOT_ALLOWED', status: 403 })
    await storeBoardSettings(db, tab, web.projectId, { boardMode: true, canChat: [peer.sub] })
    await upload()
    await say()
  })
})
