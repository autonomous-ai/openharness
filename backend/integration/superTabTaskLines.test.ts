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

// Plain chat (task #2294; docs/plans/2026-11-03-plain-chat-work-plan.md): each task is one ordinary "Let's build" message in
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
  return { tab, add, as, page }
}

describe('a task\'s one message in its project chat', () => {
  it('opens one immutable ordinary root, then records details and updates as normal thread replies', async () => {
    const s = await swarm()
    const P = await s.add('Coordinator', 'lead', true)
    const T = String((await s.as(P)({ type: 'conversation.create', title: 'Offline drafts', requesterId: owner.sub, brief: 'Keep drafts.', checks: [] })).result.conversationId)
    const first = await s.page('lead')
    expect(first.lines).toEqual([expect.objectContaining({ text: "Let's build: Offline drafts", recipientIds: [] })])
    const root = first.lines[0]!.id
    const readThread = () => store.messages(owner, s.tab, 'lead', { thread: root })
    expect((await readThread()).messages.map(m => m.text)).toEqual(["Let's build: Offline drafts", 'Keep drafts.'])
    const E = await s.add('Engineer', T)
    const assignmentId = String((await s.as(P)({ type: 'work.assign', conversationId: T, agentId: E })).result.assignmentId)
    await s.as(E)({ type: 'work.status', conversationId: T, assignmentId, status: 'working', result: 'Started.' })
    const beforeRepeated = (await readThread()).messages.length
    await s.as(E)({ type: 'work.status', conversationId: T, assignmentId, status: 'working', result: 'Halfway.' })
    expect((await readThread()).messages).toHaveLength(beforeRepeated)
    // An agent's own post stays in its task's conversation.
    await s.as(E)({ type: 'message.send', conversationId: T, text: 'Please check the draft.', replyTo: null, recipientIds: [] })
    const pr = 'https://github.com/example/app/pull/7'
    await s.as(E)({ type: 'work.status', conversationId: T, assignmentId, status: 'review', result: `Ready: ${pr}` })
    await s.as(E)({ type: 'work.status', conversationId: T, assignmentId, status: 'done', result: `Checks passed: ${pr}` })
    await s.as(P)({ type: 'conversation.merged', conversationId: T, pullRequestUrl: pr })
    await s.as(P)({ type: 'conversation.merged', conversationId: T, pullRequestUrl: pr })
    const thread = await readThread()
    expect(thread.messages.map(m => m.text)).toEqual(["Let's build: Offline drafts", 'Keep drafts.', expect.stringMatching(/^On it: \S+ is building it\.$/),
      'Ready for review: PR #7', 'Merged: PR #7. Ships in the next release.'])
    expect(thread.messages.filter(m => m.id !== root).every(m => m.thread === root && m.replyTo === root && (m.author as { id: string }).id === P
      && m.recipientIds.length === 0)).toBe(true)
    expect(await db.superTabDelivery.count({ where: { tabId: s.tab, messageId: { in: thread.messages.map(m => m.id) } } })).toBe(0)
    expect((await s.page('lead')).lines).toEqual(first.lines)
    const page = await store.messages(owner, s.tab, 'lead', {})
    expect(page.threads).toEqual(expect.arrayContaining([expect.objectContaining({ id: root, replies: thread.messages.length - 1 })]))
  })

  it('keeps a person\'s own chat message as the task\'s root, and refuses any other message', async () => {
    const s = await swarm()
    const P = await s.add('Coordinator', 'lead', true)
    const asked = String((await run(s.tab, { type: 'message.send', conversationId: 'lead', text: 'Can the phone show who answered?', replyTo: null,
      recipientIds: [] }, peer)).result.messageId)
    const T = String((await s.as(P)({ type: 'conversation.create', title: 'Phone shows who answered', brief: 'Show who answered.', checks: [],
      requestMessageId: asked })).result.conversationId)
    expect((await s.page('lead')).lines).toEqual([])
    expect((await store.read(owner, s.tab)).state.conversations.find(c => c.id === T)?.requesterId).toBe(peer.sub)
    const E = await s.add('Engineer', T)
    await s.as(P)({ type: 'work.assign', conversationId: T, agentId: E })
    expect((await store.messages(owner, s.tab, 'lead', { thread: asked })).messages.map(m => m.text))
      .toEqual(['Can the phone show who answered?', expect.stringMatching(/^On it: \S+ is building it\.$/)])
    const inTask = String((await run(s.tab, { type: 'message.send', conversationId: T, text: 'Also Desktop?', replyTo: null, recipientIds: [] })).result.messageId)
    await expect(s.as(P)({ type: 'conversation.create', title: 'Another', brief: '', checks: [], requestMessageId: inTask })).rejects.toThrow('own message')
    await expect(s.as(P)({ type: 'conversation.create', title: 'Another', brief: '', checks: [], requestMessageId: 'missing' })).rejects.toThrow('own message')
  })

  it('posts none for a task\'s steps', async () => {
    const s = await swarm()
    const P = await s.add('Coordinator', 'lead', true)
    const T = String((await s.as(P)({ type: 'conversation.create', title: 'Offline drafts', brief: 'Keep drafts.', checks: [] })).result.conversationId)
    const E = await s.add('Engineer', T)
    const assignmentId = String((await s.as(P)({ type: 'work.assign', conversationId: T, agentId: E })).result.assignmentId)
    await s.as(E)({ type: 'work.status', conversationId: T, assignmentId, status: 'review', result: 'Ready.' })
    const R = String((await s.as(E)({ type: 'conversation.create', title: 'Review', step: 'Review', reviewOf: T, brief: 'Review it.', checks: [] }))
      .result.conversationId)
    const V = await s.add('Reviewer', R)
    const reviewing = String((await s.as(E)({ type: 'work.assign', conversationId: R, agentId: V })).result.assignmentId)
    await s.as(V)({ type: 'work.status', conversationId: R, assignmentId: reviewing, status: 'done', result: 'Ready to merge: Yes.' })
    const { lines } = await s.page('lead')
    expect(lines.map(l => [l.source?.taskId, l.text])).toEqual([[T, "Let's build: Offline drafts"]])
  })

  it('shows a private project\'s task line only to that project\'s readers', async () => {
    const s = await swarm()
    const created = (await run(s.tab, { type: 'project.create', name: 'Secret', visibility: 'private', brief: '' })).result as { projectId: string; conversationId: string }
    const P = await s.add('Coordinator', created.conversationId, true)
    const T = String((await s.as(P)({ type: 'conversation.create', title: 'Hidden work', brief: 'Quietly.', checks: [] })).result.conversationId)
    const E = await s.add('Engineer', T)
    const assignmentId = String((await s.as(P)({ type: 'work.assign', conversationId: T, agentId: E })).result.assignmentId)
    await s.as(E)({ type: 'work.status', conversationId: T, assignmentId, status: 'working', result: 'Started.' })

    const mine = await s.page(created.conversationId)
    expect(mine.lines.map(l => [l.source?.taskId, l.text])).toEqual([[T, "Let's build: Hidden work"]])
    const lineId = mine.lines[0]!.id
    // A Swarm member outside the project: no line on the chats they read, and neither the private chat nor the line by id.
    expect((await s.page('lead', peer)).lines).toEqual([])
    await expect(store.messages(peer, s.tab, created.conversationId, {})).rejects.toThrow()
    await expect(store.messages(peer, s.tab, created.conversationId, { messageId: lineId })).rejects.toThrow()
    await expect(store.messages(peer, s.tab, 'lead', { messageId: lineId })).resolves.toMatchObject({ messages: [] })
  })
})
