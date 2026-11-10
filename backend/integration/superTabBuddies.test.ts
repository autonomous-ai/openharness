import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { storeOldLeads } from './oldLeads.test-support.js'
import { MongoMemoryReplSet } from 'mongodb-memory-server-core'
import { PrismaClient } from '@prisma/client'
import type { AuthUser } from '../src/lib/ssoAuth.js'
import { SuperTabStore, transaction } from '../src/superTabs/store.js'
import type { Agent, Author, MessageDraft, SuperTabState } from '../src/superTabs/model.js'
import { MemoryAttachmentStore } from '../src/superTabs/attachments.js'
import type { Command } from '../src/superTabs/commands.js'
import { poolRows } from './hostRows.test-support.js'
import { SwarmReads } from '../src/superTabs/read/service.js'
import { beforeFirstWrite } from './interleave.test-support.js'
import { storeAssignment, storeStatus } from './storedWork.test-support.js'
import { storeBuddy, storeProjectBuddy } from './storedBuddies.test-support.js'

// Buddies through the store (buddies.ts): a person's own agent, which they talk to alone and which reads what they read. Nothing
// adds a Buddy since Swarm v4 (2026-11-10): these are the rules for those a v3 release stored, which hold until the conversion
// makes each an ordinary agent (buddyConversion.ts). A fresh loopback replica set, created here.
let replica: MongoMemoryReplSet
let db: PrismaClient
const owner: AuthUser = { sub: '300000000000000000000001', email: 'owner@example.com', autonomousEnv: 'prod', role: 'user' }
const peer: AuthUser = { sub: '300000000000000000000002', email: 'peer@example.com', autonomousEnv: 'prod', role: 'user' }
const watcher: AuthUser = { sub: '300000000000000000000003', email: 'watcher@example.com', autonomousEnv: 'prod', role: 'user' }
// peer's own Mac's daemon, which relays their web app's Swarm requests.
const PEER_COMPUTER = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const peerMac: AuthUser = { ...peer, harnessSessionId: 'peer-mac-session', harnessSessionKind: 'computer' }
const config = { engine: 'claude', model: 'fixture-model', effort: 'high', contextWindow: 200000, engineVersion: 'fixture' }

beforeAll(async () => {
  replica = await MongoMemoryReplSet.create({ binary: { version: '7.0.24', downloadDir: join(tmpdir(), 'harness-super-tab-mongodb-binaries') },
    replSet: { count: 1, ip: '127.0.0.1', storageEngine: 'wiredTiger' } })
  const uri = replica.getUri(`swarm_buddies_test_${randomUUID().replaceAll('-', '_')}`)
  await promisify(execFile)(join(process.cwd(), 'node_modules/.bin/prisma'), ['db', 'push', '--skip-generate'], {
    env: { ...process.env, DATABASE_URL: uri }, timeout: 60000,
  })
  db = new PrismaClient({ datasources: { db: { url: uri } } })
  for (const user of [owner, peer, watcher]) await db.user.create({ data: { id: user.sub, externalId: `fixture-${user.sub}`, email: user.email, autonomousEnv: user.autonomousEnv } })
  for (const [machineId, user] of [['owner-mac', owner], ['peer-mac', peer]] as const) {
    await db.machine.create({ data: { machineId, userId: user.sub, apiKey: `fixture-${machineId}`, managerId: 'fixture', autonomousEnv: 'prod', authMode: 'remote',
      ...(machineId === 'peer-mac' ? { computerId: PEER_COMPUTER, sessionKind: 'computer' } : {}) } })
  }
  // Machines in no Swarm (Dee, 10-29): peer's own laptop and the owner's own laptop.
  for (const [machineId, user, sessionKind] of [['peer-laptop', peer, 'computer'], ['owner-laptop', owner, 'computer']] as const) {
    await db.machine.create({ data: { machineId, userId: user.sub, sessionKind, apiKey: `fixture-${machineId}`, managerId: 'fixture', autonomousEnv: 'prod', authMode: 'remote' } })
  }
})
afterAll(async () => {
  await db?.$disconnect()
  await replica?.stop()
})

/** A Chat with PM from before Buddies replaced it (10-29): nobody opens one now, so a stored group is made one, as
 *  superTabLiveness.test.ts does. What was written or asked there before stays. */
async function closedPmChat(f: { store: SuperTabStore; tab: string }, conversationId: string, personIds: string[]): Promise<string> {
  const people = (await f.store.read(owner, f.tab)).state.people
  const row = await db.swarmGroup.findFirstOrThrow({ where: { tabId: f.tab, key: conversationId } })
  await db.swarmGroup.update({ where: { id: row.id }, data: { data: { ...row.data as object,
    audience: { people: personIds.map(id => ({ id, generation: people.find(p => p.id === id)!.generation })) } } } })
  return conversationId
}

/** A Swarm whose PM runs on the owner's Mac, and peer a member with their own Mac in the Machines list. */
async function swarm(now: () => number = () => Date.now()) {
  const files = new MemoryAttachmentStore()
  const store = new SuperTabStore(db, now, { store: files, prefix: 'super-tabs', publicBase: 'https://cdn.example.test' })
  const tab = (await store.create(owner, randomUUID(), 'Buddies', 'public')).id
  const execute = (command: Command, user = owner, asAgentId?: string, hostMachineId?: string) =>
    store.execute(user, tab, { operationId: randomUUID(), command }, asAgentId, hostMachineId)
  const invitation = await execute({ type: 'invite.create', email: peer.email, role: 'collaborator', conversationId: 'lead' })
  await execute({ type: 'invite.accept', inviteId: invitation.result.inviteId as string }, peer)
  const lead = String((await execute({ type: 'agent.add', conversationId: 'lead', machineId: 'owner-mac', harnessId: randomUUID(), name: 'PM',
    configuration: config, lead: true })).result.agentId)
  await execute({ type: 'machine.contribute', machineId: 'peer-mac', name: 'Peer Mac', cwd: '/swarm', scope: 'swarm', engines: ['claude'], maxAgents: 4 }, peer)
  const generation = (await poolRows(store, peer, 'peer-mac')).find(p => p.tabId === tab)!.machine.generation
  await store.observeMachine(peer, tab, 'peer-mac', { generation, resources: { cpuPercent: 10, memoryTotalBytes: 32e9, memoryUsedBytes: 4e9,
    diskFreeBytes: 120e9, diskTotalBytes: 500e9, projectDiskFreeBytes: 120e9, deviceType: 'Laptop', chip: 'Fixture', os: 'macOS', gpuPercent: null },
  quotas: [], tools: {}, runningHarnessIds: [], stoppedHarnessIds: [] })
  return { store, tab, execute, lead, files }
}
type Swarm = Awaited<ReturnType<typeof swarm>>

/** peer's one Buddy of the Swarm (Dee, 10-31) on peer-mac, in their one Buddy chat, as a v3 release stored it. */
async function swarmBuddy(f: Swarm) {
  const one = await storeBuddy(db, f.tab, { personId: peer.sub, machineId: 'peer-mac', configuration: config })
  return { swarmChat: one.chat, main: one.agentId }
}

