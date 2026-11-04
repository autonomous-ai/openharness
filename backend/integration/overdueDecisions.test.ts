import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { MongoMemoryReplSet } from 'mongodb-memory-server-core'
import type { PrismaClient } from '@prisma/client'
import type { AuthUser } from '../src/lib/ssoAuth.js'
import { SuperTabStore } from '../src/superTabs/store.js'
import type { Command } from '../src/superTabs/commands.js'
import { overdueNotice } from '../src/superTabs/decisions.js'
import { OVERDUE_DECISION_MS, overdueDecisions } from '../src/superTabs/overdueDecisions.js'
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
async function swarm() {
  const store = new SuperTabStore(db, () => NOW)
  const tab = (await store.create(owner, randomUUID(), 'Overdue', 'public')).id
  const execute = (command: Command, user = owner, asAgentId?: string) => store.execute(user, tab, { operationId: randomUUID(), command }, asAgentId)
  const invitation = await execute({ type: 'invite.create', email: peer.email, role: 'collaborator', conversationId: 'lead' })
  await execute({ type: 'invite.accept', inviteId: invitation.result.inviteId as string }, peer)
  const lead = String((await execute({ type: 'agent.add', conversationId: 'lead', machineId: 'owner-mac', harnessId: randomUUID(), name: 'PM', configuration: config, lead: true })).result.agentId)
  /** Asks peer one question, then dates it `age` ago. */
  const ask = async (age: number) => {
    const before = new Set((await db.superTabDecision.findMany({ where: { tabId: tab }, select: { id: true } })).map(d => d.id))
    await execute({ type: 'decision.ask', conversationId: 'lead', personId: peer.sub, questions: [{ question: `Which week ${randomUUID()}?`, options: ['This week', 'Next week'], recommended: 1, unblocks: 'The plan' }] }, owner, lead)
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
  return { store, tab, execute, ask, askBroken, row, notices }
}

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
