import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { MongoMemoryReplSet } from 'mongodb-memory-server-core'
import type { PrismaClient } from '@prisma/client'
import type { AuthUser } from '../src/lib/ssoAuth.js'
import { SuperTabStore } from '../src/superTabs/store.js'
import type { Command } from '../src/superTabs/commands.js'
import { overdueNotice } from '../src/superTabs/decisions.js'
import { OVERDUE_DECISION_MS, overdueDecisions, dueDefaultDecisions } from '../src/superTabs/overdueDecisions.js'
import { planDatabase, plan, profiled, reads } from './plans.test-support.js'

// A decision its person leaves for 24 hours goes to the PM (spec: Diego, 2026-11-04). A fresh loopback replica set; never DATABASE_URL.
let replica: MongoMemoryReplSet
let db: PrismaClient
const NOW = Date.parse('2026-11-04T12:00:00Z')
const HOUR = 3_600_000, DAY = 24 * HOUR
const owner: AuthUser = { sub: '400000000000000000000001', email: 'owner@example.com', autonomousEnv: 'prod', role: 'user' }
const peer: AuthUser = { sub: '400000000000000000000002', email: 'peer@example.com', autonomousEnv: 'prod', role: 'user' }
const config = { engine: 'claude', model: 'fixture-model', effort: 'high', contextWindow: 200000, engineVersion: 'fixture' }

beforeAll(async () => {
  ({ replica, db } = await planDatabase('overdue_decisions_test'))
  for (const user of [owner, peer]) await db.user.create({ data: { id: user.sub, externalId: `fixture-${user.sub}`, email: user.email, autonomousEnv: 'prod' } })
  await db.machine.create({ data: { machineId: 'owner-mac', userId: owner.sub, apiKey: 'fixture-owner-mac', managerId: 'fixture', autonomousEnv: 'prod', authMode: 'remote' } })
})
// Every test counts what a pass answers across the whole database, so each starts without the earlier tests' decisions.
beforeEach(async () => { await db.superTabDecision.deleteMany({}) })
afterAll(async () => {
  await db?.$disconnect()
  await replica?.stop()
})

/** A Swarm whose PM asks peer decisions; each `ask` is stored with the given age. */
async function swarm(role: 'collaborator' | 'viewer' = 'collaborator') {
  const store = new SuperTabStore(db, () => NOW)
  const tab = (await store.create(owner, randomUUID(), 'Overdue', 'public')).id
  const execute = (command: Command, user = owner, asAgentId?: string) => store.execute(user, tab, { operationId: randomUUID(), command }, asAgentId)
  const invitation = await execute({ type: 'invite.create', email: peer.email, role, conversationId: 'lead' })
  await execute({ type: 'invite.accept', inviteId: invitation.result.inviteId as string }, peer)
  const lead = String((await execute({ type: 'agent.add', conversationId: 'lead', machineId: 'owner-mac', harnessId: randomUUID(), name: 'PM', configuration: config, lead: true })).result.agentId)
  /** Asks peer one question, then dates it `age` ago. */
  const ask = async (age: number, defaultAt?: string) => {
    const before = new Set((await db.superTabDecision.findMany({ where: { tabId: tab }, select: { id: true } })).map(d => d.id))
    await new SuperTabStore(db, () => NOW - age).execute(owner, tab, { operationId: randomUUID(), command: { type: 'decision.ask', conversationId: 'lead', personId: peer.sub, questions: [{ question: `Which week ${randomUUID()}?`, options: ['This week', 'Next week'], recommended: 1, unblocks: 'The plan', ...defaultAt ? { defaultAt } : {} }] } }, lead)
    const row = (await db.superTabDecision.findMany({ where: { tabId: tab } })).find(d => !before.has(d.id))!
    await db.superTabDecision.update({ where: { id: row.id }, data: { createdAt: new Date(NOW - age) } })
    return row.id
  }
  /** Old data the command refuses to ask now: a recommended option past its options. */
  const askBroken = async (age: number) => {
    const id = randomUUID().replaceAll('-', '').slice(0, 24)
    await db.superTabDecision.create({ data: { id, tabId: tab, batchId: randomUUID(), projectId: 'lead', conversationId: 'lead', personId: peer.sub, askerAgentId: lead,
      question: 'Which?', options: ['A', 'B'], recommended: 9, unblocks: 'Plan', createdAt: new Date(NOW - age) } })
    return id
  }
  const row = (id: string) => db.superTabDecision.findUniqueOrThrow({ where: { id } })
  // The notice is the agents' line (AGENT_ONLY): the PM reads it, a person does not.
  const notices = async () => (await store.messages(owner, tab, 'lead', {}, lead)).messages.filter(m => m.text.startsWith(overdueNotice('Product Manager'))).length
  return { store, tab, lead, execute, ask, askBroken, row, notices }
}

