import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { MongoMemoryReplSet } from 'mongodb-memory-server-core'
import { PrismaClient } from '@prisma/client'
import type { AuthUser } from '../src/lib/ssoAuth.js'
import { SuperTabStore, transaction } from '../src/superTabs/store.js'
import { SwarmReads } from '../src/superTabs/read/service.js'
import type { Command } from '../src/superTabs/commands.js'
import { poolRows } from './hostRows.test-support.js'
import { settleStuckDeliveries } from '../src/superTabs/deliverySettle.js'
import { compactDeliveries } from '../src/superTabs/deliveryCompaction.js'
import { revokeNativeContexts } from '../src/superTabs/native.js'
import { stableId, type MessageDraft, type SuperTabState } from '../src/superTabs/model.js'
import { logger } from '../src/utils/logger.js'
import { wantSchedule } from './noDefaultDigest.test-support.js'
import { SCHEDULE_SLOT_MS, scheduleSlot } from '../src/superTabs/pmSchedule.js'

// Ken, 2026-11-04 (docs/plans/2026-11-04-pm-built-in-schedule-design.md): the coordinator's poll wakes it every 30 minutes for
// the built-in schedule when the sweep has something to do, in one message per poll. A fresh loopback replica set, created here.
let replica: MongoMemoryReplSet
let db: PrismaClient
const owner: AuthUser = { sub: '210000000000000000000001', email: 'owner@example.com', autonomousEnv: 'prod', role: 'user' }
const host: AuthUser = { sub: '210000000000000000000003', email: 'host@example.com', autonomousEnv: 'prod', role: 'user' }
const config = { engine: 'codex', model: 'fixture-model', effort: 'high', contextWindow: 200000, engineVersion: 'fixture' }
const MINUTE = 60_000
const DUE = 5 * MINUTE

