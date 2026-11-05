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
  /** Each head that is git's own merge of another head and main (task #3553), by head: the head it carries. */
  const merges = new Map<string, string>()
  const reader: PullRequestReader = {
    watch: async url => { asked.push(url); return pulls.get(url) ?? null },
    // A patch id names the base branch too (pullRequestPatch.ts): `HEAD@BASE` when a test sets one, else by head alone.
    patch: async (url, head, base) => { patchReads.push(`${url}@${head}`); return patches.get(`${head}@${base}`) ?? patches.get(head) ?? null },
    merge: async (_url, head) => merges.get(head) ?? null,
    botLogin: async () => 'harness[bot]',
    done: async () => {},
  }
  return { pulls, asked, patches, patchReads, merges, reader }
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
  const { pulls, asked, patches, patchReads, merges, reader } = fakeReader()
  const pass = async () => { now += MINUTE; return watchPullRequests(db, store, reader, now) }
  /** The rows this feature wrote in [conversationId], oldest first. */
  const told = async (conversationId = task) => (await db.superTabMessage.findMany({ where: { tabId: tab, conversationId }, orderBy: { sequence: 'asc' } }))
    .filter(m => m.recipientIds.length > 0 && m.text.includes(PR))
  return { PR, number, pull, store, tab, execute, add, lead, task, worker, assignment, pulls, asked, patches, patchReads, merges, reader, pass, told, clock: { get now() { return now }, advance(ms: number) { now += ms } } }
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

  // Task #3399: a handed task (its PR ready for review, its Engineer free) comes back to its Engineer on red CI or a conflict.
  it('CI failing or a conflict on a handed task brings it back to its Engineer, in the same attempt, in the message that tells it', async () => {
    for (const red of [true, false]) {
      const f = await swarm()
      f.pulls.set(f.PR, f.pull())
      await f.pass()
      await f.execute({ type: 'work.status', conversationId: f.task, assignmentId: f.assignment, status: 'review', result: `Ready for review: ${f.PR} at abc1234` }, host, f.worker)
      f.pulls.set(f.PR, red ? f.pull({ checkRuns: [{ name: 'build', status: 'completed', conclusion: 'failure', completedAt: f.clock.now + 10_000 }] }) : f.pull({ mergeable: false }))
      expect(await f.pass()).toBe(1)
      const work = (await f.store.read(owner, f.tab)).state.conversations.find(c => c.id === f.task)!.assignment!
      expect(work).toMatchObject({ id: f.assignment, agentId: f.worker, status: 'working' })
      const [told] = await f.told()
      expect(told!.text).toMatch(red ? /^CI failed on your pull request .* Your task is back with you/ : /merge conflict.* Your task is back with you/)
      expect(told!.recipientIds).toEqual([f.worker])
    }
  })

  it('CI passing on a handed task leaves it with its Reviewers', async () => {
    const f = await swarm()
    f.pulls.set(f.PR, f.pull())
    await f.pass()
    await f.execute({ type: 'work.status', conversationId: f.task, assignmentId: f.assignment, status: 'review', result: `Ready for review: ${f.PR} at abc1234` }, host, f.worker)
    f.pulls.set(f.PR, f.pull({ checkRuns: [{ name: 'build', status: 'completed', conclusion: 'success', completedAt: f.clock.now + 10_000 }], checkSuites: [{ status: 'completed', runs: 1 }] }))
    expect(await f.pass()).toBe(1)
    expect((await f.store.read(owner, f.tab)).state.conversations.find(c => c.id === f.task)!.assignment!.status).toBe('review')
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

  // A done task is read for its heads (#3394: done before the PM merges it), and posts nothing; a step and a cancelled task
  // are not read.
  it('a step and a cancelled task are not read; a done task is, and posts nothing', async () => {
    const f = await swarm()
    const other = 'https://github.com/acme/app/pull/13'
    await f.execute({ type: 'conversation.create', title: 'Review', reviewOf: f.task, step: 'Review', brief: `Review ${other}`,
      checks: [{ description: 'Verdict', independent: false }] } as Command)
    await f.execute({ type: 'work.status', conversationId: f.task, assignmentId: f.assignment, status: 'done', result: `Done ${f.PR}` }, host, f.worker)
    f.pulls.set(f.PR, f.pull({ mergeable: false }))
    const before = (await f.told()).length
    await f.pass()
    expect(f.asked).toContain(f.PR)
    expect(f.asked).not.toContain(other)
    expect(await f.told()).toHaveLength(before)
    const cancelled = await swarm()
    await cancelled.execute({ type: 'work.cancel', conversationId: cancelled.task, assignmentId: cancelled.assignment, reason: 'Not needed' } as Command)
    await cancelled.pass()
    expect(cancelled.asked).not.toContain(cancelled.PR)
  })

  // ENGINEERING.md 4: no loop grows without a bound. A pass reads a capped number of tasks, the most recently active first.
  it('reads at most its cap of tasks a pass, the most recently active first', async () => {
    const f = await swarm()
    f.pulls.set(f.PR, f.pull())
    // Other tests' tasks are in this database too: this one is made the most recently active.
    f.clock.advance(60 * MINUTE)
    await f.execute({ type: 'work.status', conversationId: f.task, assignmentId: f.assignment, status: 'working', result: `Still on ${f.PR}` }, host, f.worker)
    await watchPullRequests(db, f.store, f.reader, f.clock.now + MINUTE, 1, 0)
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
      await f.execute({ type: 'work.check', conversationId: f.task, assignmentId: f.assignment, checkId: taskCheck, passed: true, evidence: 'Reads right', head: HEAD, base: 'main' } as Command, host, reviewer)
      await f.execute({ type: 'work.check', conversationId: step, assignmentId: stepWork, checkId: stepCheck, passed: true, evidence: 'Signs in', head: HEAD, base: 'main' } as Command, host, tester)
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

    // Task #3553: a head git merged from the reviewed head and main by itself carries the verdict (mergeCarry.ts), though its
    // patch is new; any other head does not, and a chain of such merges carries it on.
    it('a clean, automatic main merge keeps it, through a chain of them', async () => {
      const { f, HEAD3, read } = await reviewed()
      const MERGE2 = 'eeeeeee5555555eeeeeee5555555eeeeeee55555'
      f.merges.set(HEAD3, HEAD)
      f.pulls.set(f.PR, f.pull({ head: HEAD3 }))
      await f.pass()
      for (const check of await read()) {
        expect(check.passedBy).not.toBeNull()
        expect(check.verdicts!.at(-1)!.stale).toBeUndefined()
      }
      f.merges.set(MERGE2, HEAD3)
      f.pulls.set(f.PR, f.pull({ head: MERGE2 }))
      await f.pass()
      for (const check of await read()) expect(check.passedBy).not.toBeNull()
    })

    it('a main merge of another head, or with a line resolved by hand, makes it stale', async () => {
      const { f, HEAD3, read } = await reviewed()
      // Git's merge of some other head carries that head's verdicts, not these.
      f.merges.set(HEAD3, 'fffffff6666666fffffff6666666fffffff66666')
      f.pulls.set(f.PR, f.pull({ head: HEAD3 }))
      await f.pass()
      for (const check of await read()) expect(check.verdicts!.at(-1)).toMatchObject({ head: HEAD, stale: HEAD3 })
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
      const before = (await f.told()).length
      f.pulls.set(f.PR, f.pull({ head: HEAD3, mergeable: false }))
      await f.pass()
      for (const check of await read()) {
        expect(check.passedBy).toBeNull()
        expect(check.verdicts!.at(-1)).toMatchObject({ head: HEAD, stale: HEAD3 })
      }
      // Nothing is posted to an Engineer whose task is done, not even a merge conflict.
      expect(await f.told()).toHaveLength(before)
    })

    // Review of #3218 (Ledger, round 2), Important 1: a task from before steps were listed, its review step dormant, and a done
    // task quiet for over a week with its pull request still open.
    it('a new commit makes it stale on a dormant step its task does not list, and on a done task quiet for a week', async () => {
      const { f, HEAD3, step, read } = await reviewed()
      await f.execute({ type: 'work.status', conversationId: f.task, assignmentId: f.assignment, status: 'done', result: `Ready to merge ${f.PR}` }, host, f.worker)
      const row = await db.swarmGroup.findFirstOrThrow({ where: { tabId: f.tab, key: f.task } })
      const { stepIds: _listed, ...legacy } = row.data as Record<string, unknown>
      await db.swarmGroup.update({ where: { id: row.id }, data: { data: legacy as object, lastActivityAt: new Date(f.clock.now - 9 * 24 * 60 * MINUTE) } })
      await db.swarmGroup.updateMany({ where: { tabId: f.tab, key: step }, data: { dormant: true } })
      // Round 3, Important 1: a step opened before the first watch leaves the old dormant one to be looked up.
      const later = String((await f.execute({ type: 'conversation.create', title: 'Docs', reviewOf: f.task, step: 'Docs', brief: 'Docs',
        checks: [] } as Command, host, f.worker)).result.conversationId)
      f.pulls.set(f.PR, f.pull({ head: HEAD3 }))
      await f.pass()
      for (const check of await read()) {
        expect(check.passedBy).toBeNull()
        expect(check.verdicts!.at(-1)).toMatchObject({ head: HEAD, stale: HEAD3 })
      }
      // The task lists its steps from now on, the old dormant one and the new one.
      const listed = (await db.swarmGroup.findFirstOrThrow({ where: { tabId: f.tab, key: f.task } })).data as { stepIds?: string[] }
      expect(listed.stepIds).toEqual(expect.arrayContaining([step, later]))
    })

    // Security review of #3218 (Warden2, round 3), Important 1: retarget to a branch with other code, push the same diff against
    // it, retarget back. The base branch is part of the head's record: a new base reads the patch again, against that base.
    it('a retargeted base reads the patch again, and a verdict never follows the same diff onto another branch', async () => {
      const { f, read } = await reviewed()
      const H = '1234567890abcdef1234567890abcdef12345678'
      f.patches.set(`${HEAD}@evil`, 'p-evil').set(`${H}@evil`, 'p-evil').set(`${H}@main`, 'p-main-backdoor')
      const reads = () => f.patchReads.filter(r => r.startsWith(`${f.PR}@`)).length
      const before = reads()
      f.pulls.set(f.PR, f.pull({ base: 'evil' }))
      await f.pass()
      expect(reads()).toBe(before + 1)
      f.pulls.set(f.PR, f.pull({ base: 'evil', head: H }))
      await f.pass()
      f.pulls.set(f.PR, f.pull({ base: 'main', head: H }))
      await f.pass()
      expect(reads()).toBe(before + 3)
      for (const check of await read()) expect(check.passedBy).toBeNull()
      const kept = ((await db.swarmGroup.findFirstOrThrow({ where: { tabId: f.tab, key: f.task } })).data as { pullRequestHeads: Record<string, { base?: string }> }).pullRequestHeads
      expect(kept[f.PR]).toMatchObject({ head: H, base: 'main', patch: 'p-main-backdoor' })
    })

    // Security review of #3218 (Warden2, round 4), Important 1: the same head against another base branch is another diff.
    it('a verdict at its head stops counting when the pull request is retargeted, and counts again back on its base', async () => {
      const { f, read } = await reviewed()
      f.patches.set(`${HEAD}@evil`, 'p-evil')
      f.pulls.set(f.PR, f.pull({ base: 'evil' }))
      await f.pass()
      for (const check of await read()) expect(check.passedBy).toBeNull()
      f.patches.set(`${HEAD}@main`, 'p1')
      f.pulls.set(f.PR, f.pull({ base: 'main' }))
      await f.pass()
      for (const check of await read()) expect(check.passedBy).not.toBeNull()
    })

    // Review of #3218 round 7 (Ledger): seen on main, retargeted to another branch while the review ran and back before the
    // verdict came. No inferred base is the one read: a verdict naming none does not count; one naming its base counts on it.
    it('after a round trip of retargets, a verdict counts only with the base it names', async () => {
      const f = await swarm()
      const X = '9999999999999999999999999999999999999999'
      f.patches.set(`${X}@evil`, 'p-evil').set(`${X}@main`, 'p-main')
      for (const base of ['main', 'evil', 'main']) {
        f.pulls.set(f.PR, f.pull({ head: X, base }))
        await f.pass()
      }
      const reviewer = await f.add(f.task, 'test-host', 'Reviewer')
      const checkId = ((await db.swarmGroup.findFirstOrThrow({ where: { tabId: f.tab, key: f.task } })).data as { checks: Array<{ id: string }> }).checks[0]!.id
      const check = (fields: Record<string, string>) => f.execute({ type: 'work.check', conversationId: f.task, assignmentId: f.assignment, checkId,
        passed: true, evidence: 'Read it', ...fields } as Command, host, reviewer)
      const unnamed = await check({ head: X })
      expect(unnamed.result).toMatchObject({ counts: false })
      expect(String(unnamed.result.next)).toContain('base')
      expect(await check({ head: X, base: 'evil' })).toMatchObject({ result: { counts: false } })
      expect(await check({ head: X, base: 'main' })).toMatchObject({ result: { counts: true } })
    })

    // Review of #3218 (Ledger, round 3), Important 2: links added later can move a reviewed pull request out of the watch;
    // its head is then no longer read, so its verdicts stop counting, on the task and its steps, though no head was left.
    it('a verdict stops counting once its pull request leaves the links watched', async () => {
      const { f, step, read } = await reviewed()
      const later = Array.from({ length: 50 }, (_, i) => `https://github.com/acme/app/pull/${8000 + f.number * 100 + i}`)
      for (const [i, url] of later.entries()) f.pulls.set(url, { ...f.pull({ state: 'closed' }), url, number: 8000 + i })
      await f.execute({ type: 'work.status', conversationId: f.task, assignmentId: f.assignment, status: 'working', result: later.join(' ') }, host, f.worker)
      await db.swarmGroup.updateMany({ where: { tabId: f.tab, key: step }, data: { dormant: true } })
      await f.pass()
      for (const check of await read()) expect(check.passedBy).toBeNull()
      const kept = ((await db.swarmGroup.findFirstOrThrow({ where: { tabId: f.tab, key: f.task } })).data as { pullRequestHeads?: object }).pullRequestHeads
      expect(kept).toEqual({})
    })

    // Review of #3218 (Ledger, round 2), Important 2: past HEADS_KEPT open pull requests, unchanged heads keep their patches.
    it('keeps every patch across passes for a task linking more pull requests than it keeps heads of', async () => {
      const f = await swarm()
      const links = Array.from({ length: 52 }, (_, i) => `https://github.com/acme/app/pull/${9000 + f.number * 100 + i}`)
      await f.execute({ type: 'work.status', conversationId: f.task, assignmentId: f.assignment, status: 'working', result: links.join(' ') }, host, f.worker)
      for (const [i, url] of links.entries()) {
        const head = (i + 1).toString(16).padStart(40, '0')
        f.pulls.set(url, { ...f.pull({ head }), url, number: 9000 + i })
        f.patches.set(head, `p${i}`)
      }
      for (let pass = 0; pass < 3; pass++) await f.pass()
      const heads = ((await db.swarmGroup.findFirstOrThrow({ where: { tabId: f.tab, key: f.task } })).data as { pullRequestHeads: Record<string, { patch: string | null }> }).pullRequestHeads
      expect(Object.keys(heads)).toHaveLength(50)
      expect(Object.values(heads).filter(h => h.patch === null)).toEqual([])
      // Each kept head's patch was read once, in the first pass.
      expect(f.patchReads.filter(r => links.some(url => r.startsWith(`${url}@`)))).toHaveLength(50)
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
