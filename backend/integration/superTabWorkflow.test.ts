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
import { activeWork, type SuperTabState } from '../src/superTabs/model.js'
import * as parts from '../src/superTabs/parts/index.js'

// Project instructions, phase 4 is done when the template's workflow runs end to end by agents alone (docs/plans/
// 2026-10-30-project-instructions-plan.md, task 14): an Engineer opens its own review and test, the Reviewer and the Tester
// check in parallel, findings go straight to the Engineer, and the coordinator hears only the statuses and the Engineer's one
// message, with nothing to do between "ready" and "passed". A fresh loopback replica set, created here.
let replica: MongoMemoryReplSet
let db: PrismaClient
let store: SuperTabStore
const owner: AuthUser = { sub: '140000000000000000000001', email: 'owner@example.com', autonomousEnv: 'prod', role: 'user' }
const host: AuthUser = { sub: '140000000000000000000003', email: 'host@example.com', autonomousEnv: 'prod', role: 'user' }
const config = { engine: 'codex', model: 'fixture-model', effort: 'high', contextWindow: 200000, engineVersion: 'fixture' }
const run = (tab: string, command: Command, user = owner, asAgentId?: string) =>
  store.execute(user, tab, { operationId: randomUUID(), command }, asAgentId)

beforeAll(async () => {
  replica = await MongoMemoryReplSet.create({ binary: { version: '7.0.24', downloadDir: join(tmpdir(), 'harness-super-tab-mongodb-binaries') },
    replSet: { count: 1, ip: '127.0.0.1', storageEngine: 'wiredTiger' } })
  const uri = replica.getUri(`workflow_test_${randomUUID().replaceAll('-', '_')}`)
  await promisify(execFile)(join(process.cwd(), 'node_modules/.bin/prisma'), ['db', 'push', '--skip-generate'], {
    env: { ...process.env, DATABASE_URL: uri }, timeout: 60000,
  })
  db = new PrismaClient({ datasources: { db: { url: uri } } })
  store = new SuperTabStore(db)
  for (const user of [owner, host]) await db.user.create({ data: { id: user.sub, externalId: `fixture-${user.sub}`,
    email: user.email, autonomousEnv: user.autonomousEnv } })
  await db.machine.create({ data: { machineId: 'test-host', userId: host.sub, apiKey: 'fixture-only', managerId: 'fixture',
    autonomousEnv: 'prod', authMode: 'remote' } })
  await db.machineShare.create({ data: { machineId: 'test-host', ownerId: host.sub, autonomousEnv: 'prod', emails: [owner.email] } })
})
afterAll(async () => {
  await db?.$disconnect()
  await replica?.stop()
})