/** The Buddy of peer's older chat in [projectId] (spec: Older apps), on the one Buddy's machine, as a v3 release stored it: it reads
 *  that project alone and posts in that chat, as a per-project Buddy did. */
async function oldChatBuddy(f: Swarm, projectId: string) {
  const old = await storeProjectBuddy(db, f.tab, projectId, { personId: peer.sub, machineId: 'peer-mac', configuration: config })
  return { chat: old.chat, agentId: old.agentId }
}

/** peer's Buddy of project [projectId]: the one Buddy, then the Buddy of their older chat there, which every project-scoped rule
 *  below is about. */
async function buddy(f: Swarm, projectId = 'lead') {
  const one = await swarmBuddy(f)
  return { ...one, ...await oldChatBuddy(f, projectId) }
}

describe('a Buddy and the route\'s reads', () => {
  // Scholes's goals, piece 5: the route's read of running CI jobs is the project's agents'; a Buddy routes nothing.
  it('refuses a Buddy the project\'s CI read, as an unavailable project, while the PM reads it', async () => {
    const f = await swarm()
    const { agentId } = await buddy(f)
    await expect(f.store.ciRepository(peer, f.tab, 'lead', agentId)).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 })
    expect(await f.store.ciRepository(owner, f.tab, 'lead', f.lead)).toEqual({ repositoryUrl: null })
  })
})


describe('a person\'s private chat at the store\'s write (security review of #3557)', () => {
  // The command's rows are checked in applyCommand; the store checks every write again, so a notice written off that path with
  // the wrong author still never puts a Lead in a person's chat with their own agent.
  type Write = (tx: unknown, tabId: string, state: SuperTabState, rows: MessageDraft[], sequences: Map<string, number>) => Promise<unknown>
  const write = (f: Swarm, author: (state: SuperTabState) => Author, chat: string) => transaction(db, async tx => {
    const { state } = await f.store.load(tx, peer, f.tab, { groupIds: [chat] })
    const row: MessageDraft = { id: randomUUID(), conversationId: chat, author: author(state), text: 'A line', replyTo: null, recipients: [] }
    return (f.store as unknown as { writeMessages: Write }).writeMessages.call(f.store, tx, f.tab, state, [row], new Map([[row.id, 1_000_000]]))
  })
  const asAgent = (id: string) => (state: SuperTabState): Author => {
    const a = state.agents.find(x => x.id === id)!
    return { kind: 'agent', id: a.id, name: a.name, membershipGeneration: a.membershipGeneration }
  }

  it('refuses any agent but the person\'s own, a Lead included, and writes their own agent\'s line', async () => {
    const f = await swarm()
    const { swarmChat, main } = await swarmBuddy(f)
    await expect(write(f, asAgent(f.lead), swarmChat)).rejects.toMatchObject({ code: 'PRIVATE_CHAT' })
    expect(await db.superTabMessage.count({ where: { tabId: f.tab, conversationId: swarmChat, text: 'A line' } })).toBe(0)
    await write(f, asAgent(main), swarmChat)
    expect(await db.superTabMessage.count({ where: { tabId: f.tab, conversationId: swarmChat, text: 'A line' } })).toBe(1)
  })
})

