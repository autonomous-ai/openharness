import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { MongoMemoryReplSet } from 'mongodb-memory-server-core'
import { PrismaClient } from '@prisma/client'
import type { AuthUser } from '../src/lib/ssoAuth.js'
import { SuperTabStore, type SuperTabStoreHooks } from '../src/superTabs/store.js'
import type { Command } from '../src/superTabs/commands.js'
import * as parts from '../src/superTabs/parts/index.js'
import type { SuperTabState } from '../src/superTabs/model.js'

// Task #4388 (found in the security review of #3497): the server read GitHub for a command (push origin, repository reach,
// pull request files, merges and heads) before it knew the caller may run it, so anyone signed in who knew a Swarm's ids
// could make it call GitHub, spend the app's rate limit and time its answers. A refused caller now makes no GitHub call.
let replica: MongoMemoryReplSet
let db: PrismaClient
const owner: AuthUser = { sub: '230000000000000000000001', email: 'owner@example.com', autonomousEnv: 'prod', role: 'user' }
const viewer: AuthUser = { sub: '230000000000000000000002', email: 'viewer@example.com', autonomousEnv: 'prod', role: 'user' }
const stranger: AuthUser = { sub: '230000000000000000000003', email: 'stranger@example.com', autonomousEnv: 'prod', role: 'user' }
const config = { engine: 'claude', model: 'opus', effort: 'high', contextWindow: 200000, engineVersion: 'fixture' }
const requirements = { memoryBytes: 0, diskBytes: 0, maxCpuPercent: 100, tools: [], devices: [], quotaRequired: false }
const REPO = 'https://github.com/acme/app'
const PR = `${REPO}/pull/7`
const RULE = 'A bug that reaches stable ships its fix the same day (owner, 2026-11-04).'
const doc = (...rules: string[]) => ['# Project instructions', '', '## Rules', '', ...rules.map(r => `- ${r}`)].join('\n')

beforeAll(async () => {
  replica = await MongoMemoryReplSet.create({ binary: { version: '7.0.24', downloadDir: join(tmpdir(), 'harness-super-tab-mongodb-binaries') },
    replSet: { count: 1, ip: '127.0.0.1', storageEngine: 'wiredTiger' } })
  const uri = replica.getUri(`swarm_github_callers_test_${randomUUID().replaceAll('-', '_')}`)
  await promisify(execFile)(join(process.cwd(), 'node_modules/.bin/prisma'), ['db', 'push', '--skip-generate'], {
    env: { ...process.env, DATABASE_URL: uri }, timeout: 60000,
  })
  db = new PrismaClient({ datasources: { db: { url: uri } } })
  for (const user of [owner, viewer, stranger]) await db.user.create({ data: { id: user.sub, externalId: `fixture-${user.sub}`, email: user.email, autonomousEnv: user.autonomousEnv } })
  await db.machine.create({ data: { machineId: 'owner-host', userId: owner.sub, apiKey: 'fixture-owner-host', managerId: 'fixture', autonomousEnv: 'prod', authMode: 'remote' } })
})
afterAll(async () => {
  await db?.$disconnect()
  await replica?.stop()
})

async function storedState(tab: string): Promise<SuperTabState> {
  return parts.reassemble(await db.$transaction(tx => parts.loadAll(tx, tab)))
}
async function saveState(tab: string, state: SuperTabState) {
  await db.$transaction(async tx => {
    const current = await parts.loadAll(tx, tab)
    const version = Math.max(current.head.version, ...[...current.members, ...current.agents, ...current.groups, ...current.machines,
      ...current.starts, ...current.progress].map(p => p.version)) + 1
    for (const model of [tx.swarmHead, tx.swarmMember, tx.swarmAgent, tx.swarmGroup, tx.swarmMachine, tx.swarmStart, tx.swarmProgress] as unknown as
      Array<{ deleteMany(args: unknown): Promise<unknown> }>) await model.deleteMany({ where: { tabId: tab } })
    await parts.insertParts(tx, { ...parts.split(state, { tabId: tab, version, now: Date.now(), visibilityEpoch: current.visibilityEpoch }),
      sequenceBase: current.sequenceBase })
  })
}

/** Every GitHub read the store makes before (and right after) a command, each a counter. */
function github() {
  const hooks = {
    pushOrigin: vi.fn(async () => 'clean' as const),
    branchPushOrigin: vi.fn(async () => 'clean' as const),
    repositoryReach: vi.fn(async () => undefined),
    pullRequestFiles: vi.fn(async (_repository: string | null, urls: string[]) => ({ urls, head: 'abc1234', files: ['docs/a.md'] })),
    pullRequestMerges: vi.fn(async () => ({})),
    pullRequestReader: vi.fn((): never => { throw new Error('GitHub is not reachable in this test') }),
  } satisfies SuperTabStoreHooks
  const calls = () => Object.values(hooks).reduce((sum, hook) => sum + hook.mock.calls.length, 0)
  return { hooks, calls }
}

/** A public Swarm on acme/app: a task with its Engineer, linking PR, carrying a rule of the instructions; a step of it; a
 *  viewer. Built by a store with no GitHub, so nothing here counts. */
