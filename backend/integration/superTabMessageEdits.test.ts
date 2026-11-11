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
import { EXPIRED_UPLOAD, MemoryAttachmentStore } from '../src/superTabs/attachments.js'
import type { Command } from '../src/superTabs/commands.js'
import { DELETED_TEXT } from '../src/superTabs/messageEdits.js'
import { profiled } from './plans.test-support.js'

// Edit and delete your own message (task #2746): only the author, a person, on their own post. A fresh loopback replica set.
let replica: MongoMemoryReplSet
let db: PrismaClient
const owner: AuthUser = { sub: '330000000000000000000001', email: 'owner@example.com', autonomousEnv: 'prod', role: 'user' }
const peer: AuthUser = { sub: '330000000000000000000002', email: 'peer@example.com', autonomousEnv: 'prod', role: 'user' }
const other: AuthUser = { sub: '330000000000000000000003', email: 'other@example.com', autonomousEnv: 'prod', role: 'user' }
const config = { engine: 'claude', model: 'fixture-model', effort: 'high', contextWindow: 200000, engineVersion: 'fixture' }

beforeAll(async () => {
  replica = await MongoMemoryReplSet.create({ binary: { version: '7.0.24', downloadDir: join(tmpdir(), 'harness-super-tab-mongodb-binaries') },
    replSet: { count: 1, ip: '127.0.0.1', storageEngine: 'wiredTiger' } })
  const uri = replica.getUri(`swarm_message_edits_test_${randomUUID().replaceAll('-', '_')}`)
  await promisify(execFile)(join(process.cwd(), 'node_modules/.bin/prisma'), ['db', 'push', '--skip-generate'], {
    env: { ...process.env, DATABASE_URL: uri }, timeout: 60000,
  })
  db = new PrismaClient({ datasources: { db: { url: uri } } })
  for (const user of [owner, peer, other]) await db.user.create({ data: { id: user.sub, externalId: `fixture-${user.sub}`, email: user.email, autonomousEnv: user.autonomousEnv } })
  await db.machine.create({ data: { machineId: 'peer-mac', userId: peer.sub, apiKey: 'fixture-peer-mac', managerId: 'fixture', autonomousEnv: 'prod', authMode: 'remote' } })
})
afterAll(async () => {
  await db?.$disconnect()
  await replica?.stop()
})

/** A Swarm with a public project `web`; peer and other are members. Peer writes in their own chat with Ada, their agent on their
 *  Mac: a person posts there, as only agents post in a project's channel and its tasks' chats (agentsOnly.test.ts). */
async function swarm() {
  const files = new MemoryAttachmentStore()
  const store = new SuperTabStore(db, () => Date.now(), { store: files, prefix: 'super-tabs', publicBase: 'https://cdn.example.test' })
  const tab = (await store.create(owner, randomUUID(), 'Edits', 'public')).id
  const execute = (command: Command, user = owner, asAgentId?: string, hostMachineId?: string) =>
    store.execute(user, tab, { operationId: randomUUID(), command }, asAgentId, hostMachineId)
  for (const person of [peer, other]) {
    const invitation = await execute({ type: 'invite.create', email: person.email, role: 'collaborator', conversationId: 'lead' })
    await execute({ type: 'invite.accept', inviteId: invitation.result.inviteId as string }, person)
  }
  const web = (await execute({ type: 'project.create', name: 'Web', visibility: 'public', brief: '' })).result as { projectId: string; conversationId: string }
  const chat = String((await execute({ type: 'agent.new', kind: 'regular', machineId: 'peer-mac', engine: 'claude', name: 'Ada', local: true }, peer))
    .result.conversationId)
  const ada = String((await execute({ type: 'agent.add', conversationId: chat, machineId: 'peer-mac', harnessId: randomUUID(), name: 'Ada',
    configuration: config, lead: false }, peer)).result.agentId)
  const send = async (conversationId: string, text: string, user = peer, extra: Partial<Extract<Command, { type: 'message.send' }>> = {}, asAgentId?: string) =>
    String((await execute({ type: 'message.send', conversationId, text, replyTo: null, recipientIds: [], ...extra }, user, asAgentId)).result.messageId)
  const edit = (conversationId: string, messageId: string, text: string, user = peer, asAgentId?: string) =>
    execute({ type: 'message.edit', conversationId, messageId, text }, user, asAgentId)
  const remove = (conversationId: string, messageId: string, user = peer, asAgentId?: string) =>
    execute({ type: 'message.delete', conversationId, messageId }, user, asAgentId)
  const page = async (conversationId: string, user = peer, cursor: Record<string, unknown> = {}, asAgentId?: string) =>
    (await store.messages(user, tab, conversationId, cursor, asAgentId)) as unknown as { messages: Array<Record<string, any>>; threads: Array<Record<string, any>>; reactionSeq: number }
  const group = async (conversationId: string) => (await store.read(peer, tab)).state.conversations.find(c => c.id === conversationId)!
  return { store, files, tab, execute, web, chat, ada, send, edit, remove, page, group }
}

