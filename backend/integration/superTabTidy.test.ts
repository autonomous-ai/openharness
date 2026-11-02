import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { MongoMemoryReplSet } from 'mongodb-memory-server-core'
import { PrismaClient } from '@prisma/client'
import type { AuthUser } from '../src/lib/ssoAuth.js'
import { SuperTabStore } from '../src/superTabs/store.js'
import type { Command } from '../src/superTabs/commands.js'
import type { MachineObservation } from '../src/superTabs/machines.js'
import { poolRows, rosterRows } from './hostRows.test-support.js'
import { archiveFinishedGroups, markFinishedGroups, type PullRequestState } from '../src/superTabs/archive.js'
import { settleStuckDeliveries } from '../src/superTabs/deliverySettle.js'
import { SuperTabError } from '../src/superTabs/model.js'
import { logger } from '../src/utils/logger.js'

// Nobody tidies a Swarm by hand: an agent idle for 15 minutes is told to its coordinator on its poll, and finished groups
// archive. A fresh loopback replica set, created here.
let replica: MongoMemoryReplSet
let db: PrismaClient
const owner: AuthUser = { sub: '200000000000000000000001', email: 'owner@example.com', autonomousEnv: 'prod', role: 'user' }
const host: AuthUser = { sub: '200000000000000000000003', email: 'host@example.com', autonomousEnv: 'prod', role: 'user' }
const config = { engine: 'codex', model: 'fixture-model', effort: 'high', contextWindow: 200000, engineVersion: 'fixture' }
const MINUTE = 60_000