describe('the template\'s workflow', () => {
  it('runs review and test in parallel with no coordinator action between ready and passed', async () => {
    const tab = (await store.create(owner, randomUUID(), 'Pilot')).id
    const add = async (name: string, lead: boolean, roleName?: string) => String((await run(tab, { type: 'agent.add', conversationId: 'lead',
      machineId: 'test-host', harnessId: randomUUID(), name, configuration: config, lead, ...(roleName ? { roleName } : {}) })).result.agentId)
    const P = await add('Coordinator', true), E = await add('Engineer', false, 'Engineer')
    const V = await add('Reviewer', false, 'Reviewer'), X = await add('Tester', false, 'Tester')
    const as = (agentId: string) => (command: Command) => run(tab, command, host, agentId)
    /** The Swarm as its parts hold it, bookkeeping included (a reader's view leaves the ledger out). */
    const state = async (): Promise<SuperTabState> => parts.reassemble(await db.$transaction(tx => parts.loadAll(tx, tab)))
    const task = async (id: string) => (await state()).conversations.find(c => c.id === id)!

    // The coordinator opens the task with its two checks and assigns the Engineer.
    const T = String((await as(P)({ type: 'conversation.create', title: 'Offline drafts', brief: 'Keep drafts across a restart.',
      checks: [{ description: 'Review passes', independent: false }, { description: 'Test passes', independent: false }] })).result.conversationId)
    const assignment = String((await as(P)({ type: 'work.assign', conversationId: T, agentId: E })).result.assignmentId)
    const [review, test] = (await task(T)).checks
    expect([review!.description, test!.description]).toEqual(['Review passes', 'Test passes'])
    const before = new Set((await db.superTabDelivery.findMany({ where: { tabId: tab, agentId: P }, select: { id: true } })).map(d => d.id))

    // From "ready" to "passed", only the Engineer, the Reviewer and the Tester act.
    await as(E)({ type: 'work.status', conversationId: T, assignmentId: assignment, status: 'review',
      result: 'Ready for review: https://github.com/example/project/pull/12 at abc1234.' })
    const R = String((await as(E)({ type: 'conversation.create', title: 'Review: Offline drafts', brief: 'Review PR #12.', reviewOf: T,
      checks: [] })).result.conversationId)
    const S = String((await as(E)({ type: 'conversation.create', title: 'Test: Offline drafts', brief: 'Test PR #12 on a Mac.', reviewOf: T,
      checks: [] })).result.conversationId)
    const reviewing = String((await as(E)({ type: 'work.assign', conversationId: R, agentId: V })).result.assignmentId)
    const testing = String((await as(E)({ type: 'work.assign', conversationId: S, agentId: X })).result.assignmentId)
    const asked = String((await as(E)({ type: 'message.send', conversationId: T, text: 'PR #12 is ready: please review and test it.',
      replyTo: null, recipientIds: [V, X] })).result.messageId)
    await as(V)({ type: 'work.check', conversationId: T, assignmentId: assignment, checkId: review!.id, passed: false,
      evidence: 'Finding: a draft saved while offline is lost when the app restarts.' })
    const finding = String((await as(V)({ type: 'message.send', conversationId: T, text: 'One finding: offline drafts are lost on restart.',
      replyTo: null, recipientIds: [E] })).result.messageId)
    await as(E)({ type: 'message.send', conversationId: T, text: 'Fixed in abc1235: drafts are written before the app quits.',
      replyTo: null, recipientIds: [V] })
    await as(V)({ type: 'work.check', conversationId: T, assignmentId: assignment, checkId: review!.id, passed: true,
      evidence: 'Ready: yes at abc1235. The finding is fixed.' })
    await as(X)({ type: 'work.check', conversationId: T, assignmentId: assignment, checkId: test!.id, passed: true,
      evidence: 'Built abc1235 on a Mac, saved a draft offline, restarted: the draft is there.' })
    // Review and test ran side by side: both linked tasks were still open when the last check passed.
    expect(activeWork(await task(R))).toBe(true)
    expect(activeWork(await task(S))).toBe(true)
    await as(V)({ type: 'work.status', conversationId: R, assignmentId: reviewing, status: 'done', result: 'Review passed at abc1235.' })
    await as(X)({ type: 'work.status', conversationId: S, assignmentId: testing, status: 'done', result: 'Test passed at abc1235.' })
    const told = String((await as(E)({ type: 'message.send', conversationId: T, text: 'Review and test passed.', replyTo: null, recipientIds: [P] }))
      .result.messageId)

    // The checks were passed by the Reviewer and the Tester, and both verdicts count as reviews of the Engineer's attempt.
    const checks = (await task(T)).checks
    expect(checks.map(c => [c.description, c.passedBy])).toEqual([['Review passes', `agent:${V}`], ['Test passes', `agent:${X}`]])
    expect(((await task(T)).ledger?.reviews ?? []).reduce((n, r) => n + r.count, 0)).toBe(2)

    // The coordinator heard the statuses and the Engineer's one message to it, never the messages between the three.
    const window = (await db.superTabDelivery.findMany({ where: { tabId: tab, agentId: P } })).filter(d => !before.has(d.id))
    const heard = await db.superTabMessage.findMany({ where: { id: { in: window.map(d => d.messageId) } } })
    expect(heard.length).toBeGreaterThan(0)
    for (const m of heard) expect(/^(Ready for review|Done)\b/.test(m.text) || m.id === told, m.text).toBe(true)
    expect(heard.map(m => m.id)).toContain(told)
    expect(heard.map(m => m.id)).not.toContain(asked)
    expect(heard.map(m => m.id)).not.toContain(finding)
    // Each message reached whom it named: the Reviewer and the Tester the Engineer's request, the Engineer the finding.
    const reached = async (messageId: string) => (await db.superTabDelivery.findMany({ where: { tabId: tab, messageId } })).map(d => d.agentId).sort()
    expect(await reached(asked)).toEqual([V, X].sort())
    expect(await reached(finding)).toEqual([E])
    expect(await reached(told)).toEqual([P])
  })
})