beforeAll(async () => {
  replica = await MongoMemoryReplSet.create({ binary: { version: '7.0.24', downloadDir: join(tmpdir(), 'harness-super-tab-mongodb-binaries') },
    replSet: { count: 1, ip: '127.0.0.1', storageEngine: 'wiredTiger' } })
  const uri = replica.getUri(`swarm_schedule_test_${randomUUID().replaceAll('-', '_')}`)
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

/** A Swarm whose coordinator runs on one machine and whose worker, on another, works on task "Ship the parser". The coordinator's
 *  first update request (for the assignment) has gone, so nothing merges with a digest in the next 15 minutes, unless [fresh]. */
async function swarm({ fresh = false, told }: { fresh?: boolean; told?: string[] } = {}) {
  let now = Date.parse('2026-11-02T06:30:00.000Z')
  const timed = new SuperTabStore(db, () => now, null, told ? { deliveriesWaiting: w => { told.push(w.agentId) } } : {})
  const tab = (await timed.create(owner, randomUUID(), 'Digest', 'public')).id
  const execute = (command: Command, user = owner, asAgentId?: string) => timed.execute(user, tab, { operationId: randomUUID(), command }, asAgentId)
  const invitation = await execute({ type: 'invite.create', email: host.email, role: 'collaborator', conversationId: 'lead' })
  await execute({ type: 'invite.accept', inviteId: invitation.result.inviteId as string }, host)
  for (const [machineId, name] of [['lead-host', 'Lead Mac'], ['test-host', 'Worker Mac']]) {
    await execute({ type: 'machine.contribute', machineId: machineId!, name: name!, cwd: '/repo', engines: ['codex'], maxAgents: 4 }, host)
  }
  const generations = new Map<string, string>()
  for (const machineId of ['lead-host', 'test-host']) generations.set(machineId, (await poolRows(timed, host, machineId)).find(p => p.tabId === tab)!.machine.generation)
  const harnessOf = new Map<string, string>()
  const add = async (conversationId: string, machineId: string, name: string, lead = false) => {
    const harnessId = randomUUID()
    const agentId = String((await execute({ type: 'agent.add', conversationId, machineId, harnessId, name, configuration: config, lead })).result.agentId)
    harnessOf.set(machineId, harnessId)
    return agentId
  }
  const lead = await add('lead', 'lead-host', 'Lead', true)
  const group = String((await execute({ type: 'conversation.create', title: 'Ship the parser', brief: 'Implement it',
    checks: [] })).result.conversationId)
  const worker = await add(group, 'test-host', 'Worker')
  const assignmentId = String((await execute({ type: 'work.assign', conversationId: group, agentId: worker })).result.assignmentId)
  const clock = { get now() { return now }, set now(value: number) { now = value } }
  /** Its machines report, as live ones do. */
  const report = async () => {
    // Its own first: a machine's report also judges the others', and one not heard from in 2 minutes loses its work.
    for (const machineId of ['test-host', 'lead-host']) await timed.observeMachine(host, tab, machineId, { generation: generations.get(machineId)!,
      resources: { cpuPercent: 10, memoryTotalBytes: 32e9, memoryUsedBytes: 4e9, diskFreeBytes: 120e9, diskTotalBytes: 500e9, projectDiskFreeBytes: 120e9, deviceType: 'Laptop', chip: 'Fixture', os: 'macOS', gpuPercent: null },
      quotas: [], tools: {}, runningHarnessIds: [harnessOf.get(machineId)!], stoppedHarnessIds: [] })
  }
  const poll = async () => {
    // Its worker keeps saying where it is, as a live one does; a finished task refuses the line and nothing changes.
    await execute({ type: 'work.status', conversationId: group, assignmentId, status: 'working', result: randomUUID() }, host, worker).catch(() => {})
    await report()
    return timed.deliveries(host, tab, lead)
  }
  const status = (s: 'done' | 'blocked' | 'needs_human' | 'working', result = 'A result') =>
    execute({ type: 'work.status', conversationId: group, assignmentId, status: s, result }, host, worker)
  if (!fresh) {
    clock.now += DUE + 1_000
    await poll()
    const early = await rowsOf(tab, { status: 'gathered' })
    expect(await Promise.all(early.map(d => db.superTabMessage.findUnique({ where: { id: d.messageId } }).then(m => [m?.text, m?.source])))).toEqual([])
  }
  /** Writes one message as the store writes every message, for a notice no short command here sets off. */
  const write = async (source: Record<string, unknown> | undefined, recipient: string, conversationId = group, text = 'A notice.', as = worker) => {
    const id = randomUUID().replaceAll('-', '').slice(0, 24)
    await transaction(db, async tx => {
      const store = timed as unknown as { load(tx: unknown, user: AuthUser, tab: string, named?: unknown): Promise<{ state: SuperTabState }>
        writeMessages(tx: unknown, tab: string, state: SuperTabState, messages: MessageDraft[], sequences: Map<string, number>): Promise<void> }
      const { state } = await store.load(tx, host, tab, { groupIds: [conversationId] })
      const sender = state.agents.find(a => a.id === as)!
      await store.writeMessages(tx, tab, state, [{ id, conversationId, text, replyTo: null, recipients: [recipient], ...source ? { source } : {},
        author: { kind: 'agent', id: as, name: sender.name, displayName: sender.name, membershipGeneration: sender.membershipGeneration } } as MessageDraft],
      new Map([[id, 90_000 + Math.floor(Math.random() * 100_000)]]))
    })
    return id
  }
  return { timed, tab, execute, lead, group, worker, assignmentId, clock, poll, status, write, add }
}

const rowsOf = (tabId: string, where: Record<string, unknown> = {}) => db.superTabDelivery.findMany({ where: { tabId, ...where }, orderBy: { createdAt: 'asc' } })
const deliveryOf = (messageId: string, agentId: string) => db.superTabDelivery.findUniqueOrThrow({ where: { id: stableId(messageId, agentId) } })
const kindOf = (message: { source: unknown }) => (message.source as { kind?: string } | null)?.kind
const digests = async (tabId: string) => (await db.superTabMessage.findMany({ where: { tabId }, orderBy: { sequence: 'asc' } })).filter(m => kindOf(m) === 'notice-digest')

const schedules = async (tabId: string) => (await db.superTabMessage.findMany({ where: { tabId }, orderBy: { sequence: 'asc' } }))
  .filter(m => m.text.includes('Built-in schedule,'))
/** The head part's version and time: what every reader compares to know whether anything changed. */
const headOf = async (tabId: string) => db.swarmHead.findUniqueOrThrow({ where: { id: `${tabId}:head` }, select: { version: true, changedAt: true } })
const projectOf = async (f: Awaited<ReturnType<typeof swarm>>) => (await f.timed.read(host, f.tab, undefined, f.lead)).state.projects![0]!
/** A task with no agent: what the sweep is for. */
const unassigned = (f: Awaited<ReturnType<typeof swarm>>) => f.execute({ type: 'conversation.create', title: 'Nobody has this', brief: 'Do it', checks: [] })

describe('the built-in schedule on the coordinator\'s poll', () => {
  it('wakes the coordinator once per slot, as its own message when nothing else goes', async () => {
    const f = await swarm()
    wantSchedule()
    await unassigned(f)
    const inbox = await f.poll()
    const [wake] = await schedules(f.tab)
    expect(wake).toBeDefined()
    expect(kindOf(wake!)).toBe('schedule-request')
    expect(wake!.recipientIds).toEqual([f.lead])
    expect(inbox.map(d => d.messageId)).toContain(wake!.id)
    f.clock.now += MINUTE
    await f.poll()
    expect(await schedules(f.tab)).toHaveLength(1)
    expect((await projectOf(f)).schedule).toMatchObject({ lastSlot: scheduleSlot(f.clock.now) })
  })

  it('is the coordinator\'s alone: no person sees it in the chat, and no other agent reads it', async () => {
    const f = await swarm()
    wantSchedule()
    await unassigned(f)
    await f.poll()
    const [wake] = await schedules(f.tab)
    const page = async (user: AuthUser, asAgentId?: string) => (await f.timed.messages(user, f.tab, 'lead', { messageId: wake!.id }, asAgentId)).messages.map(m => m.id)
    expect(await page(host, f.lead)).toEqual([wake!.id])
    for (const user of [owner, host]) expect(await page(user)).toEqual([])
    expect(await page(host, f.worker)).toEqual([])
  })

  it('writes nothing to the Swarm\'s head and sends nothing when every task has an agent working on it', async () => {
    const f = await swarm()
    wantSchedule()
    await f.poll()
    f.clock.now += SCHEDULE_SLOT_MS
    // Every reader rereads a head that moved: a slot with nothing due must leave it as it was (#2946 review, 1).
    const before = await headOf(f.tab)
    await f.poll()
    expect(await schedules(f.tab)).toEqual([])
    expect(await headOf(f.tab)).toEqual(before)
    expect((await projectOf(f)).schedule).toBeUndefined()
    // Something to sweep later in the same slot wakes it once.
    await unassigned(f)
    await f.poll()
    expect(await schedules(f.tab)).toHaveLength(1)
  })

  it('keeps the slot out of the head readers get', async () => {
    const f = await swarm()
    wantSchedule()
    await unassigned(f)
    await f.poll()
    expect((await projectOf(f)).schedule).toMatchObject({ lastSlot: scheduleSlot(f.clock.now) })
    const reads = new SwarmReads(f.timed)
    for (const [user, asAgentId] of [[owner], [host], [host, f.lead]] as const) {
      const { head } = await reads.firstLoad(user, f.tab, asAgentId)
      expect(head.data.projects!.map(p => 'schedule' in p)).toEqual([false])
    }
  })

  it('sends no second wake while the first is unread, and still moves the slot', async () => {
    const f = await swarm()
    wantSchedule()
    await unassigned(f)
    await f.poll()
    f.clock.now += SCHEDULE_SLOT_MS
    await f.poll()
    expect(await schedules(f.tab)).toHaveLength(1)
    expect((await projectOf(f)).schedule).toMatchObject({ lastSlot: scheduleSlot(f.clock.now) })
  })

  it('sends no second wake over three slots while the first is unread', async () => {
    const f = await swarm()
    wantSchedule()
    await unassigned(f)
    await f.poll()
    for (const _ of [1, 2]) { f.clock.now += SCHEDULE_SLOT_MS; await f.poll() }
    expect(await schedules(f.tab)).toHaveLength(1)
  })

  it('sends no wake of its own while the update request that carried the last one is unread', async () => {
    const f = await swarm({ fresh: true })
    wantSchedule()
    await unassigned(f)
    f.clock.now += DUE
    await f.poll()
    f.clock.now += SCHEDULE_SLOT_MS
    await f.poll()
    expect((await schedules(f.tab)).map(kindOf)).toEqual(['update-request'])
  })

  it('goes in the update request when one is written in the same poll', async () => {
    // Fresh: the setup's own update request would still wait for its answer, and no second one goes meanwhile.
    const f = await swarm({ fresh: true })
    wantSchedule()
    await unassigned(f)
    f.clock.now += DUE
    await f.poll()
    const [wake] = await schedules(f.tab)
    expect(kindOf(wake!)).toBe('update-request')
    expect(wake!.source).toMatchObject({ kind: 'update-request', schedule: scheduleSlot(f.clock.now) })
    expect(wake!.text.indexOf('Work changed')).toBeLessThan(wake!.text.indexOf('Built-in schedule,'))
    expect((await db.superTabMessage.findMany({ where: { tabId: f.tab } })).filter(m => kindOf(m) === 'schedule-request')).toEqual([])
  })

  it('goes in the notice digest when one is written and no update request is', async () => {
    const f = await swarm()
    wantSchedule()
    await f.write({ kind: 'idle' }, f.lead)
    await unassigned(f)
    f.clock.now += DUE
    await f.poll()
    const [digest] = await digests(f.tab)
    expect(digest!.text).toContain('Built-in schedule,')
    expect(digest!.source).toMatchObject({ kind: 'notice-digest', schedule: scheduleSlot(f.clock.now) })
    expect(await schedules(f.tab)).toHaveLength(1)
  })

  it('does not go in an update request already stored under its id', async () => {
    const f = await swarm({ fresh: true })
    wantSchedule()
    await f.write({ kind: 'idle' }, f.lead)
    await unassigned(f)
    f.clock.now += DUE
    const { projectUpdateRequest } = await import('../src/superTabs/projectUpdates.js')
    const { state } = await f.timed.read(host, f.tab, undefined, f.lead)
    const draft = projectUpdateRequest(state, state.agents.find(a => a.id === f.lead)!, f.clock.now)!
    await db.superTabMessage.create({ data: { id: draft.id, tabId: f.tab, conversationId: draft.conversationId, sequence: 1, text: draft.text, replyTo: null, recipientIds: draft.recipients,
      mentions: [], thread: draft.id, source: draft.source as object, author: draft.author as object } })
    await f.poll()
    expect((await db.superTabMessage.findUniqueOrThrow({ where: { id: draft.id } })).text).not.toContain('Built-in schedule,')
    expect(await schedules(f.tab)).toHaveLength(1)
  })

  it('sends nothing in a paused Swarm, and one wake for the current slot once it resumes', async () => {
    const f = await swarm()
    wantSchedule()
    await unassigned(f)
    await f.execute({ type: 'tab.pause', paused: true })
    await f.poll()
    f.clock.now += 3 * SCHEDULE_SLOT_MS
    await f.poll()
    expect(await schedules(f.tab)).toEqual([])
    await f.execute({ type: 'tab.pause', paused: false })
    await f.poll()
    expect(await schedules(f.tab)).toHaveLength(1)
    expect((await projectOf(f)).schedule).toMatchObject({ lastSlot: scheduleSlot(f.clock.now) })
  })
})