const refused = (code: string) => expect.objectContaining({ code })

describe('message.edit', () => {
  it('replaces the author\'s text everywhere it is read, marks it edited and keeps no earlier text', async () => {
    const f = await swarm()
    const id = await f.send(f.chat, 'The build is green.')
    const before = (await f.page(f.chat)).reactionSeq
    expect((await f.edit(f.chat, id, '  The build is green now.  ')).result).toMatchObject({ changed: true })
    const read = await f.page(f.chat)
    expect(read.reactionSeq).toBeGreaterThan(before)
    const shown = read.messages.find(m => m.id === id)!
    expect(shown).toMatchObject({ text: 'The build is green now.', editedAt: expect.any(Date) })
    // Its agent reads the new text too.
    expect((await f.page(f.chat, peer, { messageId: id }, f.ada)).messages.find(m => m.id === id)?.text).toBe('The build is green now.')
    // No history: the stored row holds the new text alone, and nothing anywhere holds the old.
    const row = await db.superTabMessage.findUniqueOrThrow({ where: { id } })
    expect(JSON.stringify(row)).not.toContain('The build is green.')
    expect(Object.keys(row).filter(k => /history|previous|original/i.test(k))).toEqual([])
    // A credential edited in is removed before it is stored, as in a send (credentials.ts).
    const token = ['ghp', 'Q7mZ2xK9pL4vB8nR1tY6wC3sD5fG0hJ2kM4n'].join('_')
    await f.edit(f.chat, id, `Token: ${token}`)
    expect(JSON.stringify(await db.superTabMessage.findUniqueOrThrow({ where: { id } }))).not.toContain(token)
    expect((await f.page(f.chat, peer, {}, f.ada)).messages.find(m => m.id === id)?.text).toBe('Token: [credential removed]')
    await f.edit(f.chat, id, 'The build is green now.')
    // The same text again changes nothing.
    expect((await f.edit(f.chat, id, 'The build is green now.')).result).toMatchObject({ changed: false })
  })

  it('only the author: never another person, the owner or the author\'s own agent', async () => {
    const f = await swarm()
    const id = await f.send(f.chat, 'Mine.')
    // Another person, the owner too, does not read the chat: the message is unavailable to them.
    await expect(f.edit(f.chat, id, 'Owner rewrites it', owner)).rejects.toThrow(expect.objectContaining({ status: 404 }))
    await expect(f.edit(f.chat, id, 'Other rewrites it', other)).rejects.toThrow(expect.objectContaining({ status: 404 }))
    await expect(f.remove(f.chat, id, other)).rejects.toThrow(expect.objectContaining({ status: 404 }))
    await expect(f.edit(f.chat, id, 'Ada rewrites it', peer, f.ada)).rejects.toThrow(expect.objectContaining({ status: 403 }))
    await expect(f.remove(f.chat, id, peer, f.ada)).rejects.toThrow(expect.objectContaining({ status: 403 }))
    // An agent's own post is not editable either.
    const adaLine = await f.send(f.chat, 'Ada line', peer, {}, f.ada)
    await expect(f.edit(f.chat, adaLine, 'Ada edits', peer, f.ada)).rejects.toThrow(expect.objectContaining({ status: 403 }))
    await expect(f.edit(f.chat, adaLine, 'Peer edits Ada', peer)).rejects.toThrow(refused('FORBIDDEN'))
    expect((await f.page(f.chat)).messages.find(m => m.id === id)?.text).toBe('Mine.')
  })

  it('reads a message the actor cannot see as unavailable: another chat\'s id, a private chat, an agent-only notice', async () => {
    const f = await swarm()
    const secretLine = await f.send(f.chat, 'Secret plan')
    // Named under another conversation: not found there.
    await expect(f.edit(f.web.conversationId, secretLine, 'Moved')).rejects.toThrow(refused('NOT_FOUND'))
    // A person who cannot read the private chat learns nothing about the message.
    await expect(f.edit(f.chat, secretLine, 'Peeked', other)).rejects.toThrow(expect.objectContaining({ status: 404 }))
    await expect(f.edit(f.web.conversationId, 'no-such-message', 'x')).rejects.toThrow(refused('NOT_FOUND'))
  })
})