describe('a Buddy through the store', () => {
  it('is read by its owner and its Buddy alone: neither the Swarm owner nor the PM reads its chat, the one Buddy\'s or an older one', async () => {
    const f = await swarm()
    const { chat, agentId, swarmChat, main } = await buddy(f)
    for (const [conversationId, buddyId] of [[chat, agentId], [swarmChat, main]] as const) {
      await f.execute({ type: 'message.send', conversationId, text: 'A private idea', replyTo: null, recipientIds: [] }, peer)
      const delivered = await db.superTabDelivery.findMany({ where: { tabId: f.tab, conversationId } })
      expect([...new Set(delivered.map(d => d.agentId))]).toEqual([buddyId])
      expect((await f.store.messages(peer, f.tab, conversationId, {}, buddyId)).messages.map(m => m.text)).toContain('A private idea')
      await expect(f.store.messages(owner, f.tab, conversationId, {})).rejects.toThrow('unavailable')
      await expect(f.store.messages(owner, f.tab, conversationId, {}, f.lead)).rejects.toThrow('unavailable')
      expect((await f.store.read(owner, f.tab)).state.conversations.map(c => c.id)).not.toContain(conversationId)
    }
  })

  it('hands its owner\'s own chat messages to the Buddy: the claim and the receipt both go through (prod 10-30, v1.3.71)', async () => {
    const f = await swarm()
    const { chat, agentId } = await buddy(f)
    const sent = String((await f.execute({ type: 'message.send', conversationId: chat, text: 'Summarize my tasks', replyTo: null, recipientIds: [] }, peer)).result.messageId)
    const waiting = (await f.store.deliveries(peer, f.tab, agentId)).find(d => d.messageId === sent)!
    expect(waiting).toMatchObject({ status: 'queued' })
    const claimId = randomUUID()
    const claimed = await f.store.delivery(peer, f.tab, agentId, waiting.id, { type: 'claim', claimId })
    expect(claimed).toMatchObject({ message: { id: sent, conversationId: chat } })
    await f.store.delivery(peer, f.tab, agentId, waiting.id, { type: 'ack', claimId, receipt: 'r-1', uncertain: false })
    expect(await db.superTabDelivery.findUniqueOrThrow({ where: { id: waiting.id } })).toMatchObject({ status: 'delivered', receipt: 'r-1' })
  })

  it('reads its project\'s work as its person: which task owns it, its pull request, its state and what blocks it', async () => {
    const f = await swarm()
    // Opened before Buddies were on: the owner's private chat with the PM, which their Buddy may never read either.
    const owners = await closedPmChat(f, String((await f.execute({ type: 'conversation.create', projectId: 'lead', title: 'owner', brief: '',
      checks: [] })).result.conversationId), [owner.sub])
    const { agentId } = await buddy(f)
    const group = String((await f.execute({ type: 'conversation.create', projectId: 'lead', title: 'Offline sync', brief: 'Desktop keeps edits offline.',
      checks: [{ description: 'Edits survive a restart', independent: false }], priority: 'P2', requesterId: owner.sub })).result.conversationId)
    const builder = String((await f.execute({ type: 'agent.add', conversationId: group, machineId: 'owner-mac', harnessId: randomUUID(), name: 'Builder',
      configuration: config, lead: false })).result.agentId)
    await storeAssignment(db, f.tab, group, builder)
    await f.execute({ type: 'message.send', conversationId: group, text: 'Opened https://github.com/acme/app/pull/12', replyTo: null, recipientIds: [] }, owner, builder)
    await storeStatus(db, f.tab, group, 'needs_human', 'Ship it behind a flag?')

    const read = await new SwarmReads(f.store).firstLoad(peer, f.tab, agentId)
    const task = read.groups.find(g => g.key === group)!.data
    expect(task).toMatchObject({ title: 'Offline sync', pullRequestUrls: ['https://github.com/acme/app/pull/12'],
      assignment: { agentId: builder, status: 'needs_human', result: 'Ship it behind a flag?' }, checks: [{ description: 'Edits survive a restart' }] })
    expect(read.agents.map(a => a.data.name)).toContain('Builder')
    expect(read.groups.map(g => g.key)).not.toContain(owners)
    expect([read.machines, read.starts]).toEqual([[], []])
    // No machine or terminal id on any agent or assignment, in the first load or in what changed since (review 1, item 3).
    expect(read.agents.map(a => [a.data.machineId, a.data.harnessId])).toEqual(read.agents.map(() => ['', '']))
    expect(task.assignment).toMatchObject({ execution: { machineId: '', harnessId: '' } })
    await f.execute({ type: 'message.send', conversationId: group, text: 'Still waiting.', replyTo: null, recipientIds: [] }, owner, builder)
    const changed = await new SwarmReads(f.store).changes(peer, f.tab, read.cursor, agentId)
    expect('reload' in changed && changed.reload).toBe(false)
    const again = (changed as { groups: Array<{ key: string; data?: { assignment?: unknown } }> }).groups.find(g => g.key === group)
    expect(again?.data?.assignment).toMatchObject({ execution: { machineId: '', harnessId: '' } })
    expect(JSON.stringify([read, changed])).not.toContain('owner-mac')
    const messages = await f.store.messages(peer, f.tab, group, {}, agentId)
    expect(messages.messages.map(m => m.text)).toContain('Opened https://github.com/acme/app/pull/12')
  })

  it('is refused another person\'s private chat, the Leads conversation and another project', async () => {
    const f = await swarm()
    const owners = await closedPmChat(f, String((await f.execute({ type: 'conversation.create', projectId: 'lead', title: 'owner', brief: '',
      checks: [] })).result.conversationId), [owner.sub])
    const web = (await f.execute({ type: 'project.create', name: 'Web', visibility: 'public', brief: '' })).result as { projectId: string; conversationId: string }
    const landing = String((await f.execute({ type: 'conversation.create', projectId: web.projectId, title: 'Landing', brief: '', checks: [] })).result.conversationId)
    const { agentId } = await buddy(f)
    // An older Swarm's stored Leads conversation: removed for everyone (model.ts leadsRemoved), its Buddy included.
    const { id: leads } = await storeOldLeads(db, f.tab, [f.lead], { kind: 'person', id: owner.sub, name: owner.email, membershipGeneration: f.tab })
    for (const conversationId of [owners, web.conversationId, landing]) {
      await expect(f.store.messages(peer, f.tab, conversationId, {}, agentId)).rejects.toThrow('unavailable')
    }
    await expect(f.store.messages(peer, f.tab, leads, {}, agentId)).rejects.toMatchObject({ code: 'LEADS_CONVERSATION_REMOVED' })
    const read = await new SwarmReads(f.store).firstLoad(peer, f.tab, agentId)
    for (const id of [owners, web.conversationId, landing, leads]) expect(read.groups.map(g => g.key)).not.toContain(id)
  })
  it('reads no routing: no route rows in its task\'s messages, no routing decisions, no routing policy (security review 2 of #2115)', async () => {
    const f = await swarm()
    const { agentId } = await buddy(f)
    const group = String((await f.execute({ type: 'conversation.create', projectId: 'lead', title: 'Offline sync', brief: 'Keep edits.',
      checks: [{ description: 'Edits survive a restart', independent: false }] })).result.conversationId)
    const builder = String((await f.execute({ type: 'agent.add', conversationId: group, machineId: 'owner-mac', harnessId: randomUUID(), name: 'Builder',
      configuration: { ...config, model: 'opus' }, lead: false })).result.agentId)
    const decision = { assessment: { difficulty: 'low', risk: 'low', why: 'Small task.' },
      candidates: [{ id: 'c0', kind: 'new', machineId: 'owner-mac', engine: 'claude', model: 'opus', effort: 'high',
        quality: 3, cost: 3, title: 'New agent on Kens-MacBook-Pro.local', label: 'New agent' }],
      excluded: [], floor: 1, notes: false, pick: 'c0', via: 'only', p: null, belowFloor: false, why: 'Only candidate.' }
    const routeDecisionId = String((await f.execute({ type: 'route.record', conversationId: group, decision } as Command, owner, f.lead)).result.routeDecisionId)
    await storeAssignment(db, f.tab, group, builder)
    await f.execute({ type: 'message.send', conversationId: group, text: 'Starting now.', replyTo: null, recipientIds: [] }, owner, builder)

    const pm = (await f.store.messages(owner, f.tab, group, {}, f.lead)).messages
    const routed = pm.filter(m => ['route', 'route-override'].includes(String((m.source as { kind?: unknown } | null)?.kind)))
    expect(routed.length).toBeGreaterThan(0)
    const seen = (await f.store.messages(peer, f.tab, group, {}, agentId)).messages
    expect(seen.map(m => m.text)).toContain('Starting now.')
    expect(JSON.stringify(seen)).not.toContain('Kens-MacBook-Pro.local')
    expect(seen.map(m => m.id)).not.toEqual(expect.arrayContaining([routed[0]!.id]))
    for (const row of routed) await expect(f.store.messages(peer, f.tab, group, { messageId: row.id }, agentId)).resolves.toMatchObject({ messages: [] })
    expect((await f.store.routeDecisions(owner, f.tab, f.lead)).map(d => d.id)).toContain(routeDecisionId)
    await expect(f.store.routeDecisions(peer, f.tab, agentId)).rejects.toThrow('A Buddy reads no routing')
    await expect(f.store.routeDecision(peer, f.tab, routeDecisionId, agentId)).rejects.toThrow('A Buddy reads no routing')
    await expect(f.store.tabPolicy(peer, f.tab, agentId)).rejects.toThrow('A Buddy reads no routing')
    // What routed attempts cost (main's #2106) is routing too.
    await expect(f.store.costSummary(owner, f.tab, 7, f.lead)).resolves.toMatchObject({ days: 7 })
    await expect(f.store.costSummary(peer, f.tab, 7, agentId)).rejects.toThrow('A Buddy reads no routing')
  })

  it('still cannot read historical routing reports', async () => {
    const f = await swarm()
    const { agentId } = await buddy(f)
    const report = await db.superTabMessage.create({ data: { id: randomUUID(), tabId: f.tab, conversationId: 'lead', sequence: 1,
      author: { kind: 'agent', id: f.lead, name: 'Lead' }, recipientIds: [], mentions: [], text: 'Routing reflection: an old report.',
      source: { kind: 'routing-reflection', projectId: 'lead', on: '2026-10-29' } } })
    expect((await f.store.messages(peer, f.tab, 'lead', { messageId: report.id })).messages).toEqual([
      expect.objectContaining({ id: report.id, text: report.text }),
    ])
    expect((await f.store.messages(peer, f.tab, 'lead', {}, agentId)).messages.map(m => m.id)).not.toContain(report.id)
    await expect(f.store.messages(peer, f.tab, 'lead', { messageId: report.id }, agentId)).resolves.toMatchObject({ messages: [] })
  })

  it('reads a task archived by hand in the dormant view at once, with no report to wait for (security review 1 of #2115, #3593)', async () => {
    const f = await swarm()
    const { agentId } = await buddy(f)
    const group = String((await f.execute({ type: 'conversation.create', projectId: 'lead', title: 'Old task', brief: '', checks: [] })).result.conversationId)
    await f.execute({ type: 'conversation.archive', conversationId: group, archived: true } as Command)
    const reads = new SwarmReads(f.store)
    expect((await reads.firstLoad(peer, f.tab, agentId)).groups.some(g => g.key === group)).toBe(false)
    expect((await reads.dormant(peer, f.tab, { projectId: 'lead' }, agentId)).groups.find(g => g.key === group)?.data).toMatchObject({ archived: true })
  })

  it('never hears of a machine removed from the Swarm in its change feed, though the PM does (security review 2 of #2115)', async () => {
    const f = await swarm()
    const { agentId } = await buddy(f)
    await db.machine.create({ data: { machineId: 'owner-studio', userId: owner.sub, apiKey: 'fixture-owner-studio', managerId: 'fixture', autonomousEnv: 'prod', authMode: 'remote' } })
    await f.execute({ type: 'machine.contribute', machineId: 'owner-studio', name: 'Owner Studio', cwd: '/swarm', scope: 'swarm', engines: ['claude'], maxAgents: 2 })
    const generation = (await poolRows(f.store, owner, 'owner-studio')).find(p => p.tabId === f.tab)!.machine.generation
    await f.store.observeMachine(owner, f.tab, 'owner-studio', { generation, resources: { cpuPercent: 10, memoryTotalBytes: 32e9, memoryUsedBytes: 4e9,
      diskFreeBytes: 120e9, diskTotalBytes: 500e9, projectDiskFreeBytes: 120e9, deviceType: 'Desktop', chip: 'Fixture', os: 'macOS', gpuPercent: null },
    quotas: [], tools: {}, runningHarnessIds: [], stoppedHarnessIds: [] })
    const reads = new SwarmReads(f.store)
    const [buddyFirst, pmFirst] = [await reads.firstLoad(peer, f.tab, agentId), await reads.firstLoad(owner, f.tab, f.lead)]
    expect(pmFirst.machines.map(m => m.key)).toContain('owner-studio')
    expect(buddyFirst.machines).toEqual([])

    const removalId = String((await f.execute({ type: 'machine.remove', machineId: 'owner-studio' })).result.removalId)
    await f.store.execute(owner, f.tab, { operationId: `machine-cleaned-${removalId}`, command: { type: 'machine.cleaned', machineId: 'owner-studio', removalId } })
    const pm = await reads.changes(owner, f.tab, pmFirst.cursor, f.lead)
    expect('reload' in pm && pm.reload).toBe(false)
    expect((pm as { machines: Array<{ key: string; deleted?: boolean }> }).machines).toContainEqual(expect.objectContaining({ key: 'owner-studio', deleted: true }))
    const seen = await reads.changes(peer, f.tab, buddyFirst.cursor, agentId)
    expect('reload' in seen && seen.reload).toBe(false)
    expect((seen as { machines: unknown[] }).machines).toEqual([])
    expect(JSON.stringify(seen)).not.toMatch(/owner-studio|Owner Studio/)
  })

  it('reads the Product Manager\'s start without its machine: not on the project, its first load, its change feed or the joined row (Diego, 10-30)', async () => {
    const f = await swarm()
    // A project with no Product Manager yet: its person starts one on the machine they name (leadStart.ts).
    const app = (await f.execute({ type: 'project.create', name: 'App', visibility: 'public', brief: '' })).result as { projectId: string; conversationId: string }
    const { agentId } = await buddy(f, app.projectId)
    await f.execute({ type: 'machine.contribute', machineId: 'owner-mac', name: 'Kens-Mac-Studio.local', cwd: '/swarm', scope: 'swarm', engines: ['claude'], maxAgents: 2 })
    const generation = (await poolRows(f.store, owner, 'owner-mac')).find(p => p.tabId === f.tab)!.machine.generation
    await f.store.observeMachine(owner, f.tab, 'owner-mac', { generation, resources: { cpuPercent: 10, memoryTotalBytes: 32e9, memoryUsedBytes: 4e9,
      diskFreeBytes: 120e9, diskTotalBytes: 500e9, projectDiskFreeBytes: 120e9, deviceType: 'Desktop', chip: 'Fixture', os: 'macOS', gpuPercent: null },
    quotas: [], tools: {}, runningHarnessIds: [], stoppedHarnessIds: [], capabilities: ['leadStart'] } as Parameters<SuperTabStore['observeMachine']>[3])
    const reads = new SwarmReads(f.store)
    const [buddyFirst, pmFirst] = [await reads.firstLoad(peer, f.tab, agentId), await reads.firstLoad(owner, f.tab)]
    const startId = String((await f.execute({ type: 'lead.start', projectId: app.projectId, machineId: 'owner-mac', engine: 'claude',
      repositoryUrl: 'https://github.com/example/app' })).result.startId)
    const leadIn = (read: { head: { data: { projects?: Array<{ id: string; lead?: unknown }> } } | null }) => read.head?.data.projects?.find(p => p.id === app.projectId)?.lead
    const leak = new RegExp(`owner-mac|Kens-Mac-Studio|${startId}`)

    // Starting: a person's change feed says on which machine; the Buddy's says only that it is starting.
    const pmChanges = await reads.changes(owner, f.tab, pmFirst.cursor)
    expect('reload' in pmChanges && pmChanges.reload).toBe(false)
    expect(leadIn(pmChanges as never)).toEqual({ status: 'starting', machineId: 'owner-mac', machineName: 'Kens-Mac-Studio.local', startId })
    const seen = await reads.changes(peer, f.tab, buddyFirst.cursor, agentId)
    expect('reload' in seen && seen.reload).toBe(false)
    expect(leadIn(seen as never)).toEqual({ status: 'starting' })
    expect(JSON.stringify(seen)).not.toMatch(leak)

    // Started (its joining the Leads conversation reloads every reader): the same in each first load.
    const host = (command: Command) => f.execute(command, owner, undefined, 'owner-mac')
    await host({ type: 'agent.startDispatch', startId })
    await host({ type: 'agent.started', startId, harnessId: randomUUID(), configuration: config })
    expect(leadIn(await reads.firstLoad(owner, f.tab))).toEqual({ status: 'started', machineId: 'owner-mac', machineName: 'Kens-Mac-Studio.local', startId })
    const first = await reads.firstLoad(peer, f.tab, agentId)
    expect(leadIn(first)).toEqual({ status: 'started' })
    expect(JSON.stringify(first)).not.toMatch(leak)

    // The joined row: its machine for people, "a machine" for the Buddy, in its page and when it reads that row alone. It says
    // the PM runs another model than it asked for (#2274), which names no machine and stays.
    const asked = 'It asked for opus at xhigh and runs fixture-model at high there.'
    const joined = (await f.store.messages(owner, f.tab, app.conversationId, {})).messages.find(m => m.text.startsWith('Product Manager started on'))!
    expect(joined.text).toBe(`Product Manager started on Kens-Mac-Studio.local. ${asked}`)
    expect((await f.store.messages(peer, f.tab, app.conversationId, {})).messages.map(m => m.text)).toContain(joined.text)
    const page = (await f.store.messages(peer, f.tab, app.conversationId, {}, agentId)).messages
    const alone = (await f.store.messages(peer, f.tab, app.conversationId, { messageId: joined.id }, agentId)).messages
    expect([page.find(m => m.id === joined.id)?.text, alone.map(m => m.text)]).toEqual([`Product Manager started on a machine. ${asked}`, [`Product Manager started on a machine. ${asked}`]])
    expect(JSON.stringify([page, alone])).not.toMatch(leak)

    // A joined row stored before its source named the machine (a plain system row) reads the same, with or without the model
    // sentence: stored rows stay as written, and people read them in full.
    const buddyReads = async () => (await f.store.messages(peer, f.tab, app.conversationId, { messageId: joined.id }, agentId)).messages.map(m => m.text)
    const peopleRead = async () => (await f.store.messages(peer, f.tab, app.conversationId, { messageId: joined.id })).messages.map(m => m.text)
    await db.superTabMessage.update({ where: { id: joined.id }, data: { source: { kind: 'system' } } })
    expect(await buddyReads()).toEqual([`Product Manager started on a machine. ${asked}`])
    expect(await peopleRead()).toEqual([joined.text])
    await db.superTabMessage.update({ where: { id: joined.id }, data: { text: 'Product Manager started on Kens-Mac-Studio.local.' } })
    expect(await buddyReads()).toEqual(['Product Manager started on a machine.'])
    expect(await peopleRead()).toEqual(['Product Manager started on Kens-Mac-Studio.local.'])

    // A removed session's notice names its machine too (liveness.ts unpurged; review 2 of #2258): as it is stored now, and as
    // it was stored before its source named it.
    const notice = (machine: string) => `The saved session of a removed agent that held people's private chats, on ${machine}, is not deleted yet, so its Harness Team account takes no other project's work until it is.`
    await db.superTabMessage.update({ where: { id: joined.id }, data: { text: notice('Kens-Mac-Studio.local'), source: { kind: 'system', machine: 'Kens-Mac-Studio.local' } } })
    expect(await buddyReads()).toEqual([notice('a machine')])
    await db.superTabMessage.update({ where: { id: joined.id }, data: { source: { kind: 'system' } } })
    expect(await buddyReads()).toEqual([notice('a machine')])
    expect(await peopleRead()).toEqual([notice('Kens-Mac-Studio.local')])
  })
})

