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
import { MemoryAttachmentStore } from '../src/superTabs/attachments.js'
import type { Command } from '../src/superTabs/commands.js'
import { PERSONAL_SWARM_OPERATION } from '../src/superTabs/deletion.js'

// A Personal Swarm's project chat with no Lead (task #2633): the person's messages wait for the Lead their Desktop starts, and
// are delivered to it, by delivery as any other, once it joins. A fresh loopback replica set, created here.
let replica: MongoMemoryReplSet
let db: PrismaClient
const owner: AuthUser = { sub: '330000000000000000000001', email: 'huy@example.com', autonomousEnv: 'prod', role: 'user' }
const config = { engine: 'claude', model: 'fixture-model', effort: 'high', contextWindow: 200000, engineVersion: 'fixture' }

beforeAll(async () => {
  replica = await MongoMemoryReplSet.create({ binary: { version: '7.0.24', downloadDir: join(tmpdir(), 'harness-super-tab-mongodb-binaries') },
    replSet: { count: 1, ip: '127.0.0.1', storageEngine: 'wiredTiger' } })
  const uri = replica.getUri(`swarm_personal_lead_test_${randomUUID().replaceAll('-', '_')}`)
  await promisify(execFile)(join(process.cwd(), 'node_modules/.bin/prisma'), ['db', 'push', '--skip-generate'], {
    env: { ...process.env, DATABASE_URL: uri }, timeout: 60000,
  })
  db = new PrismaClient({ datasources: { db: { url: uri } } })
  await db.user.create({ data: { id: owner.sub, externalId: `fixture-${owner.sub}`, email: owner.email, autonomousEnv: owner.autonomousEnv } })
  await db.machine.create({ data: { machineId: 'huy-mac', userId: owner.sub, apiKey: 'fixture-huy-mac', managerId: 'fixture', autonomousEnv: 'prod', authMode: 'remote' } })
})
afterAll(async () => {
  await db?.$disconnect()
  await replica?.stop()
})

async function personal(operation = PERSONAL_SWARM_OPERATION) {
  const store = new SuperTabStore(db, () => Date.now(), { store: new MemoryAttachmentStore(), prefix: 'super-tabs', publicBase: 'https://cdn.example.test' })
  const tab = (await store.create(owner, operation, operation === PERSONAL_SWARM_OPERATION ? 'Personal' : 'Team', 'private')).id
  const execute = (command: Command) => store.execute(owner, tab, { operationId: randomUUID(), command })
  const games = (await execute({ type: 'project.create', name: 'Games', visibility: 'private', brief: '' })).result as { projectId: string; conversationId: string }
  const send = async (text: string) => String((await execute({ type: 'message.send', conversationId: games.conversationId, text, replyTo: null, recipientIds: [] }))
    .result.messageId)
  const join = async () => String((await execute({ type: 'agent.add', conversationId: games.conversationId, machineId: 'huy-mac', harnessId: randomUUID(), name: 'Lead',
    configuration: config, lead: true })).result.agentId)
  return { store, tab, execute, games, send, join }
}
const delivered = async (tab: string, agentId: string) =>
  (await db.superTabDelivery.findMany({ where: { tabId: tab, agentId }, orderBy: { createdAt: 'asc' } })).map(d => d.messageId)

describe('a Personal Swarm project chat with no Lead', () => {
  it('delivers the person\'s waiting messages to the Lead that joins, once', async () => {
    const f = await personal()
    const first = await f.send('make the landing page dark')
    expect((await f.execute({ type: 'lead.claim', projectId: f.games.projectId, machineId: 'huy-mac' })).result.leadStart).toBe('start')
    const second = await f.send('and the buttons round')
    const lead = await f.join()
    expect((await delivered(f.tab, lead)).sort()).toEqual([first, second].sort())
    // Once it leads, a message goes to it as to any Lead, and nothing waits any more.
    const third = await f.send('thanks')
    expect((await delivered(f.tab, lead)).sort()).toEqual([first, second, third].sort())
  })
})

// New project's opening request in any Swarm (agentsOnly.test.ts): its creator's request is kept in the new project's channel
// before lead.start, and the PM that joins reads it there; the channel is agents only after it.
describe('New project\'s opening request in a Team Swarm', () => {
  it('is kept for the PM that joins, which reads it; the next post is refused', async () => {
    const f = await personal(randomUUID())
    const request = await f.send('make the landing page dark')
    await expect(f.send('and the buttons round')).rejects.toMatchObject({ code: 'AGENTS_ONLY' })
    const lead = await f.join()
    const read = await f.store.messages(owner, f.tab, f.games.conversationId, {}, lead)
    expect(read.messages.find(m => m.id === request)).toMatchObject({ text: 'make the landing page dark', author: { kind: 'person', id: owner.sub } })
    await expect(f.send('thanks')).rejects.toMatchObject({ code: 'AGENTS_ONLY' })
  })
})
