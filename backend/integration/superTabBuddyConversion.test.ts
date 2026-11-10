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
import * as parts from '../src/superTabs/parts/index.js'
import type { Agent, SuperTabState } from '../src/superTabs/model.js'
import { swarmBuddyChatId } from '../src/superTabs/buddies.js'
import { convertBuddiesOnce } from '../src/superTabs/migration/buddiesJob.js'

// Swarm v4 has no Buddies (the lead's decision, 2026-11-10): a one-time job in the worker, and the time checks after it, make every
// Buddy an ordinary agent of its person and its Buddy chat their 1:1 chat (buddyConversion.ts). A fresh loopback replica set.
let replica: MongoMemoryReplSet
let db: PrismaClient
let store: SuperTabStore
const owner: AuthUser = { sub: '300000000000000000000001', email: 'owner@example.com', autonomousEnv: 'prod', role: 'user' }
const person: AuthUser = { sub: '300000000000000000000002', email: 'person@example.com', autonomousEnv: 'prod', role: 'user' }
const config = { engine: 'claude', model: null, effort: null, contextWindow: null, engineVersion: null }
const run = (tab: string, command: Command, user: AuthUser = owner) => store.execute(user, tab, { operationId: randomUUID(), command })

async function storedState(tab: string): Promise<SuperTabState> {
  return parts.reassemble(await db.$transaction(tx => parts.loadAll(tx, tab)))
}
/** Replaces a Swarm's parts with [state], as an older release would have left them. Versions keep rising. */
async function saveState(tab: string, state: SuperTabState) {
  await db.$transaction(async tx => {
    const current = await parts.loadAll(tx, tab)
    const version = Math.max(current.head.version, ...[...current.members, ...current.agents, ...current.groups, ...current.machines,
      ...current.starts, ...current.progress].map(p => p.version)) + 1
    for (const model of [tx.swarmHead, tx.swarmMember, tx.swarmAgent, tx.swarmGroup, tx.swarmMachine, tx.swarmStart, tx.swarmProgress] as unknown as
      Array<{ deleteMany(args: unknown): Promise<unknown> }>) await model.deleteMany({ where: { tabId: tab } })
    await parts.insertParts(tx, { ...parts.split(state, { tabId: tab, version, now: Date.now(), visibilityEpoch: current.visibilityEpoch }),
      sequenceBase: current.sequenceBase })
  })
}
const headVersion = async (tab: string) => (await db.swarmHead.findFirst({ where: { tabId: tab } }))!.version

/** The owner's Swarm as v4 runs it (their PM, a task with words in it), and what a v3 release left of the person's Buddy: the
 *  Buddy on their own computer, a thread session beside it, and their private Buddy chat, quiet, with what they told it there. */
async function fixture() {
  const tab = (await store.create(owner, randomUUID(), 'Buddies')).id
  const invitation = await run(tab, { type: 'invite.create', email: person.email, role: 'collaborator', conversationId: 'lead' })
  await run(tab, { type: 'invite.accept', inviteId: invitation.result.inviteId as string }, person)
  const pm = String((await run(tab, { type: 'agent.add', conversationId: 'lead', machineId: 'owner-host', harnessId: randomUUID(),
    name: 'Lead', configuration: config, lead: true })).result.agentId)
  const task = String((await run(tab, { type: 'conversation.create', projectId: 'lead', title: 'Work', brief: 'Do it',
    checks: [{ description: 'Verified', independent: false }] })).result.conversationId)
  const said = String((await run(tab, { type: 'message.send', conversationId: task, text: 'Start with the parser.', replyTo: null, recipientIds: [] })).result.messageId)
  const state = await storedState(tab)
  const me = state.people.find(p => p.id === person.sub)!
  const chat = swarmBuddyChatId(me)
  const buddy: Agent = { id: 'buddy', machineId: 'person-mac', harnessId: 'buddy-harness', machineOwnerId: person.sub, contributorId: person.sub,
    membershipGeneration: me.generation, name: 'Theo', configuration: config, buddyOf: { personId: me.id, generation: me.generation }, buddyScope: 'swarm' }
  state.agents.push(buddy, { ...buddy, id: 'session', harnessId: 'session-harness', buddySession: { thread: 'root', from: 0 } })
  state.conversations.push({ id: chat, kind: 'swarm-buddy', title: 'Theo', buddyName: 'Theo', leadId: null, agentIds: ['buddy', 'session'], archived: false,
    brief: '', checks: [], assignment: null, lastMessageSequence: 0, audience: { people: [{ id: me.id, generation: me.generation }] },
    buddySessions: [{ thread: 'root', startId: 'start', agentId: 'session', at: 0 }] })
  await saveState(tab, state)
  const told = String((await run(tab, { type: 'message.send', conversationId: chat, text: 'Remember the parser idea.', replyTo: null, recipientIds: [] }, person)).result.messageId)
  await db.swarmGroup.updateMany({ where: { tabId: tab, key: chat }, data: { dormant: true } })
  return { tab, pm, task, said, chat, told, taskAgents: state.conversations.find(c => c.id === task)!.agentIds }
}

