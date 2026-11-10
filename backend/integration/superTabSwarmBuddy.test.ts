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
import { MemoryAttachmentStore } from '../src/superTabs/attachments.js'
import type { Command } from '../src/superTabs/commands.js'
import { poolRows } from './hostRows.test-support.js'
import { profiled } from './plans.test-support.js'
import { storeBuddy, storeProjectBuddy, storeSession } from './storedBuddies.test-support.js'
import * as parts from '../src/superTabs/parts/index.js'
import { swarmTransaction } from '../src/superTabs/cache.js'
import { guardedWrite } from '../src/superTabs/parts/write.js'
import type { Conversation } from '../src/superTabs/model.js'

// One Buddy per person per Swarm (docs/specs/2026-10-31-one-buddy-per-swarm.md; Dee, 10-31): one chat at Swarm level, a main
// Buddy that reads every project its person reads and writes nowhere but that chat, and project sessions, which read one
// project. Nothing makes a Buddy or a session since Swarm v4 (2026-11-10): these are the rules for those a v3 release stored,
// which hold until the conversion makes each an ordinary agent (buddyConversion.ts). Then + New agent, v4's own. A fresh
// loopback replica set, created here.
let replica: MongoMemoryReplSet
let db: PrismaClient
const owner: AuthUser = { sub: '320000000000000000000001', email: 'owner@example.com', autonomousEnv: 'prod', role: 'user' }
const peer: AuthUser = { sub: '320000000000000000000002', email: 'peer@example.com', autonomousEnv: 'prod', role: 'user' }
const other: AuthUser = { sub: '320000000000000000000003', email: 'other@example.com', autonomousEnv: 'prod', role: 'user' }
const config = { engine: 'claude', model: 'fixture-model', effort: 'high', contextWindow: 200000, engineVersion: 'fixture' }
// Exactly the words a made-up id gets: another project's chat must not read differently (security review 2 of #2435).
const UNAVAILABLE = /^This conversation is unavailable\.$/

beforeAll(async () => {
  replica = await MongoMemoryReplSet.create({ binary: { version: '7.0.24', downloadDir: join(tmpdir(), 'harness-super-tab-mongodb-binaries') },
    replSet: { count: 1, ip: '127.0.0.1', storageEngine: 'wiredTiger' } })
  const uri = replica.getUri(`swarm_one_buddy_test_${randomUUID().replaceAll('-', '_')}`)
  await promisify(execFile)(join(process.cwd(), 'node_modules/.bin/prisma'), ['db', 'push', '--skip-generate'], {
    env: { ...process.env, DATABASE_URL: uri }, timeout: 60000,
  })
  db = new PrismaClient({ datasources: { db: { url: uri } } })
  for (const user of [owner, peer, other]) await db.user.create({ data: { id: user.sub, externalId: `fixture-${user.sub}`, email: user.email, autonomousEnv: user.autonomousEnv } })
  for (const [machineId, user] of [['owner-mac', owner], ['peer-mac', peer]] as const) {
    await db.machine.create({ data: { machineId, userId: user.sub, apiKey: `fixture-${machineId}`, managerId: 'fixture', autonomousEnv: 'prod', authMode: 'remote' } })
  }
})
afterAll(async () => {
  await db?.$disconnect()
  await replica?.stop()
})

/**
 * A Swarm with three projects: `lead` (public), `web` (public) and `secret` (private: owner and peer), each with its PM on the
 * owner's Mac; peer a member with their own Mac, whose host reports what runs there.
 */
