import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { MongoMemoryReplSet } from 'mongodb-memory-server-core'
import { PrismaClient } from '@prisma/client'
import type { AuthUser } from '../src/lib/ssoAuth.js'
import { SuperTabStore } from '../src/superTabs/store.js'
import type { Command } from '../src/superTabs/commands.js'
import { watchPullRequests, type PullRequestReader, type PullRequestWatch } from '../src/superTabs/pullRequestEvents.js'
import { logger } from '../src/utils/logger.js'

// Dee, #1891: GitHub events on an open task's pull request reach the task's Engineer directly, once, without waiting for
// the PM's sync. A fresh loopback replica set, created here.
let replica: MongoMemoryReplSet
let db: PrismaClient
const owner: AuthUser = { sub: '210000000000000000000001', email: 'owner@example.com', autonomousEnv: 'prod', role: 'user' }
const host: AuthUser = { sub: '210000000000000000000003', email: 'host@example.com', autonomousEnv: 'prod', role: 'user' }
const config = { engine: 'codex', model: 'fixture-model', effort: 'high', contextWindow: 200000, engineVersion: 'fixture' }
const HEAD = 'abc1234def5678abc1234def5678abc1234def56'
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
  /** Each pull request's patch id, by head: what its files read at that head (pullRequestPatch.ts). */
  const patches = new Map<string, string>()
  const patchReads: string[] = []
  const reader: PullRequestReader = {
    watch: async url => { asked.push(url); return pulls.get(url) ?? null },
    patch: async (url, head) => { patchReads.push(`${url}@${head}`); return patches.get(head) ?? null },
    botLogin: async () => 'harness[bot]',
    done: async () => {},
  }
  return { pulls, asked, patches, patchReads, reader }
}
/** Each Swarm's own pull request: a pass reads every Swarm in this database, and the others' are not this fake's. */
let pullNumbers = 100

/** A Swarm with a Lead and a task, "Ship the parser", assigned to a worker that linked [PR] in its status. */
async function swarm() {
  const number = ++pullNumbers, PR = `https://github.com/acme/app/pull/${number}`
  const pull = (patch: Partial<PullRequestWatch> = {}): PullRequestWatch => ({ url: PR, number, state: 'open', draft: false, head: HEAD, base: 'main',
    mergeable: true, checkRuns: [], checkSuites: [], reviews: [], comments: [], ...patch })
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
  const { pulls, asked, patches, patchReads, reader } = fakeReader()
  const pass = async () => { now += MINUTE; return watchPullRequests(db, store, reader, now) }
  /** The rows this feature wrote in [conversationId], oldest first. */
  const told = async (conversationId = task) => (await db.superTabMessage.findMany({ where: { tabId: tab, conversationId }, orderBy: { sequence: 'asc' } }))
    .filter(m => m.recipientIds.length > 0 && m.text.includes(PR))
  return { PR, number, pull, store, tab, execute, add, lead, task, worker, assignment, pulls, asked, patches, patchReads, reader, pass, told, clock: { get now() { return now }, advance(ms: number) { now += ms } } }
}

