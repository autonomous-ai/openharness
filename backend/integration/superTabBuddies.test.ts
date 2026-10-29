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
import { MemoryAttachmentStore } from '../src/superTabs/attachments.js'
import type { Command } from '../src/superTabs/commands.js'
import { poolRows } from './hostRows.test-support.js'

// Buddies end to end through the store (buddies.ts): a person adds one on their own Swarm machine, its host starts it, they
// talk to it alone, and it sends their proposal to the PM. A fresh loopback replica set, created here.
let replica: MongoMemoryReplSet
let db: PrismaClient
const owner: AuthUser = { sub: '300000000000000000000001', email: 'owner@example.com', autonomousEnv: 'prod', role: 'user' }
const peer: AuthUser = { sub: '300000000000000000000002', email: 'peer@example.com', autonomousEnv: 'prod', role: 'user' }
const config = { engine: 'claude', model: 'fixture-model', effort: 'high', contextWindow: 200000, engineVersion: 'fixture' }

beforeAll(async () => {
  replica = await MongoMemoryReplSet.create({ binary: { version: '7.0.24', downloadDir: join(tmpdir(), 'harness-super-tab-mongodb-binaries') },
    replSet: { count: 1, ip: '127.0.0.1', storageEngine: 'wiredTiger' } })
  const uri = replica.getUri(`swarm_buddies_test_${randomUUID().replaceAll('-', '_')}`)
  await promisify(execFile)(join(process.cwd(), 'node_modules/.bin/prisma'), ['db', 'push', '--skip-generate'], {
    env: { ...process.env, DATABASE_URL: uri }, timeout: 60000,
  })
  db = new PrismaClient({ datasources: { db: { url: uri } } })
  for (const user of [owner, peer]) await db.user.create({ data: { id: user.sub, externalId: `fixture-${user.sub}`, email: user.email, autonomousEnv: user.autonomousEnv } })
  for (const [machineId, user] of [['owner-mac', owner], ['peer-mac', peer]] as const) {
    await db.machine.create({ data: { machineId, userId: user.sub, apiKey: `fixture-${machineId}`, managerId: 'fixture', autonomousEnv: 'prod', authMode: 'remote' } })
  }
})
afterAll(async () => {
  await db?.$disconnect()
  await replica?.stop()
})

/** A Swarm whose PM runs on the owner's Mac, peer a member with their own Mac in the Machines list, and Buddies on. */
async function swarm() {
  const store = new SuperTabStore(db, () => Date.now(), { store: new MemoryAttachmentStore(), prefix: 'super-tabs', publicBase: 'https://cdn.example.test' })
  const tab = (await store.create(owner, randomUUID(), 'Buddies', 'public')).id
  const execute = (command: Command, user = owner, asAgentId?: string, hostMachineId?: string) =>
    store.execute(user, tab, { operationId: randomUUID(), command }, asAgentId, hostMachineId)
  const invitation = await execute({ type: 'invite.create', email: peer.email, role: 'collaborator', conversationId: 'lead' })
  await execute({ type: 'invite.accept', inviteId: invitation.result.inviteId as string }, peer)
  const lead = String((await execute({ type: 'agent.add', conversationId: 'lead', machineId: 'owner-mac', harnessId: randomUUID(), name: 'PM',
    configuration: config, lead: true })).result.agentId)
  await execute({ type: 'machine.contribute', machineId: 'peer-mac', name: 'Peer Mac', cwd: '/swarm', scope: 'swarm', engines: ['claude'], maxAgents: 2 }, peer)
  const generation = (await poolRows(store, peer, 'peer-mac')).find(p => p.tabId === tab)!.machine.generation
  await store.observeMachine(peer, tab, 'peer-mac', { generation, resources: { cpuPercent: 10, memoryTotalBytes: 32e9, memoryUsedBytes: 4e9,
    diskFreeBytes: 120e9, diskTotalBytes: 500e9, projectDiskFreeBytes: 120e9, deviceType: 'Laptop', chip: 'Fixture', os: 'macOS', gpuPercent: null },
  quotas: [], tools: {}, runningHarnessIds: [], stoppedHarnessIds: [] })
  await execute({ type: 'tab.buddies', enabled: true })
  return { store, tab, execute, lead }
}