describe('a Buddy matching agents to people (delta review 1 of #2258)', () => {
  it('matches no agent to a person by membership: not on its roster, nor by who wrote a row; a person\'s row keeps theirs', async () => {
    const f = await swarm()
    const { agentId } = await buddy(f)
    const send = async (text: string, user: typeof owner, asAgentId?: string, replyTo: string | null = null) => String((await f.execute({ type: 'message.send',
      conversationId: 'lead', text, replyTo, recipientIds: [] }, user, asAgentId)).result.messageId)
    const pmRow = await send('The plan is up.', owner, f.lead), personRow = await send('Thanks.', peer)
    await send('Glad it helps.', owner, f.lead, personRow)
    // The PM's grant as an older share policy wrote it, naming its contributor's email (lib/machineSharePolicy.ts).
    const stored = await db.swarmAgent.findFirstOrThrow({ where: { tabId: f.tab, key: f.lead } })
    await db.swarmAgent.update({ where: { id: stored.id }, data: { data: { ...stored.data as object, hostGrant: `share-1:email:${owner.email}` } } })
    const people = (await f.store.read(owner, f.tab)).state.people
    const generations = new Set(people.map(p => p.generation))
    const peerGeneration = people.find(p => p.id === peer.sub)!.generation

    // The roster: no agent but itself at a membership that matches a person's.
    const first = await new SwarmReads(f.store).firstLoad(peer, f.tab, agentId)
    const roster = first.agents.map(a => a.data)
    expect(roster.map(a => a.id)).toContain(f.lead)
    expect(roster.filter(a => a.id !== agentId && generations.has(a.membershipGeneration)).map(a => a.id)).toEqual([])
    // Nor by the grant it runs under, which may name its contributor (final check of #2258).
    expect(roster.filter(a => a.id !== agentId).map(a => a.hostGrant ?? null)).toEqual(roster.filter(a => a.id !== agentId).map(() => null))
    expect(JSON.stringify(roster)).not.toContain(`email:${owner.email}`)
    expect((await new SwarmReads(f.store).firstLoad(owner, f.tab)).agents.find(a => a.key === f.lead)!.data.hostGrant).toBe(`share-1:email:${owner.email}`)
    expect(roster.find(a => a.id === agentId)!.membershipGeneration).toBe(peerGeneration)

    // Rows: an agent's has no membership, in the page and read alone; a person's keeps theirs, which its host compares.
    const authors = (rows: Array<{ id: string; author: { membershipGeneration: string } }>) =>
      [pmRow, personRow].map(id => rows.find(m => m.id === id)?.author.membershipGeneration)
    const page = await f.store.messages(peer, f.tab, 'lead', {}, agentId)
    expect(authors(page.messages)).toEqual(['', peerGeneration])
    // Nor among a thread's reply authors.
    expect(page.threads.find(t => t.id === personRow)!.authors.map(a => [a.kind, a.membershipGeneration])).toEqual([['agent', '']])
    expect(authors((await f.store.messages(peer, f.tab, 'lead', { messageId: pmRow }, agentId)).messages)).toEqual(['', undefined])
    // People and the PM read every author as written.
    const pmGeneration = (await f.store.messages(owner, f.tab, 'lead', {})).messages.find(m => m.id === pmRow)!.author.membershipGeneration
    expect(generations.has(pmGeneration)).toBe(true)
    const pmPage = await f.store.messages(owner, f.tab, 'lead', {}, f.lead)
    expect(authors(pmPage.messages)).toEqual([pmGeneration, peerGeneration])
    expect(pmPage.threads.find(t => t.id === personRow)!.authors.map(a => a.membershipGeneration)).toEqual([pmGeneration])
  })
})