async function swarm() {
  const clock = { now: Date.now() }, running: string[] = []
  const store = new SuperTabStore(db, () => clock.now, { store: new MemoryAttachmentStore(), prefix: 'super-tabs', publicBase: 'https://cdn.example.test' })
  const tab = (await store.create(owner, randomUUID(), 'One Buddy', 'public')).id
  const execute = (command: Command, user = owner, asAgentId?: string, hostMachineId?: string) =>
    store.execute(user, tab, { operationId: randomUUID(), command }, asAgentId, hostMachineId)
  for (const person of [peer, other]) {
    const invitation = await execute({ type: 'invite.create', email: person.email, role: 'collaborator', conversationId: 'lead' })
    await execute({ type: 'invite.accept', inviteId: invitation.result.inviteId as string }, person)
  }
  const web = (await execute({ type: 'project.create', name: 'Web', visibility: 'public', brief: '' })).result as { projectId: string; conversationId: string }
  const secret = (await execute({ type: 'project.create', name: 'Secret', visibility: 'private', brief: '' })).result as { projectId: string; conversationId: string }
  await execute({ type: 'project.sharing', projectId: secret.projectId, visibility: 'private', memberIds: [owner.sub, peer.sub] })
  const pms: Record<string, string> = {}
  for (const [key, conversationId] of [['lead', 'lead'], ['web', web.conversationId], ['secret', secret.conversationId]] as const) {
    pms[key] = String((await execute({ type: 'agent.add', conversationId, machineId: 'owner-mac', harnessId: randomUUID(), name: `PM ${key}`,
      configuration: config, lead: true })).result.agentId)
  }
  await execute({ type: 'machine.contribute', machineId: 'peer-mac', name: 'Peer Mac', cwd: '/swarm', scope: 'swarm', engines: ['claude'], maxAgents: 8 }, peer)
  const generation = (await poolRows(store, peer, 'peer-mac')).find(p => p.tabId === tab)!.machine.generation
  const report = () => store.observeMachine(peer, tab, 'peer-mac', { generation, resources: { cpuPercent: 10, memoryTotalBytes: 32e9, memoryUsedBytes: 4e9,
    diskFreeBytes: 120e9, diskTotalBytes: 500e9, projectDiskFreeBytes: 120e9, deviceType: 'Laptop', chip: 'Fixture', os: 'macOS', gpuPercent: null },
  quotas: [], tools: {}, runningHarnessIds: [...running], stoppedHarnessIds: [] })
  await report()
  const host = (command: Command) => execute(command, peer, undefined, 'peer-mac')
  /** Launches start [startId] as peer-mac's host does; its agent's id. */
  const launch = async (startId: string) => {
    await host({ type: 'agent.startDispatch', startId })
    const harnessId = randomUUID()
    running.push(harnessId)
    const agentId = String((await host({ type: 'agent.started', startId, harnessId, configuration: config })).result.agentId)
    await host({ type: 'agent.startSettled', startId, warning: null })
    await report()
    return agentId
  }
  return { store, tab, execute, launch, report, clock, pms, web, secret, generation, running }
}
type Swarm = Awaited<ReturnType<typeof swarm>>

/** peer's one Buddy, in their one Buddy chat as a v3 release stored it, running on their Mac. */
async function buddy(f: Swarm) {
  const stored = await storeBuddy(db, f.tab, { personId: peer.sub, machineId: 'peer-mac', configuration: config })
  f.running.push(stored.harnessId)
  await f.report()
  return { chat: stored.chat, main: stored.agentId }
}
const send = (f: Swarm, chat: string, text: string, extra: Partial<Extract<Command, { type: 'message.send' }>> = {}, user = peer, as?: string) =>
  f.execute({ type: 'message.send', conversationId: chat, text, replyTo: null, recipientIds: [], ...extra }, user, as)
/** Marks row [id] a thread session's, of [projectId], as a session's start and its thread's replies were stored until Swarm v4. */
const sessionRow = (id: string, projectId: string) => db.superTabMessage.update({ where: { id }, data: { buddySession: true, buddyProject: projectId } })
/** A session of [projectId] in peer's [chat], rooted at their own message [text] there, as a v3 release stored it, running on
 *  their Mac. Its thread and agent. */
async function projectSession(f: Swarm, chat: string, projectId: string, text = 'Work on this project') {
  const thread = String((await send(f, chat, text)).result.messageId)
  await sessionRow(thread, projectId)
  const from = (await db.superTabMessage.findUniqueOrThrow({ where: { id: thread } })).sequence - 1
  const session = await storeSession(db, f.tab, chat, { thread, from, projectId })
  f.running.push(session.harnessId)
  await f.report()
  return { thread, agentId: session.agentId }
}
/** A line of the secret project in peer's one Buddy chat, marked with that project, as one was stored there until Swarm v4: the
 *  secret PM's question to peer, which peer's own Buddy [buddyId] wrote (task #4558; Decisions are gone since 2026-11-10). Stored
 *  as the store stores a row, numbered after the chat's newest. */