describe('pull request events', () => {
  it('CI red, CI green, a review and a conflict each post one message to the Engineer', async () => {
    const f = await swarm()
    f.pulls.set(f.PR, f.pull())
    await f.pass()
    expect(await f.told()).toEqual([])
    f.pulls.set(f.PR, f.pull({ checkRuns: [{ name: 'build (ubuntu)', status: 'completed', conclusion: 'failure', completedAt: f.clock.now + 10_000 }] }))
    expect(await f.pass()).toBe(1)
    const head2 = 'fedcba9876543'
    f.pulls.set(f.PR, f.pull({ head: head2, checkRuns: [{ name: 'build (ubuntu)', status: 'completed', conclusion: 'success', completedAt: f.clock.now + 10_000 }],
      checkSuites: [{ status: 'completed', runs: 1 }] }))
    expect(await f.pass()).toBe(1)
    f.pulls.set(f.PR, f.pull({ head: head2, mergeable: false, checkRuns: [{ name: 'build (ubuntu)', status: 'completed', conclusion: 'success', completedAt: f.clock.now }],
      checkSuites: [{ status: 'completed', runs: 1 }], reviews: [{ id: 7, login: 'huy', association: 'MEMBER', state: 'CHANGES_REQUESTED', body: 'Keep the arrow.', url: `${f.PR}#pullrequestreview-7` }] }))
    expect(await f.pass()).toBe(2)
    const rows = await f.told()
    expect(rows.map(r => r.text)).toEqual([
      `CI failed on your pull request #${f.number} (head abc1234): build (ubuntu). ${f.PR}`,
      `CI passed on your pull request #${f.number} (head fedcba9). ${f.PR}`,
      `Your pull request #${f.number} has a merge conflict with main (head fedcba9): merge main into its branch and push. ${f.PR}`,
      `huy asked for changes on your pull request #${f.number}: "Keep the arrow." ${f.PR}#pullrequestreview-7`,
    ])
    for (const row of rows) expect(row.recipientIds).toEqual([f.worker])
    // Each reaches the Engineer's host as any message to it does.
    expect(await db.superTabDelivery.count({ where: { tabId: f.tab, agentId: f.worker, messageId: { in: rows.map(r => r.id) } } })).toBe(4)
  })

  it('a second pass and a retried write post nothing', async () => {
    const f = await swarm()
    f.pulls.set(f.PR, f.pull())
    await f.pass()
    const red = f.pull({ checkRuns: [{ name: 'build', status: 'completed', conclusion: 'failure', completedAt: f.clock.now + 10_000 }] })
    f.pulls.set(f.PR, red)
    expect(await f.pass()).toBe(1)
    expect(await f.pass()).toBe(0)
    // The same write sent again, as a retry would: the group already holds its key.
    expect(await f.store.pullRequestSeen(f.tab, f.task, red, 'harness[bot]')).toBe(0)
    expect(await f.told()).toHaveLength(1)
  })

  it('no Engineer: recorded, not posted, so a later one hears only what is new', async () => {
    const f = await swarm()
    f.pulls.set(f.PR, f.pull())
    await f.pass()
    await f.execute({ type: 'agent.remove', agentId: f.worker })
    f.pulls.set(f.PR, f.pull({ mergeable: false }))
    expect(await f.pass()).toBe(0)
    expect(await f.told()).toEqual([])
    // What the task's next Engineer will not be told again.
    const row = await db.swarmGroup.findFirstOrThrow({ where: { tabId: f.tab, key: f.task } })
    expect((row.data as { pullRequestEvents?: Record<string, string[]> }).pullRequestEvents?.[f.PR]).toContain(`conflict:${HEAD}`)
  })

  it('a step and a finished task are not read', async () => {
    const f = await swarm()
    const other = 'https://github.com/acme/app/pull/13'
    await f.execute({ type: 'conversation.create', title: 'Review', reviewOf: f.task, step: 'Review', brief: `Review ${other}`,
      checks: [{ description: 'Verdict', independent: false }] } as Command)
    await f.execute({ type: 'work.status', conversationId: f.task, assignmentId: f.assignment, status: 'done', result: `Done ${f.PR}` }, host, f.worker)
    await f.pass()
    // Other tests' Swarms are in this database too: this one's pull requests are the ones not asked about.
    expect(f.asked).not.toContain(f.PR)
    expect(f.asked).not.toContain(other)
  })

  // ENGINEERING.md 4: no loop grows without a bound. A pass reads a capped number of tasks, the most recently active first.
  it('reads at most its cap of tasks a pass, the most recently active first', async () => {
    const f = await swarm()
    f.pulls.set(f.PR, f.pull())
    // Other tests' tasks are in this database too: this one is made the most recently active.
    f.clock.advance(60 * MINUTE)
    await f.execute({ type: 'work.status', conversationId: f.task, assignmentId: f.assignment, status: 'working', result: `Still on ${f.PR}` }, host, f.worker)
    await watchPullRequests(db, f.store, f.reader, f.clock.now + MINUTE, 1)
    expect(f.asked).toEqual([f.PR])
  })

  // ENGINEERING.md 6 and 8: a pull request GitHub cannot read is not skipped in silence, and each pass that did something
  // says how much.
  it('says how many pull requests it could not read', async () => {
    const f = await swarm()
    const warn = vi.spyOn(logger, 'warn')
    try {
      await f.pass()
      expect(warn).toHaveBeenCalledWith('[swarm-pr-events] pass', expect.objectContaining({ unreadable: expect.any(Number), posted: 0 }))
      const line = warn.mock.calls.find(call => call[0] === '[swarm-pr-events] pass')![1] as { unreadable: number; pulls: number; groups: number }
      expect(line.unreadable).toBeGreaterThanOrEqual(1)
      expect(line.pulls).toBeGreaterThanOrEqual(line.unreadable)
    } finally { warn.mockRestore() }
  })

  // Dee, #3394: a verdict counts only at the head it read, or a head whose patch is the same.
  describe('a verdict at a head', () => {
    const reviewed = async () => {
      const f = await swarm()
      const HEAD2 = 'bbbbbbb2222222bbbbbbb2222222bbbbbbb22222', HEAD3 = 'ccccccc3333333ccccccc3333333ccccccc33333'
      f.patches.set(HEAD, 'p1').set(HEAD2, 'p1').set(HEAD3, 'p2')
      f.pulls.set(f.PR, f.pull())
      await f.pass()
      // A Reviewer passes the task's check; a Tester passes its own step's.
      const reviewer = await f.add(f.task, 'test-host', 'Reviewer'), tester = await f.add(f.task, 'test-host', 'Tester')
      const step = String((await f.execute({ type: 'conversation.create', title: 'Test', reviewOf: f.task, step: 'Test', brief: 'Test it',
        checks: [{ description: 'Signs in', independent: true }] } as Command, host, f.worker)).result.conversationId)
      await f.execute({ type: 'conversation.agent', conversationId: step, agentId: tester, present: true, lead: false })
      const stepWork = String((await f.execute({ type: 'work.assign', conversationId: step, agentId: tester }, host, f.worker)).result.assignmentId)
      const group = async (key: string) => (await db.swarmGroup.findFirstOrThrow({ where: { tabId: f.tab, key } })).data as unknown as
        { checks: Array<{ id: string; passedBy: string | null; verdicts?: Array<{ head?: string; patch?: string; stale?: string }> }> }
      const taskCheck = (await group(f.task)).checks[0]!.id, stepCheck = (await group(step)).checks[0]!.id
      await f.execute({ type: 'work.check', conversationId: f.task, assignmentId: f.assignment, checkId: taskCheck, passed: true, evidence: 'Reads right', head: HEAD } as Command, host, reviewer)
      await f.execute({ type: 'work.check', conversationId: step, assignmentId: stepWork, checkId: stepCheck, passed: true, evidence: 'Signs in', head: HEAD } as Command, host, tester)
      const read = async () => [(await group(f.task)).checks[0]!, (await group(step)).checks[0]!]
      return { f, HEAD2, HEAD3, step, read }
    }

    it('counts at its head, and its patch is read once a head', async () => {
      const { f, read } = await reviewed()
      for (const check of await read()) {
        expect(check.passedBy).not.toBeNull()
        expect(check.verdicts!.at(-1)).toMatchObject({ head: HEAD, patch: 'p1' })
      }
      await f.pass()
      expect(f.patchReads).toEqual([`${f.PR}@${HEAD}`])
    })

    it('a same-patch rebase or main merge keeps it', async () => {
      const { f, HEAD2, read } = await reviewed()
      f.pulls.set(f.PR, f.pull({ head: HEAD2 }))
      await f.pass()
      for (const check of await read()) {
        expect(check.passedBy).not.toBeNull()
        expect(check.verdicts!.at(-1)!.stale).toBeUndefined()
      }
    })

    it('a new commit makes it stale on the task and its step', async () => {
      const { f, HEAD3, read } = await reviewed()
      f.pulls.set(f.PR, f.pull({ head: HEAD3 }))
      await f.pass()
      for (const check of await read()) {
        expect(check.passedBy).toBeNull()
        expect(check.verdicts!.at(-1)).toMatchObject({ head: HEAD, stale: HEAD3 })
      }
    })

    // Review of #3218 (Ledger), Important 1: an Engineer sets its task done before the PM merges it, and a done review step goes
    // dormant after a quiet day; a push then must still stop their verdicts counting.
    it('a new commit makes it stale on a done task, and on a dormant step', async () => {
      const { f, HEAD3, step, read } = await reviewed()
      await f.execute({ type: 'work.status', conversationId: f.task, assignmentId: f.assignment, status: 'done', result: `Ready to merge ${f.PR}` }, host, f.worker)
      await db.swarmGroup.updateMany({ where: { tabId: f.tab, key: step }, data: { dormant: true } })
      f.pulls.set(f.PR, f.pull({ head: HEAD3 }))
      await f.pass()
      for (const check of await read()) {
        expect(check.passedBy).toBeNull()
        expect(check.verdicts!.at(-1)).toMatchObject({ head: HEAD, stale: HEAD3 })
      }
      // Nothing is posted to an Engineer whose task is done.
      expect(await f.told()).toEqual([])
    })

    // Review of #3218 (Ledger), Important 5: a patch GitHub could not give is told in the pass's line, and read again later.
    it('a patch it could not read is counted in the pass line, and read again after a while', async () => {
      const { f, read } = await reviewed()
      const NEXT = 'eeeeeee5555555eeeeeee5555555eeeeeee55555'
      const warn = vi.spyOn(logger, 'warn')
      try {
        f.pulls.set(f.PR, f.pull({ head: NEXT }))
        await f.pass()
        const line = warn.mock.calls.find(call => call[0] === '[swarm-pr-events] pass')?.[1] as { unpatched?: number } | undefined
        expect(line?.unpatched).toBeGreaterThanOrEqual(1)
      } finally { warn.mockRestore() }
      // GitHub answers later with the reviewed patch: the head's patch is learned and the verdicts count again.
      f.patches.set(NEXT, 'p1')
      await f.pass()
      expect(f.patchReads.filter(r => r.endsWith(NEXT))).toHaveLength(1)
      f.clock.advance(15 * MINUTE)
      await f.pass()
      expect(f.patchReads.filter(r => r.endsWith(NEXT))).toHaveLength(2)
      for (const check of await read()) expect(check.passedBy).not.toBeNull()
    })

    it('a head whose patch cannot be read counts only verdicts at that very head', async () => {
      const { f, read } = await reviewed()
      f.pulls.set(f.PR, f.pull({ head: 'ddddddd4444444ddddddd4444444ddddddd44444' }))
      await f.pass()
      for (const check of await read()) expect(check.passedBy).toBeNull()
    })
  })
})
