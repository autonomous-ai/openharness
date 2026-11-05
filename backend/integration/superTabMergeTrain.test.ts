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
import { teamWrittenTask } from '../src/superTabs/teamWritten.js'

// Task #3402: the merge train reads its candidates from the Swarm, records each merge on its task with the original pull
// request's link (never the batch's), and tells a task's Engineer once per key. A fresh loopback replica set, created here.
let replica: MongoMemoryReplSet
let db: PrismaClient
const owner: AuthUser = { sub: '230000000000000000000001', email: 'owner@example.com', autonomousEnv: 'prod', role: 'user' }
const host: AuthUser = { sub: '230000000000000000000003', email: 'host@example.com', autonomousEnv: 'prod', role: 'user' }
const config = { engine: 'codex', model: 'fixture-model', effort: 'high', contextWindow: 200000, engineVersion: 'fixture' }

beforeAll(async () => {
  replica = await MongoMemoryReplSet.create({ binary: { version: '7.0.24', downloadDir: join(tmpdir(), 'harness-super-tab-mongodb-binaries') },
    replSet: { count: 1, ip: '127.0.0.1', storageEngine: 'wiredTiger' } })
  const uri = replica.getUri(`swarm_merge_train_test_${randomUUID().replaceAll('-', '_')}`)
  await promisify(execFile)(join(process.cwd(), 'node_modules/.bin/prisma'), ['db', 'push', '--skip-generate'], {
    env: { ...process.env, DATABASE_URL: uri }, timeout: 60000,
  })
  db = new PrismaClient({ datasources: { db: { url: uri } } })
  for (const user of [owner, host]) await db.user.create({ data: { id: user.sub, externalId: `fixture-${user.sub}`, email: user.email, autonomousEnv: user.autonomousEnv } })
  for (const machineId of ['lead-host', 'test-host']) {
    await db.machine.create({ data: { machineId, userId: host.sub, apiKey: `fixture-${machineId}`, managerId: 'fixture', autonomousEnv: 'prod', authMode: 'remote' } })
    await db.machineShare.create({ data: { machineId, ownerId: host.sub, autonomousEnv: 'prod', emails: [owner.email] } })
  }
})
afterAll(async () => {
  await db?.$disconnect()
  await replica?.stop()
})

let pullNumbers = 300

/** A Swarm on acme/app with a Lead, and a task with a review step, assigned to a worker that linked its pull request. */
async function swarm() {
  const number = ++pullNumbers, PR = `https://github.com/acme/app/pull/${number}`
  let now = Date.parse('2026-11-05T15:00:00.000Z')
  const store = new SuperTabStore(db, () => now)
  const tab = (await store.create(owner, randomUUID(), 'Train', 'public')).id
  const execute = (command: Command, user = owner, asAgentId?: string) => store.execute(user, tab, { operationId: randomUUID(), command }, asAgentId)
  const invitation = await execute({ type: 'invite.create', email: host.email, role: 'collaborator', conversationId: 'lead' })
  await execute({ type: 'invite.accept', inviteId: invitation.result.inviteId as string }, host)
  for (const [machineId, name] of [['lead-host', 'Lead Mac'], ['test-host', 'Worker Mac']]) {
    await execute({ type: 'machine.contribute', machineId: machineId!, name: name!, cwd: '/repo', engines: ['codex'], maxAgents: 4 }, host)
  }
  const add = async (conversationId: string, machineId: string, name: string, lead = false) => String((await execute({ type: 'agent.add',
    conversationId, machineId, harnessId: randomUUID(), name, configuration: config, lead })).result.agentId)
  await add('lead', 'lead-host', 'Lead', true)
  await execute({ type: 'tab.project', machineId: 'lead-host', project: { cwd: '/repo', repositoryUrl: null } })
  await execute({ type: 'project.repository', projectId: 'lead', repositoryUrl: 'https://github.com/acme/app' })
  const task = String((await execute({ type: 'conversation.create', title: 'Ship the parser', brief: 'Implement it', checks: [] })).result.conversationId)
  const worker = await add(task, 'test-host', 'Worker')
  const assignment = String((await execute({ type: 'work.assign', conversationId: task, agentId: worker })).result.assignmentId)
  await execute({ type: 'work.status', conversationId: task, assignmentId: assignment, status: 'review', result: `Ready ${PR}` }, host, worker)
  const step = String((await execute({ type: 'conversation.create', title: 'Review', brief: 'Read it', reviewOf: task, step: 'Review',
    checks: [{ description: 'Read', independent: true }] })).result.conversationId)
  return { PR, number, store, tab, execute, task, worker, step, clock: { get now() { return now }, advance(ms: number) { now += ms } } }
}

describe('the merge train in the Swarm', () => {
  it('lists the project\'s tasks with their own pull requests and steps', async () => {
    const f = await swarm()
    const projects = (await f.store.trainProjects(f.clock.now)).filter(p => p.tabId === f.tab)
    expect(projects).toHaveLength(1)
    expect(projects[0]).toMatchObject({ projectId: 'lead', ownerId: owner.sub, repositoryUrl: 'https://github.com/acme/app' })
    expect(projects[0]!.pulls.map(p => [p.taskId, p.url, p.task.steps.map(s => s.step)])).toEqual([[f.task, f.PR, ['Review']]])
  })

  it('records a merge with the original link, once, and marks nothing Team-written', async () => {
    const f = await swarm()
    const [project] = (await f.store.trainProjects(f.clock.now)).filter(p => p.tabId === f.tab)
    await f.store.trainMerged(project!, f.task, f.PR, f.clock.now - 1000)
    await f.store.trainMerged(project!, f.task, f.PR, f.clock.now - 1000)
    const state = (await f.store.read(owner, f.tab)).state
    const group = state.conversations.find(c => c.id === f.task)!
    expect(group.pullRequestUrls).toEqual([f.PR])
    expect(group.ledger?.shippedAt).toBeTypeOf('number')
    expect(group.teamWritten).toBeUndefined()
    expect(teamWrittenTask(state, group)).toBe(false)
    const merged = await db.superTabMessage.findMany({ where: { tabId: f.tab, conversationId: f.task, text: { startsWith: 'Merged ' } } })
    expect(merged.map(m => m.text)).toEqual([`Merged ${f.PR}`])
  })

  it('tells the task\'s Engineer once per key', async () => {
    const f = await swarm()
    expect(await f.store.trainTell(f.tab, f.task, `train-conflict:abc`, `Merge main once. ${f.PR}`)).toBe(true)
    expect(await f.store.trainTell(f.tab, f.task, `train-conflict:abc`, `Merge main once. ${f.PR}`)).toBe(false)
    const rows = await db.superTabMessage.findMany({ where: { tabId: f.tab, conversationId: f.task, text: { startsWith: 'Merge main once' } } })
    expect(rows.map(r => r.recipientIds)).toEqual([[f.worker]])
  })
})
