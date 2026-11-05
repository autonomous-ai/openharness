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
import { poolRows } from './hostRows.test-support.js'
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
  for (const [machineId, user] of [['owner-mac', owner], ['peer-mac', peer]] as const) {
    await db.machine.create({ data: { machineId, userId: user.sub, apiKey: `fixture-${machineId}`, managerId: 'fixture', autonomousEnv: 'prod', authMode: 'remote' } })
  }
})
afterAll(async () => {
  await db?.$disconnect()
  await replica?.stop()
})

/** A Swarm with a public project `web` (its PM on the owner's Mac) and a private one `secret` (owner and peer); peer and other
 *  are members, peer with a Mac whose host runs peer's Swarm Buddy. */
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
  const secret = (await execute({ type: 'project.create', name: 'Secret', visibility: 'private', brief: '' })).result as { projectId: string; conversationId: string }
  await execute({ type: 'project.sharing', projectId: secret.projectId, visibility: 'private', memberIds: [owner.sub, peer.sub] })
  const pm = String((await execute({ type: 'agent.add', conversationId: web.conversationId, machineId: 'owner-mac', harnessId: randomUUID(), name: 'PM web',
    configuration: config, lead: true })).result.agentId)
  await execute({ type: 'machine.contribute', machineId: 'peer-mac', name: 'Peer Mac', cwd: '/swarm', scope: 'swarm', engines: ['claude'], maxAgents: 8 }, peer)
  const generation = (await poolRows(store, peer, 'peer-mac')).find(p => p.tabId === tab)!.machine.generation
  const running: string[] = []
  const report = () => store.observeMachine(peer, tab, 'peer-mac', { generation, resources: { cpuPercent: 10, memoryTotalBytes: 32e9, memoryUsedBytes: 4e9,
    diskFreeBytes: 120e9, diskTotalBytes: 500e9, projectDiskFreeBytes: 120e9, deviceType: 'Laptop', chip: 'Fixture', os: 'macOS', gpuPercent: null },
  quotas: [], tools: {}, runningHarnessIds: [...running], stoppedHarnessIds: [], capabilities: ['buddySessions', 'swarmBuddy'] })
  await report()
  const host = (command: Command) => execute(command, peer, undefined, 'peer-mac')
  /** peer's one Buddy, added from # buddy and started by their Mac's host. */
  const buddy = async () => {
    const added = await execute({ type: 'buddy.create', machineId: 'peer-mac', engine: 'claude' }, peer)
    const startId = String(added.result.startId)
    await host({ type: 'agent.startDispatch', startId })
    const harnessId = randomUUID()
    running.push(harnessId)
    const agentId = String((await host({ type: 'agent.started', startId, harnessId, configuration: config })).result.agentId)
    await host({ type: 'agent.startSettled', startId, warning: null })
    await report()
    return { chat: String(added.result.conversationId), agentId }
  }
  const send = async (conversationId: string, text: string, user = peer, extra: Partial<Extract<Command, { type: 'message.send' }>> = {}, asAgentId?: string) =>
    String((await execute({ type: 'message.send', conversationId, text, replyTo: null, recipientIds: [], ...extra }, user, asAgentId)).result.messageId)
  const edit = (conversationId: string, messageId: string, text: string, user = peer, asAgentId?: string) =>
    execute({ type: 'message.edit', conversationId, messageId, text }, user, asAgentId)
  const remove = (conversationId: string, messageId: string, user = peer, asAgentId?: string) =>
    execute({ type: 'message.delete', conversationId, messageId }, user, asAgentId)
  const page = async (conversationId: string, user = owner, cursor: Record<string, unknown> = {}) =>
    (await store.messages(user, tab, conversationId, cursor)) as unknown as { messages: Array<Record<string, any>>; threads: Array<Record<string, any>>; reactionSeq: number }
  const group = async (conversationId: string) => (await store.read(owner, tab)).state.conversations.find(c => c.id === conversationId)!
  return { store, files, tab, execute, web, secret, pm, buddy, send, edit, remove, page, group }
}

const refused = (code: string) => expect.objectContaining({ code })

