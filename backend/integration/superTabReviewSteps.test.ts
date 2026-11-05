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

// Task #3401: a task's Ready reads its pull request's files from GitHub, outside the command's transaction, and the server
// opens its review steps from them. A fresh loopback replica set, created here.
let replica: MongoMemoryReplSet
let db: PrismaClient
const owner: AuthUser = { sub: '220000000000000000000001', email: 'owner@example.com', autonomousEnv: 'prod', role: 'user' }
const host: AuthUser = { sub: '220000000000000000000003', email: 'host@example.com', autonomousEnv: 'prod', role: 'user' }
const opus = { engine: 'claude', model: 'opus', effort: 'high', contextWindow: 200000, engineVersion: 'fixture' }
const REPO = 'https://github.com/acme/app'

beforeAll(async () => {
  replica = await MongoMemoryReplSet.create({ binary: { version: '7.0.24', downloadDir: join(tmpdir(), 'harness-super-tab-mongodb-binaries') },
    replSet: { count: 1, ip: '127.0.0.1', storageEngine: 'wiredTiger' } })
  const uri = replica.getUri(`swarm_review_steps_test_${randomUUID().replaceAll('-', '_')}`)
  await promisify(execFile)(join(process.cwd(), 'node_modules/.bin/prisma'), ['db', 'push', '--skip-generate'], {
    env: { ...process.env, DATABASE_URL: uri }, timeout: 60000,
  })
  db = new PrismaClient({ datasources: { db: { url: uri } } })
  for (const user of [owner, host]) await db.user.create({ data: { id: user.sub, externalId: `fixture-${user.sub}`, email: user.email, autonomousEnv: user.autonomousEnv } })
  await db.machine.create({ data: { machineId: 'review-host', userId: host.sub, apiKey: 'fixture-review-host', managerId: 'fixture', autonomousEnv: 'prod', authMode: 'remote' } })
  await db.machineShare.create({ data: { machineId: 'review-host', ownerId: host.sub, autonomousEnv: 'prod', emails: [owner.email] } })
})
afterAll(async () => {
  await db?.$disconnect()
  await replica?.stop()
})

/** A Swarm whose project has a GitHub repository, a PM, a task with its Engineer, and two Reviewers. */
async function swarm(hooks: SuperTabStoreHooks) {
  const store = new SuperTabStore(db, Date.now, undefined, hooks)
  const tab = (await store.create(owner, randomUUID(), 'Reviews', 'public')).id
  const execute = (command: Command, user = owner, asAgentId?: string) => store.execute(user, tab, { operationId: randomUUID(), command }, asAgentId)
  const invitation = await execute({ type: 'invite.create', email: host.email, role: 'collaborator', conversationId: 'lead' })
  await execute({ type: 'invite.accept', inviteId: invitation.result.inviteId as string }, host)
  await execute({ type: 'machine.contribute', machineId: 'review-host', name: 'Review Mac', cwd: '/repo', engines: ['claude'], maxAgents: 8 }, host)
  const add = async (conversationId: string, name: string, lead = false, roleName?: string) => String((await execute({ type: 'agent.add',
    conversationId, machineId: 'review-host', harnessId: randomUUID(), name, configuration: opus, lead, ...roleName ? { roleName } : {} } as Command)).result.agentId)
  const lead = await add('lead', 'PM', true)
  const task = String((await execute({ type: 'conversation.create', title: 'Fix sign-in', brief: 'Sign in works offline.', checks: [] })).result.conversationId)
  const dev = await add(task, 'Dev', false, 'Engineer')
  const reviewers = [await add(task, 'Rev A', false, 'Reviewer'), await add(task, 'Rev B', false, 'Reviewer')]
  const assignment = String((await execute({ type: 'work.assign', conversationId: task, agentId: dev })).result.assignmentId)
  return { store, tab, execute, lead, task, dev, reviewers, assignment }
}

const stepsIn = async (tab: string, task: string) => (await db.swarmGroup.findMany({ where: { tabId: tab } }))
  .map(row => row.data as { reviewOf?: string; step?: string; assignment?: { agentId: string; status: string } | null })
  .filter(group => group.reviewOf === task)

describe('a Ready through the store', () => {
  it('reads the pull request\'s files and opens two security reviews for a sign-in change', async () => {
    const pullRequestFiles = vi.fn(async (_repository: string | null, urls: string[]) => ({ urls, head: 'abc1234', files: ['backend/src/routes/auth.ts'] }))
    const { tab, execute, task, dev, reviewers, assignment } = await swarm({ pullRequestFiles })
    await execute({ type: 'work.status', conversationId: task, assignmentId: assignment, status: 'review', result: `Ready: ${REPO}/pull/7` }, host, dev)
    expect(pullRequestFiles).toHaveBeenCalledWith(null, [`${REPO}/pull/7`])
    const steps = await stepsIn(tab, task)
    expect(steps.map(step => step.step).sort()).toEqual(['Security review 1', 'Security review 2'])
    expect(steps.map(step => step.assignment?.agentId).sort()).toEqual([...reviewers].sort())
  })

  it('opens nothing when the Ready names no pull request, and never reads for a step\'s Ready', async () => {
    const pullRequestFiles = vi.fn(async (_repository: string | null, urls: string[]) => ({ urls, head: 'abc1234', files: ['docs/a.md'] }))
    const { tab, execute, task, dev, assignment } = await swarm({ pullRequestFiles })
    await execute({ type: 'work.status', conversationId: task, assignmentId: assignment, status: 'review', result: 'Ready' }, host, dev)
    expect(pullRequestFiles).not.toHaveBeenCalled()
    expect(await stepsIn(tab, task)).toEqual([])
  })

  it('opens the strictest steps when the read throws, and the Ready still goes through', async () => {
    const pullRequestFiles = vi.fn(async () => { throw new Error('GitHub down') })
    const { tab, execute, task, dev, assignment } = await swarm({ pullRequestFiles })
    await execute({ type: 'work.status', conversationId: task, assignmentId: assignment, status: 'review', result: `Ready: ${REPO}/pull/7` }, host, dev)
    expect((await stepsIn(tab, task)).map(step => step.step).sort()).toEqual(['Security review 1', 'Security review 2'])
  })
})
