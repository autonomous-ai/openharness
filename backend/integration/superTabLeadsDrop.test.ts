import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MongoMemoryReplSet } from 'mongodb-memory-server-core'
import { PrismaClient } from '@prisma/client'
import { migrateSwarm } from '../src/superTabs/migration/migrate.js'
import { dropLeadsChats } from '../src/superTabs/migration/dropLeads.js'
import { dropLegacyUntilDone } from '../src/superTabs/migration/dropLegacyJob.js'
import { SuperTabStore } from '../src/superTabs/store.js'
import { storeOldLeads } from '../src/superTabs/leads.test-support.js'
import { writeLegacySwarm } from '../scripts/swarm-parts/legacy.js'
import { NOW, owner, richSwarm } from '../src/superTabs/read/fixture.test-support.js'

// The Leads conversations older Swarms still store go through the store's own write (migration/dropLeads.ts), with their
// messages and deliveries; every v4 conversation, message and delivery stays. A fresh loopback replica set, created here: this
// suite never reads DATABASE_URL or an existing database.
let replica: MongoMemoryReplSet
let db: PrismaClient
const LEADS = 'old-leads'

beforeAll(async () => {
  replica = await MongoMemoryReplSet.create({ binary: { version: '7.0.24', downloadDir: join(tmpdir(), 'harness-super-tab-mongodb-binaries') },
    replSet: { count: 1, ip: '127.0.0.1', storageEngine: 'wiredTiger' } })
  const uri = replica.getUri(`swarm_leads_drop_test_${randomUUID().replaceAll('-', '_')}`)
  await promisify(execFile)(join(process.cwd(), 'node_modules/.bin/prisma'), ['db', 'push', '--skip-generate'], {
    env: { ...process.env, DATABASE_URL: uri }, timeout: 60000,
  })
  db = new PrismaClient({ datasources: { db: { url: uri } } })
  await db.user.create({ data: { id: owner.userId, externalId: `fixture-${owner.userId}`, email: owner.email, autonomousEnv: 'prod' } })
})
afterAll(async () => {
  await db?.$disconnect()
  await replica?.stop()
})

const store = () => new SuperTabStore(db, () => NOW)
const user = { sub: owner.userId, email: owner.email, autonomousEnv: 'prod', role: 'user' } as const

/** A Swarm stored by parts with its old Leads conversation, as production has them: the rich fixture (project chat `lead`, a
 *  task, a private project's task) plus Leads, each with [perChat] messages, each delivered to the Lead. [stored]: still in one
 *  row, not migrated. */
async function swarm(perChat = 3, stored: 'parts' | 'row' = 'parts') {
  const s = richSwarm()
  const state = structuredClone(s.state)
  state.id = `tab-${randomUUID()}`
  storeOldLeads(state, [s.lead], LEADS)
  await writeLegacySwarm(db, { state, revision: 500 })
  if (stored === 'parts') expect((await migrateSwarm(db, state.id, { now: () => NOW })).ok).toBe(true)
  const chats = [LEADS, 'lead', s.web, s.secretGroup]
  for (const conversationId of chats) {
    for (let sequence = 1; sequence <= perChat; sequence++) {
      const id = `${conversationId}-m${sequence}-${randomUUID()}`
      await db.superTabMessage.create({ data: { id, tabId: state.id, conversationId, sequence, author: { kind: 'person', id: owner.userId, name: owner.email } as never,
        text: `Message ${sequence}`, recipientIds: [s.lead], createdAt: new Date(NOW) } })
      await db.superTabDelivery.create({ data: { id: `d-${id}`, tabId: state.id, conversationId, messageId: id, agentId: s.lead, machineId: 'host',
        membershipGeneration: 'g', authorKind: 'person', authorId: owner.userId, authorGeneration: 'g' } })
    }
  }
  return { tabId: state.id, lead: s.lead, web: s.web, secretGroup: s.secretGroup }
}
const groups = (tabId: string) => db.swarmGroup.findMany({ where: { tabId }, select: { key: true, version: true, deleted: true, data: true } })
const counts = async (tabId: string, conversationId: string) => ({
  messages: await db.superTabMessage.count({ where: { tabId, conversationId } }),
  deliveries: await db.superTabDelivery.count({ where: { tabId, conversationId } }) })

