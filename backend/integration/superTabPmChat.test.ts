import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { Readable } from 'node:stream'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PrismaClient } from '@prisma/client'
import { MongoMemoryReplSet } from 'mongodb-memory-server-core'
import type { AuthUser } from '../src/lib/ssoAuth.js'
import { SuperTabStore } from '../src/superTabs/store.js'
import { MemoryAttachmentStore } from '../src/superTabs/attachments.js'
import { commandSchema } from '../src/superTabs/commands.js'
import { HostReads } from '../src/superTabs/read/host.js'

// Swarm v4: New project asks its Product Manager in their 1:1 chat, which lead.start opens before the PM is there (pmChat.ts).
// Desktop's sequence through the store: lead.start, the files uploaded to that chat, the request sent there, then the PM's
// host launches it, and the PM is delivered the request with its files. Nothing is posted in the channel.
let db: PrismaClient, replica: MongoMemoryReplSet
const owner: AuthUser = { sub: '620000000000000000000001', email: 'owner@example.test', autonomousEnv: 'prod', role: 'user' }
const configuration = { engine: 'claude', model: 'fixture', effort: 'xhigh', contextWindow: 200000, engineVersion: 'fixture' }

beforeAll(async () => {
  replica = await MongoMemoryReplSet.create({ binary: { version: '7.0.24', downloadDir: join(tmpdir(), 'harness-super-tab-mongodb-binaries') },
    replSet: { count: 1, ip: '127.0.0.1', storageEngine: 'wiredTiger' } })
  const uri = replica.getUri(`swarm_pm_chat_${randomUUID().replaceAll('-', '_')}`)
  await promisify(execFile)(join(process.cwd(), 'node_modules/.bin/prisma'), ['db', 'push', '--skip-generate'], {
    env: { ...process.env, DATABASE_URL: uri }, timeout: 60000,
  })
  db = new PrismaClient({ datasources: { db: { url: uri } } })
  await db.user.create({ data: { id: owner.sub, externalId: `fixture-${owner.sub}`, email: owner.email, autonomousEnv: 'prod' } })
  await db.machine.create({ data: { machineId: owner.sub, userId: owner.sub, apiKey: `fixture-${owner.sub}`, managerId: 'fixture', autonomousEnv: 'prod', authMode: 'remote' } })
})
afterAll(async () => { await db?.$disconnect(); await replica?.stop() })

/** The owner's Team Swarm with their own computer listed and reporting that it starts PMs, and a new project. */
async function swarm() {
  const store = new SuperTabStore(db, Date.now, { store: new MemoryAttachmentStore(), prefix: 'super-tabs', publicBase: 'https://cdn.example.test' }, { readCache: null })
  const tab = (await store.create(owner, randomUUID(), 'Team', 'public')).id
  const execute = (command: unknown, operationId = randomUUID(), hostMachineId?: string) =>
    store.execute(owner, tab, { operationId, command: commandSchema.parse(command) }, undefined, hostMachineId)
  await execute({ type: 'machine.contribute', machineId: owner.sub, name: 'Owner Mac', cwd: '/fixture', scope: 'swarm', engines: ['claude'], maxAgents: 4 })
  const own = (await new HostReads(store).changes(owner, owner.sub, { full: true })).tabs.find(row => row.tabId === tab)
  if (!own || !('pool' in own) || !own.pool) throw new Error('The owner\'s computer has no host pool')
  await store.observeMachine(owner, tab, owner.sub, { generation: own.pool.machine.generation, resources: { cpuPercent: 10, memoryTotalBytes: 32e9,
    memoryUsedBytes: 4e9, diskFreeBytes: 120e9, diskTotalBytes: 500e9, projectDiskFreeBytes: 120e9, deviceType: 'Laptop', chip: 'Fixture', os: 'macOS',
    gpuPercent: null }, quotas: [], tools: {}, runningHarnessIds: [], stoppedHarnessIds: [], capabilities: ['leadStart'] })
  const app = (await execute({ type: 'project.create', name: 'App', visibility: 'public', brief: '' })).result as { projectId: string; conversationId: string }
  return { store, tab, execute, app }
}

describe('New project\'s request in its PM\'s 1:1 chat', () => {
  it('waits there from lead.start, and reaches the PM with its files once it joins', async () => {
    const f = await swarm()
    const operation = randomUUID()
    const startCommand = { type: 'lead.start', projectId: f.app.projectId, machineId: owner.sub, engine: 'claude', repositoryUrl: 'https://github.com/example/app' }
    const started = (await f.execute(startCommand, operation)).result as { startId: string; chatId: string }
    // A replayed start answers the same chat.
    expect((await f.execute(startCommand, operation)).result.chatId).toBe(started.chatId)

    const uploaded = await f.store.upload(owner, f.tab, started.chatId, { name: 'notes.txt', mime: 'text/plain', body: Readable.from([Buffer.from('Dark mode.\n')]) })
    const request = String((await f.execute({ type: 'message.send', conversationId: started.chatId, text: 'Build the sign-in page.', replyTo: null,
      recipientIds: [], attachmentIds: [uploaded.attachment.id] })).result.messageId)

    await f.execute({ type: 'agent.startDispatch', startId: started.startId }, randomUUID(), owner.sub)
    const pm = String((await f.execute({ type: 'agent.started', startId: started.startId, harnessId: randomUUID(), configuration }, randomUUID(), owner.sub)).result.agentId)

    const read = await f.store.read(owner, f.tab)
    expect(read.state.conversations.find(c => c.id === started.chatId)).toMatchObject({ kind: 'agent-chat', agentIds: [pm] })
    expect(read.state.agents.find(a => a.id === pm)?.chatId).toBe(started.chatId)
    // Delivered once, as typed, with its file.
    const deliveries = await f.store.deliveries(owner, f.tab, pm)
    expect(deliveries.filter(d => d.messageId === request)).toHaveLength(1)
    const row = (await f.store.messages(owner, f.tab, started.chatId, {}, pm)).messages.find(m => m.id === request)
    expect(row).toMatchObject({ text: 'Build the sign-in page.', author: { kind: 'person', id: owner.sub } })
    expect(row?.attachments?.map(a => a.name)).toEqual(['notes.txt'])
    // The channel holds no word of the person's.
    const channel = (await f.store.messages(owner, f.tab, f.app.conversationId, {})).messages
    expect(channel.filter(m => m.author.kind === 'person' && !m.source)).toEqual([])
  })
})