// Only the person and their own agent post in their private chat (anh Dee, 11-07, task #4558): the PM's private line, which
// opened a person's Buddy chat before any Buddy (Ken, 10-29), is refused, and opens no chat.
describe('a PM\'s private line to a person (task #4558)', () => {
  const tell = (text: string) => ({ type: 'person.tell' as const, personId: peer.sub, text })
  const chats = async (tab: string) => (await db.swarmGroup.findMany({ where: { tabId: tab, deleted: false } }))
    .filter(row => ['buddy', 'swarm-buddy'].includes(String((row.data as { kind?: string }).kind))).map(row => row.key)

  it('is refused, naming where to post instead, writes nothing in the person\'s chat, and the PM still cannot read it', async () => {
    const f = await swarm()
    const { chat } = await oldChatBuddy(f, 'lead')
    await expect(f.execute(tell('Your fix is merged.'), owner, f.lead)).rejects.toMatchObject({ code: 'PRIVATE_CHAT', message: expect.stringContaining('project chat') })
    expect(await db.superTabMessage.count({ where: { tabId: f.tab, conversationId: chat } })).toBe(0)
    await expect(f.store.messages(owner, f.tab, chat, {}, f.lead)).rejects.toThrow('unavailable')
    expect(await db.superTabDelivery.count({ where: { tabId: f.tab, conversationId: chat } })).toBe(0)
  })

  it('opens no Buddy chat for the person, and tells the PM first when they cannot read the project', async () => {
    const f = await swarm()
    await expect(f.execute(tell('First.'), owner, f.lead)).rejects.toMatchObject({ code: 'PRIVATE_CHAT' })
    expect(await chats(f.tab)).toEqual([])
    await f.execute({ type: 'project.sharing', projectId: 'lead', visibility: 'private', memberIds: [] })
    await expect(f.execute(tell('Second.'), owner, f.lead)).rejects.toThrow('cannot read this project')
    expect(await chats(f.tab)).toEqual([])
  })

  // People talk only to the PM (anh Dee, 11-05; crewNeeds.ts, task #3404): another agent's line is the PM's crew need.
  it('gives the PM another agent\'s line as a crew need, and opens no Buddy chat for it', async () => {
    const f = await swarm()
    const engineer = String((await f.execute({ type: 'agent.add', conversationId: 'lead', machineId: 'owner-mac', harnessId: randomUUID(), name: 'Engineer',
      configuration: config, lead: false })).result.agentId)
    await f.execute(tell('From the Engineer.'), owner, engineer)
    const needs = (await db.superTabMessage.findMany({ where: { tabId: f.tab, conversationId: 'lead' } }))
      .filter(m => (m.source as { kind?: string } | null)?.kind === 'crew-need')
    expect(needs).toEqual([expect.objectContaining({ recipientIds: [f.lead], source: expect.objectContaining({ crewNeed: expect.objectContaining({ agentId: engineer, personIds: [peer.sub] }) }) })])
    expect(await chats(f.tab)).toEqual([])
  })
})

