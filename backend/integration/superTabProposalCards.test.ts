import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { MongoMemoryReplSet } from 'mongodb-memory-server-core'
import type { PrismaClient } from '@prisma/client'
import type { AuthUser } from '../src/lib/ssoAuth.js'
import { SuperTabStore } from '../src/superTabs/store.js'
import { commandSchema } from '../src/superTabs/commands.js'
import type { Conversation } from '../src/superTabs/model.js'
import { SwarmReads } from '../src/superTabs/read/service.js'
import { listNamedIndexes } from '../src/superTabs/parts/indexed.js'
import { runTimeCheckPass } from '../src/superTabs/timeChecks.js'
import { planDatabase, profiled, reads, plan } from './plans.test-support.js'
import { storeBoardSettings } from './storedWork.test-support.js'

let replica: MongoMemoryReplSet, db: PrismaClient
const owner: AuthUser = { sub: '540000000000000000000001', email: 'owner@example.com', autonomousEnv: 'prod', role: 'user' }
const peer: AuthUser = { sub: '540000000000000000000002', email: 'peer@example.com', autonomousEnv: 'prod', role: 'user' }
const config = { engine: 'codex', model: 'fixture', effort: 'high', contextWindow: 200000, engineVersion: 'fixture' }
const DAY = 86_400_000
beforeAll(async () => {
  ({ replica, db } = await planDatabase('proposal_cards'))
  await listNamedIndexes(db)
  for (const u of [owner, peer]) await db.user.create({ data: { id: u.sub, externalId: `fixture-${u.sub}`, email: u.email, autonomousEnv: 'prod' } })
  await db.machine.create({ data: { machineId: 'proposal-mac', userId: owner.sub, apiKey: 'fixture-proposal-mac', managerId: 'fixture', autonomousEnv: 'prod', authMode: 'remote' } })
})
afterAll(async () => { await db?.$disconnect(); await replica?.stop() })

async function fixture() {
  let now = Date.now()
  const store = new SuperTabStore(db, () => now, null, { readCache: null })
  const tab = (await store.create(owner, randomUUID(), 'Proposal cards', 'public')).id
  const execute = (command: unknown, user = owner, asAgentId?: string, operationId = randomUUID()) =>
    store.execute(user, tab, { operationId, command: commandSchema.parse(command) }, asAgentId)
  const invitation = await execute({ type: 'invite.create', email: peer.email, role: 'viewer', conversationId: 'lead' })
  await execute({ type: 'invite.accept', inviteId: invitation.result.inviteId }, peer)
  const pm = String((await execute({ type: 'agent.add', conversationId: 'lead', machineId: 'proposal-mac', harnessId: randomUUID(), name: 'PM', configuration: config, lead: true })).result.agentId)
  // #3819 owns the switch command; this test isolates its agreed stored input.
  const head = await db.swarmHead.findUniqueOrThrow({ where: { id: `${tab}:head` } })
  const data = head.data as unknown as { projects: Array<{ boardMode?: true }> }
  data.projects[0]!.boardMode = true
  await db.swarmHead.update({ where: { id: head.id }, data: { data: data as never, version: head.version + 1 } })
  const create = async (user = peer, priority = 'P2') => String((await execute({ type: 'proposal.create', projectId: 'lead', title: 'Keep drafts', text: 'Keep offline drafts',
    goal: 'Preserve work', why: 'Reconnect loses drafts', doneWhen: 'Draft returns', evidence: ['Network-off reproduction'], priority }, user)).result.conversationId)
  const card = async (id: string) => (await db.swarmGroup.findUniqueOrThrow({ where: { tabId_key: { tabId: tab, key: id } } })).data as unknown as Conversation
  return { store, tab, pm, execute, create, card, clock: { get now() { return now }, set now(value: number) { now = value } } }
}