describe('message.edit', () => {
  it('replaces the author\'s text everywhere it is read, marks it edited and keeps no earlier text', async () => {
    const f = await swarm()
    const id = await f.send(f.web.conversationId, 'The build is green.')
    const before = (await f.page(f.web.conversationId)).reactionSeq
    expect((await f.edit(f.web.conversationId, id, '  The build is green now.  ')).result).toMatchObject({ changed: true })
    const read = await f.page(f.web.conversationId)
    expect(read.reactionSeq).toBeGreaterThan(before)
    const shown = read.messages.find(m => m.id === id)!
    expect(shown).toMatchObject({ text: 'The build is green now.', editedAt: expect.any(Date) })
    expect((await f.page(f.web.conversationId, other, { messageId: id })).messages.find(m => m.id === id)?.text).toBe('The build is green now.')
    // No history: the stored row holds the new text alone, and nothing anywhere holds the old.
    const row = await db.superTabMessage.findUniqueOrThrow({ where: { id } })
    expect(JSON.stringify(row)).not.toContain('The build is green.')
    expect(Object.keys(row).filter(k => /history|previous|original/i.test(k))).toEqual([])
    // A credential edited in is removed before it is stored, as in a send (credentials.ts).
    const token = ['ghp', 'Q7mZ2xK9pL4vB8nR1tY6wC3sD5fG0hJ2kM4n'].join('_')
    await f.edit(f.web.conversationId, id, `Token: ${token}`)
    expect(JSON.stringify(await db.superTabMessage.findUniqueOrThrow({ where: { id } }))).not.toContain(token)
    expect((await f.page(f.web.conversationId, other)).messages.find(m => m.id === id)?.text).toBe('Token: [credential removed]')
    await f.edit(f.web.conversationId, id, 'The build is green now.')
    // The same text again changes nothing.
    expect((await f.edit(f.web.conversationId, id, 'The build is green now.')).result).toMatchObject({ changed: false })
  })

  it('only the author: never another person, the owner, the owner\'s PM or the author\'s own Buddy', async () => {
    const f = await swarm()
    const id = await f.send(f.web.conversationId, 'Mine.')
    await expect(f.edit(f.web.conversationId, id, 'Owner rewrites it', owner)).rejects.toThrow(refused('FORBIDDEN'))
    await expect(f.edit(f.web.conversationId, id, 'Other rewrites it', other)).rejects.toThrow(refused('FORBIDDEN'))
    await expect(f.remove(f.web.conversationId, id, other)).rejects.toThrow(refused('FORBIDDEN'))
    await expect(f.edit(f.web.conversationId, id, 'PM rewrites it', owner, f.pm)).rejects.toThrow(expect.objectContaining({ status: 403 }))
    await expect(f.remove(f.web.conversationId, id, owner, f.pm)).rejects.toThrow(expect.objectContaining({ status: 403 }))
    // An agent's own post is not editable either.
    const pmLine = await f.send(f.web.conversationId, 'PM line', owner, {}, f.pm)
    await expect(f.edit(f.web.conversationId, pmLine, 'PM edits', owner, f.pm)).rejects.toThrow(expect.objectContaining({ status: 403 }))
    await expect(f.edit(f.web.conversationId, pmLine, 'Owner edits the PM', owner)).rejects.toThrow(refused('FORBIDDEN'))
    // peer's Buddy, in peer's own chat, on peer's own message: refused.
    const buddy = await f.buddy()
    const own = await f.send(buddy.chat, 'Look into the CPU spike')
    await expect(f.edit(buddy.chat, own, 'Buddy rewrites it', peer, buddy.agentId)).rejects.toThrow(expect.objectContaining({ status: 403 }))
    await expect(f.remove(buddy.chat, own, peer, buddy.agentId)).rejects.toThrow(expect.objectContaining({ status: 403 }))
    expect((await f.page(f.web.conversationId)).messages.find(m => m.id === id)?.text).toBe('Mine.')
    expect((await f.page(buddy.chat, peer)).messages.find(m => m.id === own)?.text).toBe('Look into the CPU spike')
    // The author still can, in their Buddy chat too.
    await f.edit(buddy.chat, own, 'Look into the memory spike')
    expect((await f.page(buddy.chat, peer)).messages.find(m => m.id === own)?.text).toBe('Look into the memory spike')
  })

  it('reads a message the actor cannot see as unavailable: another chat\'s id, a private chat, an agent-only notice', async () => {
    const f = await swarm()
    const secretLine = await f.send(f.secret.conversationId, 'Secret plan')
    // Named under another conversation: not found there.
    await expect(f.edit(f.web.conversationId, secretLine, 'Moved')).rejects.toThrow(refused('NOT_FOUND'))
    // A person who cannot read the private chat learns nothing about the message.
    await expect(f.edit(f.secret.conversationId, secretLine, 'Peeked', other)).rejects.toThrow(expect.objectContaining({ status: 404 }))
    await expect(f.edit(f.web.conversationId, 'no-such-message', 'x')).rejects.toThrow(refused('NOT_FOUND'))
  })
})

