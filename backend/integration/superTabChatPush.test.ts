import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MongoMemoryReplSet } from 'mongodb-memory-server-core'
import { PrismaClient } from '@prisma/client'
import type { AuthUser } from '../src/lib/ssoAuth.js'
import { SuperTabStore } from '../src/superTabs/store.js'
import type { Command } from '../src/superTabs/commands.js'
import { writeChatSetting } from '../src/superTabs/chatSettings.js'
import { dropMuted } from '../src/push/muted.js'
import type { PhoneNotice } from '../src/push/sender.js'

// Swarm v4 (anh Dee, 2026-11-10): an agent reaches its person in their 1:1 chat, so what it writes there rings that person's
// phone, through the store's real write (push/notices.ts chatNotices), unless they muted the chat (push/muted.ts).
let replica: MongoMemoryReplSet
let db: PrismaClient
const owner: AuthUser = { sub: '350000000000000000000001', email: 'owner@example.com', autonomousEnv: 'prod', role: 'user' }
const config = { engine: 'codex', model: 'fixture-model', effort: 'high', contextWindow: 200000, engineVersion: 'fixture' }
const phones: PhoneNotice[] = []

beforeAll(async () => {
  replica = await MongoMemoryReplSet.create({ binary: { version: '7.0.24', downloadDir: join(tmpdir(), 'harness-super-tab-mongodb-binaries') },
    replSet: { count: 1, ip: '127.0.0.1', storageEngine: 'wiredTiger' } })
  const uri = replica.getUri(`swarm_chat_push_test_${randomUUID().replaceAll('-', '_')}`)
  await promisify(execFile)(join(process.cwd(), 'node_modules/.bin/prisma'), ['db', 'push', '--skip-generate'], {
    env: { ...process.env, DATABASE_URL: uri }, timeout: 60000,
  })
  db = new PrismaClient({ datasources: { db: { url: uri } } })
  await db.user.create({ data: { id: owner.sub, externalId: `fixture-${owner.sub}`, email: owner.email, autonomousEnv: owner.autonomousEnv } })
  await db.machine.create({ data: { machineId: 'own-mac', userId: owner.sub, apiKey: 'fixture-only', managerId: 'fixture', autonomousEnv: 'prod', authMode: 'remote' } })
})
afterAll(async () => {
  await db?.$disconnect()
  await replica?.stop()
})

describe('an agent\'s words in its 1:1 chat ring its person', () => {
  it('pushes once a write to its person, keyed as the app\'s own notice of the chat; their own words and a muted chat ring nothing', async () => {
    const store = new SuperTabStore(db, () => Date.now(), null, { phoneNotices: notices => { phones.push(...notices) } })
    const tab = (await store.create(owner, randomUUID(), 'Personal')).id
    const run = (command: Command, asAgentId?: string) => store.execute(owner, tab, { operationId: randomUUID(), command }, asAgentId)
    const agentId = (await run({ type: 'agent.add', conversationId: 'lead', machineId: 'own-mac', harnessId: randomUUID(), name: 'Oak',
      configuration: config, lead: false })).result.agentId as string
    const chat = (await store.read(owner, tab)).state.conversations.find(c => c.kind === 'agent-chat' && c.agentIds.includes(agentId))!.id
    const say = (text: string, asAgentId?: string) => run({ type: 'message.send', conversationId: chat, text, replyTo: null, recipientIds: [] }, asAgentId)

    phones.length = 0
    const sent = String((await say('The build is green.', agentId)).result.messageId)
    await new Promise(resolve => setImmediate(resolve))
    expect(phones).toEqual([{ personId: owner.sub, key: `chat:${tab}:${chat}`, slot: `chat:${tab}:${chat}`, title: 'Oak wrote to you', subtitle: '',
      body: 'Open Harness to read it.', link: `swarm:${tab}/${chat}/message/${sent}`, setting: expect.any(String) }])
    expect(JSON.stringify(phones)).not.toContain('build is green')

    phones.length = 0
    await say('Thanks, ship it.')
    await new Promise(resolve => setImmediate(resolve))
    expect(phones).toEqual([])

    // Muted, it is dropped as it is sent, as a muted chat's tags are.
    await say('One more thing.', agentId)
    await new Promise(resolve => setImmediate(resolve))
    expect(await dropMuted(db, phones)).toHaveLength(1)
    await writeChatSetting(db, { tabId: tab, personId: owner.sub, conversationId: chat, notify: 'muted', now: Date.now() })
    expect(await dropMuted(db, phones)).toEqual([])
  })
})