async function swarm() {
  const setup = new SuperTabStore(db, Date.now, undefined, {})
  const tab = (await setup.create(owner, randomUUID(), 'Callers', 'public')).id
  const run = (command: Command, user = owner) => setup.execute(user, tab, { operationId: randomUUID(), command })
  const invitation = await run({ type: 'invite.create', email: viewer.email, role: 'viewer', conversationId: 'lead' })
  await run({ type: 'invite.accept', inviteId: invitation.result.inviteId as string }, viewer)
  const task = String((await run({ type: 'conversation.create', title: 'Stable fixes', brief: `Goal:\nSame-day fixes.\n\nChanges:\n- ${RULE}`, checks: [] })).result.conversationId)
  const dev = String((await run({ type: 'agent.add', conversationId: task, machineId: 'owner-host', harnessId: randomUUID(), name: 'Dev', configuration: config, lead: false })).result.agentId)
  const state = await storedState(tab)
  state.projects!.find(p => p.id === 'lead')!.repository = { machineId: 'owner-host', cwd: '/repo', repositoryUrl: REPO }
  Object.assign(state.conversations.find(c => c.id === task)!, { pullRequestUrls: [PR], codePullRequestUrls: [PR] })
  await saveState(tab, state)
  const assignmentId = String((await run({ type: 'work.assign', conversationId: task, agentId: dev })).result.assignmentId)
  const step = String((await run({ type: 'conversation.create', projectId: 'lead', title: 'Review', brief: `Review ${PR}`, reviewOf: task, step: 'Review', checks: [] })).result.conversationId)
  const stored = await db.superTabInstructions.findFirstOrThrow({ where: { tabId: tab, projectId: 'lead' } })
  await run({ type: 'instructions.save', projectId: 'lead', baseRevision: stored.revision, text: doc(RULE, 'Tests run first.'), summary: 'Rules.' })
  const revision = (await db.superTabInstructions.findFirstOrThrow({ where: { tabId: tab, projectId: 'lead' } })).revision
  const { hooks, calls } = github()
  const store = new SuperTabStore(db, Date.now, undefined, hooks)
  const execute = (user: AuthUser, command: Command, asAgentId?: string) => store.execute(user, tab, { operationId: randomUUID(), command }, asAgentId)
  /** Each command that reads GitHub before it runs, with the read it makes. */
  const commands: Array<{ name: string; command: Command; hook: keyof typeof hooks; asAgent?: true }> = [
    { name: 'work.assign', command: { type: 'work.assign', conversationId: step, agentId: dev }, hook: 'pushOrigin' },
    { name: 'work.assign reach', command: { type: 'work.assign', conversationId: step, agentId: dev }, hook: 'repositoryReach' },
    { name: 'work.teamWritten', command: { type: 'work.teamWritten', conversationId: task }, hook: 'pushOrigin' },
    { name: 'conversation.agent', command: { type: 'conversation.agent', conversationId: step, agentId: dev, present: true, lead: false }, hook: 'pushOrigin' },
    { name: 'work.check', command: { type: 'work.check', conversationId: task, assignmentId, checkId: 'check', passed: true, evidence: 'Read it.',
      head: 'a'.repeat(40) } as Command, hook: 'pullRequestReader' },
    { name: 'agent.start', command: { type: 'agent.start', request: { conversationId: step, machineId: 'owner-host', engine: 'claude', name: 'Reviewer',
      cwd: '/repo', worktree: true, branchRef: 'refs/heads/fix', requirements } } as Command, hook: 'branchPushOrigin' },
    { name: 'agent.start reach', command: { type: 'agent.start', request: { conversationId: step, machineId: 'owner-host', engine: 'claude', name: 'Reviewer',
      cwd: '/repo', worktree: true, requirements } } as Command, hook: 'repositoryReach' },
    { name: 'lead.start', command: { type: 'lead.start', projectId: 'lead', machineId: null, engine: 'claude', branchRef: 'refs/heads/fix' }, hook: 'branchPushOrigin' },
    { name: 'instructions.save', command: { type: 'instructions.save', projectId: 'lead', baseRevision: revision, text: doc('Tests run first.'),
      summary: 'Moved the stable rule to its task.' }, hook: 'pullRequestMerges' },
    // A Ready is its Engineer's: run last, as it opens steps.
    { name: 'work.status review', command: { type: 'work.status', conversationId: task, assignmentId, status: 'review', result: `Ready: ${PR}` },
      hook: 'pullRequestFiles', asAgent: true },
  ]
  return { tab, task, dev, hooks, calls, execute, commands }
}

describe('a command\'s GitHub reads', () => {
  it('make no GitHub call for a caller outside the Swarm or a viewer, who are refused as before', async () => {
    const f = await swarm()
    for (const { name, command } of f.commands) {
      for (const user of [stranger, viewer]) {
        await expect(f.execute(user, command), `${name} by ${user.email}`).rejects.toMatchObject({ status: expect.any(Number) })
      }
    }
    expect(Object.fromEntries(Object.entries(f.hooks).map(([name, hook]) => [name, hook.mock.calls.length]))).toEqual({
      pushOrigin: 0, branchPushOrigin: 0, repositoryReach: 0, pullRequestFiles: 0, pullRequestMerges: 0, pullRequestReader: 0 })
  })

  it('tell a stranger the same about a real task and a made-up one', async () => {
    const f = await swarm()
    const refusal = (conversationId: string) => f.execute(stranger, { type: 'work.assign', conversationId, agentId: f.dev })
      .then(() => null, (error: { code?: string; status?: number; message?: string }) => ({ code: error.code, status: error.status, message: error.message }))
    const real = await refusal(f.task)
    expect(real).not.toBeNull()
    expect(await refusal('missing-task')).toEqual(real)
    expect(f.calls()).toBe(0)
  })

  it('still read GitHub for a member\'s commands', async () => {
    const f = await swarm()
    for (const { name, command, hook, asAgent } of f.commands) {
      const before = f.hooks[hook].mock.calls.length
      // Whether the command then passes is its own business: only that it read GitHub first counts here.
      await f.execute(owner, command, asAgent ? f.dev : undefined).catch(() => undefined)
      expect(f.hooks[hook].mock.calls.length, name).toBeGreaterThan(before)
    }
  })
})
