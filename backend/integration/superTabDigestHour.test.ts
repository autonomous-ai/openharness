import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MongoMemoryReplSet } from 'mongodb-memory-server-core'
import type { PrismaClient } from '@prisma/client'
import type { AuthUser } from '../src/lib/ssoAuth.js'
import { SuperTabStore } from '../src/superTabs/store.js'
import type { Command } from '../src/superTabs/commands.js'
import { planDatabase } from './plans.test-support.js'

// Every project keeps a default morning digest, due from 08:00 to 09:00 Vietnam time (digest.ts), and the suite's stores run
// on the real clock. In that hour each Lead's poll got one more message, and ten tests of superTabs and superTabMessagePages
// failed on every pull request (#2871, #2872). This runs what they assert on that clock at 08:30.
const EIGHT_THIRTY_VIETNAM = Date.UTC(2026, 10, 4, 1, 30)
const owner: AuthUser = { sub: '500000000000000000000001', email: 'owner@example.com', autonomousEnv: 'prod', role: 'user' }
const host: AuthUser = { sub: '500000000000000000000003', email: 'host@example.com', autonomousEnv: 'prod', role: 'user' }
const config = { engine: 'codex', model: 'fixture-model', effort: 'high', contextWindow: 200000, engineVersion: 'fixture' }
let replica: MongoMemoryReplSet
let db: PrismaClient

beforeAll(async () => {
  ({ replica, db } = await planDatabase('swarm_digest_hour_test'))
  for (const user of [owner, host]) await db.user.create({ data: { id: user.sub, externalId: `fixture-${user.sub}`, email: user.email, autonomousEnv: 'prod' } })
  await db.machine.create({ data: { machineId: 'test-host', userId: host.sub, apiKey: 'fixture-only', managerId: 'fixture', autonomousEnv: 'prod', authMode: 'remote' } })
  await db.machineShare.create({ data: { machineId: 'test-host', ownerId: host.sub, autonomousEnv: 'prod', emails: [owner.email] } })
})
afterAll(async () => {
  await db?.$disconnect()
  await replica?.stop()
})
// Only Date: the database's drivers keep their real timers.
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'], now: EIGHT_THIRTY_VIETNAM }) })
afterEach(() => { vi.useRealTimers() })

describe('the suite at 08:30 Vietnam time, on the clock a store takes by default', () => {
  async function fixture() {
    // Made under the fake clock: a store keeps the Date.now it was built with.
    const store = new SuperTabStore(db)
    const tab = (await store.create(owner, randomUUID(), 'Digest hour')).id
    const run = (command: Command) => store.execute(owner, tab, { operationId: randomUUID(), command })
    const lead = String((await run({ type: 'agent.add', conversationId: 'lead', machineId: 'test-host', harnessId: randomUUID(), name: 'Lead',
      configuration: config, lead: true })).result.agentId)
    return { store, tab, run, lead }
  }

  it("adds nothing to a Lead's poll or its chat", async () => {
    const { store, tab, lead } = await fixture()
    expect(await store.deliveries(host, tab, lead)).toEqual([])
    const rows = await db.superTabMessage.findMany({ where: { tabId: tab, conversationId: 'lead' } })
    expect(rows.filter(m => (m.source as { kind?: string } | null)?.kind === 'digest-request')).toEqual([])
  })

  it('leaves a message to the Lead the only one it is given', async () => {
    const { store, tab, run, lead } = await fixture()
    const sent = await run({ type: 'message.send', conversationId: 'lead', text: 'Hello', replyTo: null, recipientIds: [lead] })
    expect((await store.deliveries(host, tab, lead)).map(d => d.messageId)).toEqual([sent.result.messageId])
  })
})
