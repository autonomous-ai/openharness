import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { MongoMemoryReplSet } from 'mongodb-memory-server-core'
import type { PrismaClient } from '@prisma/client'
import type { AuthUser } from '../src/lib/ssoAuth.js'
import { SuperTabStore } from '../src/superTabs/store.js'
import type { Command } from '../src/superTabs/commands.js'
import type { StoredCreate } from '../src/superTabs/steps.test-support.js'
import { planDatabase, plan, profiled, reads } from './plans.test-support.js'
import { storeAssignment, storeCreate, storeStatus } from './storedWork.test-support.js'
import { PERSONAL_SWARM_OPERATION } from '../src/superTabs/deletion.js'

// Task #2924 (Dee and River, 2026-11-04): an agent with a task in the project talks in its project chat without joining it, and a
// person's answer to its line there reaches it. Through the store, as hosts and apps call it. A fresh loopback replica set;
// never DATABASE_URL. A person posts in a project's chat only in their Personal Swarm while agents only exempts it
// (agentsOnly.test.ts): each test runs in its own person's Personal Swarm, and these go with that exemption.
let replica: MongoMemoryReplSet
let db: PrismaClient
let store: SuperTabStore
const owner: AuthUser = { sub: '100000000000000000000001', email: 'owner@example.com', autonomousEnv: 'prod', role: 'user' }
const other: AuthUser = { sub: '100000000000000000000002', email: 'other@example.com', autonomousEnv: 'prod', role: 'user' }
const host: AuthUser = { sub: '100000000000000000000003', email: 'host@example.com', autonomousEnv: 'prod', role: 'user' }
const config = { engine: 'codex', model: 'fixture-model', effort: 'high', contextWindow: 200000, engineVersion: 'fixture' }
let person = owner
const run = (tab: string, command: Command | StoredCreate, user = person, asAgentId?: string) => command.type === 'conversation.create'
  ? storeCreate(db, tab, command, user, asAgentId) : store.execute(user, tab, { operationId: randomUUID(), command }, asAgentId)
const post = (text: string, replyTo: string | null = null): Command => ({ type: 'message.send', conversationId: 'lead', text, replyTo, recipientIds: [] })

beforeAll(async () => {
  ({ replica, db } = await planDatabase('project_chat_workers'))
  store = new SuperTabStore(db)
  for (const user of [owner, other, host]) await db.user.create({ data: { id: user.sub, externalId: `fixture-${user.sub}`, email: user.email, autonomousEnv: 'prod' } })
  await db.machine.create({ data: { machineId: 'test-host', userId: host.sub, apiKey: 'fixture-only', managerId: 'fixture', autonomousEnv: 'prod', authMode: 'remote' } })
  await db.machineShare.create({ data: { machineId: 'test-host', ownerId: host.sub, autonomousEnv: 'prod', emails: [owner.email, other.email] } })
})
afterAll(async () => {
  await db?.$disconnect()
  await replica?.stop()
})

/** [user]'s Personal Swarm with its PM and an Engineer assigned a task, neither but the PM in the project chat. */
async function working(user: AuthUser) {
  person = user
  const tab = (await store.create(user, PERSONAL_SWARM_OPERATION, 'Personal')).id
  const add = async (conversationId: string, name: string, lead: boolean) => (await run(tab, { type: 'agent.add', conversationId, machineId: 'test-host',
    harnessId: randomUUID(), name, configuration: config, lead })).result.agentId as string
  const lead = await add('lead', 'Lead', true)
  const task = String((await run(tab, { type: 'conversation.create', title: 'Login bug', brief: 'Fix it.', checks: [] })).result.conversationId)
  const engineer = await add(task, 'Builder', false)
  await storeAssignment(db, tab, task, engineer)
  const members = async () => (await store.read(user, tab)).state.conversations.find(c => c.id === 'lead')!.agentIds
  return { tab, lead, task, engineer, members }
}

describe('an agent with a task in the project, in its project chat', () => {
  it('posts there without joining, and its host claims a person\'s answer in its thread or right below its line', async () => {
    const { tab, lead, task, engineer, members } = await working(owner)
    expect(await members()).toEqual([lead])
    const asked = String((await run(tab, post('Can someone check the login bug?'))).result.messageId)
    const line = String((await run(tab, post('I am on it: the token expires early.', asked), host, engineer)).result.messageId)
    const top = String((await run(tab, post('Fixed in the next build.'), host, engineer)).result.messageId)
    const inThread = String((await run(tab, post('Thanks, which build?', top))).result.messageId)
    const below = String((await run(tab, post('Also the phone, please.'))).result.messageId)
    expect(await members()).toEqual([lead])
    const rows = (await store.messages(person, tab, 'lead', {})).messages
    expect(rows.find(m => m.id === line)).toMatchObject({ author: { kind: 'agent', id: engineer }, thread: asked, recipientIds: [] })
    expect(rows.find(m => m.id === inThread)!.recipientIds).toEqual([engineer])
    expect(rows.find(m => m.id === below)!.recipientIds).toEqual([engineer, lead])
    const deliveries = await store.deliveries(host, tab, engineer)
    for (const messageId of [inThread, below]) {
      const delivery = deliveries.find(d => d.messageId === messageId)!
      expect((await store.delivery(host, tab, engineer, delivery.id, { type: 'claim', claimId: randomUUID() })).message).toMatchObject({ id: messageId })
    }
    // Once its work there ends, what waits for it is no longer handed to its host.
    const late = String((await run(tab, post('One more thing?', top))).result.messageId)
    const waiting = (await store.deliveries(host, tab, engineer)).find(d => d.messageId === late)!
    await storeStatus(db, tab, task, 'cancelled', 'Moved on.')
    await expect(store.delivery(host, tab, engineer, waiting.id, { type: 'claim', claimId: randomUUID() })).rejects.toMatchObject({ code: 'DELIVERY_REVOKED' })
    expect((await store.deliveries(host, tab, engineer)).map(d => d.messageId)).not.toContain(late)
  })

  // Backend rule 3: the line above a person's is read through the chat's sequence index, its newest rows only.
  it('reads the line above a person\'s by the sequence index, examining only the newest rows', async () => {
    const { tab, engineer } = await working(other)
    for (let i = 0; i < 60; i++) await run(tab, post(`Older line ${i}.`))
    await run(tab, post('I am on it.'), host, engineer)
    const entries = await profiled(db, () => run(tab, post('Thanks!')))
    const above = plan(reads(entries, 'SuperTabMessage', ['tabId', 'conversationId'], ['id', 'messageId', 'thread', 'sequence', 'createdAt']))
      .filter(r => r.returned > 1)
    expect(above).toEqual([expect.objectContaining({ plan: expect.stringMatching(/^IXSCAN .*tabId.*conversationId.*sequence/) })])
    expect(above[0]!.docsExamined).toBeLessThanOrEqual(20)
  })
})