describe('explicit deadline persistence', () => {
  it('stores, reads and deduplicates the normalized deadline while a changed deadline is a new decision', async () => {
    const f = await swarm()
    const question = { question: 'Ship today?', options: ['Yes', 'Tomorrow'], recommended: 0, unblocks: 'Release', defaultAt: '2026-11-04T13:00:00Z' }
    const ask = async (defaultAt: string) => {
      return f.execute({ type: 'decision.ask', conversationId: 'lead', personId: peer.sub, questions: [{ ...question, defaultAt }] } as Command, owner, f.lead)
    }
    const first = await ask(question.defaultAt)
    const id = String((first.result.decisionIds as string[])[0])
    expect(await f.row(id)).toMatchObject({ defaultAt: new Date('2026-11-04T13:00:00Z') })
    expect((await ask('2026-11-04T14:00:00+01:00')).result.decisionIds).toEqual([id])
    const changed = await ask('2026-11-04T14:00:00Z')
    expect(changed.result.decisionIds).not.toEqual([id])
    const list = await f.store.decisions(peer, f.tab, 'open')
    expect(list.decisions.find(d => d.id === id)).toMatchObject({ defaultAt: new Date('2026-11-04T13:00:00Z'), defaulted: false })
  })
})

describe('timed recommendation defaults', () => {
  const at = (delta: number) => new Date(NOW + delta).toISOString()

  it('waits before the deadline, then applies its recommendation at the exact time and tells the asker once', async () => {
    const f = await swarm()
    const id = await f.ask(HOUR, at(0))
    expect(await new SuperTabStore(db, () => NOW - 1).leaveOverdueDecisions(NOW - 1)).toEqual({ answered: 0, skipped: 0, failed: 0 })
    expect(await f.store.leaveOverdueDecisions(NOW)).toEqual({ answered: 1, skipped: 0, failed: 0 })
    expect(await f.row(id)).toMatchObject({ choice: 1, delegated: true, defaulted: true, overdue: null, answeredAt: new Date(NOW) })
    const notices = (await f.store.messages(owner, f.tab, 'lead', {}, f.lead)).messages.filter(m => (m.source as { decisionId?: string })?.decisionId === id)
    expect(notices).toHaveLength(1)
    expect(notices[0]).toMatchObject({ recipientIds: [f.lead], source: { kind: 'agent-only' } })
    expect(notices[0]!.text).toMatch(/default.*time|deadline/i)
    expect(notices[0]!.text).not.toContain('Next week')
    const settled = await f.store.decisions(peer, f.tab, 'settled')
    expect(settled.decisions.find(d => d.id === id)).toMatchObject({ defaulted: true, answer: 'Default applied: Next week' })
    expect((await f.store.decisions(peer, f.tab, 'answered')).decisions).toHaveLength(0)
    expect(await f.store.leaveOverdueDecisions(NOW)).toEqual({ answered: 0, skipped: 0, failed: 0 })
  })

  it('does not take a future deadline at the legacy 24-hour age and does take a long-lived question due today', async () => {
    const f = await swarm()
    const future = await f.ask(25 * HOUR, at(HOUR))
    const ancient = await f.ask(40 * DAY, at(0))
    expect(await f.store.leaveOverdueDecisions(NOW)).toEqual({ answered: 1, skipped: 0, failed: 0 })
    expect((await f.row(future)).answeredAt).toBeNull()
    expect((await f.row(ancient)).defaulted).toBe(true)
  })

  it('keeps a person’s prior answer and makes concurrent sweep/answer attempts single-winner', async () => {
    const f = await swarm()
    const answered = await f.ask(HOUR, at(0))
    await f.execute({ type: 'decision.answer', decisionId: answered, choice: 0 }, peer)
    const racing = await f.ask(HOUR, at(0))
    await Promise.allSettled([f.store.leaveOverdueDecisions(NOW), f.store.leaveOverdueDecisions(NOW), f.execute({ type: 'decision.answer', decisionId: racing, choice: 0 }, peer)])
    expect(await f.row(answered)).toMatchObject({ choice: 0, defaulted: null })
    const row = await f.row(racing)
    expect(row.answeredAt).toEqual(new Date(NOW))
    expect([0, 1]).toContain(row.choice)
    const notices = (await f.store.messages(owner, f.tab, 'lead', {}, f.lead)).messages.filter(m => (m.source as { decisionId?: string })?.decisionId === racing)
    expect(notices).toHaveLength(1)
  })

  it('caps explicit defaults per pass and excludes withdrawn or reflection decisions', async () => {
    const f = await swarm()
    const withdrawn = await f.ask(HOUR, at(0)), reflection = await f.ask(HOUR, at(0))
    await db.superTabDecision.update({ where: { id: withdrawn }, data: { withdrawn: true } })
    await db.superTabDecision.update({ where: { id: reflection }, data: { kind: 'routing-reflection' } })
    const ids = [await f.ask(HOUR, at(-2)), await f.ask(HOUR, at(-1)), await f.ask(HOUR, at(0))]
    expect(await f.store.leaveOverdueDecisions(NOW, 2)).toEqual({ answered: 2, skipped: 0, failed: 0 })
    expect((await f.row(ids[2]!)).answeredAt).toBeNull()
    expect((await f.store.leaveOverdueDecisions(NOW, 2)).answered).toBe(1)
    for (const id of [withdrawn, reflection]) expect((await f.row(id)).answeredAt).toBeNull()
  })

  it('withdraws permanently unavailable due rows so they cannot starve fresh or legacy questions', async () => {
    const f = await swarm()
    const gone = [await f.ask(HOUR, at(-3)), await f.ask(HOUR, at(-2))]
    for (const id of gone) await db.superTabDecision.update({ where: { id }, data: { personId: '400000000000000000000099' } })
    const due = await f.ask(HOUR, at(0)), legacy = await f.ask(25 * HOUR)
    // A small cap models a full queue of permanently unanswerable rows. Legacy work gets its share immediately.
    await f.store.leaveOverdueDecisions(NOW, 2)
    expect((await f.row(legacy)).overdue).toBe(true)
    for (let i = 0; i < 2; i++) await f.store.leaveOverdueDecisions(NOW, 2)
    for (const id of gone) expect(await f.row(id)).toMatchObject({ withdrawn: true, answeredAt: new Date(NOW), choice: null })
    expect((await f.row(due)).defaulted).toBe(true)
  })

  it('withdraws a removed member’s due default even while their user still exists', async () => {
    const f = await swarm()
    const id = await f.ask(HOUR, at(0))
    await f.execute({ type: 'member.remove', userId: peer.sub })
    expect(await db.user.findUnique({ where: { id: peer.sub } })).not.toBeNull()
    expect(await f.store.leaveOverdueDecisions(NOW)).toEqual({ answered: 0, skipped: 1, failed: 0 })
    expect(await f.row(id)).toMatchObject({ withdrawn: true, answeredAt: new Date(NOW), choice: null, defaulted: null })
    expect(await f.store.leaveOverdueDecisions(NOW)).toEqual({ answered: 0, skipped: 0, failed: 0 })
  })

  it('keeps decision defaults available to viewers, who may answer their own questions', async () => {
    const f = await swarm('viewer')
    const id = await f.ask(HOUR, at(0))
    expect(await f.store.leaveOverdueDecisions(NOW)).toEqual({ answered: 1, skipped: 0, failed: 0 })
    expect(await f.row(id)).toMatchObject({ choice: 1, defaulted: true, withdrawn: null })
  })

  it('uses the deadline index without scanning future, legacy or answered noise', async () => {
    const f = await swarm()
    for (let i = 0; i < 10; i++) await f.ask(HOUR, at(HOUR + i))
    for (let i = 0; i < 5; i++) await f.ask(25 * HOUR)
    const done = await f.ask(HOUR, at(-1))
    await f.execute({ type: 'decision.answer', decisionId: done, choice: 0 }, peer)
    await f.ask(40 * DAY, at(0))
    const found: unknown[] = []
    const start = performance.now()
    const entries = await profiled(db, async () => { found.push(...await dueDefaultDecisions(db, NOW)) })
    const elapsedMs = performance.now() - start
    const read = reads(entries, 'SuperTabDecision', ['defaultAt'])
    const explain = JSON.stringify(plan(read))
    expect(found).toHaveLength(1)
    expect(read, explain).toHaveLength(1)
    expect(read[0]!.planSummary, explain).toMatch(/IXSCAN \{ answeredAt: 1, defaultAt: 1 \}/)
    expect(read[0]!.docsExamined, explain).toBeLessThanOrEqual(found.length + 1)
    console.info('deadline query evidence', { elapsedMs, returned: found.length, examined: read[0]!.docsExamined, plan: read[0]!.planSummary })
  })
})