// News went to the person's one Buddy, which posts only in their own chat (spec 3: "News ... goes to the main Buddy"): a delivery
// its row does not list among its recipients. Nothing writes news since Swarm v4 (2026-11-10); the rules for what a v3 release
// left are read here: its Buddy is handed it only while its person reads there, and nobody else learns whose Buddy heard.
describe('a Buddy\'s news of its person\'s requests (Diego, 10-29)', () => {
  /** peer's proposal in the project chat, as the Buddy of their older chat there posted it until proposals went (2026-11-10): their
   *  words, with the goal and scope it wrote. [agentId] is their one Buddy, which heard the news. */
  async function proposed() {
    const f = await swarm()
    const { chat, agentId: proposer, main: agentId, swarmChat } = await buddy(f)
    const proposal = String((await f.execute({ type: 'message.send', conversationId: 'lead', text: 'Send it to the PM', replyTo: null, recipientIds: [f.lead] }, peer)).result.messageId)
    await db.superTabMessage.update({ where: { id: proposal }, data: { source: { kind: 'buddy-proposal', personId: peer.sub, buddyId: proposer, goal: 'Offline sync',
      scope: 'Desktop only', priority: 'normal' } } })
    const pm = (text: string, extra: { replyTo?: string } = {}) => f.execute({ type: 'message.send', conversationId: 'lead', text,
      replyTo: extra.replyTo ?? null, recipientIds: [] }, owner, f.lead)
    /** The PM's line [messageId] as news for [buddyId], as a v3 release delivered it: one delivery, the row naming no such recipient. */
    const news = async (messageId: string, buddyId = agentId) => {
      const row = await db.superTabMessage.findUniqueOrThrow({ where: { id: messageId } })
      const stored = async (key: string) => (await db.swarmAgent.findFirstOrThrow({ where: { tabId: f.tab, key } })).data as unknown as Agent
      const [to, from] = [await stored(buddyId), await stored(f.lead)]
      return db.superTabDelivery.create({ data: { id: randomUUID().replaceAll('-', '').slice(0, 24), tabId: f.tab, conversationId: row.conversationId,
        messageId, agentId: to.id, machineId: to.machineId, machineOwnerId: to.machineOwnerId, membershipGeneration: to.membershipGeneration,
        authorKind: 'agent', authorId: from.id, authorGeneration: from.membershipGeneration, status: 'queued' } })
    }
    /** What peer's host is handed for a Buddy from outside its person's Buddy chats, by message. */
    const heard = async (buddyId = agentId) => (await f.store.deliveries(peer, f.tab, buddyId)).filter(d => ![chat, swarmChat].includes(d.conversationId))
      .map(d => d.messageId)
    return { f, agentId, proposer, proposal, pm, news, heard }
  }

  it('hands its news to the Buddy as news, and no reader learns whose Buddy heard', async () => {
    const { f, agentId, proposal, pm, news, heard } = await proposed()
    const answer = String((await pm('Taking it: a task opens now.', { replyTo: proposal })).result.messageId)
    const delivery = await news(answer)
    expect(await heard()).toEqual([answer])
    // Picked up as project news: the host tells the Buddy it is news for its owner, not a message to answer there.
    const claimed = await f.store.delivery(peer, f.tab, agentId, delivery.id, { type: 'claim', claimId: randomUUID() })
    expect(claimed).toMatchObject({ buddyNews: true, message: { id: answer, conversationId: 'lead' } })
    // Readers never see whose Buddy listens: not among the answer's recipients, nor its deliveries.
    const shown = (await f.store.messages(owner, f.tab, 'lead', {})).messages.find(m => m.id === answer)!
    expect(shown.recipientIds).not.toContain(agentId)
    expect(shown.deliveries.map(d => d.agentId)).not.toContain(agentId)
  })

  it('refuses what waits at pickup once its person stops reading the project', async () => {
    const { f, agentId, proposal, pm, news, heard } = await proposed()
    const waiting = await news(String((await pm('Taking this as a task.', { replyTo: proposal })).result.messageId))
    await f.execute({ type: 'project.sharing', projectId: 'lead', visibility: 'private', memberIds: [] })
    await expect(f.store.delivery(peer, f.tab, agentId, waiting.id, { type: 'claim', claimId: randomUUID() })).rejects.toThrow('no longer authorized')
    expect(await heard()).toEqual([])
  })

  it('refuses news its person loses after the claim read it but before the claim wrote (security review 1 of #2178)', async () => {
    const { f, agentId, proposal, pm, news } = await proposed()
    const waiting = await news(String((await pm('Private progress: taking it.', { replyTo: proposal })).result.messageId))
    let raced = false
    const racing = new SuperTabStore(beforeFirstWrite(db, async () => {
      if (raced) return
      raced = true
      await f.execute({ type: 'project.sharing', projectId: 'lead', visibility: 'private', memberIds: [] })
    }), () => Date.now())
    const result = await racing.delivery(peer, f.tab, agentId, waiting.id, { type: 'claim', claimId: randomUUID() })
      .then(value => ({ accepted: true, text: value.message?.text }), error => ({ accepted: false, code: error.code }))
    expect(raced).toBe(true)
    expect(await f.store.deliveries(peer, f.tab, agentId)).toEqual([])
    expect(result).toMatchObject({ accepted: false, code: 'DELIVERY_REVOKED' })
  })

  it('keeps whose Buddy heard a line hidden after that Buddy became an ordinary agent (security review 1 of #2178)', async () => {
    const { f, proposal, pm, news } = await proposed()
    const answer = String((await pm('Taking this as a task.', { replyTo: proposal })).result.messageId)
    await news(answer)
    const read = async () => (await f.store.messages(owner, f.tab, 'lead', {})).messages.find(m => m.id === answer)!
    expect((await read()).deliveries).toEqual([])
    // Nor when an agent reads: the PM sees no Buddy among the line's deliveries.
    const asPm = (await f.store.messages(owner, f.tab, 'lead', {}, f.lead)).messages.find(m => m.id === answer)!
    expect(asPm.deliveries).toEqual([])
    await f.store.convertBuddies(f.tab)
    expect((await read()).deliveries).toEqual([])
    // Ordinary deliveries still show: the proposal's to the PM, its listed recipient.
    const sent = (await f.store.messages(owner, f.tab, 'lead', {})).messages.find(m => m.id === proposal)!
    expect(sent.deliveries.map(d => d.agentId)).toEqual([f.lead])
  })

  it('never lets a person resolve a Buddy\'s news delivery: it reads as one that needs no checking (security review 2 of #2178)', async () => {
    const { f, proposal, pm, news } = await proposed()
    const delivery = await news(String((await pm('Taking this as a task.', { replyTo: proposal })).result.messageId))
    await db.superTabDelivery.update({ where: { id: delivery.id }, data: { status: 'uncertain' } })
    for (const resolution of ['received', 'resend', 'cancel'] as const) {
      for (const user of [owner, peer]) {
        await expect(f.execute({ type: 'delivery.resolve', deliveryId: delivery.id, resolution }, user)).rejects.toThrow('This delivery no longer needs checking.')
      }
    }
    expect((await db.superTabDelivery.findUniqueOrThrow({ where: { id: delivery.id } })).status).toBe('uncertain')
  })

  it('is refused at pickup in the Leads conversation, even with a delivery row there (security review 2 of #2178)', async () => {
    const { f, agentId, proposer, news } = await proposed()
    const { messageId: said } = await storeOldLeads(db, f.tab, [f.lead], { kind: 'person', id: owner.sub, name: owner.email, membershipGeneration: f.tab }, 'Leads only.')
    // The older chat's Buddy, and the one Buddy, which reads every project, are refused there alike.
    for (const buddyId of [proposer, agentId]) {
      const planted = await news(said, buddyId)
      expect((await f.store.deliveries(peer, f.tab, buddyId)).map(d => d.id)).not.toContain(planted.id)
      await expect(f.store.delivery(peer, f.tab, buddyId, planted.id, { type: 'claim', claimId: randomUUID() })).rejects.toThrow('no longer authorized')
    }
  })

  it('hands a Buddy a claimed row without the machine it names (security review 2 of #2178)', async () => {
    const { f, agentId, proposal, pm, news } = await proposed()
    const answer = String((await pm('Taking this as a task.', { replyTo: proposal })).result.messageId)
    // A machine-removed row's shape (commands.ts removeMachine), as if it were news: what reaches the Buddy names no machine.
    await db.superTabMessage.update({ where: { id: answer }, data: { text: 'Studio Mac left the Swarm.', source: { kind: 'machine-removed', machine: 'Studio Mac' } } })
    const delivery = await news(answer)
    const claimed = await f.store.delivery(peer, f.tab, agentId, delivery.id, { type: 'claim', claimId: randomUUID() })
    expect(JSON.stringify(claimed.message)).not.toContain('Studio Mac')
    expect(claimed.message).toMatchObject({ text: 'A machine left the Swarm.' })
  })
})