describe('message.delete', () => {
  it.each([false, true])('lets only the owner delete their Buddy proposal, removing its content with replies: %s', async hasReplies => {
    const f = await swarm()
    const { chat, agentId } = await f.buddy()
    const line = 'Fix my login'
    const ask = await f.send(chat, line)
    const command: Command = { type: 'buddy.propose', conversationId: chat, ownerMessageId: ask, projectId: f.web.projectId,
      text: line, goal: line, scope: 'Private detail copied into the scope', priority: 'normal' }
    const id = String((await f.execute(command, peer, agentId)).result.messageId)
    const answer = hasReplies ? await f.send(f.web.conversationId, 'I can reproduce it.', other, { replyTo: id }) : undefined
    for (const person of [owner, other]) await expect(f.remove(f.web.conversationId, id, person)).rejects.toThrow(refused('FORBIDDEN'))
    await expect(f.remove(f.web.conversationId, id, owner, f.pm)).rejects.toThrow(expect.objectContaining({ status: 403 }))
    await expect(f.remove(f.web.conversationId, id, peer, agentId)).rejects.toThrow(expect.objectContaining({ status: 403 }))
    await expect(f.edit(f.web.conversationId, id, 'Rewritten')).rejects.toThrow(refused('FORBIDDEN'))
    expect((await f.remove(f.web.conversationId, id)).result).toMatchObject({ changed: true, kept: hasReplies })
    const row = await db.superTabMessage.findUnique({ where: { id } })
    if (hasReplies) {
      expect(row).toMatchObject({ text: DELETED_TEXT, deletedAt: expect.any(Date) })
      expect(row?.source ?? null).toBeNull()
      const thread = await f.page(f.web.conversationId, other, { thread: id })
      expect(thread.messages.map(m => m.id)).toEqual([id, answer])
      expect(JSON.stringify(thread)).not.toContain(line)
      expect(JSON.stringify(thread)).not.toContain(command.scope)
      await expect(f.remove(f.web.conversationId, id)).rejects.toThrow(refused('MESSAGE_DELETED'))
    } else {
      expect(row).toBeNull()
      expect((await f.page(f.web.conversationId)).messages.some(m => m.id === id)).toBe(false)
    }
    expect(await db.superTabDelivery.count({ where: { tabId: f.tab, messageId: id, status: { in: ['queued', 'claimed', 'gathered'] } } })).toBe(0)
    // Deleting the post does not grant the Buddy permission to post the same ask again.
    await expect(f.execute(command, peer, agentId)).rejects.toThrow(refused('PROPOSAL_SENT'))
  })

  it('never treats a non-proposal source or a mismatched source owner as permission to delete', async () => {
    const f = await swarm()
    const id = await f.send(f.web.conversationId, 'Own message')
    for (const source of [{ kind: 'buddy-proposal', personId: other.sub }, { kind: 'task-request', personId: peer.sub }, { kind: 'buddy-proposal' }]) {
      await db.superTabMessage.update({ where: { id }, data: { source } })
      await expect(f.remove(f.web.conversationId, id)).rejects.toThrow(refused('FORBIDDEN'))
    }
  })

  it.each([false, true])('preserves files handed on from the owner chat when deleting a proposal, with replies: %s', async hasReplies => {
    const f = await swarm()
    const { chat, agentId } = await f.buddy()
    const upload = async (name: string, asBuddy = false) => (await f.store.upload(peer, f.tab, chat,
      { name, mime: 'text/plain', body: Readable.from([Buffer.from(name)]) }, asBuddy ? agentId : undefined)).attachment.id
    const handed = await upload('owner-note.txt'), owned = await upload('proposal-note.txt', true)
    const ask = await f.send(chat, 'Send the notes to the PM', peer, { attachmentIds: [handed] })
    const id = String((await f.execute({ type: 'buddy.propose', conversationId: chat, ownerMessageId: ask, projectId: f.web.projectId,
      text: 'Send the notes to the PM', goal: 'Fix drafts', scope: 'Desktop', priority: 'normal', attachmentIds: [handed, owned] }, peer, agentId)).result.messageId)
    expect(await db.superTabAttachment.findUniqueOrThrow({ where: { id: handed } })).toMatchObject({ usedBy: ask, proposedBy: id })
    expect(await db.superTabAttachment.findUniqueOrThrow({ where: { id: owned } })).toMatchObject({ usedBy: id })
    if (hasReplies) await f.send(f.web.conversationId, 'I can reproduce it.', other, { replyTo: id })
    const entries = await profiled(db, () => f.remove(f.web.conversationId, id))
    const kept = await db.superTabAttachment.findUniqueOrThrow({ where: { id: handed } })
    expect(kept.usedBy).toBe(ask)
    expect(kept.proposedBy ?? null).toBeNull()
    expect((await db.superTabAttachment.findUniqueOrThrow({ where: { id: owned } })).usedBy).toBe(EXPIRED_UPLOAD)
    expect((await f.page(chat, peer)).messages.find(m => m.id === ask)?.attachments).toEqual([expect.objectContaining({ id: handed })])
    const updates = entries.filter(e => e.ns.endsWith('.SuperTabAttachment'))
    expect(updates.length).toBeGreaterThan(0)
    expect(updates.filter(e => /COLLSCAN/.test(String(e.planSummary)))).toEqual([])
  })

  it('removes a message with no replies: its row, reactions, Activity, open deliveries and files', async () => {
    const f = await swarm()
    const root = await f.send(f.web.conversationId, 'Owner root', owner)
    const upload = await f.store.upload(peer, f.tab, f.web.conversationId, { name: 'plan.txt', mime: 'text/plain', body: Readable.from([Buffer.from('plan')]) })
    const fileId = String((upload as { attachment?: { id: string }; id?: string }).attachment?.id ?? (upload as { id?: string }).id)
    const reply = await f.send(f.web.conversationId, 'See the plan', peer, { replyTo: root, attachmentIds: [fileId], recipientIds: [f.pm] })
    await f.execute({ type: 'message.react', conversationId: f.web.conversationId, messageId: reply, emoji: 'thumbs_up', on: true }, owner)
    expect(await db.superTabDelivery.count({ where: { messageId: reply, status: { in: ['queued', 'claimed'] } } })).toBe(1)
    expect((await f.page(f.web.conversationId, owner, { thread: root })).threads.find(t => t.id === root)?.replies).toBe(1)
    expect((await f.remove(f.web.conversationId, reply)).result).toMatchObject({ changed: true, kept: false })
    expect(await db.superTabMessage.findUnique({ where: { id: reply } })).toBeNull()
    expect(await db.superTabReaction.count({ where: { messageId: reply } })).toBe(0)
    expect(await db.superTabActivity.count({ where: { messageId: reply } })).toBe(0)
    expect(await db.superTabDelivery.count({ where: { messageId: reply, status: { in: ['queued', 'claimed', 'gathered'] } } })).toBe(0)
    // Its file goes to the hourly sweep, which removes the stored bytes (lib/attachmentSweep.ts).
    expect((await db.superTabAttachment.findUniqueOrThrow({ where: { id: fileId } })).usedBy).toBe(EXPIRED_UPLOAD)
    // The thread it was in no longer counts it.
    const thread = await f.page(f.web.conversationId, owner, { thread: root })
    expect(thread.messages.map(m => m.id)).toEqual([root])
    expect(thread.threads.find(t => t.id === root)?.replies ?? 0).toBe(0)
    // Gone means gone: no edit, no second delete, no reply to it.
    await expect(f.edit(f.web.conversationId, reply, 'Back')).rejects.toThrow(refused('NOT_FOUND'))
    await expect(f.remove(f.web.conversationId, reply)).rejects.toThrow(refused('NOT_FOUND'))
  })

  it('removes the tags a deleted message gave, so nobody keeps a waiting tag to a message they cannot open', async () => {
    const f = await swarm()
    const tagged = await f.send(f.web.conversationId, '@other can you look?', peer, { mentions: [other.sub] })
    const kept = await f.send(f.web.conversationId, '@other and this one', peer, { mentions: [other.sub] })
    await f.send(f.web.conversationId, 'Looking.', owner, { replyTo: kept })
    expect(await db.superTabMention.count({ where: { messageId: { in: [tagged, kept] } } })).toBe(2)
    await f.remove(f.web.conversationId, tagged)
    await f.remove(f.web.conversationId, kept)
    expect(await db.superTabMention.count({ where: { messageId: { in: [tagged, kept] } } })).toBe(0)
  })

  it('keeps a root with replies as "This message was deleted." and its replies keep their thread', async () => {
    const f = await swarm()
    const root = await f.send(f.web.conversationId, 'Should we ship? Secret detail here.')
    const answer = await f.send(f.web.conversationId, 'Yes, ship it.', owner, { replyTo: root })
    expect((await f.remove(f.web.conversationId, root)).result).toMatchObject({ changed: true, kept: true })
    const main = await f.page(f.web.conversationId, other)
    const tomb = main.messages.find(m => m.id === root)!
    expect(tomb).toMatchObject({ text: DELETED_TEXT, deletedAt: expect.any(Date) })
    expect(tomb.attachments ?? null).toBeNull()
    expect(JSON.stringify(await db.superTabMessage.findUniqueOrThrow({ where: { id: root } }))).not.toContain('Secret detail')
    const thread = await f.page(f.web.conversationId, other, { thread: root })
    expect(thread.messages.map(m => m.id)).toEqual([root, answer])
    expect(thread.threads.find(t => t.id === root)?.replies).toBe(1)
    // A deleted message is not edited back, deleted again or reacted to; its thread still takes replies.
    await expect(f.edit(f.web.conversationId, root, 'Undo')).rejects.toThrow(refused('MESSAGE_DELETED'))
    await expect(f.remove(f.web.conversationId, root)).rejects.toThrow(refused('MESSAGE_DELETED'))
    await f.send(f.web.conversationId, 'Shipped.', owner, { replyTo: root })
    expect((await f.page(f.web.conversationId, other, { thread: root })).messages).toHaveLength(3)
  })

  it('reads and writes every row it touches through an index, never by scanning a collection', async () => {
    const f = await swarm()
    const root = await f.send(f.web.conversationId, 'Owner root', owner)
    const reply = await f.send(f.web.conversationId, 'Reply', peer, { replyTo: root, recipientIds: [f.pm] })
    await f.execute({ type: 'message.react', conversationId: f.web.conversationId, messageId: reply, emoji: 'thumbs_up', on: true }, owner)
    const touched = ['SuperTabMessage', 'SuperTabReaction', 'SuperTabActivity', 'SuperTabDelivery', 'SuperTabAttachment', 'SuperTabThread', 'SuperTabMention']
    const entries = await profiled(db, () => f.remove(f.web.conversationId, reply))
    // The profiler saw the delete's writes (so the check below is not empty by accident).
    for (const c of ['SuperTabMessage', 'SuperTabDelivery', 'SuperTabActivity']) expect(entries.some(e => e.ns.endsWith(`.${c}`))).toBe(true)
    const scans = entries.filter(e => touched.some(c => e.ns.endsWith(`.${c}`)) && /COLLSCAN/.test(String(e.planSummary)))
    expect(scans.map(e => [e.ns, e.op, JSON.stringify(e.command?.filter ?? e.command?.q ?? e.command?.pipeline)])).toEqual([])
  })

  it('steps the chat\'s newest-message counters back, so a deleted newest message leaves nobody unread', async () => {
    const f = await swarm()
    await f.send(f.web.conversationId, 'Earlier', owner)
    const before = await f.group(f.web.conversationId)
    const newest = await f.send(f.web.conversationId, 'Oops, wrong chat')
    expect((await f.group(f.web.conversationId)).lastMainSequence).toBeGreaterThan(before.lastMainSequence!)
    await f.remove(f.web.conversationId, newest)
    const after = await f.group(f.web.conversationId)
    expect(after.lastMainSequence).toBe(before.lastMainSequence)
    expect(after.lastPersonSequence).toBe(before.lastPersonSequence)
    expect(after.lastMessageSequence).toBe(before.lastMessageSequence)
  })
})