describe('decisions left to the PM after 24 hours', () => {
  it('a decision asked 25 hours ago is left to the PM', async () => {
    const f = await swarm()
    const id = await f.ask(25 * HOUR)
    expect(await f.store.leaveOverdueDecisions(NOW)).toEqual({ answered: 1, skipped: 0, failed: 0 })
    expect(await f.row(id)).toMatchObject({ delegated: true, overdue: true, choice: 1 })
    expect(await f.notices()).toBe(1)
  })

  it('a decision asked 23 hours ago waits', async () => {
    const f = await swarm()
    const id = await f.ask(23 * HOUR)
    expect(await f.store.leaveOverdueDecisions(NOW)).toEqual({ answered: 0, skipped: 0, failed: 0 })
    expect((await f.row(id)).answeredAt).toBeNull()
  })

  it("a person's answer wins over the sweep", async () => {
    const f = await swarm()
    const id = await f.ask(25 * HOUR)
    await f.execute({ type: 'decision.answer', decisionId: id, choice: 0 }, peer)
    expect(await f.store.leaveOverdueDecisions(NOW)).toEqual({ answered: 0, skipped: 0, failed: 0 })
    const row = await f.row(id)
    expect(row.choice).toBe(0)
    expect(row.overdue).toBeNull()
  })

  it('a second pass replays nothing', async () => {
    const f = await swarm()
    await f.ask(25 * HOUR)
    expect((await f.store.leaveOverdueDecisions(NOW)).answered).toBe(1)
    expect(await f.store.leaveOverdueDecisions(NOW + HOUR)).toEqual({ answered: 0, skipped: 0, failed: 0 })
    expect(await f.notices()).toBe(1)
  })

  it('a decision older than 8 days is never taken', async () => {
    const f = await swarm()
    const ancient = await f.ask(9 * DAY)
    const week = await f.ask(7 * DAY)
    expect((await new SuperTabStore(db, () => NOW).leaveOverdueDecisions(NOW)).answered).toBe(1)
    expect((await f.row(week)).overdue).toBe(true)
    expect((await f.row(ancient)).answeredAt).toBeNull()
    expect((await f.store.leaveOverdueDecisions(NOW)).answered).toBe(0)
    expect((await f.row(ancient)).answeredAt).toBeNull()
  })

  it('a capped pass leaves the rest for the next one', async () => {
    const f = await swarm()
    const ids = [await f.ask(30 * HOUR), await f.ask(28 * HOUR), await f.ask(26 * HOUR)]
    expect(await f.store.leaveOverdueDecisions(NOW, 2)).toEqual({ answered: 2, skipped: 0, failed: 0 })
    expect((await f.row(ids[2]!)).answeredAt).toBeNull()
    expect(await f.store.leaveOverdueDecisions(NOW, 2)).toEqual({ answered: 1, skipped: 0, failed: 0 })
    expect((await f.row(ids[2]!)).overdue).toBe(true)
  })

  it('a decision the PM cannot take is skipped, the rest are answered', async () => {
    const f = await swarm()
    const bad = await f.askBroken(25 * HOUR)
    const good = await f.ask(26 * HOUR - 1000)
    expect(await f.store.leaveOverdueDecisions(NOW)).toEqual({ answered: 1, skipped: 1, failed: 0 })
    expect((await f.row(bad)).answeredAt).toBeNull()
    expect((await f.row(good)).overdue).toBe(true)
  })

  it('the overdue read uses decision_waiting_created', async () => {
    const f = await swarm()
    // Noise: waiting rows outside the window (older than 8 days, younger than 24 hours) and answered rows inside it.
    for (let i = 0; i < 10; i++) await f.ask(40 * DAY + i * HOUR)
    for (let i = 0; i < 5; i++) await f.ask(2 * HOUR + i)
    for (let i = 0; i < 10; i++) {
      const id = await f.ask(30 * HOUR + i * HOUR)
      await db.superTabDecision.update({ where: { id }, data: { answeredAt: new Date(NOW - HOUR), choice: 0 } })
    }
    await f.ask(25 * HOUR)
    await f.ask(24 * HOUR + 1000)
    const found: Array<unknown> = []
    const entries = await profiled(db, async () => { found.push(...await overdueDecisions(db, NOW)) })
    const read = reads(entries, 'SuperTabDecision', ['createdAt'])
    const explain = JSON.stringify(plan(read))
    expect(found).toHaveLength(2)
    expect(read, explain).toHaveLength(1)
    expect(read[0]!.planSummary, explain).toMatch(/IXSCAN \{ answeredAt: 1, createdAt: 1 \}/)
    expect(read[0]!.docsExamined, explain).toBeLessThanOrEqual(found.length + 1)
    expect(OVERDUE_DECISION_MS).toBe(DAY)
  })
})