beforeAll(async () => {
  replica = await MongoMemoryReplSet.create({ binary: { version: '7.0.24', downloadDir: join(tmpdir(), 'harness-super-tab-mongodb-binaries') },
    replSet: { count: 1, ip: '127.0.0.1', storageEngine: 'wiredTiger' } })
  const uri = replica.getUri(`super_tab_buddy_conversion_${randomUUID().replaceAll('-', '_')}`)
  await promisify(execFile)(join(process.cwd(), 'node_modules/.bin/prisma'), ['db', 'push', '--skip-generate'], {
    env: { ...process.env, DATABASE_URL: uri }, timeout: 60000,
  })
  db = new PrismaClient({ datasources: { db: { url: uri } } })
  store = new SuperTabStore(db)
  for (const user of [owner, person]) await db.user.create({ data: { id: user.sub, externalId: `fixture-${user.sub}`,
    email: user.email, autonomousEnv: user.autonomousEnv } })
}, 120_000)
afterAll(async () => {
  await db?.$disconnect()
  await replica?.stop()
})

describe('the one-time job that makes every Buddy an ordinary agent', () => {
  it('converts each Buddy once when two pods run it together: its chat stays its person\'s alone, and v4\'s data stays', async () => {
    const f = await fixture()
    const untouched = (await store.create(owner, randomUUID(), 'No Buddy')).id
    const untouchedVersion = await headVersion(untouched)

    const passes = await Promise.all([new SuperTabStore(db), new SuperTabStore(db)].map(pod => convertBuddiesOnce(db, pod)))
    expect(passes.map(p => p.failed)).toEqual([0, 0])

    const state = await storedState(f.tab)
    const agent = state.agents.find(a => a.id === 'buddy')!
    expect(agent).toMatchObject({ regular: true, chatId: f.chat, contributorId: person.sub, machineOwnerId: person.sub, name: 'Theo' })
    expect(agent).not.toHaveProperty('buddyOf')
    expect(state.agents.some(a => a.buddyOf)).toBe(false)
    const chat = state.conversations.find(c => c.id === f.chat)!
    expect(chat).toMatchObject({ kind: 'agent-chat', title: 'Theo', agentIds: ['buddy'], audience: { people: [{ id: person.sub }] } })
    expect(chat).not.toHaveProperty('buddySessions')
    // The thread session is gone, its host told to close it.
    expect(state.agents.map(a => a.id)).not.toContain('session')
    expect(state.closingSessions?.map(c => c.agentId)).toEqual(['session'])
    // Its person reads what they told it; the Swarm's owner does not even learn the chat is there.
    const page = await store.messages(person, f.tab, f.chat, {})
    expect(page.messages.map(m => m.id)).toContain(f.told)
    await expect(store.messages(owner, f.tab, f.chat, {})).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect((await store.read(owner, f.tab)).state.conversations.map(c => c.id)).not.toContain(f.chat)
    // Swarm v4's own data stays: the PM, the task, its members and its words.
    expect(state.conversations.find(c => c.id === 'lead')!.leadId).toBe(f.pm)
    expect(state.conversations.find(c => c.id === f.task)!.agentIds).toEqual(f.taskAgents)
    expect((await store.messages(owner, f.tab, f.task, {})).messages.some(m => m.id === f.said)).toBe(true)
    // A Swarm with no Buddy is read and never written.
    expect(await headVersion(untouched)).toBe(untouchedVersion)

    // Done: the next pass converts nothing, so the job stops.
    expect(await convertBuddiesOnce(db, store)).toEqual({ swarms: expect.any(Number), converted: 0, failed: 0 })
  })

  it('also runs in the time checks, for a Buddy an older backend added after the job', async () => {
    const f = await fixture()
    await store.runTimeChecks(f.tab)
    const state = await storedState(f.tab)
    expect(state.agents.some(a => a.buddyOf)).toBe(false)
    expect(state.conversations.find(c => c.id === f.chat)).toMatchObject({ kind: 'agent-chat', agentIds: ['buddy'] })
    // What the session's removal left for it to hear ends with it.
    expect(await db.superTabDelivery.count({ where: { tabId: f.tab, agentId: 'session', status: { in: ['queued', 'claimed'] } } })).toBe(0)
  })
})