async function secretLine(f: Swarm, chat: string, buddyId: string, text: string) {
  await swarmTransaction(db, async tx => {
    const current = (await parts.loadActive(tx, f.tab, { groupIds: [chat] })).groups.find(g => g.key === chat)!
    const data = structuredClone(current.data!) as Conversation
    const sequence = (data.messageSeq ?? 0) + 1, id = randomUUID()
    data.messageSeq = data.lastMessageSequence = data.lastMainSequence = sequence
    await tx.superTabMessage.create({ data: { id, tabId: f.tab, conversationId: chat, sequence, thread: id, text, recipientIds: [buddyId], mentions: [],
      author: { kind: 'agent', id: buddyId, name: 'Buddy' } as never, source: { kind: 'decision-asked', projectId: f.secret.projectId } as never,
      buddyProject: f.secret.projectId, createdAt: new Date(f.clock.now) } })
    await guardedWrite(tx, f.tab, { op: 'update', kind: 'group', key: chat, seen: current.version, data }, f.clock.now)
  })
}
const texts = async (f: Swarm, chat: string, user: AuthUser, as?: string, cursor: Record<string, unknown> = {}) =>
  (await f.store.messages(user, f.tab, chat, cursor, as)).messages.map(m => m.text)

describe('one Buddy chat per person per Swarm', () => {
  it('is read by its person alone', async () => {
    const f = await swarm()
    const { chat } = await buddy(f)
    await send(f, chat, 'A private idea')
    expect(await texts(f, chat, peer)).toContain('A private idea')
    for (const user of [owner, other]) {
      await expect(f.store.messages(user, f.tab, chat, {})).rejects.toThrow(UNAVAILABLE)
      expect((await f.store.read(user, f.tab)).state.conversations.map(c => c.id)).not.toContain(chat)
    }
    await expect(f.store.messages(owner, f.tab, chat, {}, f.pms.lead)).rejects.toThrow(UNAVAILABLE)
  })
})

describe('the main Buddy', () => {
  it('reads every project its person reads, and no project they do not', async () => {
    const f = await swarm()
    const { main } = await buddy(f)
    await send(f, f.web.conversationId, 'Web news', {}, owner)
    await send(f, f.secret.conversationId, 'Secret news', {}, owner)
    expect(await texts(f, 'lead', peer, main)).toBeDefined()
    expect(await texts(f, f.web.conversationId, peer, main)).toContain('Web news')
    expect(await texts(f, f.secret.conversationId, peer, main)).toContain('Secret news')
    await f.execute({ type: 'project.sharing', projectId: f.secret.projectId, visibility: 'private', memberIds: [owner.sub] })
    await expect(f.store.messages(peer, f.tab, f.secret.conversationId, {}, main)).rejects.toThrow(UNAVAILABLE)
    expect(JSON.stringify((await f.store.read(peer, f.tab, main)).state)).not.toContain(f.secret.conversationId)
  })

  it('writes nowhere but its own chat: no post, reaction, proposal or task in any project', async () => {
    const f = await swarm()
    const { chat, main } = await buddy(f)
    const pmLine = String((await send(f, f.web.conversationId, 'From the web PM', {}, owner)).result.messageId)
    for (const target of ['lead', f.web.conversationId, f.secret.conversationId]) {
      await expect(send(f, target, 'A post', {}, peer, main)).rejects.toMatchObject({ code: 'BUDDY_FORBIDDEN' })
    }
    await expect(send(f, f.web.conversationId, 'A reply', { replyTo: pmLine }, peer, main)).rejects.toMatchObject({ code: 'BUDDY_FORBIDDEN' })
    await expect(f.execute({ type: 'message.react', conversationId: f.web.conversationId, messageId: pmLine, emoji: 'eyes', on: true }, peer, main))
      .rejects.toMatchObject({ code: 'BUDDY_FORBIDDEN' })
    await expect(f.execute({ type: 'conversation.create', projectId: f.web.projectId, title: 'T', brief: '', checks: [] }, peer, main))
      .rejects.toMatchObject({ code: 'BUDDY_FORBIDDEN' })
    expect(await texts(f, f.web.conversationId, owner)).not.toContain('A post')
    // Its own chat it answers in.
    await send(f, chat, 'Here is the summary', {}, peer, main)
    expect(await texts(f, chat, peer)).toContain('Here is the summary')
  })
})

