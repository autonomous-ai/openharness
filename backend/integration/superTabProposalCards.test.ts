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
  const create = async (user = peer) => String((await execute({ type: 'proposal.create', projectId: 'lead', title: 'Keep drafts', text: 'Keep offline drafts',
    goal: 'Preserve work', why: 'Reconnect loses drafts', doneWhen: 'Draft returns', evidence: ['Network-off reproduction'], priority: 'P2' }, user)).result.conversationId)
  const card = async (id: string) => (await db.swarmGroup.findUniqueOrThrow({ where: { tabId_key: { tabId: tab, key: id } } })).data as unknown as Conversation
  return { store, tab, pm, execute, create, card, clock: { get now() { return now }, set now(value: number) { now = value } } }
}

describe('durable proposal cards', () => {
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

  it('applies questions after long inactivity including dormant cards, using the due index', async () => {
    const { dueProposalCards } = await import('../src/superTabs/proposalDue.js')
    const f = await fixture(), id = await f.create(), deadline = f.clock.now + 30 * DAY
    await f.execute({ type: 'proposal.ask', conversationId: id, personId: peer.sub, question: 'Wait?', defaultAnswer: 'Proceed', deadline }, owner, f.pm)
    const row = await db.swarmGroup.findUniqueOrThrow({ where: { tabId_key: { tabId: f.tab, key: id } } })
    await db.swarmGroup.update({ where: { id: row.id }, data: { dormant: true, lastActivityAt: new Date(f.clock.now - 60 * DAY), data: { ...(row.data as object), dormant: true } } })
    f.clock.now = deadline
    const prof = await profiled(db, () => dueProposalCards(db, deadline, 200))
    const due = plan(reads(prof, 'SwarmGroup', ['proposalDueAt']))
    expect(due).toEqual([expect.objectContaining({ plan: 'IXSCAN { deleted: 1, proposalDueAt: 1, tabId: 1, key: 1 }' })])
    expect(due[0]!.docsExamined).toBeLessThanOrEqual(due[0]!.returned ?? 0)
    await runTimeCheckPass(db, f.store, deadline)
    expect((await f.card(id)).proposal!.questions[0]!.answer).toMatchObject({ text: 'Proceed', defaulted: true })
    await runTimeCheckPass(db, f.store, deadline + 1)
    expect(await db.superTabMessage.count({ where: { tabId: f.tab, conversationId: id, text: 'Proceed' } })).toBe(1)
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