describe('message.delete', () => {
  it('never takes a row with a source, a person\'s own included, as theirs to delete', async () => {
    const f = await swarm()
    const id = await f.send(f.chat, 'Own message')
    for (const source of [{ kind: 'buddy-proposal', personId: peer.sub }, { kind: 'task-request', personId: peer.sub }]) {
      await db.superTabMessage.update({ where: { id }, data: { source } })
      await expect(f.remove(f.chat, id)).rejects.toThrow(refused('FORBIDDEN'))
    }
  })

  it('removes a message with no replies: its row, open deliveries and files', async () => {
    const f = await swarm()
    const root = await f.send(f.chat, 'Ada root', peer, {}, f.ada)
    const upload = await f.store.upload(peer, f.tab, f.chat, { name: 'plan.txt', mime: 'text/plain', body: Readable.from([Buffer.from('plan')]) })
    const fileId = String((upload as { attachment?: { id: string }; id?: string }).attachment?.id ?? (upload as { id?: string }).id)
    const reply = await f.send(f.chat, 'See the plan', peer, { replyTo: root, attachmentIds: [fileId], recipientIds: [f.ada] })
    expect(await db.superTabDelivery.count({ where: { messageId: reply, status: { in: ['queued', 'claimed'] } } })).toBe(1)
    expect((await f.page(f.chat, peer, { thread: root })).threads.find(t => t.id === root)?.replies).toBe(1)
    expect((await f.remove(f.chat, reply)).result).toMatchObject({ changed: true, kept: false })
    expect(await db.superTabMessage.findUnique({ where: { id: reply } })).toBeNull()
    expect(await db.superTabDelivery.count({ where: { messageId: reply, status: { in: ['queued', 'claimed'] } } })).toBe(0)
    // Its file goes to the hourly sweep, which removes the stored bytes (lib/attachmentSweep.ts).
    expect((await db.superTabAttachment.findUniqueOrThrow({ where: { id: fileId } })).usedBy).toBe(EXPIRED_UPLOAD)
    // The thread it was in no longer counts it.
    const thread = await f.page(f.chat, peer, { thread: root })
    expect(thread.messages.map(m => m.id)).toEqual([root])
    expect(thread.threads.find(t => t.id === root)?.replies ?? 0).toBe(0)
    // Gone means gone: no edit, no second delete, no reply to it.
    await expect(f.edit(f.chat, reply, 'Back')).rejects.toThrow(refused('NOT_FOUND'))
    await expect(f.remove(f.chat, reply)).rejects.toThrow(refused('NOT_FOUND'))
  })

  it('keeps a root with replies as "This message was deleted." and its replies keep their thread', async () => {
    const f = await swarm()
    const root = await f.send(f.chat, 'Should we ship? Secret detail here.')
    const answer = await f.send(f.chat, 'Yes, ship it.', peer, { replyTo: root }, f.ada)
    expect((await f.remove(f.chat, root)).result).toMatchObject({ changed: true, kept: true })
    // Its agent reads what is left.
    const main = await f.page(f.chat, peer, {}, f.ada)
    const tomb = main.messages.find(m => m.id === root)!
    expect(tomb).toMatchObject({ text: DELETED_TEXT, deletedAt: expect.any(Date) })
    expect(tomb.attachments ?? null).toBeNull()
    expect(JSON.stringify(await db.superTabMessage.findUniqueOrThrow({ where: { id: root } }))).not.toContain('Secret detail')
    const thread = await f.page(f.chat, peer, { thread: root }, f.ada)
    expect(thread.messages.map(m => m.id)).toEqual([root, answer])
    expect(thread.threads.find(t => t.id === root)?.replies).toBe(1)
    // A deleted message is not edited back or deleted again; its thread still takes replies.
    await expect(f.edit(f.chat, root, 'Undo')).rejects.toThrow(refused('MESSAGE_DELETED'))
    await expect(f.remove(f.chat, root)).rejects.toThrow(refused('MESSAGE_DELETED'))
    await f.send(f.chat, 'Shipped.', peer, { replyTo: root }, f.ada)
    expect((await f.page(f.chat, peer, { thread: root }, f.ada)).messages).toHaveLength(3)
  })

  it('reads and writes every row it touches through an index, never by scanning a collection', async () => {
    const f = await swarm()
    const root = await f.send(f.chat, 'Ada root', peer, {}, f.ada)
    const reply = await f.send(f.chat, 'Reply', peer, { replyTo: root, recipientIds: [f.ada] })
    const touched = ['SuperTabMessage', 'SuperTabDelivery', 'SuperTabAttachment', 'SuperTabThread']
    const entries = await profiled(db, () => f.remove(f.chat, reply))
    // The profiler saw the delete's writes (so the check below is not empty by accident).
    for (const c of ['SuperTabMessage', 'SuperTabDelivery']) expect(entries.some(e => e.ns.endsWith(`.${c}`))).toBe(true)
    const scans = entries.filter(e => touched.some(c => e.ns.endsWith(`.${c}`)) && /COLLSCAN/.test(String(e.planSummary)))
    expect(scans.map(e => [e.ns, e.op, JSON.stringify(e.command?.filter ?? e.command?.q ?? e.command?.pipeline)])).toEqual([])
  })

  it('steps the chat\'s newest-message counters back, so a deleted newest message leaves nobody unread', async () => {
    const f = await swarm()
    await f.send(f.chat, 'Earlier')
    const before = await f.group(f.chat)
    const newest = await f.send(f.chat, 'Oops, wrong chat')
    expect((await f.group(f.chat)).lastMainSequence).toBeGreaterThan(before.lastMainSequence!)
    await f.remove(f.chat, newest)
    const after = await f.group(f.chat)
    expect(after.lastMainSequence).toBe(before.lastMainSequence)
    expect(after.lastPersonSequence).toBe(before.lastPersonSequence)
    expect(after.lastMessageSequence).toBe(before.lastMessageSequence)
  })
})