describe('a person\'s post in their Buddy chat from the web (phone bug, 10-29)', () => {
  // The web app relays a person's Swarm requests through one of their online machines: through their own Mac it is theirs.
  const post = (chat: string, text: string) => ({ type: 'message.send' as const, conversationId: chat, text, replyTo: null, recipientIds: [] })
  const stored = (f: Awaited<ReturnType<typeof swarm>>, chat: string) => db.superTabMessage.findMany({ where: { tabId: f.tab, conversationId: chat } })
  const delivered = async (f: Awaited<ReturnType<typeof swarm>>, chat: string) =>
    (await db.superTabDelivery.findMany({ where: { tabId: f.tab, conversationId: chat } })).map(d => d.agentId)

  it('is accepted through their own Mac\'s sign-in and delivered to their Buddy alone', async () => {
    const f = await swarm()
    const { chat, agentId } = await buddy(f)
    await f.execute(post(chat, 'From my phone'), peerMac)
    expect([...new Set(await delivered(f, chat))]).toEqual([agentId])
    expect((await f.store.messages(peer, f.tab, chat, {}, agentId)).messages.at(-1)).toMatchObject({ text: 'From my phone',
      author: expect.objectContaining({ kind: 'person', id: peer.sub }) })
  })

  it('is nobody else\'s: the Swarm owner, the PM and a viewer are refused alike, told nothing about the chat', async () => {
    const f = await swarm()
    const invitation = await f.execute({ type: 'invite.create', email: watcher.email, role: 'viewer', conversationId: 'lead' })
    await f.execute({ type: 'invite.accept', inviteId: invitation.result.inviteId as string }, watcher)
    const { chat } = await buddy(f)
    const before = (await stored(f, chat)).length, deliveredBefore = await delivered(f, chat)
    const refusal = (conversation: string, user: AuthUser, asAgentId?: string) => f.execute(post(conversation, 'Not mine'), user, asAgentId)
      .then(() => null, (error: Error & { code?: string; status?: number }) => ({ code: error.code, status: error.status, message: error.message }))
    for (const [user, asAgentId] of [[owner, undefined], [owner, f.lead], [watcher, undefined]] as const) {
      // Refused exactly as for a chat that does not exist (a viewer, for being one), naming neither peer nor the chat.
      const answer = await refusal(chat, user, asAgentId)
      expect(answer).not.toBeNull()
      expect(answer).toEqual(await refusal('ffffffffffffffffffffffff', user, asAgentId))
      expect(answer!.message).not.toMatch(/peer|Buddy/i)
    }
    expect((await stored(f, chat)).length).toBe(before)
    expect(await delivered(f, chat)).toEqual(deliveredBefore)
  })
})