describe('a project session', () => {
  it('reads its own project alone, and of its chat only its own thread', async () => {
    const f = await swarm()
    const { chat } = await buddy(f)
    await send(f, chat, 'MAIN CHAT SENTINEL: the secret plan')
    await send(f, f.secret.conversationId, 'SECRET PROJECT SENTINEL', {}, owner)
    const { thread, agentId } = await projectSession(f, chat, f.web.projectId, 'Draft the web proposal')
    expect(await texts(f, f.web.conversationId, peer, agentId)).toBeDefined()
    // Another project, the main chat outside its thread and an invented id are refused alike.
    for (const id of ['lead', f.secret.conversationId, 'invented-group']) {
      await expect(f.store.messages(peer, f.tab, id, {}, agentId)).rejects.toThrow(UNAVAILABLE)
    }
    const own = await texts(f, chat, peer, agentId, { thread })
    expect(own).toContain('Draft the web proposal')
    expect(JSON.stringify(await f.store.messages(peer, f.tab, chat, {}, agentId))).not.toContain('MAIN CHAT SENTINEL')
    expect(JSON.stringify(await f.store.read(peer, f.tab, agentId))).not.toContain('SECRET PROJECT SENTINEL')
    expect((await f.store.read(peer, f.tab, agentId)).state.conversations.map(c => c.id)).not.toContain(f.secret.conversationId)
  })

  it('reads in its thread only its person\'s words and its own, never a main-Buddy root or excerpt', async () => {
    const f = await swarm()
    const { chat, main } = await buddy(f)
    const root = String((await send(f, chat, 'MAIN BUDDY SENTINEL: secret project numbers', {}, peer, main)).result.messageId)
    const ask = String((await send(f, chat, 'Send this to the web PM', { replyTo: root })).result.messageId)
    await sessionRow(ask, f.web.projectId)
    const from = (await db.superTabMessage.findUniqueOrThrow({ where: { id: ask } })).sequence - 1
    const { agentId } = await storeSession(db, f.tab, chat, { thread: root, from, projectId: f.web.projectId })
    const read = await f.store.messages(peer, f.tab, chat, { thread: root }, agentId)
    expect(JSON.stringify(read)).not.toContain('MAIN BUDDY SENTINEL')
    expect(read.messages.map(m => m.text)).toEqual(['Send this to the web PM'])
    // The root by its id reads exactly as a made-up id does.
    const invented = await f.store.messages(peer, f.tab, chat, { messageId: 'invented-message-id' }, agentId)
    expect(await f.store.messages(peer, f.tab, chat, { messageId: root }, agentId)).toEqual(invented)
  })
})

describe('the PM\'s lines and losing a project', () => {
  // Only the person and their own agent post in their private chat (anh Dee, 11-07, task #4558).
  it('refuses a PM\'s private line, and writes it nowhere', async () => {
    const f = await swarm()
    await buddy(f)
    await expect(f.execute({ type: 'person.tell', personId: peer.sub, text: 'WEB PM LINE' }, owner, f.pms.web))
      .rejects.toMatchObject({ code: 'PRIVATE_CHAT' })
    expect(await db.superTabMessage.count({ where: { tabId: f.tab, text: 'WEB PM LINE' } })).toBe(0)
  })

  it('takes a lost project out of the Buddy: its sessions end, its lines hide, and the main Buddy reads it no more', async () => {
    const f = await swarm()
    const { chat, main } = await buddy(f)
    const { thread, agentId } = await projectSession(f, chat, f.secret.projectId, 'SECRET SESSION SENTINEL')
    await secretLine(f, chat, main, 'SECRET PM LINE')
    expect((await texts(f, chat, peer)).join('\n')).toContain('SECRET PM LINE')
    await f.execute({ type: 'project.sharing', projectId: f.secret.projectId, visibility: 'private', memberIds: [owner.sub] })
    const state = (await f.store.read(peer, f.tab)).state
    expect(state.agents.map(a => a.id)).not.toContain(agentId)
    expect(state.agents.map(a => a.id)).toContain(main)
    const seen = JSON.stringify(await f.store.messages(peer, f.tab, chat, {}))
    expect(seen).not.toContain('SECRET PM LINE')
    expect(seen).not.toContain('SECRET SESSION SENTINEL')
    await expect(f.store.messages(peer, f.tab, chat, { thread }, main)).resolves.toBeDefined()
    expect(JSON.stringify(await f.store.messages(peer, f.tab, chat, {}, main))).not.toContain('SECRET PM LINE')
    await expect(f.store.messages(peer, f.tab, f.secret.conversationId, {}, main)).rejects.toThrow(UNAVAILABLE)
  })
})

