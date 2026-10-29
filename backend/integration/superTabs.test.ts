import { createHash, randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterAll, beforeAll, describe, expect, it, onTestFinished, vi } from 'vitest'
import { MongoMemoryReplSet } from 'mongodb-memory-server-core'
import { PrismaClient } from '@prisma/client'
import Fastify, { type FastifyInstance } from 'fastify'
import type { AuthUser } from '../src/lib/ssoAuth.js'
import { ABANDONED_START_MS, GrantReads, SuperTabStore } from '../src/superTabs/store.js'
import { HostReads } from '../src/superTabs/read/host.js'
import { MemoryAttachmentStore } from '../src/superTabs/attachments.js'
import { superTabRoutes } from '../src/routes/superTabs.js'
import { errorHandler } from '../src/middlewares/errorHandler.js'
import type { Command } from '../src/superTabs/commands.js'
import { nextMachineShareGrants } from '../src/lib/machineSharePolicy.js'
import { DEFAULT_ROUTING_POLICY } from '../src/superTabs/routingPolicy.js'
import { stableId, type SuperTabState } from '../src/superTabs/model.js'
import { ensureTerminalExpiry, TERMINAL_EXPIRY_MS } from '../src/superTabs/terminal.js'
import { ensureMentionExpiry, MENTION_EXPIRY_MS } from '../src/superTabs/mentions.js'
import * as parts from '../src/superTabs/parts/index.js'
import { swarmTransaction } from '../src/superTabs/cache.js'
import { guardedWrite, PartConflict } from '../src/superTabs/parts/write.js'
import { ensurePartExpiry, sweepSwarms } from '../src/superTabs/sweeps.js'
import { assignmentRows, poolRows, rosterRows } from './hostRows.test-support.js'
import { recipientShare } from '../src/routes/harnessShares.js'
import { beforeFirstWrite } from './interleave.test-support.js'

// A fresh loopback replica set, created here. This suite never reads DATABASE_URL or an existing database.
let replica: MongoMemoryReplSet
let db: PrismaClient
let recordQuery = (_query: string) => {}
let store: SuperTabStore
let app: FastifyInstance
const owner: AuthUser = { sub: '100000000000000000000001', email: 'owner@example.com', autonomousEnv: 'prod', role: 'user' }
const peer: AuthUser = { sub: '100000000000000000000002', email: 'peer@example.com', autonomousEnv: 'prod', role: 'user' }
const host: AuthUser = { sub: '100000000000000000000003', email: 'host@example.com', autonomousEnv: 'prod', role: 'user' }
const config = { engine: 'codex', model: 'fixture-model', effort: 'high', contextWindow: 200000, engineVersion: 'fixture' }
const run = (tab: string, command: Command, user = owner, asAgentId?: string, operationId = randomUUID()) =>
  store.execute(user, tab, { operationId, command }, asAgentId)
async function fixture() {
  const tab = (await store.create(owner, randomUUID(), 'Pilot')).id
  const lead = (await run(tab, { type: 'agent.add', conversationId: 'lead', machineId: 'test-host', harnessId: randomUUID(),
    name: 'Lead', configuration: config, lead: true })).result.agentId as string
  return { tab, lead }
}
async function routedStart(tab: string, lead: string, role?: 'reviewer') {
  const decision = { assessment: { difficulty: 'low', risk: 'low', why: 'Small task.' },
    candidates: [{ id: 'c0', kind: 'new', machineId: 'test-host', engine: 'codex', model: 'fixture-model', effort: 'high',
      quality: 2, cost: 2, title: 'New agent', label: 'New agent' }],
    excluded: [], floor: 1, notes: false, pick: 'c0', via: 'only', p: null, belowFloor: false, why: 'Only candidate.' }
  const routeDecisionId = String((await run(tab, { type: 'route.record', conversationId: 'lead', decision } as Command, host, lead)).result.routeDecisionId)
  const request = { conversationId: 'lead', machineId: 'test-host', engine: 'codex', model: 'fixture-model', effort: 'high',
    name: 'Builder', cwd: '/fixture/repo', worktree: false, ...(role ? { role } : {}),
    requirements: { memoryBytes: 0, diskBytes: 0, maxCpuPercent: 100, tools: [], devices: [], quotaRequired: false } }
  const startId = String((await run(tab, { type: 'agent.start', request, routeDecisionId } as Command, host, lead)).result.startId)
  return { routeDecisionId, startId }
}
const message = (text: string): Command => ({ type: 'message.send', conversationId: 'lead', text, replyTo: null, recipientIds: [] })
/** Makes [machineId], a machine of `host`'s, one used only for agents (`harness team on`) for this test: its account row
 *  is a team machine and it reports from its team session with that privacy, so it may take the owner's projects
 *  (docs/plans/2026-10-24-swarm-team-account.md, Task 3). A teammate's work runs only on such a machine. Its host routes then
 *  take its team session alone, never its owner's own sign-in (security review 2 of #2089). */
async function teamMachine(machineId: string) {
  const computerId = createHash('sha256').update(machineId).digest('hex').slice(0, 32)
  await db.machine.update({ where: { machineId }, data: { computerId, sessionKind: 'team' } })
  onTestFinished(async () => { await db.machine.update({ where: { machineId }, data: { computerId: null, sessionKind: null } }) })
  const session: AuthUser = { ...host, harnessSessionId: `team-${machineId}`, harnessSessionKind: 'team', harnessComputerId: computerId }
  return { session, privacy: { mode: 'dedicated' as const } }
}
/** A Swarm's whole state as its parts hold it, dormant groups included (test helper: the store keeps no single document). */
async function storedState(tab: string): Promise<SuperTabState> {
  return parts.reassemble(await db.$transaction(tx => parts.loadAll(tx, tab)))
}
/** Replaces a Swarm's parts with `state`, as an older release or the migration would have left them. Versions keep rising. */
async function saveState(tab: string, state: SuperTabState) {
  await swarmTransaction(db, async tx => {
    const current = await parts.loadAll(tx, tab)
    const version = Math.max(current.head.version, ...[...current.members, ...current.agents, ...current.groups, ...current.machines,
      ...current.starts, ...current.progress].map(p => p.version)) + 1
    for (const model of [tx.swarmHead, tx.swarmMember, tx.swarmAgent, tx.swarmGroup, tx.swarmMachine, tx.swarmStart, tx.swarmProgress] as unknown as
      Array<{ deleteMany(args: unknown): Promise<unknown> }>) await model.deleteMany({ where: { tabId: tab } })
    await parts.insertParts(tx, { ...parts.split(state, { tabId: tab, version, now: Date.now(), visibilityEpoch: current.visibilityEpoch }),
      sequenceBase: current.sequenceBase })
  })
}
async function invite(tab: string, role: 'collaborator' | 'viewer' = 'collaborator') {
  const invitation = await run(tab, { type: 'invite.create', email: peer.email, role, conversationId: 'lead' })
  await run(tab, { type: 'invite.accept', inviteId: invitation.result.inviteId as string }, peer)
}
/** `host`, whose machine runs the fixture's agents, as a member: the one person who drives a Lead's terminal (terminal.ts mayDrive). */
async function joinHost(tab: string) {
  const invitation = await run(tab, { type: 'invite.create', email: host.email, role: 'collaborator', conversationId: 'lead' })
  await run(tab, { type: 'invite.accept', inviteId: invitation.result.inviteId as string }, host)
}

beforeAll(async () => {
  replica = await MongoMemoryReplSet.create({ binary: { version: '7.0.24', downloadDir: join(tmpdir(), 'harness-super-tab-mongodb-binaries') },
    replSet: { count: 1, ip: '127.0.0.1', storageEngine: 'wiredTiger' } })
  const uri = replica.getUri(`super_tab_test_${randomUUID().replaceAll('-', '_')}`)
  await promisify(execFile)(join(process.cwd(), 'node_modules/.bin/prisma'), ['db', 'push', '--skip-generate'], {
    env: { ...process.env, DATABASE_URL: uri }, timeout: 60000,
  })
  const client = new PrismaClient({ datasources: { db: { url: uri } }, log: [{ emit: 'event', level: 'query' }] })
  client.$on('query', event => recordQuery(event.query))
  db = client
  store = new SuperTabStore(db)
  for (const user of [owner, peer, host]) await db.user.create({ data: { id: user.sub, externalId: `fixture-${user.sub}`,
    email: user.email, autonomousEnv: user.autonomousEnv } })
  await db.machine.create({ data: { machineId: 'test-host', userId: host.sub, apiKey: 'fixture-only', managerId: 'fixture',
    autonomousEnv: 'prod', authMode: 'remote' } })
  await db.machineShare.create({ data: { machineId: 'test-host', ownerId: host.sub, autonomousEnv: 'prod', emails: [owner.email, peer.email] } })
  app = Fastify()
  app.setErrorHandler(errorHandler)
  // External SSO is replaced with three fixture accounts; every permission/transaction below is real.
  app.addHook('onRequest', async (request, reply) => {
    const user = [owner, peer, host].find(u => `Bearer ${u.sub}` === request.headers.authorization)
    if (!user) return reply.code(401).send({ success: false })
    request.user = user
  })
  await app.register(superTabRoutes, { store })
  await app.ready()
})
afterAll(async () => {
  await app?.close()
  await db?.$disconnect()
  await replica?.stop()
})

describe('delivery authority dependencies', () => {
  it('refuses a native delivery to another receiver when the terminal agent has a private PM chat', async () => {
    const { tab, lead } = await fixture()
    await invite(tab)
    const group = String((await run(tab, { type: 'conversation.create', title: 'Terminal source', brief: '', checks: [] })).result.conversationId)
    const worker = String((await run(tab, { type: 'agent.add', conversationId: group, machineId: 'test-host', harnessId: randomUUID(),
      name: 'Terminal agent', configuration: config, lead: false })).result.agentId)
    const { contextId } = await store.native.open(peer, tab, { operationId: randomUUID(), conversationId: group, agentId: worker })
    const turn = await store.native.append(host, tab, contextId, { turnId: 'private-terminal', kind: 'prompt', previousEventId: null,
      text: 'Typed before the session became private.', truncated: false, interrupted: false }) as { eventId: string }
    const delivery = await db.superTabDelivery.findFirstOrThrow({ where: { tabId: tab, messageId: turn.eventId, agentId: lead } })
    expect(delivery.nativeContextId).toBe(contextId)
    expect(delivery.agentId).not.toBe(worker)
    // An older stored registration can carry privacy through group membership without a confidential mark or a revoked
    // context. Only the terminal agent's groups reveal it; the receiver is the Lead in the public source conversation.
    const state = await storedState(tab)
    expect(state.agents.find(a => a.id === worker)!.confidential).toBeUndefined()
    state.conversations.push({ ...structuredClone(state.conversations.find(c => c.id === group)!), id: randomUUID(), title: 'Private PM chat',
      agentIds: [worker], leadId: null, assignment: null, audience: { people: [{ id: owner.sub, generation: state.people.find(p => p.id === owner.sub)!.generation }] } })
    await saveState(tab, state)
    expect((await db.superTabNativeContext.findUniqueOrThrow({ where: { id: contextId } })).revoked).toBe(false)
    await expect(store.delivery(host, tab, lead, delivery.id, { type: 'claim', claimId: randomUUID() }))
      .rejects.toMatchObject({ code: 'DELIVERY_REVOKED' })
  })

  it('refuses an older agent without a project when its private project cannot deliver to an outsider', async () => {
    const { tab, lead } = await fixture()
    const projectId = String((await run(tab, { type: 'project.create', name: 'Private legacy project', visibility: 'private', brief: '' })).result.projectId)
    const group = String((await run(tab, { type: 'conversation.create', projectId, title: 'Legacy source', brief: '', checks: [] })).result.conversationId)
    const sender = String((await run(tab, { type: 'agent.add', conversationId: group, machineId: 'test-host', harnessId: randomUUID(),
      name: 'Legacy sender', configuration: config, lead: false })).result.agentId)
    const state = await storedState(tab)
    const legacy = state.agents.find(a => a.id === sender)!
    delete legacy.projectId
    await saveState(tab, state)
    // A stale cross-project delivery from before migration must not acquire the public receiver's project identity.
    const sent = await run(tab, message('Stale legacy delivery.'))
    const delivery = await db.superTabDelivery.findFirstOrThrow({ where: { tabId: tab, agentId: lead, messageId: sent.result.messageId as string } })
    await db.superTabDelivery.update({ where: { id: delivery.id }, data: { authorKind: 'agent', authorId: sender,
      authorGeneration: legacy.membershipGeneration } })
    await expect(store.delivery(host, tab, lead, delivery.id, { type: 'claim', claimId: randomUUID() }))
      .rejects.toMatchObject({ code: 'DELIVERY_REVOKED' })
  })

  it('refuses a claim when its person sender is removed after the authority read', async () => {
    const { tab, lead } = await fixture()
    await invite(tab)
    const sent = await run(tab, message('Sent before removal.'), peer)
    const delivery = await db.superTabDelivery.findFirstOrThrow({ where: { tabId: tab, agentId: lead, messageId: sent.result.messageId as string } })
    let removed = false
    const raced = new SuperTabStore(beforeFirstWrite(db, async () => {
      if (removed) return
      removed = true
      // Remove the authority part independently of delivery cancellation, so only the sender touch can reject a stale
      // authorization decision. The other fixture paths already cover commands cancelling the delivery row itself.
      await swarmTransaction(db, async tx => {
        const member = await tx.swarmMember.findFirstOrThrow({ where: { tabId: tab, key: peer.sub } })
        await guardedWrite(tx, tab, { op: 'remove', kind: 'member', key: peer.sub, seen: member.version,
          data: member.data as unknown as SuperTabState['people'][number] }, parts.clock.next())
      })
    }))
    await expect(raced.delivery(host, tab, lead, delivery.id, { type: 'claim', claimId: randomUUID() }))
      .rejects.toMatchObject({ code: 'DELIVERY_REVOKED' })
    expect(removed).toBe(true)
    expect((await db.superTabDelivery.findUniqueOrThrow({ where: { id: delivery.id } })).status).toBe('queued')
  })
})

describe('durable group pull request links', () => {
  const pr = (number: number) => `https://github.com/example/project/pull/${number}`
  const links = async (tab: string, groupId = 'lead') => {
    const group = (await store.read(owner, tab)).state.conversations.find(c => c.id === groupId)!
    return (group as unknown as { pullRequestUrls?: string[] }).pullRequestUrls
  }

  it('keeps one link beyond the latest 100 messages', async () => {
    const { tab } = await fixture()
    await run(tab, message(`Review ${pr(41)}`))
    await run(tab, message(`Same PR again: ${pr(41)}`))
    expect(await links(tab)).toEqual([pr(41)])
    await db.superTabMessage.createMany({ data: Array.from({ length: 101 }, (_, i) => ({
      id: randomUUID(), tabId: tab, conversationId: 'lead', sequence: 1000 + i,
      author: { kind: 'person', id: owner.sub, name: owner.email }, text: `Later note ${i}`,
      replyTo: null, recipientIds: [],
    })) })
    expect((await store.messages(owner, tab, 'lead', {})).messages).toHaveLength(100)
    expect((await store.messages(owner, tab, 'lead', {})).messages.some(row => row.text.includes(pr(41)))).toBe(false)
    expect(await links(tab)).toEqual([pr(41)])
  })

  it('lists links from check evidence and a work result even when no message has those links', async () => {
    const { tab, lead } = await fixture()
    await run(tab, { type: 'work.define', conversationId: 'lead', brief: 'Record work',
      checks: [{ description: 'Reviewed', independent: false }] })
    const assignmentId = String((await run(tab, { type: 'work.assign', conversationId: 'lead', agentId: lead })).result.assignmentId)
    const checkId = (await store.read(owner, tab)).state.conversations[0]!.checks[0]!.id
    await run(tab, { type: 'work.check', conversationId: 'lead', assignmentId, checkId, passed: true,
      evidence: `Reviewed ${pr(42)} and ${pr(42)}` }, host, lead)
    expect((await store.messages(owner, tab, 'lead', {})).messages.some(row => row.text.includes(pr(42)))).toBe(false)
    await run(tab, { type: 'work.status', conversationId: 'lead', assignmentId, status: 'working', result: `Built ${pr(43)}` }, host, lead)
    expect(await links(tab)).toEqual([pr(42), pr(43)])
  })
})

describe('native recording restart recovery', () => {
  async function recoveryFixture(status: 'working' | 'review' = 'working') {
    const { tab, lead } = await fixture()
    const group = (await run(tab, { type: 'conversation.create', title: 'Recover interrupted work', brief: 'Finish the saved task',
      checks: [{ description: 'Task has a checkpoint', independent: false }] })).result.conversationId as string
    const worker = (await run(tab, { type: 'agent.add', conversationId: group, machineId: 'test-host', harnessId: randomUUID(),
      name: 'Recovery Engineer', configuration: config, lead: false })).result.agentId as string
    const assigned = await run(tab, { type: 'work.assign', conversationId: group, agentId: worker })
    const assignmentId = assigned.result.assignmentId as string
    if (status === 'review') await run(tab, { type: 'work.status', conversationId: group, assignmentId, status, result: 'Checkpoint ready' }, host, worker)
    const { contextId } = await store.native.open(owner, tab, { operationId: randomUUID(), conversationId: group, agentId: worker })
    const prompt = { turnId: 'saved_turn', kind: 'prompt' as const, previousEventId: null,
      text: 'Continue from the saved commit', truncated: false, interrupted: false }
    const checkpoint = await store.native.append(host, tab, contextId, prompt) as { eventId: string }
    const checkpointRow = await db.superTabMessage.findUniqueOrThrow({ where: { id: checkpoint.eventId } })
    const gap = { turnId: 'restart_observation', kind: 'gap' as const, previousEventId: checkpoint.eventId,
      text: '', truncated: false, interrupted: false }
    const interruption = (reason: 'recording_restarted' | 'history_lost' | 'agent_stopped' = 'recording_restarted') => ({ ...gap,
      gap: { incidentId: 'restart_incident', reason, detectedAt: Date.now() + 1000 } })
    const state = async () => (await store.read(owner, tab)).state.conversations.find(c => c.id === group)!.assignment!
    const gapDeliveries = async () => {
      const rows = await db.superTabMessage.findMany({ where: { tabId: tab, conversationId: group } })
      const ids = rows.filter(m => (m.source as { phase?: string } | null)?.phase === 'gap').map(m => m.id)
      return db.superTabDelivery.findMany({ where: { tabId: tab, messageId: { in: ids } } })
    }
    const append = async (body: Record<string, unknown>, context = contextId) => {
      const response = await app.inject({ method: 'POST', url: `/api/super-tabs/${tab}/native/${context}`,
        headers: { authorization: `Bearer ${host.sub}` }, payload: body })
      expect(response.statusCode, response.body).toBe(200)
      return response.json().data as { eventId: string }
    }
    return { tab, lead, group, worker, assignmentId, contextId, checkpoint, checkpointRow, gap, interruption, state, gapDeliveries, append }
  }

  it('keeps a PR link from a native message after that message leaves the latest page', async () => {
    const f = await recoveryFixture()
    const url = 'https://github.com/example/project/pull/44'
    await f.append({ turnId: 'saved_turn', kind: 'answer', previousEventId: f.checkpoint.eventId,
      text: `Opened ${url}`, truncated: false, interrupted: false })
    const group = () => store.read(owner, f.tab).then(row => row.state.conversations.find(c => c.id === f.group)!)
    expect((await group()).pullRequestUrls).toEqual([url])
    await db.superTabMessage.createMany({ data: Array.from({ length: 101 }, (_, i) => ({
      id: randomUUID(), tabId: f.tab, conversationId: f.group, sequence: 1000 + i,
      author: { kind: 'person', id: owner.sub, name: owner.email }, text: `Later note ${i}`,
      replyTo: null, recipientIds: [],
    })) })
    expect((await store.messages(owner, f.tab, f.group, {})).messages.some(row => row.text.includes(url))).toBe(false)
    expect((await group()).pullRequestUrls).toEqual([url])
  })

  it.each(['recording_restarted', 'history_lost', 'agent_stopped'] as const)('wakes only the Lead and blocks working work for %s with a checkpoint time and no visible ids', async reason => {
    const f = await recoveryFixture(), event = f.interruption(reason)
    const result = await store.native.append(host, f.tab, f.contextId, event) as { eventId: string }
    expect(await f.state()).toMatchObject({ id: f.assignmentId, status: 'blocked', result: expect.stringContaining('Recovery Engineer') })
    const message = await db.superTabMessage.findUniqueOrThrow({ where: { id: result.eventId } })
    expect(message.text).toContain('Recovery Engineer')
    expect(message.text).toContain('Recover interrupted work')
    expect(message.text).toContain(f.checkpointRow.createdAt.toISOString())
    expect(message.text).not.toContain(f.assignmentId)
    expect(message.text).not.toContain(f.checkpoint.eventId)
    expect(message.text).not.toContain('saved_turn')
    expect((await f.state()).result).toBe(message.text)
    expect(message.source).toMatchObject({ kind: 'native', phase: 'gap', recovery: {
      assignmentId: f.assignmentId, checkpoint: { eventId: f.checkpoint.eventId, turnId: 'saved_turn', recordedAt: f.checkpointRow.createdAt.toISOString() } } })
    expect(await f.gapDeliveries()).toMatchObject([{ agentId: f.lead, messageId: result.eventId }])
    expect(await f.gapDeliveries()).toHaveLength(1)
    expect(await store.native.append(host, f.tab, f.contextId, event)).toEqual(result)
    expect(await f.gapDeliveries()).toHaveLength(1)
  })

  it('keeps a person’s unattributed terminal input from blocking working work or waking the Lead', async () => {
    const f = await recoveryFixture(), before = await f.state()
    const result = await f.append({ ...f.gap, gap: { incidentId: 'typed_input', reason: 'unattributed_input', detectedAt: Date.now() + 1000 } })
    expect(await f.state()).toEqual(before)
    expect(await f.gapDeliveries()).toEqual([])
    const message = await db.superTabMessage.findUniqueOrThrow({ where: { id: result.eventId } })
    expect(message.text).toBe('Some terminal activity could not be recorded. Check the native session for the full conversation.')
    expect(message.source).not.toHaveProperty('recovery')
  })

  it.each(['legacy', 'context_expired', 'prompt_missing'] as const)('keeps a %s gap as a plain note without changing work', async reason => {
    const f = await recoveryFixture(), before = await f.state()
    const result = await f.append({ ...f.gap, ...(reason === 'legacy' ? {} : { gap: { incidentId: 'plain_gap', reason, detectedAt: Date.now() + 1000 } }) })
    expect(await f.state()).toEqual(before)
    expect(await f.gapDeliveries()).toEqual([])
    const message = await db.superTabMessage.findUniqueOrThrow({ where: { id: result.eventId } })
    expect(message.text).toBe('Some terminal activity could not be recorded. Check the native session for the full conversation.')
    expect(message.source).not.toHaveProperty('recovery')
  })

  it('notifies once about an interruption during review while preserving the review state and result', async () => {
    const f = await recoveryFixture('review'), before = await f.state(), event = f.interruption()
    const first = await f.append(event)
    await f.append({ ...event, turnId: 'another_gap', previousEventId: first.eventId })
    expect(await f.state()).toEqual(before)
    expect(await f.gapDeliveries()).toMatchObject([{ agentId: f.lead, messageId: first.eventId }])
    expect(await f.gapDeliveries()).toHaveLength(1)
    const message = await db.superTabMessage.findUniqueOrThrow({ where: { id: first.eventId } })
    expect(message.text).toContain('Keep this task in review')
    expect(message.text).not.toContain('report working')
    expect(message.text).not.toContain('work was interrupted')
  })

  it('advertises recovery metadata without requiring it from older recorders', async () => {
    const f = await recoveryFixture()
    expect(await store.native.read(host, f.tab, f.contextId)).toMatchObject({ recovery: { version: 1, serverTime: expect.any(Number) } })
  })

  it('names the newer progress checkpoint when a later restart interrupts the task again', async () => {
    const f = await recoveryFixture(), detectedAt = Date.now() + 1000
    const first = await f.append({ ...f.gap, gap: { incidentId: 'first_restart', reason: 'recording_restarted', detectedAt } })
    const later = new SuperTabStore(db, () => detectedAt + 1)
    const progress = await later.execute(host, f.tab, { operationId: randomUUID(), command: {
      type: 'work.status', conversationId: f.group, assignmentId: f.assignmentId, status: 'working', result: 'Saved the next checkpoint' } }, f.worker)
    const checkpoint = await db.superTabMessage.findUniqueOrThrow({ where: { id: progress.result.messageId as string } })
    const second = await f.append({ ...f.gap, turnId: 'new_restart_observation', previousEventId: first.eventId,
      gap: { incidentId: 'second_restart', reason: 'recording_restarted', detectedAt: detectedAt + 2 } })
    expect(await f.state()).toMatchObject({ status: 'blocked' })
    const message = await db.superTabMessage.findUniqueOrThrow({ where: { id: second.eventId } })
    expect(message.text).toContain(checkpoint.createdAt.toISOString())
    expect(message.text).not.toContain(checkpoint.id)
    expect(message.source).toMatchObject({ recovery: { checkpoint: { eventId: checkpoint.id, recordedAt: checkpoint.createdAt.toISOString() } } })
    expect(await f.gapDeliveries()).toHaveLength(2)
  })

  it('wakes once for the same restart across contexts and does not re-block after the Lead clears it', async () => {
    const f = await recoveryFixture(), detectedAt = Date.now() + 1000
    const metadata = { incidentId: 'same_restart', reason: 'recording_restarted', detectedAt }
    const first = await f.append({ ...f.gap, gap: metadata })
    expect(await f.state()).toMatchObject({ status: 'blocked' })
    const later = new SuperTabStore(db, () => detectedAt + 1)
    await later.execute(host, f.tab, { operationId: randomUUID(), command: {
      type: 'work.status', conversationId: f.group, assignmentId: f.assignmentId, status: 'working', result: 'Continuing from the checkpoint' } }, f.lead)
    const { contextId } = await store.native.open(owner, f.tab, { operationId: randomUUID(), conversationId: f.group, agentId: f.worker })
    await f.append({ ...f.gap, turnId: 'second_gap', previousEventId: null, gap: metadata }, contextId)
    await f.append({ ...f.gap, turnId: 'third_gap', previousEventId: first.eventId, gap: metadata })
    expect(await f.state()).toMatchObject({ status: 'working', result: 'Continuing from the checkpoint' })
    expect(await f.gapDeliveries()).toHaveLength(1)
  })

  it.each(['worker', 'lead'] as const)('lets the %s resume a recovery block without a person, including a delayed legacy gap', async who => {
    const f = await recoveryFixture()
    const first = await store.native.append(host, f.tab, f.contextId, f.interruption()) as { eventId: string }
    expect(await f.state()).toMatchObject({ status: 'blocked' })
    await run(f.tab, { type: 'work.status', conversationId: f.group, assignmentId: f.assignmentId,
      status: 'working', result: 'Session checked; work continued' }, host, who === 'worker' ? f.worker : f.lead)
    await store.native.append(host, f.tab, f.contextId, { ...f.gap, turnId: 'late_legacy_gap', previousEventId: first.eventId })
    expect(await f.state()).toMatchObject({ status: 'working', result: 'Session checked; work continued' })
    expect(await f.gapDeliveries()).toHaveLength(1)
  })

  it.each(['status', 'message'] as const)('does not block a delayed incident after the worker reports progress by %s', async progress => {
    const f = await recoveryFixture(), detectedAt = Date.now() + 1000
    const later = new SuperTabStore(db, () => detectedAt + 1)
    const command: Command = progress === 'status'
      ? { type: 'work.status', conversationId: f.group, assignmentId: f.assignmentId, status: 'working', result: null }
      : { type: 'message.send', conversationId: f.group, text: 'Recovered and committed the next step', replyTo: null, recipientIds: [] }
    await later.execute(host, f.tab, { operationId: randomUUID(), command }, f.worker)
    const first = await f.append({ ...f.gap, gap: { incidentId: 'delayed_restart', reason: 'recording_restarted', detectedAt } })
    await f.append({ ...f.gap, turnId: 'later_retry', previousEventId: first.eventId,
      gap: { incidentId: 'delayed_restart', reason: 'recording_restarted', detectedAt } })
    expect(await f.state()).toMatchObject({ status: 'working', result: null })
    expect(await f.gapDeliveries()).toHaveLength(0)
  })

  it.each(['done', 'blocked', 'needs_human'] as const)('does not replace %s work or notify the Lead', async status => {
    const f = await recoveryFixture()
    if (status === 'done') {
      const checkId = (await store.read(owner, f.tab)).state.conversations.find(c => c.id === f.group)!.checks[0]!.id
      await run(f.tab, { type: 'work.check', conversationId: f.group, assignmentId: f.assignmentId, checkId,
        passed: true, evidence: 'The fixture recorded its checkpoint' }, host, f.worker)
    }
    await run(f.tab, { type: 'work.status', conversationId: f.group, assignmentId: f.assignmentId,
      status, result: 'Existing outcome' }, host, f.worker)
    await store.native.append(host, f.tab, f.contextId, f.interruption())
    expect(await f.state()).toMatchObject({ status, result: 'Existing outcome' })
    expect(await f.gapDeliveries()).toHaveLength(0)
  })

  it('does not wake or block the Lead itself, even when it holds active work', async () => {
    const { tab, lead } = await fixture()
    await run(tab, { type: 'work.define', conversationId: 'lead', brief: 'Lead task', checks: [{ description: 'Checked', independent: false }] })
    await run(tab, { type: 'work.assign', conversationId: 'lead', agentId: lead })
    await joinHost(tab)
    const { contextId } = await store.native.open(host, tab, { operationId: randomUUID(), conversationId: 'lead', agentId: lead })
    const receipt = await store.native.append(host, tab, contextId, { turnId: 'lead_restart', kind: 'gap', previousEventId: null,
      text: '', truncated: false, interrupted: false,
      gap: { incidentId: 'lead_restart', reason: 'recording_restarted', detectedAt: Date.now() + 1000 } }) as { eventId: string }
    expect((await store.read(owner, tab)).state.conversations[0]!.assignment!.status).toBe('working')
    expect(await db.superTabDelivery.findMany({ where: { messageId: receipt.eventId } })).toEqual([])
  })

  it('does not notify for a worker without an assignment', async () => {
    const { tab } = await fixture()
    const worker = (await run(tab, { type: 'agent.add', conversationId: 'lead', machineId: 'test-host', harnessId: randomUUID(),
      name: 'Idle Engineer', configuration: config, lead: false })).result.agentId as string
    const { contextId } = await store.native.open(owner, tab, { operationId: randomUUID(), conversationId: 'lead', agentId: worker })
    const receipt = await store.native.append(host, tab, contextId, { turnId: 'idle_restart', kind: 'gap', previousEventId: null,
      text: '', truncated: false, interrupted: false,
      gap: { incidentId: 'idle_restart', reason: 'recording_restarted', detectedAt: Date.now() + 1000 } }) as { eventId: string }
    expect((await store.read(owner, tab)).state.conversations[0]!.assignment).toBeNull()
    expect(await db.superTabDelivery.findMany({ where: { messageId: receipt.eventId } })).toEqual([])
  })
})

describe('Change agent on a Swarm member', () => {
  it('moves active execution and keeps queued, held, answered and uncertain receipts; Send again uses the current member', async () => {
    const { tab, lead } = await fixture()
    const before = (await store.read(owner, tab)).state.agents.find(a => a.id === lead)!
    const group = (await run(tab, { type: 'conversation.create', title: 'Replacement', brief: 'Continue work',
      checks: [{ description: 'Receives messages', independent: false }] })).result.conversationId as string
    await run(tab, { type: 'conversation.agent', conversationId: group, agentId: lead, present: true, lead: false })
    await run(tab, { type: 'work.assign', conversationId: group, agentId: lead })
    const receiptIds: string[] = []
    for (const status of ['queued', 'claimed', 'uncertain', 'answered']) {
      const sent = await run(tab, { ...message(`Before ${status}`), recipientIds: [lead] } as Command)
      const delivery = (await store.deliveries(host, tab, lead)).find(d => d.messageId === sent.result.messageId)!
      await db.superTabDelivery.update({ where: { id: delivery.id }, data: { status, ...(status !== 'queued' ? { claimId: `claim-${status}`, receipt: `receipt-${status}` } : {}),
        ...(status === 'claimed' ? { holdReason: 'team_busy', holdSince: new Date() } : {}) } })
      receiptIds.push(delivery.id)
    }
    const receipts = await db.superTabDelivery.findMany({ where: { id: { in: receiptIds } }, orderBy: { id: 'asc' } })
    const command: Command = { type: 'agent.rebind', agentId: lead, machineId: 'test-host', projectId: 'lead',
      previousHarnessId: before.harnessId, harnessId: randomUUID(), configuration: { ...config, engine: 'claude', model: 'sonnet' } }
    const operation = randomUUID()
    const changed = await run(tab, command, host, lead, operation)
    const after = (await store.read(owner, tab)).state
    expect(after.agents.find(a => a.id === lead)).toMatchObject({ ...before, harnessId: command.harnessId,
      configuration: command.configuration, configurationVersion: expect.any(String) })
    expect(after.conversations[0]!.leadId).toBe(lead)
    expect(await db.superTabRun.findUnique({ where: { id: lead } })).toMatchObject({ harnessId: command.harnessId })
    expect(await db.superTabDelivery.findMany({ where: { id: { in: receiptIds } }, orderBy: { id: 'asc' } })).toEqual(receipts)
    expect(await run(tab, command, host, lead, operation)).toEqual(changed)
    const uncertain = receipts.find(d => d.status === 'uncertain')!
    await run(tab, { type: 'delivery.resolve', deliveryId: uncertain.id, resolution: 'resend' })
    const resent = (await store.deliveries(host, tab, lead)).find(d => d.id !== uncertain.id && !receiptIds.includes(d.id) && d.status === 'queued')!
    expect(resent).toMatchObject({ agentId: lead, status: 'queued' })
  })
  it('revokes the replaced terminal\'s recording contexts and the turns of it still waiting for the Lead', async () => {
    const { tab, lead } = await fixture()
    const group = String((await run(tab, { type: 'conversation.create', title: 'Rebound', brief: 'Work', checks: [{ description: 'Done', independent: false }] })).result.conversationId)
    const harnessId = randomUUID()
    const worker = String((await run(tab, { type: 'agent.add', conversationId: group, machineId: 'test-host', harnessId, name: 'Worker',
      configuration: config, lead: false })).result.agentId)
    const { contextId } = await store.native.open(owner, tab, { operationId: randomUUID(), conversationId: group, agentId: worker })
    await store.native.append(host, tab, contextId, { turnId: 'old_turn', kind: 'prompt', previousEventId: null, text: 'Typed before the switch',
      truncated: false, interrupted: false })
    const turn = (await store.deliveries(host, tab, lead)).find(d => d.nativeContextId === contextId)!
    await run(tab, { type: 'agent.rebind', agentId: worker, machineId: 'test-host', projectId: 'lead', previousHarnessId: harnessId,
      harnessId: randomUUID(), configuration: config }, host, worker)
    expect((await db.superTabNativeContext.findUniqueOrThrow({ where: { id: contextId } })).revoked).toBe(true)
    expect((await db.superTabDelivery.findUniqueOrThrow({ where: { id: turn.id } })).status).toBe('cancelled')
    await expect(store.delivery(host, tab, lead, turn.id, { type: 'claim', claimId: randomUUID() })).rejects.toMatchObject({ code: 'DELIVERY_REVOKED' })
  })

  it('refuses a replacement already contributed in another tab', async () => {
    const first = await fixture(), second = await fixture()
    const previous = (await store.read(owner, first.tab)).state.agents[0]!
    const occupied = (await store.read(owner, second.tab)).state.agents[0]!
    await expect(run(first.tab, { type: 'agent.rebind', agentId: first.lead, machineId: 'test-host', projectId: 'lead',
      previousHarnessId: previous.harnessId, harnessId: occupied.harnessId, configuration: config }, host, first.lead)).rejects.toMatchObject({ code: 'SESSION_CONTRIBUTED' })
  })
})

describe('five-part task persistence', () => {
  it('stores structured tasks through the API and delivers all parts to the worker', async () => {
    const { tab, lead } = await fixture()
    const task = { goal: 'Keep drafts', changes: 'Persist pending edits', constraints: 'No dependencies', owns: ['backend/src/superTabs'] }
    const checks = [{ description: 'Draft survives reconnect', independent: false }]
    const created = await app.inject({ method: 'POST', url: `/api/super-tabs/${tab}/commands`,
      headers: { authorization: `Bearer ${host.sub}` }, payload: { operationId: randomUUID(), asAgentId: lead,
        command: { type: 'conversation.create', title: 'Drafts', task, checks } } })
    expect(created.statusCode, created.body).toBe(200)
    const group = created.json().data.result.conversationId as string
    const worker = (await run(tab, { type: 'agent.add', conversationId: group, machineId: 'test-host', harnessId: randomUUID(), name: 'Worker', configuration: config, lead: false })).result.agentId as string
    const row = (await store.read(owner, tab)).state.conversations.find(c => c.id === group)!
    expect(row.task).toEqual(task)
    expect(row.brief).toContain('Goal:\nKeep drafts')
    await run(tab, { type: 'work.assign', conversationId: group, agentId: worker })
    const messages = (await store.messages(owner, tab, group, {})).messages
    const delivered = messages.at(-1)!.text
    for (const part of ['Goal:', 'Changes:', 'Constraints:', 'Owns:', 'Acceptance checks:', ...Object.values(task).flat(), checks[0]!.description]) expect(delivered).toContain(part)
  })
})

describe('person removal notices', () => {
  it('records one Lead notice per group and replays removal without another notice or delivery', async () => {
    const { tab, lead } = await fixture()
    const group = (await run(tab, { type: 'conversation.create', title: 'Pending drafts', brief: 'Keep drafts offline',
      checks: [{ description: 'Draft survives reconnect', independent: false }] })).result.conversationId as string
    const worker = (await run(tab, { type: 'agent.add', conversationId: group, machineId: 'test-host', harnessId: randomUUID(),
      name: 'Draft worker', configuration: config, lead: false })).result.agentId as string
    await run(tab, { type: 'conversation.agent', conversationId: 'lead', agentId: worker, present: true, lead: false })
    await run(tab, { type: 'work.assign', conversationId: group, agentId: worker })
    const operationId = randomUUID(), command: Command = { type: 'agent.remove', agentId: worker }
    const first = await run(tab, command, owner, undefined, operationId)
    const notices = await db.superTabMessage.findMany({ where: { tabId: tab, text: { contains: 'removed' } } })
    expect(notices).toHaveLength(2)
    expect(notices.find(n => n.conversationId === group)!.text).toContain('Pending drafts')
    const deliveries = await db.superTabDelivery.findMany({ where: { tabId: tab, messageId: { in: notices.map(n => n.id) } } })
    expect(deliveries).toHaveLength(2)
    expect(deliveries.every(d => d.agentId === lead)).toBe(true)
    expect(await run(tab, command, owner, undefined, operationId)).toEqual(first)
    expect(await db.superTabMessage.count({ where: { tabId: tab, text: { contains: 'removed' } } })).toBe(2)
    expect(await db.superTabDelivery.count({ where: { tabId: tab, messageId: { in: notices.map(n => n.id) } } })).toBe(2)
  })
})

describe('agent member identities', () => {
  it('keeps a name through replay and removal, including the stored message author', async () => {
    const tab = (await store.create(owner, randomUUID(), 'People and agents')).id
    const operationId = randomUUID()
    const command: Command = { type: 'agent.add', conversationId: 'lead', machineId: 'test-host',
      harnessId: randomUUID(), name: 'Lead', configuration: config, lead: false }
    const added = await run(tab, command, owner, undefined, operationId)
    const agentId = added.result.agentId as string
    const first = await store.read(owner, tab)
    const agent = first.state.agents.find(a => a.id === agentId)!
    expect(agent.displayName).toBeTruthy()
    expect(agent.displayName).not.toBe('Lead')
    expect(await run(tab, command, owner, undefined, operationId)).toEqual(added)
    expect((await store.read(owner, tab)).lastChangedAt).toBe(first.lastChangedAt)
    await run(tab, message('The plan is ready.'), host, agentId)
    await run(tab, { type: 'agent.remove', agentId })
    const rows = (await store.messages(owner, tab, 'lead', {})).messages
    expect(rows.find(row => row.text === 'The plan is ready.')!.author)
      .toMatchObject({ id: agentId, name: 'Lead', displayName: agent.displayName })
    expect((await store.read(owner, tab)).state.agents).toEqual([])
  })
})

describe('deleting abandoned swarm projects', () => {
  it('deletes the project through the API, fences stale requests, and replays only the deletion receipt', async () => {
    const { tab } = await fixture()
    const createId = randomUUID()
    const create = { type: 'project.create' as const, name: 'Abandoned private project', visibility: 'private' as const, brief: '' }
    const { projectId, conversationId } = (await run(tab, create, owner, undefined, createId)).result as { projectId: string; conversationId: string }
    const group = String((await run(tab, { type: 'conversation.create', projectId, title: 'Offline work', brief: '', checks: [] })).result.conversationId)
    const send = { ...message('Private unfinished draft'), conversationId: group } as Command
    const sendId = randomUUID()
    await run(tab, send, owner, undefined, sendId)
    await run(tab, { type: 'invite.create', email: 'abandoned@example.com', role: 'collaborator', conversationId })
    const deleteId = randomUUID(), command = { type: 'project.delete' as const, projectId }
    const response = await app.inject({ method: 'POST', url: `/api/super-tabs/${tab}/commands`,
      headers: { authorization: `Bearer ${owner.sub}` }, payload: { operationId: deleteId, command } })
    expect(response.statusCode).toBe(200)
    expect(response.json().data.result).toEqual({})
    expect(await run(tab, command, owner, undefined, deleteId)).toEqual(response.json().data)
    const state = (await store.read(owner, tab)).state
    expect(state.projects!.map(p => p.id)).toEqual(['lead'])
    expect(state.conversations.map(c => c.id)).toEqual(['lead', state.leadsConversationId])
    // An invitation is to the Swarm: it moves to the project that is left rather than disappearing.
    expect(state.invitations.map(i => [i.email, i.conversationId])).toEqual([['abandoned@example.com', 'lead']])
    for (const id of [conversationId, group]) {
      await expect(store.messages(owner, tab, id, {})).rejects.toMatchObject({ code: 'NOT_FOUND' })
      await expect(store.attempts(owner, tab, id)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    }
    await expect(run(tab, send, owner, undefined, sendId)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(run(tab, create, owner, undefined, createId)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(run(tab, { type: 'project.rename', projectId, name: 'Revived' })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(run(tab, { type: 'agent.add', conversationId, machineId: 'test-host', harnessId: randomUUID(),
      name: 'Late lead', configuration: config, lead: true })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect((await store.read(owner, tab)).state.projects!.map(p => p.id)).toEqual(['lead'])
  })

  it('allows an empty swarm and never assigns a deleted workgroup number again', async () => {
    const tab = (await store.create(owner, randomUUID(), 'Empty swarm')).id
    const old = (await run(tab, { type: 'conversation.create', title: 'Old work', brief: '', checks: [] })).result
    await run(tab, { type: 'project.delete', projectId: 'lead' })
    const empty = (await store.read(owner, tab)).state
    expect(empty.projects).toEqual([])
    // Only the Swarm-wide Leads conversation is left.
    expect(empty.conversations.map(c => c.kind)).toEqual(['leads'])
    expect(empty.agents).toEqual([])
    expect(empty.people).toHaveLength(1)
    const projectId = String((await run(tab, { type: 'project.create', name: 'Fresh project', visibility: 'public', brief: '' })).result.projectId)
    const next = (await run(tab, { type: 'conversation.create', projectId, title: 'Fresh work', brief: '', checks: [] })).result
    expect(next.number).toBe(Number(old.number) + 1)
    await expect(store.messages(owner, tab, String(old.conversationId), {})).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('lets only the project owner delete it, and removal revokes receipt replay', async () => {
    const { tab } = await fixture()
    await invite(tab)
    const publicId = String((await run(tab, { type: 'project.create', name: 'Peer project', visibility: 'public', brief: '' }, peer)).result.projectId)
    const privateId = String((await run(tab, { type: 'project.create', name: 'Peer private project', visibility: 'private', brief: '' }, peer)).result.projectId)
    await expect(run(tab, { type: 'project.delete', projectId: publicId })).rejects.toMatchObject({ code: 'PROJECT_OWNER_REQUIRED' })
    await expect(run(tab, { type: 'project.delete', projectId: privateId })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    const operationId = randomUUID(), command = { type: 'project.delete' as const, projectId: publicId }
    const deleted = await run(tab, command, peer, undefined, operationId)
    expect(await run(tab, command, peer, undefined, operationId)).toEqual(deleted)
    await run(tab, { type: 'member.remove', userId: peer.sub })
    await expect(run(tab, command, peer, undefined, operationId)).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('refuses pending starts and prevents a failed start from joining after deletion', async () => {
    const { tab } = await fixture()
    const { projectId, conversationId } = (await run(tab, { type: 'project.create', name: 'Failed start', visibility: 'public', brief: '' })).result as { projectId: string; conversationId: string }
    const request = { conversationId, machineId: 'test-host', engine: 'codex', name: 'Builder', cwd: '/work', worktree: true,
      requirements: { memoryBytes: 0, diskBytes: 0, maxCpuPercent: 100, tools: [], devices: [], quotaRequired: false } }
    const startId = String((await run(tab, { type: 'agent.start', request })).result.startId)
    await expect(run(tab, { type: 'project.delete', projectId })).rejects.toMatchObject({ code: 'STARTS_PENDING' })
    await run(tab, { type: 'agent.startFailed', startId, error: 'The machine refused the prompt before launch.' })
    await run(tab, { type: 'project.delete', projectId })
    await expect(store.start(owner, tab, startId)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(run(tab, { type: 'agent.started', startId, harnessId: randomUUID(), configuration: config })).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('does not erase a removed terminal’s private history restriction', async () => {
    const { tab } = await fixture()
    const { projectId, conversationId } = (await run(tab, { type: 'project.create', name: 'Private work', visibility: 'private', brief: '' })).result as { projectId: string; conversationId: string }
    const harnessId = randomUUID()
    const agentId = String((await run(tab, { type: 'agent.add', conversationId, machineId: 'test-host', harnessId,
      name: 'Private lead', configuration: config, lead: true })).result.agentId)
    await joinHost(tab)
    await run(tab, { type: 'project.sharing', projectId, visibility: 'private', memberIds: [host.sub] })
    const context = await store.native.open(host, tab, { operationId: randomUUID(), conversationId, agentId })
    await run(tab, { type: 'project.delete', projectId })
    await expect(store.native.read(host, tab, context.contextId)).rejects.toMatchObject({ code: 'NATIVE_CONTEXT_REVOKED' })
    expect(await store.mayObserve(owner, tab, 'test-host', harnessId, host.sub)).toBe(false)
    await expect(run(tab, { type: 'agent.add', conversationId: 'lead', machineId: 'test-host', harnessId,
      name: 'Moved lead', configuration: config, lead: false })).rejects.toMatchObject({ code: 'PROJECT_SESSION' })
  })

  it('serializes deletion against a late lead contribution', async () => {
    const { tab } = await fixture()
    const { projectId, conversationId } = (await run(tab, { type: 'project.create', name: 'Race', visibility: 'public', brief: '' })).result as { projectId: string; conversationId: string }
    const results = await Promise.allSettled([
      run(tab, { type: 'project.delete', projectId }),
      run(tab, { type: 'agent.add', conversationId, machineId: 'test-host', harnessId: randomUUID(), name: 'Lead', configuration: config, lead: true }),
    ])
    // Whichever runs first, the delete wins and takes a lead that arrived before it.
    expect(results[0].status).toBe('fulfilled')
    const state = (await store.read(owner, tab)).state
    expect(state.projects!.some(p => p.id === projectId)).toBe(false)
    expect(state.agents.some(a => a.projectId === projectId)).toBe(false)
    expect(state.conversations.some(c => c.id === conversationId)).toBe(false)
  })
})

describe('private swarm projects on the real control API', () => {
  it('uses one contributed machine across projects with a separate authorized checkout for each', async () => {
    const { tab } = await fixture()
    const invitation = await run(tab, { type: 'invite.create', email: host.email, role: 'collaborator', conversationId: 'lead' })
    await run(tab, { type: 'invite.accept', inviteId: invitation.result.inviteId as string }, host)
    const machineId = 'swarm-pool-host'
    await db.machine.create({ data: { machineId, userId: host.sub, apiKey: 'fixture-swarm-pool', managerId: 'fixture',
      autonomousEnv: 'prod', authMode: 'remote' } })
    const team = await teamMachine(machineId)
    const project = (await run(tab, { type: 'project.create', name: 'Second project', visibility: 'private', brief: '' })).result
    const conversationId = String(project.conversationId), projectId = String(project.projectId)
    await run(tab, { type: 'agent.add', conversationId, machineId: 'test-host', harnessId: randomUUID(),
      name: 'Project lead', configuration: config, lead: true,
      project: { cwd: '/lead/second', repositoryUrl: 'https://github.com/example/second' } })
    await run(tab, { type: 'machine.contribute', machineId, name: 'Shared capacity', cwd: '/swarm-root',
      engines: ['codex'], maxAgents: 2 }, host)
    await expect(run(tab, { type: 'tab.project', machineId, project: { cwd: '/unrelated', repositoryUrl: null } }))
      .rejects.toMatchObject({ code: 'HOST_REQUIRED' })
    const request = { conversationId, machineId, engine: 'codex', name: 'Builder',
      cwd: `/swarm-root/${projectId}`, worktree: true,
      requirements: { memoryBytes: 0, diskBytes: 0, maxCpuPercent: 100, tools: [], devices: [], quotaRequired: false } }
    await expect(run(tab, { type: 'agent.start', request })).rejects.toMatchObject({ code: 'PROJECT_CONTRIBUTION' })
    await run(tab, { type: 'machine.contribute', machineId, name: 'Shared capacity', cwd: '/swarm-root',
      scope: 'swarm', engines: ['codex'], maxAgents: 2 }, host)
    const pool = (await poolRows(store, team.session, machineId))[0]!
    await store.observeMachine(team.session, tab, machineId, { generation: pool.machine.generation,
      resources: { cpuPercent: 10, memoryTotalBytes: 32e9, memoryUsedBytes: 4e9, projectDiskFreeBytes: 100e9,
        diskFreeBytes: 100e9, diskTotalBytes: 500e9, deviceType: 'Laptop', chip: 'Fixture CPU', os: 'macOS', gpuPercent: null },
      quotas: [], tools: { git: true }, runningHarnessIds: [], stoppedHarnessIds: [], privacy: team.privacy })
    expect(pool.projects).toEqual([])
    await expect(run(tab, { type: 'agent.start', request: { ...request, cwd: '/swarm-root/lead' } }))
      .rejects.toMatchObject({ code: 'OUTSIDE_CONTRIBUTION' })
    const secondStart = (await run(tab, { type: 'agent.start', request })).result.startId as string
    await run(tab, { type: 'agent.start', request: { ...request, conversationId: 'lead', cwd: '/swarm-root/lead' } })
    const queued = (await poolRows(store, team.session, machineId))[0]!
    expect(queued.starts).toHaveLength(2)
    expect(queued.projects!.find(p => p.id === projectId)).toMatchObject({
      repository: { machineId: 'test-host', cwd: '/lead/second', repositoryUrl: 'https://github.com/example/second' },
      conversationIds: [conversationId],
    })
    expect((await store.read(host, tab)).state.projects!.some(p => p.id === projectId)).toBe(false)
    const hostRun = (command: Command) => store.execute(team.session, tab, { operationId: randomUUID(), command }, undefined, machineId)
    await hostRun({ type: 'agent.startDispatch', startId: secondStart })
    const started = await hostRun({ type: 'agent.started', startId: secondStart, harnessId: 'second-builder', configuration: config })
    await hostRun({ type: 'agent.startSettled', startId: secondStart, warning: null })
    const agentId = String(started.result.agentId)
    expect((await store.read(team.session, tab, agentId)).state.conversations.map(c => c.id)).toEqual([conversationId])
    await expect(store.messages(team.session, tab, 'lead', {}, agentId)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(await db.machineShare.findUnique({ where: { machineId } })).toBeNull()
  })

  it('revokes chat, terminal observers, native contexts and old receipts together', async () => {
    const { tab } = await fixture()
    await invite(tab)
    const project = (await run(tab, { type: 'project.create', name: 'Private project', visibility: 'private', brief: '' })).result
    const conversationId = String(project.conversationId), projectId = String(project.projectId)
    const harnessId = randomUUID()
    const agentId = String((await run(tab, { type: 'agent.add', conversationId, machineId: 'test-host', harnessId,
      name: 'Private lead', configuration: config, lead: true })).result.agentId)
    // Its terminal observers are checked on a Builder's terminal: nobody but its machine's owner watches a Lead (Critical 1).
    const workerHarness = randomUUID()
    const workerId = String((await run(tab, { type: 'agent.add', conversationId, machineId: 'test-host', harnessId: workerHarness,
      name: 'Private builder', configuration: config, lead: false })).result.agentId)
    await run(tab, { ...message('Private result'), conversationId } as Command)
    expect((await store.read(peer, tab)).state.projects!.map(p => p.id)).not.toContain(projectId)
    await expect(store.messages(peer, tab, conversationId, {})).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(store.native.open(peer, tab, { operationId: randomUUID(), conversationId, agentId: workerId })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(await store.mayObserve(peer, tab, 'test-host', workerHarness, host.sub)).toBe(false)
    expect((await rosterRows(store, host, 'test-host')).find(t => t.agent?.id === workerId)!.observers.map(p => p.userId)).not.toContain(peer.sub)
    await expect(store.messages(host, tab, 'lead', {}, agentId)).rejects.toMatchObject({ code: 'NOT_FOUND' })

    await run(tab, { type: 'project.sharing', projectId, visibility: 'private', memberIds: [peer.sub] })
    expect((await store.messages(peer, tab, conversationId, {})).messages.map(m => m.text)).toContain('Private result')
    expect(await store.mayObserve(peer, tab, 'test-host', workerHarness, host.sub)).toBe(true)
    // A member's terminal, also on the Builder: only its machine's owner drives a Lead.
    const context = await store.native.open(peer, tab, { operationId: randomUUID(), conversationId, agentId: workerId })
    const command = { ...message('Shared review'), conversationId } as Command
    const operationId = randomUUID()
    await run(tab, command, peer, undefined, operationId)
    await run(tab, { type: 'project.sharing', projectId, visibility: 'private', memberIds: [] })
    await expect(run(tab, command, peer, undefined, operationId)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(store.native.read(host, tab, context.contextId)).rejects.toMatchObject({ code: 'NATIVE_CONTEXT_REVOKED' })
    expect(await store.mayObserve(peer, tab, 'test-host', workerHarness, host.sub)).toBe(false)

    // Removing a roster row, here with its project, cannot erase the terminal's private history.
    await run(tab, { type: 'project.delete', projectId })
    const other = await fixture()
    await expect(run(other.tab, { type: 'agent.add', conversationId: 'lead', machineId: 'test-host', harnessId,
      name: 'Moved lead', configuration: config, lead: false })).rejects.toMatchObject({ code: 'PROJECT_SESSION' })
  })

  it('requests one consolidation after five minutes and remains quiet without new reports', async () => {
    let now = 10_000
    const timed = new SuperTabStore(db, () => now)
    const tab = (await timed.create(owner, randomUUID(), 'Updates', 'public')).id
    const execute = (command: Command, asAgentId?: string) => timed.execute(asAgentId ? host : owner, tab,
      { operationId: randomUUID(), command }, asAgentId)
    const lead = String((await execute({ type: 'agent.add', conversationId: 'lead', machineId: 'test-host',
      harnessId: randomUUID(), name: 'Lead', configuration: config, lead: true })).result.agentId)
    const updates = async () => (await timed.deliveries(host, tab, lead)).filter(d => d.conversationId === 'lead')
    const group = String((await execute({ type: 'conversation.create', title: 'Work', brief: 'Implement it',
      checks: [{ description: 'Verified', independent: true }] })).result.conversationId)
    expect(await updates()).toEqual([])
    now += 299_999
    expect(await updates()).toEqual([])
    // The quiet poll skips the time checks for 30 s after a full one (store.deliveries), so the request lands within that.
    now += 30_000
    const polls = await Promise.all(Array.from({ length: 3 }, () => updates()))
    const ids = new Set(polls.flat().map(d => d.id))
    expect(ids.size).toBe(1)
    const requests = await db.superTabMessage.findMany({ where: { tabId: tab, conversationId: 'lead' } })
    expect(requests).toHaveLength(1)
    expect(requests[0]!.source).toMatchObject({ kind: 'update-request' })
    await execute({ ...message('New evidence'), conversationId: group } as Command)
    now += 300_000
    expect((await updates()).map(d => d.id)).toEqual([...ids])
    // The Lead reports through what it read of each workgroup: here the new evidence, the group's latest message.
    const read = (await timed.read(owner, tab)).state.conversations.find(c => c.id === group)!
    await execute({ type: 'project.report', projectId: 'lead', through: { [group]: read.lastMessageSequence },
      text: 'The implementation is ready. Verification is next.' }, lead)
    expect(await updates()).toEqual([])
    now += 3_600_000
    expect(await updates()).toEqual([])
    expect((await db.superTabMessage.findMany({ where: { tabId: tab, conversationId: 'lead' } })).filter(m =>
      (m.source as Record<string, unknown>)?.kind === 'project-report')).toHaveLength(1)
    await execute({ type: 'project.cadence', projectId: 'lead', minutes: 15 })
    await execute({ ...message('Tests passed'), conversationId: group } as Command)
    now += 899_999
    expect(await updates()).toEqual([])
    // As above: the Lead's open deliveries are answered from its last full poll for 30 s, so the request lands within that.
    now += 30_000
    expect(await updates()).toHaveLength(1)
  })
})

describe('since when a worker is down', () => {
  async function downFixture() {
    let now = 1_000_000
    const timed = new SuperTabStore(db, () => now)
    const tab = (await timed.create(owner, randomUUID(), 'Down since', 'public')).id
    const execute = (command: Command, user = owner, asAgentId?: string) =>
      timed.execute(user, tab, { operationId: randomUUID(), command }, asAgentId)
    const invitation = await execute({ type: 'invite.create', email: host.email, role: 'collaborator', conversationId: 'lead' })
    await execute({ type: 'invite.accept', inviteId: invitation.result.inviteId as string }, host)
    await execute({ type: 'machine.contribute', machineId: 'test-host', name: 'Host', cwd: '/repo', engines: ['codex'], maxAgents: 4 }, host)
    const leadHarness = randomUUID(), workerHarness = randomUUID()
    const lead = String((await execute({ type: 'agent.add', conversationId: 'lead', machineId: 'test-host', harnessId: leadHarness,
      name: 'Lead', configuration: config, lead: true })).result.agentId)
    const group = String((await execute({ type: 'conversation.create', title: 'Ship the parser', brief: 'Implement it',
      checks: [{ description: 'Verified', independent: false }] })).result.conversationId)
    const worker = String((await execute({ type: 'agent.add', conversationId: group, machineId: 'test-host', harnessId: workerHarness,
      name: 'Worker', configuration: config, lead: false })).result.agentId)
    const assignmentId = String((await execute({ type: 'work.assign', conversationId: group, agentId: worker })).result.assignmentId)
    const generation = (await poolRows(timed, host, 'test-host')).find(p => p.tabId === tab)!.machine.generation
    const observe = (running: string[], stopped: string[] = []) => timed.observeMachine(host, tab, 'test-host', { generation,
      resources: { cpuPercent: 10, memoryTotalBytes: 32e9, memoryUsedBytes: 4e9, diskFreeBytes: 120e9, diskTotalBytes: 500e9,
        projectDiskFreeBytes: 120e9, deviceType: 'Laptop', chip: 'Fixture', os: 'macOS', gpuPercent: null },
      quotas: [], tools: {}, runningHarnessIds: running, stoppedHarnessIds: stopped })
    // What the Lead reads with `status`.
    const downSince = async (agentId: string) => (await timed.read(host, tab, lead)).state.agents.find(a => a.id === agentId)!.downSince
    return { timed, tab, execute, lead, group, worker, assignmentId, leadHarness, workerHarness, observe, downSince,
      clock: { get now() { return now }, set now(value: number) { now = value } } }
  }
  const iso = (ms: number) => new Date(ms).toISOString()

  it('is set by a gone session, a confirmed stop and an offline machine, and cleared when the worker is back', async () => {
    const f = await downFixture()
    await f.observe([f.leadHarness, f.workerHarness])
    expect(await f.downSince(f.worker)).toBeUndefined()

    // The host no longer lists the session as running.
    f.clock.now += 1_000
    const gone = f.clock.now
    await f.observe([f.leadHarness])
    f.clock.now += 1_000
    await f.observe([f.leadHarness])
    expect(await f.downSince(f.worker)).toBe(iso(gone))
    expect(await f.downSince(f.lead)).toBeUndefined()
    await f.observe([f.leadHarness, f.workerHarness])
    expect(await f.downSince(f.worker)).toBeUndefined()

    // The host confirms the session stopped, before its next reading.
    f.clock.now += 1_000
    const stopped = f.clock.now
    await f.timed.stopped(host, f.tab, f.assignmentId, 'fixture-native-stop')
    expect(await f.downSince(f.worker)).toBe(iso(stopped))
    f.clock.now += 1_000
    await f.observe([f.leadHarness], [f.workerHarness])
    expect(await f.downSince(f.worker)).toBe(iso(stopped))
    await f.observe([f.leadHarness, f.workerHarness])
    expect(await f.downSince(f.worker)).toBeUndefined()

    // The machine stops sending readings: down since its last one, kept when it returns without the session.
    f.clock.now += 1_000
    const lastReading = f.clock.now
    await f.observe([f.leadHarness, f.workerHarness])
    f.clock.now += 45_000
    expect(await f.downSince(f.worker)).toBeUndefined()
    f.clock.now += 1
    expect(await f.downSince(f.worker)).toBe(iso(lastReading))
    expect(await f.downSince(f.lead)).toBe(iso(lastReading))
    f.clock.now += 60_000
    await f.observe([f.leadHarness])
    expect(await f.downSince(f.worker)).toBe(iso(lastReading))
    expect(await f.downSince(f.lead)).toBeUndefined()
  })
})

describe('Super Tabs on a real Mongo replica set', () => {
  it('records a grid worker\'s model on every assignment, after its start is finished and no longer loaded', async () => {
    // Review of #1808: the run read the start, which a command does not load once the start is finished, so an assigned or
    // reused Kimi worker counted as a subscription run.
    const tab = (await store.create(owner, randomUUID(), 'Grid pool')).id
    const invitation = await run(tab, { type: 'invite.create', email: host.email, role: 'collaborator', conversationId: 'lead' })
    await run(tab, { type: 'invite.accept', inviteId: invitation.result.inviteId as string }, host)
    await db.machine.create({ data: { machineId: 'grid-host', userId: host.sub, apiKey: 'fixture-grid-host', managerId: 'fixture', autonomousEnv: 'prod', authMode: 'remote' } })
    const team = await teamMachine('grid-host')
    await run(tab, { type: 'machine.contribute', machineId: 'grid-host', name: 'Grid laptop', cwd: '/project', engines: ['claude'], maxAgents: 2 }, host)
    const grid = (await store.read(owner, tab)).state.localModels!.grid
    const generation = (await poolRows(store, team.session, 'grid-host'))[0]!.machine.generation
    await store.observeMachine(team.session, tab, 'grid-host', { generation, resources: { cpuPercent: 10, memoryTotalBytes: 32e9, memoryUsedBytes: 4e9,
      diskFreeBytes: 120e9, diskTotalBytes: 500e9, projectDiskFreeBytes: 120e9, deviceType: 'Laptop', chip: 'Fixture CPU', os: 'macOS', gpuPercent: null },
      quotas: [], tools: { git: true }, runningHarnessIds: [], stoppedHarnessIds: [], privacy: team.privacy,
      localModels: [{ grid, model: 'moonshotai/kimi-k3', name: 'Kimi K3', kind: 'api' }] })
    const group = String((await run(tab, { type: 'conversation.create', title: 'Small fix', brief: 'Fix it.',
      checks: [{ description: 'Independent review', independent: true }] })).result.conversationId)
    const startId = String((await run(tab, { type: 'agent.start', request: { conversationId: group, machineId: 'grid-host', engine: 'claude', name: 'Builder',
      cwd: '/project', worktree: true, gridModel: 'moonshotai/kimi-k3', gridName: grid,
      requirements: { memoryBytes: 0, diskBytes: 0, maxCpuPercent: 100, tools: [], devices: [], quotaRequired: false } } })).result.startId)
    const hostRun = (command: Command) => store.execute(team.session, tab, { operationId: randomUUID(), command }, undefined, 'grid-host')
    await hostRun({ type: 'agent.startDispatch', startId })
    const agentId = String((await hostRun({ type: 'agent.started', startId, harnessId: 'grid-builder',
      configuration: { engine: 'claude', model: null, effort: null, contextWindow: null, engineVersion: null } })).result.agentId)
    await hostRun({ type: 'agent.startSettled', startId, warning: null })
    const runs = async () => (await storedState(tab)).conversations.find(c => c.id === group)!.ledger!.runs!.map(r => [r.model, r.grid])
    await run(tab, { type: 'work.assign', conversationId: group, agentId })
    expect(await runs()).toEqual([['moonshotai/kimi-k3', true]])
    const first = (await store.read(owner, tab)).state.conversations.find(c => c.id === group)!.assignment!.id
    await run(tab, { type: 'work.cancel', conversationId: group, assignmentId: first, reason: 'Again.' })
    await run(tab, { type: 'work.assign', conversationId: group, agentId })
    expect(await runs()).toEqual([['moonshotai/kimi-k3', true], ['moonshotai/kimi-k3', true]])
  })

  it('rates a Reviewer launched on its engine\'s default by the default row after it reports its model, its start finished', async () => {
    // Live bug 10-29: a command does not load a finished start, so a Codex Reviewer that reported gpt-6.1-sol was rated 1.
    const tab = (await store.create(owner, randomUUID(), 'Default pool')).id
    const invitation = await run(tab, { type: 'invite.create', email: host.email, role: 'collaborator', conversationId: 'lead' })
    await run(tab, { type: 'invite.accept', inviteId: invitation.result.inviteId as string }, host)
    await db.machine.create({ data: { machineId: 'default-host', userId: host.sub, apiKey: 'fixture-default-host', managerId: 'fixture', autonomousEnv: 'prod', authMode: 'remote' } })
    const team = await teamMachine('default-host')
    await run(tab, { type: 'machine.contribute', machineId: 'default-host', name: 'Default laptop', cwd: '/project', engines: ['codex'], maxAgents: 2 }, host)
    const generation = (await poolRows(store, team.session, 'default-host'))[0]!.machine.generation
    await store.observeMachine(team.session, tab, 'default-host', { generation, resources: { cpuPercent: 10, memoryTotalBytes: 32e9, memoryUsedBytes: 4e9,
      diskFreeBytes: 120e9, diskTotalBytes: 500e9, projectDiskFreeBytes: 120e9, deviceType: 'Laptop', chip: 'Fixture CPU', os: 'macOS', gpuPercent: null },
      quotas: [], tools: { git: true }, runningHarnessIds: [], stoppedHarnessIds: [], privacy: team.privacy })
    const group = String((await run(tab, { type: 'conversation.create', title: 'Fix', brief: 'Fix it.',
      checks: [{ description: 'Independent review', independent: true }] })).result.conversationId)
    const review = async () => String((await run(tab, { type: 'conversation.create', title: 'Review', brief: 'Review it.', reviewOf: group,
      checks: [{ description: 'Verdict', independent: false }] })).result.conversationId)
    const first = await review()
    const startId = String((await run(tab, { type: 'agent.start', request: { conversationId: first, role: 'reviewer', machineId: 'default-host', engine: 'codex',
      name: 'Reviewer', cwd: '/project', worktree: true, requirements: { memoryBytes: 0, diskBytes: 0, maxCpuPercent: 100, tools: [], devices: [], quotaRequired: false } } })).result.startId)
    const hostRun = (command: Command) => store.execute(team.session, tab, { operationId: randomUUID(), command }, undefined, 'default-host')
    await hostRun({ type: 'agent.startDispatch', startId })
    const agentId = String((await hostRun({ type: 'agent.started', startId, harnessId: 'default-reviewer',
      configuration: { engine: 'codex', model: null, effort: null, contextWindow: null, engineVersion: null } })).result.agentId)
    await hostRun({ type: 'agent.startSettled', startId, warning: null })
    const assign = async (conversationId: string) => (await run(tab, { type: 'work.assign', conversationId, agentId })).result.warnings
    expect(await assign(first)).toBeUndefined()
    const previousVersion = (await storedState(tab)).agents.find(a => a.id === agentId)!.configurationVersion!
    await run(tab, { type: 'agent.configuration', previousVersion, configuration: { engine: 'codex', model: 'gpt-6.1-sol', effort: null, contextWindow: null, engineVersion: null } }, team.session, agentId)
    const firstWork = (await store.read(owner, tab)).state.conversations.find(c => c.id === first)!.assignment!.id
    await run(tab, { type: 'work.cancel', conversationId: first, assignmentId: firstWork, reason: 'Again.' })
    expect(await assign(await review())).toBeUndefined()
  })

  it('tells a contributed machine its start\'s project skills, which its host cannot read from the Swarm', async () => {
    // Prod logs 2026-10-28: the host asked for a Swarm status read it may not make (a 400 at every start), then launched
    // every agent on Harness orchestration, whatever its project ran.
    const tab = (await store.create(owner, randomUUID(), 'Skills pool')).id
    const invitation = await run(tab, { type: 'invite.create', email: host.email, role: 'collaborator', conversationId: 'lead' })
    await run(tab, { type: 'invite.accept', inviteId: invitation.result.inviteId as string }, host)
    await db.machine.create({ data: { machineId: 'skills-host', userId: host.sub, apiKey: 'fixture-skills-host', managerId: 'fixture', autonomousEnv: 'prod', authMode: 'remote' } })
    const team = await teamMachine('skills-host')
    await run(tab, { type: 'machine.contribute', machineId: 'skills-host', name: 'Skills laptop', cwd: '/project', engines: ['claude'], maxAgents: 4 }, host)
    const generation = (await poolRows(store, team.session, 'skills-host'))[0]!.machine.generation
    await store.observeMachine(team.session, tab, 'skills-host', { generation, resources: { cpuPercent: 10, memoryTotalBytes: 32e9, memoryUsedBytes: 4e9,
      diskFreeBytes: 120e9, diskTotalBytes: 500e9, projectDiskFreeBytes: 120e9, deviceType: 'Laptop', chip: 'Fixture CPU', os: 'macOS', gpuPercent: null },
      quotas: [], tools: { git: true }, runningHarnessIds: [], stoppedHarnessIds: [], privacy: team.privacy })
    const start = async () => String((await run(tab, { type: 'agent.start', request: { conversationId: 'lead', machineId: 'skills-host', engine: 'claude',
      name: 'Builder', cwd: '/project', worktree: true,
      requirements: { memoryBytes: 0, diskBytes: 0, maxCpuPercent: 100, tools: [], devices: [], quotaRequired: false } } })).result.startId)
    const skillMode = async (startId: string) => (await store.start(team.session, tab, startId, undefined, 'skills-host')).skillMode

    expect(await skillMode(await start())).toBe('default')
    await run(tab, { type: 'project.skills', projectId: 'lead', mode: 'orchestration' })
    expect(await skillMode(await start())).toBe('orchestration')
    await run(tab, { type: 'project.roles.create', projectId: 'lead', roles: [{ id: 'lead', name: 'Product Manager', kind: 'lead', text: 'LEAD' },
      { id: 'dev', name: 'Engineer', kind: 'builder', text: 'DEV' }, { id: 'review', name: 'Reviewer', kind: 'reviewer', text: 'REVIEW' }] })
    await run(tab, { type: 'project.skills', projectId: 'lead', mode: 'custom' })
    // A Custom set is the Default skills with the owner's role text, which the agent reads after it joins.
    expect(await skillMode(await start())).toBe('default')
  })

  it('contributes project capacity without sharing the computer and fences host execution', async () => {
    const tab = (await store.create(owner, randomUUID(), 'Machine pool')).id
    const invitation = await run(tab, { type: 'invite.create', email: host.email, role: 'collaborator', conversationId: 'lead' })
    await run(tab, { type: 'invite.accept', inviteId: invitation.result.inviteId as string }, host)
    const contribute = { type: 'machine.contribute' as const, machineId: 'pool-host', name: 'Host laptop', cwd: '/project', engines: ['codex' as const], maxAgents: 1 }
    await db.machine.create({ data: { machineId: 'pool-host', userId: host.sub, apiKey: 'fixture-pool-only', managerId: 'fixture', autonomousEnv: 'prod', authMode: 'remote' } })
    const team = await teamMachine('pool-host')
    await expect(run(tab, contribute)).rejects.toMatchObject({ code: 'HOST_REQUIRED' })
    await run(tab, contribute, host)
    expect(await db.machineShare.findUnique({ where: { machineId: 'pool-host' } })).toBeNull()
    const pools = await poolRows(store, team.session, 'pool-host')
    expect(pools).toHaveLength(1)
    const generation = pools[0]!.machine.generation
    const observation = { generation, resources: { cpuPercent: 10, memoryTotalBytes: 32e9, memoryUsedBytes: 4e9, diskFreeBytes: 120e9, diskTotalBytes: 500e9,
      projectDiskFreeBytes: 120e9, deviceType: 'Laptop', chip: 'Fixture CPU', os: 'macOS', gpuPercent: null }, quotas: [], tools: { git: true }, runningHarnessIds: [], stoppedHarnessIds: [] }
    await expect(store.observeMachine(owner, tab, 'pool-host', observation)).rejects.toMatchObject({ code: 'CONTRIBUTION_REVOKED' })
    await store.observeMachine(team.session, tab, 'pool-host', { ...observation, privacy: team.privacy })
    const request = { permissionMode: 'full', conversationId: 'lead', machineId: 'pool-host', engine: 'codex', name: 'Builder', cwd: '/project', worktree: true,
      requirements: { memoryBytes: 0, diskBytes: 0, maxCpuPercent: 100, tools: [], devices: [], quotaRequired: false } }
    await expect(run(tab, { type: 'agent.start', request: { ...request, cwd: '/private' } })).rejects.toMatchObject({ code: 'OUTSIDE_CONTRIBUTION' })
    await expect(run(tab, { type: 'agent.start', request: { ...request, permissionMode: 'bypassPermissions' } })).rejects.toMatchObject({ code: 'OUTSIDE_CONTRIBUTION' })
    const starts = await Promise.allSettled([run(tab, { type: 'agent.start', request }), run(tab, { type: 'agent.start', request })])
    expect(starts.filter(r => r.status === 'fulfilled')).toHaveLength(1)
    expect(starts.filter(r => r.status === 'rejected')).toHaveLength(1)
    const startId = (starts.find(r => r.status === 'fulfilled') as PromiseFulfilledResult<Awaited<ReturnType<typeof run>>>).value.result.startId as string
    const queued = await store.start(owner, tab, startId)
    expect(queued.poolGeneration).toBe(generation)
    expect(queued.request.permissionMode).toBe('full')
    await expect(run(tab, { type: 'agent.startDispatch', startId })).rejects.toMatchObject({ code: 'HOST_REQUIRED' })
    await expect(store.start(peer, tab, startId, undefined, 'pool-host')).rejects.toMatchObject({ code: 'FORBIDDEN' })
    const hostRun = (command: Command) => store.execute(team.session, tab, { operationId: randomUUID(), command }, undefined, 'pool-host')
    await expect(hostRun(message('Not a generic proxy'))).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await run(tab, { type: 'machine.pause', machineId: 'pool-host', paused: true }, host)
    await expect(hostRun({ type: 'agent.startDispatch', startId })).rejects.toMatchObject({ code: 'MACHINE_PAUSED' })
    await run(tab, { type: 'machine.pause', machineId: 'pool-host', paused: false }, host)
    await hostRun({ type: 'agent.startDispatch', startId })
    await expect(hostRun({ type: 'agent.startDispatch', startId })).rejects.toMatchObject({ code: 'START_CLAIMED' })
    await hostRun({ type: 'agent.started', startId, harnessId: 'pool-builder', configuration: config })
    const pendingAgent = (await store.read(owner, tab)).state.agents[0]!
    await expect(run(tab, { type: 'work.assign', conversationId: 'lead', agentId: pendingAgent.id })).rejects.toMatchObject({ code: 'START_PENDING' })
    await expect(run(tab, contribute, host)).rejects.toMatchObject({ code: 'STARTS_PENDING' })
    await expect(run(tab, { type: 'agent.startSettled', startId, warning: null })).rejects.toMatchObject({ code: 'HOST_REQUIRED' })
    await hostRun({ type: 'agent.startSettled', startId, warning: null })
    expect((await store.start(owner, tab, startId)).poolSettled).toBe(true)
    expect((await store.read(owner, tab)).state.agents[0]).toMatchObject({ contributorId: host.sub, machineOwnerId: host.sub, harnessId: 'pool-builder' })
    await run(tab, { type: 'member.remove', userId: host.sub })
    expect(await poolRows(store, team.session, 'pool-host')).toEqual([])
    // The machine stays listed while its host cleans up, but its owner left: a reading is refused as theirs no longer.
    await expect(store.observeMachine(team.session, tab, 'pool-host', observation)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(store.start(team.session, tab, startId, undefined, 'pool-host')).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('resolves a reply beyond recent history without crossing conversation or membership boundaries', async () => {
    const { tab, lead } = await fixture()
    const question = (await run(tab, message('Should pending edits survive restart?'), host, lead)).result.messageId as string
    for (let i = 0; i < 101; i++) await run(tab, message(`Later update ${i}`), host, lead)
    expect((await store.messages(host, tab, 'lead', {}, lead)).messages.some(row => row.id === question)).toBe(false)
    const url = `/api/super-tabs/${tab}/conversations/lead/messages?asAgentId=${lead}&messageId=${question}`
    const headers = { authorization: `Bearer ${host.sub}` }
    const original = await app.inject({ url, headers })
    expect(original.statusCode).toBe(200)
    expect(original.json().data.messages).toMatchObject([{ id: question, text: 'Should pending edits survive restart?' }])
    expect(original.json().data.messages).toHaveLength(1)
    expect((await app.inject({ url: `${url}&before=100`, headers })).statusCode).toBe(400)
    const group = (await run(tab, { type: 'conversation.create', title: 'Other work', brief: '', checks: [] })).result.conversationId as string
    expect((await store.messages(host, tab, group, { messageId: question }, lead)).messages).toEqual([])
    expect((await app.inject({ url: `/api/super-tabs/${tab}/conversations/lead/messages?messageId=${question}`,
      headers: { authorization: `Bearer ${peer.sub}` } })).statusCode).toBe(403)
    await run(tab, { type: 'project.delete', projectId: 'lead' })
    const removed = await app.inject({ url, headers })
    expect(removed.statusCode).toBe(409)
    expect(removed.json().error.code).toBe('AGENT_UNAVAILABLE')
  })

  it('records native turns once, in order, with verified source metadata and no input echo', async () => {
    const { tab, lead } = await fixture()
    await invite(tab)
    // Only the Lead's machine's owner drives it (terminal.ts mayDrive); the execution host alone records and reads it.
    await joinHost(tab)
    const request = { operationId: randomUUID(), conversationId: 'lead', agentId: lead }
    const { contextId } = await store.native.open(host, tab, request)
    expect(await store.native.open(host, tab, request)).toEqual({ contextId })
    await expect(store.native.read(peer, tab, contextId)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(await store.native.read(host, tab, contextId)).toMatchObject({ agentId: lead, machineId: 'test-host',
      operator: { id: host.sub, kind: 'person' }, lastEventId: null })
    const prompt = { turnId: randomUUID(), kind: 'prompt' as const, previousEventId: null,
      text: 'A native intervention', truncated: false, interrupted: false }
    await expect(store.native.append(owner, tab, contextId, prompt)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    const posted = await Promise.all(Array.from({ length: 3 }, () => store.native.append(host, tab, contextId, prompt)))
    expect(posted[1]).toEqual(posted[0])
    await expect(store.native.append(host, tab, contextId, { ...prompt, text: 'Changed content' })).rejects.toMatchObject({ code: 'OPERATION_REUSED' })
    const first = posted[0] as { eventId: string }
    const answer = { ...prompt, kind: 'answer' as const, text: 'A native answer', interrupted: true }
    await expect(store.native.append(host, tab, contextId, answer)).rejects.toMatchObject({ code: 'NATIVE_ORDER_CHANGED' })
    await expect(store.native.append(host, tab, contextId, { ...answer, turnId: randomUUID(), previousEventId: first.eventId }))
      .rejects.toMatchObject({ code: 'NATIVE_PROMPT_MISSING' })
    const second = await store.native.append(host, tab, contextId, { ...answer, previousEventId: first.eventId })
    expect(await store.native.append(host, tab, contextId, prompt)).toEqual(first)
    const rows = (await store.messages(owner, tab, 'lead', {})).messages
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ text: prompt.text, author: { kind: 'agent', id: lead },
      source: { kind: 'native', phase: 'prompt', operator: { id: host.sub, kind: 'person' } } })
    expect(rows[1]).toMatchObject({ replyTo: first.eventId, text: answer.text, source: { interrupted: true, phase: 'answer' } })
    expect(rows[0]!.source).not.toHaveProperty('contextId')
    expect(rows[1]!.sequence).toBeGreaterThan(rows[0]!.sequence)
    expect((await store.native.read(host, tab, contextId)).lastEventId).toBe((second as { eventId: string }).eventId)
    expect(await store.deliveries(host, tab, lead)).toEqual([])
    const forged = await app.inject({ method: 'POST', url: `/api/super-tabs/${tab}/native/${contextId}`,
      headers: { authorization: `Bearer ${host.sub}` }, payload: { ...prompt, operator: { id: owner.sub } } })
    expect(forged.statusCode).toBe(400)
  })

  it('keeps native observations in the chosen group and informs its lead without reviving a withdrawn context', async () => {
    const { tab, lead } = await fixture()
    const group = (await run(tab, { type: 'conversation.create', title: 'Implementation', brief: '', checks: [] })).result.conversationId as string
    const worker = (await run(tab, { type: 'agent.add', conversationId: group, machineId: 'test-host', harnessId: randomUUID(),
      name: 'Builder', configuration: config, lead: false })).result.agentId as string
    const request = { operationId: randomUUID(), conversationId: group, agentId: worker }
    const { contextId } = await store.native.open(owner, tab, request)
    await expect(store.native.open(owner, tab, { ...request, conversationId: 'lead' })).rejects.toMatchObject({ code: 'AGENT_UNAVAILABLE' })
    const event = { turnId: randomUUID(), kind: 'prompt' as const, previousEventId: null,
      text: 'Change this implementation', truncated: false, interrupted: false }
    const receipt = await store.native.append(host, tab, contextId, event) as { eventId: string }
    expect((await store.messages(owner, tab, 'lead', {})).messages).toHaveLength(0)
    expect((await store.messages(owner, tab, group, {})).messages).toHaveLength(1)
    expect(await store.deliveries(host, tab, worker)).toEqual([])
    const notifications = await store.deliveries(host, tab, lead)
    expect(notifications).toHaveLength(1)
    expect(notifications[0]).toMatchObject({ conversationId: group, nativeContextId: contextId, messageId: receipt.eventId })
    await run(tab, { type: 'conversation.agent', conversationId: group, agentId: worker, present: false, lead: false })
    await run(tab, { type: 'conversation.agent', conversationId: group, agentId: worker, present: true, lead: false })
    await expect(store.native.read(host, tab, contextId)).rejects.toMatchObject({ code: 'NATIVE_CONTEXT_REVOKED' })
    await expect(store.native.open(owner, tab, request)).rejects.toMatchObject({ code: 'NATIVE_CONTEXT_REVOKED' })
    expect(await store.deliveries(host, tab, lead)).toEqual([])
    expect((await db.superTabDelivery.findUnique({ where: { id: notifications[0]!.id } }))!.status).toBe('cancelled')
    expect(await store.native.open(owner, tab, { ...request, operationId: randomUUID() })).not.toEqual({ contextId })
  })

  it('requires machine control as well as collaboration and fences removal, re-invitation and changed machine grants', async () => {
    const { tab } = await fixture()
    await invite(tab, 'viewer')
    // A member's terminal on a Builder: only its machine's owner drives a Lead (terminal.ts mayDrive).
    const group = String((await run(tab, { type: 'conversation.create', title: 'Build', brief: '', checks: [] })).result.conversationId)
    const worker = String((await run(tab, { type: 'agent.add', conversationId: group, machineId: 'test-host', harnessId: randomUUID(),
      name: 'Builder', configuration: config, lead: false })).result.agentId)
    const request = { operationId: randomUUID(), conversationId: group, agentId: worker }
    await expect(store.native.open(peer, tab, request)).rejects.toMatchObject({ code: 'READ_ONLY' })
    await run(tab, { type: 'member.remove', userId: peer.sub })
    await invite(tab)
    const { contextId } = await store.native.open(peer, tab, request)
    const event = { turnId: randomUUID(), kind: 'gap' as const, previousEventId: null,
      text: 'Caller text must not impersonate a gap explanation', truncated: false, interrupted: false }
    await store.native.append(host, tab, contextId, event)
    expect((await store.messages(owner, tab, group, {})).messages[0]!.text).toContain('Some terminal activity could not be recorded')
    const original = (await db.machineShare.findUnique({ where: { machineId: 'test-host' } }))!
    await db.machineShare.update({ where: { machineId: 'test-host' }, data: { emails: [owner.email],
      grantVersions: nextMachineShareGrants(original, [owner.email], null) } })
    try {
      await expect(store.native.open(peer, tab, { ...request, operationId: randomUUID() })).rejects.toMatchObject({ code: 'HOST_REQUIRED' })
      await expect(store.native.read(host, tab, contextId)).rejects.toMatchObject({ code: 'HOST_REQUIRED' })
      await db.machineShare.update({ where: { machineId: 'test-host' }, data: {
        emails: original.emails, grantVersions: nextMachineShareGrants({ ...original, emails: [owner.email] }, original.emails, null),
      } })
      await expect(store.native.read(host, tab, contextId)).rejects.toMatchObject({ code: 'NATIVE_CONTEXT_REVOKED' })
    } finally {
      const current = await db.machineShare.findUniqueOrThrow({ where: { machineId: 'test-host' } })
      await db.machineShare.update({ where: { machineId: 'test-host' }, data: { emails: original.emails,
        grantVersions: nextMachineShareGrants(current, original.emails, null) } })
    }
    await run(tab, { type: 'member.remove', userId: peer.sub })
    await invite(tab)
    await expect(store.native.read(host, tab, contextId)).rejects.toMatchObject({ code: 'NATIVE_CONTEXT_REVOKED' })
  })

  it('keeps an ordered configuration history, rejects stale observations and authorizes the execution host alone', async () => {
    const { tab, lead } = await fixture()
    await run(tab, { type: 'work.define', conversationId: 'lead', brief: 'A measured result', checks: [{ description: 'Verified evidence', independent: false }] })
    const assigned = await run(tab, { type: 'work.assign', conversationId: 'lead', agentId: lead })
    const before = (await store.read(owner, tab)).state.agents[0]!.configurationVersion!
    const command: Command = { type: 'agent.configuration', previousVersion: before,
      configuration: { ...config, model: 'observed-model', effort: 'max', contextWindow: null } }
    await expect(run(tab, command)).rejects.toMatchObject({ code: 'HOST_REQUIRED' })
    await expect(run(tab, command, peer, lead)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    const id = randomUUID()
    const first = await run(tab, command, host, lead, id)
    expect(await run(tab, command, host, lead, id)).toEqual(first)
    await expect(run(tab, command, host, lead)).rejects.toMatchObject({ code: 'STALE_CONFIGURATION' })
    const current = (await store.read(owner, tab)).state.agents[0]!
    await run(tab, { ...command, previousVersion: current.configurationVersion! }, host, lead)
    const records = await db.superTabConfiguration.findMany({ where: { tabId: tab, agentId: lead }, orderBy: { revision: 'asc' } })
    expect(records).toHaveLength(2)
    expect(records[0]!.configuration).toEqual(config)
    expect(records[1]).toMatchObject({ configuration: command.configuration, actorKey: `agent:${lead}`, assignmentIds: [assigned.result.assignmentId] })
    expect((await store.read(owner, tab)).state.conversations[0]!.assignment!.configuration).toEqual(config)
    const next = { ...command, previousVersion: current.configurationVersion!, configuration: config }
    const race = await Promise.allSettled([run(tab, next, host, lead), run(tab, { ...next, configuration: { ...config, effort: 'low' } }, host, lead)])
    expect(race.filter(r => r.status === 'fulfilled')).toHaveLength(1)
    expect(await db.superTabConfiguration.count({ where: { tabId: tab } })).toBe(3)
    // A Lead leaves only with its project, and a project with active work is not deleted.
    await run(tab, { type: 'work.cancel', conversationId: 'lead', assignmentId: assigned.result.assignmentId as string, reason: 'The project closes.' })
    await run(tab, { type: 'project.delete', projectId: 'lead' })
    await expect(run(tab, next, host, lead)).rejects.toMatchObject({ code: 'AGENT_UNAVAILABLE' })
    expect(await db.superTabConfiguration.count({ where: { tabId: tab } })).toBe(3)
  })

  it('records a claimed delivery hold for the claim holder only and posts nothing in the conversation', async () => {
    const { tab, lead } = await fixture()
    await run(tab, message('Please start.'))
    const delivery = (await store.deliveries(host, tab, lead))[0]!
    await expect(store.delivery(host, tab, lead, delivery.id, { type: 'hold', claimId: 'claim', reason: 'team_waiting_draft' }))
      .rejects.toMatchObject({ code: 'NOT_CLAIMED' })
    await store.delivery(host, tab, lead, delivery.id, { type: 'claim', claimId: 'claim' })
    await expect(store.delivery(host, tab, lead, delivery.id, { type: 'hold', claimId: 'another', reason: 'team_waiting_draft' }))
      .rejects.toMatchObject({ code: 'CLAIM_CONFLICT' })
    expect(await store.delivery(host, tab, lead, delivery.id, { type: 'hold', claimId: 'claim', reason: 'team_waiting_user' })).toEqual({ held: true })
    expect(await db.superTabDelivery.findUnique({ where: { id: delivery.id } })).toMatchObject({ holdReason: 'team_waiting_user' })
    expect((await store.messages(owner, tab, 'lead', {})).messages.map(m => m.text)).toEqual(['Please start.'])
    await store.delivery(host, tab, lead, delivery.id, { type: 'ack', claimId: 'claim', receipt: 'done', uncertain: false })
    expect(await store.delivery(host, tab, lead, delivery.id, { type: 'hold', claimId: 'claim', reason: 'team_waiting_idle' })).toEqual({ held: false })
  })

  it('files replies under their thread root, summarises each thread for its page, and reads one thread', async () => {
    const { tab, lead } = await fixture()
    await invite(tab)
    const reply = (text: string, replyTo: string, extra: Record<string, unknown> = {}) =>
      ({ type: 'message.send', conversationId: 'lead', text, replyTo, recipientIds: [], ...extra }) as Command
    const root = String((await run(tab, message('Should we do thread replies?'))).result.messageId)
    const first = String((await run(tab, reply('Yes, threads.', root, { mentions: [owner.sub] }), host, lead)).result.messageId)
    // A reply only in its thread leaves the chat's newest main-stream message where it was; an also-sent one moves it.
    const lead1 = async () => (await store.read(owner, tab)).state.conversations.find(c => c.id === 'lead')!
    const afterFirst = await lead1()
    expect(afterFirst.lastMainSequence).toBe(afterFirst.lastMessageSequence - 1)
    const second = String((await run(tab, reply('Agreed.', first, { alsoSend: true }), peer)).result.messageId)
    const after = String((await run(tab, message('Next topic.'))).result.messageId)
    const afterAll = await lead1()
    expect(afterAll.lastMainSequence).toBe(afterAll.lastMessageSequence)

    // Agents read one feed: every reply, each with its thread root.
    const feed = (await store.messages(host, tab, 'lead', {}, lead)).messages
    expect(feed.map(m => [m.id, m.thread, m.alsoInChat ?? null])).toEqual(
      [[root, root, null], [first, root, null], [second, root, true], [after, after, null]])
    expect(feed.find(m => m.id === second)!.replyTo).toBe(first)
    const page = await store.messages(owner, tab, 'lead', {})
    const last = feed.find(m => m.id === second)!
    expect(page.threads).toEqual([{ id: root, replies: 2, lastSequence: last.sequence, lastAt: last.createdAt,
      authors: [expect.objectContaining({ kind: 'person', id: peer.sub }), expect.objectContaining({ kind: 'agent', id: lead })],
      people: [owner.sub, peer.sub] }])
    // A poll that reads only a new reply still learns its root's summary.
    const poll = await store.messages(owner, tab, 'lead', { after: feed.find(m => m.id === first)!.sequence })
    expect(poll.threads.map(t => [t.id, t.replies])).toEqual([[root, 2]])

    const thread = await store.messages(owner, tab, 'lead', { thread: root })
    expect(thread.messages.map(m => m.id)).toEqual([root, first, second])
    expect(thread.threads.map(t => t.id)).toEqual([root])

    // A person who leaves is no longer named, though their reply stays.
    await run(tab, { type: 'member.remove', userId: peer.sub })
    const left = (await store.messages(owner, tab, 'lead', { thread: root })).threads[0]!
    expect(left.people).toEqual([owner.sub])
    expect(left.authors.map(a => a.id)).toEqual([lead])
    expect(left.replies).toBe(2)
  })

  it('keeps a reply to a message written before threads inline, and refuses a thread of a conversation the reader cannot see', async () => {
    const { tab } = await fixture()
    await invite(tab)
    const old = randomUUID().replaceAll('-', '').slice(0, 24)
    await db.superTabMessage.create({ data: { id: old, tabId: tab, conversationId: 'lead', sequence: 0,
      author: { kind: 'person', id: owner.sub, name: owner.email, membershipGeneration: 'g' }, text: 'Before threads.', recipientIds: [], mentions: [] } })
    const answer = String((await run(tab, { type: 'message.send', conversationId: 'lead', text: 'Answered inline.', replyTo: old, recipientIds: [],
      alsoSend: true }, peer)).result.messageId)
    const rows = (await store.messages(owner, tab, 'lead', {})).messages
    expect(rows.find(m => m.id === answer)).toMatchObject({ replyTo: old, thread: answer, alsoInChat: null })
    expect(rows.find(m => m.id === old)!.thread).toBeNull()

    const project = (await run(tab, { type: 'project.create', name: 'Private project', visibility: 'private', brief: '' })).result
    const hidden = String(project.conversationId)
    const secret = String((await run(tab, { ...message('Private root'), conversationId: hidden } as Command)).result.messageId)
    await expect(store.messages(peer, tab, hidden, { thread: secret })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    // A root named under another conversation reads nothing of it.
    expect((await store.messages(peer, tab, 'lead', { thread: secret })).messages).toEqual([])
  })

  it('delivers a Lead\'s agent-only notice to the Lead once and shows it to no person in the project chat', async () => {
    const { tab, lead } = await fixture()
    await invite(tab)
    const before = (await store.read(owner, tab)).state.conversations.find(c => c.id === 'lead')!.lastMessageSequence
    const notice: Command = { type: 'message.send', conversationId: 'lead', text: 'Harness updated your built-in swarm-lead skill.',
      replyTo: null, recipientIds: [lead], agentOnly: true }
    const sent = await run(tab, notice, host, lead, 'skill-notice')
    await run(tab, notice, host, lead, 'skill-notice')
    const deliveries = (await store.deliveries(host, tab, lead)).filter(d => d.messageId === sent.result.messageId)
    expect(deliveries).toHaveLength(1)
    for (const person of [owner, peer]) {
      expect((await store.messages(person, tab, 'lead', {})).messages).toEqual([])
      expect((await store.messages(person, tab, 'lead', { messageId: sent.result.messageId as string })).messages).toEqual([])
    }
    expect((await store.read(owner, tab)).state.conversations.find(c => c.id === 'lead')!.lastMessageSequence).toBe(before)
    expect((await store.messages(host, tab, 'lead', {}, lead)).messages.map(m => m.text)).toEqual(['Harness updated your built-in swarm-lead skill.'])
    // Typed through the normal claim; a hold while the input box is busy is recorded on the delivery, so the delivery pass
    // knows its host still holds it (deliverySettle.ts), and writes no row people would see.
    const claimed = await store.delivery(host, tab, lead, deliveries[0]!.id, { type: 'claim', claimId: 'claim' })
    expect(claimed.message).toMatchObject({ text: 'Harness updated your built-in swarm-lead skill.', source: { kind: 'agent-only' } })
    expect(await store.delivery(host, tab, lead, deliveries[0]!.id, { type: 'hold', claimId: 'claim', reason: 'team_waiting_draft' })).toEqual({ held: true })
    expect(await db.superTabDelivery.findUniqueOrThrow({ where: { id: deliveries[0]!.id } })).toMatchObject({ holdReason: 'team_waiting_draft' })
    expect((await store.messages(owner, tab, 'lead', {})).messages).toEqual([])
  })

  it('delivers a worker\'s agent-only notice once in its group and lists it for no person and not for its Lead', async () => {
    const { tab, lead } = await fixture()
    const group = (await run(tab, { type: 'conversation.create', title: 'Worker task', brief: 'Work', checks: [{ description: 'Done', independent: false }] })).result.conversationId as string
    const worker = (await run(tab, { type: 'agent.add', conversationId: group, machineId: 'test-host', harnessId: randomUUID(), name: 'Worker', configuration: config, lead: false })).result.agentId as string
    await run(tab, { type: 'work.assign', conversationId: group, agentId: worker })
    const before = (await store.read(owner, tab)).state.conversations.find(c => c.id === group)!.lastMessageSequence
    const notice: Command = { type: 'message.send', conversationId: group, text: 'Harness updated your built-in swarm-dev skill.',
      replyTo: null, recipientIds: [worker], agentOnly: true }
    const sent = await run(tab, notice, host, worker, 'worker-notice')
    await run(tab, notice, host, worker, 'worker-notice')
    expect((await store.deliveries(host, tab, worker)).filter(d => d.messageId === sent.result.messageId)).toHaveLength(1)
    expect((await store.deliveries(host, tab, lead)).filter(d => d.messageId === sent.result.messageId)).toEqual([])
    expect((await store.messages(owner, tab, group, {})).messages.map(m => m.id)).not.toContain(sent.result.messageId)
    expect((await store.messages(host, tab, group, {}, lead)).messages.map(m => m.id)).not.toContain(sent.result.messageId)
    expect((await store.messages(host, tab, group, {}, worker)).messages.map(m => m.id)).toContain(sent.result.messageId)
    expect((await store.read(owner, tab)).state.conversations.find(c => c.id === group)!.lastMessageSequence).toBe(before)
  })

  it('reads past more than a page of hidden notices so a person still reaches every later message', async () => {
    const { tab, lead } = await fixture()
    const first = (await run(tab, message('Before the notices.'))).result.messageId as string
    for (let i = 0; i < 120; i++) {
      await run(tab, { type: 'message.send', conversationId: 'lead', text: `Notice ${i}.`, replyTo: null, recipientIds: [lead], agentOnly: true }, host, lead)
    }
    const last = (await run(tab, message('After the notices.'))).result.messageId as string
    // Desktop's first read, then its next read after the last row it shows (desktop/lib/super_tabs/controller.dart).
    const opened = await store.messages(owner, tab, 'lead', {})
    expect(opened.messages.map(m => m.id)).toEqual([first, last])
    expect(opened.next).toBeNull()
    const tail = opened.messages[0]!.sequence
    expect((await store.messages(owner, tab, 'lead', { after: tail })).messages.map(m => m.id)).toEqual([last])
    expect((await store.messages(owner, tab, 'lead', { before: opened.messages[1]!.sequence })).messages.map(m => m.id)).toEqual([first])
    // The Lead pages through all of its own notices, a full page then the rest.
    const page = await store.messages(host, tab, 'lead', {}, lead)
    expect(page.messages).toHaveLength(100)
    const rest = await store.messages(host, tab, 'lead', { before: page.next!.sequence, beforeId: page.next!.id }, lead)
    expect([...rest.messages, ...page.messages].map(m => m.text)).toEqual(['Before the notices.', ...Array.from({ length: 120 }, (_, i) => `Notice ${i}.`), 'After the notices.'])
    expect(rest.next).toBeNull()
  })

  it('pages through older rows that share one sequence without skipping any at a page edge', async () => {
    const { tab } = await fixture()
    // Before the store by parts, every row one command wrote shared that command's tab revision.
    const ids = Array.from({ length: 150 }, (_, i) => `shared-${String(i).padStart(3, '0')}`)
    await db.superTabMessage.createMany({ data: ids.map(id => ({ id, tabId: tab, conversationId: 'lead', sequence: 0,
      author: { kind: 'person', id: owner.sub, name: owner.email }, text: id, replyTo: null, recipientIds: [] })) })
    const page = await store.messages(owner, tab, 'lead', { before: 1 })
    expect(page.messages).toHaveLength(100)
    expect(page.next).toEqual({ sequence: 0, id: page.messages[0]!.id })
    const rest = await store.messages(owner, tab, 'lead', { before: page.next!.sequence, beforeId: page.next!.id })
    expect([...rest.messages, ...page.messages].map(m => m.id)).toEqual(ids)
    expect(rest.next).toBeNull()
  })

  it('reads each hidden row once on its way to a page, however many there are, even when they share a sequence', async () => {
    const { tab, lead } = await fixture()
    // 2,000 of the Lead's notices, as one command before the store by parts wrote them: on one sequence, between two posts.
    const row = (id: string, sequence: number, hidden: boolean) => ({ id, tabId: tab, conversationId: 'lead', sequence,
      author: { kind: 'person', id: owner.sub, name: owner.email }, text: id, replyTo: null, recipientIds: hidden ? [lead] : [],
      ...(hidden ? { source: { kind: 'agent-only' } } : {}) })
    await db.superTabMessage.createMany({ data: [row('a-first', 0, false),
      ...Array.from({ length: 2_000 }, (_, i) => row(`b-notice-${String(i).padStart(4, '0')}`, 1, true)), row('c-last', 2, false)] })
    // What MongoDB reads of the messages for one page: an offset is walked in the index (keys), rows are fetched (documents).
    const examined = async (read: () => Promise<unknown>) => {
      await db.$runCommandRaw({ profile: 2 })
      try { await read() } finally { await db.$runCommandRaw({ profile: 0 }) }
      const { cursor } = await db.$runCommandRaw({ find: 'system.profile', filter: {}, projection: { ns: 1, keysExamined: 1, docsExamined: 1 }, limit: 1000 }) as
        { cursor: { firstBatch: Array<{ ns: string; keysExamined?: number; docsExamined?: number }> } }
      await db.$runCommandRaw({ drop: 'system.profile' })
      return cursor.firstBatch.filter(entry => entry.ns.endsWith('.SuperTabMessage'))
        .reduce((sum, entry) => sum + (entry.keysExamined ?? 0) + (entry.docsExamined ?? 0), 0)
    }
    let opened!: Awaited<ReturnType<typeof store.messages>>
    expect(await examined(async () => { opened = await store.messages(owner, tab, 'lead', {}) })).toBeLessThan(6_000)
    expect(opened.messages.map(m => m.id)).toEqual(['a-first', 'c-last'])
    expect(opened.next).toBeNull()
    expect((await store.messages(owner, tab, 'lead', { after: 0 })).messages.map(m => m.id)).toEqual(['c-last'])
  })

  it('accepts an agent-only notice only from an agent to itself alone', async () => {
    const { tab, lead } = await fixture()
    const worker = (await run(tab, { type: 'agent.add', conversationId: 'lead', machineId: 'test-host', harnessId: randomUUID(), name: 'Worker', configuration: config, lead: false })).result.agentId as string
    const notice = (recipientIds: string[]): Command => ({ type: 'message.send', conversationId: 'lead', text: 'Skill changed.', replyTo: null, recipientIds, agentOnly: true })
    await expect(run(tab, notice([lead]))).rejects.toMatchObject({ code: 'INVALID_RECIPIENT' })
    await expect(run(tab, notice([worker]), host, lead)).rejects.toMatchObject({ code: 'INVALID_RECIPIENT' })
    await expect(run(tab, notice([lead, worker]), host, lead)).rejects.toMatchObject({ code: 'INVALID_RECIPIENT' })
    await expect(run(tab, notice([]), host, lead)).rejects.toMatchObject({ code: 'INVALID_RECIPIENT' })
    // A tag would tell a person about a notice they cannot see.
    await invite(tab)
    await expect(run(tab, { ...notice([lead]), mentions: [peer.sub] } as Command, host, lead)).rejects.toMatchObject({ code: 'INVALID_RECIPIENT' })
    expect((await store.messages(owner, tab, 'lead', {})).messages).toEqual([])
  })

  it('stores the current delivery hold and its first time without a conversation notice', async () => {
    const { tab, lead } = await fixture()
    let now = Date.now()
    const timed = new SuperTabStore(db, () => now)
    await run(tab, message('Keep the reason beside this instruction.'))
    const delivery = (await store.deliveries(host, tab, lead))[0]!
    await timed.delivery(host, tab, lead, delivery.id, { type: 'claim', claimId: 'claim' })
    const since = new Date(now)
    for (const reason of ['team_waiting_idle', 'team_waiting_user', 'team_waiting_draft', 'team_waiting_control', 'team_waiting_unavailable'] as const) {
      await timed.delivery(host, tab, lead, delivery.id, { type: 'hold', claimId: 'claim', reason })
      expect(await db.superTabDelivery.findUnique({ where: { id: delivery.id } })).toMatchObject({ holdReason: reason, holdSince: since })
      const rows = (await timed.messages(owner, tab, 'lead', {})).messages
      expect(rows).toHaveLength(1)
      expect(rows[0]!.deliveries[0]).toMatchObject({ holdReason: reason, holdSince: since })
      now += 5000
    }
  })

  it.each(['delivered', 'answered', 'cancelled'] as const)('clears a delivery hold when it becomes %s', async status => {
    const { tab } = await fixture()
    const worker = (await run(tab, { type: 'agent.add', conversationId: 'lead', machineId: 'test-host', harnessId: randomUUID(), name: 'Worker',
      configuration: config, lead: false })).result.agentId as string
    await run(tab, { ...message('Finish this held instruction.'), recipientIds: [worker] } as Command)
    const delivery = (await store.deliveries(host, tab, worker))[0]!
    await store.delivery(host, tab, worker, delivery.id, { type: 'claim', claimId: 'claim' })
    await store.delivery(host, tab, worker, delivery.id, { type: 'hold', claimId: 'claim', reason: 'team_waiting_idle' })
    if (status === 'delivered') await store.delivery(host, tab, worker, delivery.id, { type: 'ack', claimId: 'claim', receipt: 'typed', uncertain: false })
    else if (status === 'answered') await run(tab, { type: 'message.send', conversationId: 'lead', text: 'Finished.', replyTo: delivery.messageId, recipientIds: [] }, host, worker)
    else await run(tab, { type: 'agent.remove', agentId: worker })
    const saved = await db.superTabDelivery.findUnique({ where: { id: delivery.id } })
    expect(saved).toMatchObject({ status, holdReason: null, holdSince: null })
    const row = (await store.messages(owner, tab, 'lead', { messageId: delivery.messageId })).messages[0]!
    expect(row.deliveries[0]).toMatchObject({ status, holdReason: null, holdSince: null })
  })

  it('keeps delivery and answer times stable, including an answer after the terminal acknowledged delivery', async () => {
    const { tab, lead } = await fixture()
    let now = Date.now()
    const timed = new SuperTabStore(db, () => now)
    await run(tab, message('Record this reply duration.'))
    const delivery = (await store.deliveries(host, tab, lead))[0]!
    await timed.delivery(host, tab, lead, delivery.id, { type: 'claim', claimId: 'claim' })
    await timed.delivery(host, tab, lead, delivery.id, { type: 'ack', claimId: 'claim', receipt: 'typed', uncertain: false })
    const deliveredAt = new Date(now)
    now += 72000
    await timed.delivery(host, tab, lead, delivery.id, { type: 'ack', claimId: 'claim', receipt: 'typed', uncertain: false })
    await timed.execute(host, tab, { operationId: randomUUID(), command: {
      type: 'message.send', conversationId: 'lead', text: 'Done.', replyTo: delivery.messageId, recipientIds: [],
    } }, lead)
    const row = (await timed.messages(owner, tab, 'lead', { messageId: delivery.messageId })).messages[0]!
    expect(row.deliveries[0]).toMatchObject({ status: 'answered', deliveredAt, answeredAt: new Date(now) })
  })

  it('a withdrawn host can retire its receipt without regaining conversation access', async () => {
    const { tab, lead } = await fixture()
    await run(tab, message('Keep the execution receipt after removal.'))
    const first = (await store.deliveries(host, tab, lead))[0]!
    await store.delivery(host, tab, lead, first.id, { type: 'claim', claimId: 'claim' })
    await store.delivery(host, tab, lead, first.id, { type: 'ack', claimId: 'claim', receipt: 'unclear', uncertain: true })
    await run(tab, { type: 'project.delete', projectId: 'lead' })
    expect(await store.deliveryReceipt(host, tab, lead, first.id)).toEqual({ id: first.id, status: 'cancelled' })
    // A server that has not just polled for this host (the quiet poll answers an unchanged caller for 30 s) refuses at once.
    await expect(new SuperTabStore(db).deliveries(host, tab, lead)).rejects.toMatchObject({ code: 'AGENT_UNAVAILABLE' })
    await expect(store.deliveryReceipt(peer, tab, lead, first.id)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    // Reassigning the machine does not transfer the former owner's receipts.
    await db.machine.update({ where: { machineId: 'test-host' }, data: { userId: peer.sub } })
    try {
      await expect(store.deliveryReceipt(peer, tab, lead, first.id)).rejects.toMatchObject({ code: 'FORBIDDEN' })
      await expect(store.deliveryReceipt(host, tab, lead, first.id)).rejects.toMatchObject({ code: 'HOST_UNAVAILABLE' })
    } finally {
      await db.machine.update({ where: { machineId: 'test-host' }, data: { userId: host.sub } })
    }
  })

  it('resolves uncertain input once, preserves native evidence, and fences late host acknowledgements', async () => {
    const { tab, lead } = await fixture()
    await invite(tab)
    await run(tab, message('Check the exact revision.'))
    const first = (await store.deliveries(host, tab, lead))[0]!
    const claimId = randomUUID()
    await store.delivery(host, tab, lead, first.id, { type: 'claim', claimId })
    await store.delivery(host, tab, lead, first.id, { type: 'ack', claimId, receipt: 'lost-native-ack', uncertain: true })
    const resend: Command = { type: 'delivery.resolve', deliveryId: first.id, resolution: 'resend' }
    await expect(run(tab, resend, host, lead)).rejects.toMatchObject({ code: 'HUMAN_REQUIRED' })
    const operationId = randomUUID()
    const repeated = await Promise.all(Array.from({ length: 3 }, () => run(tab, resend, peer, undefined, operationId)))
    expect(new Set(repeated.map(r => r.result.messageId)).size).toBe(1)
    const pending = await store.deliveries(host, tab, lead)
    expect(pending).toHaveLength(1)
    expect(pending[0]!.id).not.toBe(first.id)
    expect(await store.deliveryReceipt(host, tab, lead, first.id)).toEqual({ id: first.id, status: 'superseded' })
    expect((await db.superTabDelivery.findUnique({ where: { id: first.id } }))!.receipt).toBe('lost-native-ack')
    await expect(run(tab, resend, peer)).rejects.toMatchObject({ code: 'DELIVERY_RESOLVED' })
    await expect(store.delivery(host, tab, lead, first.id, { type: 'ack', claimId, receipt: 'late', uncertain: false }))
      .rejects.toMatchObject({ code: 'DELIVERY_RESOLVED' })
    const rows = (await store.messages(owner, tab, 'lead', {})).messages
    expect(rows).toHaveLength(2)
    expect(rows[1]!.text).toBe(rows[0]!.text)
    expect(rows[1]!.replyTo).toBe(rows[0]!.id)
    expect(rows[1]!.author).toMatchObject({ id: peer.sub, kind: 'person' })
    const second = pending[0]!
    await store.delivery(host, tab, lead, second.id, { type: 'claim', claimId: 'second-claim' })
    await store.delivery(host, tab, lead, second.id, { type: 'ack', claimId: 'second-claim', receipt: 'unclear', uncertain: true })
    await run(tab, { type: 'delivery.resolve', deliveryId: second.id, resolution: 'received' })
    expect(await store.deliveries(host, tab, lead)).toEqual([])
    expect(await store.deliveryReceipt(host, tab, lead, second.id)).toEqual({ id: second.id, status: 'confirmed' })
    await expect(store.deliveryReceipt(peer, tab, lead, second.id)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect((await store.messages(owner, tab, 'lead', {})).messages.at(-1)!.text).toContain('confirmed')
  })

  it('a viewer cannot resolve input and a changed machine grant cannot be used to resend it', async () => {
    const { tab, lead } = await fixture()
    await invite(tab, 'viewer')
    await run(tab, message('Do not replay after revocation.'))
    const delivery = (await store.deliveries(host, tab, lead))[0]!
    await store.delivery(host, tab, lead, delivery.id, { type: 'claim', claimId: 'claim' })
    await store.delivery(host, tab, lead, delivery.id, { type: 'ack', claimId: 'claim', receipt: 'unclear', uncertain: true })
    const command: Command = { type: 'delivery.resolve', deliveryId: delivery.id, resolution: 'resend' }
    await expect(run(tab, command, peer)).rejects.toMatchObject({ code: 'READ_ONLY' })
    const share = await db.machineShare.findUniqueOrThrow({ where: { machineId: 'test-host' } })
    await db.machineShare.update({ where: { machineId: 'test-host' }, data: { emails: [] } })
    try {
      await expect(run(tab, command)).rejects.toMatchObject({ code: 'CONTRIBUTION_REVOKED' })
      await run(tab, { ...command, resolution: 'cancel' })
      expect((await db.superTabDelivery.findUnique({ where: { id: delivery.id } }))!.status).toBe('cancelled')
    } finally {
      await db.machineShare.update({ where: { machineId: 'test-host' }, data: { emails: share.emails } })
    }
  })

  it('commits exactly one tab and message under concurrent retries and rejects reused operation IDs', async () => {
    const operationId = randomUUID()
    const created = await Promise.all(Array.from({ length: 5 }, () => store.create(owner, operationId, 'Concurrent')))
    expect(new Set(created.map(c => c.id)).size).toBe(1)
    await expect(store.create(owner, operationId, 'Different')).rejects.toMatchObject({ code: 'OPERATION_REUSED' })
    const { tab, lead } = await fixture()
    const sendId = randomUUID()
    const sends = await Promise.all(Array.from({ length: 5 }, () => run(tab, message('Exactly once.'), owner, undefined, sendId)))
    expect(new Set(sends.map(s => s.result.messageId)).size).toBe(1)
    expect(await db.superTabMessage.count({ where: { tabId: tab } })).toBe(1)
    expect(await store.deliveries(host, tab, lead)).toHaveLength(1)
    await expect(run(tab, message('Different'), owner, undefined, sendId)).rejects.toMatchObject({ code: 'OPERATION_REUSED' })
  })

  it('joins without machine access, permits viewers to leave, and denies stale access after removal', async () => {
    const { tab } = await fixture()
    await expect(store.read(peer, tab)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await invite(tab, 'viewer')
    expect((await store.read(peer, tab)).state.people).toHaveLength(2)
    await expect(run(tab, message('Run this.'), peer)).rejects.toMatchObject({ code: 'READ_ONLY' })
    const operationId = randomUUID()
    const leave: Command = { type: 'member.remove', userId: peer.sub }
    await run(tab, leave, peer, undefined, operationId)
    await run(tab, leave, peer, undefined, operationId)
    await expect(store.read(peer, tab)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(store.read({ ...owner, autonomousEnv: 'stag' }, tab)).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('lets the Lead record a rule only by quoting a message the owner wrote in this tab', async () => {
    const { tab, lead } = await fixture()
    await invite(tab)
    const said = (await run(tab, message('Never use Haiku.'))).result.messageId as string
    const other = (await run(tab, message('Use Haiku.'), peer)).result.messageId as string
    const rule = (messageId: string): Command => ({ type: 'rule.set', rule: { kind: 'forbidModel', model: 'haiku' }, text: 'Never use Haiku.',
      askedIn: { conversationId: 'lead', messageId } })
    await expect(run(tab, rule(other), host, lead)).rejects.toMatchObject({ code: 'OWNER_MESSAGE_REQUIRED' })
    await expect(run(tab, rule('missing'), host, lead)).rejects.toMatchObject({ code: 'OWNER_MESSAGE_REQUIRED' })
    await run(tab, rule(said), host, lead)
    const state = (await store.read(owner, tab)).state
    expect(state.rules).toEqual([expect.objectContaining({ text: 'Never use Haiku.', askedBy: owner.sub, askedIn: { conversationId: 'lead', messageId: said } })])
    // One message may ask for several rules, but the owner's "Rule added" row is not the owner asking.
    await run(tab, { ...rule(said), rule: { kind: 'minEffort', effort: 'high' } } as Command, host, lead)
    expect((await store.read(owner, tab)).state.rules).toHaveLength(2)
    const ownRow = await run(tab, { type: 'rule.set', rule: { kind: 'preferIdle' }, text: 'Reuse idle agents.' })
    await expect(run(tab, rule(ownRow.result.messageId as string), host, lead)).rejects.toMatchObject({ code: 'OWNER_MESSAGE_REQUIRED' })
  })
  it('lets a project\'s Lead record and remove a rule from the owner\'s message in that project\'s chat', async () => {
    // Backend v1.3.14 refused it: a Swarm of projects has no 'lead' chat.
    const tab = (await store.create(owner, randomUUID(), 'Projects')).id
    const { projectId, conversationId: chat } = (await run(tab, { type: 'project.create', name: 'App', visibility: 'public', brief: '' })).result as { projectId: string; conversationId: string }
    await run(tab, { type: 'project.delete', projectId: 'lead' })
    const lead = (await run(tab, { type: 'agent.add', conversationId: chat, machineId: 'test-host', harnessId: randomUUID(),
      name: 'Lead', configuration: config, lead: true })).result.agentId as string
    const said = (await run(tab, { ...message('Only use this Mac.'), conversationId: chat } as Command)).result.messageId as string
    const askedIn = { conversationId: chat, messageId: said }
    const ruleId = (await run(tab, { type: 'rule.set', rule: { kind: 'machines', machineIds: ['test-host'] }, text: 'Only this Mac.', askedIn }, host, lead)).result.ruleId as string
    expect((await store.read(owner, tab)).state.rules).toEqual([expect.objectContaining({ text: 'Only this Mac.', askedIn, addedBy: `agent:${lead}` })])
    await run(tab, { type: 'rule.remove', ruleId, askedIn }, host, lead)
    expect((await store.read(owner, tab)).state).not.toHaveProperty('rules')
    const rows = (await store.messages(owner, tab, chat, {})).messages.filter(m => m.source).map(m => m.text)
    expect(rows).toEqual(['Rule added: Only this Mac.', 'Rule removed: Only this Mac.'])
    expect((await store.read(owner, tab)).state.projects!.map(p => p.id)).toEqual([projectId])
  })
  it('keeps a new Swarm\'s folder from tab.project on its first project, so the repository can be shared and the host uses it', async () => {
    // Review of #1598: a new Swarm stores its first project, which tab.project left without the folder.
    const tab = (await store.create(owner, randomUUID(), 'Folder')).id
    await run(tab, { type: 'tab.project', machineId: 'test-host', project: { cwd: '/work/app', repositoryUrl: null } })
    const url = 'https://github.com/example/app'
    await run(tab, { type: 'project.repository', projectId: 'lead', repositoryUrl: url })
    const repository = { machineId: 'test-host', cwd: '/work/app', repositoryUrl: url }
    expect((await store.read(owner, tab)).state.projects!.map(p => p.repository)).toEqual([repository])
    const invitation = await run(tab, { type: 'invite.create', email: host.email, role: 'collaborator', conversationId: 'lead' })
    await run(tab, { type: 'invite.accept', inviteId: invitation.result.inviteId as string }, host)
    await run(tab, { type: 'machine.contribute', machineId: 'test-host', name: 'Host', cwd: '/swarm-root', scope: 'swarm', engines: ['codex'], maxAgents: 2 }, host)
    const pool = (await poolRows(store, host, 'test-host')).find(p => p.tabId === tab)!
    const team = await teamMachine('test-host')
    await store.observeMachine(team.session, tab, 'test-host', { generation: pool.machine.generation,
      resources: { cpuPercent: 10, memoryTotalBytes: 32e9, memoryUsedBytes: 4e9, projectDiskFreeBytes: 100e9,
        diskFreeBytes: 100e9, diskTotalBytes: 500e9, deviceType: 'Laptop', chip: 'Fixture CPU', os: 'macOS', gpuPercent: null },
      quotas: [], tools: { git: true }, runningHarnessIds: [], stoppedHarnessIds: [], privacy: team.privacy })
    const request = { conversationId: 'lead', machineId: 'test-host', engine: 'codex', name: 'Builder', cwd: '/work/app', worktree: true,
      requirements: { memoryBytes: 0, diskBytes: 0, maxCpuPercent: 100, tools: [], devices: [], quotaRequired: false } }
    await run(tab, { type: 'agent.start', request })
    expect((await poolRows(store, team.session, 'test-host')).find(p => p.tabId === tab)!.projects).toEqual([expect.objectContaining({ id: 'lead', repository })])
  })
  it('lets a project\'s Lead change its skills only by quoting a message the project owner wrote there, and tells the host', async () => {
    const tab = (await store.create(owner, randomUUID(), 'Skills')).id
    await invite(tab)
    const { projectId, conversationId: chat } = (await run(tab, { type: 'project.create', name: 'App', visibility: 'public', brief: '' }, peer)).result as { projectId: string; conversationId: string }
    const lead = (await run(tab, { type: 'agent.add', conversationId: chat, machineId: 'test-host', harnessId: randomUUID(),
      name: 'Lead', configuration: config, lead: true }, peer)).result.agentId as string
    const legacyLead = (await run(tab, { type: 'agent.add', conversationId: 'lead', machineId: 'test-host', harnessId: randomUUID(),
      name: 'Old', configuration: config, lead: true })).result.agentId as string
    const modes = async () => Object.fromEntries((await rosterRows(store, host, 'test-host')).filter(r => r.tabId === tab).map(r => [r.agent?.id, r.skillMode]))
    expect(await modes()).toEqual({ [lead]: 'default', [legacyLead]: 'default' })
    const say = async (text: string, user = peer) => (await run(tab, { ...message(text), conversationId: chat } as Command, user)).result.messageId as string
    const skills = (messageId: string): Command => ({ type: 'project.skills', projectId, mode: 'orchestration', askedIn: { conversationId: chat, messageId } })
    await expect(run(tab, skills(await say('Use Harness orchestration.', owner)), host, lead)).rejects.toMatchObject({ code: 'OWNER_MESSAGE_REQUIRED' })
    await expect(run(tab, skills('missing'), host, lead)).rejects.toMatchObject({ code: 'OWNER_MESSAGE_REQUIRED' })
    await run(tab, skills(await say('Use Harness orchestration.')), host, lead)
    expect(await modes()).toEqual({ [lead]: 'orchestration', [legacyLead]: 'default' })
    const row = (await store.messages(owner, tab, chat, {})).messages.find(m => m.text === 'Skills: Harness orchestration')!
    expect(row.source).toEqual({ kind: 'system' })
    await expect(run(tab, { ...skills(row.id), mode: 'default' } as Command, host, lead)).rejects.toMatchObject({ code: 'OWNER_MESSAGE_REQUIRED' })
    await run(tab, { type: 'project.skills', projectId, mode: 'default' }, peer)
    expect(await modes()).toEqual({ [lead]: 'default', [legacyLead]: 'default' })
    // A project stored before skill modes keeps Harness orchestration.
    const state = await storedState(tab)
    delete state.projects!.find(p => p.id === 'lead')!.skillMode
    await saveState(tab, state)
    expect(await modes()).toEqual({ [lead]: 'default', [legacyLead]: 'orchestration' })
  })
  it('keeps custom role texts out of the tab and the host rows, and serves a text only to the project owner, its Lead and its agents\' hosts', async () => {
    const { tab, lead } = await fixture()
    await invite(tab)
    const worker = (await run(tab, { type: 'agent.add', conversationId: 'lead', machineId: 'test-host', harnessId: randomUUID(),
      name: 'Worker', configuration: config, lead: false })).result.agentId as string
    const version = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 16)
    const roles = [{ id: 'lead', name: 'Product Manager', kind: 'lead' as const, text: 'LEAD-TEXT' },
      { id: 'dev', name: 'Engineer', kind: 'builder' as const, text: 'DEV-TEXT' }, { id: 'review', name: 'Reviewer', kind: 'reviewer' as const, text: 'REVIEW-TEXT' }]
    await run(tab, { type: 'project.roles.create', projectId: 'lead', roles })
    const rows = async () => (await rosterRows(store, host, 'test-host')).filter(r => r.tabId === tab)
    const rowOf = async (id: string) => (await rows()).find(r => r.agent.id === id)!
    expect(await rowOf(worker)).not.toHaveProperty('role')
    await run(tab, { type: 'project.skills', projectId: 'lead', mode: 'custom' })
    expect(await rowOf(lead)).toMatchObject({ skillMode: 'default', role: { id: 'lead', name: 'Product Manager', kind: 'lead', version: version('LEAD-TEXT'), projectId: 'lead' } })
    expect(await rowOf(worker)).toMatchObject({ skillMode: 'default', role: { id: 'dev', name: 'Engineer', kind: 'builder', version: version('DEV-TEXT'), projectId: 'lead' } })
    const stored = JSON.stringify(await storedState(tab))
    for (const text of [JSON.stringify(await rows()), stored, JSON.stringify((await store.read(owner, tab)).state)]) expect(text).not.toMatch(/LEAD-TEXT|DEV-TEXT/)

    const text = (user: AuthUser, roleId: string, asAgentId?: string) => app.inject({ method: 'GET',
      url: `/api/super-tabs/${tab}/projects/lead/roles/${roleId}${asAgentId ? `?asAgentId=${asAgentId}` : ''}`, headers: { authorization: `Bearer ${user.sub}` } })
    for (const [user, as] of [[owner], [host], [host, lead]] as Array<[AuthUser, string?]>) {
      const answer = await text(user, 'dev', as)
      expect(answer.statusCode, answer.body).toBe(200)
      expect(answer.json().data).toEqual({ version: version('DEV-TEXT'), text: 'DEV-TEXT' })
    }
    for (const [user, as] of [[peer], [host, worker]] as Array<[AuthUser, string?]>) expect((await text(user, 'dev', as)).statusCode).toBe(404)
    expect((await text(owner, 'aaaaaaaaaaaa')).statusCode).toBe(404)
    // A host reads a text only while it could host the agent now: its machine active and the contributor's share grant live.
    const share = await db.machineShare.findUniqueOrThrow({ where: { machineId: 'test-host' } })
    await db.machineShare.update({ where: { machineId: 'test-host' }, data: { emails: [] } })
    try { expect((await text(host, 'dev')).statusCode).toBe(404) } finally {
      await db.machineShare.update({ where: { machineId: 'test-host' }, data: { emails: share.emails } })
    }
    await db.machine.update({ where: { machineId: 'test-host' }, data: { deletedAt: new Date() } })
    try { expect((await text(host, 'dev')).statusCode).toBe(404) } finally {
      await db.machine.update({ where: { machineId: 'test-host' }, data: { deletedAt: null } })
    }
    expect((await text(host, 'dev')).statusCode).toBe(200)

    await run(tab, { type: 'project.role.set', projectId: 'lead', role: { ...roles[1]!, text: 'DEV-TEXT v2' } })
    expect((await rowOf(worker)).role).toMatchObject({ id: 'dev', version: version('DEV-TEXT v2'), projectId: 'lead' })
    expect((await text(owner, 'dev')).json().data).toEqual({ version: version('DEV-TEXT v2'), text: 'DEV-TEXT v2' })
    await run(tab, { type: 'project.role.remove', projectId: 'lead', roleId: 'review' })
    expect((await text(owner, 'review')).statusCode).toBe(404)
    expect(await db.superTabRoleText.count({ where: { tabId: tab } })).toBe(2)
    await run(tab, { type: 'project.roles.reset', projectId: 'lead', roles: roles.slice(0, 2) })
    expect((await text(owner, 'dev')).json().data.text).toBe('DEV-TEXT')

    const other = (await run(tab, { type: 'project.create', name: 'Other', visibility: 'public', brief: '' })).result.projectId as string
    await run(tab, { type: 'project.roles.create', projectId: other, roles })
    await run(tab, { type: 'project.delete', projectId: other })
    expect(await db.superTabRoleText.count({ where: { tabId: tab, projectId: other } })).toBe(0)
  })
  it('serves no role text once the reader, or the hosted agent\'s contributor, left the Swarm\'s Workspace, before that removal reaches the Swarm', async () => {
    const { tab } = await fixture()
    await invite(tab)
    await run(tab, { type: 'agent.add', conversationId: 'lead', machineId: 'test-host', harnessId: randomUUID(), name: 'Worker', configuration: config, lead: false })
    await run(tab, { type: 'project.roles.create', projectId: 'lead', roles: [{ id: 'lead', name: 'Product Manager', kind: 'lead' as const, text: 'LEAD-TEXT' },
      { id: 'dev', name: 'Engineer', kind: 'builder' as const, text: 'DEV-TEXT' }] })
    await run(tab, { type: 'project.skills', projectId: 'lead', mode: 'custom' })
    const text = (user: AuthUser) => app.inject({ method: 'GET', url: `/api/super-tabs/${tab}/projects/lead/roles/dev`, headers: { authorization: `Bearer ${user.sub}` } })
    expect((await text(owner)).statusCode).toBe(200)
    expect((await text(host)).statusCode).toBe(200)
    // The owner, who is the project's owner and the Worker's contributor, is marked removed as a removal leaves it before its cleanup.
    const row = await db.superTab.findUniqueOrThrow({ where: { id: tab } })
    await db.swarmWorkspaceMember.update({ where: { id: `${row.workspaceId}:${owner.sub}` }, data: { removedAt: new Date() } })
    try {
      for (const user of [owner, host]) {
        const answer = await text(user)
        expect(answer.statusCode, user.email).not.toBe(200)
        expect(answer.body).not.toContain('DEV-TEXT')
      }
    } finally { await db.swarmWorkspaceMember.update({ where: { id: `${row.workspaceId}:${owner.sub}` }, data: { removedAt: null } }) }
  })
  it('writes a message to several recipients in two insert commands, preserving each delivery', async () => {
    const { tab, lead } = await fixture()
    const recipients = [lead]
    for (const name of ['Parser', 'Renderer', 'Exporter']) recipients.push(String((await run(tab, {
      type: 'agent.add', conversationId: 'lead', machineId: 'test-host', harnessId: randomUUID(), name, configuration: config, lead: false,
    })).result.agentId))
    const queries: string[] = []
    recordQuery = query => { if (/SuperTab(Message|Delivery).*insert/i.test(query)) queries.push(query) }
    let sent: Awaited<ReturnType<typeof run>>
    try {
      sent = await run(tab, { ...message('Batch to all four.'), recipientIds: recipients } as Command)
    } finally { recordQuery = () => {} }
    const messageId = String(sent.result.messageId)
    const stored = await db.superTabMessage.findUniqueOrThrow({ where: { id: messageId } })
    expect(stored).toMatchObject({ tabId: tab, conversationId: 'lead', text: 'Batch to all four.', recipientIds: recipients,
      author: { kind: 'person', id: owner.sub }, replyTo: null, mentions: [] })
    const deliveries = await db.superTabDelivery.findMany({ where: { tabId: tab, messageId } })
    expect(deliveries).toHaveLength(4)
    for (const recipient of recipients) expect(deliveries.find(row => row.agentId === recipient)).toMatchObject({
      id: stableId(messageId, recipient), tabId: tab, conversationId: 'lead', messageId, machineId: 'test-host',
      machineOwnerId: host.sub, membershipGeneration: tab, authorKind: 'person', authorId: owner.sub,
      authorGeneration: tab, assignmentId: null, status: 'queued',
    })
    expect(queries).toHaveLength(2)
  })

  it('closes the replying agent\'s own deliveries of a message as answered, and nobody else\'s', async () => {
    const { tab, lead } = await fixture()
    const helper = (await run(tab, { type: 'agent.add', conversationId: 'lead', machineId: 'test-host', harnessId: randomUUID(),
      name: 'Helper', configuration: config, lead: false })).result.agentId as string
    await invite(tab)
    const asked = await run(tab, { type: 'message.send', conversationId: 'lead', text: 'What is the status?', replyTo: null,
      recipientIds: [lead, helper] }, peer)
    const messageId = asked.result.messageId as string
    const held = (await store.deliveries(host, tab, lead))[0]!
    const claimId = randomUUID()
    // A claimed delivery closes too, not only a queued one.
    await store.delivery(host, tab, lead, held.id, { type: 'claim', claimId })
    const other = (await store.deliveries(host, tab, helper))[0]!
    // A person's reply closes nothing.
    await run(tab, { type: 'message.send', conversationId: 'lead', text: 'Also, soon please.', replyTo: messageId, recipientIds: [] })
    expect(await store.deliveryReceipt(host, tab, lead, held.id)).toEqual({ id: held.id, status: 'claimed' })
    await run(tab, { type: 'message.send', conversationId: 'lead', text: 'It is done.', replyTo: messageId, recipientIds: [] }, host, lead)
    expect(await store.deliveryReceipt(host, tab, lead, held.id)).toEqual({ id: held.id, status: 'answered' })
    expect((await store.deliveries(host, tab, lead)).map(d => d.messageId)).not.toContain(messageId)
    expect(await store.deliveryReceipt(host, tab, helper, other.id)).toEqual({ id: other.id, status: 'queued' })
    await expect(store.delivery(host, tab, lead, held.id, { type: 'claim', claimId })).rejects.toMatchObject({ code: 'DELIVERY_RESOLVED' })
    await expect(store.delivery(host, tab, lead, held.id, { type: 'ack', claimId, receipt: 'late', uncertain: false }))
      .rejects.toMatchObject({ code: 'DELIVERY_RESOLVED' })
    const next = await run(tab, { type: 'message.send', conversationId: 'lead', text: 'And the tests?', replyTo: null, recipientIds: [lead] }, peer)
    const queued = (await store.deliveries(host, tab, lead)).find(d => d.messageId === next.result.messageId)!
    await run(tab, { type: 'message.send', conversationId: 'lead', text: 'They pass.', replyTo: next.result.messageId as string, recipientIds: [] }, host, lead)
    expect(await store.deliveryReceipt(host, tab, lead, queued.id)).toEqual({ id: queued.id, status: 'answered' })
  })

  it('durably resumes a claim, never steals it on timeout, and does not resurrect revoked messages on rejoin', async () => {
    const { tab, lead } = await fixture()
    await invite(tab)
    await run(tab, message('Instruction from a collaborator.'), peer)
    const delivery = (await store.deliveries(host, tab, lead))[0]!
    const claimId = randomUUID()
    const first = await store.delivery(host, tab, lead, delivery.id, { type: 'claim', claimId })
    expect(first.delivery.status).toBe('claimed')
    // Simulate a backend restart: no in-memory object carries delivery ownership.
    const restarted = new SuperTabStore(db)
    expect((await restarted.delivery(host, tab, lead, delivery.id, { type: 'claim', claimId })).message!.text).toContain('collaborator')
    await expect(restarted.delivery(host, tab, lead, delivery.id, { type: 'claim', claimId: randomUUID() })).rejects.toMatchObject({ code: 'CLAIM_CONFLICT' })
    await run(tab, { type: 'member.remove', userId: peer.sub })
    await invite(tab)
    expect(await store.deliveries(host, tab, lead)).toHaveLength(0)
    await expect(store.delivery(host, tab, lead, delivery.id, { type: 'ack', claimId, receipt: 'receipt', uncertain: false })).rejects.toMatchObject({ code: 'DELIVERY_REVOKED' })
    expect((await store.messages(owner, tab, 'lead', {})).messages).toHaveLength(1)
  })

  it('allows one claim winner and preserves the original native receipt', async () => {
    const { tab, lead } = await fixture()
    await run(tab, message('One native turn.'))
    const delivery = (await store.deliveries(host, tab, lead))[0]!
    const claims = await Promise.allSettled([randomUUID(), randomUUID()].map(claimId => store.delivery(host, tab, lead, delivery.id, { type: 'claim', claimId })))
    expect(claims.filter(r => r.status === 'fulfilled')).toHaveLength(1)
    const won = claims.find(r => r.status === 'fulfilled')!
    if (won.status !== 'fulfilled') throw new Error('No claim winner')
    const claimId = won.value.delivery.claimId!
    await store.delivery(host, tab, lead, delivery.id, { type: 'ack', claimId, receipt: 'native-turn-1', uncertain: false })
    await store.delivery(host, tab, lead, delivery.id, { type: 'ack', claimId, receipt: 'native-turn-1', uncertain: false })
    await expect(store.delivery(host, tab, lead, delivery.id, { type: 'ack', claimId, receipt: 'different', uncertain: false })).rejects.toMatchObject({ code: 'RECEIPT_CONFLICT' })
    expect(await store.deliveries(host, tab, lead)).toHaveLength(0)
  })

  it('serializes revocation against claims and exposes no pending instruction after removal', async () => {
    const { tab, lead } = await fixture()
    await invite(tab)
    await run(tab, message('Racing with removal.'), peer)
    const delivery = (await store.deliveries(host, tab, lead))[0]!
    const results = await Promise.allSettled([
      store.delivery(host, tab, lead, delivery.id, { type: 'claim', claimId: randomUUID() }),
      run(tab, { type: 'member.remove', userId: peer.sub }),
    ])
    expect(results[1]!.status).toBe('fulfilled')
    expect(await store.deliveries(host, tab, lead)).toHaveLength(0)
    expect((await db.superTabDelivery.findUnique({ where: { id: delivery.id } }))!.status).toBe('cancelled')
  })

  it('holds a cross-tab assignment until host-confirmed stop and retains the previous attempt', async () => {
    const one = await fixture()
    const two = await fixture()
    const session = randomUUID()
    const attach: Command = { type: 'agent.add', conversationId: 'lead', machineId: 'test-host', harnessId: session,
      name: 'Worker', configuration: config, lead: false }
    const worker = (await run(one.tab, attach)).result.agentId as string
    await run(two.tab, attach)
    const define: Command = { type: 'work.define', conversationId: 'lead', brief: 'Check the fixture.', checks: [{ description: 'Test passes.', independent: true }] }
    await run(one.tab, define); await run(two.tab, define)
    const assignmentId = (await run(one.tab, { type: 'work.assign', conversationId: 'lead', agentId: worker })).result.assignmentId as string
    await expect(run(two.tab, { type: 'work.assign', conversationId: 'lead', agentId: worker })).rejects.toMatchObject({ code: 'AGENT_BUSY' })
    await run(one.tab, { type: 'agent.remove', agentId: worker })
    expect(await assignmentRows(store, host, 'test-host')).toContainEqual({ tabId: one.tab, assignmentId, harnessId: session })
    await expect(assignmentRows(store, owner, 'test-host')).rejects.toMatchObject({ code: 'HOST_UNAVAILABLE' })
    await expect(store.stopped(owner, one.tab, assignmentId, 'forged')).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await store.stopped(host, one.tab, assignmentId, 'native-stop-receipt')
    expect((await store.read(owner, one.tab)).state.conversations[0]!.assignment?.status).toBe('stopped')
    await store.stopped(host, one.tab, assignmentId, 'native-stop-receipt')
    expect(await assignmentRows(store, host, 'test-host')).not.toContainEqual({ tabId: one.tab, assignmentId, harnessId: session })
    expect(await db.superTabDelivery.count({ where: { tabId: one.tab, assignmentId, status: 'queued' } })).toBe(0)
    await run(two.tab, { type: 'work.assign', conversationId: 'lead', agentId: worker })
    await run(one.tab, define)
    expect((await db.superTabAttempt.findUnique({ where: { id: assignmentId } }))!.snapshot).toMatchObject({ assignment: { status: 'stopped', configuration: config } })
  })

  it('lists the attempts of one group, newest first, after a stop and a new definition', async () => {
    const { tab, lead } = await fixture()
    const worker = (await run(tab, { type: 'agent.add', conversationId: 'lead', machineId: 'test-host', harnessId: randomUUID(),
      name: 'Builder', configuration: config, lead: false })).result.agentId as string
    const define = (brief: string): Command => ({ type: 'work.define', conversationId: 'lead', brief, checks: [{ description: 'Test passes.', independent: false }] })
    const attempt = async (brief: string) => {
      await run(tab, define(brief))
      const id = (await run(tab, { type: 'work.assign', conversationId: 'lead', agentId: worker })).result.assignmentId as string
      await store.stopped(host, tab, id, 'native-stop-receipt')
      return id
    }
    const first = await attempt('Build it.')
    const second = await attempt('Build it again.')
    await run(tab, define('Build it a third time.'))
    // A host-confirmed stop sets its own result, so a long one is seeded: the server cuts it.
    const long = randomUUID()
    await db.superTabAttempt.create({ data: { id: long, tabId: tab, conversationId: 'lead', createdAt: new Date(0), snapshot: { assignment: {
      id: long, agentId: worker, status: 'done', result: 'x'.repeat(900), execution: { machineId: 'test-host', harnessId: 'secret-harness', machineOwnerId: host.sub } } } } })
    const url = `/api/super-tabs/${tab}/conversations/lead/attempts`
    const read = (user: AuthUser, query = '') => app.inject({ url: `${url}${query}`, headers: { authorization: `Bearer ${user.sub}` } })
    const listed = (await read(owner)).json().data
    expect(listed.map((a: { id: string }) => a.id)).toEqual([second, first, long])
    expect(listed[1]).toMatchObject({ id: first, agentId: worker, status: 'stopped', createdAt: expect.any(String) })
    expect(listed[2]).toMatchObject({ id: long, status: 'done', result: 'x'.repeat(500) })
    // Only what a reader of the group needs: no host grant, configuration or brief.
    expect(Object.keys(listed[2]).sort()).toEqual(['agentId', 'createdAt', 'id', 'result', 'status'])
    expect((await read(host, `?asAgentId=${lead}`)).json().data).toHaveLength(3)
    await invite(tab, 'viewer')
    expect((await read(peer)).statusCode).toBe(200)
    expect((await app.inject({ url, headers: { authorization: `Bearer ${randomUUID()}` } })).statusCode).toBe(401)
  })

  it('refuses the attempts of a group to a non-member and never crosses tabs', async () => {
    const one = await fixture()
    const two = await fixture()
    const group = (await run(two.tab, { type: 'conversation.create', title: 'Other work', brief: '', checks: [] })).result.conversationId as string
    const read = (tab: string, conversation: string, user: AuthUser, query = '') =>
      app.inject({ url: `/api/super-tabs/${tab}/conversations/${conversation}/attempts${query}`, headers: { authorization: `Bearer ${user.sub}` } })
    expect((await read(one.tab, 'lead', peer)).statusCode).toBe(403)
    expect((await read(one.tab, group, owner)).statusCode).toBe(404)
    expect((await read(two.tab, group, owner)).statusCode).toBe(200)
    expect((await read(one.tab, 'lead', host, `?asAgentId=${two.lead}`)).statusCode).not.toBe(200)
  })

  it('tells the lead once when the host confirms its worker stopped', async () => {
    const { tab, lead } = await fixture()
    const worker = (await run(tab, { type: 'agent.add', conversationId: 'lead', machineId: 'test-host', harnessId: randomUUID(),
      name: 'Builder', configuration: config, lead: false })).result.agentId as string
    const displayName = (await store.read(owner, tab)).state.agents.find(a => a.id === worker)!.displayName!
    await run(tab, { type: 'work.define', conversationId: 'lead', brief: 'Build it.', checks: [{ description: 'Test passes.', independent: false }] })
    const assignmentId = (await run(tab, { type: 'work.assign', conversationId: 'lead', agentId: worker })).result.assignmentId as string
    const before = (await store.deliveries(host, tab, lead)).length
    await store.stopped(host, tab, assignmentId, 'native-stop-receipt')
    await store.stopped(host, tab, assignmentId, 'native-stop-receipt')
    const notices = (await store.messages(owner, tab, 'lead', {})).messages.filter(m => m.text.startsWith('Stopped'))
    expect(notices).toHaveLength(1)
    expect(notices[0]).toMatchObject({ author: { kind: 'agent', id: worker, name: 'Builder', displayName },
      text: 'Stopped\n\nThe execution host confirmed that this harness stopped. If this work should continue, assign a new attempt.' })
    expect(await store.deliveries(host, tab, lead)).toHaveLength(before + 1)
    expect((await store.read(owner, tab)).state.conversations[0]!.lastMessageSequence).toBe(notices[0]!.sequence)
    await run(tab, { type: 'agent.remove', agentId: worker })
    expect((await store.messages(owner, tab, 'lead', {})).messages.find(m => m.id === notices[0]!.id)!.author)
      .toMatchObject({ displayName })
  })

  it('rejects unshared hosts and spoofed agent identities through the HTTP API', async () => {
    const { tab, lead } = await fixture()
    const headers = { authorization: `Bearer ${owner.sub}` }
    expect((await app.inject({ url: `/api/super-tabs/${tab}/parts` })).statusCode).toBe(401)
    expect((await app.inject({ url: `/api/super-tabs/${tab}/parts`, headers })).statusCode).toBe(200)
    expect((await app.inject({ url: `/api/super-tabs/${tab}/parts?asAgentId=${lead}`, headers })).statusCode).toBe(403)
    const malformed = await app.inject({ method: 'POST', url: `/api/super-tabs/${tab}/commands`, headers,
      payload: { operationId: randomUUID(), command: { ...message('No spoofing.'), contributorId: owner.sub } } })
    expect(malformed.statusCode).toBe(400)
    await db.machine.create({ data: { machineId: 'private-host', userId: peer.sub, apiKey: 'private-fixture', managerId: 'fixture', autonomousEnv: 'prod' } })
    await expect(run(tab, { type: 'agent.add', conversationId: 'lead', machineId: 'private-host', harnessId: 'private', name: 'Private', configuration: config, lead: false })).rejects.toMatchObject({ code: 'HOST_REQUIRED' })
    const post = await app.inject({ method: 'POST', url: `/api/super-tabs/${tab}/commands`, headers,
      payload: { operationId: randomUUID(), command: message('A shared conversation.') } })
    expect(post.statusCode).toBe(200)
    const history = await app.inject({ url: `/api/super-tabs/${tab}/conversations/lead/messages`, headers })
    expect(history.json().data.messages[0].text).toBe('A shared conversation.')
  })

  it('rechecks the machine share at delivery even while the contributor remains in the tab', async () => {
    const { tab } = await fixture()
    await invite(tab)
    const agentId = (await run(tab, { type: 'agent.add', conversationId: 'lead', machineId: 'test-host', harnessId: randomUUID(),
      name: 'Peer worker', configuration: config, lead: false }, peer)).result.agentId as string
    await run(tab, { ...message('Only on an authorized machine.'), recipientIds: [agentId] } as Command)
    expect(await store.deliveries(host, tab, agentId)).toHaveLength(1)
    try {
      const before = await db.machineShare.findUniqueOrThrow({ where: { machineId: 'test-host' } })
      await db.machineShare.update({ where: { machineId: 'test-host' }, data: { emails: [owner.email],
        grantVersions: nextMachineShareGrants(before, [owner.email], null) } })
      expect((await store.read(peer, tab)).state.people).toHaveLength(2)
      await expect(store.deliveries(host, tab, agentId)).rejects.toMatchObject({ code: 'CONTRIBUTION_REVOKED' })
    } finally {
      const before = await db.machineShare.findUniqueOrThrow({ where: { machineId: 'test-host' } })
      await db.machineShare.update({ where: { machineId: 'test-host' }, data: { emails: [owner.email, peer.email],
        grantVersions: nextMachineShareGrants(before, [owner.email, peer.email], null) } })
    }
    // The host may have been offline throughout the revocation. A restored share
    // still cannot revive a contribution made under the earlier grant.
    await expect(store.deliveries(host, tab, agentId)).rejects.toMatchObject({ code: 'CONTRIBUTION_REVOKED' })
  })

  it('also withholds outgoing instructions from an agent whose machine grant was revoked', async () => {
    const { tab, lead } = await fixture()
    await invite(tab)
    const worker = (await run(tab, { type: 'agent.add', conversationId: 'lead', machineId: 'test-host', harnessId: randomUUID(),
      name: 'Peer worker', configuration: config, lead: false }, peer)).result.agentId as string
    await store.execute(host, tab, { operationId: randomUUID(), command: { ...message('Delegated before revocation.'), recipientIds: [worker] } as Command }, lead)
    const [delivery] = await store.deliveries(host, tab, worker)
    expect(delivery).toBeTruthy()
    const before = await db.machineShare.findUniqueOrThrow({ where: { machineId: 'test-host' } })
    try {
      await db.machineShare.update({ where: { machineId: 'test-host' }, data: { emails: [peer.email],
        grantVersions: nextMachineShareGrants(before, [peer.email], null) } })
      expect(await store.deliveries(host, tab, worker)).toEqual([])
      await expect(store.delivery(host, tab, worker, delivery!.id, { type: 'claim', claimId: randomUUID() })).rejects.toMatchObject({ code: 'DELIVERY_REVOKED' })
    } finally {
      const current = await db.machineShare.findUniqueOrThrow({ where: { machineId: 'test-host' } })
      await db.machineShare.update({ where: { machineId: 'test-host' }, data: { emails: [owner.email, peer.email],
        grantVersions: nextMachineShareGrants(current, [owner.email, peer.email], null) } })
    }
    expect(await store.deliveries(host, tab, worker)).toEqual([])
  })

  it('derives session-only observer access from accepted membership and removes it with that membership', async () => {
    const { tab } = await fixture()
    // A Builder's terminal: nobody but its machine's owner watches a Lead (Critical 1).
    const native = randomUUID()
    await run(tab, { type: 'agent.add', conversationId: 'lead', machineId: 'test-host', harnessId: native, name: 'Builder', configuration: config, lead: false })
    expect(await store.mayObserve(peer, tab, 'test-host', native, host.sub)).toBe(false)
    await invite(tab, 'viewer')
    expect(await store.mayObserve(peer, tab, 'test-host', native, host.sub)).toBe(true)
    expect(await store.mayObserve(peer, tab, 'test-host', 'another-session', host.sub)).toBe(false)
    const grants = (await rosterRows(store, host, 'test-host')).find(t => t.tabId === tab && t.agent?.harnessId === native)
    expect(grants?.observers).toContainEqual({ email: peer.email, userId: peer.sub })
    await run(tab, { type: 'member.remove', userId: peer.sub })
    expect(await store.mayObserve(peer, tab, 'test-host', native, host.sub)).toBe(false)
    expect((await rosterRows(store, host, 'test-host')).find(t => t.tabId === tab && t.agent?.harnessId === native)?.observers).not.toContainEqual({ email: peer.email, userId: peer.sub })
  })

  it('tells the execution host which of its agents need a decision or are stuck', async () => {
    const { tab } = await fixture()
    const group = (await run(tab, { type: 'conversation.create', title: 'Release', brief: 'Ship it.', checks: [{ description: 'Shipped.', independent: false }] })).result.conversationId as string
    const worker = (await run(tab, { type: 'agent.add', conversationId: group, machineId: 'test-host', harnessId: randomUUID(),
      name: 'Builder', configuration: config, lead: false })).result.agentId as string
    const assignmentId = (await run(tab, { type: 'work.assign', conversationId: group, agentId: worker })).result.assignmentId as string
    const row = async () => (await rosterRows(store, host, 'test-host')).find(t => t.tabId === tab && t.agent.id === worker)!
    expect(await row()).toMatchObject({ tabName: 'Pilot', attention: null })
    await run(tab, { type: 'work.status', conversationId: group, assignmentId, status: 'blocked', result: 'No access to staging.' } as Command, host, worker)
    expect((await row()).attention).toEqual({ assignmentId, status: 'blocked', result: 'No access to staging.' })
    await run(tab, { type: 'work.status', conversationId: group, assignmentId, status: 'needs_human', result: null } as Command, host, worker)
    expect((await row()).attention).toEqual({ assignmentId, status: 'needs_human', result: null })
    await run(tab, { type: 'work.status', conversationId: group, assignmentId, status: 'working', result: null } as Command, host, worker)
    expect((await row()).attention).toBeNull()
  })

  it('marks members of only archived groups inactive for host retention', async () => {
    const { tab, lead } = await fixture()
    const group = (await run(tab, { type: 'conversation.create', title: 'Done work', brief: '', checks: [] })).result.conversationId as string
    const worker = (await run(tab, { type: 'agent.add', conversationId: group, machineId: 'test-host', harnessId: randomUUID(),
      name: 'Builder', configuration: config, lead: false })).result.agentId as string
    const active = async () => Object.fromEntries((await rosterRows(store, host, 'test-host'))
      .filter(t => t.tabId === tab).map(t => [t.agent.id, t.active]))
    expect(await active()).toEqual({ [lead]: true, [worker]: true })
    await run(tab, { type: 'conversation.archive', conversationId: group, archived: true })
    expect(await active()).toEqual({ [lead]: true, [worker]: false })
  })

  it('serializes native start claims and fences a restored target-machine grant', async () => {
    const { tab } = await fixture()
    const request = { conversationId: 'lead', machineId: 'test-host', engine: 'claude', name: 'Builder', cwd: '/fixture/repo', worktree: true,
      requirements: { memoryBytes: 100, diskBytes: 200, maxCpuPercent: 80, tools: ['git'], devices: [], quotaRequired: false } }
    const intent = randomUUID()
    const starts = await Promise.all(Array.from({ length: 3 }, () => run(tab, { type: 'agent.start', request }, owner, undefined, intent)))
    const startId = starts[0]!.result.startId as string
    expect(new Set(starts.map(s => s.result.startId)).size).toBe(1)
    expect((await store.read(owner, tab)).state.starts).toHaveLength(1)
    const claims = await Promise.allSettled(Array.from({ length: 2 }, () => run(tab, { type: 'agent.startDispatch', startId })))
    expect(claims.filter(c => c.status === 'fulfilled')).toHaveLength(1)
    expect((await store.start(owner, tab, startId)).dispatched).toBe(true)
    const original = await db.machineShare.findUniqueOrThrow({ where: { machineId: 'test-host' } })
    try {
      await db.machineShare.update({ where: { machineId: 'test-host' }, data: { emails: [peer.email],
        grantVersions: nextMachineShareGrants(original, [peer.email], null) } })
      await expect(store.start(owner, tab, startId)).rejects.toMatchObject({ code: 'HOST_REQUIRED' })
    } finally {
      const current = await db.machineShare.findUniqueOrThrow({ where: { machineId: 'test-host' } })
      await db.machineShare.update({ where: { machineId: 'test-host' }, data: { emails: [owner.email, peer.email],
        grantVersions: nextMachineShareGrants(current, [owner.email, peer.email], null) } })
    }
    await expect(store.start(owner, tab, startId)).rejects.toMatchObject({ code: 'CONTRIBUTION_REVOKED' })
    await expect(run(tab, { type: 'agent.started', startId, harnessId: 'must-not-join', configuration: config })).rejects.toMatchObject({ code: 'CONTRIBUTION_REVOKED' })
  })

  it('does not authorize a host through a contributor’s obsolete email address', async () => {
    const { tab, lead } = await fixture()
    await run(tab, message('Requires the current machine grant.'))
    try {
      await db.user.update({ where: { id: owner.sub }, data: { email: 'changed@example.net' } })
      await expect(store.deliveries(host, tab, lead)).rejects.toMatchObject({ code: 'CONTRIBUTION_REVOKED' })
    } finally {
      await db.user.update({ where: { id: owner.sub }, data: { email: owner.email } })
    }
  })

  it('judges a review verdict\'s step up by the tab\'s own ratings', async () => {
    const { tab } = await fixture()
    const group = (await run(tab, { type: 'conversation.create', title: 'Docs', brief: 'Fix the docs.', checks: [{ description: 'Reviewed', independent: true }] })).result.conversationId as string
    const sonnet = (await run(tab, { type: 'agent.add', conversationId: group, machineId: 'test-host', harnessId: randomUUID(), name: 'Sonnet',
      configuration: { ...config, engine: 'claude', model: 'claude-sonnet-4-5' }, lead: false })).result.agentId as string
    const assignmentId = (await run(tab, { type: 'work.assign', conversationId: group, agentId: sonnet })).result.assignmentId as string
    // The task stepped up to Sonnet before; this tab's owner rates Sonnet at the top tier, so its failed review steps nothing up.
    const part = await db.swarmGroup.findFirstOrThrow({ where: { tabId: tab, key: group } })
    await db.swarmGroup.update({ where: { id: part.id }, data: { version: part.version + 1,
      data: { ...part.data as object, stepUp: { attempt: 2, floor: 2, reason: 'Its first review said Ready no.', at: 1, carry: '' } } } })
    await run(tab, { type: 'tab.routingPolicy', policy: { models: DEFAULT_ROUTING_POLICY.models.map(m => m.model === 'sonnet' ? { ...m, quality: 3 } : m) } })
    const checkId = (await store.read(owner, tab)).state.conversations.find(c => c.id === group)!.checks[0]!.id
    await run(tab, { type: 'work.check', conversationId: group, assignmentId, checkId, passed: false, evidence: 'Ready: no.' })
    const after = (await store.read(owner, tab)).state.conversations.find(c => c.id === group)!
    expect(after.assignment).toMatchObject({ id: assignmentId, status: 'working' })
  })

  it('stores the account routing policy with revisions and merges the owner policy into each tab', async () => {
    const initial = await store.accountPolicy(owner)
    expect(initial).toEqual({ policy: DEFAULT_ROUTING_POLICY, revision: 0, isDefault: true })
    const saved = await store.saveAccountPolicy(owner, 0, { ...DEFAULT_ROUTING_POLICY, quotaReserve: 30 })
    expect(saved.revision).toBe(1)
    await expect(store.saveAccountPolicy(owner, 0, DEFAULT_ROUTING_POLICY)).rejects.toMatchObject({ code: 'REVISION_CHANGED' })
    const { tab, lead } = await fixture()
    await run(tab, { type: 'tab.routingPolicy', policy: { notes: 'Prefer remote-1.' } })
    await invite(tab, 'viewer')
    // A member reads the owner's policy, never their own account's.
    await store.saveAccountPolicy(peer, 0, { ...DEFAULT_ROUTING_POLICY, quotaReserve: 5 })
    for (const [user, asAgent] of [[owner, undefined], [peer, undefined], [host, lead]] as const) {
      const effective = await store.tabPolicy(user, tab, asAgent)
      expect(effective.policy.quotaReserve).toBe(30)
      expect(effective.policy.notes).toBe('Prefer remote-1.')
      expect(effective.overridden).toEqual(['notes'])
      // The owner's account value, so a field reset to the account default can show it.
      expect(effective.account).toEqual({ ...DEFAULT_ROUTING_POLICY, quotaReserve: 30 })
    }
    const response = await app.inject({ url: `/api/super-tabs/${tab}/routing-policy`, headers: { authorization: `Bearer ${peer.sub}` } })
    expect(response.statusCode).toBe(200)
    expect((await app.inject({ url: '/api/super-tabs/routing-policy', headers: { authorization: `Bearer ${owner.sub}` } })).statusCode).toBe(200)
  })

  it('lets exactly one of two concurrent saves win the same revision', async () => {
    const results = await Promise.allSettled([host, host].map((user, i) =>
      store.saveAccountPolicy(user, 0, { ...DEFAULT_ROUTING_POLICY, quotaReserve: 10 + i })))
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1)
    expect((await store.accountPolicy(host)).revision).toBe(1)
  })

  it('records, supersedes and lets a person change a route decision; a closed one refuses', async () => {
    const { tab, lead } = await fixture()
    const decision = { assessment: { difficulty: 'medium', risk: 'low', why: 'A small API change.' },
      candidates: [
        { id: 'c0', kind: 'member', agentId: lead, machineId: 'test-host', engine: 'claude', model: 'sonnet', effort: 'medium', quality: 2, cost: 2, title: 'Lead · Claude sonnet medium · test-host', label: 'Member Lead' },
        { id: 'c1', kind: 'new', machineId: 'test-host', engine: 'claude', model: 'opus', effort: 'high', quality: 3, cost: 3, title: 'New agent · Claude opus high · test-host', label: 'New agent' },
      ], excluded: [{ title: 'New agent · Codex · test-host', reason: 'The selected agent engine is not installed on this machine.' }],
      floor: 2, notes: false, pick: 'c0', via: 'order', fallback: 'unsure', p: null, belowFloor: false, why: 'Jev unsure; first in the policy order.' }
    const first = (await run(tab, { type: 'route.record', conversationId: 'lead', decision } as Command, host, lead)).result.routeDecisionId as string
    const second = (await run(tab, { type: 'route.record', conversationId: 'lead', decision } as Command, host, lead)).result.routeDecisionId as string
    expect((await store.routeDecision(owner, tab, first)).outcome).toBe('superseded')
    const rows = (await store.messages(owner, tab, 'lead', {})).messages
    expect(rows.at(-1)).toMatchObject({ text: expect.stringContaining('"A small API change."'),
      source: { kind: 'route', decisionId: second, via: 'order', fallback: 'unsure', why: 'A small API change.' } })
    await expect(run(tab, { type: 'route.override', decisionId: first, candidateId: 'c1', reason: 'Needs Opus.' } as Command))
      .rejects.toMatchObject({ code: 'ROUTE_CLOSED' })
    await run(tab, { type: 'route.override', decisionId: second, candidateId: 'c1', reason: 'Needs Opus.' } as Command)
    expect((await store.routeDecision(owner, tab, second)).override).toMatchObject({ by: 'person', candidateId: 'c1' })
    expect((await store.deliveries(host, tab, lead)).length).toBeGreaterThan(0)
    await invite(tab, 'viewer')
    await expect(run(tab, { type: 'route.override', decisionId: second, candidateId: 'c0', reason: 'No.' } as Command, peer))
      .rejects.toMatchObject({ status: 403 })
    expect((await store.routeDecisions(owner, tab)).map(d => d.id)).toEqual([second, first])
    const response = await app.inject({ url: `/api/super-tabs/${tab}/route-decisions/${second}`, headers: { authorization: `Bearer ${peer.sub}` } })
    expect(response.statusCode).toBe(200)
  })

  it('returns the receipt of a recorded agent start after its machine stops being listed', async () => {
    const { tab, lead } = await fixture()
    const machineId = `second-${randomUUID()}`
    await db.machine.create({ data: { machineId, userId: host.sub, apiKey: 'fixture-only', managerId: 'fixture', autonomousEnv: 'prod', authMode: 'remote' } })
    await db.machineShare.create({ data: { machineId, ownerId: host.sub, autonomousEnv: 'prod', emails: [owner.email] } })
    const helper = (await run(tab, { type: 'agent.add', conversationId: 'lead', machineId, harnessId: randomUUID(), name: 'Helper', configuration: config, lead: false })).result.agentId as string
    const request = { conversationId: 'lead', machineId, engine: 'codex', name: 'Builder', cwd: '/work', worktree: true,
      requirements: { memoryBytes: 0, diskBytes: 0, maxCpuPercent: 100, tools: [], devices: [], quotaRequired: false } }
    const decision = { assessment: { difficulty: 'low', risk: 'low', why: 'Docs.' },
      candidates: [{ id: 'c0', kind: 'new', machineId: 'test-host', engine: 'claude', model: 'haiku', effort: 'auto', quality: 1, cost: 1, title: 'New agent', label: 'New agent' }],
      excluded: [], floor: 1, notes: false, pick: 'c0', via: 'only', p: null, belowFloor: false, why: 'Only candidate.' }
    const routeDecisionId = (await run(tab, { type: 'route.record', conversationId: 'lead', decision } as Command, host, lead)).result.routeDecisionId as string
    const operationId = randomUUID(), command: Command = { type: 'agent.start', request, routeDecisionId, overrideReason: 'The helper machine has the repository.' }
    const first = await run(tab, command, host, lead, operationId)
    await run(tab, { type: 'agent.remove', agentId: helper })
    // A new start on the machine is refused now, but the recorded one keeps its receipt.
    await expect(run(tab, command, host, lead)).rejects.toMatchObject({ code: 'MACHINE_NOT_LISTED' })
    expect((await run(tab, command, host, lead, operationId)).result.startId).toBe(first.result.startId)
  })

  it('corrects the log to the model that ran when the routed switch failed, and reads the times of one decision', async () => {
    const { tab, lead } = await fixture()
    const decision = { assessment: { difficulty: 'low', risk: 'low', why: 'Docs.' },
      candidates: [{ id: 'c0', kind: 'new', machineId: 'test-host', engine: 'claude', model: 'haiku', effort: 'auto', quality: 1, cost: 1, title: 'New agent', label: 'New agent' }],
      excluded: [], floor: 1, notes: false, pick: 'c0', via: 'only', p: null, belowFloor: false, why: 'Only candidate.' }
    const routeDecisionId = (await run(tab, { type: 'route.record', conversationId: 'lead', decision } as Command, host, lead)).result.routeDecisionId as string
    const request = { conversationId: 'lead', machineId: 'test-host', engine: 'claude', model: 'haiku', effort: 'auto', name: 'Builder', cwd: '/fixture/repo', worktree: false,
      requirements: { memoryBytes: 0, diskBytes: 0, maxCpuPercent: 100, tools: [], devices: [], quotaRequired: false } }
    const startId = (await run(tab, { type: 'agent.start', request, routeDecisionId } as Command, host, lead)).result.startId as string
    // A queued start already holds its account's quota when the Lead routes again.
    await run(tab, { type: 'route.record', conversationId: 'lead', decision } as Command, host, lead)
    expect((await store.routeDecision(owner, tab, routeDecisionId)).outcome).toBeNull()
    await expect(run(tab, { type: 'route.modelResult', decisionId: routeDecisionId, startId: 'other', model: 'sonnet', effort: 'auto' } as Command, host, lead))
      .rejects.toMatchObject({ code: 'ROUTE_MISMATCH' })
    const before = (await store.messages(owner, tab, 'lead', {})).messages.length
    await run(tab, { type: 'route.modelResult', decisionId: routeDecisionId, startId, model: 'sonnet', effort: 'auto' } as Command, host, lead)
    expect((await store.messages(owner, tab, 'lead', {})).messages).toHaveLength(before)
    const read = async () => (await app.inject({ url: `/api/super-tabs/${tab}/route-decisions/${routeDecisionId}`, headers: { authorization: `Bearer ${owner.sub}` } })).json().data
    expect(await read()).toMatchObject({ outcome: null, outcomeAt: null, createdAt: expect.any(String),
      final: { kind: 'new', startId, model: 'sonnet', effort: 'auto', requested: { model: 'haiku', effort: 'auto' } } })
  })

  it('releases a queued start\'s route hold when that start fails', async () => {
    const { tab, lead } = await fixture()
    const { routeDecisionId, startId } = await routedStart(tab, lead)
    expect((await store.routeDecision(owner, tab, routeDecisionId)).outcome).toBeNull()
    await run(tab, { type: 'agent.startFailed', startId, error: 'Launch refused.' }, host, lead)
    expect((await store.routeDecision(owner, tab, routeDecisionId)).outcome).toBe('failed')
  })

  it.each(['its owner removes it', 'its owner leaves the Swarm'] as const)('releases every queued route hold when its machine leaves because %s', async how => {
    // The Lead runs elsewhere: a machine that hosts a project's Lead cannot leave the Swarm.
    const tab = (await store.create(owner, randomUUID(), 'Pilot')).id
    const leadMachineId = `lead-${randomUUID()}`
    await db.machine.create({ data: { machineId: leadMachineId, userId: host.sub, apiKey: 'fixture-only', managerId: 'fixture', autonomousEnv: 'prod', authMode: 'remote' } })
    await db.machineShare.create({ data: { machineId: leadMachineId, ownerId: host.sub, autonomousEnv: 'prod', emails: [owner.email] } })
    const lead = (await run(tab, { type: 'agent.add', conversationId: 'lead', machineId: leadMachineId, harnessId: randomUUID(),
      name: 'Lead', configuration: config, lead: true })).result.agentId as string
    const invitation = await run(tab, { type: 'invite.create', email: host.email, role: 'collaborator', conversationId: 'lead' })
    await run(tab, { type: 'invite.accept', inviteId: invitation.result.inviteId as string }, host)
    await run(tab, { type: 'machine.contribute', machineId: 'test-host', name: 'Host', cwd: '/fixture/repo', engines: ['codex'], maxAgents: 4 }, host)
    const machine = (await poolRows(store, host, 'test-host')).find(pool => pool.tabId === tab)!.machine
    const team = await teamMachine('test-host')
    await store.observeMachine(team.session, tab, 'test-host', { generation: machine.generation,
      resources: { cpuPercent: 10, memoryTotalBytes: 32e9, memoryUsedBytes: 4e9, diskFreeBytes: 120e9, diskTotalBytes: 500e9,
        projectDiskFreeBytes: 120e9, deviceType: 'Laptop', chip: 'Fixture', os: 'macOS', gpuPercent: null },
      quotas: [], tools: {}, runningHarnessIds: [], stoppedHarnessIds: [], privacy: team.privacy })
    const starts = [await routedStart(tab, lead), await routedStart(tab, lead)]
    for (const { routeDecisionId } of starts) expect((await store.routeDecision(owner, tab, routeDecisionId)).outcome).toBeNull()

    await run(tab, how === 'its owner removes it' ? { type: 'machine.remove', machineId: 'test-host' } : { type: 'member.remove', userId: host.sub }, host)

    const state = (await store.read(owner, tab)).state
    for (const { routeDecisionId, startId } of starts) {
      expect(state.starts?.find(s => s.id === startId)?.error).toBe('Its machine was removed from the Swarm.')
      expect((await store.routeDecision(owner, tab, routeDecisionId)).outcome).toBe('failed')
    }
  })

  it('releases a started agent\'s route hold when the host stops it before assignment', async () => {
    const { tab, lead } = await fixture()
    const { routeDecisionId, startId } = await routedStart(tab, lead, 'reviewer')
    const agentId = String((await run(tab, { type: 'agent.started', startId, harnessId: randomUUID(), configuration: config }, host, lead)).result.agentId)
    expect((await store.routeDecision(owner, tab, routeDecisionId)).outcome).toBeNull()
    await run(tab, { type: 'agent.release', agentId, decision: 'stop' }, host, lead)
    const releaseId = (await store.read(owner, tab)).state.agents.find(agent => agent.id === agentId)!.releaseId!
    await run(tab, { type: 'agent.remove', agentId, releaseId }, host, agentId)
    expect((await store.routeDecision(owner, tab, routeDecisionId)).outcome).toBe('stopped')
  })

  it('names the failing field when a command is invalid', async () => {
    const { tab } = await fixture()
    const command = { type: 'agent.start', request: { conversationId: 'lead', machineId: 'test-host', engine: 'claude', name: 'Builder', cwd: '/fixture/repo', worktree: false } }
    const response = await app.inject({ method: 'POST', url: `/api/super-tabs/${tab}/commands`, headers: { authorization: `Bearer ${owner.sub}` },
      payload: { operationId: randomUUID(), command } })
    expect(response.statusCode).toBe(400)
    expect(response.json().error.message).toContain('command.request.requirements')
  })

  it('closes a linked decision with the assignment outcome', async () => {
    const { tab, lead } = await fixture()
    const group = (await run(tab, { type: 'conversation.create', title: 'Build', brief: 'Build it.', checks: [{ description: 'Tests pass', independent: false }] })).result.conversationId as string
    const worker = (await run(tab, { type: 'agent.add', conversationId: group, machineId: 'test-host', harnessId: randomUUID(),
      name: 'Builder', configuration: config, lead: false })).result.agentId as string
    const decision = { assessment: { difficulty: 'low', risk: 'low', why: 'Small.' },
      candidates: [{ id: 'c0', kind: 'member', agentId: worker, machineId: 'test-host', engine: 'claude', model: 'sonnet', effort: 'medium', quality: 2, cost: 2, title: 'Builder', label: 'Member Builder' }],
      excluded: [], floor: 1, notes: false, pick: 'c0', via: 'only', p: null, belowFloor: false, why: 'Only candidate.' }
    const routeDecisionId = (await run(tab, { type: 'route.record', conversationId: group, decision } as Command, host, lead)).result.routeDecisionId as string
    const assignmentId = (await run(tab, { type: 'work.assign', conversationId: group, agentId: worker, routeDecisionId } as Command, host, lead)).result.assignmentId as string
    expect(await store.routeDecision(owner, tab, routeDecisionId)).toMatchObject({ assignmentId, final: { kind: 'member', agentId: worker } })
    await run(tab, { type: 'route.record', conversationId: group, decision } as Command, host, lead)
    expect((await store.routeDecision(owner, tab, routeDecisionId)).outcome).toBeNull()
    await store.stopped(host, tab, assignmentId, 'native-stop-receipt')
    expect((await store.routeDecision(owner, tab, routeDecisionId)).outcome).toBe('stopped')
  })

  it('keeps a decision open when the Lead stops its work to hand over to the candidate a person chose', async () => {
    const { tab, lead } = await fixture()
    const group = (await run(tab, { type: 'conversation.create', title: 'Build', brief: 'Build it.', checks: [{ description: 'Tests pass', independent: false }] })).result.conversationId as string
    const add = async (name: string) => (await run(tab, { type: 'agent.add', conversationId: group, machineId: 'test-host', harnessId: randomUUID(),
      name, configuration: config, lead: false })).result.agentId as string
    const picked = await add('Picked'), chosen = await add('Chosen')
    const candidate = (id: string, agentId: string, title: string) => ({ id, kind: 'member', agentId, machineId: 'test-host', engine: 'codex',
      model: 'fixture-model', effort: 'high', quality: 2, cost: 2, title, label: `Member ${title}` })
    const decision = { assessment: { difficulty: 'low', risk: 'low', why: 'Small.' },
      candidates: [candidate('c0', picked, 'Picked'), candidate('c1', chosen, 'Chosen')],
      excluded: [], floor: 1, notes: false, pick: 'c0', via: 'jev', p: 0.9, belowFloor: false, why: 'Jev chose Picked.' }
    const id = (await run(tab, { type: 'route.record', conversationId: group, decision } as Command, host, lead)).result.routeDecisionId as string
    const first = (await run(tab, { type: 'work.assign', conversationId: group, agentId: picked, routeDecisionId: id } as Command, host, lead)).result.assignmentId as string
    await run(tab, { type: 'route.override', decisionId: id, candidateId: 'c1', reason: 'Chosen knows this code.' } as Command)
    // The person's Change reaches the Lead as a message to act on.
    const rows = (await store.messages(owner, tab, group, {})).messages
    const change = rows.at(-1)!
    expect(change).toMatchObject({ source: { kind: 'route-override', by: 'person' }, text: expect.stringContaining('chose Chosen instead of Picked') })
    expect((await store.deliveries(host, tab, lead)).map(d => d.messageId)).toContain(change.id)
    // The first attempt is still running: no second link may overwrite its final.
    await expect(run(tab, { type: 'work.assign', conversationId: group, agentId: chosen, routeDecisionId: id } as Command, host, lead))
      .rejects.toMatchObject({ code: 'WORK_ACTIVE' })
    await store.stopped(host, tab, first, 'handover-stop-receipt')
    expect(await store.routeDecision(owner, tab, id)).toMatchObject({ outcome: null, assignmentId: null, final: null })
    await run(tab, { type: 'agent.release', agentId: picked, decision: 'keep' }, host, lead)
    const second = (await run(tab, { type: 'work.assign', conversationId: group, agentId: chosen, routeDecisionId: id } as Command, host, lead)).result.assignmentId as string
    expect(await store.routeDecision(owner, tab, id)).toMatchObject({ outcome: null, assignmentId: second, final: { kind: 'member', agentId: chosen } })
    const check = (await store.read(owner, tab)).state.conversations.find(c => c.id === group)!.checks[0]!.id
    await run(tab, { type: 'work.check', conversationId: group, assignmentId: second, checkId: check, passed: true, evidence: 'ok' } as Command, host, chosen)
    await run(tab, { type: 'work.status', conversationId: group, assignmentId: second, status: 'done', result: 'Built.' } as Command, host, chosen)
    expect(await store.routeDecision(owner, tab, id)).toMatchObject({ outcome: 'done', assignmentId: second })
  })

  it('records more than 30 routes in an hour: there is no hourly cap', async () => {
    const { tab, lead } = await fixture()
    const decision = { assessment: { difficulty: 'low', risk: 'low', why: 'Docs.' },
      candidates: [{ id: 'c0', kind: 'new', machineId: 'test-host', engine: 'claude', model: 'haiku', effort: 'auto', quality: 1, cost: 1, title: 'New agent', label: 'New agent' }],
      excluded: [], floor: 1, notes: false, pick: 'c0', via: 'only', p: null, belowFloor: false, why: 'Only candidate.' }
    for (let i = 0; i < 30; i++) await run(tab, { type: 'route.record', conversationId: 'lead', decision } as Command, host, lead)
    await expect(run(tab, { type: 'route.record', conversationId: 'lead', decision } as Command, host, lead)).resolves.toBeDefined()
  })
})

it('allocates workgroup numbers transactionally and replays the same number after a lost reply', async () => {
  const tab = (await store.create(owner, randomUUID(), 'Numbered work')).id
  const operations = [randomUUID(), randomUUID(), randomUUID()]
  const command: Command = { type: 'conversation.create', title: 'Work', brief: '', checks: [] }
  const results = await Promise.all(operations.map(id => run(tab, command, owner, undefined, id)))
  expect(results.map(r => r.result.number).sort()).toEqual([1, 2, 3])
  expect((await run(tab, command, owner, undefined, operations[0])).result).toEqual(results[0]!.result)
  expect((await store.read(owner, tab)).state.conversations.map(c => c.number)).toEqual([undefined, 1, 2, 3, undefined])
})

describe('Super Tab chat attachments', () => {
  const files = new MemoryAttachmentStore()
  let attaching: SuperTabStore
  let upload: FastifyInstance
  beforeAll(async () => {
    attaching = new SuperTabStore(db, Date.now, { store: files, prefix: 'super-tabs', publicBase: 'https://cdn.example.test' })
    upload = Fastify()
    upload.setErrorHandler(errorHandler)
    upload.addHook('onRequest', async (request, reply) => {
      const user = [owner, peer, host].find(u => `Bearer ${u.sub}` === request.headers.authorization)
      if (!user) return reply.code(401).send({ success: false })
      request.user = user
    })
    await upload.register(superTabRoutes, { store: attaching })
    await upload.ready()
  })
  afterAll(async () => { await upload?.close() })
  type Part = [string, string] | [string, Uint8Array, string, string]
  type Uploaded = { id: string; name: string; mime: string; size: number; url: string }
  const post = async (tab: string, parts: Part[], user = owner, asAgentId?: string, server = upload) => {
    const form = new FormData()
    for (const part of parts) {
      if (part.length === 2) form.append(part[0], part[1])
      else form.append(part[0], new Blob([part[1]], { type: part[3] }), part[2])
    }
    const encoded = new Request('http://upload.test', { method: 'POST', body: form })
    const response = await server.inject({ method: 'POST', url: `/api/super-tabs/${tab}/attachments${asAgentId ? `?asAgentId=${asAgentId}` : ''}`,
      headers: { authorization: `Bearer ${user.sub}`, 'content-type': encoded.headers.get('content-type')! }, payload: Buffer.from(await encoded.arrayBuffer()) })
    const body = response.json()
    return { status: response.statusCode, code: body.error?.code ?? body.code, attachment: body.data?.attachment as Uploaded }
  }
  const file = (tab: string, name = 'screen.png', bytes = new Uint8Array([1, 2, 3]), mime = 'image/png', conversationId = 'lead', user = owner, asAgentId?: string) =>
    post(tab, [['conversationId', conversationId], ['file', bytes, name, mime]], user, asAgentId)
  const send = (tab: string, attachmentIds: string[], user = owner, asAgentId?: string, text = '', operationId = randomUUID()) =>
    attaching.execute(user, tab, { operationId, command: { type: 'message.send', conversationId: 'lead', text, replyTo: null, recipientIds: [], attachmentIds } }, asAgentId)
  const objectKey = (url: string) => url.slice('https://cdn.example.test/'.length)

  it('keeps a credential out of a file\'s name, which the chat shows like the message', async () => {
    const { tab } = await fixture()
    const token = ['ghp', 'Fixture0Token1Not2Real3Value4abcdefgh'].join('_')
    const { status, attachment } = await file(tab, `deploy-${token}.txt`, new Uint8Array([1, 2, 3]), 'text/plain')
    expect(status).toBe(200)
    expect(attachment.name).toBe('deploy-[credential removed].txt')
    expect(attachment.url).not.toContain(token)
    expect(JSON.stringify(await db.superTabAttachment.findMany({ where: { tabId: tab } }))).not.toContain(token)
  })

  it('streams one file into the bucket under a random key and answers its metadata', async () => {
    const { tab } = await fixture()
    const bytes = new Uint8Array(2 * 1024 * 1024).map((_, i) => i % 251)
    bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const { status, attachment } = await file(tab, 'Screen Shot 1.png', bytes)
    expect(status).toBe(200)
    expect(attachment).toMatchObject({ name: 'Screen Shot 1.png', mime: 'image/png', size: bytes.byteLength })
    expect(attachment.url).toMatch(new RegExp(`^https://cdn\\.example\\.test/super-tabs/${tab}/[0-9a-f]{32}/Screen_Shot_1\\.png$`))
    expect(files.objects.get(objectKey(attachment.url))!.bytes.equals(Buffer.from(bytes))).toBe(true)
    expect(files.objects.get(objectKey(attachment.url))).toMatchObject({ contentType: 'image/png', contentDisposition: "inline; filename*=UTF-8''Screen%20Shot%201.png" })
    const html = await file(tab, 'page.html', new Uint8Array([60]), 'text/html')
    expect(html.attachment.mime).toBe('text/html')
    expect(files.objects.get(objectKey(html.attachment.url))).toMatchObject({ contentType: 'application/octet-stream', contentDisposition: "attachment; filename*=UTF-8''page.html" })
    // A page renamed to .png is not an image: it is kept whole, as bytes to download.
    const page = Buffer.from('<html><script>alert(1)</script></html>')
    const disguised = await file(tab, 'cat.png', page, 'image/png')
    expect(disguised.attachment.mime).toBe('application/octet-stream')
    expect(files.objects.get(objectKey(disguised.attachment.url))).toMatchObject({ contentType: 'application/octet-stream', contentDisposition: "attachment; filename*=UTF-8''cat.png" })
    expect(files.objects.get(objectKey(disguised.attachment.url))!.bytes.equals(page)).toBe(true)
  })

  it('refuses an oversized, second, misordered or hidden-named file, and a server with no bucket', async () => {
    const { tab } = await fixture()
    const before = files.objects.size
    expect(await file(tab, 'big.bin', new Uint8Array(10 * 1024 * 1024 + 1), 'application/octet-stream')).toMatchObject({ status: 413, code: 'ATTACHMENT_TOO_LARGE' })
    expect(await file(tab, 'exact.bin', new Uint8Array(10 * 1024 * 1024), 'application/octet-stream')).toMatchObject({ status: 200 })
    expect(await post(tab, [['conversationId', 'lead'], ['file', new Uint8Array(1), 'a.png', 'image/png'], ['file', new Uint8Array(1), 'b.png', 'image/png']]))
      .toMatchObject({ status: 400, code: 'INVALID_ATTACHMENT' })
    expect(await post(tab, [['file', new Uint8Array(1), 'a.png', 'image/png'], ['conversationId', 'lead']])).toMatchObject({ status: 400, code: 'INVALID_ATTACHMENT' })
    expect(await post(tab, [['conversationId', 'lead']])).toMatchObject({ status: 400, code: 'INVALID_ATTACHMENT' })
    expect(await file(tab, 'evil‮gnp.exe')).toMatchObject({ status: 400, code: 'INVALID_ATTACHMENT' })
    const json = await upload.inject({ method: 'POST', url: `/api/super-tabs/${tab}/attachments`, headers: { authorization: `Bearer ${owner.sub}` }, payload: { conversationId: 'lead' } })
    expect([json.statusCode, json.json().error?.code ?? json.json().code]).toEqual([400, 'INVALID_ATTACHMENT'])
    // The exact-size file, and the first of the two: the second is only seen after the first was stored. Its id was
    // never answered to anyone, so nothing can send it.
    expect(files.objects.size).toBe(before + 2)
    expect(await post(tab, [['conversationId', 'lead'], ['file', new Uint8Array(1), 'a.png', 'image/png']], owner, undefined, app))
      .toMatchObject({ status: 503, code: 'ATTACHMENTS_UNAVAILABLE' })
  })

  it('answers a bucket failure as unavailable, not as a server error', async () => {
    const { tab } = await fixture()
    const put = vi.spyOn(files, 'put').mockRejectedValueOnce(Object.assign(new Error('Forbidden'), { code: 403 }))
    expect(await file(tab)).toMatchObject({ status: 503, code: 'ATTACHMENTS_UNAVAILABLE' })
    put.mockRestore()
    expect(await file(tab)).toMatchObject({ status: 200 })
  })

  it('sends uploaded files once, with empty text, and delivers their metadata to the agent', async () => {
    const { tab, lead } = await fixture()
    const { attachment } = await file(tab, 'log.txt', new Uint8Array(10), 'text/plain')
    const sent = await send(tab, [attachment.id])
    const row = (await store.messages(owner, tab, 'lead', {})).messages.find(m => m.id === sent.result.messageId)!
    expect(row).toMatchObject({ text: '', attachments: [attachment] })
    const delivery = (await store.deliveries(host, tab, lead)).find(d => d.messageId === sent.result.messageId)!
    expect((await store.delivery(host, tab, lead, delivery.id, { type: 'claim', claimId: randomUUID() })).message!.attachments).toEqual([attachment])
    await expect(send(tab, [attachment.id])).rejects.toMatchObject({ code: 'ATTACHMENT_USED' })
    await expect(send(tab, [])).rejects.toMatchObject({ code: 'TEXT_REQUIRED' })
  })

  it('lets only the uploading actor send a file, only in its conversation, and an agent attach from its host', async () => {
    const { tab, lead } = await fixture()
    await invite(tab)
    const mine = (await file(tab)).attachment
    await expect(send(tab, [mine.id], peer)).rejects.toMatchObject({ code: 'ATTACHMENT_UNAVAILABLE' })
    const group = String((await run(tab, { type: 'conversation.create', title: 'Elsewhere', brief: '', checks: [] })).result.conversationId)
    const elsewhere = (await file(tab, 'x.png', new Uint8Array(5), 'image/png', group)).attachment
    await expect(send(tab, [elsewhere.id])).rejects.toMatchObject({ code: 'ATTACHMENT_UNAVAILABLE' })
    await expect(send(tab, ['missing-attachment'])).rejects.toMatchObject({ code: 'ATTACHMENT_UNAVAILABLE' })
    expect(await file(tab, 'a.png', new Uint8Array(1), 'image/png', 'lead', peer, lead)).toMatchObject({ status: 403, code: 'FORBIDDEN' })
    expect(await file(tab, 'a.png', new Uint8Array(1), 'image/png', 'no-such-group')).toMatchObject({ status: 404 })
    const fromAgent = (await file(tab, 'result.png', new Uint8Array(7), 'image/png', 'lead', host, lead)).attachment
    const sent = await send(tab, [fromAgent.id], host, lead, 'Here is the screenshot.')
    expect((await store.messages(owner, tab, 'lead', {})).messages.find(m => m.id === sent.result.messageId))
      .toMatchObject({ author: { kind: 'agent', id: lead }, attachments: [{ name: 'result.png', size: 7 }] })
  })

  it('refuses a viewer before storing anything', async () => {
    const { tab } = await fixture()
    await invite(tab, 'viewer')
    const before = files.objects.size
    expect(await file(tab, 'a.png', new Uint8Array(1), 'image/png', 'lead', peer)).toMatchObject({ status: 403, code: 'READ_ONLY' })
    expect(files.objects.size).toBe(before)
  })
})

it('releases a finished worker through its execution host, cancels deliveries and returns the machine slot', async () => {
  const { tab, lead } = await fixture()
  const invitation = await run(tab, { type: 'invite.create', email: host.email, role: 'collaborator', conversationId: 'lead' })
  await run(tab, { type: 'invite.accept', inviteId: invitation.result.inviteId as string }, host)
  await run(tab, { type: 'machine.contribute', machineId: 'test-host', name: 'Host', cwd: '/repo', engines: ['codex'], maxAgents: 4 }, host)
  const group = (await run(tab, { type: 'conversation.create', title: 'Task', brief: 'Deliver it', checks: [{ description: 'Verified', independent: false }] })).result.conversationId as string
  const native = randomUUID()
  const worker = (await run(tab, { type: 'agent.add', conversationId: group, machineId: 'test-host', harnessId: native, name: 'Worker', configuration: config, lead: false })).result.agentId as string
  const pool = (await poolRows(store, host, 'test-host')).find(p => p.tabId === tab)!.machine
  const oldObservation = { generation: pool.generation,
    resources: { cpuPercent: 10, memoryTotalBytes: 32e9, memoryUsedBytes: 4e9, diskFreeBytes: 120e9, diskTotalBytes: 500e9, projectDiskFreeBytes: 120e9, deviceType: 'Laptop', chip: 'Fixture', os: 'macOS', gpuPercent: null },
    quotas: [], tools: {}, runningHarnessIds: [native], stoppedHarnessIds: [] }
  await store.observeMachine(host, tab, 'test-host', oldObservation)
  const assignmentId = (await run(tab, { type: 'work.assign', conversationId: group, agentId: worker })).result.assignmentId as string
  await expect(run(tab, { type: 'agent.release', agentId: worker, decision: 'stop' }, host, lead)).rejects.toMatchObject({ code: 'WORK_ACTIVE' })
  await store.stopped(host, tab, assignmentId, 'fixture-native-stop')
  const before = (await store.read(owner, tab)).state
  expect(before.agents.find(a => a.id === worker)!.workDecision).toBe('awaiting')
  const { machineSlots } = await import('../src/superTabs/machines.js')
  expect(machineSlots(before, before.machines![0]!)).toBe(2)
  await run(tab, { type: 'agent.release', agentId: worker, decision: 'stop' }, host, lead)
  expect((await rosterRows(store, host, 'test-host')).find(r => r.agent?.id === worker)).toMatchObject({ stopRequested: true })
  await expect(run(tab, { type: 'agent.remove', agentId: worker }, owner, worker)).rejects.toMatchObject({ code: 'FORBIDDEN' })
  const operation = randomUUID()
  const releaseId = (await store.read(owner, tab)).state.agents.find(a => a.id === worker)!.releaseId!
  const removal = { type: 'agent.remove', agentId: worker, releaseId } as Command
  await expect(run(tab, { ...removal, releaseId: 'old-release' } as Command, host, worker)).rejects.toMatchObject({ code: 'STALE_RELEASE' })
  const receipt = await run(tab, removal, host, worker, operation)
  expect(await run(tab, removal, host, worker, operation)).toEqual(receipt)
  const after = (await store.read(owner, tab)).state
  expect(after.agents.some(a => a.id === worker)).toBe(false)
  expect(machineSlots(after, after.machines![0]!)).toBe(1)
  await store.observeMachine(host, tab, 'test-host', oldObservation)
  const delayed = (await store.read(owner, tab)).state
  expect(delayed.machines![0]!.availableSlots).toBe(3)
  expect(await db.superTabDelivery.count({ where: { tabId: tab, agentId: worker, status: { in: ['queued', 'claimed', 'uncertain'] } } })).toBe(0)
  expect((await rosterRows(store, host, 'test-host')).some(r => r.agent?.id === worker)).toBe(false)
  // Re-contribution reserves a new runtime; ordinary removal must not reuse its old stop proof.
  await run(tab, { type: 'agent.add', conversationId: group, machineId: 'test-host', harnessId: native, name: 'Renewed worker', configuration: config, lead: false })
  await run(tab, { type: 'agent.remove', agentId: worker })
  const hostPool = (await poolRows(store, host, 'test-host')).find(p => p.tabId === tab)!
  expect(hostPool.harnessIds).toContain(native)
  const reservation = hostPool.reservations.find(r => r.harnessId === native)!
  await store.observeMachine(host, tab, 'test-host', { ...oldObservation, runningHarnessIds: [], stoppedHarnessIds: [native],
    stoppedReservations: [{ harnessId: native, generation: 'old-generation' }] })
  const stillReserved = (await store.read(owner, tab)).state
  expect(stillReserved.machines![0]!.availableSlots).toBe(2)
  await store.observeMachine(host, tab, 'test-host', { ...oldObservation, runningHarnessIds: [], stoppedHarnessIds: [native],
    stoppedReservations: [reservation] })
  const physicallyStopped = (await store.read(owner, tab)).state
  expect(physicallyStopped.machines![0]!.availableSlots).toBe(3)
  await store.observeMachine(host, tab, 'test-host', oldObservation)
  const delayedAgain = (await store.read(owner, tab)).state
  expect(delayedAgain.machines![0]!.availableSlots).toBe(3)
})

it('fences a shared native session globally while its release is pending', async () => {
  const a = await fixture(), b = await fixture(), native = randomUUID()
  const add = async (tab: string) => {
    const group = (await run(tab, { type: 'conversation.create', title: 'Shared worker task', brief: 'Work', checks: [{ description: 'Done', independent: false }] })).result.conversationId as string
    const worker = (await run(tab, { type: 'agent.add', conversationId: group, machineId: 'test-host', harnessId: native, name: 'Shared worker', configuration: config, lead: false })).result.agentId as string
    const assignmentId = (await run(tab, { type: 'work.assign', conversationId: group, agentId: worker })).result.assignmentId as string
    return { group, worker, assignmentId }
  }
  const first = await add(a.tab)
  await store.stopped(host, a.tab, first.assignmentId, 'first-finished')
  const second = await add(b.tab)
  await expect(run(a.tab, { type: 'agent.release', agentId: first.worker, decision: 'stop' }, host, a.lead)).rejects.toMatchObject({ code: 'AGENT_BUSY' })
  await store.stopped(host, b.tab, second.assignmentId, 'second-finished')
  await run(b.tab, { type: 'agent.remove', agentId: second.worker })
  await run(a.tab, { type: 'agent.release', agentId: first.worker, decision: 'stop' }, host, a.lead)
  await expect(run(b.tab, { type: 'agent.add', conversationId: second.group, machineId: 'test-host', harnessId: native, name: 'Shared worker', configuration: config, lead: false })).rejects.toMatchObject({ code: 'STOP_REQUESTED' })
  await expect(run(a.tab, { type: 'agent.remove', agentId: first.worker }, host, a.lead)).rejects.toMatchObject({ code: 'FORBIDDEN' })
  const state = (await store.read(owner, a.tab)).state
  const releaseId = state.agents.find(x => x.id === first.worker)!.releaseId!
  await run(a.tab, { type: 'agent.remove', agentId: first.worker, releaseId } as Command, host, first.worker)
  expect(await db.superTabRun.findUnique({ where: { id: first.worker } })).toBeNull()
})

it('lets a person force-withdraw a stuck stop, clears its fence and retires the old session', async () => {
  const { tab, lead } = await fixture(), native = randomUUID()
  const group = (await run(tab, { type: 'conversation.create', title: 'Offline worker', brief: 'Work', checks: [{ description: 'Done', independent: false }] })).result.conversationId as string
  const worker = (await run(tab, { type: 'agent.add', conversationId: group, machineId: 'test-host', harnessId: native, name: 'Worker', configuration: config, lead: false })).result.agentId as string
  const assignmentId = (await run(tab, { type: 'work.assign', conversationId: group, agentId: worker })).result.assignmentId as string
  await store.stopped(host, tab, assignmentId, 'completed-before-offline')
  await run(tab, { type: 'agent.release', agentId: worker, decision: 'stop' }, host, lead)
  const forced = { type: 'agent.remove', agentId: worker } as Command
  await expect(run(tab, forced, host, lead)).rejects.toMatchObject({ code: 'FORBIDDEN' })
  await run(tab, forced)
  expect(await db.superTabRun.findUnique({ where: { id: worker } })).toBeNull()
  expect((await store.read(owner, tab)).state.agents.some(a => a.id === worker)).toBe(false)
  // The old native identity cannot receive new work while a delayed close may still be finishing.
  await expect(run(tab, { type: 'agent.add', conversationId: group, machineId: 'test-host', harnessId: native, name: 'Retired worker', configuration: config, lead: false })).rejects.toMatchObject({ code: 'SESSION_RELEASED' })
  const other = await fixture()
  const reused = await run(other.tab, { type: 'agent.add', conversationId: 'lead', machineId: 'test-host', harnessId: native, name: 'Contributor reuse', configuration: config, lead: false })
  expect(reused.result.agentId).toBe(worker)
  await run(tab, { type: 'project.delete', projectId: 'lead' })
})

it('refuses to stop a finished worker that also works in another Swarm', async () => {
  // A session registered in two Swarms can no longer be a Lead in either (final review, Critical 1), so it works there as a Builder.
  const first = await fixture(), second = { tab: (await store.create(owner, randomUUID(), 'Other')).id }, native = randomUUID()
  const group = (await run(first.tab, { type: 'conversation.create', title: 'Finished worker', brief: 'Work', checks: [{ description: 'Done', independent: false }] })).result.conversationId as string
  const worker = (await run(first.tab, { type: 'agent.add', conversationId: group, machineId: 'test-host', harnessId: native, name: 'Worker', configuration: config, lead: false })).result.agentId as string
  const assignmentId = (await run(first.tab, { type: 'work.assign', conversationId: group, agentId: worker })).result.assignmentId as string
  await store.stopped(host, first.tab, assignmentId, 'completed')
  await run(second.tab, { type: 'agent.add', conversationId: 'lead', machineId: 'test-host', harnessId: native, name: 'Other Builder', configuration: config, lead: false })
  await expect(run(first.tab, { type: 'agent.release', agentId: worker, decision: 'stop' }, host, first.lead)).rejects.toMatchObject({ code: 'SESSION_SHARED' })
  expect((await store.read(owner, first.tab)).state.agents.find(a => a.id === worker)!.workDecision).toBe('awaiting')
})


it('makes a project private while its worker is stopping', async () => {
  const { tab, lead } = await fixture(), native = randomUUID()
  const group = (await run(tab, { type: 'conversation.create', title: 'Finished task', brief: 'Work', checks: [{ description: 'Done', independent: false }] })).result.conversationId as string
  const worker = (await run(tab, { type: 'agent.add', conversationId: group, machineId: 'test-host', harnessId: native, name: 'Worker', configuration: config, lead: false })).result.agentId as string
  const assignmentId = (await run(tab, { type: 'work.assign', conversationId: group, agentId: worker })).result.assignmentId as string
  await store.stopped(host, tab, assignmentId, 'completed')
  await run(tab, { type: 'agent.release', agentId: worker, decision: 'stop' }, host, lead)
  await run(tab, { type: 'project.sharing', projectId: 'lead', visibility: 'private', memberIds: [] })
  const state = (await store.read(owner, tab)).state
  expect(state.projects!.find(p => p.id === 'lead')!.visibility).toBe('private')
  expect(state.agents.find(a => a.id === worker)!.workDecision).toBe('stop')
})


it.each(['finished', 'expired'] as const)('lets another Swarm reuse after the native close lease is %s', async outcome => {
  const first = await fixture(), other = await fixture(), native = randomUUID()
  const group = (await run(first.tab, { type: 'conversation.create', title: 'Task', brief: 'Work', checks: [{ description: 'Done', independent: false }] })).result.conversationId as string
  const worker = (await run(first.tab, { type: 'agent.add', conversationId: group, machineId: 'test-host', harnessId: native, name: 'Worker', configuration: config, lead: false })).result.agentId as string
  const assignmentId = (await run(first.tab, { type: 'work.assign', conversationId: group, agentId: worker })).result.assignmentId as string
  await store.stopped(host, first.tab, assignmentId, 'completed')
  await run(first.tab, { type: 'agent.release', agentId: worker, decision: 'stop' }, host, first.lead)
  const leased = await run(first.tab, { type: 'agent.stopLease', agentId: worker, releaseId: (await store.read(owner, first.tab)).state.agents.find(a => a.id === worker)!.releaseId! } as Command, host, worker)
  const reuse = { type: 'agent.add', conversationId: 'lead', machineId: 'test-host', harnessId: native, name: 'Reused', configuration: config, lead: false } as Command
  if (outcome === 'expired') await run(first.tab, { type: 'agent.remove', agentId: worker })
  await expect(run(other.tab, reuse)).rejects.toMatchObject({ code: 'CLOSE_PENDING' })
  if (outcome === 'finished') {
    const releaseId = (await store.read(owner, first.tab)).state.agents.find(a => a.id === worker)!.releaseId!
    await run(first.tab, { type: 'agent.remove', agentId: worker, releaseId }, host, worker)
    expect((await run(other.tab, reuse)).result.agentId).toBe(worker)
  } else {
    const later = new SuperTabStore(db, () => Number(leased.result.expiresAt) + 1)
    expect((await later.execute(owner, other.tab, { operationId: randomUUID(), command: reuse })).result.agentId).toBe(worker)
  }
})

describe('the owner\'s Lead machine joins its Swarm', () => {
  it('adds the machine once, finishes abandoned starts and keeps in-flight ones and existing settings', async () => {
    const machineId = `owner-mac-${randomUUID()}`
    await db.machine.create({ data: { machineId, userId: owner.sub, apiKey: `fixture-${machineId}`, managerId: 'fixture', autonomousEnv: 'prod', authMode: 'remote' } })
    const tab = (await store.create(owner, randomUUID(), 'Own machine')).id
    const lead = (await run(tab, { type: 'agent.add', conversationId: 'lead', machineId, harnessId: randomUUID(), name: 'Lead', configuration: config, lead: true })).result.agentId as string
    expect((await rosterRows(store, owner, machineId)).map(r => r.joinSwarm)).toEqual([true])
    const request = { conversationId: 'lead', machineId, engine: 'codex', name: 'Builder', cwd: '/repo', worktree: true,
      requirements: { memoryBytes: 0, diskBytes: 0, maxCpuPercent: 100, tools: [], devices: [], quotaRequired: false } }
    const start = async () => (await run(tab, { type: 'agent.start', request })).result.startId as string
    const [abandoned, inFlight, dispatched] = [await start(), await start(), await start()]
    await run(tab, { type: 'agent.startDispatch', startId: dispatched })
    const age = (ids: string[]) => db.superTabOperation.updateMany({ where: { id: { in: ids.map(id => stableId(tab, `person:${owner.sub}`, id)) } },
      data: { createdAt: new Date(Date.now() - ABANDONED_START_MS - 1) } })
    await age([abandoned, dispatched])
    const join = { type: 'machine.contribute' as const, machineId, name: 'Ken Mac', cwd: '/swarm', scope: 'swarm' as const, engines: ['codex'], maxAgents: 3, ifMissing: true as const }
    await expect(run(tab, join)).rejects.toMatchObject({ code: 'STARTS_PENDING' })
    const pending = (await store.read(owner, tab)).state.starts!
    expect([abandoned, inFlight, dispatched].map(id => pending.find(s => s.id === id)!.error)).toEqual([null, null, null])
    await run(tab, { type: 'agent.startFailed', startId: inFlight, error: 'Launch refused.' })
    await run(tab, { type: 'agent.started', startId: dispatched, harnessId: randomUUID(), configuration: config })
    await run(tab, join)
    const joined = (await store.read(owner, tab)).state
    expect(joined.starts!.find(s => s.id === abandoned)!.error).toBe('Abandoned before it started.')
    expect(joined.starts!.find(s => s.id === inFlight)!.error).toBe('Launch refused.')
    expect(joined.starts!.find(s => s.id === dispatched)!.error).toBeNull()
    const notice = (await store.messages(owner, tab, 'lead', {})).messages.at(-1)!
    expect(notice.text).toBe('Builder never started and will not start now. Start it again if still needed.')
    // The notice is written in the owner's name, but the system wrote it: a Lead cannot quote it as the owner asking.
    await expect(run(tab, { type: 'rule.set', rule: { kind: 'preferIdle' }, text: 'Idle first.', askedIn: { conversationId: 'lead', messageId: notice.id } },
      owner, lead)).rejects.toMatchObject({ code: 'OWNER_MESSAGE_REQUIRED' })
    const added = joined.machines!.find(m => m.machineId === machineId)!
    expect(added).toMatchObject({ contributorId: owner.sub, maxAgents: 3, scope: 'swarm', cwd: '/swarm' })
    expect((await rosterRows(store, owner, machineId)).map(r => r.joinSwarm)).toEqual([false, false])
    await run(tab, { ...join, maxAgents: 8, cwd: '/elsewhere' })
    expect((await store.read(owner, tab)).state.machines!.find(m => m.machineId === machineId)).toEqual(added)
  })

  it('never adds another account\'s machine', async () => {
    const { tab } = await fixture()
    const invitation = await run(tab, { type: 'invite.create', email: host.email, role: 'collaborator', conversationId: 'lead' })
    await run(tab, { type: 'invite.accept', inviteId: invitation.result.inviteId as string }, host)
    expect((await rosterRows(store, host, 'test-host')).filter(r => r.tabId === tab).map(r => r.joinSwarm)).toEqual([false])
    const join = { type: 'machine.contribute' as const, machineId: 'test-host', name: 'Host', cwd: '/swarm', scope: 'swarm' as const, engines: ['codex'], maxAgents: 2, ifMissing: true as const }
    await expect(run(tab, join)).rejects.toMatchObject({ code: 'OWNER_REQUIRED' })
    await expect(run(tab, join, host)).rejects.toMatchObject({ code: 'OWNER_REQUIRED' })
    expect((await store.read(owner, tab)).state.machines ?? []).toEqual([])
  })

  it('never marks the owner\'s machine for a collaborator\'s Lead running on it through a share', async () => {
    const machineId = `owner-shared-${randomUUID()}`
    await db.machine.create({ data: { machineId, userId: owner.sub, apiKey: `fixture-${machineId}`, managerId: 'fixture', autonomousEnv: 'prod', authMode: 'remote' } })
    await db.machineShare.create({ data: { machineId, ownerId: owner.sub, autonomousEnv: 'prod', emails: [peer.email] } })
    const tab = (await store.create(owner, randomUUID(), 'Shared Lead')).id
    await invite(tab)
    await run(tab, { type: 'agent.add', conversationId: 'lead', machineId, harnessId: randomUUID(), name: 'Peer Lead', configuration: config, lead: true }, peer)
    expect((await rosterRows(store, owner, machineId)).map(r => [r.agent.contributorId, r.joinSwarm])).toEqual([[peer.sub, false]])
  })
})

describe('Lead safety on the host roster', () => {
  it('marks the Lead, refuses removing it, and lists removed sessions to close until their machine owner confirms', async () => {
    const { tab, lead } = await fixture()
    const harness = randomUUID()
    const worker = (await run(tab, { type: 'agent.add', conversationId: 'lead', machineId: 'test-host', harnessId: harness, name: 'Worker',
      configuration: config, lead: false })).result.agentId as string
    const rows = async () => (await rosterRows(store, host, 'test-host')).filter(r => r.tabId === tab)
    expect((await rows()).map(r => [r.agent.id, r.lead])).toEqual([[lead, true], [worker, false]])
    await expect(run(tab, { type: 'agent.remove', agentId: lead })).rejects.toMatchObject({ code: 'LEAD_PROTECTED',
      message: expect.stringContaining('is the Product Manager of project Pilot. Delete the project first.') })

    await run(tab, { type: 'agent.remove', agentId: worker })
    const closing = (id: string, harnessId: string) => ({ tabId: tab, agent: { id, harnessId, machineId: 'test-host' }, closeSession: true, active: false })
    expect(await rows()).toEqual([expect.objectContaining({ agent: expect.objectContaining({ id: lead }) }), closing(worker, harness)])
    // What the host sends: its own account, no agent, one operation per session.
    const confirm = (agentId: string, harnessId: string, user = host) =>
      run(tab, { type: 'agent.sessionClosed', agentId, harnessId }, user, undefined, `session-closed-${agentId}-${harnessId}`)
    expect((await store.read(owner, tab)).state).not.toHaveProperty('closingSessions')
    // Neither the Swarm owner nor an outsider can confirm it, and a refusal writes nothing; the machine's owner can,
    // though it is not in the Swarm.
    const revision = (await store.read(owner, tab)).lastChangedAt
    await expect(confirm(worker, harness, owner)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(confirm(worker, harness, peer)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect((await store.read(owner, tab)).lastChangedAt).toBe(revision)
    const receipt = await confirm(worker, harness)
    expect(await confirm(worker, harness)).toEqual(receipt)
    await expect(run(tab, { type: 'agent.sessionClosed', agentId: worker, harnessId: harness }, host)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect((await rows()).map(r => r.agent.id)).toEqual([lead])

    // Deleting the project takes its Lead, and its host is asked to close the session even with no agent left on the machine.
    const leadHarness = (await store.read(owner, tab)).state.agents.find(a => a.id === lead)!.harnessId
    await run(tab, { type: 'project.delete', projectId: 'lead' })
    expect(await rows()).toEqual([closing(lead, leadHarness)])
    await confirm(lead, leadHarness)
    expect(await rows()).toEqual([])
  })
})

describe('grant checks of the host roster', () => {
  /** A machine of `host`'s shared with the owner and peer, and a Swarm of the owner's with the peer in it, on its own
   *  machine so no other test's Swarm shows up in its host reads. */
  async function sharedMachine() {
    const machineId = `grants-${randomUUID()}`
    await db.machine.create({ data: { machineId, userId: host.sub, apiKey: `fixture-${machineId}`, managerId: 'fixture', autonomousEnv: 'prod', authMode: 'remote' } })
    await db.machineShare.create({ data: { machineId, ownerId: host.sub, autonomousEnv: 'prod', emails: [owner.email, peer.email] } })
    const tab = (await store.create(owner, randomUUID(), 'Grants')).id
    await invite(tab)
    const add = async (tabId: string, name: string, by: AuthUser, lead = false) => (await run(tabId, { type: 'agent.add', conversationId: 'lead', machineId,
      harnessId: randomUUID(), name, configuration: config, lead }, by)).result.agentId as string
    return { machineId, tab, add }
  }
  /** Each database call a host read makes, as `Model.operation`, through a store on a client that counts them. */
  function counted() {
    const calls: string[] = []
    const client = db.$extends({ query: { $allModels: { async $allOperations({ model, operation, args, query }) {
      calls.push(`${model}.${operation}`)
      return query(args)
    } } } }) as unknown as PrismaClient
    const count = (call: string) => calls.filter(c => c === call).length
    return { store: new SuperTabStore(client), count }
  }
  const agentIds = (rows: Array<{ tabId: string; agent?: { id: string } }>, tab: string) => rows.filter(r => r.tabId === tab && r.agent).map(r => r.agent!.id).sort()

  it('reads the machine, its share, and each contributor and their Workspace membership once per host read, not once per agent', async () => {
    const { machineId, tab, add } = await sharedMachine()
    const agents = [await add(tab, 'Lead', owner, true)]
    for (let i = 0; i < 4; i++) agents.push(await add(tab, `Owner worker ${i}`, owner))
    for (let i = 0; i < 3; i++) agents.push(await add(tab, `Peer worker ${i}`, peer))
    const { store: counting, count } = counted()
    expect(agentIds(await rosterRows(counting, host, machineId), tab)).toEqual(agents.sort())
    // Eight agents of two contributors on one machine: the read's own machine check, one share, two people, two memberships.
    expect({ machines: count('Machine.findFirst'), shares: count('MachineShare.findUnique'), contributors: count('User.findUnique'),
      memberships: count('SwarmWorkspaceMember.findUnique') }).toEqual({ machines: 1, shares: 1, contributors: 2, memberships: 2 })
  })

  it('checks agents of one contributor checked at once with one read of each lookup', async () => {
    const { tab, add } = await sharedMachine()
    const agents = [await add(tab, 'Peer worker 1', peer), await add(tab, 'Peer worker 2', peer), await add(tab, 'Peer worker 3', peer)]
    const { state } = await store.read(owner, tab)
    const { store: counting, count } = counted()
    const reads = new GrantReads()
    await Promise.all(agents.map(id => counting.agentGrant(counting.db, state, state.agents.find(a => a.id === id)!, reads)))
    expect({ machines: count('Machine.findFirst'), shares: count('MachineShare.findUnique'), contributors: count('User.findUnique'),
      memberships: count('SwarmWorkspaceMember.findUnique') }).toEqual({ machines: 1, shares: 1, contributors: 1, memberships: 1 })
  })

  it('keeps nothing between two host reads of one store: a share revoked between them drops the rows on the next', async () => {
    const { machineId, tab, add } = await sharedMachine()
    const mine = [await add(tab, 'Lead', owner, true), await add(tab, 'Owner worker', owner)]
    const theirs = [await add(tab, 'Peer worker 1', peer), await add(tab, 'Peer worker 2', peer)]
    const hosts = new HostReads(counted().store)
    const roster = async () => agentIds((await hosts.changes(host, machineId, { full: true })).tabs.flatMap(t => 'roster' in t ? t.roster : []), tab)
    expect(await roster()).toEqual([...mine, ...theirs].sort())
    const before = await db.machineShare.findUniqueOrThrow({ where: { machineId } })
    await db.machineShare.update({ where: { machineId }, data: { emails: [owner.email], grantVersions: nextMachineShareGrants(before, [owner.email], null) } })
    expect(await roster()).toEqual(mine.sort())
  })

  it('still drops only the rows of a contributor whose share was revoked', async () => {
    const { machineId, tab, add } = await sharedMachine()
    const mine = [await add(tab, 'Lead', owner, true), await add(tab, 'Owner worker', owner)]
    await add(tab, 'Peer worker 1', peer)
    await add(tab, 'Peer worker 2', peer)
    const before = await db.machineShare.findUniqueOrThrow({ where: { machineId } })
    await db.machineShare.update({ where: { machineId }, data: { emails: [owner.email], grantVersions: nextMachineShareGrants(before, [owner.email], null) } })
    expect(agentIds(await rosterRows(counted().store, host, machineId), tab)).toEqual(mine.sort())
  })

  it('still drops a contributor\'s rows only in the Swarms of the Workspace they left', async () => {
    const { machineId, tab, add } = await sharedMachine()
    const mine = [await add(tab, 'Lead', owner, true), await add(tab, 'Owner worker', owner)]
    await add(tab, 'Peer worker 1', peer)
    await add(tab, 'Peer worker 2', peer)
    // The peer's own Swarm, in the peer's own Workspace, on the same machine.
    const theirs = (await store.create(peer, randomUUID(), 'Peer Swarm')).id
    const peers = [await add(theirs, 'Peer Lead', peer, true), await add(theirs, 'Peer helper', peer)]
    const workspaceId = (await db.superTab.findUniqueOrThrow({ where: { id: tab } })).workspaceId!
    expect((await db.superTab.findUniqueOrThrow({ where: { id: theirs } })).workspaceId).not.toBe(workspaceId)
    await db.swarmWorkspaceMember.update({ where: { id: `${workspaceId}:${peer.sub}` }, data: { removedAt: new Date() } })
    const rows = await rosterRows(counted().store, host, machineId)
    expect(agentIds(rows, tab)).toEqual(mine.sort())
    expect(agentIds(rows, theirs)).toEqual(peers.sort())
  })
})

describe('the Lead reads and types in an agent terminal', () => {
  async function terminalFixture() {
    const { tab, lead } = await fixture()
    const group = (await run(tab, { type: 'conversation.create', title: 'Terminal', brief: 'Answer the prompt', checks: [] })).result.conversationId as string
    const harnessId = randomUUID()
    const worker = (await run(tab, { type: 'agent.add', conversationId: group, machineId: 'test-host', harnessId,
      name: 'Terminal Engineer', configuration: config, lead: false })).result.agentId as string
    const claim = async (at = store) => (await at.hostTerminal(host, 'test-host')).filter(row => row.tabId === tab)
    return { tab, lead, worker, group, harnessId, claim }
  }
  const later = (ms: number) => new SuperTabStore(db, () => Date.now() + ms)

  it('relays a screen read to the owning host once and returns it only to the requester, outside history', async () => {
    const { tab, lead, worker, group, harnessId, claim } = await terminalFixture()
    const requestId = (await run(tab, { type: 'agent.screen', agentId: worker, scrollback: 20 }, host, lead)).result.requestId as string
    await expect(store.hostTerminal(peer, 'test-host')).rejects.toThrow('unavailable')
    expect(await claim()).toEqual([{ tabId: tab, agentId: worker, harnessId, request: { id: requestId, kind: 'screen', scrollback: 20 } }])
    expect(await claim()).toEqual([])
    expect(await store.terminalResult(host, tab, requestId, lead)).toEqual({ requestId, pending: true })
    await expect(run(tab, { type: 'agent.screenResult', requestId, ok: true, text: 'x' }, host, lead)).rejects.toThrow('host')
    await run(tab, { type: 'agent.screenResult', requestId, ok: true, text: 'TOKEN=fixture-secret' }, host, worker)
    await expect(store.terminalResult(owner, tab, requestId)).rejects.toThrow('unavailable')
    expect(await store.terminalResult(host, tab, requestId, lead)).toEqual({ requestId, ok: true, text: 'TOKEN=fixture-secret' })
    await expect(store.terminalResult(host, tab, requestId, lead)).rejects.toThrow('unavailable')
    const history = [...(await store.messages(owner, tab, 'lead', {})).messages, ...(await store.messages(owner, tab, group, {})).messages]
    const receipts = await db.superTabOperation.findMany({ where: { tabId: tab } })
    expect(JSON.stringify([history, receipts, await store.read(owner, tab)])).not.toContain('fixture-secret')
  })

  it('logs typed input in the agent group and hands the host the text and keys', async () => {
    const { tab, worker, group, harnessId, claim } = await terminalFixture()
    const requestId = (await run(tab, { type: 'agent.input', agentId: worker, text: '/model', keys: ['Enter'] })).result.requestId as string
    expect(await claim()).toEqual([{ tabId: tab, agentId: worker, harnessId, request: { id: requestId, kind: 'input', text: '/model', keys: ['Enter'] } }])
    const rows = (await store.messages(owner, tab, group, {})).messages.filter(m => (m.source as { kind?: string } | null)?.kind === 'terminal-input')
    expect(rows.map(m => [m.text, m.recipientIds])).toEqual([[expect.stringMatching(/^owner typed `\/model` \+ Enter in .+'s terminal$/), []]])
    await run(tab, { type: 'agent.inputResult', requestId, ok: true }, host, worker)
    expect(await store.terminalResult(owner, tab, requestId)).toEqual({ requestId, ok: true })
  })

  it('fails with a plain reason when the host never picks up or never answers, and never types late', async () => {
    const { tab, lead, worker, claim } = await terminalFixture()
    const unseen = (await run(tab, { type: 'agent.screen', agentId: worker }, host, lead)).result.requestId as string
    expect(await claim(later(11_000))).toEqual([])
    expect(await store.terminalResult(host, tab, unseen, lead)).toEqual({ requestId: unseen, ok: false, error: expect.stringContaining('did not pick up') })
    const typed = (await run(tab, { type: 'agent.input', agentId: worker, keys: ['Enter'] }, host, lead)).result.requestId as string
    expect(await claim()).toHaveLength(1)
    expect(await later(31_000).terminalResult(host, tab, typed, lead)).toEqual({ requestId: typed, ok: false, error: expect.stringContaining('did not answer') })
    await expect(run(tab, { type: 'agent.inputResult', requestId: typed, ok: true }, host, worker)).rejects.toThrow('unavailable')
  })

  it('never hands the host a request for a terminal that was replaced', async () => {
    const { tab, lead, worker, claim } = await terminalFixture()
    const requestId = (await run(tab, { type: 'agent.input', agentId: worker, keys: ['Enter'] }, host, lead)).result.requestId as string
    await db.superTabTerminalRequest.update({ where: { id: requestId }, data: { harnessId: 'replaced-terminal' } })
    expect(await claim()).toEqual([])
    expect(await store.terminalResult(host, tab, requestId, lead)).toEqual({ requestId, ok: false, error: expect.stringContaining('changed') })
  })

  // Neither demotion has a command (the Lead guard keeps a project's Lead), so the state is edited the way a future one would.
  async function edit(tab: string, change: (state: SuperTabState) => void) {
    const state = await storedState(tab)
    change(state)
    await saveState(tab, state)
  }
  async function answered(tab: string, worker: string, requester: AuthUser = host, asAgentId?: string) {
    const requestId = (await run(tab, { type: 'agent.screen', agentId: worker }, requester, asAgentId)).result.requestId as string
    await store.hostTerminal(host, 'test-host')
    await run(tab, { type: 'agent.screenResult', requestId, ok: true, text: 'TOKEN=fixture-secret' }, host, worker)
    return requestId
  }

  it('gives a former Lead and a demoted person nothing, even for their own request', async () => {
    const { tab, lead, worker } = await terminalFixture()
    const asLead = await answered(tab, worker, host, lead)
    await edit(tab, state => { state.conversations.find(c => c.id === 'lead')!.leadId = null })
    await expect(store.terminalResult(host, tab, asLead, lead)).rejects.toThrow()
    await invite(tab)
    const asPeer = await answered(tab, worker, peer)
    await edit(tab, state => { state.people.find(p => p.id === peer.sub)!.role = 'viewer' })
    await expect(store.terminalResult(peer, tab, asPeer)).rejects.toThrow()
  })

  it('refuses a host answer after 30 seconds, even before the sender asked for it', async () => {
    const { tab, lead, worker, claim } = await terminalFixture()
    const requestId = (await run(tab, { type: 'agent.screen', agentId: worker }, host, lead)).result.requestId as string
    expect(await claim()).toHaveLength(1)
    await expect(later(31_000).execute(host, tab, { operationId: randomUUID(), command: { type: 'agent.screenResult', requestId, ok: true, text: 'late' } }, worker))
      .rejects.toThrow('no longer waiting')
  })

  /** A store whose terminal answers are told the way the routes tell them across instances (lib/bus.ts), here in process.
   *  `heard: false` loses every notice, as a dropped publish would. It counts the Swarm loads a wait makes. */
  function watched(options: { heard?: boolean; now?: () => number } = {}) {
    const notices = new EventEmitter()
    const at = new SuperTabStore(db, options.now ?? Date.now, null, {
      terminalAnswered: requestId => { if (options.heard !== false) notices.emit(requestId) },
      watchTerminal: async (requestId, onChange) => { notices.on(requestId, onChange); return () => { notices.off(requestId, onChange) } },
    })
    const load = vi.spyOn(at as unknown as { load: (...args: unknown[]) => unknown }, 'load')
    return { at, loads: () => load.mock.calls.length, listeners: (requestId: string) => notices.listenerCount(requestId) }
  }

  it('waits for an answer without loading the Swarm again and again', async () => {
    const { tab, lead, worker, claim } = await terminalFixture()
    const requestId = (await run(tab, { type: 'agent.screen', agentId: worker }, host, lead)).result.requestId as string
    expect(await claim()).toHaveLength(1)
    const { at, loads, listeners } = watched()
    expect(await at.terminalResult(host, tab, requestId, lead, 3_000)).toEqual({ requestId, pending: true })
    expect(loads()).toBeLessThanOrEqual(2)
    expect(listeners(requestId)).toBe(0)
  })

  it('returns the answer as soon as the host’s answer commits', async () => {
    const { tab, lead, worker, claim } = await terminalFixture()
    const requestId = (await run(tab, { type: 'agent.screen', agentId: worker }, host, lead)).result.requestId as string
    expect(await claim()).toHaveLength(1)
    const { at, loads } = watched()
    const waiting = at.terminalResult(host, tab, requestId, lead, 20_000).then(answer => ({ answer, at: Date.now() }))
    await new Promise(resolve => setTimeout(resolve, 300))
    await at.execute(host, tab, { operationId: randomUUID(), command: { type: 'agent.screenResult', requestId, ok: true, text: 'screen' } }, worker)
    const answeredAt = Date.now()
    const { answer, at: returnedAt } = await waiting
    expect(answer).toEqual({ requestId, ok: true, text: 'screen' })
    expect(returnedAt - answeredAt).toBeLessThan(100)
    expect(loads()).toBeLessThanOrEqual(4)
  })

  it('wakes a wait when the request turns late, and when the host refuses it', async () => {
    const { tab, lead, worker, claim } = await terminalFixture()
    const unseen = (await run(tab, { type: 'agent.screen', agentId: worker }, host, lead)).result.requestId as string
    // The pickup window ends 300 ms into this store's clock.
    const late = watched({ now: () => Date.now() + 9_700 })
    const started = Date.now()
    expect(await late.at.terminalResult(host, tab, unseen, lead, 20_000)).toEqual({ requestId: unseen, ok: false, error: expect.stringContaining('did not pick up') })
    expect(Date.now() - started).toBeLessThan(2_000)
    const replaced = (await run(tab, { type: 'agent.input', agentId: worker, keys: ['Enter'] }, host, lead)).result.requestId as string
    await db.superTabTerminalRequest.update({ where: { id: replaced }, data: { harnessId: 'replaced-terminal' } })
    const { at } = watched()
    const waiting = at.terminalResult(host, tab, replaced, lead, 20_000)
    await new Promise(resolve => setTimeout(resolve, 300))
    const refusedAt = Date.now()
    expect(await claim(at)).toEqual([])
    expect(await waiting).toEqual({ requestId: replaced, ok: false, error: expect.stringContaining('changed') })
    expect(Date.now() - refusedAt).toBeLessThan(1_000)
  })

  it('neither waits for nor fails on a notice channel that cannot subscribe, as while Redis is down', async () => {
    const { tab, lead, worker, claim } = await terminalFixture()
    for (const watching of [() => new Promise<() => void>(() => {}), () => Promise.reject(new Error('Redis is down'))]) {
      const at = new SuperTabStore(db, Date.now, null, { watchTerminal: watching })
      const requestId = (await run(tab, { type: 'agent.screen', agentId: worker }, host, lead)).result.requestId as string
      expect(await claim()).toHaveLength(1)
      const started = Date.now()
      expect(await at.terminalResult(host, tab, requestId, lead, 1_000)).toEqual({ requestId, pending: true })
      expect(Date.now() - started).toBeLessThan(2_000)
      await run(tab, { type: 'agent.screenResult', requestId, ok: true, text: 'screen' }, host, worker)
      expect(await at.terminalResult(host, tab, requestId, lead, 20_000)).toEqual({ requestId, ok: true, text: 'screen' })
    }
  })

  it('still returns an answer whose notice was lost, at the next re-check', async () => {
    const { tab, lead, worker, claim } = await terminalFixture()
    const requestId = (await run(tab, { type: 'agent.screen', agentId: worker }, host, lead)).result.requestId as string
    expect(await claim()).toHaveLength(1)
    const { at, loads } = watched({ heard: false })
    const waiting = at.terminalResult(host, tab, requestId, lead, 20_000)
    await new Promise(resolve => setTimeout(resolve, 300))
    await run(tab, { type: 'agent.screenResult', requestId, ok: true, text: 'screen' }, host, worker)
    const answeredAt = Date.now()
    expect(await waiting).toEqual({ requestId, ok: true, text: 'screen' })
    expect(Date.now() - answeredAt).toBeLessThan(6_000)
    expect(loads()).toBeLessThanOrEqual(3)
  })

  it('expires an unread answer after two minutes, without waiting for another request', async () => {
    const { tab, lead, worker } = await terminalFixture()
    const requestId = await answered(tab, worker, host, lead)
    await expect(later(121_000).terminalResult(host, tab, requestId, lead)).rejects.toThrow('unavailable')
    await ensureTerminalExpiry(db)
    const indexes = await db.$runCommandRaw({ listIndexes: 'SuperTabTerminalRequest' }) as { cursor: { firstBatch: Array<{ key: object; expireAfterSeconds?: number }> } }
    expect(indexes.cursor.firstBatch).toContainEqual(expect.objectContaining({ key: { createdAt: 1 }, expireAfterSeconds: TERMINAL_EXPIRY_MS / 1000 }))
  })

  it('serves the host and the requester over HTTP', async () => {
    const { tab, lead, worker } = await terminalFixture()
    const requestId = (await run(tab, { type: 'agent.screen', agentId: worker }, host, lead)).result.requestId as string
    const claimed = await app.inject({ method: 'POST', url: '/api/super-tabs/hosts/test-host/terminal', headers: { authorization: `Bearer ${host.sub}` } })
    expect(claimed.json().data.filter((row: { tabId: string }) => row.tabId === tab)).toHaveLength(1)
    await run(tab, { type: 'agent.screenResult', requestId, ok: false, error: 'The pane closed.' }, host, worker)
    const answer = await app.inject({ method: 'GET', url: `/api/super-tabs/${tab}/terminal/${requestId}?asAgentId=${lead}`, headers: { authorization: `Bearer ${host.sub}` } })
    expect(answer.json().data).toEqual({ requestId, ok: false, error: 'The pane closed.' })
  })
})

describe('Leads conversation', () => {
  it('appears in an old Swarm, lets people and Leads post, and delivers only to the other Leads', async () => {
    const { tab, lead } = await fixture()
    // A Swarm stored before the Leads conversation existed.
    const stored = await storedState(tab)
    const leads = stored.leadsConversationId!
    delete stored.leadsConversationId
    stored.conversations = stored.conversations.filter(c => c.kind !== 'leads')
    await saveState(tab, stored)
    // Clients find it without a project: by the tab's id for it and its kind.
    const read = (await store.read(owner, tab)).state
    expect(read.leadsConversationId).toBe(leads)
    const found = read.conversations.find(c => c.id === leads)!
    expect(found.kind).toBe('leads')
    expect(found).not.toHaveProperty('projectId')
    expect((await store.messages(owner, tab, leads, {})).messages).toEqual([])

    const docs = String((await run(tab, { type: 'project.create', name: 'Docs', visibility: 'public', brief: '' })).result.conversationId)
    const docsLead = (await run(tab, { type: 'agent.add', conversationId: docs, machineId: 'test-host', harnessId: randomUUID(), name: 'Docs Lead',
      configuration: config, lead: true })).result.agentId as string
    const worker = (await run(tab, { type: 'agent.add', conversationId: 'lead', machineId: 'test-host', harnessId: randomUUID(), name: 'Worker',
      configuration: config, lead: false })).result.agentId as string
    const post = (text: string, user = owner, asAgentId?: string) => store.execute(user, tab, { operationId: randomUUID(),
      command: { type: 'message.send', conversationId: leads, text, replyTo: null, recipientIds: [] } }, asAgentId)
    await post('Who goes first?')
    const waiting = async (agentId: string) => (await store.deliveries(host, tab, agentId)).filter(d => d.conversationId === leads).length
    expect([await waiting(lead), await waiting(docsLead), await waiting(worker)]).toEqual([1, 1, 0])
    await post('Pilot goes first.', host, lead)
    expect([await waiting(lead), await waiting(docsLead)]).toEqual([1, 2])
    await expect(post('Me too', host, worker)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(store.messages(host, tab, leads, {}, worker)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect((await store.messages(owner, tab, leads, {})).messages.map(m => m.text)).toEqual(['Who goes first?', 'Pilot goes first.'])
  })

  it('shows Leads the other projects\' work and posts one overlap alert for both Leads', async () => {
    const { tab, lead } = await fixture()
    const docs = String((await run(tab, { type: 'project.create', name: 'Docs', visibility: 'public', brief: '' })).result.projectId)
    const docsChat = (await store.read(owner, tab)).state.projects!.find(p => p.id === docs)!.leadConversationId
    const docsLead = (await run(tab, { type: 'agent.add', conversationId: docsChat, machineId: 'test-host', harnessId: randomUUID(), name: 'Docs Lead',
      configuration: config, lead: true })).result.agentId as string
    const task = (owns: string[]) => ({ goal: 'Polish', changes: 'Roster', constraints: 'None', owns })
    const checks = [{ description: 'Done', independent: false }]
    const roster = String((await run(tab, { type: 'conversation.create', projectId: docs, title: 'Roster', task: task(['desktop/lib/super_tabs']), checks })).result.conversationId)
    const worker = (await run(tab, { type: 'agent.add', conversationId: roster, machineId: 'test-host', harnessId: randomUUID(), name: 'Docs Worker',
      configuration: config, lead: false })).result.agentId as string
    await run(tab, { type: 'work.assign', conversationId: roster, agentId: worker })

    expect((await store.read(host, tab, lead)).state.otherProjectsWork).toEqual([expect.objectContaining({ conversationId: roster, projectName: 'Docs',
      title: 'Roster', owns: ['desktop/lib/super_tabs'], status: 'working' })])
    expect((await store.read(host, tab, worker)).state).not.toHaveProperty('otherProjectsWork')

    const filter = String((await run(tab, { type: 'conversation.create', title: 'Agents filter', task: task(['desktop/lib/super_tabs/roster.dart']), checks },
      host, lead)).result.conversationId)
    await run(tab, { type: 'work.define', conversationId: filter, task: task(['desktop/lib/super_tabs']), checks }, host, lead)
    const leads = (await store.read(owner, tab)).state.leadsConversationId!
    const alerts = (await store.messages(owner, tab, leads, {})).messages
    expect(alerts).toEqual([expect.objectContaining({ source: { kind: 'overlap', conversationIds: [filter, roster] }, recipientIds: [docsLead],
      text: expect.stringContaining('"Agents filter" (Pilot') })])
    expect((await store.deliveries(host, tab, docsLead)).filter(d => d.conversationId === leads)).toHaveLength(1)
  })
})

describe('a Swarm written by a later release', () => {
  it('keeps conversation kinds and fields it does not know unchanged through its own reads and writes', async () => {
    // Like production Swarms, no project is named 'lead', so a conversation without a project belongs to none.
    const tab = (await store.create(owner, randomUUID(), 'Rollout')).id
    await run(tab, { type: 'project.create', name: 'Pilot', visibility: 'public', brief: '' })
    await run(tab, { type: 'project.delete', projectId: 'lead' })
    type Stored = Record<string, unknown> & { conversations: Array<Record<string, unknown>>; parkedConversations?: Array<Record<string, unknown>> }
    const stored = await storedState(tab) as unknown as Stored
    const later = { id: 'later', kind: 'later-kind', title: 'From a later release', leadId: null, agentIds: [], archived: false, brief: '',
      checks: [], assignment: null, lastMessageSequence: 0, laterField: { nested: [1] } }
    const chat = stored.conversations.find(c => c.kind !== 'leads')!
    stored.laterField = { kept: true }
    chat.laterField = 'kept'
    stored.conversations.push(later)
    await saveState(tab, stored as unknown as SuperTabState)

    expect((await store.read(owner, tab)).state.conversations.map(c => c.id)).toEqual([chat.id, stored.leadsConversationId])
    await run(tab, { type: 'message.send', conversationId: chat.id as string, text: 'Still writable', replyTo: null, recipientIds: [] })
    expect((await store.messages(owner, tab, chat.id as string, {})).messages.map(m => m.text)).toEqual(['Still writable'])
    await expect(store.messages(owner, tab, 'later', {})).rejects.toMatchObject({ code: 'NOT_FOUND' })
    const written = await storedState(tab) as unknown as Stored
    expect(written.laterField).toEqual({ kept: true })
    expect(written.conversations.find(c => c.id === chat.id)!.laterField).toBe('kept')
    // A later release, which knows the kind, puts it back from here.
    expect(written.parkedConversations).toEqual([later])
  })

  it('never gives a new conversation the number of a conversation it set aside', async () => {
    const tab = (await store.create(owner, randomUUID(), 'Rollout numbers')).id
    const stored = await storedState(tab)
    stored.conversations.push({ id: 'later', kind: 'later-kind' as never, number: 7, title: 'From a later release', leadId: null, agentIds: [],
      archived: false, brief: '', checks: [], assignment: null, lastMessageSequence: 0 })
    delete stored.groupCounter
    await saveState(tab, stored)
    const created = String((await run(tab, { type: 'conversation.create', title: 'New work', brief: '', checks: [] })).result.conversationId)
    expect((await store.read(owner, tab)).state.conversations.find(c => c.id === created)!.number).toBe(8)
  })
})

describe('machine removal', () => {
  const day = 24 * 3_600_000
  async function contributed() {
    const tab = (await store.create(owner, randomUUID(), 'Remove')).id
    const invitation = await run(tab, { type: 'invite.create', email: host.email, role: 'collaborator', conversationId: 'lead' })
    await run(tab, { type: 'invite.accept', inviteId: invitation.result.inviteId as string }, host)
    await run(tab, { type: 'machine.contribute', machineId: 'test-host', name: 'Host', cwd: '/fixture/repo', engines: ['codex'], maxAgents: 4 }, host)
    // Its host is here and reporting, so removing it waits for that host to acknowledge.
    const machine = (await poolRows(store, host, 'test-host')).find(pool => pool.tabId === tab)!.machine
    await store.observeMachine(host, tab, 'test-host', { generation: machine.generation,
      resources: { cpuPercent: 10, memoryTotalBytes: 32e9, memoryUsedBytes: 4e9, diskFreeBytes: 120e9, diskTotalBytes: 500e9,
        projectDiskFreeBytes: 120e9, deviceType: 'Laptop', chip: 'Fixture', os: 'macOS', gpuPercent: null },
      quotas: [], tools: {}, runningHarnessIds: [], stoppedHarnessIds: [] })
    return tab
  }
  const cleanups = async (tab: string, from = store) => (await rosterRows(from, host, 'test-host')).filter(r => r.tabId === tab && 'cleanup' in r)
  const cleaned = (tab: string, removalId: string) => app.inject({ method: 'POST', url: `/api/super-tabs/${tab}/commands`, headers: { authorization: `Bearer ${host.sub}` },
    payload: { operationId: randomUUID(), command: { type: 'machine.cleaned', machineId: 'test-host', removalId } } })

  it('previews the removal for the machine owner only, then lists a cleanup to its host until the host says it cleaned up', async () => {
    const tab = await contributed()
    const worker = (await run(tab, { type: 'agent.add', conversationId: 'lead', machineId: 'test-host', harnessId: randomUUID(),
      name: 'Worker', configuration: config, lead: false }, host)).result.agentId as string
    const preview = (user: AuthUser) => app.inject({ method: 'GET', url: `/api/super-tabs/${tab}/machines/test-host/removal`, headers: { authorization: `Bearer ${user.sub}` } })
    const shown = await preview(host)
    expect(shown.statusCode, shown.body).toBe(200)
    expect(shown.json().data).toEqual({ blockedBy: null, agents: [{ id: worker, name: 'Worker', projectName: 'Remove' }], soleSourceProjects: [] })
    expect((await preview(owner)).statusCode).toBe(403)
    await expect(run(tab, { type: 'machine.remove', machineId: 'test-host' })).rejects.toMatchObject({ code: 'FORBIDDEN' })

    const removalId = (await run(tab, { type: 'machine.remove', machineId: 'test-host' }, host)).result.removalId as string
    expect((await store.read(owner, tab)).state.machines!.map(m => [m.removal?.state, m.paused])).toEqual([['cleaning', true]])
    expect(await cleanups(tab)).toEqual([{ tabId: tab, cleanup: { machineId: 'test-host', removalId } }])
    expect((await rosterRows(store, host, 'test-host')).filter(r => r.tabId === tab && r.agent?.id === worker && 'closeSession' in r)).toHaveLength(1)
    expect((await rosterRows(store, owner, 'test-host').catch(() => []))).toEqual([])
    // The machine owner's host acknowledges even after leaving the Swarm.
    await run(tab, { type: 'member.remove', userId: host.sub }, host)
    expect((await cleaned(tab, 'not-this-one')).statusCode).toBe(404)
    const ack = await cleaned(tab, removalId)
    expect(ack.statusCode, ack.body).toBe(200)
    expect(await cleanups(tab)).toEqual([])
    expect((await store.read(owner, tab)).state.machines).toEqual([])
  })

  it('drops a machine that went silent while cleaning, and a reconnecting host gets that cleanup once before its ack', async () => {
    const tab = await contributed()
    const generation = (await poolRows(store, host, 'test-host')).find(pool => pool.tabId === tab)!.machine.generation
    const removalId = (await run(tab, { type: 'machine.remove', machineId: 'test-host' }, host)).result.removalId as string
    // Its host goes silent for longer than three beats: a read leaves the machine out, but its stored removal is still there.
    const later = new SuperTabStore(db, () => Date.now() + 60_000)
    const stored = () => storedState(tab)
    expect((await later.read(owner, tab)).state.machines).toEqual([])
    expect((await stored()).machines!.map(m => m.removal?.id)).toEqual([removalId])
    // It reconnects and reports before acknowledging: that reading must not bring the machine back as cleaning.
    await later.observeMachine(host, tab, 'test-host', { generation,
      resources: { cpuPercent: 10, memoryTotalBytes: 32e9, memoryUsedBytes: 4e9, diskFreeBytes: 120e9, diskTotalBytes: 500e9,
        projectDiskFreeBytes: 120e9, deviceType: 'Laptop', chip: 'Fixture', os: 'macOS', gpuPercent: null },
      quotas: [], tools: {}, runningHarnessIds: [], stoppedHarnessIds: [] })
    expect((await later.read(owner, tab)).state.machines).toEqual([])
    expect((await stored()).machines).toEqual([])
    // One cleanup, not one per poll.
    expect(await cleanups(tab, later)).toEqual([{ tabId: tab, cleanup: { machineId: 'test-host', removalId } }])
    expect(await cleanups(tab, later)).toEqual([{ tabId: tab, cleanup: { machineId: 'test-host', removalId } }])
    // A delayed acknowledgement closes it; a second, late one finds nothing left to undo.
    await later.execute(host, tab, { operationId: randomUUID(), command: { type: 'machine.cleaned', machineId: 'test-host', removalId } })
    expect(await cleanups(tab, later)).toEqual([])
    expect((await stored()).machineCleanups).toBeUndefined()
    const late = await app.inject({ method: 'POST', url: `/api/super-tabs/${tab}/commands`, headers: { authorization: `Bearer ${host.sub}` },
      payload: { operationId: randomUUID(), command: { type: 'machine.cleaned', machineId: 'test-host', removalId } } })
    expect(late.statusCode).toBe(404)
  })

  it('lists a pending cleanup to its host even when the machine is in more than the 100 Swarms a host poll reads', async () => {
    const tab = await contributed()
    const removalId = (await run(tab, { type: 'machine.remove', machineId: 'test-host' }, host)).result.removalId as string
    const newer = await Promise.all(Array.from({ length: 101 }, async () => (await store.create(owner, randomUUID(), 'Newer')).id))
    await db.superTab.updateMany({ where: { id: { in: newer } }, data: { machineIds: ['test-host'] } })
    try {
      expect(await cleanups(tab)).toEqual([{ tabId: tab, cleanup: { machineId: 'test-host', removalId } }])
      expect((await cleaned(tab, removalId)).statusCode).toBe(200)
    } finally { await db.superTab.deleteMany({ where: { id: { in: newer } } }) }
  })

  it('cleans up the machines of a person who leaves the Swarm, the same way as removing one', async () => {
    const tab = await contributed()
    const worker = (await run(tab, { type: 'agent.add', conversationId: 'lead', machineId: 'test-host', harnessId: randomUUID(),
      name: 'Worker', configuration: config, lead: false }, host)).result.agentId as string
    await run(tab, { type: 'member.remove', userId: host.sub }, host)
    const [row] = await cleanups(tab)
    expect(row).toEqual({ tabId: tab, cleanup: { machineId: 'test-host', removalId: expect.any(String) } })
    expect((await rosterRows(store, host, 'test-host')).filter(r => r.tabId === tab && r.agent?.id === worker && 'closeSession' in r)).toHaveLength(1)
    expect((await store.read(owner, tab)).state.machines!.map(m => m.removal?.state)).toEqual(['cleaning'])
    expect((await cleaned(tab, (row as { cleanup: { removalId: string } }).cleanup.removalId)).statusCode).toBe(200)
    expect(await cleanups(tab)).toEqual([])
    expect((await store.read(owner, tab)).state.machines).toEqual([])
  })

  it('drops the machine\'s records after 24 hours without an acknowledgement, and still lists the cleanup to its host', async () => {
    const tab = await contributed()
    const removalId = (await run(tab, { type: 'machine.remove', machineId: 'test-host' }, host)).result.removalId as string
    const later = new SuperTabStore(db, () => Date.now() + day)
    expect((await later.read(owner, tab)).state.machines).toEqual([])
    await later.execute(owner, tab, { operationId: randomUUID(), command: { type: 'tab.rename', name: 'A day later' } })
    const stored = await storedState(tab)
    expect([stored.machines ?? [], stored.machineCleanups]).toEqual([[], [{ machineId: 'test-host', removalId, machineOwnerId: host.sub, requestedAt: expect.any(String) }]])
    expect(await cleanups(tab, later)).toEqual([{ tabId: tab, cleanup: { machineId: 'test-host', removalId } }])
    await later.execute(host, tab, { operationId: randomUUID(), command: { type: 'machine.cleaned', machineId: 'test-host', removalId } })
    expect(await cleanups(tab, later)).toEqual([])
    expect((await storedState(tab)).machineCleanups).toBeUndefined()
  })
})

describe('Lead mentions', () => {
  const DAY = 24 * 60 * 60_000
  async function tagged(role: 'collaborator' | 'viewer' = 'collaborator') {
    const { tab, lead } = await fixture()
    await invite(tab, role)
    const group = (await run(tab, { type: 'conversation.create', title: 'Copy review', brief: '', checks: [] })).result.conversationId as string
    await run(tab, { type: 'conversation.agent', conversationId: group, agentId: lead, present: true, lead: true })
    const text = `Please confirm the welcome copy. ${'x'.repeat(300)}`
    const messageId = (await run(tab, { type: 'message.send', conversationId: group, text, replyTo: null, recipientIds: [], mentions: [peer.sub] },
      host, lead)).result.messageId as string
    return { tab, lead, group, text, messageId }
  }
  const list = async (tab: string, user: AuthUser, state: 'waiting' | 'earlier') => {
    const response = await app.inject({ method: 'GET', url: `/api/super-tabs/${tab}/mentions?state=${state}`, headers: { authorization: `Bearer ${user.sub}` } })
    expect(response.statusCode, response.body).toBe(200)
    return response.json().data.mentions as Array<Record<string, unknown>>
  }
  const waiting = async (tab: string, user: AuthUser, reader = store) => (await reader.read(user, tab)).state as SuperTabState & { mentionsWaiting?: number }

  it('lists a tag only for the tagged person, with the message, and counts it on their state alone', async () => {
    const { tab, lead, group, text, messageId } = await tagged()
    const [mention, ...rest] = await list(tab, peer, 'waiting')
    expect(rest).toEqual([])
    expect(mention).toEqual({ id: expect.any(String), projectId: 'lead', projectName: 'Pilot', conversationId: group, conversationTitle: 'Copy review',
      messageId, leadId: lead, leadName: expect.any(String), text: text.slice(0, 200), createdAt: expect.any(String), resolvedAt: null, resolvedBy: null })
    expect(mention!.leadName).toBe((await waiting(tab, owner)).agents.find(a => a.id === lead)!.displayName)
    expect(await list(tab, owner, 'waiting')).toEqual([])
    expect(await list(tab, peer, 'earlier')).toEqual([])
    expect((await waiting(tab, peer)).mentionsWaiting).toBe(1)
    expect((await waiting(tab, owner)).mentionsWaiting).toBe(0)
    expect((await store.read(host, tab, lead)).state).not.toHaveProperty('mentionsWaiting')
    expect((await store.messages(owner, tab, group, {})).messages.find(m => m.id === messageId)!.mentions).toEqual([peer.sub])
  })

  it('resolves on the person’s later post in that conversation, not on anyone else’s', async () => {
    const { tab, group } = await tagged()
    await run(tab, { type: 'message.send', conversationId: group, text: 'Owner chimes in.', replyTo: null, recipientIds: [] })
    await run(tab, { type: 'message.send', conversationId: 'lead', text: 'Elsewhere.', replyTo: null, recipientIds: [] }, peer)
    expect(await list(tab, peer, 'waiting')).toHaveLength(1)
    await run(tab, { type: 'message.send', conversationId: group, text: 'Looks good.', replyTo: null, recipientIds: [] }, peer)
    expect(await list(tab, peer, 'waiting')).toEqual([])
    expect(await list(tab, peer, 'earlier')).toEqual([expect.objectContaining({ resolvedBy: 'reply', resolvedAt: expect.any(String) })])
    expect((await waiting(tab, peer)).mentionsWaiting).toBe(0)
  })

  it('resolves on the person’s reply inside a thread', async () => {
    const { tab, group, messageId } = await tagged()
    await run(tab, { type: 'message.send', conversationId: group, text: 'Confirmed.', replyTo: messageId, recipientIds: [] }, peer)
    expect(await list(tab, peer, 'waiting')).toEqual([])
    expect(await list(tab, peer, 'earlier')).toEqual([expect.objectContaining({ messageId, resolvedBy: 'reply' })])
  })

  it('counts a tag in a conversation gone quiet, as the list shows it, on every read, and never once the person cannot read it', async () => {
    const { tab, lead, group } = await tagged()
    const other = (await run(tab, { type: 'conversation.create', title: 'Pricing page', brief: '', checks: [] })).result.conversationId as string
    await run(tab, { type: 'conversation.agent', conversationId: other, agentId: lead, present: true, lead: true })
    await run(tab, { type: 'message.send', conversationId: other, text: 'Check the prices.', replyTo: null, recipientIds: [], mentions: [peer.sub] }, host, lead)
    // Ordinary loads no longer read it (sweeps.ts puts quiet conversations to sleep).
    await db.swarmGroup.updateMany({ where: { tabId: tab, key: group }, data: { dormant: true } })
    const derived = async (url: string) => {
      const response = await app.inject({ method: 'GET', url: `/api/super-tabs/${tab}/${url}`, headers: { authorization: `Bearer ${peer.sub}` } })
      expect(response.statusCode, response.body).toBe(200)
      return response.json().data as { cursor: string; derived: { mentionsWaiting?: number } }
    }
    const first = await derived('parts')
    expect((await list(tab, peer, 'waiting')).map(m => m.conversationId).sort()).toEqual([group, other].sort())
    expect(first.derived.mentionsWaiting).toBe(2)
    expect((await derived(`changes?cursor=${first.cursor}`)).derived.mentionsWaiting).toBe(2)
    expect((await waiting(tab, peer)).mentionsWaiting).toBe(2)
    await run(tab, { type: 'project.sharing', projectId: 'lead', visibility: 'private', memberIds: [] })
    expect(await db.swarmGroup.findFirst({ where: { tabId: tab, key: group }, select: { dormant: true } })).toEqual({ dormant: true })
    expect(await list(tab, peer, 'waiting')).toEqual([])
    expect((await derived('parts')).derived.mentionsWaiting).toBe(0)
    expect((await waiting(tab, peer)).mentionsWaiting).toBe(0)
  })

  it('lets a tagged viewer mark it done', async () => {
    const { tab } = await tagged('viewer')
    const [mention] = await list(tab, peer, 'waiting')
    await run(tab, { type: 'mention.done', mentionId: mention!.id as string }, peer)
    expect(await list(tab, peer, 'earlier')).toEqual([expect.objectContaining({ id: mention!.id, resolvedBy: 'done' })])
    expect((await waiting(tab, peer)).mentionsWaiting).toBe(0)
  })

  it('resolves when the person marks it done, and nobody else can', async () => {
    const { tab } = await tagged()
    const [mention] = await list(tab, peer, 'waiting')
    const done: Command = { type: 'mention.done', mentionId: mention!.id as string }
    await expect(run(tab, done)).rejects.toThrow('This mention is unavailable.')
    const operationId = randomUUID()
    await run(tab, done, peer, undefined, operationId)
    await run(tab, done, peer, undefined, operationId)
    expect(await list(tab, peer, 'waiting')).toEqual([])
    expect(await list(tab, peer, 'earlier')).toEqual([expect.objectContaining({ id: mention!.id, resolvedBy: 'done' })])
  })

  it('drops a tag 30 days after it was made and from a conversation the person can no longer read', async () => {
    const { tab } = await tagged()
    const later = new SuperTabStore(db, () => Date.now() + 30 * DAY + 1000)
    expect((await waiting(tab, peer, later)).mentionsWaiting).toBe(0)
    expect((await waiting(tab, peer)).mentionsWaiting).toBe(1)
    await run(tab, { type: 'project.sharing', projectId: 'lead', visibility: 'private', memberIds: [] })
    expect(await list(tab, peer, 'waiting')).toEqual([])
    expect((await waiting(tab, peer)).mentionsWaiting).toBe(0)
    await ensureMentionExpiry(db)
    const indexes = await db.$runCommandRaw({ listIndexes: 'SuperTabMention' }) as { cursor: { firstBatch: Array<{ key: object; expireAfterSeconds?: number }> } }
    expect(indexes.cursor.firstBatch).toContainEqual(expect.objectContaining({ key: { createdAt: 1 }, expireAfterSeconds: MENTION_EXPIRY_MS / 1000 }))
  })

  it('keeps the stored tab and older messages as the previous backend reads and writes them', async () => {
    const { tab, group } = await tagged()
    const stored = await storedState(tab)
    expect(JSON.stringify(stored)).not.toMatch(/mention/i)
    // A message the previous backend wrote has no mentions field; its next post omits mentions too.
    await db.$runCommandRaw({ insert: 'SuperTabMessage', documents: [{ _id: 'old-backend-row', tabId: tab, conversationId: group, sequence: 1,
      author: { kind: 'person', id: owner.sub, name: owner.email, membershipGeneration: tab }, text: 'Written before mentions.',
      replyTo: null, recipientIds: [], createdAt: { $date: new Date().toISOString() } }] })
    await run(tab, { type: 'message.send', conversationId: group, text: 'Old shape.', replyTo: null, recipientIds: [] })
    const rows = (await store.messages(owner, tab, group, {})).messages
    expect(rows.find(m => m.id === 'old-backend-row')!.mentions).toEqual([])
    expect(rows.at(-1)!.mentions).toEqual([])
  })
})

describe('leaderboard credits written by the store (leaderboard/record.ts)', () => {
  const unblocks = async (tab: string, group: string) => (await storedState(tab)).conversations.find(c => c.id === group)!.ledger?.unblocks ?? []

  it('credits a reply to a Lead\'s tag once, as a tag reply', async () => {
    const { tab, lead } = await fixture()
    await invite(tab)
    const group = (await run(tab, { type: 'conversation.create', title: 'Copy review', brief: '', checks: [] })).result.conversationId as string
    await run(tab, { type: 'conversation.agent', conversationId: group, agentId: lead, present: true, lead: true })
    const tag = (await run(tab, { type: 'message.send', conversationId: group, text: 'Confirm the copy?', replyTo: null, recipientIds: [], mentions: [peer.sub] },
      host, lead)).result.messageId as string
    await run(tab, { type: 'message.send', conversationId: group, text: 'Confirmed.', replyTo: null, recipientIds: [] }, peer)
    await run(tab, { type: 'message.send', conversationId: group, text: 'One more thing.', replyTo: null, recipientIds: [] }, peer)
    expect(await unblocks(tab, group)).toEqual([{ personId: peer.sub, at: expect.any(Number), waitedMs: expect.any(Number), kind: 'tag_reply', item: tag }])
  })

  it('credits "Duyệt" in reply to the Lead\'s ask as an approval, in the Lead conversation', async () => {
    const { tab, lead } = await fixture()
    const ask = (await run(tab, { type: 'message.send', conversationId: 'lead', text: 'Plan: three steps. GO?', replyTo: null, recipientIds: [] }, host, lead))
      .result.messageId as string
    await run(tab, { type: 'message.send', conversationId: 'lead', text: 'Duyệt nhé', replyTo: ask, recipientIds: [] })
    expect(await unblocks(tab, 'lead')).toEqual([expect.objectContaining({ personId: owner.sub, kind: 'approval', item: ask })])
  })

  it('credits the person asked for their decision answer', async () => {
    const { tab, lead } = await fixture()
    await invite(tab)
    const asked = await run(tab, { type: 'decision.ask', conversationId: 'lead', personId: peer.sub,
      questions: [{ question: 'Ship how?', options: ['Behind a flag', 'To everyone'], recommended: 0, unblocks: 'The release' }] }, host, lead)
    const decisionId = (asked.result.decisionIds as string[])[0]!
    await run(tab, { type: 'decision.answer', decisionId, choice: 1 }, peer)
    expect(await unblocks(tab, 'lead')).toEqual([expect.objectContaining({ personId: peer.sub, kind: 'decision', item: decisionId })])
  })

  it('credits a worker\'s question asked again after it moved on once, when its decision is answered', async () => {
    const { tab } = await fixture()
    await invite(tab)
    const group = (await run(tab, { type: 'conversation.create', title: 'Release', brief: 'Ship it.', checks: [{ description: 'Shipped.', independent: false }] })).result.conversationId as string
    const worker = (await run(tab, { type: 'agent.add', conversationId: group, machineId: 'test-host', harnessId: randomUUID(),
      name: 'Builder', configuration: config, lead: false })).result.agentId as string
    const assignmentId = (await run(tab, { type: 'work.assign', conversationId: group, agentId: worker })).result.assignmentId as string
    const ask = { type: 'work.status', conversationId: group, assignmentId, status: 'needs_human', result: 'Ship how?',
      ask: { personId: peer.sub, options: ['Behind a flag', 'To everyone'], recommended: 0, unblocks: 'The release' } } as Command
    await run(tab, ask, host, worker)
    await run(tab, { type: 'work.status', conversationId: group, assignmentId, status: 'working', result: null } as Command, host, worker)
    await run(tab, ask, host, worker)
    const [decision] = await db.superTabDecision.findMany({ where: { tabId: tab } })
    await run(tab, { type: 'decision.answer', decisionId: decision!.id, choice: 0 }, peer)
    // The requester's next post answers nothing more: the repeated question was that decision again.
    await run(tab, { type: 'message.send', conversationId: group, text: 'Behind a flag, then.', replyTo: null, recipientIds: [] })
    expect(await unblocks(tab, group)).toEqual([expect.objectContaining({ personId: peer.sub, kind: 'decision', item: decision!.id })])
  })
})

describe('credentials in Swarm chat', () => {
  // Assembled at run time from obviously fake parts, never a credential-shaped literal.
  const jwt = [{ alg: 'HS256', typ: 'JWT' }, { sub: 'fixture-user' }].map(part => Buffer.from(JSON.stringify(part)).toString('base64url'))
    .concat('Fixture0Signature1Not2Real3Value4abcdefgh').join('.')
  const github = ['ghp', 'Fixture0Token1Not2Real3Value4abcdefgh'].join('_')
  const pasted = `My Harness login: ${jwt} and the deploy token ${github}. Can the Lead use them?`
  const kept = `My Harness login: [credential removed] and the deploy token [credential removed]. Can the Lead use them?`
  const notice = 'Removed 2 credentials (JWT, GitHub token) before saving. Revoke or rotate them.'
  /** Everything stored for the tab, besides a terminal request (whose host must type exactly what was sent). */
  const stored = async (tab: string) => JSON.stringify(await Promise.all([
    db.superTab.findMany({ where: { id: tab } }), storedState(tab), db.superTabMessage.findMany({ where: { tabId: tab } }),
    db.superTabOperation.findMany({ where: { tabId: tab } }), db.superTabDelivery.findMany({ where: { tabId: tab } }),
    db.superTabAttempt.findMany({ where: { tabId: tab } }), db.superTabRouteDecision.findMany({ where: { tabId: tab } }),
  ]))
  /** Every line the process writes while `body` runs: console and the raw streams the logger could reach. */
  async function written(body: () => Promise<void>): Promise<string> {
    const lines: string[] = []
    const keep = (...args: unknown[]) => { lines.push(args.map(arg => typeof arg === 'string' ? arg : JSON.stringify(arg)).join(' ')) }
    const spies = [...(['log', 'info', 'warn', 'error', 'debug'] as const).map(method => vi.spyOn(console, method).mockImplementation(keep)),
      vi.spyOn(process.stdout, 'write').mockImplementation(chunk => { keep(String(chunk)); return true }),
      vi.spyOn(process.stderr, 'write').mockImplementation(chunk => { keep(String(chunk)); return true })]
    try { await body() } finally { for (const spy of spies) spy.mockRestore() }
    return lines.join('\n')
  }

  it('stores and delivers a person\'s message without the credentials, tells the sender, logs neither, and replays the same receipt', async () => {
    const { tab, lead } = await fixture()
    const operationId = randomUUID()
    const post = (text: string) => app.inject({ method: 'POST', url: `/api/super-tabs/${tab}/commands`,
      headers: { authorization: `Bearer ${owner.sub}` }, payload: { operationId, command: message(text) } })
    let answer: { revision: number; result: Record<string, unknown> } | undefined
    const output = await written(async () => {
      const first = await post(pasted)
      expect(first.statusCode, first.body).toBe(200)
      answer = first.json().data
      expect(answer!.result).toEqual({ messageId: expect.any(String), credentialNotice: notice,
        credentialsRemoved: [{ kind: 'jwt', label: 'JWT', count: 1 }, { kind: 'github', label: 'GitHub token', count: 1 }] })
      // A retry of the same operation answers its receipt, notice included, and writes nothing more.
      const before = (await store.messages(owner, tab, 'lead', {})).messages.length
      const again = await post(pasted)
      expect(again.statusCode, again.body).toBe(200)
      expect(again.json().data).toEqual(answer)
      expect((await store.messages(owner, tab, 'lead', {})).messages).toHaveLength(before)
      // The receipt is still bound to what was sent: other words under the same operation are refused, as before.
      const reused = await post('Something else entirely.')
      expect([reused.statusCode, reused.json().error.code]).toEqual([409, 'OPERATION_REUSED'])
    })
    const row = (await store.messages(owner, tab, 'lead', { messageId: answer!.result.messageId as string })).messages[0]!
    expect(row.text).toBe(kept)
    const deliveries = await db.superTabDelivery.findMany({ where: { tabId: tab, messageId: row.id } })
    expect(deliveries.map(d => d.agentId)).toEqual([lead])
    const everything = await stored(tab)
    for (const secret of [jwt, github]) {
      expect(everything).not.toContain(secret)
      expect(output).not.toContain(secret)
    }
  })

  it('treats an agent\'s post the same, and a native terminal transcript too', async () => {
    const { tab, lead } = await fixture()
    const posted = await run(tab, message(`gh auth status printed ${github}`), host, lead)
    expect(posted.result.credentialNotice).toBe('Removed a credential (GitHub token) before saving. Revoke or rotate it.')
    expect((await store.messages(owner, tab, 'lead', { messageId: posted.result.messageId as string })).messages[0]!.text)
      .toBe('gh auth status printed [credential removed]')
    const group = (await run(tab, { type: 'conversation.create', title: 'Release', brief: 'Ship it',
      checks: [{ description: 'Shipped', independent: false }] })).result.conversationId as string
    const worker = (await run(tab, { type: 'agent.add', conversationId: group, machineId: 'test-host', harnessId: randomUUID(),
      name: 'Release Engineer', configuration: config, lead: false })).result.agentId as string
    const { contextId } = await store.native.open(owner, tab, { operationId: randomUUID(), conversationId: group, agentId: worker })
    const prompt = { turnId: 'pasted_turn', kind: 'prompt' as const, previousEventId: null, text: `use this: ${jwt}`, truncated: false, interrupted: false }
    const output = await written(async () => {
      const recorded = await store.native.append(host, tab, contextId, prompt) as { eventId: string }
      expect((await db.superTabMessage.findUniqueOrThrow({ where: { id: recorded.eventId } })).text).toBe('use this: [credential removed]')
      expect(await store.native.append(host, tab, contextId, prompt)).toEqual(recorded)
    })
    const everything = await stored(tab)
    for (const secret of [jwt, github]) {
      expect(everything).not.toContain(secret)
      expect(output).not.toContain(secret)
    }
  })
})

describe('Swarm parts storage', () => {
  /** A Swarm born in parts at version 1, with one dormant group and one finished start. */
  async function stored() {
    const tabId = `parts-${randomUUID()}`
    const state = (await import('../src/superTabs/model.js')).createSuperTab(tabId, 'Parts', { id: owner.sub, email: owner.email }, 'prod')
    state.conversations.push({ id: 'quiet', projectId: 'lead', number: 1, title: 'Quiet', leadId: null, agentIds: ['a1'], archived: false,
      brief: '', checks: [], assignment: null, lastMessageSequence: 0, dormant: true })
    state.agents.push({ id: 'a1', machineId: 'm1', harnessId: 'h1', machineOwnerId: host.sub, contributorId: owner.sub, membershipGeneration: tabId,
      name: 'A', configuration: config })
    const request = { conversationId: 'lead', machineId: 'm1', engine: 'codex', name: 'B', cwd: '/w', worktree: false,
      requirements: { memoryBytes: 0, diskBytes: 0, maxCpuPercent: 100, tools: [], devices: [], quotaRequired: false } }
    const start = { creationId: 'c', actorKey: 'person:x', contributorId: owner.sub, membershipGeneration: tabId, machineOwnerId: host.sub,
      hostGrant: null, request, dispatched: true, error: null }
    state.starts = [{ ...start, id: 'running', harnessId: null }, { ...start, id: 'done', harnessId: 'h1' }]
    await db.$transaction(tx => parts.insertParts(tx, parts.split(state, { tabId, version: 1, now: Date.now() - 60_000 })))
    return tabId
  }

  it('writes a part only at the version it was read; a writer that read an older version conflicts and retries', async () => {
    const tabId = await stored()
    const head = (await db.$transaction(tx => parts.loadActive(tx, tabId))).head
    await db.$transaction(tx => guardedWrite(tx, tabId, { op: 'update', kind: 'head', key: 'head', seen: head.version,
      data: { ...head.data!, name: 'Renamed' } }, Date.now()))
    const stale = db.$transaction(tx => guardedWrite(tx, tabId, { op: 'update', kind: 'head', key: 'head', seen: head.version,
      data: { ...head.data!, name: 'Lost' } }, Date.now()))
    await expect(stale).rejects.toBeInstanceOf(PartConflict)
    await expect(stale).rejects.toMatchObject({ code: 'P2034' })
    const after = (await db.$transaction(tx => parts.loadActive(tx, tabId))).head
    expect(after).toMatchObject({ version: head.version + 1, data: { name: 'Renamed' } })
  })

  it('moves the version on a touch but leaves the data and the change time', async () => {
    const tabId = await stored()
    const before = (await db.$transaction(tx => parts.loadActive(tx, tabId))).agents[0]!
    await db.$transaction(tx => guardedWrite(tx, tabId, { op: 'touch', kind: 'agent', key: 'a1', seen: before.version }, Date.now()))
    const after = (await db.$transaction(tx => parts.loadActive(tx, tabId))).agents[0]!
    expect(after).toEqual({ ...before, version: before.version + 1 })
  })

  it('keeps a removed part as a tombstone with its last data, and a part added again continues from its version', async () => {
    const tabId = await stored()
    const agent = (await db.$transaction(tx => parts.loadActive(tx, tabId))).agents[0]!
    await db.$transaction(tx => guardedWrite(tx, tabId, { op: 'remove', kind: 'agent', key: 'a1', seen: agent.version, data: agent.data! }, Date.now()))
    expect((await db.$transaction(tx => parts.loadActive(tx, tabId))).agents).toEqual([])
    const since = new Date(Date.now() - 1_000)
    const changed = (await db.$transaction(tx => parts.loadChanged(tx, [tabId], since))).get(tabId)!
    expect(changed.find(p => p.kind === 'agent')).toMatchObject({ key: 'a1', deleted: true, data: { name: 'A' } })
    await db.$transaction(tx => guardedWrite(tx, tabId, { op: 'insert', kind: 'agent', key: 'a1', data: { ...agent.data!, name: 'Again' }, ordinal: 5 }, Date.now()))
    expect((await db.$transaction(tx => parts.loadActive(tx, tabId))).agents[0]).toMatchObject({ version: agent.version + 2, data: { name: 'Again' } })
  })

  it('loads dormant groups and finished starts only when a command names them', async () => {
    const tabId = await stored()
    const active = await db.$transaction(tx => parts.loadActive(tx, tabId))
    expect(active.groups.map(p => p.key)).not.toContain('quiet')
    expect(active.starts.map(p => p.key)).toEqual(['running'])
    const named = await db.$transaction(tx => parts.loadActive(tx, tabId, { groupIds: ['quiet'], startIds: ['done'] }))
    expect(named.groups.find(p => p.key === 'quiet')).toMatchObject({ dormant: true })
    expect(named.starts.map(p => p.key).sort()).toEqual(['done', 'running'])
    const firstLoad = await db.$transaction(tx => parts.loadActive(tx, tabId, { includeRecentStarts: true }))
    expect(firstLoad.starts.map(p => p.key).sort()).toEqual(['done', 'running'])
    expect((await db.$transaction(tx => parts.loadActive(tx, tabId, { agentIds: ['a1'] }))).groups.map(p => p.key)).toContain('quiet')
    expect((await db.$transaction(tx => parts.loadDormant(tx, tabId, {}))).map(p => p.key)).toEqual(['quiet'])
    expect((await db.$transaction(tx => parts.loadAll(tx, tabId))).groups.map(p => p.key)).toContain('quiet')
  })

  it('refuses to write a part over 4 MiB and writes nothing of that command', async () => {
    const tabId = await stored()
    const row = await db.superTab.findFirstOrThrow({ where: { id: tabId } }).catch(() => null)
    const loaded = await db.$transaction(tx => parts.loadActive(tx, tabId))
    const state = parts.reassemble(loaded)
    const next = structuredClone(state)
    next.name = 'Renamed'
    next.conversations.find(c => c.id === 'lead')!.brief = 'x'.repeat(4 * 1024 * 1024 + 1)
    const { commitParts } = await import('../src/superTabs/parts/commit.js')
    await expect(db.$transaction(tx => commitParts(tx, { parts: loaded, state, row: row ?? { id: tabId, revision: 0 } }, next, { stamp: Date.now() })))
      .rejects.toMatchObject({ code: 'PART_TOO_LARGE', status: 413 })
    expect((await db.$transaction(tx => parts.loadActive(tx, tabId))).head.data!.name).toBe('Parts')
  })

  it('names the newest data change of each Swarm', async () => {
    const tabId = await stored()
    const before = (await db.$transaction(tx => parts.lastChangedAt(tx, [tabId]))).get(tabId)!
    const head = (await db.$transaction(tx => parts.loadActive(tx, tabId))).head
    const stamp = Date.now()
    await db.$transaction(tx => guardedWrite(tx, tabId, { op: 'update', kind: 'head', key: 'head', seen: head.version, data: head.data! }, stamp))
    expect((await db.$transaction(tx => parts.lastChangedAt(tx, [tabId]))).get(tabId)).toBe(stamp)
    expect(stamp).toBeGreaterThan(before)
  })
})

describe('a closed Chat with PM through the store (Buddies replaced it, 10-29)', () => {
  it('is never opened again, by a person or the PM', async () => {
    const { tab, lead } = await fixture()
    await invite(tab)
    const open = { type: 'conversation.create' as const, title: 'Peer and PM', brief: '', checks: [], audience: { personIds: [peer.sub] } }
    await expect(run(tab, open, peer)).rejects.toMatchObject({ code: 'PM_CHAT_CLOSED' })
    await expect(run(tab, { ...open, brief: 'Talk', checks: [{ description: 'Talked', independent: false }] }, host, lead)).rejects.toMatchObject({ code: 'PM_CHAT_CLOSED' })
  })

  it('is out of everyone\'s reads and messages, its person\'s and the PM\'s included, takes no post, and stays stored', async () => {
    const { tab, lead } = await fixture()
    await invite(tab)
    const group = randomUUID()
    const state = await storedState(tab)
    state.conversations.push({ ...structuredClone(state.conversations.find(c => c.id === 'lead')!), id: group, title: 'Chat with PM', leadId: lead,
      agentIds: [lead], assignment: null, audience: { people: [{ id: peer.sub, generation: state.people.find(p => p.id === peer.sub)!.generation }] } })
    await saveState(tab, state)
    const ids = async (user: AuthUser, asAgentId?: string) => (await store.read(user, tab, asAgentId)).state.conversations.map(c => c.id)
    for (const [user, asAgentId] of [[peer], [owner], [host, lead]] as const) {
      expect(await ids(user, asAgentId)).not.toContain(group)
      await expect(store.messages(user, tab, group, {}, asAgentId)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    }
    const say = { type: 'message.send' as const, conversationId: group, text: 'Hi', replyTo: null, recipientIds: [] }
    await expect(run(tab, say, peer)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(run(tab, say, host, lead)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect((await storedState(tab)).conversations.find(c => c.id === group)).toMatchObject({ title: 'Chat with PM', agentIds: [lead] })
  })
})

describe('the PM\'s terminal after a private chat (final review, Critical 1)', () => {
  const bob: AuthUser = { sub: '100000000000000000000004', email: 'bob@example.com', autonomousEnv: 'prod', role: 'user' }
  /** Someone the machine's owner shared the PM's terminal with the ordinary way, outside any Swarm. */
  const carol: AuthUser = { sub: '100000000000000000000005', email: 'carol@example.com', autonomousEnv: 'prod', role: 'user' }
  /** Alice (peer) and Bob read a public project whose machine neither owns; Alice told its PM something in the project chat,
   *  and Bob held a share of the PM's terminal from before. */
  async function privateChat() {
    const { tab, lead } = await fixture()
    await invite(tab)
    // The PM runs on host's machine; host is a member too, so the one person who may still watch it.
    const asHost = await run(tab, { type: 'invite.create', email: host.email, role: 'collaborator', conversationId: 'lead' })
    await run(tab, { type: 'invite.accept', inviteId: asHost.result.inviteId as string }, host)
    if (!await db.user.findUnique({ where: { id: bob.sub } })) {
      await db.user.create({ data: { id: bob.sub, externalId: `fixture-${bob.sub}`, email: bob.email, autonomousEnv: bob.autonomousEnv } })
    }
    const invitation = await run(tab, { type: 'invite.create', email: bob.email, role: 'collaborator', conversationId: 'lead' })
    await run(tab, { type: 'invite.accept', inviteId: invitation.result.inviteId as string }, bob)
    const harnessId = (await store.read(owner, tab)).state.agents.find(a => a.id === lead)!.harnessId
    // Shares of the PM's session from before the chat: Bob's, which this Swarm made, and Carol's, made outside any Swarm.
    const share = (superTabId: string | null, recipient: AuthUser, agentId = harnessId) => db.harnessShare.create({ data: { id: randomUUID(), superTabId,
      ownerId: host.sub, machineId: 'test-host', agentId, recipientEmail: recipient.email, autonomousEnv: 'prod', name: 'Lead', ownerPublicKey: 'fixture-key',
      expiresAt: new Date(Date.now() + 86_400_000), revokedAt: null } }).then(row => row.id)
    const swarmShare = await share(tab, bob), ordinaryShare = await share(null, carol)
    const secret = await run(tab, { type: 'message.send', conversationId: 'lead', text: 'For the PM: the launch slips a week.', replyTo: null, recipientIds: [] }, peer)
    // The PM's host types it into the PM's terminal and confirms it.
    const delivery = (await store.deliveries(host, tab, lead)).find(d => d.messageId === secret.result.messageId)!
    const claimId = randomUUID()
    await store.delivery(host, tab, lead, delivery.id, { type: 'claim', claimId })
    await store.delivery(host, tab, lead, delivery.id, { type: 'ack', claimId, receipt: 'Typed into the PM terminal', uncertain: false })
    expect((await db.superTabDelivery.findUniqueOrThrow({ where: { id: delivery.id } })).status).toBe('delivered')
    return { tab, lead, harnessId, swarmShare, ordinaryShare, share }
  }
  const observers = async (agentId: string) => (await rosterRows(store, host, 'test-host')).find(t => t.agent?.id === agentId)!.observers.map(p => p.userId)

  // A terminal drives its session and its answers land in the conversation. Driving another person's Lead needs its machine's
  // owner (terminal.ts mayDrive), so a member's terminal on a Builder made a Lead is refused from then on, whether or not it
  // was revoked with the change.
  it('refuses a member\'s terminal on a Builder made its project\'s Lead, at use and at open, and keeps the machine owner\'s', async () => {
    const { tab } = await fixture()
    await invite(tab)
    const asHost = await run(tab, { type: 'invite.create', email: host.email, role: 'collaborator', conversationId: 'lead' })
    await run(tab, { type: 'invite.accept', inviteId: asHost.result.inviteId as string }, host)
    const second = (await run(tab, { type: 'project.create', name: 'Second', visibility: 'public', brief: '' })).result as { projectId: string; conversationId: string }
    const group = String((await run(tab, { type: 'conversation.create', projectId: second.projectId, title: 'Build', brief: 'Build it', checks: [] })).result.conversationId)
    const worker = String((await run(tab, { type: 'agent.add', conversationId: group, machineId: 'test-host', harnessId: randomUUID(),
      name: 'Builder', configuration: config, lead: false })).result.agentId)
    const opened = (user: AuthUser) => store.native.open(user, tab, { operationId: randomUUID(), conversationId: group, agentId: worker })
    const { contextId: peers } = await opened(peer)
    const { contextId: hosts } = await opened(host)
    const typed = (contextId: string, turnId: string) => store.native.append(host, tab, contextId, { turnId, kind: 'prompt', previousEventId: null,
      text: 'Typed into the Builder', truncated: false, interrupted: false })
    await typed(peers, 'before')

    await run(tab, { type: 'conversation.agent', conversationId: second.conversationId, agentId: worker, present: true, lead: true })
    await expect(typed(peers, 'after')).rejects.toMatchObject({ code: 'NATIVE_CONTEXT_REVOKED' })
    // The refusal at use says why, as the refusal at open does (review of #1940).
    await db.superTabNativeContext.update({ where: { id: peers }, data: { revoked: false } })
    await expect(typed(peers, 'why')).rejects.toMatchObject({ code: 'NATIVE_CONTEXT_REVOKED', message: expect.stringContaining('a Product Manager’s terminal') })
    await expect(store.native.read(host, tab, peers)).rejects.toMatchObject({ code: 'NATIVE_CONTEXT_REVOKED' })
    await expect(opened(peer)).rejects.toMatchObject({ code: 'TERMINAL_PRIVATE' })
    // Even a terminal the change left unrevoked is refused at use.
    await db.superTabNativeContext.update({ where: { id: peers }, data: { revoked: false } })
    await expect(typed(peers, 'unrevoked')).rejects.toMatchObject({ code: 'NATIVE_CONTEXT_REVOKED' })
    expect((await db.superTabNativeContext.findUniqueOrThrow({ where: { id: hosts } })).revoked).toBe(false)
    await expect(typed(hosts, 'owner')).resolves.toMatchObject({ eventId: expect.any(String) })
    await expect(opened(host)).resolves.toMatchObject({ contextId: expect.any(String) })
  })

  it('lets every reader watch it while it is the Lead, view only: not through an ordinary share, and not once it is no longer the Lead', async () => {
    const { tab, lead, harnessId, swarmShare, ordinaryShare } = await privateChat()
    // Ken, 2026-10-28: a member watching the Product Manager reads the private chats it is in, and every member may.
    expect(await observers(lead)).toEqual(expect.arrayContaining([bob.sub, owner.sub, peer.sub]))
    const row = (await rosterRows(store, host, 'test-host')).find(t => t.tabId === tab && t.agent?.id === lead)!
    expect(row).toMatchObject({ confidential: true, membersWatch: true })
    for (const user of [bob, owner, peer]) expect(await store.mayObserve(user, tab, 'test-host', harnessId, host.sub)).toBe(true)
    expect(await recipientShare(swarmShare, bob, db)).not.toBeNull()
    // Outside the Swarm it is still its machine's person's alone.
    expect(await recipientShare(ordinaryShare, carol, db)).toBeNull()
    // A Lead leaves only with its project, but a state from before that rule can hold a former Lead still in the private chat.
    const state = await storedState(tab)
    state.conversations.find(c => c.id === 'lead')!.leadId = null
    await saveState(tab, state)
    expect(await observers(lead)).toEqual([])
    for (const user of [bob, owner, peer]) expect(await store.mayObserve(user, tab, 'test-host', harnessId, host.sub)).toBe(false)
    expect(await recipientShare(swarmShare, bob, db)).toBeNull()
    expect(await store.mayObserve(host, tab, 'test-host', harnessId, host.sub)).toBe(true)
  })

  it('leaves a Builder\'s terminal to the project\'s readers', async () => {
    const { tab } = await privateChat()
    const workerHarness = randomUUID()
    const worker = String((await run(tab, { type: 'agent.add', conversationId: 'lead', machineId: 'test-host', harnessId: workerHarness,
      name: 'Worker', configuration: config, lead: false })).result.agentId)
    expect(await observers(worker)).toEqual(expect.arrayContaining([bob.sub, owner.sub, peer.sub]))
    expect(await store.mayObserve(bob, tab, 'test-host', workerHarness, host.sub)).toBe(true)
  })

  /** Swarm B, where Bob reads a public project. */
  async function otherSwarm() {
    const other = (await store.create(owner, randomUUID(), 'Other Swarm', 'public')).id
    const invitation = await run(other, { type: 'invite.create', email: bob.email, role: 'collaborator', conversationId: 'lead' })
    await run(other, { type: 'invite.accept', inviteId: invitation.result.inviteId as string }, bob)
    return other
  }

  it('lets a confidential session be registered in one Swarm only, and no session in two become confidential', async () => {
    const { harnessId } = await privateChat()
    const other = await otherSwarm()
    const add = (tab: string, harness: string, lead: boolean) => run(tab, { type: 'agent.add', conversationId: 'lead', machineId: 'test-host', harnessId: harness,
      name: lead ? 'Lead' : 'Builder', configuration: config, lead })
    await expect(add(other, harnessId, false)).rejects.toMatchObject({ code: 'SESSION_CONFIDENTIAL' })
    // A session in two Swarms already cannot become a Lead in either.
    const shared = randomUUID()
    const first = (await store.create(owner, randomUUID(), 'No Lead yet', 'public')).id
    const sharedId = String((await add(first, shared, false)).result.agentId)
    await add(other, shared, false)
    await expect(run(first, { type: 'conversation.agent', conversationId: 'lead', agentId: sharedId, present: true, lead: true }))
      .rejects.toMatchObject({ code: 'SESSION_CONFIDENTIAL' })
  })

  /** A gate a transaction waits at once, before its first write: `reached` says it read everything, `open` lets it write. */
  function gate() {
    let reach!: () => void, open!: () => void, first = true
    const reached = new Promise<void>(resolve => { reach = resolve }), opened = new Promise<void>(resolve => { open = resolve })
    // Only its first attempt waits; a retry after the conflict reads again and goes straight on.
    const at = async () => { if (!first) return; first = false; reach(); await opened }
    return { at, reached, open }
  }

  it.each(['promotion', 'registration'] as const)('lets only one of a concurrent promotion to Lead in one Swarm and a registration in another win: %s first', async winner => {
    const shared = randomUUID()
    const first = (await fixture()).tab, other = await otherSwarm()
    const project = (await run(first, { type: 'project.create', name: 'Promotes', visibility: 'public', brief: '' })).result as { projectId: string; conversationId: string }
    const sharedId = String((await run(first, { type: 'agent.add', conversationId: project.conversationId, machineId: 'test-host', harnessId: shared,
      name: 'Shared', configuration: config, lead: false })).result.agentId)
    // Both transactions read before either writes; then the winner commits, and only then may the other write.
    const promotionGate = gate(), registrationGate = gate()
    const promotion = new SuperTabStore(beforeFirstWrite(db, promotionGate.at)).execute(owner, first, { operationId: randomUUID(),
      command: { type: 'conversation.agent', conversationId: project.conversationId, agentId: sharedId, present: true, lead: true } })
    const registration = new SuperTabStore(beforeFirstWrite(db, registrationGate.at)).execute(owner, other, { operationId: randomUUID(),
      command: { type: 'agent.add', conversationId: 'lead', machineId: 'test-host', harnessId: shared, name: 'Shared', configuration: config, lead: false } })
    await Promise.all([promotionGate.reached, registrationGate.reached])
    const [won, lost] = winner === 'promotion' ? [promotion, registration] : [registration, promotion]
    const [wonGate, lostGate] = winner === 'promotion' ? [promotionGate, registrationGate] : [registrationGate, promotionGate]
    wonGate.open()
    await won
    lostGate.open()
    await expect(lost).rejects.toMatchObject({ code: 'SESSION_CONFIDENTIAL' })
    const registered = async (tab: string) => db.swarmAgent.count({ where: { key: sharedId, deleted: false, tabId: tab } })
    if (winner === 'promotion') {
      expect(await registered(other)).toBe(0)
      expect((await storedState(first)).agents.find(a => a.id === sharedId)!.confidential).toBe(true)
    } else {
      expect(await registered(other)).toBe(1)
      expect((await storedState(first)).agents.find(a => a.id === sharedId)!.confidential).toBeUndefined()
    }
    // Swarm A lets the session go with its project (a Lead is protected from plain removal): no Swarm then holds a confidential
    // session unmarked, because it never had a second registration.
    await run(first, { type: 'project.delete', projectId: project.projectId })
    expect(await registered(first)).toBe(0)
    const left = await db.swarmAgent.findMany({ where: { key: sharedId, deleted: false } })
    expect(left.every(row => winner === 'registration' && !(row.data as { confidential?: boolean }).confidential)).toBe(true)
    expect(left).toHaveLength(winner === 'promotion' ? 0 : 1)
  })

  it('keeps a session registered in two Swarms before the rule closed everywhere: to the other Swarm\'s Lead, its readers and earlier shares', async () => {
    const { tab, lead, harnessId, swarmShare, ordinaryShare, share } = await privateChat()
    const other = await otherSwarm()
    const otherLead = String((await run(other, { type: 'agent.add', conversationId: 'lead', machineId: 'test-host', harnessId: randomUUID(),
      name: 'Other Lead', configuration: config, lead: true })).result.agentId)
    // The PM's session as a Builder in Swarm B, written the way a duplicate from before the rule is stored.
    const pm = (await storedState(tab)).agents.find(a => a.id === lead)!
    const b = await storedState(other)
    const { confidential: _mark, ...unmarked } = pm
    b.agents.push({ ...unmarked, projectId: b.projects![0]!.id, name: 'Builder elsewhere',
      membershipGeneration: b.people.find(p => p.id === pm.contributorId)!.generation })
    b.conversations.find(c => c.id === 'lead')!.agentIds.push(lead)
    await saveState(other, b)
    const row = (await rosterRows(store, host, 'test-host')).find(t => t.tabId === other && t.agent?.id === lead)!
    expect(row).toMatchObject({ observers: [], confidential: true })
    expect(await store.mayObserve(bob, other, 'test-host', harnessId, host.sub)).toBe(false)
    await expect(run(other, { type: 'agent.screen', agentId: lead }, bob)).rejects.toMatchObject({ code: 'TERMINAL_PRIVATE' })
    // Swarm B's Lead cannot read or type into its Builder alias of Swarm A's PM.
    await expect(run(other, { type: 'agent.screen', agentId: lead }, host, otherLead)).rejects.toMatchObject({ code: 'TERMINAL_PRIVATE' })
    await expect(run(other, { type: 'agent.input', agentId: lead, keys: ['Enter'] }, host, otherLead)).rejects.toMatchObject({ code: 'TERMINAL_PRIVATE' })
    // Shares made before the chat, opened as the observer relay opens them: Swarm A's opens for its member while the session
    // is A's Lead (Ken, 2026-10-28); Swarm B's and the ordinary one stay closed.
    expect(await recipientShare(swarmShare, bob, db)).not.toBeNull()
    expect(await recipientShare(ordinaryShare, carol, db)).toBeNull()
    await db.harnessShare.update({ where: { id: swarmShare }, data: { superTabId: other } })
    expect(await recipientShare(swarmShare, bob, db)).toBeNull()
    // A Builder's session shared the ordinary way still opens.
    const builderHarness = randomUUID()
    await run(other, { type: 'agent.add', conversationId: 'lead', machineId: 'test-host', harnessId: builderHarness, name: 'Plain builder', configuration: config, lead: false })
    expect(await recipientShare(await share(null, carol, builderHarness), carol, db)).not.toBeNull()
  })

  it('lets nobody but its machine\'s owner read or type in it through the terminal requests', async () => {
    const { tab, lead } = await privateChat()
    for (const user of [bob, owner]) {
      await expect(run(tab, { type: 'agent.screen', agentId: lead, scrollback: 200 }, user)).rejects.toMatchObject({ code: 'TERMINAL_PRIVATE' })
      await expect(run(tab, { type: 'agent.input', agentId: lead, text: 'history' }, user)).rejects.toMatchObject({ code: 'TERMINAL_PRIVATE' })
    }
    expect((await run(tab, { type: 'agent.screen', agentId: lead }, host)).result.requestId).toBeTruthy()
  })
})

// Prod, 2026-10-28 (Atlas, the hour to 14:30 VN): every command, message.send included, sent one terminal-context query of
// 78 branches, 70 of them this project's archived groups, that returned nothing and spent 67% of its 0.6–3.8 s planning.
describe('terminal-context revoke on an ordinary command', () => {
  it('sends a message in a Swarm with many archived groups and a private project without touching terminal contexts', async () => {
    const { tab } = await fixture()
    await invite(tab)
    await run(tab, { type: 'project.create', name: 'Owner only', visibility: 'private', brief: '' })
    for (let i = 0; i < 30; i++) {
      const group = String((await run(tab, { type: 'conversation.create', title: `Old ${i}`, brief: '', checks: [] })).result.conversationId)
      await run(tab, { type: 'conversation.archive', conversationId: group, archived: true })
    }
    await db.$runCommandRaw({ profile: 2 })
    try {
      await run(tab, message('Status?'))
    } finally {
      await db.$runCommandRaw({ profile: 0 })
    }
    const profiled = await db.$runCommandRaw({ find: 'system.profile', filter: { 'command.profile': { $exists: false } }, batchSize: 10000 }) as
      unknown as { cursor: { firstBatch: Array<{ ns: string; op: string }> } }
    await db.$runCommandRaw({ drop: 'system.profile' })
    expect(profiled.cursor.firstBatch.filter(row => row.ns.endsWith('.SuperTabNativeContext'))).toEqual([])
  })
})

describe('Swarm sweeps', () => {
  const day = 86_400_000
  async function finishedGroup(tab: string, lead: string) {
    const group = String((await run(tab, { type: 'conversation.create', title: 'Done work', brief: 'Do it',
      checks: [{ description: 'Done', independent: false }] })).result.conversationId)
    const worker = String((await run(tab, { type: 'agent.add', conversationId: group, machineId: 'test-host', harnessId: randomUUID(),
      name: 'Worker', configuration: config, lead: false })).result.agentId)
    const assignmentId = String((await run(tab, { type: 'work.assign', conversationId: group, agentId: worker })).result.assignmentId)
    const checkId = (await store.read(owner, tab)).state.conversations.find(c => c.id === group)!.checks[0]!.id
    await run(tab, { type: 'work.check', conversationId: group, assignmentId, checkId, passed: true, evidence: 'Shown' }, host, lead)
    await run(tab, { type: 'work.status', conversationId: group, assignmentId, status: 'done', result: 'Shipped' }, host, worker)
    return group
  }

  /** The project's Lead reports through everything its workgroup said so far. */
  async function acknowledge(tab: string, lead: string, group: string) {
    const read = (await store.read(owner, tab)).state.conversations.find(c => c.id === group)!
    await run(tab, { type: 'project.report', projectId: 'lead', through: { [group]: read.lastMessageSequence }, text: null }, host, lead)
  }

  it('puts a conversation archived by hand to sleep once its reports are acknowledged, and ordinary loads stop reading it', async () => {
    const { tab, lead } = await fixture()
    const group = await finishedGroup(tab, lead)
    await run(tab, { type: 'conversation.archive', conversationId: group, archived: true })
    const loaded = async () => (await db.$transaction(tx => parts.loadActive(tx, tab))).groups.map(p => p.key)
    expect(await loaded()).toContain(group)
    await acknowledge(tab, lead, group)
    await sweepSwarms(db)
    expect(await loaded()).not.toContain(group)
    expect((await db.$transaction(tx => parts.loadDormant(tx, tab, {}))).map(p => p.key)).toEqual([group])
    // Reopened, it is active again.
    await run(tab, { type: 'conversation.archive', conversationId: group, archived: false })
    expect(await loaded()).toContain(group)
  })

  it('puts a conversation with finished work to sleep after a quiet day, and a new message wakes it', async () => {
    const { tab, lead } = await fixture()
    const group = await finishedGroup(tab, lead)
    const listed = async () => (await store.read(owner, tab)).state.conversations.map(c => c.id)
    await sweepSwarms(db, Date.now() + day - 60_000)
    expect(await listed()).toContain(group)
    // Its reports are not acknowledged yet: it stays awake, where the Lead's report check sees it.
    await sweepSwarms(db, Date.now() + day + 60_000)
    expect(await listed()).toContain(group)
    await acknowledge(tab, lead, group)
    await sweepSwarms(db, Date.now() + day + 60_000)
    expect(await listed()).not.toContain(group)
    // The Lead conversation stays awake whatever its age.
    expect(await listed()).toContain('lead')
    expect((await db.$transaction(tx => parts.loadDormant(tx, tab, {}))).map(p => p.key)).toEqual([group])
    expect((await store.messages(owner, tab, group, {})).messages.at(-1)!.text).toMatch(/^Done/)
    await run(tab, { type: 'message.send', conversationId: group, text: 'One more thing.', replyTo: null, recipientIds: [] })
    expect(await listed()).toContain(group)
    expect(await db.$transaction(tx => parts.loadDormant(tx, tab, {}))).toEqual([])
  })

  it('reaches a finished group behind more than a batch of quiet groups that cannot sleep', async () => {
    const { tab, lead } = await fixture()
    const group = await finishedGroup(tab, lead)
    // 520 groups the sweep must pass over: quiet for days, older than the finished group, but their work is not finished.
    const old = new Date(Date.now() - 10 * day)
    await db.swarmGroup.createMany({ data: Array.from({ length: 520 }, (_, i) => {
      // Keys that sort before any generated id, so they come first in the store's natural order as well as by age.
      const key = `-idle-${String(i).padStart(3, '0')}`
      return { id: `${tab}:${key}`, tabId: tab, key, version: 1, changedAt: old, deleted: false, ordinal: 1000 + i, projectId: 'lead', kind: null,
        archived: false, dormant: false, agentIds: [], executionMachineId: null, messageSeq: 0, reportSeq: 0, lastActivityAt: old,
        data: { id: key, projectId: 'lead', title: key, leadId: null, agentIds: [], archived: false, brief: '', checks: [], assignment: null, lastMessageSequence: 0 } }
    }) })
    await acknowledge(tab, lead, group)
    await sweepSwarms(db, Date.now() + day + 60_000)
    expect((await db.$transaction(tx => parts.loadDormant(tx, tab, {}))).map(p => p.key)).toContain(group)
  })

  it('revokes a terminal in a dormant conversation when its opener loses the project, and restoring access does not revive it', async () => {
    const { tab } = await fixture()
    await invite(tab)
    const projectId = String((await run(tab, { type: 'project.create', name: 'Secret', visibility: 'private', brief: '' })).result.projectId)
    await run(tab, { type: 'project.sharing', projectId, visibility: 'private', memberIds: [peer.sub] })
    const leadChat = (await store.read(owner, tab)).state.projects!.find(p => p.id === projectId)!.leadConversationId
    const projectLead = String((await run(tab, { type: 'agent.add', conversationId: leadChat, machineId: 'test-host', harnessId: randomUUID(),
      name: 'Secret Lead', configuration: config, lead: true })).result.agentId)
    const group = String((await run(tab, { type: 'conversation.create', projectId, title: 'Quiet', brief: 'Old work',
      checks: [{ description: 'Done', independent: false }] })).result.conversationId)
    const worker = String((await run(tab, { type: 'agent.add', conversationId: group, machineId: 'test-host', harnessId: randomUUID(),
      name: 'Secret Worker', configuration: config, lead: false })).result.agentId)
    const { contextId } = await store.native.open(peer, tab, { operationId: randomUUID(), conversationId: group, agentId: worker })
    const turn = await store.native.append(host, tab, contextId, { turnId: 'kept', kind: 'prompt', previousEventId: null, text: 'Typed by the peer',
      truncated: false, interrupted: false }) as { eventId: string }
    const waiting = await db.superTabDelivery.findFirstOrThrow({ where: { tabId: tab, messageId: turn.eventId, agentId: projectLead } })
    // Its work finished, its reports acknowledged, a quiet day later it sleeps: no ordinary load reads it any more. Not
    // archived: archiving revokes its terminals by itself.
    const assignmentId = String((await run(tab, { type: 'work.assign', conversationId: group, agentId: worker })).result.assignmentId)
    const checkId = (await storedState(tab)).conversations.find(c => c.id === group)!.checks[0]!.id
    await run(tab, { type: 'work.check', conversationId: group, assignmentId, checkId, passed: true, evidence: 'Shown' })
    await run(tab, { type: 'work.status', conversationId: group, assignmentId, status: 'done', result: 'Shipped' }, host, worker)
    const read = (await storedState(tab)).conversations.find(c => c.id === group)!
    await run(tab, { type: 'project.report', projectId, through: { [group]: read.lastMessageSequence }, text: null }, host, projectLead)
    await sweepSwarms(db, Date.now() + day + 60_000)
    expect((await db.$transaction(tx => parts.loadDormant(tx, tab, {}))).map(p => p.key)).toContain(group)
    expect((await db.superTabNativeContext.findUniqueOrThrow({ where: { id: contextId } })).revoked).toBe(false)

    await run(tab, { type: 'project.sharing', projectId, visibility: 'private', memberIds: [] })
    expect((await db.superTabNativeContext.findUniqueOrThrow({ where: { id: contextId } })).revoked).toBe(true)
    expect((await db.superTabDelivery.findUniqueOrThrow({ where: { id: waiting.id } })).status).toBe('cancelled')
    await run(tab, { type: 'project.sharing', projectId, visibility: 'private', memberIds: [peer.sub] })
    await expect(store.native.append(host, tab, contextId, { turnId: 'late', kind: 'prompt', previousEventId: turn.eventId, text: 'After removal',
      truncated: false, interrupted: false })).rejects.toMatchObject({ code: 'NATIVE_CONTEXT_REVOKED' })
  })

  it('revokes a terminal in a dormant legacy conversation of the default project, stored with no project, when its opener loses the project', async () => {
    const { tab, lead } = await fixture()
    await invite(tab)
    await run(tab, { type: 'project.sharing', projectId: 'lead', visibility: 'private', memberIds: [peer.sub] })
    const group = String((await run(tab, { type: 'conversation.create', title: 'Legacy quiet', brief: 'Old work',
      checks: [{ description: 'Done', independent: false }] })).result.conversationId)
    const worker = String((await run(tab, { type: 'agent.add', conversationId: group, machineId: 'test-host', harnessId: randomUUID(),
      name: 'Legacy Worker', configuration: config, lead: false })).result.agentId)
    const { contextId } = await store.native.open(peer, tab, { operationId: randomUUID(), conversationId: group, agentId: worker })
    const turn = await store.native.append(host, tab, contextId, { turnId: 'kept', kind: 'prompt', previousEventId: null, text: 'Typed by the peer',
      truncated: false, interrupted: false }) as { eventId: string }
    const waiting = await db.superTabDelivery.findFirstOrThrow({ where: { tabId: tab, messageId: turn.eventId, agentId: lead } })
    const assignmentId = String((await run(tab, { type: 'work.assign', conversationId: group, agentId: worker })).result.assignmentId)
    const checkId = (await storedState(tab)).conversations.find(c => c.id === group)!.checks[0]!.id
    await run(tab, { type: 'work.check', conversationId: group, assignmentId, checkId, passed: true, evidence: 'Shown' })
    await run(tab, { type: 'work.status', conversationId: group, assignmentId, status: 'done', result: 'Shipped' }, host, worker)
    await acknowledge(tab, lead, group)
    await sweepSwarms(db, Date.now() + day + 60_000)
    // Stored as a Swarm from before projects left it: no project on the group, which then belongs to the default one.
    const row = await db.swarmGroup.findFirstOrThrow({ where: { tabId: tab, key: group } })
    const { projectId: _projectId, ...legacy } = row.data as Record<string, unknown>
    await db.swarmGroup.update({ where: { id: row.id }, data: { projectId: null, data: legacy as never } })
    expect((await db.$transaction(tx => parts.loadDormant(tx, tab, {}))).map(p => p.key)).toContain(group)
    expect((await db.superTabNativeContext.findUniqueOrThrow({ where: { id: contextId } })).revoked).toBe(false)

    await run(tab, { type: 'project.sharing', projectId: 'lead', visibility: 'private', memberIds: [] })
    expect((await db.superTabNativeContext.findUniqueOrThrow({ where: { id: contextId } })).revoked).toBe(true)
    expect((await db.superTabDelivery.findUniqueOrThrow({ where: { id: waiting.id } })).status).toBe('cancelled')
    await run(tab, { type: 'project.sharing', projectId: 'lead', visibility: 'private', memberIds: [peer.sub] })
    await expect(store.native.append(host, tab, contextId, { turnId: 'late', kind: 'prompt', previousEventId: turn.eventId, text: 'After removal',
      truncated: false, interrupted: false })).rejects.toMatchObject({ code: 'NATIVE_CONTEXT_REVOKED' })
  })

  it('never lets a person, agent or machine come back at a lower version, even long after it was removed', async () => {
    const { tab } = await fixture()
    const harnessId = randomUUID()
    const add = async () => String((await run(tab, { type: 'agent.add', conversationId: 'lead', machineId: 'test-host', harnessId, name: 'Returning',
      configuration: config, lead: false })).result.agentId)
    const agentId = await add()
    for (const effort of ['low', 'medium']) {
      const previous = (await storedState(tab)).agents.find(a => a.id === agentId)!.configurationVersion ?? null
      await run(tab, { type: 'agent.configuration', previousVersion: previous, configuration: { ...config, effort } }, host, agentId)
    }
    const before = await db.swarmAgent.findFirstOrThrow({ where: { tabId: tab, key: agentId } })
    await run(tab, { type: 'agent.remove', agentId })
    // Past the tombstone's 7 days: its record stays, compacted, and holds the version; nothing purges it.
    await sweepSwarms(db, Date.now() + 8 * day)
    const kept = await db.swarmAgent.findFirstOrThrow({ where: { tabId: tab, key: agentId } })
    expect(kept.deleted).toBe(true)
    expect(kept.data).toEqual({})
    expect(kept.version).toBeGreaterThan(before.version)
    await ensurePartExpiry(db)
    for (const collection of ['SwarmMember', 'SwarmAgent', 'SwarmMachine']) {
      const indexes = await db.$runCommandRaw({ listIndexes: collection }) as { cursor: { firstBatch: Array<{ expireAfterSeconds?: number }> } }
      expect(indexes.cursor.firstBatch.filter(i => i.expireAfterSeconds !== undefined), collection).toEqual([])
    }
    await add()
    const back = await db.swarmAgent.findFirstOrThrow({ where: { tabId: tab, key: agentId } })
    expect(back.deleted).toBe(false)
    expect(back.version).toBeGreaterThan(kept.version)
    const history = await db.superTabConfiguration.findMany({ where: { tabId: tab, agentId }, orderBy: { revision: 'asc' } })
    expect(history.at(-1)!.configuration).toMatchObject({ effort: 'high' })
  })

  it('drops finished starts and expired invitations after their time, and creates the purge index', async () => {
    const { tab, lead } = await fixture()
    const { startId } = await routedStart(tab, lead)
    await store.execute(host, tab, { operationId: randomUUID(), command: { type: 'agent.startFailed', startId, error: 'No room.' } }, lead)
    await run(tab, { type: 'invite.create', email: 'late@example.com', role: 'viewer', conversationId: 'lead' })
    await sweepSwarms(db, Date.now() + 6 * day)
    expect((await db.$transaction(tx => parts.loadAll(tx, tab))).starts.find(p => p.key === startId)?.deleted).toBeUndefined()
    await sweepSwarms(db, Date.now() + 8 * day)
    expect((await db.$transaction(tx => parts.loadAll(tx, tab))).starts.find(p => p.key === startId)?.deleted).toBe(true)
    expect((await store.read(owner, tab)).state.invitations).toEqual([])
    expect((await db.superTab.findUniqueOrThrow({ where: { id: tab } })).invitedEmails).not.toContain('late@example.com')
    await ensurePartExpiry(db)
    const indexes = await db.$runCommandRaw({ listIndexes: 'SwarmGroup' }) as { cursor: { firstBatch: Array<{ key: object; expireAfterSeconds?: number }> } }
    expect(indexes.cursor.firstBatch).toContainEqual(expect.objectContaining({ key: { purgeAt: 1 }, expireAfterSeconds: 0 }))
  })
})

describe('Swarm parts under concurrent writes', () => {
  /** A store whose transactions are counted: one per attempt, so every retry after a conflict shows. */
  function counted() {
    let attempts = 0
    const proxy = new Proxy(db, { get(target, key, receiver) {
      if (key === '$transaction') return (...args: Parameters<PrismaClient['$transaction']>) => { attempts++; return (target.$transaction as (...a: unknown[]) => unknown)(...args) }
      return Reflect.get(target, key, receiver)
    } })
    return { store: new SuperTabStore(proxy as PrismaClient), get attempts() { return attempts } }
  }
  /** A group with its own assigned worker, so the worker's posts reach the Lead. */
  async function workGroup(tab: string, title: string) {
    const group = String((await run(tab, { type: 'conversation.create', title, brief: 'Build it', checks: [{ description: 'Built', independent: false }] })).result.conversationId)
    const worker = String((await run(tab, { type: 'agent.add', conversationId: group, machineId: 'test-host', harnessId: randomUUID(),
      name: title, configuration: config, lead: false })).result.agentId)
    await run(tab, { type: 'work.assign', conversationId: group, agentId: worker })
    return { group, worker }
  }

  it('lets agents post in different groups at the same time without a single conflict', async () => {
    const { tab } = await fixture()
    const groups = await Promise.all(['Parser', 'Renderer', 'Exporter', 'Importer'].map(title => workGroup(tab, title)))
    // The project is dirty already, as it is in a busy Swarm: posts do not write its progress again.
    for (const { group, worker } of groups) await run(tab, { type: 'message.send', conversationId: group, text: 'Started.', replyTo: null, recipientIds: [] }, host, worker)
    const c = counted()
    // Each worker posts in turn in its own group, all workers at once: any conflict is between different groups.
    await Promise.all(groups.map(async ({ group, worker }) => {
      for (let i = 0; i < 5; i++) await c.store.execute(host, tab, { operationId: randomUUID(),
        command: { type: 'message.send', conversationId: group, text: `Progress ${i}`, replyTo: null, recipientIds: [] } }, worker)
    }))
    expect(c.attempts).toBe(groups.length * 5)
    for (const { group } of groups) {
      const sequences = (await store.messages(owner, tab, group, {})).messages.map(m => m.sequence)
      expect(new Set(sequences).size).toBe(sequences.length)
      expect(sequences).toEqual([...sequences].sort((a, b) => a - b))
    }
  })

  it('records terminal turns in different groups at the same time without a single conflict, even when one person opened them all', async () => {
    const { tab } = await fixture()
    const groups = await Promise.all(['Alpha', 'Beta', 'Gamma'].map(title => workGroup(tab, title)))
    const contexts = []
    for (const { group, worker } of groups) contexts.push((await store.native.open(owner, tab, { operationId: randomUUID(), conversationId: group, agentId: worker })).contextId)
    // The project is dirty already: a turn writes only its own group.
    for (const contextId of contexts) await store.native.append(host, tab, contextId, { turnId: 'warm', kind: 'prompt', previousEventId: null, text: 'Warm up', truncated: false, interrupted: false })
    const c = counted()
    await Promise.all(contexts.map(async contextId => {
      let previous = (await db.superTabNativeContext.findUniqueOrThrow({ where: { id: contextId } })).lastEventId
      for (let i = 0; i < 4; i++) {
        const recorded = await c.store.native.append(host, tab, contextId, { turnId: `turn_${i}`, kind: 'prompt', previousEventId: previous,
          text: `Prompt ${i}`, truncated: false, interrupted: false }) as { eventId: string }
        previous = recorded.eventId
      }
    }))
    expect(c.attempts).toBe(contexts.length * 4)
  })

  it('lets a Lead\'s host claim its deliveries while the Lead posts, without a conflict between them', async () => {
    const { tab, lead } = await fixture()
    const groups = await Promise.all(['North', 'South', 'East'].map(title => workGroup(tab, title)))
    for (const { group, worker } of groups) {
      for (let i = 0; i < 2; i++) await run(tab, { type: 'message.send', conversationId: group, text: `Report ${i}`, replyTo: null, recipientIds: [] }, host, worker)
    }
    const waiting = await store.deliveries(host, tab, lead)
    expect(waiting.length).toBeGreaterThanOrEqual(6)
    const c = counted()
    await Promise.all([
      ...waiting.map(d => c.store.delivery(host, tab, lead, d.id, { type: 'claim', claimId: randomUUID() })),
      c.store.execute(host, tab, { operationId: randomUUID(), command: { type: 'message.send', conversationId: 'lead', text: 'Planning.', replyTo: null, recipientIds: [] } }, lead),
    ])
    expect(c.attempts).toBe(waiting.length + 1)
  })

  it('gives a machine\'s last slot to exactly one of two concurrent starts', async () => {
    const tab = (await store.create(owner, randomUUID(), 'Slots')).id
    await run(tab, { type: 'invite.create', email: host.email, role: 'collaborator', conversationId: 'lead' })
      .then(r => run(tab, { type: 'invite.accept', inviteId: r.result.inviteId as string }, host))
    await run(tab, { type: 'machine.contribute', machineId: 'test-host', name: 'Host', cwd: '/fixture/repo', engines: ['codex'], maxAgents: 1 }, host)
    const generation = (await poolRows(store, host, 'test-host')).find(p => p.tabId === tab)!.machine.generation
    await store.observeMachine(host, tab, 'test-host', { generation, resources: { cpuPercent: 10, memoryTotalBytes: 32e9, memoryUsedBytes: 4e9,
      diskFreeBytes: 120e9, diskTotalBytes: 500e9, projectDiskFreeBytes: 120e9, deviceType: 'Laptop', chip: 'Fixture', os: 'macOS', gpuPercent: null },
      quotas: [], tools: {}, runningHarnessIds: [], stoppedHarnessIds: [] })
    const request = (name: string) => ({ conversationId: 'lead', machineId: 'test-host', engine: 'codex', name, cwd: '/fixture/repo', worktree: false,
      requirements: { memoryBytes: 0, diskBytes: 0, maxCpuPercent: 100, tools: [], devices: [], quotaRequired: false } })
    const results = await Promise.allSettled([run(tab, { type: 'agent.start', request: request('One') }, host),
      run(tab, { type: 'agent.start', request: request('Two') }, host)])
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1)
    expect(results.find(r => r.status === 'rejected')).toMatchObject({ reason: { code: 'MACHINE_FULL' } })
  })

  it('never keeps a message from a person removed while it was being sent', async () => {
    const { tab, lead } = await fixture()
    await invite(tab)
    const results = await Promise.allSettled([run(tab, message('Sent while leaving.'), peer), run(tab, { type: 'member.remove', userId: peer.sub })])
    expect(results[1]!.status).toBe('fulfilled')
    // Sent first, its delivery was revoked with the membership; sent second, it was refused. Either way nothing waits.
    expect(await store.deliveries(host, tab, lead)).toEqual([])
    const authored = await db.superTabDelivery.findMany({ where: { tabId: tab, authorId: peer.sub } })
    expect(authored.every(d => d.status === 'cancelled')).toBe(true)
  })

  it('serializes a claim against revoking an agent sender', async () => {
    const { tab, lead } = await fixture()
    const { group, worker } = await workGroup(tab, 'Revoked')
    await run(tab, { type: 'message.send', conversationId: group, text: 'Report for the Lead.', replyTo: null, recipientIds: [] }, host, worker)
    const delivery = (await store.deliveries(host, tab, lead)).find(d => d.authorId === worker)!
    await run(tab, { type: 'work.cancel', conversationId: group, assignmentId: (await store.read(owner, tab)).state.conversations.find(c => c.id === group)!.assignment!.id,
      reason: 'Withdrawing the worker' })
    const results = await Promise.allSettled([
      store.delivery(host, tab, lead, delivery.id, { type: 'claim', claimId: randomUUID() }),
      run(tab, { type: 'agent.remove', agentId: worker }),
    ])
    expect(results[1]!.status).toBe('fulfilled')
    expect((await db.superTabDelivery.findUniqueOrThrow({ where: { id: delivery.id } })).status).toBe('cancelled')
    expect((await store.deliveries(host, tab, lead)).map(d => d.id)).not.toContain(delivery.id)
  })

  it('serializes a claim against removing its receiving agent', async () => {
    const { tab, lead } = await fixture()
    const { group, worker } = await workGroup(tab, 'Receiver')
    await run(tab, { type: 'work.cancel', conversationId: group, assignmentId: (await store.read(owner, tab)).state.conversations.find(c => c.id === group)!.assignment!.id,
      reason: 'Withdrawing the worker' })
    await run(tab, { type: 'message.send', conversationId: group, text: 'For the worker.', replyTo: null, recipientIds: [worker] }, host, lead)
    const delivery = (await store.deliveries(host, tab, worker))[0]!
    const results = await Promise.allSettled([
      store.delivery(host, tab, worker, delivery.id, { type: 'claim', claimId: randomUUID() }),
      run(tab, { type: 'agent.remove', agentId: worker }),
    ])
    expect(results[1]!.status).toBe('fulfilled')
    expect((await db.superTabDelivery.findUniqueOrThrow({ where: { id: delivery.id } })).status).toBe('cancelled')
  })

  it('ends the waiting delivery rows of a conversation archived or left by their receiver, so a claim in flight conflicts', async () => {
    const { tab, lead } = await fixture()
    const { group, worker } = await workGroup(tab, 'Rows')
    const assignmentId = (await store.read(owner, tab)).state.conversations.find(c => c.id === group)!.assignment!.id
    await run(tab, { type: 'work.cancel', conversationId: group, assignmentId, reason: 'Done here' })
    const waiting = await run(tab, { type: 'message.send', conversationId: group, text: 'Still waiting.', replyTo: null, recipientIds: [worker] }, host, lead)
    const row = async () => db.superTabDelivery.findFirstOrThrow({ where: { tabId: tab, agentId: worker, messageId: waiting.result.messageId as string } })
    const before = await row()
    await new Promise(resolve => setTimeout(resolve, 5))
    await run(tab, { type: 'conversation.agent', conversationId: group, agentId: worker, present: false, lead: false })
    const left = await row()
    expect(left.updatedAt.getTime()).toBeGreaterThan(before.updatedAt.getTime())
    // Its receiver can no longer read it there: it ends now, rather than waiting unseen for good (prod watch, 2026-10-28).
    expect(left.status).toBe('cancelled')
    const kept = await run(tab, { type: 'message.send', conversationId: group, text: 'For the Lead.', replyTo: null, recipientIds: [] })
    const toLead = async () => db.superTabDelivery.findFirstOrThrow({ where: { tabId: tab, messageId: kept.result.messageId as string } })
    const open = await toLead()
    await new Promise(resolve => setTimeout(resolve, 5))
    await run(tab, { type: 'conversation.archive', conversationId: group, archived: true })
    const archived = await toLead()
    expect(archived.updatedAt.getTime()).toBeGreaterThan(open.updatedAt.getTime())
    // Archiving ends them too: 6 of 9 deliveries stuck for days in prod were in archived groups.
    expect(archived.status).toBe('cancelled')
  })

  it('assigns the routed agent through its finished start, without an override reason', async () => {
    const { tab, lead } = await fixture()
    const { routeDecisionId, startId } = await routedStart(tab, lead)
    await store.execute(host, tab, { operationId: randomUUID(), command: { type: 'agent.startDispatch', startId } }, lead)
    const agentId = String((await store.execute(host, tab, { operationId: randomUUID(), command: { type: 'agent.started', startId,
      harnessId: randomUUID(), configuration: config } }, lead)).result.agentId)
    // Started and not pooled: the start is finished and out of every command's active state.
    expect((await db.swarmStart.findFirstOrThrow({ where: { tabId: tab, key: startId } })).finishedAt).not.toBeNull()
    await run(tab, { type: 'work.define', conversationId: 'lead', brief: 'Routed work', checks: [{ description: 'Done', independent: false }] }, host, lead)
    const assigned = await run(tab, { type: 'work.assign', conversationId: 'lead', agentId, routeDecisionId }, host, lead)
    expect(assigned.result.assignmentId).toBeTruthy()
    expect((await store.routeDecision(owner, tab, routeDecisionId)).final).toMatchObject({ kind: 'new', startId })
  })
})

describe('a migrated Swarm\'s kept old state (Stability 2.1)', () => {
  /** About the 1 MB a production Swarm kept from before its split into parts (design 6.1: `SuperTab.legacyState`). */
  const OLD_STATE = { conversations: Array.from({ length: 2_000 }, (_, i) => ({ id: `old-${i}`, title: 'x'.repeat(480) })) }
  /** Far below the old state: a read that fetched it would send at least 1 MB. */
  const READ_LIMIT = 200_000
  const bytesOut = async () => Number(((await db.$runCommandRaw({ serverStatus: 1 })) as { network: { bytesOut: unknown } }).network.bytesOut)

  it('is never fetched by a command, a read, the owner\'s lists, an invitation list or a host\'s terminal pickup', async () => {
    const { tab, lead } = await fixture()
    const invited: AuthUser = { sub: '100000000000000000000009', email: 'invited@example.com', autonomousEnv: 'prod', role: 'user' }
    await run(tab, { type: 'invite.create', email: invited.email, role: 'viewer', conversationId: 'lead' })
    const group = (await run(tab, { type: 'conversation.create', title: 'Terminal', brief: 'Answer the prompt', checks: [] })).result.conversationId as string
    const worker = (await run(tab, { type: 'agent.add', conversationId: group, machineId: 'test-host', harnessId: randomUUID(),
      name: 'Terminal Engineer', configuration: config, lead: false })).result.agentId as string
    await db.superTab.update({ where: { id: tab }, data: { legacyState: OLD_STATE } })

    const fetched: string[] = []
    /** Runs `body`, and names it when MongoDB sent this backend enough for the old state while it ran (bench/probe.ts). */
    async function measured<T>(name: string, body: () => Promise<T>): Promise<T> {
      const before = await bytesOut(), ownReply = await bytesOut() - before
      const start = await bytesOut()
      const result = await body()
      if (await bytesOut() - start - ownReply >= READ_LIMIT) fetched.push(name)
      return result
    }
    expect((await measured('command', () => run(tab, message('After the split')))).result.messageId).toBeTruthy()
    expect((await measured('read', () => store.read(owner, tab))).state.agents.map(a => a.id).sort()).toEqual([lead, worker].sort())
    expect(await measured('invitations', () => store.invitations(invited))).toEqual([expect.objectContaining({ tabId: tab, name: 'Pilot', role: 'viewer' })])
    // The owner's lists read each of the owner's Swarms: an owner of this one alone, as the shared owner has many here.
    const solo: AuthUser = { sub: '10000000000000000000000a', email: 'solo@example.com', autonomousEnv: 'prod', role: 'user' }
    const own = (await store.create(solo, randomUUID(), 'Solo')).id
    await db.superTab.update({ where: { id: own }, data: { legacyState: OLD_STATE } })
    expect((await measured('list', () => store.list(solo))).tabs).toEqual([expect.objectContaining({ id: own, name: 'Solo', ownerId: solo.sub })])
    expect(await measured('host grids', () => store.hostGrids(solo))).toEqual([expect.objectContaining({ tabId: own, enabled: true })])
    expect(await measured('archive', () => store.archiveFinished(tab, group, []))).toBe(false)
    const requestId = (await run(tab, { type: 'agent.screen', agentId: worker, scrollback: 20 }, host, lead)).result.requestId as string
    expect((await measured('terminal pickup', () => store.hostTerminal(host, 'test-host'))).filter(row => row.tabId === tab).map(row => row.request.id))
      .toEqual([requestId])
    expect(fetched).toEqual([])

    // Reads and writes leave it in place: only the maintenance script removes it.
    for (const id of [tab, own]) expect((await db.superTab.findUnique({ where: { id }, select: { legacyState: true } }))!.legacyState).toEqual(OLD_STATE)
  })
})
