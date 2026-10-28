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
import type { Conversation } from '../src/superTabs/model.js'
import type { MachineObservation } from '../src/superTabs/machines.js'
import { poolRows, rosterRows } from './hostRows.test-support.js'
import { archiveFinishedGroups, markFinishedGroups, type PullRequestState } from '../src/superTabs/archive.js'

// Nobody tidies a Swarm by hand: a worker idle for 15 minutes is stopped on its Lead's poll and its host is asked to close
// it. A fresh loopback replica set, created here.
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
    .filter(m => (m.source as { kind?: string } | null)?.kind === 'idle-stop')
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

describe('a worker left idle', () => {
  it('is stopped on its Lead\'s poll 15 minutes after its last activity, and its host is asked to close it', async () => {
    const f = await swarm()
    f.clock.now += 14 * MINUTE
    await f.observe('test-host', [f.harness.worker], { harnessUncommitted: { [f.harness.worker]: false } })
    await f.timed.deliveries(host, f.tab, f.lead)
    expect((await f.member()).workDecision).toBe('awaiting')
    f.clock.now += MINUTE + 1_000
    await f.observe('test-host', [f.harness.worker], { harnessUncommitted: { [f.harness.worker]: false } })
    await f.timed.deliveries(host, f.tab, f.lead)
    const member = await f.member()
    expect(member.workDecision).toBe('stop')
    expect((await rosterRows(f.timed, host, 'test-host')).find(r => r.agent.id === f.worker)!.agent).toMatchObject({ releaseId: member.releaseId })
    expect(await f.lines()).toEqual([expect.objectContaining({ conversationId: f.group, recipientIds: [], text: 'Worker stopped: no work for 15 minutes.' })])
    // A second poll finds it already stopping and writes nothing more.
    f.clock.now += MINUTE
    await f.timed.deliveries(host, f.tab, f.lead)
    expect(await f.lines()).toHaveLength(1)
  })

  it('is kept while its host reports uncommitted changes, or does not say', async () => {
    const f = await swarm()
    f.clock.now += 20 * MINUTE
    await f.observe('test-host', [f.harness.worker], { harnessUncommitted: { [f.harness.worker]: true } })
    await f.timed.deliveries(host, f.tab, f.lead)
    expect((await f.member()).workDecision).toBe('awaiting')
    f.clock.now += MINUTE
    await f.observe('test-host', [f.harness.worker])
    await f.timed.deliveries(host, f.tab, f.lead)
    expect((await f.member()).workDecision).toBe('awaiting')
  })

  it('is kept while a message waits for it', async () => {
    const f = await swarm()
    f.clock.now += 20 * MINUTE
    await f.observe('test-host', [f.harness.worker], { harnessUncommitted: { [f.harness.worker]: false } })
    // Written straight into the queue, as a delivery from a moment ago that its host has not picked up yet.
    await db.superTabDelivery.create({ data: { id: randomUUID(), tabId: f.tab, conversationId: f.group, messageId: randomUUID(), agentId: f.worker,
      machineId: 'test-host', machineOwnerId: host.sub, assignmentId: null, membershipGeneration: 'g', authorKind: 'person', authorId: owner.sub, authorGeneration: 'g' } })
    await f.timed.deliveries(host, f.tab, f.lead)
    expect((await f.member()).workDecision).toBe('awaiting')
  })

  it('is kept, as a Reviewer, while the work it reviews is open, even once its review group was archived', async () => {
    const f = await swarm()
    const reviewed = String((await f.execute({ type: 'conversation.create', title: 'Parser v2', brief: 'More parsing',
      checks: [{ description: 'Verified', independent: false }] })).result.conversationId)
    const builder = await f.add(reviewed, 'test-host', randomUUID(), 'Builder')
    const work = String((await f.execute({ type: 'work.assign', conversationId: reviewed, agentId: builder })).result.assignmentId)
    const review = String((await f.execute({ type: 'conversation.create', title: 'Review: Parser v2', brief: 'Review it', reviewOf: reviewed,
      checks: [{ description: 'Verdict', independent: false }] })).result.conversationId)
    const reviewerHarness = randomUUID()
    const reviewer = await f.add(review, 'test-host', reviewerHarness, 'Reviewer')
    await f.started(reviewer, { role: 'reviewer' })
    const verdict = String((await f.execute({ type: 'work.assign', conversationId: review, agentId: reviewer })).result.assignmentId)
    await f.execute({ type: 'work.cancel', conversationId: review, assignmentId: verdict, reason: 'Verdict given' })
    await f.execute({ type: 'conversation.archive', conversationId: review, archived: true })
    // Asleep, as the hourly sweep leaves an archived group once its Lead read its reports: ordinary loads leave it out.
    const part = await db.swarmGroup.findFirstOrThrow({ where: { tabId: f.tab, key: review } })
    await db.swarmGroup.update({ where: { id: part.id }, data: { dormant: true, data: { ...part.data as object, dormant: true } } })
    await f.delivered()
    const reviewerOf = async () => (await f.timed.read(owner, f.tab)).state.agents.find(a => a.id === reviewer)!
    const poll = async () => {
      await f.observe('test-host', [f.harness.worker, reviewerHarness], { harnessUncommitted: { [f.harness.worker]: false, [reviewerHarness]: false } })
      await f.timed.deliveries(host, f.tab, f.lead)
    }
    f.clock.now += 20 * MINUTE
    await poll()
    expect((await reviewerOf()).workDecision).not.toBe('stop')
    // The reviewed work ends: no re-check can come, and the Reviewer has been idle long enough.
    await f.execute({ type: 'work.cancel', conversationId: reviewed, assignmentId: work, reason: 'Dropped' })
    await f.delivered()
    f.clock.now += MINUTE
    await poll()
    expect((await reviewerOf()).workDecision).toBe('stop')
  })

  it('is kept once the owner turned tidying off', async () => {
    const f = await swarm()
    await f.execute({ type: 'tab.tidy', enabled: false })
    f.clock.now += 20 * MINUTE
    await f.observe('test-host', [f.harness.worker], { harnessUncommitted: { [f.harness.worker]: false } })
    await f.timed.deliveries(host, f.tab, f.lead)
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
  // Linked on purpose by the Lead's record; a message only naming a pull request never links it (#558).
  const linkPr = (f: Awaited<ReturnType<typeof swarm>>) => f.execute({ type: 'conversation.merged', conversationId: f.group, pullRequestUrl: PR })

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
      text: 'Archived: the work is cancelled (Done elsewhere) and its pull requests are merged or closed.' })])
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

  it('stays open while a person\'s decision asked there waits', async () => {
    const f = await swarm()
    await db.superTabDecision.create({ data: { id: randomUUID(), tabId: f.tab, batchId: 'b', conversationId: f.group, projectId: 'p', personId: owner.sub,
      askerAgentId: f.lead, assignmentId: null, question: 'Ship it?', options: ['Yes', 'No'], recommended: 0, unblocks: 'Release', createdAt: new Date(f.clock.now) } })
    f.clock.now += 40 * MINUTE
    await archiveFinishedGroups(db, f.timed, github({}), f.clock.now)
    expect(await archived(f)).toBe(false)
  })

  it('stays open while its task is lost, even marked finished, so unfinished work never closes silently', async () => {
    const f = await swarm()
    const lost = String((await f.execute({ type: 'conversation.create', title: 'Round tabs', brief: 'Drop closed tabs', checks: [{ description: 'Verified', independent: false }] })).result.conversationId)
    const worker = await f.add(lost, 'test-host', randomUUID(), 'Dial')
    await f.execute({ type: 'work.assign', conversationId: lost, agentId: worker })
    const part = await db.swarmGroup.findFirstOrThrow({ where: { tabId: f.tab, key: lost } })
    const data = part.data as unknown as Conversation
    await db.swarmGroup.update({ where: { id: part.id }, data: { workFinished: true,
      data: { ...data, assignment: { ...data.assignment!, status: 'lost', lost: { reason: 'its model keeps failing', at: f.clock.now } } } as object } })
    f.clock.now += 40 * MINUTE
    await archiveFinishedGroups(db, f.timed, github({}), f.clock.now)
    expect((await db.swarmGroup.findUniqueOrThrow({ where: { id: part.id } })).archived).toBe(false)
    expect(await archived(f)).toBe(true)
  })

  it('tags the person who asked for a cancelled task, with the reason, when it archives', async () => {
    const f = await swarm()
    f.clock.now += 40 * MINUTE
    await archiveFinishedGroups(db, f.timed, github({}), f.clock.now)
    const [line] = await archiveLines(f)
    expect(line).toMatchObject({ text: 'Archived: the work is cancelled (Done elsewhere).', mentions: [owner.sub] })
    expect(await db.superTabMention.findMany({ where: { tabId: f.tab, conversationId: f.group } }))
      .toEqual([expect.objectContaining({ personId: owner.sub, messageId: line!.id, resolvedAt: null })])
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

describe('the archive pass', () => {
  it('reads each pull request once however many groups link it', async () => {
    const PR = 'https://github.com/acme/app/pull/9'
    const f = await swarm()
    const second = String((await f.execute({ type: 'conversation.create', title: 'Docs', brief: 'Docs too', checks: [{ description: 'Verified', independent: false }] })).result.conversationId)
    const worker2 = await f.add(second, 'test-host', randomUUID(), 'Writer')
    const work = String((await f.execute({ type: 'work.assign', conversationId: second, agentId: worker2 })).result.assignmentId)
    await f.execute({ type: 'work.cancel', conversationId: second, assignmentId: work, reason: 'Done elsewhere' })
    for (const group of [f.group, second]) await f.execute({ type: 'conversation.merged', conversationId: group, pullRequestUrl: PR })
    const read: string[] = []
    f.clock.now += 40 * MINUTE
    await archiveFinishedGroups(db, f.timed, { state: async url => { read.push(url); return 'open' }, done: async () => {} }, f.clock.now)
    // Other tests' Swarms share this database, with links of their own.
    expect(read.filter(url => url === PR)).toEqual([PR])
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