beforeAll(async () => {
  replica = await MongoMemoryReplSet.create({ binary: { version: '7.0.24', downloadDir: join(tmpdir(), 'harness-super-tab-mongodb-binaries') },
    replSet: { count: 1, ip: '127.0.0.1', storageEngine: 'wiredTiger' } })
  const uri = replica.getUri(`swarm_tidy_test_${randomUUID().replaceAll('-', '_')}`)
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

/** A Swarm whose Lead runs on one of host's machines and whose Swarm-started worker, on another, finished "Ship the parser". */
async function swarm() {
  let now = Date.parse('2026-10-27T08:00:00.000Z')
  const timed = new SuperTabStore(db, () => now)
  const tab = (await timed.create(owner, randomUUID(), 'Tidy', 'public')).id
  const execute = (command: Command, user = owner, asAgentId?: string) => timed.execute(user, tab, { operationId: randomUUID(), command }, asAgentId)
  const invitation = await execute({ type: 'invite.create', email: host.email, role: 'collaborator', conversationId: 'lead' })
  await execute({ type: 'invite.accept', inviteId: invitation.result.inviteId as string }, host)
  for (const [machineId, name] of [['lead-host', 'Lead Mac'], ['test-host', 'Worker Mac']]) {
    await execute({ type: 'machine.contribute', machineId: machineId!, name: name!, cwd: '/repo', engines: ['codex'], maxAgents: 4 }, host)
  }
  const generations = new Map<string, string>()
  for (const machineId of ['lead-host', 'test-host']) generations.set(machineId, (await poolRows(timed, host, machineId)).find(p => p.tabId === tab)!.machine.generation)
  const harness = { lead: randomUUID(), worker: randomUUID() }
  const add = async (conversationId: string, machineId: string, harnessId: string, name: string, lead = false) => String((await execute({ type: 'agent.add',
    conversationId, machineId, harnessId, name, configuration: config, lead })).result.agentId)
  const lead = await add('lead', 'lead-host', harness.lead, 'Lead', true)
  const group = String((await execute({ type: 'conversation.create', title: 'Ship the parser', brief: 'Implement it',
    checks: [{ description: 'Verified', independent: false }] })).result.conversationId)
  const worker = await add(group, 'test-host', harness.worker, 'Worker')
  // As agent.started records it for a Swarm start (commands.ts); agent.add stands for a person's own session.
  const row = await db.swarmAgent.findFirstOrThrow({ where: { tabId: tab, key: worker } })
  await db.swarmAgent.update({ where: { id: row.id }, data: { data: { ...row.data as object,
    startedSession: { creationId: 'creation-1', sessionId: 'session-1', createdAt: new Date(now).toISOString() } } } })
  const assignmentId = String((await execute({ type: 'work.assign', conversationId: group, agentId: worker })).result.assignmentId)
  await execute({ type: 'work.cancel', conversationId: group, assignmentId, reason: 'Done elsewhere' })
  // Its host took the cancel notice, as a running host does.
  await db.superTabDelivery.updateMany({ where: { tabId: tab, agentId: worker, status: 'queued' }, data: { status: 'delivered' } })
  const observe = (machineId: string, running: string[], extra: Partial<MachineObservation> = {}) => timed.observeMachine(host, tab, machineId, {
    generation: generations.get(machineId)!, resources: { cpuPercent: 10, memoryTotalBytes: 32e9, memoryUsedBytes: 4e9, diskFreeBytes: 120e9,
      diskTotalBytes: 500e9, projectDiskFreeBytes: 120e9, deviceType: 'Laptop', chip: 'Fixture', os: 'macOS', gpuPercent: null },
    quotas: [], tools: {}, runningHarnessIds: running, stoppedHarnessIds: [], ...extra })
  const member = async () => (await timed.read(owner, tab)).state.agents.find(a => a.id === worker)!
  const lines = async () => (await db.superTabMessage.findMany({ where: { tabId: tab }, orderBy: { sequence: 'asc' } }))
    .filter(m => (m.source as { kind?: string } | null)?.kind === 'idle')
  /** Marks an agent as the Swarm started it, with [patch] (a role), as agent.started and agent.start record them. */
  const started = async (agentId: string, patch: Record<string, unknown> = {}) => {
    const part = await db.swarmAgent.findFirstOrThrow({ where: { tabId: tab, key: agentId } })
    await db.swarmAgent.update({ where: { id: part.id }, data: { data: { ...part.data as object, ...patch,
      startedSession: { creationId: `creation-${agentId}`, sessionId: `session-${agentId}`, createdAt: new Date(now).toISOString() } } } })
  }
  /** Its host took every message queued so far, as a running host does. */
  const delivered = () => db.superTabDelivery.updateMany({ where: { tabId: tab, status: 'queued' }, data: { status: 'delivered' } })
  return { timed, tab, execute, lead, group, worker, harness, observe, member, lines, add, started, delivered,
    clock: { get now() { return now }, set now(value: number) { now = value } } }
}

// Project instructions, phase 4 (decision 7): the server stops no idle agent. Its coordinator is told once per idle spell,
// whether tidying is on or off, and the instructions say whether it stops or keeps the agent.
describe('an agent left idle', () => {
  it('is told to its coordinator on its poll 15 minutes after its last activity, once, and nothing stops it', async () => {
    const f = await swarm()
    f.clock.now += 14 * MINUTE
    await f.timed.deliveries(host, f.tab, f.lead)
    expect(await f.lines()).toEqual([])
    f.clock.now += MINUTE + 1_000
    const inbox = await f.timed.deliveries(host, f.tab, f.lead)
    const lines = await f.lines()
    expect(lines).toEqual([expect.objectContaining({ conversationId: 'lead', recipientIds: [f.lead], text: 'Worker has had no open task for 15 minutes.',
      source: { kind: 'idle', agentId: f.worker } })])
    expect(inbox.map(d => d.messageId)).toContain(lines[0]!.id)
    const member = await f.member()
    expect(member.workDecision).toBe('awaiting')
    expect(member.releaseId).toBeUndefined()
    expect((await rosterRows(f.timed, host, 'test-host')).find(r => r.agent.id === f.worker)!.agent.releaseId ?? null).toBeNull()
    // The same idle spell is told once, however many polls follow.
    f.clock.now += 30 * MINUTE
    await f.timed.deliveries(host, f.tab, f.lead)
    expect(await f.lines()).toHaveLength(1)
  })

  it('is told to the coordinator alone: no person or other agent reads it', async () => {
    const f = await swarm()
    f.clock.now += 15 * MINUTE + 1_000
    await f.timed.deliveries(host, f.tab, f.lead)
    const [line] = await f.lines()
    const page = async (user: AuthUser, conversationId: string, query: { messageId?: string } = {}, asAgentId?: string) =>
      (await f.timed.messages(user, f.tab, conversationId, query, asAgentId)).messages.map(m => m.id)
    expect(await page(host, 'lead', {}, f.lead)).toContain(line!.id)
    for (const user of [owner, host]) {
      expect(await page(user, 'lead')).not.toContain(line!.id)
      expect(await page(user, 'lead', { messageId: line!.id })).toEqual([])
    }
    expect((await db.superTabDelivery.findMany({ where: { tabId: f.tab, messageId: line!.id } })).map(d => d.agentId)).toEqual([f.lead])
  })

  it('is told whatever its host says of its folder, and not while a message waits for it', async () => {
    const f = await swarm()
    f.clock.now += 20 * MINUTE
    await f.observe('test-host', [f.harness.worker], { harnessUncommitted: { [f.harness.worker]: true } })
    // Written straight into the queue, as a delivery from a moment ago that its host has not picked up yet.
    const waiting = await db.superTabDelivery.create({ data: { id: randomUUID(), tabId: f.tab, conversationId: f.group, messageId: randomUUID(), agentId: f.worker,
      machineId: 'test-host', machineOwnerId: host.sub, assignmentId: null, membershipGeneration: 'g', authorKind: 'person', authorId: owner.sub, authorGeneration: 'g' } })
    await f.timed.deliveries(host, f.tab, f.lead)
    expect(await f.lines()).toEqual([])
    await db.superTabDelivery.update({ where: { id: waiting.id }, data: { status: 'delivered' } })
    await f.timed.deliveries(host, f.tab, f.lead)
    expect(await f.lines()).toHaveLength(1)
  })

  it('is not told of while it belongs to a task with active work, and is once that work ends', async () => {
    const f = await swarm()
    const reviewed = String((await f.execute({ type: 'conversation.create', title: 'Parser v2', brief: 'More parsing',
      checks: [{ description: 'Verified', independent: false }] })).result.conversationId)
    const builderHarness = randomUUID()
    const builder = await f.add(reviewed, 'test-host', builderHarness, 'Builder')
    const work = String((await f.execute({ type: 'work.assign', conversationId: reviewed, agentId: builder })).result.assignmentId)
    // The worker checks it, as a Reviewer or a Tester linked to it does.
    await f.execute({ type: 'conversation.agent', conversationId: reviewed, agentId: f.worker, present: true, lead: false })
    await f.delivered()
    const told = async () => (await f.lines()).filter(m => (m.source as { agentId?: string }).agentId === f.worker)
    f.clock.now += 20 * MINUTE
    // The Builder's session is at work: its machine's report keeps its task's lease (liveness.ts).
    await f.observe('test-host', [f.harness.worker, builderHarness], { harnessProgress: { [builderHarness]: f.clock.now } })
    await f.timed.deliveries(host, f.tab, f.lead)
    expect(await told()).toEqual([])
    await f.execute({ type: 'work.cancel', conversationId: reviewed, assignmentId: work, reason: 'Dropped' })
    await f.delivered()
    f.clock.now += 15 * MINUTE + 1_000
    await f.timed.deliveries(host, f.tab, f.lead)
    expect(await told()).toHaveLength(1)
  })

  it('is told by its loaded tasks alone: a task gone asleep is never read for it', async () => {
    const f = await swarm()
    const review = String((await f.execute({ type: 'conversation.create', title: 'Review: Parser', brief: 'Review it', reviewOf: f.group,
      checks: [{ description: 'Verdict', independent: false }] })).result.conversationId)
    const reviewer = await f.add(review, 'test-host', randomUUID(), 'Reviewer')
    await f.started(reviewer, { role: 'reviewer' })
    const verdict = String((await f.execute({ type: 'work.assign', conversationId: review, agentId: reviewer })).result.assignmentId)
    await f.execute({ type: 'work.cancel', conversationId: review, assignmentId: verdict, reason: 'Verdict given' })
    await f.execute({ type: 'conversation.archive', conversationId: review, archived: true })
    await f.delivered()
    // Asleep, though active 10 minutes ago: the coordinator's poll reads no asleep group, so the Reviewer is idle from its start.
    f.clock.now += 20 * MINUTE
    const part = await db.swarmGroup.findFirstOrThrow({ where: { tabId: f.tab, key: review } })
    const recent = new Date(f.clock.now - 10 * MINUTE)
    await db.swarmGroup.update({ where: { id: part.id }, data: { dormant: true, lastActivityAt: recent,
      data: { ...part.data as object, dormant: true, lastActivityAt: recent.toISOString() } } })
    await f.timed.deliveries(host, f.tab, f.lead)
    const named = (await f.timed.read(owner, f.tab)).state.agents.find(a => a.id === reviewer)!
    expect((await f.lines()).filter(m => (m.source as { agentId?: string }).agentId === reviewer))
      .toEqual([expect.objectContaining({ conversationId: 'lead', text: `${named.displayName ?? named.name} has had no open task for 15 minutes.` })])
    expect(named.workDecision).not.toBe('stop')
  })

  it('is told whether or not the owner turned tidying off', async () => {
    const f = await swarm()
    await f.execute({ type: 'tab.tidy', enabled: false })
    f.clock.now += 20 * MINUTE
    await f.timed.deliveries(host, f.tab, f.lead)
    expect(await f.lines()).toHaveLength(1)
    expect((await f.member()).workDecision).toBe('awaiting')
  })
})

describe('a finished group', () => {
  const PR = 'https://github.com/acme/app/pull/7'
  /** GitHub as the sweep reads it: each pull request's state, null when it cannot say. */
  const github = (states: Record<string, PullRequestState>) => ({ read: [] as string[], closed: false,
    async state(url: string) { this.read.push(url); return states[url] ?? null }, async done() { this.closed = true } })
  const archived = async (f: Awaited<ReturnType<typeof swarm>>) => (await db.swarmGroup.findFirstOrThrow({ where: { tabId: f.tab, key: f.group } })).archived
  const archiveLines = async (f: Awaited<ReturnType<typeof swarm>>) => (await db.superTabMessage.findMany({ where: { tabId: f.tab, conversationId: f.group } }))
    .filter(m => (m.source as { kind?: string } | null)?.kind === 'auto-archive')
  const linkPr = (f: Awaited<ReturnType<typeof swarm>>) => f.execute({ type: 'message.send', conversationId: f.group, text: `Pull request: ${PR}`, replyTo: null, recipientIds: [] })

  it('archives 30 minutes after its last message once every pull request is merged or closed, with one quiet line', async () => {
    const f = await swarm()
    await linkPr(f)
    const prs = github({ [PR]: 'merged' })
    f.clock.now += 29 * MINUTE
    await archiveFinishedGroups(db, f.timed, prs, f.clock.now)
    expect(await archived(f)).toBe(false)
    f.clock.now += MINUTE
    await archiveFinishedGroups(db, f.timed, prs, f.clock.now)
    expect(await archived(f)).toBe(true)
    expect(prs.read).toContain(PR)
    expect(prs.closed).toBe(true)
    expect(await archiveLines(f)).toEqual([expect.objectContaining({ recipientIds: [],
      text: 'Archived: the work is cancelled and its pull requests are merged or closed.' })])
    // It never archives twice.
    f.clock.now += 40 * MINUTE
    await archiveFinishedGroups(db, f.timed, prs, f.clock.now)
    expect(await archiveLines(f)).toHaveLength(1)
  })

  it('stays open while a pull request is open or GitHub cannot say', async () => {
    for (const state of ['open', null] as const) {
      const f = await swarm()
      await linkPr(f)
      f.clock.now += 40 * MINUTE
      await archiveFinishedGroups(db, f.timed, github({ [PR]: state }), f.clock.now)
      expect(await archived(f)).toBe(false)
    }
  })

  // Dee, 10-31: a decision asked in finished work waits no more, so it no longer holds the group open.
  it('archives finished work with a person\'s decision still open there, closing it as withdrawn', async () => {
    const f = await swarm()
    const id = randomUUID()
    await db.superTabDecision.create({ data: { id, tabId: f.tab, batchId: 'b', conversationId: f.group, projectId: 'p', personId: owner.sub,
      askerAgentId: f.lead, assignmentId: null, question: 'Ship it?', options: ['Yes', 'No'], recommended: 0, unblocks: 'Release', createdAt: new Date(f.clock.now) } })
    f.clock.now += 40 * MINUTE
    await archiveFinishedGroups(db, f.timed, github({}), f.clock.now)
    expect(await archived(f)).toBe(true)
    expect(await db.superTabDecision.findUnique({ where: { id } })).toMatchObject({ withdrawn: true, choice: null, answeredAt: new Date(f.clock.now) })
  })

  it('stays open once the owner turned tidying off, and never archives the Lead conversation', async () => {
    const f = await swarm()
    await f.execute({ type: 'tab.tidy', enabled: false })
    f.clock.now += 40 * MINUTE
    await archiveFinishedGroups(db, f.timed, github({}), f.clock.now)
    expect(await archived(f)).toBe(false)
    expect((await db.swarmGroup.findMany({ where: { tabId: f.tab, archived: true } }))).toEqual([])
  })
})

// Ken, 2026-10-30: 28 of 31 open review groups waited for a Reviewer on pull requests already merged or closed.
describe('a review nobody reviews', () => {
  const PR = 'https://github.com/example/parser/pull/9'
  const github = (states: Record<string, PullRequestState>) => ({ async state(url: string) { return states[url] ?? null }, async done() {} })
  /** A Swarm whose Builder marked "Parser v2" ready with PR and opened its review itself, linked to that work (project
   *  instructions, phase 4: the server opens no review), with nobody assigned to it, or [reviewer] working on it. */
  async function waiting(withReviewer = false) {
    const f = await swarm()
    const reviewed = String((await f.execute({ type: 'conversation.create', title: 'Parser v2', brief: 'More parsing',
      checks: [{ description: 'Verified', independent: true }] })).result.conversationId)
    const builder = await f.add(reviewed, 'test-host', randomUUID(), 'Builder')
    const work = String((await f.execute({ type: 'work.assign', conversationId: reviewed, agentId: builder })).result.assignmentId)
    const ready = (text: string) => f.execute({ type: 'work.status', conversationId: reviewed, assignmentId: work, status: 'review', result: text }, host, builder)
    await ready(`Ready: yes, revision abc..def. ${PR}`)
    const opened = String((await f.execute({ type: 'conversation.create', title: 'Review: Parser v2', brief: `Review ${PR} against the task.`,
      reviewOf: reviewed, checks: [{ description: 'Verdict', independent: false }] }, host, builder)).result.conversationId)
    if (withReviewer) {
      const reviewer = await f.add('lead', 'test-host', randomUUID(), 'Reviewer')
      await f.execute({ type: 'work.assign', conversationId: opened, agentId: reviewer }, host, builder)
    }
    const reviews = async () => (await db.swarmGroup.findMany({ where: { tabId: f.tab, deleted: false } }))
      .filter(row => (row.data as { reviewOf?: string }).reviewOf === reviewed)
    const review = (await reviews())[0]!
    const closeLines = async () => (await db.superTabMessage.findMany({ where: { tabId: f.tab, conversationId: review.key } }))
      .filter(m => (m.source as { kind?: string } | null)?.kind === 'auto-archive')
    const isArchived = async () => (await db.swarmGroup.findUniqueOrThrow({ where: { id: review.id } })).archived
    return { ...f, reviewed, builder, work, ready, reviews, review, closeLines, isArchived }
  }

  it('closes 30 minutes after its last message once every pull request of the work it reviews is merged, with one line saying why', async () => {
    const f = await waiting()
    expect((f.review.data as { assignment: unknown }).assignment).toBeNull()
    expect(f.review.workFinished).toBe(true)
    f.clock.now += 29 * MINUTE
    await archiveFinishedGroups(db, f.timed, github({ [PR]: 'merged' }), f.clock.now)
    expect(await f.isArchived()).toBe(false)
    f.clock.now += MINUTE
    await archiveFinishedGroups(db, f.timed, github({ [PR]: 'merged' }), f.clock.now)
    expect(await f.isArchived()).toBe(true)
    expect(await f.closeLines()).toEqual([expect.objectContaining({ recipientIds: [], author: expect.objectContaining({ id: f.lead }),
      text: 'Closed: #9 merged; no Swarm review is needed now.' })])
    // The work it reviews is untouched: its Builder still waits, for the Lead to settle.
    expect((await db.swarmGroup.findFirstOrThrow({ where: { tabId: f.tab, key: f.reviewed } })).archived).toBe(false)
  })

  it('stays open while a pull request of the work it reviews is open, reopened, or unknown to GitHub', async () => {
    const SECOND = 'https://github.com/example/parser/pull/10'
    for (const states of [{ [PR]: 'open' }, { [PR]: null }, { [PR]: 'merged', [SECOND]: 'open' }] as Array<Record<string, PullRequestState>>) {
      const f = await waiting()
      // A second pull request linked to the work it reviews only, after the review opened.
      await f.execute({ type: 'message.send', conversationId: f.reviewed, text: `Follow-up: ${SECOND}`, replyTo: null, recipientIds: [] })
      f.clock.now += 40 * MINUTE
      await archiveFinishedGroups(db, f.timed, github(states), f.clock.now)
      expect(await f.isArchived()).toBe(false)
      expect(await f.closeLines()).toEqual([])
    }
  })

  it('never closes while a Reviewer works on it', async () => {
    const f = await waiting(true)
    expect((f.review.data as { assignment: { status: string } }).assignment.status).toBe('working')
    expect(f.review.workFinished).toBe(false)
    f.clock.now += 40 * MINUTE
    await archiveFinishedGroups(db, f.timed, github({ [PR]: 'merged' }), f.clock.now)
    expect(await f.isArchived()).toBe(false)
  })

  it('is found once the worker marks it at startup when it was written before reviews took the mark', async () => {
    const f = await waiting()
    await db.swarmGroup.update({ where: { id: f.review.id }, data: { workFinished: false } })
    f.clock.now += 40 * MINUTE
    await archiveFinishedGroups(db, f.timed, github({ [PR]: 'merged' }), f.clock.now)
    expect(await f.isArchived()).toBe(false)
    expect(await markFinishedGroups(db)).toBeGreaterThanOrEqual(1)
    await archiveFinishedGroups(db, f.timed, github({ [PR]: 'merged' }), f.clock.now)
    expect(await f.isArchived()).toBe(true)
  })

  // Review of #2322: a Ready committed inside the close's write linked a new pull request to the work; the close then
  // archived its review on the older ones, and the work was left with no review, silently (the 10-28 failure).
  it('stays open when a Ready for review with a new pull request commits during its close, so the work keeps a review', async () => {
    const f = await waiting()
    let during: (() => Promise<unknown>) | null = () => f.ready('Ready: yes, revision fff. https://github.com/example/parser/pull/11')
    // Paused at the close's first write, which closes the decisions still waiting there.
    const hooked = db.$extends({ query: { superTabDecision: { async updateMany({ args, query }) {
      if (during && (args.where as { conversationId?: string } | undefined)?.conversationId === f.review.key) { const run = during; during = null; await run() }
      return query(args)
    } } } })
    const closing = new SuperTabStore(hooked as unknown as PrismaClient, () => f.clock.now)
    f.clock.now += 40 * MINUTE
    await archiveFinishedGroups(db, closing, github({ [PR]: 'merged' }), f.clock.now)
    expect(during).toBeNull()
    expect(await f.isArchived()).toBe(false)
    expect(await f.closeLines()).toEqual([])
    expect((await f.reviews()).filter(row => !row.archived)).toHaveLength(1)
  })

  it('is cancelled by its coordinator with "current": it archives with the reason, and what waited there for the coordinator ends', async () => {
    const f = await waiting()
    await f.execute({ type: 'message.send', conversationId: f.review.key, text: 'No reviewer is free yet.', replyTo: null, recipientIds: [f.lead] }, host, f.builder)
    const waitingFor = await db.superTabDelivery.findMany({ where: { tabId: f.tab, conversationId: f.review.key, status: 'queued' } })
    expect(waitingFor.map(d => d.agentId)).toEqual([f.lead])
    await f.execute({ type: 'work.cancel', conversationId: f.review.key, assignmentId: 'current', reason: 'Reviewed outside the Swarm' }, host, f.lead)
    expect(await f.isArchived()).toBe(true)
    expect((await db.superTabDelivery.findMany({ where: { id: { in: waitingFor.map(d => d.id) } } })).map(d => d.status)).toEqual(['cancelled'])
    const line = await db.superTabMessage.findFirstOrThrow({ where: { tabId: f.tab, conversationId: f.review.key, text: { startsWith: 'Lead cancelled' } } })
    expect(line).toMatchObject({ text: 'Lead cancelled this task: Reviewed outside the Swarm.', recipientIds: [] })
  })
})

describe('the archive pass', () => {
  it('reads each pull request once however many groups link it', async () => {
    const PR = 'https://github.com/acme/app/pull/9'
    const f = await swarm()
    const second = String((await f.execute({ type: 'conversation.create', title: 'Docs', brief: 'Docs too', checks: [{ description: 'Verified', independent: false }] })).result.conversationId)
    const worker2 = await f.add(second, 'test-host', randomUUID(), 'Writer')
    const work = String((await f.execute({ type: 'work.assign', conversationId: second, agentId: worker2 })).result.assignmentId)
    await f.execute({ type: 'work.cancel', conversationId: second, assignmentId: work, reason: 'Done elsewhere' })
    for (const group of [f.group, second]) await f.execute({ type: 'message.send', conversationId: group, text: `Pull request: ${PR}`, replyTo: null, recipientIds: [] })
    const read: string[] = []
    f.clock.now += 40 * MINUTE
    await archiveFinishedGroups(db, f.timed, { state: async url => { read.push(url); return 'open' }, done: async () => {} }, f.clock.now)
    // Other tests' Swarms share this database, with links of their own.
    expect(read.filter(url => url === PR)).toEqual([PR])
  })

  // Review of #2322: a busy group whose write kept conflicting ended the pass for every group after it.
  it('skips a group whose write fails, with a warning, and goes on to the rest', async () => {
    const f = await swarm()
    const second = String((await f.execute({ type: 'conversation.create', title: 'Docs', brief: 'Docs too', checks: [{ description: 'Verified', independent: false }] })).result.conversationId)
    const writer = await f.add(second, 'test-host', randomUUID(), 'Writer')
    const work = String((await f.execute({ type: 'work.assign', conversationId: second, agentId: writer })).result.assignmentId)
    await f.execute({ type: 'work.cancel', conversationId: second, assignmentId: work, reason: 'Done elsewhere' })
    // f.group went quiet first, so the pass reaches it first.
    const failing: Pick<SuperTabStore, 'archiveFinished'> = { archiveFinished: async (tabId, groupId, checked, reviewOf) => {
      if (groupId === f.group) throw new Error('write conflict')
      return f.timed.archiveFinished(tabId, groupId, checked, reviewOf)
    } }
    f.clock.now += 40 * MINUTE
    await expect(archiveFinishedGroups(db, failing, { state: async () => null, done: async () => {} }, f.clock.now)).resolves.toBeGreaterThanOrEqual(1)
    const archivedOf = async (key: string) => (await db.swarmGroup.findFirstOrThrow({ where: { tabId: f.tab, key } })).archived
    expect(await archivedOf(f.group)).toBe(false)
    expect(await archivedOf(second)).toBe(true)
  })

  it('finds a finished group written before the finished mark once the worker marks it at startup', async () => {
    const f = await swarm()
    const part = await db.swarmGroup.findFirstOrThrow({ where: { tabId: f.tab, key: f.group } })
    // As an older backend left it: no mark at all.
    await db.$runCommandRaw({ update: 'SwarmGroup', updates: [{ q: { _id: part.id }, u: { $unset: { workFinished: '' } } }] })
    const prs = { state: async () => null, done: async () => {} }
    f.clock.now += 40 * MINUTE
    await archiveFinishedGroups(db, f.timed, prs, f.clock.now)
    expect((await db.swarmGroup.findUniqueOrThrow({ where: { id: part.id } })).archived).toBe(false)
    expect(await markFinishedGroups(db)).toBeGreaterThanOrEqual(1)
    await archiveFinishedGroups(db, f.timed, prs, f.clock.now)
    expect((await db.swarmGroup.findUniqueOrThrow({ where: { id: part.id } })).archived).toBe(true)
  })
})

// Prod watch, 2026-10-28: 9 deliveries had waited for days (uncertain since Oct 20, claimed for 71 hours, queued in archived
// groups). None belonged to a task, so nothing ended them. Each now ends as cancelled, which its sender sees as Not sent.
describe('a delivery that cannot move', () => {
  const HOUR = 60 * MINUTE
  type Fixture = Awaited<ReturnType<typeof swarm>>
  const status = async (id: string) => (await db.superTabDelivery.findUniqueOrThrow({ where: { id } })).status
  /** A person's message to the Lead in the project chat, waiting for the Lead's host. */
  const toLead = async (f: Fixture, text: string) => {
    const sent = await f.execute({ type: 'message.send', conversationId: 'lead', text, replyTo: null, recipientIds: [] })
    return (await db.superTabDelivery.findFirstOrThrow({ where: { tabId: f.tab, messageId: sent.result.messageId as string, agentId: f.lead } })).id
  }
  /** The Lead's message to its worker in the worker's group. */
  const toWorker = async (f: Fixture, text: string) => {
    const sent = await f.execute({ type: 'message.send', conversationId: f.group, text, replyTo: null, recipientIds: [f.worker] }, host, f.lead)
    return (await db.superTabDelivery.findFirstOrThrow({ where: { tabId: f.tab, messageId: sent.result.messageId as string, agentId: f.worker } })).id
  }
  /** The pass at [after] past the row's last write: a host's own writes are stamped by the database clock, not the store's. */
  const settleAfter = async (f: Fixture, id: string, after: number) =>
    settleStuckDeliveries(db, f.timed, (await db.superTabDelivery.findUniqueOrThrow({ where: { id } })).updatedAt.getTime() + after)

  it('ends as Not sent when the tidy pass archives its group', async () => {
    const f = await swarm()
    const waiting = await toWorker(f, 'One more thing.')
    f.clock.now += 40 * MINUTE
    await archiveFinishedGroups(db, f.timed, { state: async () => null, done: async () => {} }, f.clock.now)
    expect((await db.swarmGroup.findFirstOrThrow({ where: { tabId: f.tab, key: f.group } })).archived).toBe(true)
    expect(await status(waiting)).toBe('cancelled')
  })

  it('is ended by the delivery pass once its group is archived, even asleep, while one its recipient can read waits', async () => {
    const f = await swarm()
    const old = await toWorker(f, 'Left over.')
    const readable = await toLead(f, 'Still for you.')
    await f.execute({ type: 'conversation.archive', conversationId: f.group, archived: true })
    // As a backend from before this pass left it: archived and asleep with its delivery still queued.
    await db.superTabDelivery.update({ where: { id: old }, data: { status: 'queued' } })
    const part = await db.swarmGroup.findFirstOrThrow({ where: { tabId: f.tab, key: f.group } })
    await db.swarmGroup.update({ where: { id: part.id }, data: { dormant: true, data: { ...part.data as object, dormant: true } } })
    await settleStuckDeliveries(db, f.timed, f.clock.now)
    expect(await status(old)).toBe('cancelled')
    expect(await status(readable)).toBe('queued')
  })

  it('ends a claim its host has not touched for 10 minutes, and keeps one its host touched since', async () => {
    const f = await swarm()
    const id = await toLead(f, 'Claimed, then the host went away.')
    await f.timed.delivery(host, f.tab, f.lead, id, { type: 'claim', claimId: 'claim' })
    await settleAfter(f, id, 9 * MINUTE)
    expect(await status(id)).toBe('claimed')
    await settleAfter(f, id, 10 * MINUTE + 1_000)
    expect(await status(id)).toBe('cancelled')
  })

  it('ends a hold after an hour, or after a day while a person owes the agent an answer, and keeps why', async () => {
    const f = await swarm()
    const busy = await toLead(f, 'Held while the Lead works.')
    const asking = await toLead(f, 'Held while the Lead waits on a person.')
    for (const id of [busy, asking]) await f.timed.delivery(host, f.tab, f.lead, id, { type: 'claim', claimId: `claim-${id}` })
    await f.timed.delivery(host, f.tab, f.lead, busy, { type: 'hold', claimId: `claim-${busy}`, reason: 'team_waiting_idle' })
    await f.timed.delivery(host, f.tab, f.lead, asking, { type: 'hold', claimId: `claim-${asking}`, reason: 'team_waiting_user' })
    const heldAt = f.clock.now
    await settleStuckDeliveries(db, f.timed, heldAt + 59 * MINUTE)
    expect([await status(busy), await status(asking)]).toEqual(['claimed', 'claimed'])
    await settleStuckDeliveries(db, f.timed, heldAt + HOUR + MINUTE)
    expect(await db.superTabDelivery.findUniqueOrThrow({ where: { id: busy } })).toMatchObject({ status: 'cancelled', holdReason: 'team_waiting_idle' })
    expect(await status(asking)).toBe('claimed')
    await settleStuckDeliveries(db, f.timed, heldAt + 23 * HOUR)
    expect(await status(asking)).toBe('claimed')
    await settleStuckDeliveries(db, f.timed, heldAt + 24 * HOUR + MINUTE)
    expect(await db.superTabDelivery.findUniqueOrThrow({ where: { id: asking } })).toMatchObject({ status: 'cancelled', holdReason: 'team_waiting_user' })
  })

  it('counts a hold the pass ended as delivered once its host confirms it typed it', async () => {
    const f = await swarm()
    const id = await toLead(f, 'Held, then typed as the pass ends it.')
    await f.timed.delivery(host, f.tab, f.lead, id, { type: 'claim', claimId: 'claim' })
    await f.timed.delivery(host, f.tab, f.lead, id, { type: 'hold', claimId: 'claim', reason: 'team_waiting_idle' })
    // An hour on, the terminal frees: the host claims it again and types it, and the pass ends it before the host confirms.
    f.clock.now += HOUR + MINUTE
    await f.timed.delivery(host, f.tab, f.lead, id, { type: 'claim', claimId: 'claim' })
    await settleStuckDeliveries(db, f.timed, f.clock.now)
    expect(await status(id)).toBe('cancelled')
    await f.timed.delivery(host, f.tab, f.lead, id, { type: 'ack', claimId: 'claim', receipt: 'Typed.', uncertain: false })
    expect(await db.superTabDelivery.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: 'delivered', receipt: 'Typed.',
      deliveredAt: new Date(f.clock.now), holdReason: null })
  })

  // Prod 10-30: two hours of SWARM_BUSY kept hosts' acknowledgements out past the 10-minute quiet time. The pass ended claims
  // the agents had received, their senders saw Not sent and sent them again, and the agents acted twice.
  it('counts a quiet claim the pass ended as delivered once its host\'s acknowledgement gets through, and never types it again', async () => {
    const f = await swarm()
    const id = await toLead(f, 'Typed while the backend was busy.')
    await f.timed.delivery(host, f.tab, f.lead, id, { type: 'claim', claimId: 'claim' })
    await settleAfter(f, id, 10 * MINUTE + 1_000)
    expect(await db.superTabDelivery.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: 'cancelled', holdReason: 'claim_quiet', holdSince: null })
    await expect(f.timed.delivery(host, f.tab, f.lead, id, { type: 'claim', claimId: 'claim' })).rejects.toMatchObject({ code: 'DELIVERY_REVOKED' })
    await expect(f.timed.delivery(host, f.tab, f.lead, id, { type: 'ack', claimId: 'another', receipt: 'Typed.', uncertain: false }))
      .rejects.toMatchObject({ code: 'DELIVERY_REVOKED' })
    f.clock.now += 20 * MINUTE
    await f.timed.delivery(host, f.tab, f.lead, id, { type: 'ack', claimId: 'claim', receipt: 'Typed.', uncertain: false })
    expect(await db.superTabDelivery.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: 'delivered', receipt: 'Typed.',
      deliveredAt: new Date(f.clock.now), holdReason: null, claimId: 'claim' })
    // Delivered stays delivered: a later pass ends nothing, and the same acknowledgement again changes nothing.
    await settleAfter(f, id, 2 * HOUR)
    await f.timed.delivery(host, f.tab, f.lead, id, { type: 'ack', claimId: 'claim', receipt: 'Typed.', uncertain: false })
    expect(await status(id)).toBe('delivered')
  })

  it('never takes a late acknowledgement for a claim an archive ended, nor one the pass ended as unreadable, once the group is back', async () => {
    const f = await swarm()
    const archived = await toWorker(f, 'Ended by the archive.'), unread = await toWorker(f, 'Left claimed in the archived group.')
    for (const id of [archived, unread]) await f.timed.delivery(host, f.tab, f.worker, id, { type: 'claim', claimId: 'claim' })
    await f.execute({ type: 'conversation.archive', conversationId: f.group, archived: true })
    expect(await db.superTabDelivery.findUniqueOrThrow({ where: { id: archived } })).toMatchObject({ status: 'cancelled', holdReason: null })
    // As a backend from before the archive cancelled its deliveries left one: still claimed, quiet, in the archived group.
    await db.superTabDelivery.update({ where: { id: unread }, data: { status: 'claimed' } })
    await settleAfter(f, unread, 10 * MINUTE + 1_000)
    expect(await db.superTabDelivery.findUniqueOrThrow({ where: { id: unread } })).toMatchObject({ status: 'cancelled', holdReason: null })
    await f.execute({ type: 'conversation.archive', conversationId: f.group, archived: false })
    for (const id of [archived, unread]) {
      await expect(f.timed.delivery(host, f.tab, f.worker, id, { type: 'ack', claimId: 'claim', receipt: 'Typed.', uncertain: false }))
        .rejects.toMatchObject({ code: 'DELIVERY_REVOKED' })
      expect(await status(id)).toBe('cancelled')
    }
  })

  it('never takes a late acknowledgement for a quiet claim the pass ended from another agent, or once its agent left the group', async () => {
    const f = await swarm()
    const id = await toWorker(f, 'Typed, then the worker was taken off the task.')
    await f.timed.delivery(host, f.tab, f.worker, id, { type: 'claim', claimId: 'claim' })
    await settleAfter(f, id, 10 * MINUTE + 1_000)
    expect(await db.superTabDelivery.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: 'cancelled', holdReason: 'claim_quiet' })
    // The same claim id, sent as another agent of the same host: the delivery is looked up by its own agent, so it is not found.
    await expect(f.timed.delivery(host, f.tab, f.lead, id, { type: 'ack', claimId: 'claim', receipt: 'Typed.', uncertain: false }))
      .rejects.toMatchObject({ code: 'DELIVERY_REVOKED' })
    await f.execute({ type: 'conversation.agent', conversationId: f.group, agentId: f.worker, present: false, lead: false })
    await expect(f.timed.delivery(host, f.tab, f.worker, id, { type: 'ack', claimId: 'claim', receipt: 'Typed.', uncertain: false }))
      .rejects.toMatchObject({ code: 'DELIVERY_REVOKED' })
    expect(await db.superTabDelivery.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: 'cancelled', receipt: null })
  })

  it('never types a hold the pass ended: claiming it again is refused', async () => {
    const f = await swarm()
    const id = await toLead(f, 'Held and ended, never typed.')
    await f.timed.delivery(host, f.tab, f.lead, id, { type: 'claim', claimId: 'claim' })
    await f.timed.delivery(host, f.tab, f.lead, id, { type: 'hold', claimId: 'claim', reason: 'team_waiting_idle' })
    await settleStuckDeliveries(db, f.timed, f.clock.now + HOUR + MINUTE)
    await expect(f.timed.delivery(host, f.tab, f.lead, id, { type: 'claim', claimId: 'claim' })).rejects.toMatchObject({ code: 'DELIVERY_REVOKED' })
    await expect(f.timed.delivery(host, f.tab, f.lead, id, { type: 'ack', claimId: 'another', receipt: 'Typed.', uncertain: false }))
      .rejects.toMatchObject({ code: 'DELIVERY_REVOKED' })
    expect(await status(id)).toBe('cancelled')
  })

  it('ends an uncertain delivery nobody resolved within an hour', async () => {
    const f = await swarm()
    const id = await toLead(f, 'Maybe typed.')
    await f.timed.delivery(host, f.tab, f.lead, id, { type: 'claim', claimId: 'claim' })
    await f.timed.delivery(host, f.tab, f.lead, id, { type: 'ack', claimId: 'claim', receipt: 'Native paste was ambiguous.', uncertain: true })
    await settleAfter(f, id, 59 * MINUTE)
    expect(await status(id)).toBe('uncertain')
    await settleAfter(f, id, HOUR + MINUTE)
    expect(await status(id)).toBe('cancelled')
    // Ended for good: only a hold the pass ended comes back on its host's confirmation.
    await expect(f.timed.delivery(host, f.tab, f.lead, id, { type: 'ack', claimId: 'claim', receipt: 'Typed after all.', uncertain: false }))
      .rejects.toMatchObject({ code: 'DELIVERY_REVOKED' })
    expect(await status(id)).toBe('cancelled')
  })

  it('leaves a delivery its host typed or claimed again after the pass read it', async () => {
    const f = await swarm()
    const typed = await toLead(f, 'Typed as the pass reads it.')
    const reclaimed = await toLead(f, 'Claimed again as the pass reads it.')
    for (const id of [typed, reclaimed]) await f.timed.delivery(host, f.tab, f.lead, id, { type: 'claim', claimId: 'claim' })
    const read = await db.superTabDelivery.findMany({ where: { id: { in: [typed, reclaimed] } }, orderBy: { id: 'asc' } })
    await new Promise(resolve => setTimeout(resolve, 5))
    await f.timed.delivery(host, f.tab, f.lead, typed, { type: 'ack', claimId: 'claim', receipt: 'Typed.', uncertain: false })
    // A live host claims a claim it still holds again: that is what tells it from a claim nobody will type.
    await f.timed.delivery(host, f.tab, f.lead, reclaimed, { type: 'claim', claimId: 'claim' })
    expect(await f.timed.settleDeliveries(f.tab, read, Math.max(...read.map(r => r.updatedAt.getTime())) + HOUR)).toBe(0)
    expect([await status(typed), await status(reclaimed)]).toEqual(['delivered', 'claimed'])
  })

  it('ends a hold that is over even though its live host claimed it again after the pass read it', async () => {
    const f = await swarm()
    const id = await toLead(f, 'Held while the Lead works.')
    await f.timed.delivery(host, f.tab, f.lead, id, { type: 'claim', claimId: 'claim' })
    await f.timed.delivery(host, f.tab, f.lead, id, { type: 'hold', claimId: 'claim', reason: 'team_waiting_idle' })
    const read = await db.superTabDelivery.findUniqueOrThrow({ where: { id } })
    await new Promise(resolve => setTimeout(resolve, 5))
    // Its core refused the write while the terminal was busy, so the host claims it again on each poll (cli superTabs/host.ts).
    await f.timed.delivery(host, f.tab, f.lead, id, { type: 'claim', claimId: 'claim' })
    expect(await f.timed.settleDeliveries(f.tab, [read], f.clock.now + HOUR + MINUTE)).toBe(1)
    expect(await db.superTabDelivery.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: 'cancelled', holdReason: 'team_waiting_idle' })
  })

  // Prod 10-30, v1.3.71 (#2178): every Buddy claim answered SWARM_BUSY for two hours and nothing said so. A claim that fails
  // that way is now written on its delivery, outside the failed transaction (store.ts recordFailedClaim).
  describe('a claim that keeps failing', () => {
    /** Whether the stores from failingStore answer busy, and whether the record write itself is down. Reset before each test. */
    const busy = { on: false, recordDown: false, early: false, recordHangs: false }
    beforeEach(() => { busy.on = false; busy.recordDown = false; busy.early = false; busy.recordHangs = false })
    /** A store over the same database whose transactions answer busy while busy.on is set, as retryTransient ends 8 write
     *  conflicts. By default the real body runs first (its authorization checks included) and the answer comes at commit, rolling
     *  the body back; with busy.early the answer comes before any body runs. With busy.recordDown its single-document delivery
     *  writes throw too; with busy.recordHangs they never answer. */
    const failingStore = (f: Fixture) => {
      const proxy = new Proxy(db, { get: (target, key) => {
        const tooBusy = () => new SuperTabError('SWARM_BUSY', 'This Swarm is busy. Try again in a moment.', 503)
        if (key === '$transaction') return (body: (tx: unknown) => Promise<unknown>, ...rest: unknown[]) => {
          if (!busy.on) return (target.$transaction as (...a: unknown[]) => unknown)(body, ...rest)
          if (busy.early) return Promise.reject(tooBusy())
          return (target.$transaction as (...a: unknown[]) => unknown)(async (tx: unknown) => { await body(tx); throw tooBusy() }, ...rest)
        }
        if (key === 'superTabDelivery' && (busy.recordDown || busy.recordHangs)) return new Proxy(target.superTabDelivery, { get: (model, name) =>
          name === 'updateMany' ? () => busy.recordHangs ? new Promise(() => {}) : Promise.reject(new Error('down')) : Reflect.get(model, name) })
        return Reflect.get(target, key)
      } }) as PrismaClient
      busy.on = true
      return new SuperTabStore(proxy, () => f.clock.now)
    }
    const claim = { type: 'claim', claimId: 'c' } as const
    const claimFields = ['claimFailingSince', 'claimFailedAt', 'claimFailures', 'claimFailure'] as const
    const row = (id: string) => db.superTabDelivery.findUniqueOrThrow({ where: { id } })

    it('records a busy claim on its delivery, keeps when it began and counts each one', async () => {
      const f = await swarm(); const id = await toLead(f, 'Hi')
      const flaky = failingStore(f)
      await expect(flaky.delivery(host, f.tab, f.lead, id, claim)).rejects.toMatchObject({ code: 'SWARM_BUSY' })
      const first = f.clock.now
      f.clock.now += 30_000
      await expect(flaky.delivery(host, f.tab, f.lead, id, claim)).rejects.toMatchObject({ code: 'SWARM_BUSY' })
      expect(await row(id)).toMatchObject({ status: 'queued', claimFailingSince: new Date(first),
        claimFailedAt: new Date(first + 30_000), claimFailures: 2, claimFailure: 'SWARM_BUSY' })
    })
    it('clears the record once a claim gets in', async () => {
      const f = await swarm(); const id = await toLead(f, 'Hi')
      await expect(failingStore(f).delivery(host, f.tab, f.lead, id, claim)).rejects.toMatchObject({ code: 'SWARM_BUSY' })
      expect((await row(id)).claimFailures).toBe(1)
      await f.timed.delivery(host, f.tab, f.lead, id, claim)
      const claimed = await row(id)
      expect(claimed.status).toBe('claimed')
      // Unset, not null: the claim removes the keys, so "missing" stays a real absence that the first failure's isSet: false branch
      // matches (and starts the count at 0, since Prisma's increment of a missing count leaves it null). Prisma reads both as null.
      const [raw] = await db.superTabDelivery.findRaw({ filter: { _id: id } }) as unknown as Array<Record<string, unknown>>
      for (const field of claimFields) { expect(claimed[field], field).toBeNull(); expect(raw, field).not.toHaveProperty(field) }
    })
    it('records nothing for a delivery that is no longer queued, or for an ack', async () => {
      const f = await swarm(); const gone = await toLead(f, 'Gone'); const acked = await toLead(f, 'Acked')
      await db.superTabDelivery.update({ where: { id: gone }, data: { status: 'claimed', claimId: 'c' } })
      const flaky = failingStore(f)
      await expect(flaky.delivery(host, f.tab, f.lead, gone, claim)).rejects.toMatchObject({ code: 'SWARM_BUSY' })
      for (const field of claimFields) expect((await row(gone))[field], field).toBeNull()
      await f.timed.delivery(host, f.tab, f.lead, acked, claim)
      await expect(flaky.delivery(host, f.tab, f.lead, acked, { type: 'ack', claimId: 'c', receipt: 'r', uncertain: false })).rejects.toMatchObject({ code: 'SWARM_BUSY' })
      for (const field of claimFields) expect((await row(acked))[field], field).toBeNull()
    })
    it('records nothing when busy is answered before the request was authorized', async () => {
      const f = await swarm(); const id = await toLead(f, 'Hi')
      const flaky = failingStore(f); busy.early = true
      await expect(flaky.delivery(host, f.tab, f.lead, id, claim)).rejects.toMatchObject({ code: 'SWARM_BUSY' })
      for (const field of claimFields) expect((await row(id))[field], field).toBeNull()
    })
    it('answers busy within about 2 seconds even when the record write never returns', async () => {
      const f = await swarm(); const id = await toLead(f, 'Hi')
      const flaky = failingStore(f); busy.recordHangs = true
      const began = Date.now()
      await expect(flaky.delivery(host, f.tab, f.lead, id, claim)).rejects.toMatchObject({ code: 'SWARM_BUSY', status: 503 })
      expect(Date.now() - began).toBeLessThan(4_000)
    }, 15_000)
    it('still throws the busy answer when the record itself cannot be written, and says so', async () => {
      const f = await swarm(); const id = await toLead(f, 'Hi')
      const flaky = failingStore(f); busy.recordDown = true
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
      try {
        await expect(flaky.delivery(host, f.tab, f.lead, id, claim)).rejects.toMatchObject({ code: 'SWARM_BUSY', status: 503 })
        expect(warn).toHaveBeenCalledWith('[swarm-deliveries] could not record a failed claim', expect.objectContaining({ tabId: f.tab, deliveryId: id }))
      } finally { warn.mockRestore() }
    })
    it('hands claimFailingSince and claimFailures to page readers', async () => {
      const f = await swarm(); const id = await toLead(f, 'Hi')
      await expect(failingStore(f).delivery(host, f.tab, f.lead, id, claim)).rejects.toMatchObject({ code: 'SWARM_BUSY' })
      const page = await f.timed.messages(owner, f.tab, 'lead', {})
      const shown = page.messages.flatMap(m => m.deliveries).find(d => d.id === id)
      expect(shown).toMatchObject({ claimFailingSince: new Date(f.clock.now), claimFailures: 1 })
      expect(JSON.parse(JSON.stringify(shown))).toMatchObject({ claimFailingSince: new Date(f.clock.now).toISOString(), claimFailures: 1 })
    })
    it('raises claims failing for a delivery whose claims have failed 5 minutes and still fail, and cancels nothing', async () => {
      const f = await swarm(); const id = await toLead(f, 'Hi'); const flaky = failingStore(f)
      const began = f.clock.now
      await expect(flaky.delivery(host, f.tab, f.lead, id, claim)).rejects.toThrow()
      f.clock.now = began + 5 * MINUTE
      await expect(flaky.delivery(host, f.tab, f.lead, id, claim)).rejects.toThrow()
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
      try {
        await settleStuckDeliveries(db, f.timed, began + 5 * MINUTE + 1_000)
        // Earlier tests leave rows in the shared database; this Swarm's line is the one that counts.
        expect(warn).toHaveBeenCalledWith('[swarm-deliveries] claims failing',
          { tabId: f.tab, deliveries: 1, oldestFailingSince: new Date(began).toISOString(), codes: ['SWARM_BUSY'] })
        expect(await status(id)).toBe('queued')
      } finally { warn.mockRestore() }
    })
    it('says nothing for a claim failing under 5 minutes, or one whose last failure is over 5 minutes old', async () => {
      const f = await swarm(); const young = await toLead(f, 'Young'); const old = await toLead(f, 'Old')
      const now = f.clock.now + 10 * MINUTE
      await db.superTabDelivery.update({ where: { id: young }, data: { claimFailingSince: new Date(now - 4 * MINUTE),
        claimFailedAt: new Date(now - 1_000), claimFailures: 3, claimFailure: 'SWARM_BUSY' } })
      await db.superTabDelivery.update({ where: { id: old }, data: { claimFailingSince: new Date(now - 20 * MINUTE),
        claimFailedAt: new Date(now - 6 * MINUTE), claimFailures: 9, claimFailure: 'SWARM_BUSY' } })
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
      try {
        await settleStuckDeliveries(db, f.timed, now)
        expect(warn.mock.calls.filter(([line, fields]) => line === '[swarm-deliveries] claims failing' && (fields as { tabId: string }).tabId === f.tab)).toEqual([])
        expect(await status(young)).toBe('queued'); expect(await status(old)).toBe('queued')
      } finally { warn.mockRestore() }
    })
  })
})