describe('security reviews of #2435', () => {
  it('refuses a write into an older project chat from an app that knows one Buddy, and keeps an older app\'s', async () => {
    const f = await swarm()
    await buddy(f)
    const old = (await storeProjectBuddy(db, f.tab, f.web.projectId, { personId: peer.sub, machineId: 'peer-mac', configuration: config })).chat
    const line = String((await send(f, old, 'From the phone')).result.messageId)
    await expect(send(f, old, 'From new Desktop', { oneBuddy: true })).rejects.toMatchObject({ code: 'BUDDY_CHAT_EARLIER' })
    await expect(send(f, old, 'A thread reply', { replyTo: line, oneBuddy: true })).rejects.toMatchObject({ code: 'BUDDY_CHAT_EARLIER' })
    // A person's reaction is retired (reactions.ts): answered as ignored before anything is read, from any app.
    expect((await f.execute({ type: 'message.react', conversationId: old, messageId: line, emoji: 'eyes', on: true, oneBuddy: true }, peer)).result)
      .toMatchObject({ ignored: true })
    expect((await f.execute({ type: 'message.react', conversationId: old, messageId: line, emoji: 'eyes', on: true }, peer)).result)
      .toMatchObject({ ignored: true })
    expect(await texts(f, old, peer)).not.toContain('From new Desktop')
  })

  it('ends the one Buddy\'s session in an older project chat when its person loses the project', async () => {
    const f = await swarm()
    await buddy(f)
    const narrow = (await storeProjectBuddy(db, f.tab, f.secret.projectId, { personId: peer.sub, machineId: 'peer-mac', configuration: config })).agentId
    // Read as the owner, who still reads the project and so would see the agent if it were left: peer's own read hides it anyway.
    expect((await f.store.read(owner, f.tab)).state.agents.map(a => a.id)).toContain(narrow)
    await f.execute({ type: 'project.sharing', projectId: f.secret.projectId, visibility: 'private', memberIds: [owner.sub] })
    expect((await f.store.read(owner, f.tab)).state.agents.map(a => a.id)).not.toContain(narrow)
  })

  it('shows a project session none of its chat\'s sessions: other threads and other projects\'', async () => {
    const f = await swarm()
    const { chat } = await buddy(f)
    const { agentId } = await projectSession(f, chat, f.web.projectId, 'Web work')
    await projectSession(f, chat, f.secret.projectId, 'SECRET THREAD ROOT')
    const read = (await f.store.read(peer, f.tab, agentId)).state.conversations.find(c => c.id === chat)!
    expect(read.buddySessions).toBeUndefined()
    expect(JSON.stringify(read)).not.toContain(f.secret.projectId)
  })
})

describe('security re-check 2 of #2435', () => {
  it('puts a project session\'s terminal lines in its own thread, with its project, hidden once that project is lost', async () => {
    const f = await swarm()
    const { chat, main } = await buddy(f)
    const { thread, agentId } = await projectSession(f, chat, f.secret.projectId, 'Secret work')
    await f.execute({ type: 'agent.input', agentId, text: 'TYPED SENTINEL' }, peer)
    const row = await db.superTabMessage.findFirstOrThrow({ where: { tabId: f.tab, conversationId: chat, text: { contains: 'TYPED SENTINEL' } } })
    expect(row).toMatchObject({ thread, buddySession: true, buddyProject: f.secret.projectId })
    expect(JSON.stringify(await f.store.messages(peer, f.tab, chat, {}, main))).not.toContain('TYPED SENTINEL')
    await f.execute({ type: 'project.sharing', projectId: f.secret.projectId, visibility: 'private', memberIds: [owner.sub] })
    expect(JSON.stringify(await f.store.messages(peer, f.tab, chat, { thread }))).not.toContain('TYPED SENTINEL')
  })
})

