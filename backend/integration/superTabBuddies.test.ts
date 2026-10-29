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
import { poolRows } from './hostRows.test-support.js'
import { SwarmReads } from '../src/superTabs/read/service.js'

// Buddies end to end through the store (buddies.ts): a person adds one on their own Swarm machine, its host starts it, they
// talk to it alone, and it sends their proposal to the PM. A fresh loopback replica set, created here.
let replica: MongoMemoryReplSet
let db: PrismaClient
const owner: AuthUser = { sub: '300000000000000000000001', email: 'owner@example.com', autonomousEnv: 'prod', role: 'user' }
const peer: AuthUser = { sub: '300000000000000000000002', email: 'peer@example.com', autonomousEnv: 'prod', role: 'user' }
const config = { engine: 'claude', model: 'fixture-model', effort: 'high', contextWindow: 200000, engineVersion: 'fixture' }

beforeAll(async () => {
  replica = await MongoMemoryReplSet.create({ binary: { version: '7.0.24', downloadDir: join(tmpdir(), 'harness-super-tab-mongodb-binaries') },
    replSet: { count: 1, ip: '127.0.0.1', storageEngine: 'wiredTiger' } })
  const uri = replica.getUri(`swarm_buddies_test_${randomUUID().replaceAll('-', '_')}`)
  await promisify(execFile)(join(process.cwd(), 'node_modules/.bin/prisma'), ['db', 'push', '--skip-generate'], {
    env: { ...process.env, DATABASE_URL: uri }, timeout: 60000,
  })
  db = new PrismaClient({ datasources: { db: { url: uri } } })
  for (const user of [owner, peer]) await db.user.create({ data: { id: user.sub, externalId: `fixture-${user.sub}`, email: user.email, autonomousEnv: user.autonomousEnv } })
  for (const [machineId, user] of [['owner-mac', owner], ['peer-mac', peer]] as const) {
    await db.machine.create({ data: { machineId, userId: user.sub, apiKey: `fixture-${machineId}`, managerId: 'fixture', autonomousEnv: 'prod', authMode: 'remote' } })
  }
})
afterAll(async () => {
  await db?.$disconnect()
  await replica?.stop()
})

/** A Swarm whose PM runs on the owner's Mac, peer a member with their own Mac in the Machines list, and Buddies on. */
async function swarm() {
  const store = new SuperTabStore(db, () => Date.now())
  const tab = (await store.create(owner, randomUUID(), 'Buddies', 'public')).id
  const execute = (command: Command, user = owner, asAgentId?: string, hostMachineId?: string) =>
    store.execute(user, tab, { operationId: randomUUID(), command }, asAgentId, hostMachineId)
  const invitation = await execute({ type: 'invite.create', email: peer.email, role: 'collaborator', conversationId: 'lead' })
  await execute({ type: 'invite.accept', inviteId: invitation.result.inviteId as string }, peer)
  const lead = String((await execute({ type: 'agent.add', conversationId: 'lead', machineId: 'owner-mac', harnessId: randomUUID(), name: 'PM',
    configuration: config, lead: true })).result.agentId)
  await execute({ type: 'machine.contribute', machineId: 'peer-mac', name: 'Peer Mac', cwd: '/swarm', scope: 'swarm', engines: ['claude'], maxAgents: 2 }, peer)
  const generation = (await poolRows(store, peer, 'peer-mac')).find(p => p.tabId === tab)!.machine.generation
  await store.observeMachine(peer, tab, 'peer-mac', { generation, resources: { cpuPercent: 10, memoryTotalBytes: 32e9, memoryUsedBytes: 4e9,
    diskFreeBytes: 120e9, diskTotalBytes: 500e9, projectDiskFreeBytes: 120e9, deviceType: 'Laptop', chip: 'Fixture', os: 'macOS', gpuPercent: null },
  quotas: [], tools: {}, runningHarnessIds: [], stoppedHarnessIds: [] })
  await execute({ type: 'tab.buddies', enabled: true })
  return { store, tab, execute, lead }
}