// Task #3826: in a switched project an agent asks the person directly, always with a default and a time. Past the time the
// default applies, unless the ask says the person must agree: then it waits for them, and the PM is told once.
describe('a switched project’s direct asks at their default time', () => {
  const at = (delta: number) => new Date(NOW + delta).toISOString()

  /** A switched project with its PM and a worker on a task, asking peer directly; `ask` dates the decision `age` ago. */
  async function direct() {
    const f = await swarm()
    const app = (await f.execute({ type: 'project.create', name: 'App', visibility: 'public', brief: '' })).result as { projectId: string; conversationId: string }
    await f.execute({ type: 'project.boardMode', projectId: app.projectId, on: true })
    const add = async (name: string, lead: boolean) => String((await f.execute({ type: 'agent.add', conversationId: app.conversationId, machineId: 'owner-mac',
      harnessId: randomUUID(), name, configuration: config, lead })).result.agentId)
    const pm = await add('Lead', true)
    const worker = await add('Builder', false)
    const task = String((await f.execute({ type: 'conversation.create', projectId: app.projectId, title: 'Copy', brief: '', checks: [] })).result.conversationId)
    await f.execute({ type: 'conversation.agent', conversationId: task, agentId: worker, present: true, lead: false })
    const ask = async (age: number, extra: Record<string, unknown>) => {
      const asked = await new SuperTabStore(db, () => NOW - age).execute(owner, f.tab, { operationId: randomUUID(), command: { type: 'decision.ask', conversationId: task,
        personId: peer.sub, questions: [{ question: `Ship how ${randomUUID()}?`, options: ['Behind a flag', 'To everyone'], recommended: 0, unblocks: 'The release', ...extra }] } as Command }, worker)
      const id = String((asked.result.decisionIds as string[])[0])
      await db.superTabDecision.update({ where: { id }, data: { createdAt: new Date(NOW - age) } })
      return id
    }
    const told = async (id: string, agentId: string) => (await f.store.messages(owner, f.tab, task, {}, agentId)).messages
      .filter(m => (m.source as { decisionId?: string } | null)?.decisionId === id && m.recipientIds.includes(agentId))
    return { ...f, pm, worker, task, ask, told }
  }

  it('applies the recommendation at its time, and the asking agent hears it', async () => {
    const f = await direct()
    const id = await f.ask(HOUR, { defaultAt: at(0) })
    expect(await f.store.leaveOverdueDecisions(NOW)).toEqual({ answered: 1, skipped: 0, failed: 0 })
    expect(await f.row(id)).toMatchObject({ choice: 0, delegated: true, defaulted: true })
    expect(await f.told(id, f.worker)).toHaveLength(1)
  })

  it('waits for a person who must agree: the PM is told once, no later pass or the 24-hour sweep answers, and the person still can', async () => {
    const f = await direct()
    const id = await f.ask(HOUR, { defaultAt: at(0), mustAgree: true })
    expect(await f.row(id)).toMatchObject({ mustAgree: true })
    // Not answered: the sweep skips it, once.
    expect(await f.store.leaveOverdueDecisions(NOW)).toEqual({ answered: 0, skipped: 1, failed: 0 })
    expect(await f.row(id)).toMatchObject({ answeredAt: null, choice: null, defaulted: null })
    const pmTold = await f.told(id, f.pm)
    expect(pmTold).toHaveLength(1)
    expect(pmTold[0]).toMatchObject({ source: { kind: 'decision-must-agree' } })
    expect(pmTold[0]!.text).not.toContain('To everyone')
    expect(await f.store.leaveOverdueDecisions(NOW + 1)).toEqual({ answered: 0, skipped: 0, failed: 0 })
    expect(await new SuperTabStore(db, () => NOW + 2 * DAY).leaveOverdueDecisions(NOW + 2 * DAY)).toEqual({ answered: 0, skipped: 0, failed: 0 })
    expect(await f.told(id, f.pm)).toHaveLength(1)
    expect((await f.store.decisions(peer, f.tab, 'open')).decisions.map(d => d.id)).toContain(id)
    await f.execute({ type: 'decision.answer', decisionId: id, choice: 1 }, peer)
    expect(await f.row(id)).toMatchObject({ choice: 1, delegated: null })
  })
})