/** peer's Buddy, added and started by peer-mac's host as a running host does. */
async function buddy(f: Awaited<ReturnType<typeof swarm>>) {
  const added = await f.execute({ type: 'buddy.create', projectId: 'lead', machineId: 'peer-mac', engine: 'claude' }, peer)
  const startId = String(added.result.startId), chat = String(added.result.conversationId)
  const pool = (await poolRows(f.store, peer, 'peer-mac')).find(p => p.tabId === f.tab)!
  const host = (command: Command) => f.execute(command, peer, undefined, 'peer-mac')
  await host({ type: 'agent.startDispatch', startId })
  const agentId = String((await host({ type: 'agent.started', startId, harnessId: randomUUID(), configuration: config })).result.agentId)
  await host({ type: 'agent.startSettled', startId, warning: null })
  return { chat, agentId, pool }
}

describe('a Buddy through the store', () => {
  it('starts on its owner\'s machine from a list older hosts do not read, and joins its owner\'s chat', async () => {
    const f = await swarm()
    const { chat, agentId, pool } = await buddy(f)
    expect(pool.starts).toEqual([])
    expect(pool.buddyStarts).toHaveLength(1)
    const read = await f.store.read(peer, f.tab)
    expect(read.state.agents.find(a => a.id === agentId)).toMatchObject({ buddyOf: { personId: peer.sub } })
    const messages = await f.store.messages(peer, f.tab, chat, {})
    expect(messages.messages.map(m => m.text)).toEqual(['peer\'s Buddy is ready. Tell it what you have in mind.'])
  })

  it('is read by its owner and its Buddy alone: neither the Swarm owner nor the PM reads its chat', async () => {
    const f = await swarm()
    const { chat, agentId } = await buddy(f)
    await f.execute({ type: 'message.send', conversationId: chat, text: 'A private idea', replyTo: null, recipientIds: [] }, peer)
    const delivered = await db.superTabDelivery.findMany({ where: { tabId: f.tab, conversationId: chat } })
    expect(delivered.map(d => d.agentId)).toEqual([agentId])
    expect((await f.store.messages(peer, f.tab, chat, {}, agentId)).messages.map(m => m.text)).toContain('A private idea')
    await expect(f.store.messages(owner, f.tab, chat, {})).rejects.toThrow('unavailable')
    await expect(f.store.messages(owner, f.tab, chat, {}, f.lead)).rejects.toThrow('unavailable')
    expect((await f.store.read(owner, f.tab)).state.conversations.map(c => c.id)).not.toContain(chat)
  })

  it('sends its owner\'s proposal to the PM in the project chat, once per ask', async () => {
    const f = await swarm()
    const { chat, agentId } = await buddy(f)
    const ask = String((await f.execute({ type: 'message.send', conversationId: chat, text: 'Send it to the PM', replyTo: null, recipientIds: [] }, peer)).result.messageId)
    const propose = () => f.execute({ type: 'buddy.propose', conversationId: chat, ownerMessageId: ask, goal: 'Offline sync', scope: 'Desktop only',
      priority: 'normal' }, peer, agentId)
    const sent = await propose()
    const row = await db.superTabMessage.findFirstOrThrow({ where: { tabId: f.tab, id: String(sent.result.messageId) } })
    expect(row).toMatchObject({ conversationId: 'lead', recipientIds: [f.lead], source: { kind: 'buddy-proposal', personId: peer.sub, ownerMessageId: ask },
      text: 'Proposal from peer\'s Buddy, on peer\'s behalf.\n\nGoal: Offline sync\nScope: Desktop only\nPriority: normal' })
    expect(await db.superTabDelivery.count({ where: { tabId: f.tab, messageId: row.id, agentId: f.lead } })).toBe(1)
    await expect(propose()).rejects.toThrow('already sent')
    await expect(f.execute({ type: 'message.send', conversationId: 'lead', text: 'Hi PM', replyTo: null, recipientIds: [] }, peer, agentId))
      .rejects.toThrow('A Buddy posts only in its own chat')
  })

  it('carries the files its owner handed it on the proposal, for the PM to open, and no other file', async () => {
    const f = await swarm()
    const { chat, agentId } = await buddy(f)
    const upload = async (name: string, mime: string, bytes: Buffer, conversationId = chat, asBuddy = true) =>
      (await f.store.upload(peer, f.tab, conversationId, { name, mime, body: Readable.from([bytes]) }, asBuddy ? agentId : undefined)).attachment.id
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])
    const plan = await upload('plan.md', 'text/markdown', Buffer.from('# Offline sync\n'))
    const shot = await upload('shot.png', 'image/png', png)
    // A log its owner sent in their chat, and one they uploaded but never sent.
    const log = await upload('sync.log', 'text/plain', Buffer.from('conflict at 10:02\n'), chat, false)
    const sentIn = String((await f.execute({ type: 'message.send', conversationId: chat, text: 'Here is the log', replyTo: null, recipientIds: [], attachmentIds: [log] }, peer)).result.messageId)
    const unsent = await upload('draft.txt', 'text/plain', Buffer.from('not for the PM'), chat, false)
    const ask = async () => String((await f.execute({ type: 'message.send', conversationId: chat, text: 'Send it to the PM with the plan', replyTo: null, recipientIds: [] }, peer)).result.messageId)
    const propose = async (attachmentIds: string[], ownerMessageId?: string) => f.execute({ type: 'buddy.propose', conversationId: chat,
      ownerMessageId: ownerMessageId ?? await ask(), goal: 'Offline sync', scope: 'Desktop only', priority: 'normal', attachmentIds }, peer, agentId)

    await expect(propose([plan, unsent])).rejects.toThrow('Upload this file again')
    await expect(propose([plan, 'a'.repeat(24), 'b'.repeat(24), 'c'.repeat(24), 'd'.repeat(24), 'e'.repeat(24)])).rejects.toThrow('at most 5 files')
    const sent = await propose([plan, shot, log])
    const id = String(sent.result.messageId)
    const read = (await f.store.messages(owner, f.tab, 'lead', {}, f.lead)).messages.find(m => m.id === id)
    expect(read?.attachments?.map(a => [a.name, a.mime, a.url.startsWith('https://cdn.example.test/super-tabs/')])).toEqual([
      ['plan.md', 'text/markdown', true], ['shot.png', 'image/png', true], ['sync.log', 'text/plain', true]])
    expect((await f.store.messages(owner, f.tab, 'lead', {})).messages.find(m => m.id === id)?.attachments).toHaveLength(3)
    // Its own files go with the proposal; its owner's stays with their message too.
    const rows = await db.superTabAttachment.findMany({ where: { tabId: f.tab, id: { in: [plan, shot, log, unsent] } } })
    expect(Object.fromEntries(rows.map(r => [r.id, r.usedBy ?? null]))).toEqual({ [plan]: id, [shot]: id, [log]: sentIn, [unsent]: null })
    // A file it already sent, and one its owner sent outside their chat, are not its to send.
    await expect(propose([plan])).rejects.toThrow('Upload this file again')
    const elsewhere = await upload('other.txt', 'text/plain', Buffer.from('project chat'), 'lead', false)
    await f.execute({ type: 'message.send', conversationId: 'lead', text: 'FYI', replyTo: null, recipientIds: [], attachmentIds: [elsewhere] }, peer)
    await expect(propose([elsewhere])).rejects.toThrow('Upload this file again')
    // Nor can it post a file in the project chat any other way.
    await expect(upload('leak.md', 'text/markdown', Buffer.from('x'), 'lead')).rejects.toThrow('does not participate')
    const loose = await upload('loose.md', 'text/markdown', Buffer.from('x'))
    await expect(f.execute({ type: 'message.send', conversationId: 'lead', text: '', replyTo: null, recipientIds: [], attachmentIds: [loose] }, peer, agentId))
      .rejects.toThrow('Attach this file again')
  })
})