// Task #3818: a person's other Buddies' chats are listed on their main one, whose id every command derives, so a command loads
// them even once they have gone quiet.
describe('several Buddies through the store (#3818)', () => {
  /** [chat] gone quiet, as the tidy pass leaves it: only a command that names it, or loads it with its list, reads it. */
  const quiet = async (f: Swarm, chat: string) => {
    const row = await db.swarmGroup.findFirstOrThrow({ where: { tabId: f.tab, key: chat } })
    await db.swarmGroup.update({ where: { id: row.id }, data: { dormant: true, version: row.version + 1, changedAt: new Date(),
      data: { ...row.data as object, dormant: true } } })
  }

  // Ken's 06:20 VN prod scan on v1.4.26 (task #4213): loading the listed chats loaded the whole Swarm again, so every command
  // in a Swarm with a quiet second Buddy read its machines, agents, members and progress twice.
  it('loads a quiet listed chat by itself: any command reads the Swarm\'s machines, agents, members and progress once', async () => {
    const f = await swarm()
    await buddy(f)
    const research = await storeBuddy(db, f.tab, { personId: peer.sub, machineId: 'peer-mac', configuration: config, name: 'Research', listed: true })
    await quiet(f, research.chat)
    const reads = await profiled(db, () => send(f, 'lead', 'Hello', {}, owner))
    // Every live row of the Swarm, by tab: not one row's version check by its id. Prisma's filters name a field as `$tabId`, a
    // plain match (the held listing, parts/held.ts) as `tabId`.
    const names = (filter: string, field: string) => filter.includes(`"$${field}"`) || filter.includes(`"${field}":`)
    const wholeSwarm = (collection: string) => reads.filter(e => e.ns.endsWith(`.${collection}`) && e.op !== 'update').filter(e => {
      const filter = JSON.stringify(e.command?.pipeline ?? e.command?.filter ?? {})
      return names(filter, 'tabId') && names(filter, 'deleted') && !names(filter, '_id')
    }).length
    expect(['SwarmMachine', 'SwarmAgent', 'SwarmMember', 'SwarmProgress'].map(c => [c, wholeSwarm(c)]))
      .toEqual([['SwarmMachine', 1], ['SwarmAgent', 1], ['SwarmMember', 1], ['SwarmProgress', 1]])
  })
})

// Task #4116 (Swarm v3, anh Dee 11-07): + New agent makes a Regular or a PM agent on the person's own computer, through the store:
// its grant is the store's reading of the machine's account row, never the request's.
describe('+ New agent through the store', () => {
  const capable = async (f: Swarm) => f.store.observeMachine(peer, f.tab, 'peer-mac', { generation: f.generation, resources: { cpuPercent: 10,
    memoryTotalBytes: 32e9, memoryUsedBytes: 4e9, diskFreeBytes: 120e9, diskTotalBytes: 500e9, projectDiskFreeBytes: 120e9, deviceType: 'Laptop', chip: 'Fixture',
    os: 'macOS', gpuPercent: null }, quotas: [], tools: {}, runningHarnessIds: [...f.running], stoppedHarnessIds: [],
  capabilities: ['leadStart', 'regularAgent'] })

  it('starts a Regular agent on the person\'s own computer, in a chat only they and it read', async () => {
    const f = await swarm()
    await capable(f)
    const made = await f.execute({ type: 'agent.new', kind: 'regular', name: 'Ada', engine: 'claude', machineId: 'peer-mac' }, peer)
    const chat = String(made.result.conversationId)
    const ada = await f.launch(String(made.result.startId))
    await capable(f)
    await expect(send(f, chat, 'Hello Ada')).resolves.toBeTruthy()
    await expect(send(f, chat, 'Hello', {}, peer, ada)).resolves.toBeTruthy()
    await expect(f.store.messages(owner, f.tab, chat, {})).rejects.toThrow(UNAVAILABLE)
    await expect(send(f, chat, 'Peeking', {}, owner)).rejects.toThrow(UNAVAILABLE)
    const read = await f.store.read(peer, f.tab)
    expect(read.state.agents.find(a => a.id === ada)).toMatchObject({ regular: true })
  })

  it('starts a PM that names its new project, on the person\'s own computer', async () => {
    const f = await swarm()
    await capable(f)
    const made = await f.execute({ type: 'agent.new', kind: 'pm', projectName: 'Docs', engine: 'claude', machineId: 'peer-mac' }, peer)
    const read = await f.store.read(peer, f.tab)
    expect(read.state.projects!.find(p => p.id === made.result.projectId)).toMatchObject({ name: 'Docs', ownerId: peer.sub })
    expect(read.state.starts!.find(s => s.id === made.result.startId)?.request).toMatchObject({ machineId: 'peer-mac', conversationId: made.result.conversationId })
  })

  it('is refused on a computer that is not the person\'s own', async () => {
    const f = await swarm()
    await expect(f.execute({ type: 'agent.new', kind: 'regular', name: 'Ada', engine: 'claude', machineId: 'owner-mac' }, peer)).rejects.toMatchObject({ code: 'AGENT_OWN_MACHINE' })
  })
})