// A Buddy on one of its person's own machines that is in no Swarm (Dee, 10-29): the machine is recorded Buddy-only, and only
// that machine's person learns of it. Nothing records one since Swarm v4; this is one a v3 release stored.
describe('a Buddy on its person\'s own machine outside the Swarm, through the store', () => {
  // Security review 1 of #2234: the change feed sent the record to every member as a change of that machine id.
  it('never reaches another reader, by first load or change feed, nor its own person as a machine', async () => {
    const f = await swarm()
    const reads = new SwarmReads(f.store)
    const others = [{ user: owner, as: undefined }, { user: owner, as: f.lead }] as const
    const cursors = await Promise.all(others.map(o => reads.firstLoad(o.user, f.tab, o.as).then(r => r.cursor)))
    const mine = (await reads.firstLoad(peer, f.tab)).cursor
    const { agentId } = await storeBuddy(db, f.tab, { personId: peer.sub, machineId: 'peer-laptop', configuration: config, ownMachine: 'Peer Laptop' })
    for (const [i, o] of others.entries()) {
      expect(JSON.stringify(await reads.firstLoad(o.user, f.tab, o.as))).not.toMatch(/peer-laptop|Peer Laptop/)
      expect(JSON.stringify(await reads.changes(o.user, f.tab, cursors[i]!, o.as))).not.toMatch(/peer-laptop|Peer Laptop/)
      expect(((await f.store.read(o.user, f.tab, o.as)).state.machines ?? []).map(m => m.machineId)).not.toContain('peer-laptop')
    }
    expect((await f.store.read(peer, f.tab)).state.agents.find(a => a.id === agentId)).toMatchObject({ machineId: 'peer-laptop', buddyOf: { personId: peer.sub } })
    expect(((await f.store.read(peer, f.tab)).state.machines ?? []).map(m => m.machineId)).not.toContain('peer-laptop')
    const changed = await reads.changes(peer, f.tab, mine) as { machines?: Array<{ key: string }> }
    expect((changed.machines ?? []).map(m => m.key)).not.toContain('peer-laptop')
  })
})

describe('the person\'s own browser, reading and writing the Swarm straight from the web (docs/specs/2026-10-30-web-swarm-direct.md)', () => {
  // A browser signed in by a computer's QR holds a viewer session; one signed in with Autonomous holds the person's own
  // token (`peer` here). Either is the person, as their own Mac's sign-in that relayed the web's requests until now.
  const peerWeb: AuthUser = { ...peer, harnessSessionId: 'peer-web-session', harnessSessionKind: 'viewer' }
  const ownerWeb: AuthUser = { ...owner, harnessSessionId: 'owner-web-session', harnessSessionKind: 'viewer' }
  const refusal = (read: Promise<unknown>) => read.then(() => null, (error: { code?: string; status?: number; message?: string }) =>
    ({ code: error.code, status: error.status, message: error.message }))

  it('reads the Swarm list, the Swarm and its person\'s Buddy chat, and posts there, exactly as their own Mac does', async () => {
    const f = await swarm()
    const { chat } = await buddy(f)
    await f.execute({ type: 'message.send', conversationId: chat, text: 'From the browser', replyTo: null, recipientIds: [] }, peerWeb)
    await f.execute({ type: 'message.send', conversationId: chat, text: 'From the Mac', replyTo: null, recipientIds: [] }, peerMac)
    const reads = new SwarmReads(f.store)
    for (const signIn of [peerWeb, peer]) {
      expect((await reads.list(signIn)).tabs.map(t => t.id)).toEqual((await reads.list(peerMac)).tabs.map(t => t.id))
      const keys = (await reads.firstLoad(signIn, f.tab)).groups.map(g => g.key).sort()
      expect(keys).toEqual((await reads.firstLoad(peerMac, f.tab)).groups.map(g => g.key).sort())
      expect(keys).toContain(chat)
      expect((await f.store.messages(signIn, f.tab, chat, {})).messages.map(m => m.text))
        .toEqual((await f.store.messages(peerMac, f.tab, chat, {})).messages.map(m => m.text))
    }
    expect((await f.store.messages(peerWeb, f.tab, chat, {})).messages.map(m => m.text))
      .toEqual(expect.arrayContaining(['From the browser', 'From the Mac']))
  })

  it('is refused another person\'s Buddy chat, a private project and another Swarm as their own Mac is, with no name', async () => {
    const f = await swarm()
    const { chat } = await buddy(f)
    const hidden = (await f.execute({ type: 'project.create', name: 'Secret plan', visibility: 'private', brief: '' })).result as
      { projectId: string; conversationId: string }
    const task = String((await f.execute({ type: 'conversation.create', projectId: hidden.projectId, title: 'Secret task', brief: '',
      checks: [] })).result.conversationId)
    const madeUp = 'groups-000000000000000000000000'
    // The owner's browser, on peer's Buddy chat.
    const othersBuddy = await refusal(f.store.messages(ownerWeb, f.tab, chat, {}))
    expect(othersBuddy).not.toBeNull()
    expect(othersBuddy).toEqual(await refusal(f.store.messages(ownerWeb, f.tab, madeUp, {})))
    expect((await new SwarmReads(f.store).firstLoad(ownerWeb, f.tab)).groups.map(g => g.key)).not.toContain(chat)
    // peer's browser, on the owner's private project: refused as their own Mac is, and with no name. (The server says
    // "project" here and "conversation" for an id that does not exist, for every sign-in alike; reported, not changed here.)
    for (const id of [hidden.conversationId, task]) {
      const refused = await refusal(f.store.messages(peerWeb, f.tab, id, {}))
      expect(refused).toMatchObject({ code: 'NOT_FOUND', status: 404 })
      expect(refused).toEqual(await refusal(f.store.messages(peerMac, f.tab, id, {})))
      expect(JSON.stringify(refused)).not.toMatch(/Secret/)
    }
    const keys = (await new SwarmReads(f.store).firstLoad(peerWeb, f.tab)).groups.map(g => g.key)
    for (const id of [hidden.conversationId, task]) expect(keys).not.toContain(id)
    // Another Swarm peer is not in: refused as their own Mac is, with no name. (403 here and 404 for a Swarm that does not
    // exist, for every sign-in alike; reported, not changed here.)
    const other = (await f.store.create(owner, randomUUID(), 'Private Swarm', 'private')).id
    const outside = await refusal(new SwarmReads(f.store).firstLoad(peerWeb, other))
    expect(outside).not.toBeNull()
    expect(outside).toEqual(await refusal(new SwarmReads(f.store).firstLoad(peerMac, other)))
    expect(JSON.stringify(outside)).not.toContain('Private Swarm')
  })

  it('speaks as an agent only where the person\'s own Mac may', async () => {
    const f = await swarm()
    const { agentId } = await buddy(f)
    for (const asAgent of [agentId, f.lead]) {
      expect(await refusal(f.store.messages(peerWeb, f.tab, 'lead', {}, asAgent)))
        .toEqual(await refusal(f.store.messages(peerMac, f.tab, 'lead', {}, asAgent)))
    }
    expect(await refusal(f.store.messages(peerWeb, f.tab, 'lead', {}, f.lead))).toMatchObject({ code: 'FORBIDDEN', status: 403 })
  })
})