/** peer's Buddy, added and started by peer-mac's host as a running host does. */
async function buddy(f: Awaited<ReturnType<typeof swarm>>) {
  const added = await f.execute({ type: 'buddy.create', projectId: 'lead', machineId: 'peer-mac', engine: 'claude' }, peer)
  const startId = String(added.result.startId), chat = String(added.result.conversationId)
  const pool = (await poolRows(f.store, peer, 'peer-mac')).find(p => p.tabId === f.tab)!
  const host = (command: Command) => f.execute(command, peer, undefined, 'peer-mac')
  await host({ type: 'agent.startDispatch', startId })
  const agentId = String((await host({ type: 'agent.started', startId, harnessId: randomUUID(), configuration: config })).result.agentId)
  await host({ type: 'agent.startSettled', startId, warning: null })
  return { chat, agentId, pool }
}

describe('a Buddy through the store', () => {
  it('starts on its owner\'s machine from a list older hosts do not read, and joins its owner\'s chat', async () => {
    const f = await swarm()
    const { chat, agentId, pool } = await buddy(f)
    expect(pool.starts).toEqual([])
    expect(pool.buddyStarts).toHaveLength(1)
    const read = await f.store.read(peer, f.tab)
    expect(read.state.agents.find(a => a.id === agentId)).toMatchObject({ buddyOf: { personId: peer.sub } })
    const messages = await f.store.messages(peer, f.tab, chat, {})
    expect(messages.messages.map(m => m.text)).toEqual(['peer\'s Buddy is ready. Tell it what you have in mind.'])
  })

  it('is read by its owner and its Buddy alone: neither the Swarm owner nor the PM reads its chat', async () => {
    const f = await swarm()
    const { chat, agentId } = await buddy(f)
    await f.execute({ type: 'message.send', conversationId: chat, text: 'A private idea', replyTo: null, recipientIds: [] }, peer)
    const delivered = await db.superTabDelivery.findMany({ where: { tabId: f.tab, conversationId: chat } })
    expect(delivered.map(d => d.agentId)).toEqual([agentId])
    expect((await f.store.messages(peer, f.tab, chat, {}, agentId)).messages.map(m => m.text)).toContain('A private idea')
    await expect(f.store.messages(owner, f.tab, chat, {})).rejects.toThrow('unavailable')
    await expect(f.store.messages(owner, f.tab, chat, {}, f.lead)).rejects.toThrow('unavailable')
    expect((await f.store.read(owner, f.tab)).state.conversations.map(c => c.id)).not.toContain(chat)
  })

  it('sends its owner\'s proposal to the PM in the project chat, once per ask', async () => {
    const f = await swarm()
    const { chat, agentId } = await buddy(f)
    const ask = String((await f.execute({ type: 'message.send', conversationId: chat, text: 'Send it to the PM', replyTo: null, recipientIds: [] }, peer)).result.messageId)
    const propose = () => f.execute({ type: 'buddy.propose', conversationId: chat, ownerMessageId: ask, goal: 'Offline sync', scope: 'Desktop only',
      priority: 'normal' }, peer, agentId)
    const sent = await propose()
    const row = await db.superTabMessage.findFirstOrThrow({ where: { tabId: f.tab, id: String(sent.result.messageId) } })
    expect(row).toMatchObject({ conversationId: 'lead', recipientIds: [f.lead], source: { kind: 'buddy-proposal', personId: peer.sub, ownerMessageId: ask },
      text: 'Proposal from peer\'s Buddy, on peer\'s behalf.\n\nGoal: Offline sync\nScope: Desktop only\nPriority: normal' })
    expect(await db.superTabDelivery.count({ where: { tabId: f.tab, messageId: row.id, agentId: f.lead } })).toBe(1)
    await expect(propose()).rejects.toThrow('already sent')
    await expect(f.execute({ type: 'message.send', conversationId: 'lead', text: 'Hi PM', replyTo: null, recipientIds: [] }, peer, agentId))
      .rejects.toThrow('A Buddy posts only in its own chat')
  })
  it('reads its project\'s work as its person: which task owns it, its pull request, its state and what blocks it', async () => {
    const f = await swarm()
    // Opened before Buddies were on: the owner's private chat with the PM, which their Buddy may never read either.
    await f.execute({ type: 'tab.buddies', enabled: false })
    const owners = String((await f.execute({ type: 'conversation.create', projectId: 'lead', title: 'owner', brief: '', checks: [],
      audience: { personIds: [owner.sub] } })).result.conversationId)
    await f.execute({ type: 'tab.buddies', enabled: true })
    const { agentId } = await buddy(f)
    const group = String((await f.execute({ type: 'conversation.create', projectId: 'lead', title: 'Offline sync', brief: 'Desktop keeps edits offline.',
      checks: [{ description: 'Edits survive a restart', independent: false }] })).result.conversationId)
    const builder = String((await f.execute({ type: 'agent.add', conversationId: group, machineId: 'owner-mac', harnessId: randomUUID(), name: 'Builder',
      configuration: config, lead: false })).result.agentId)
    const assignmentId = String((await f.execute({ type: 'work.assign', conversationId: group, agentId: builder })).result.assignmentId)
    await f.execute({ type: 'message.send', conversationId: group, text: 'Opened https://github.com/acme/app/pull/12', replyTo: null, recipientIds: [] }, owner, builder)
    await f.execute({ type: 'work.status', conversationId: group, assignmentId, status: 'needs_human', result: 'Ship it behind a flag?' }, owner, builder)
    await f.execute({ type: 'decision.ask', conversationId: group, personId: peer.sub, questions: [{ question: 'Ship it behind a flag?',
      options: ['Behind a flag', 'To everyone'], recommended: 0, unblocks: 'The release' }] }, owner, f.lead)
    await f.execute({ type: 'decision.ask', conversationId: group, personId: owner.sub, questions: [{ question: 'Which week?',
      options: ['This week', 'Next week'], recommended: 0, unblocks: 'The plan' }] }, owner, f.lead)

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
    const decisions = await f.store.decisions(peer, f.tab, 'open', agentId)
    expect(decisions.decisions.map(d => [d.conversationId, d.question])).toEqual([[group, 'Ship it behind a flag?']])
  })

  it('is refused another person\'s private chat, the Leads conversation and another project', async () => {
    const f = await swarm()
    await f.execute({ type: 'tab.buddies', enabled: false })
    const owners = String((await f.execute({ type: 'conversation.create', projectId: 'lead', title: 'owner', brief: '', checks: [],
      audience: { personIds: [owner.sub] } })).result.conversationId)
    await f.execute({ type: 'tab.buddies', enabled: true })
    const web = (await f.execute({ type: 'project.create', name: 'Web', visibility: 'public', brief: '' })).result as { projectId: string; conversationId: string }
    const landing = String((await f.execute({ type: 'conversation.create', projectId: web.projectId, title: 'Landing', brief: '', checks: [] })).result.conversationId)
    const { agentId } = await buddy(f)
    const leads = (await f.store.read(owner, f.tab)).state.leadsConversationId
    expect(leads).toBeTruthy()
    for (const conversationId of [owners, web.conversationId, landing, leads!]) {
      await expect(f.store.messages(peer, f.tab, conversationId, {}, agentId)).rejects.toThrow('unavailable')
    }
    const read = await new SwarmReads(f.store).firstLoad(peer, f.tab, agentId)
    for (const id of [owners, web.conversationId, landing, leads]) expect(read.groups.map(g => g.key)).not.toContain(id)
  })
  it('reads no routing: no route rows in its task\'s messages, no routing decisions, no routing policy (security review 2 of #2115)', async () => {
    const f = await swarm()
    const { agentId } = await buddy(f)
    const group = String((await f.execute({ type: 'conversation.create', projectId: 'lead', title: 'Offline sync', brief: 'Keep edits.',
      checks: [{ description: 'Edits survive a restart', independent: false }] })).result.conversationId)
    const builder = String((await f.execute({ type: 'agent.add', conversationId: group, machineId: 'owner-mac', harnessId: randomUUID(), name: 'Builder',
      configuration: config, lead: false })).result.agentId)
    const decision = { assessment: { difficulty: 'low', risk: 'low', why: 'Small task.' },
      candidates: [{ id: 'c0', kind: 'new', machineId: 'owner-mac', engine: 'claude', model: 'fixture-model', effort: 'high',
        quality: 2, cost: 2, title: 'New agent on Kens-MacBook-Pro.local', label: 'New agent' }],
      excluded: [], floor: 1, notes: false, pick: 'c0', via: 'only', p: null, belowFloor: false, why: 'Only candidate.' }
    const routeDecisionId = String((await f.execute({ type: 'route.record', conversationId: group, decision } as Command, owner, f.lead)).result.routeDecisionId)
    await f.execute({ type: 'work.assign', conversationId: group, agentId: builder, routeDecisionId, overrideReason: 'It has the context.' } as Command, owner, f.lead)
    await f.execute({ type: 'message.send', conversationId: group, text: 'Starting now.', replyTo: null, recipientIds: [] }, owner, builder)

    const pm = (await f.store.messages(owner, f.tab, group, {}, f.lead)).messages
    const routed = pm.filter(m => ['route', 'route-override'].includes(String((m.source as { kind?: unknown } | null)?.kind)))
    expect(routed.length).toBeGreaterThanOrEqual(2)
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

  it('still reads a task archived before the PM reported on it, until it leaves the active set (security review 1 of #2115)', async () => {
    const f = await swarm()
    const { agentId } = await buddy(f)
    const group = String((await f.execute({ type: 'conversation.create', projectId: 'lead', title: 'Old task', brief: '', checks: [] })).result.conversationId)
    await f.execute({ type: 'message.send', conversationId: group, text: 'Done here.', replyTo: null, recipientIds: [] })
    await f.execute({ type: 'conversation.archive', conversationId: group, archived: true } as Command)
    const read = await new SwarmReads(f.store).firstLoad(peer, f.tab, agentId)
    expect(read.groups.find(g => g.key === group)?.data).toMatchObject({ archived: true })
    expect(read.groups.find(g => g.key === group)?.data.dormant).toBeUndefined()
  })
  it('reads a lost task without the machine it ran on, in its messages, its task and its agent (security re-check 2 of #2115)', async () => {
    const f = await swarm()
    const { agentId } = await buddy(f)
    await f.execute({ type: 'machine.contribute', machineId: 'owner-mac', name: 'Kens-MacBook-Pro.local', cwd: '/swarm', scope: 'swarm', engines: ['claude'], maxAgents: 2 })
    const generation = (await poolRows(f.store, owner, 'owner-mac')).find(p => p.tabId === f.tab)!.machine.generation
    const report = (stoppedHarnessIds: string[]) => f.store.observeMachine(owner, f.tab, 'owner-mac', { generation, resources: { cpuPercent: 10,
      memoryTotalBytes: 32e9, memoryUsedBytes: 4e9, diskFreeBytes: 120e9, diskTotalBytes: 500e9, projectDiskFreeBytes: 120e9, deviceType: 'Laptop',
      chip: 'Fixture', os: 'macOS', gpuPercent: null }, quotas: [], tools: {}, runningHarnessIds: [], stoppedHarnessIds })
    await report([])
    const group = String((await f.execute({ type: 'conversation.create', projectId: 'lead', title: 'Offline sync', brief: 'Keep edits.',
      checks: [{ description: 'Edits survive a restart', independent: false }] })).result.conversationId)
    const harnessId = randomUUID()
    const builder = String((await f.execute({ type: 'agent.add', conversationId: group, machineId: 'owner-mac', harnessId, name: 'Builder',
      configuration: config, lead: false })).result.agentId)
    await f.execute({ type: 'work.assign', conversationId: group, agentId: builder })
    await report([harnessId])

    const lost = (await f.store.messages(owner, f.tab, group, {}, f.lead)).messages.filter(m => (m.source as { kind?: string } | null)?.kind === 'work-lost')
    expect(lost.length).toBeGreaterThan(0)
    expect(lost.every(m => m.text.includes('its session on Kens-MacBook-Pro.local stopped'))).toBe(true)
    const pmRead = await new SwarmReads(f.store).firstLoad(owner, f.tab, f.lead)
    expect(pmRead.groups.find(g => g.key === group)!.data.assignment).toMatchObject({ status: 'lost', lost: { reason: 'its session on Kens-MacBook-Pro.local stopped' } })

    const seen = (await f.store.messages(peer, f.tab, group, {}, agentId)).messages.filter(m => (m.source as { kind?: string } | null)?.kind === 'work-lost')
    expect(seen.map(m => m.id).sort()).toEqual(lost.map(m => m.id).sort())
    expect(seen.every(m => m.text.includes('its session stopped'))).toBe(true)
    const read = await new SwarmReads(f.store).firstLoad(peer, f.tab, agentId)
    expect(read.groups.find(g => g.key === group)!.data.assignment).toMatchObject({ status: 'lost', lost: { reason: 'its session stopped' } })
    expect(read.agents.find(a => a.key === builder)!.data.lostTask).toMatchObject({ reason: 'its session stopped' })
    expect(JSON.stringify([seen, read])).not.toContain('Kens-MacBook-Pro')
  })
})
