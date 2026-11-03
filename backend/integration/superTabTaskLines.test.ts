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

// Quiet Swarm 2/6 (task #2191; docs/plans/2026-11-02-quiet-swarm-task-line-plan.md): each task with an Engineer is one
// message in its project chat, edited in place as the task moves, none for its steps, and a private project's line only
// for that project's readers. Through the store and a fresh loopback replica set, as the people's apps read it.
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
    const operationId = randomUUID()
    const post = { operationId, command: { type: 'message.send' as const, conversationId: T, text: 'Please check the draft.', replyTo: null, recipientIds: [] } }
    await store.execute(host, s.tab, post, E)
    await store.execute(host, s.tab, post, E)
    const thread = await readThread()
    expect(thread.messages.filter(m => m.text === 'Please check the draft.')).toHaveLength(1)
    expect(thread.messages.filter(m => m.id !== root).every(m => m.thread === root && m.replyTo === root)).toBe(true)
    expect((await s.page('lead')).lines).toEqual(first.lines)
    const page = await store.messages(owner, s.tab, 'lead', {})
    expect(page.threads).toEqual(expect.arrayContaining([expect.objectContaining({ id: root, replies: thread.messages.length - 1 })]))
    const pr = 'https://github.com/example/app/pull/7'
    await s.as(E)({ type: 'work.status', conversationId: T, assignmentId, status: 'done', result: `Checks passed: ${pr}` })
    await s.as(P)({ type: 'conversation.merged', conversationId: T, pullRequestUrl: pr })
    await s.as(P)({ type: 'conversation.merged', conversationId: T, pullRequestUrl: pr })
    expect((await readThread()).messages.filter(m => m.text === `Merged ${pr}.`)).toHaveLength(1)
    expect((await s.page('lead')).lines).toEqual(first.lines)
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