describe('durable proposal cards', () => {

  it('keeps legacy Buddy delivery, and rejects conversion after the mirror is dormant', async () => {
    const f = await fixture()
    await storeBoardSettings(db, f.tab, 'lead', { boardMode: undefined })
    const added = await f.execute({ type: 'buddy.create', machineId: 'proposal-mac', engine: 'codex', setup: { name: 'Fixture Mac', cwd: '/fixture', engines: ['codex'] } })
    const startId = String(added.result.startId), chatId = String(added.result.conversationId)
    const host = (command: unknown) => f.store.execute(owner, f.tab, { operationId: randomUUID(), command: commandSchema.parse(command) }, undefined, 'proposal-mac')
    await host({ type: 'agent.startDispatch', startId })
    const buddyId = String((await host({ type: 'agent.started', startId, harnessId: randomUUID(), configuration: config })).result.agentId)
    await host({ type: 'agent.startSettled', startId, warning: null })
    const text = 'Keep offline drafts'
    const ask = await f.execute({ type: 'message.send', conversationId: chatId, text, recipientIds: [buddyId], replyTo: null })
    const sent = await f.execute({ type: 'buddy.propose', conversationId: chatId, projectId: 'lead', ownerMessageId: ask.result.messageId,
      text, goal: text, scope: 'Drafts', priority: 'normal' }, owner, buddyId)
    const messageId = String(sent.result.messageId)
    expect(await db.superTabDelivery.count({ where: { tabId: f.tab, agentId: f.pm, messageId } })).toBe(1)
    const create = { type: 'conversation.create', title: text, priority: 'P2', proposalMessageId: messageId,
      task: { goal: text, changes: 'Restore drafts', constraints: 'No login', owns: ['backend/src/superTabs/'] },
      checks: [{ description: 'Draft returns', independent: false }] }
    await f.execute(create, owner, f.pm)
    const { legacyProposalId } = await import('../src/superTabs/proposalCards.js')
    const mirrorId = legacyProposalId('lead', messageId)
    const row = await db.swarmGroup.findUniqueOrThrow({ where: { tabId_key: { tabId: f.tab, key: mirrorId } } })
    await db.swarmGroup.update({ where: { id: row.id }, data: { dormant: true, data: { ...(row.data as object), dormant: true }, version: { increment: 1 } } })
    await expect(f.execute(create, owner, f.pm)).rejects.toThrow()
  })

  it('tells senders the PM was excluded and persists only the recipients that will receive a chat post', async () => {
    const f = await fixture()
    const group = String((await f.execute({ type: 'conversation.create', title: 'Follow-up', brief: 'Resolve the question', checks: [{ description: 'Question answered', independent: false }] })).result.conversationId)
    const worker = String((await f.execute({ type: 'agent.add', conversationId: group, machineId: 'proposal-mac', harnessId: randomUUID(), name: 'Worker', configuration: config, lead: false })).result.agentId)
    const question = await f.execute({ type: 'message.send', conversationId: group, text: 'Which work should we keep?', recipientIds: [worker], replyTo: null }, owner, f.pm)
    for (const asAgent of [undefined, worker]) {
      const sent = await f.execute({ type: 'message.send', conversationId: group, text: 'Keep the offline draft work', recipientIds: [f.pm], replyTo: String(question.result.messageId) }, owner, asAgent)
      expect(sent.result.reachedNoAgent).toEqual(expect.any(String))
      expect(sent.result.notReached).toContain('PM')
      expect(sent.result.notReached).toContain('proposal card')
      const row = await db.superTabMessage.findUniqueOrThrow({ where: { id: String(sent.result.messageId) } })
      expect(row.recipientIds).toEqual([])
      expect(await db.superTabDelivery.count({ where: { tabId: f.tab, messageId: row.id } })).toBe(0)
    }
    const partial = await f.execute({ type: 'message.send', conversationId: group, text: 'For both', recipientIds: [f.pm, worker], replyTo: null })
    expect(partial.result.notReached).toContain('PM')
    expect(partial.result).not.toHaveProperty('reachedNoAgent')
    expect((await db.superTabMessage.findUniqueOrThrow({ where: { id: String(partial.result.messageId) } })).recipientIds).toEqual([worker])
    expect((await db.superTabDelivery.findMany({ where: { tabId: f.tab, messageId: String(partial.result.messageId) } })).map(d => d.agentId)).toEqual([worker])
  })

  it('writes no decided notice in the sending person’s private Buddy chat, nor delivers one to their Buddy (task #4558)', async () => {
    const f = await fixture()
    const added = await f.execute({ type: 'buddy.create', machineId: 'proposal-mac', engine: 'codex', setup: { name: 'Fixture Mac', cwd: '/fixture', engines: ['codex'] } })
    const startId = String(added.result.startId)
    const host = (command: unknown) => f.store.execute(owner, f.tab, { operationId: randomUUID(), command: commandSchema.parse(command) }, undefined, 'proposal-mac')
    await host({ type: 'agent.startDispatch', startId })
    const buddyId = String((await host({ type: 'agent.started', startId, harnessId: randomUUID(), configuration: config })).result.agentId)
    await host({ type: 'agent.startSettled', startId, warning: null })
    const id = await f.create(owner)
    await f.execute({ type: 'proposal.decide', conversationId: id, decision: 'no', reason: 'Outside positioning' }, owner, f.pm)
    const delivered = await f.store.deliveries(owner, f.tab, buddyId)
    const notices = await db.superTabMessage.findMany({ where: { tabId: f.tab, conversationId: String(added.result.conversationId) } })
    expect(notices.filter(m => (m.source as { kind?: string } | null)?.kind === 'proposal-notice')).toEqual([])
    expect(delivered.filter(d => notices.some(m => m.id === d.messageId && (m.author as { id?: string }).id !== buddyId))).toEqual([])
  })

  it('keeps a dormant card loaded when its person has a dormant default Buddy chat', async () => {
    const f = await fixture()
    await f.execute({ type: 'buddy.create', machineId: 'proposal-mac', engine: 'codex', setup: { name: 'Fixture Mac', cwd: '/fixture', engines: ['codex'] } })
    const second = await f.execute({ type: 'buddy.create', machineId: 'proposal-mac', engine: 'codex', name: 'Research' })
    await f.execute({ type: 'buddy.default', conversationId: second.result.conversationId })
    const id = await f.create(owner)
    for (const key of [id, String(second.result.conversationId)]) {
      const row = await db.swarmGroup.findUniqueOrThrow({ where: { tabId_key: { tabId: f.tab, key } } })
      await db.swarmGroup.update({ where: { id: row.id }, data: { dormant: true, version: { increment: 1 },
        data: { ...(row.data as object), dormant: true } } })
    }
    await f.execute({ type: 'proposal.decide', conversationId: id, decision: 'no', reason: 'Outside positioning' }, owner, f.pm)
    expect((await f.card(id)).proposal!.decision).toMatchObject({ kind: 'no', reason: 'Outside positioning' })
    const notices = await db.superTabMessage.findMany({ where: { tabId: f.tab, conversationId: String(second.result.conversationId) } })
    expect(notices.some(m => (m.source as { moment?: string } | null)?.moment === 'decided')).toBe(false)
  })

  it('delivers urgent proposals first on both a full poll and its fast repeat', async () => {
    const f = await fixture(), low = await f.create(), urgent = await f.create(owner, 'P0')
    for (let i = 0; i < 2; i++) {
      const deliveries = await f.store.deliveries(owner, f.tab, f.pm)
      expect(deliveries.filter(d => [low, urgent].includes(d.conversationId)).map(d => d.conversationId)).toEqual([urgent, low])
    }
  })

  it('does not hide a new P0 behind the bounded page of older nonurgent inputs', async () => {
    const f = await fixture(), low = await f.create()
    const row = await db.superTabDelivery.findFirstOrThrow({ where: { tabId: f.tab, conversationId: low, agentId: f.pm } })
    await db.superTabDelivery.createMany({ data: Array.from({ length: 105 }, (_, i) => ({ ...row, id: randomUUID(), createdAt: new Date(f.clock.now - i - 1000) })) })
    const urgent = await f.create(owner, 'P0')
    const prof = await profiled(db, async () => expect((await f.store.deliveries(owner, f.tab, f.pm))[0]?.conversationId).toBe(urgent))
    const priority = plan(reads(prof, 'SuperTabDelivery', ['inputPriority']))
    expect(priority).toEqual([expect.objectContaining({ plan: expect.stringContaining('IXSCAN { tabId: 1, agentId: 1, status: 1, inputPriority: 1, createdAt: 1 }') })])
    expect(priority[0]!.docsExamined).toBeLessThanOrEqual(110)
    console.info('Proposal priority read:', priority)
    expect((await f.store.deliveries(owner, f.tab, f.pm))[0]?.conversationId).toBe(urgent)
  })

  it('withholds queued ordinary chat after switching and still delivers a proposal', async () => {
    const f = await fixture()
    const head = await db.swarmHead.findUniqueOrThrow({ where: { id: `${f.tab}:head` } })
    const data = head.data as any
    delete data.projects[0].boardMode
    await db.swarmHead.update({ where: { id: head.id }, data: { data, version: { increment: 1 } } })
    const chat = await f.execute({ type: 'message.send', conversationId: 'lead', text: 'Old ordinary chat', recipientIds: [f.pm], replyTo: null })
    data.projects[0].boardMode = true
    await db.swarmHead.update({ where: { id: head.id }, data: { data, version: { increment: 1 } } })
    const id = await f.create()
    const deliveries = await f.store.deliveries(owner, f.tab, f.pm)
    expect(deliveries.some(d => d.messageId === chat.result.messageId)).toBe(false)
    expect(deliveries.some(d => d.conversationId === id)).toBe(true)
  })

  it('persists viewer proposals and answers through the real store and changed-parts read', async () => {
    const f = await fixture(), read = new SwarmReads(f.store)
    const before = await read.firstLoad(peer, f.tab)
    const id = await f.create()
    const question = await f.execute({ type: 'proposal.ask', conversationId: id, personId: peer.sub,
      question: 'Seven days?', defaultAnswer: 'Seven days', deadline: f.clock.now + 60_000 }, owner, f.pm)
    const answered = await f.execute({ type: 'proposal.answer', conversationId: id, questionId: question.result.questionId, text: 'Fourteen days' }, peer)
    expect(answered.result.applied).toBe(true)
    expect((await f.card(id)).proposal!.questions[0]!.answer!.text).toBe('Fourteen days')
    const changes = await read.changes(peer, f.tab, before.cursor)
    expect(changes.groups.some(g => g.key === id && !g.deleted && 'data' in g && g.data?.proposal?.text === 'Keep offline drafts')).toBe(true)
    expect(await db.superTabDelivery.count({ where: { tabId: f.tab, agentId: f.pm, messageId: answered.result.messageId as string } })).toBe(1)
  })

  it('guards answer races and denies receipt replay after private-project revocation', async () => {
    const f = await fixture(), id = await f.create(), deadline = f.clock.now + 1000
    const q = await f.execute({ type: 'proposal.ask', conversationId: id, personId: peer.sub, question: 'Keep?', defaultAnswer: 'Yes', deadline }, owner, f.pm)
    const answer = { type: 'proposal.answer', conversationId: id, questionId: q.result.questionId, text: 'No' }
    const results = await Promise.all([f.execute(answer, peer), f.execute({ ...answer, text: 'Maybe' }, peer)])
    expect(results.map(r => r.result.applied).sort()).toEqual([false, true])
    await f.execute({ type: 'project.sharing', projectId: 'lead', visibility: 'private', memberIds: [peer.sub] })
    const op = randomUUID()
    await f.execute({ ...answer, text: 'Visible late comment' }, peer, undefined, op)
    await f.execute({ type: 'project.sharing', projectId: 'lead', visibility: 'private', memberIds: [] })
    await expect(f.execute({ ...answer, text: 'Visible late comment' }, peer, undefined, op)).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})
