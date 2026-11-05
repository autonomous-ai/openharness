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

// Plain chat (task #2294; docs/plans/2026-11-03-plain-chat-work-plan.md): each task is one ordinary message, its title alone, in
// its project chat, never edited, with the PM's replies in its thread as it moves, none for its steps, and a private
// project's only for that project's readers. Through the store and a fresh loopback replica set, as the people's apps read it.
let replica: MongoMemoryReplSet
let db: PrismaClient
let store: SuperTabStore
const owner: AuthUser = { sub: '150000000000000000000001', email: 'dee@example.com', autonomousEnv: 'prod', role: 'user' }
const peer: AuthUser = { sub: '150000000000000000000002', email: 'peer@example.com', autonomousEnv: 'prod', role: 'user' }
const host: AuthUser = { sub: '150000000000000000000003', email: 'host@example.com', autonomousEnv: 'prod', role: 'user' }
const config = { engine: 'codex', model: 'fixture-model', effort: 'high', contextWindow: 200000, engineVersion: 'fixture' }
const run = (tab: string, command: Command, user = owner, asAgentId?: string) =>
  store.execute(user, tab, { operationId: randomUUID(), command }, asAgentId)

beforeAll(async () => {
  replica = await MongoMemoryReplSet.create({ binary: { version: '7.0.24', downloadDir: join(tmpdir(), 'harness-super-tab-mongodb-binaries') },
    replSet: { count: 1, ip: '127.0.0.1', storageEngine: 'wiredTiger' } })
  const uri = replica.getUri(`task_lines_test_${randomUUID().replaceAll('-', '_')}`)
  await promisify(execFile)(join(process.cwd(), 'node_modules/.bin/prisma'), ['db', 'push', '--skip-generate'], {
    env: { ...process.env, DATABASE_URL: uri }, timeout: 60000,
  })
  db = new PrismaClient({ datasources: { db: { url: uri } } })
  store = new SuperTabStore(db)
  for (const user of [owner, peer, host]) await db.user.create({ data: { id: user.sub, externalId: `fixture-${user.sub}`,
    email: user.email, autonomousEnv: user.autonomousEnv } })
  await db.machine.create({ data: { machineId: 'test-host', userId: host.sub, apiKey: 'fixture-only', managerId: 'fixture',
    autonomousEnv: 'prod', authMode: 'remote' } })
  await db.machineShare.create({ data: { machineId: 'test-host', ownerId: host.sub, autonomousEnv: 'prod', emails: [owner.email] } })
})
afterAll(async () => {
  await db?.$disconnect()
  await replica?.stop()
})

type Row = { id: string; text: string; source?: Record<string, unknown> | null; recipientIds?: string[] }
async function swarm() {
  const tab = (await store.create(owner, randomUUID(), 'Quiet')).id
  const invitation = await run(tab, { type: 'invite.create', email: peer.email, role: 'collaborator', conversationId: 'lead' })
  await run(tab, { type: 'invite.accept', inviteId: invitation.result.inviteId as string }, peer)
  const add = async (name: string, conversationId: string, lead = false) => String((await run(tab, { type: 'agent.add', conversationId,
    machineId: 'test-host', harnessId: randomUUID(), name, configuration: config, lead })).result.agentId)
  const as = (agentId: string) => (command: Command) => run(tab, command, host, agentId)
  /** The task lines a person's app reads on a chat's newest page, and the page's reaction counter. */
  const page = async (conversationId: string, user = owner) => {
    const answer = await store.messages(user, tab, conversationId, {}) as unknown as { messages: Row[]; reactionSeq: number }
    return { lines: answer.messages.filter(m => m.source?.kind === 'task-line'), reactionSeq: answer.reactionSeq }
  }
  /** The owner's own message in [conversationId], which a task names as its request. */
  const ask = async (text: string, conversationId = 'lead') => String((await run(tab, { type: 'message.send', conversationId, text, replyTo: null,
    recipientIds: [] })).result.messageId)
  return { tab, add, as, page, ask }
}