describe('dropping the Leads conversations', () => {
  it('tombstones the Leads group at its next version, clears the head, and removes its messages and deliveries alone', async () => {
    const s = await swarm()
    const before = await groups(s.tabId)
    expect(before.find(g => g.key === LEADS)).toMatchObject({ deleted: false })
    const report = await dropLeadsChats(db, store())
    expect(report).toMatchObject({ swarms: 1, conversations: 1, messages: 3, deliveries: 3, done: false })
    const after = await groups(s.tabId)
    const leads = before.find(g => g.key === LEADS)!
    expect(after.find(g => g.key === LEADS)).toMatchObject({ deleted: true, version: leads.version + 1 })
    // Every v4 conversation stays, unchanged: the project chat, a task, a private project's task.
    for (const group of before.filter(g => g.key !== LEADS)) {
      expect(after.find(g => g.key === group.key), group.key).toEqual(group)
    }
    expect(await counts(s.tabId, LEADS)).toEqual({ messages: 0, deliveries: 0 })
    for (const chat of ['lead', s.web, s.secretGroup]) expect(await counts(s.tabId, chat), chat).toEqual({ messages: 3, deliveries: 3 })
    const head = await db.swarmHead.findUniqueOrThrow({ where: { id: `${s.tabId}:head` } })
    expect(head.data).not.toHaveProperty('leadsConversationId')
    // The Swarm reads as before, without it.
    const read = await store().read(user as never, s.tabId)
    expect(read.state.conversations.map(c => c.id)).not.toContain(LEADS)
    expect(read.state.conversations.map(c => c.id)).toEqual(expect.arrayContaining(['lead', s.web]))
    // A second pass finds nothing to do, and says the job is done.
    expect(await dropLeadsChats(db, store())).toEqual({ swarms: 0, conversations: 0, messages: 0, deliveries: 0, done: true })
  })

  it('finds the messages of a Leads conversation removed by a run that stopped before them', async () => {
    const s = await swarm(2)
    // The conversation went, its messages did not: as a run stopped between the two.
    expect(await store().dropLeads(s.tabId, [LEADS])).toEqual([LEADS])
    expect(await counts(s.tabId, LEADS)).toEqual({ messages: 2, deliveries: 2 })
    expect(await dropLeadsChats(db, store())).toMatchObject({ conversations: 0, messages: 2, deliveries: 2, done: false })
    expect(await counts(s.tabId, LEADS)).toEqual({ messages: 0, deliveries: 0 })
  })

  it('removes each conversation once when two servers run it at once', async () => {
    const s = await swarm(4)
    const [one, two] = await Promise.all([dropLeadsChats(db, store()), dropLeadsChats(db, store())])
    expect(one.conversations + two.conversations).toBe(1)
    expect(one.messages + two.messages).toBe(4)
    expect(await counts(s.tabId, LEADS)).toEqual({ messages: 0, deliveries: 0 })
    for (const chat of ['lead', s.web]) expect(await counts(s.tabId, chat)).toEqual({ messages: 4, deliveries: 4 })
  })

  it('leaves a deleted Swarm\'s, and one still in one row, to their purge and migration', async () => {
    const deleted = await swarm(1)
    await db.superTab.update({ where: { id: deleted.tabId }, data: { deletedAt: new Date(NOW) } })
    const row = await swarm(1, 'row')
    await dropLeadsChats(db, store())
    expect((await groups(deleted.tabId)).find(g => g.key === LEADS)).toMatchObject({ deleted: false })
    expect(await counts(deleted.tabId, LEADS)).toEqual({ messages: 1, deliveries: 1 })
    expect(await counts(row.tabId, LEADS)).toEqual({ messages: 1, deliveries: 1 })
  })

  it('runs in the legacy drop job with the store, and the job ends once a pass removes nothing', async () => {
    // A Swarm still in one row holds the job's old-state step back (dropLegacy.ts): the one the test above left goes first.
    await db.superTab.deleteMany({ where: { format: { not: 2 } } })
    const s = await swarm(1)
    const lines: Array<Record<string, unknown>> = []
    // A few rounds at most: a job that never ends stops here instead of hanging the suite.
    const stop = new AbortController()
    let rounds = 0
    const report = await dropLegacyUntilDone(db, { leads: store(), log: line => lines.push(line), signal: stop.signal,
      wait: async () => { if (++rounds >= 5) stop.abort() } })
    expect(rounds).toBeLessThan(5)
    expect(report?.done).toBe(true)
    expect(await counts(s.tabId, LEADS)).toEqual({ messages: 0, deliveries: 0 })
    // Counts only: no Swarm, conversation or message id in what it logs.
    expect(JSON.stringify(lines)).not.toContain(s.tabId)
    expect(JSON.stringify(lines)).not.toContain(LEADS)
  })
})
