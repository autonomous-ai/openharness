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
import { watchPullRequests, type PullRequestReader, type PullRequestWatch } from '../src/superTabs/pullRequestEvents.js'

// Dee, #1891: GitHub events on an open task's pull request reach the task's Engineer directly, once, without waiting for
// the PM's sync. A fresh loopback replica set, created here.
let replica: MongoMemoryReplSet
let db: PrismaClient
const owner: AuthUser = { sub: '210000000000000000000001', email: 'owner@example.com', autonomousEnv: 'prod', role: 'user' }
const host: AuthUser = { sub: '210000000000000000000003', email: 'host@example.com', autonomousEnv: 'prod', role: 'user' }
const config = { engine: 'codex', model: 'fixture-model', effort: 'high', contextWindow: 200000, engineVersion: 'fixture' }
const PR = 'https://github.com/acme/app/pull/12'
const HEAD = 'abc1234def5678'
const MINUTE = 60_000

beforeAll(async () => {
  replica = await MongoMemoryReplSet.create({ binary: { version: '7.0.24', downloadDir: join(tmpdir(), 'harness-super-tab-mongodb-binaries') },
    replSet: { count: 1, ip: '127.0.0.1', storageEngine: 'wiredTiger' } })
  const uri = replica.getUri(`swarm_pr_events_test_${randomUUID().replaceAll('-', '_')}`)
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

/** What a fake GitHub says of each pull request, which a test changes between passes, and which URLs a pass asked about. */
function fakeReader() {
  const pulls = new Map<string, PullRequestWatch>()
  const asked: string[] = []
  const reader: PullRequestReader = {
    watch: async url => { asked.push(url); return pulls.get(url) ?? null },
    botLogin: async () => 'harness[bot]',
    done: async () => {},
  }
  return { pulls, asked, reader }
}
const pull = (patch: Partial<PullRequestWatch> = {}): PullRequestWatch => ({ url: PR, number: 12, state: 'open', draft: false, head: HEAD, base: 'main',
  mergeable: true, checkRuns: [], checkSuites: [], reviews: [], comments: [], ...patch })

/** A Swarm with a Lead and a task, "Ship the parser", assigned to a worker that linked [PR] in its status. */
async function swarm() {
  let now = Date.parse('2026-11-03T08:00:00.000Z')
  const store = new SuperTabStore(db, () => now)
  const tab = (await store.create(owner, randomUUID(), 'Events', 'public')).id
  const execute = (command: Command, user = owner, asAgentId?: string) => store.execute(user, tab, { operationId: randomUUID(), command }, asAgentId)
  const invitation = await execute({ type: 'invite.create', email: host.email, role: 'collaborator', conversationId: 'lead' })
  await execute({ type: 'invite.accept', inviteId: invitation.result.inviteId as string }, host)
  for (const [machineId, name] of [['lead-host', 'Lead Mac'], ['test-host', 'Worker Mac']]) {
    await execute({ type: 'machine.contribute', machineId: machineId!, name: name!, cwd: '/repo', engines: ['codex'], maxAgents: 4 }, host)
  }
  const add = async (conversationId: string, machineId: string, name: string, lead = false) => String((await execute({ type: 'agent.add',
    conversationId, machineId, harnessId: randomUUID(), name, configuration: config, lead })).result.agentId)
  const lead = await add('lead', 'lead-host', 'Lead', true)
  const task = String((await execute({ type: 'conversation.create', title: 'Ship the parser', brief: 'Implement it',
    checks: [{ description: 'Verified', independent: false }] })).result.conversationId)
  const worker = await add(task, 'test-host', 'Worker')
  const assignment = String((await execute({ type: 'work.assign', conversationId: task, agentId: worker })).result.assignmentId)
  await execute({ type: 'work.status', conversationId: task, assignmentId: assignment, status: 'working', result: `Draft ${PR}` }, host, worker)
  const { pulls, asked, reader } = fakeReader()
  const pass = async () => { now += MINUTE; return watchPullRequests(db, store, reader, now) }
  /** The rows this feature wrote in [conversationId], oldest first. */
  const told = async (conversationId = task) => (await db.superTabMessage.findMany({ where: { tabId: tab, conversationId }, orderBy: { sequence: 'asc' } }))
    .filter(m => m.text.includes(PR) && m.text !== `Draft ${PR}`)
  return { store, tab, execute, add, lead, task, worker, assignment, pulls, asked, pass, told, clock: { get now() { return now } } }
}

describe('pull request events', () => {
  it('CI red, CI green, a review and a conflict each post one message to the Engineer', async () => {
    const f = await swarm()
    f.pulls.set(PR, pull())
    await f.pass()
    expect(await f.told()).toEqual([])
    f.pulls.set(PR, pull({ checkRuns: [{ name: 'build (ubuntu)', status: 'completed', conclusion: 'failure', completedAt: f.clock.now + 10_000 }] }))
    expect(await f.pass()).toBe(1)
    const head2 = 'fedcba9876543'
    f.pulls.set(PR, pull({ head: head2, checkRuns: [{ name: 'build (ubuntu)', status: 'completed', conclusion: 'success', completedAt: f.clock.now + 10_000 }],
      checkSuites: [{ status: 'completed', runs: 1 }] }))
    expect(await f.pass()).toBe(1)
    f.pulls.set(PR, pull({ head: head2, mergeable: false, checkRuns: [{ name: 'build (ubuntu)', status: 'completed', conclusion: 'success', completedAt: f.clock.now }],
      checkSuites: [{ status: 'completed', runs: 1 }], reviews: [{ id: 7, login: 'huy', state: 'CHANGES_REQUESTED', body: 'Keep the arrow.', url: `${PR}#pullrequestreview-7` }] }))
    expect(await f.pass()).toBe(2)
    const rows = await f.told()
    expect(rows.map(r => r.text)).toEqual([
      `CI failed on your pull request #12 (head abc1234): build (ubuntu). ${PR}`,
      `CI passed on your pull request #12 (head fedcba9). ${PR}`,
      `Your pull request #12 has a merge conflict with main (head fedcba9): merge main into its branch and push. ${PR}`,
      `huy asked for changes on your pull request #12: "Keep the arrow." ${PR}#pullrequestreview-7`,
    ])
    for (const row of rows) expect(row.recipientIds).toEqual([f.worker])
    // Each reaches the Engineer's host as any message to it does.
    expect(await db.superTabDelivery.count({ where: { tabId: f.tab, agentId: f.worker, messageId: { in: rows.map(r => r.id) } } })).toBe(4)
  })

  it('a second pass and a retried write post nothing', async () => {
    const f = await swarm()
    f.pulls.set(PR, pull())
    await f.pass()
    const red = pull({ checkRuns: [{ name: 'build', status: 'completed', conclusion: 'failure', completedAt: f.clock.now + 10_000 }] })
    f.pulls.set(PR, red)
    expect(await f.pass()).toBe(1)
    expect(await f.pass()).toBe(0)
    // The same write sent again, as a retry would: the group already holds its key.
    expect(await f.store.pullRequestSeen(f.tab, f.task, red, 'harness[bot]')).toBe(0)
    expect(await f.told()).toHaveLength(1)
  })

  it('no Engineer: recorded, not posted, and a later Engineer hears only what is new', async () => {
    const f = await swarm()
    f.pulls.set(PR, pull())
    await f.pass()
    await f.execute({ type: 'agent.remove', agentId: f.worker })
    f.pulls.set(PR, pull({ mergeable: false }))
    expect(await f.pass()).toBe(0)
    expect(await f.told()).toEqual([])
    const next = await f.add(f.task, 'test-host', 'Second')
    await f.execute({ type: 'work.assign', conversationId: f.task, agentId: next })
    f.pulls.set(PR, pull({ mergeable: false, comments: [{ id: 9, login: 'dee', body: 'Please rebase', url: `${PR}#issuecomment-9` }] }))
    expect(await f.pass()).toBe(1)
    expect((await f.told()).map(r => [r.text, r.recipientIds])).toEqual([[`dee commented on your pull request #12: "Please rebase" ${PR}#issuecomment-9`, [next]]])
  })

  it('a step and a finished task are not read', async () => {
    const f = await swarm()
    const other = 'https://github.com/acme/app/pull/13'
    await f.execute({ type: 'conversation.create', title: 'Review', reviewOf: f.task, step: 'Review', brief: `Review ${other}`,
      checks: [{ description: 'Verdict', independent: false }] } as Command)
    await f.execute({ type: 'work.status', conversationId: f.task, assignmentId: f.assignment, status: 'done', result: `Done ${PR}` }, host, f.worker)
    await f.pass()
    expect(f.asked).toEqual([])
  })
})