describe('a task\'s one message in its project chat', () => {
  // Anh Dee, 11-04 ('bot messages'): a person sees only rows they wrote. A task no message asked for lives in Backlog and its own
  // conversation: no row under its requester's name, and nothing in the project chat as it moves.
  it('posts nothing in the project chat for a task no message asked for, while it is still in the Swarm\'s tasks', async () => {
    const s = await swarm()
    const P = await s.add('Coordinator', 'lead', true)
    const before = (await store.messages(owner, s.tab, 'lead', {})).messages.length
    const T = String((await s.as(P)({ type: 'conversation.create', title: 'Offline drafts', requesterId: owner.sub, brief: 'Keep drafts.', checks: [{ description: 'Done', independent: false }], priority: 'P2' })).result.conversationId)
    const E = await s.add('Engineer', T)
    const assignmentId = String((await s.as(P)({ type: 'work.assign', conversationId: T, agentId: E })).result.assignmentId)
    const pr = 'https://github.com/example/app/pull/7'
    await s.as(E)({ type: 'work.status', conversationId: T, assignmentId, status: 'review', result: `Ready: ${pr}` })
    await s.as(E)({ type: 'work.status', conversationId: T, assignmentId, status: 'done', result: `Checks passed: ${pr}` })
    await s.as(P)({ type: 'conversation.merged', conversationId: T, pullRequestUrl: pr })
    const chat = await store.messages(owner, s.tab, 'lead', {})
    expect(chat.messages.slice(before).filter(m => !(m.source as { kind?: string } | null)?.kind?.startsWith('route'))
      .map(m => [m.text, (m.author as { id: string }).id])).toEqual([])
    expect(chat.threads ?? []).toEqual([])
    // Backlog and the status card read the tasks, not the chat: it is there, with its requester.
    expect((await store.read(owner, s.tab)).state.conversations.find(c => c.id === T)).toMatchObject({ requesterId: owner.sub, title: 'Offline drafts' })
  })

  it('keeps a person\'s own chat message as the task\'s root, and refuses any other message', async () => {
    const s = await swarm()
    const P = await s.add('Coordinator', 'lead', true)
    const asked = String((await run(s.tab, { type: 'message.send', conversationId: 'lead', text: 'Can the phone show who answered?', replyTo: null,
      recipientIds: [] }, peer)).result.messageId)
    const T = String((await s.as(P)({ type: 'conversation.create', title: 'Phone shows who answered', brief: 'Show who answered.', checks: [{ description: 'Done', independent: false }], priority: 'P2',
      requestMessageId: asked })).result.conversationId)
    expect((await s.page('lead')).lines).toEqual([])
    expect((await store.read(owner, s.tab)).state.conversations.find(c => c.id === T)?.requesterId).toBe(peer.sub)
    const E = await s.add('Engineer', T)
    await s.as(P)({ type: 'work.assign', conversationId: T, agentId: E })
    // A second task may hang under the same message; its thread names both.
    await s.as(P)({ type: 'conversation.create', title: 'Desktop shows who answered', brief: 'Same on Desktop.', checks: [{ description: 'Done', independent: false }], priority: 'P2', requestMessageId: asked })
    expect((await s.page('lead')).lines).toEqual([])
    expect((await store.messages(owner, s.tab, 'lead', { thread: asked })).messages.map(m => m.text))
      .toEqual(['Can the phone show who answered?', 'Phone shows who answered', 'Desktop shows who answered'])
    const inTask = String((await run(s.tab, { type: 'message.send', conversationId: T, text: 'Also Desktop?', replyTo: null, recipientIds: [] })).result.messageId)
    await expect(s.as(P)({ type: 'conversation.create', title: 'Another', brief: '', checks: [], requestMessageId: inTask })).rejects.toThrow('own message')
    await expect(s.as(P)({ type: 'conversation.create', title: 'Another', brief: '', checks: [], requestMessageId: 'missing' })).rejects.toThrow('own message')
  })

  // In place of the On it / Shipped label (anh Dee, 11-04, 'bot messages'): the task's agent reacts on the message that asked.
  it('reacts 👀 as the agent when its work starts and ✅ once when it merges, on the asking message, with its author told', async () => {
    const s = await swarm()
    const P = await s.add('Coordinator', 'lead', true)
    const asked = String((await run(s.tab, { type: 'message.send', conversationId: 'lead', text: 'Can drafts survive a restart?', replyTo: null,
      recipientIds: [] }, peer)).result.messageId)
    const T = String((await s.as(P)({ type: 'conversation.create', title: 'Offline drafts', brief: 'Keep drafts.', checks: [{ description: 'Done', independent: false }], priority: 'P2', requestMessageId: asked }))
      .result.conversationId)
    const E = await s.add('Engineer', T)
    const reactions = async () => {
      const page = await store.messages(peer, s.tab, 'lead', {}) as unknown as { messages: Array<{ id: string; reactions: unknown }>; reactionSeq: number }
      return { on: page.messages.find(m => m.id === asked)!.reactions, seq: page.reactionSeq }
    }
    const before = await reactions()
    expect(before.on).toEqual([])
    const assignmentId = String((await s.as(P)({ type: 'work.assign', conversationId: T, agentId: E })).result.assignmentId)
    const started = await reactions()
    expect(started.on).toEqual([{ emoji: 'eyes', count: 1, by: [{ kind: 'agent', id: E }] }])
    expect(started.seq).toBeGreaterThan(before.seq)
    const pr = 'https://github.com/example/app/pull/7'
    await s.as(E)({ type: 'work.status', conversationId: T, assignmentId, status: 'done', result: `Checks passed: ${pr}` })
    await s.as(P)({ type: 'conversation.merged', conversationId: T, pullRequestUrl: pr })
    await s.as(P)({ type: 'conversation.merged', conversationId: T, pullRequestUrl: pr })
    expect((await reactions()).on).toEqual([{ emoji: 'eyes', count: 1, by: [{ kind: 'agent', id: E }] }, { emoji: 'check', count: 1, by: [{ kind: 'agent', id: E }] }])
    // Its author hears each as any reaction to their message (activity.ts).
    expect((await db.superTabActivity.findMany({ where: { tabId: s.tab, personId: peer.sub, kind: 'reaction', messageId: asked } }))
      .map(row => [row.actorId, row.emoji]).sort()).toEqual([[E, 'check'], [E, 'eyes']])
  })

  // Diego, 2026-11-04 (task #2693): a stop its host confirms is no command, so its thread kept saying On it.
  it('says Not building this in the thread once when the host confirms the stop', async () => {
    const s = await swarm()
    const P = await s.add('Coordinator', 'lead', true)
    const root = await s.ask('Can drafts survive a restart?')
    const T = String((await s.as(P)({ type: 'conversation.create', title: 'Offline drafts', brief: 'Keep drafts.', checks: [{ description: 'Done', independent: false }], priority: 'P2', requestMessageId: root }))
      .result.conversationId)
    const E = await s.add('Engineer', T)
    const assignmentId = String((await s.as(P)({ type: 'work.assign', conversationId: T, agentId: E })).result.assignmentId)
    await store.stopped(host, s.tab, assignmentId, 'fixture stop receipt')
    await store.stopped(host, s.tab, assignmentId, 'fixture stop receipt')
    const replies = (await store.messages(owner, s.tab, 'lead', { thread: root })).messages.filter(m => m.text.startsWith('Not building this'))
    expect(replies).toEqual([expect.objectContaining({ text: 'Not building this: The execution host confirmed that this harness stopped.',
      thread: root, replyTo: root, recipientIds: [], author: expect.objectContaining({ id: P }) })])
  })

  it('posts none for a task\'s steps', async () => {
    const s = await swarm()
    const P = await s.add('Coordinator', 'lead', true)
    const root = await s.ask('Can drafts survive a restart?')
    const T = String((await s.as(P)({ type: 'conversation.create', title: 'Offline drafts', brief: 'Keep drafts.', checks: [{ description: 'Done', independent: false }], priority: 'P2', requestMessageId: root }))
      .result.conversationId)
    const E = await s.add('Engineer', T)
    const assignmentId = String((await s.as(P)({ type: 'work.assign', conversationId: T, agentId: E })).result.assignmentId)
    await s.as(E)({ type: 'work.status', conversationId: T, assignmentId, status: 'review', result: 'Ready.' })
    const thread = async () => (await store.messages(owner, s.tab, 'lead', { thread: root })).messages.map(m => m.text)
    const before = await thread()
    const R = String((await s.as(E)({ type: 'conversation.create', title: 'Review', step: 'Review', reviewOf: T, brief: 'Review it.', checks: [] }))
      .result.conversationId)
    const V = await s.add('Reviewer', R)
    const reviewing = String((await s.as(E)({ type: 'work.assign', conversationId: R, agentId: V })).result.assignmentId)
    await s.as(V)({ type: 'work.status', conversationId: R, assignmentId: reviewing, status: 'done', result: 'Ready to merge: Yes.' })
    expect((await s.page('lead')).lines).toEqual([])
    expect(await thread()).toEqual(before)
  })

  it('shows a private project\'s task only to that project\'s readers, in its own chat\'s thread', async () => {
    const s = await swarm()
    const created = (await run(s.tab, { type: 'project.create', name: 'Secret', visibility: 'private', brief: '' })).result as { projectId: string; conversationId: string }
    const P = await s.add('Coordinator', created.conversationId, true)
    const root = await s.ask('Can we do the hidden work?', created.conversationId)
    const T = String((await s.as(P)({ type: 'conversation.create', title: 'Hidden work', brief: 'Quietly.', checks: [{ description: 'Done', independent: false }], priority: 'P2', requestMessageId: root })).result.conversationId)
    const E = await s.add('Engineer', T)
    const assignmentId = String((await s.as(P)({ type: 'work.assign', conversationId: T, agentId: E })).result.assignmentId)
    await s.as(E)({ type: 'work.status', conversationId: T, assignmentId, status: 'working', result: 'Started.' })

    const named = (await store.messages(owner, s.tab, created.conversationId, { thread: root })).messages.find(m => m.text === 'Hidden work')!
    expect(named).toMatchObject({ thread: root, replyTo: root })
    // A Swarm member outside the project: nothing on the chats they read, and neither the private chat nor the reply by id.
    expect((await s.page('lead', peer)).lines).toEqual([])
    await expect(store.messages(peer, s.tab, created.conversationId, {})).rejects.toThrow()
    await expect(store.messages(peer, s.tab, created.conversationId, { messageId: named.id })).rejects.toThrow()
    await expect(store.messages(peer, s.tab, 'lead', { messageId: named.id })).resolves.toMatchObject({ messages: [] })
  })
})
