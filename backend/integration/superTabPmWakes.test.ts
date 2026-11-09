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

// Swarm v4 (anh Dee 2026-11-09): the server wakes no PM for a built-in schedule, a daily tidy or a morning digest, and sends it no
// "what changed for PMs" note. A fresh loopback replica set, created here.
let replica: MongoMemoryReplSet
let db: PrismaClient
const owner: AuthUser = { sub: '210000000000000000000001', email: 'owner@example.com', autonomousEnv: 'prod', role: 'user' }
const host: AuthUser = { sub: '210000000000000000000003', email: 'host@example.com', autonomousEnv: 'prod', role: 'user' }
const config = { engine: 'codex', model: 'fixture-model', effort: 'high', contextWindow: 200000, engineVersion: 'fixture' }
const MINUTE = 60_000

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
 *  first poll is a full one ([fresh] is kept for callers: no update request goes with the setup any more, task #3593). */
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
    // Added by the host, whose machines they run on: an agent is its own person's, on their own computer (task #4120).
    const agentId = String((await execute({ type: 'agent.add', conversationId, machineId, harnessId, name, configuration: config, lead }, host)).result.agentId)
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
    // The worker's time checks run every 30 s (timeChecks.ts): one runs before each poll here.
    await timed.runTimeChecks(tab)
    return timed.deliveries(host, tab, lead)
  }
  const status = (s: 'done' | 'blocked' | 'needs_human' | 'working', result = 'A result') =>
    execute({ type: 'work.status', conversationId: group, assignmentId, status: s, result }, host, worker)
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
describe('the coordinator\'s poll', () => {
  it('sends no built-in schedule, tidy request, digest or process note, however long it waits', async () => {
    const f = await swarm()
    await unassigned(f)
    f.clock.now += 26 * 60 * MINUTE
    await f.poll()
    const sent = await db.superTabMessage.findMany({ where: { tabId: f.tab, recipientIds: { has: f.lead } } })
    expect(sent.filter(m => /Built-in schedule|daily tidy|What changed for PMs|digest/i.test(m.text) || ['schedule-request', 'tidy-request', 'digest'].includes(kindOf(m) ?? ''))).toEqual([])
  })
})
