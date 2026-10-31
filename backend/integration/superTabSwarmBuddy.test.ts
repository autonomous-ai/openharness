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

// One Buddy per person per Swarm (docs/specs/2026-10-31-one-buddy-per-swarm.md; Dee, 10-31): one chat at Swarm level, a main
// Buddy that reads every project its person reads and writes nowhere but that chat, and project sessions, the only Buddies that
// write into a project. A fresh loopback replica set, created here.
let replica: MongoMemoryReplSet
let db: PrismaClient
const owner: AuthUser = { sub: '320000000000000000000001', email: 'owner@example.com', autonomousEnv: 'prod', role: 'user' }
const peer: AuthUser = { sub: '320000000000000000000002', email: 'peer@example.com', autonomousEnv: 'prod', role: 'user' }
const other: AuthUser = { sub: '320000000000000000000003', email: 'other@example.com', autonomousEnv: 'prod', role: 'user' }
const config = { engine: 'claude', model: 'fixture-model', effort: 'high', contextWindow: 200000, engineVersion: 'fixture' }
const UNAVAILABLE = /unavailable/

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
 * owner's Mac; peer a member with their own Mac, whose host says it runs a Swarm Buddy and its sessions (or not: `capable`).
 */
async function swarm({ capable = true } = {}) {
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
  quotas: [], tools: {}, runningHarnessIds: [...running], stoppedHarnessIds: [], ...(capable ? { capabilities: ['buddySessions', 'swarmBuddy'] } : {}) })
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
  return { store, tab, execute, host, launch, report, clock, pms, web, secret }
}
type Swarm = Awaited<ReturnType<typeof swarm>>

/** peer's one Buddy, added from # buddy and started by their Mac's host. */
async function buddy(f: Swarm) {
  const added = await f.execute({ type: 'buddy.create', machineId: 'peer-mac', engine: 'claude' }, peer)
  const chat = String(added.result.conversationId)
  return { chat, main: await f.launch(String(added.result.startId)) }
}
const send = (f: Swarm, chat: string, text: string, extra: Partial<Extract<Command, { type: 'message.send' }>> = {}, user = peer, as?: string) =>
  f.execute({ type: 'message.send', conversationId: chat, text, replyTo: null, recipientIds: [], ...extra }, user, as)
/** peer's New session in [projectId] from their own top-level message in the chat; the session's thread and agent. */
async function projectSession(f: Swarm, chat: string, projectId: string | undefined, text = 'Work on this project') {
  const sent = await send(f, chat, text, { newSession: true, ...(projectId ? { sessionProjectId: projectId } : {}) })
  const thread = String(sent.result.messageId)
  return { thread, agentId: await f.launch(String(sent.result.startId)) }
}
const texts = async (f: Swarm, chat: string, user: AuthUser, as?: string, cursor: Record<string, unknown> = {}) =>
  (await f.store.messages(user, f.tab, chat, cursor, as)).messages.map(m => m.text)

describe('one Buddy chat per person per Swarm', () => {
  it('opens one chat at Swarm level, the same from every project, read by its person alone', async () => {
    const f = await swarm()
    const first = String((await f.execute({ type: 'buddy.chat' }, peer)).result.conversationId)
    expect(String((await f.execute({ type: 'buddy.chat' }, peer)).result.conversationId)).toBe(first)
    const chat = (await f.store.read(peer, f.tab)).state.conversations.find(c => c.id === first)!
    expect(chat).toMatchObject({ kind: 'swarm-buddy' })
    expect(chat.projectId).toBeUndefined()
    await send(f, first, 'A private idea')
    for (const user of [owner, other]) {
      await expect(f.store.messages(user, f.tab, first, {})).rejects.toThrow(UNAVAILABLE)
      expect((await f.store.read(user, f.tab)).state.conversations.map(c => c.id)).not.toContain(first)
    }
    await expect(f.store.messages(owner, f.tab, first, {}, f.pms.lead)).rejects.toThrow(UNAVAILABLE)
  })

  it('runs one Buddy per person per Swarm: a second one is refused, whichever project it names', async () => {
    const f = await swarm()
    const { chat, main } = await buddy(f)
    await expect(f.execute({ type: 'buddy.create', machineId: 'peer-mac', engine: 'claude' }, peer)).rejects.toMatchObject({ code: 'BUDDY_EXISTS' })
    // An older app's Start in a project names it: it is the same one Buddy.
    await expect(f.execute({ type: 'buddy.create', projectId: f.web.projectId, machineId: 'peer-mac', engine: 'claude' }, peer)).rejects.toMatchObject({ code: 'BUDDY_EXISTS' })
    const buddies = (await f.store.read(peer, f.tab)).state.agents.filter(a => a.buddyOf?.personId === peer.sub)
    expect(buddies.map(a => a.id)).toEqual([main])
    expect(buddies[0]!.projectId).toBeUndefined()
    expect((await f.store.read(peer, f.tab)).state.conversations.find(c => c.id === chat)!.agentIds).toEqual([main])
  })

  it('asks for a host that runs a Swarm Buddy', async () => {
    const f = await swarm({ capable: false })
    await expect(f.execute({ type: 'buddy.create', machineId: 'peer-mac', engine: 'claude' }, peer)).rejects.toMatchObject({ code: 'BUDDY_UPDATE_HOST' })
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
    const ask = String((await send(f, chat, 'Send it to the web PM')).result.messageId)
    const pmLine = String((await send(f, f.web.conversationId, 'From the web PM', {}, owner)).result.messageId)
    for (const target of ['lead', f.web.conversationId, f.secret.conversationId]) {
      await expect(send(f, target, 'A post', {}, peer, main)).rejects.toMatchObject({ code: 'BUDDY_FORBIDDEN' })
    }
    await expect(send(f, f.web.conversationId, 'A reply', { replyTo: pmLine }, peer, main)).rejects.toMatchObject({ code: 'BUDDY_FORBIDDEN' })
    await expect(f.execute({ type: 'message.react', conversationId: f.web.conversationId, messageId: pmLine, emoji: 'eyes', on: true }, peer, main))
      .rejects.toMatchObject({ code: 'BUDDY_FORBIDDEN' })
    await expect(f.execute({ type: 'buddy.propose', conversationId: chat, ownerMessageId: ask, goal: 'G', scope: 'S', priority: 'normal' }, peer, main))
      .rejects.toMatchObject({ code: 'BUDDY_PROPOSE_SESSION' })
    await expect(f.execute({ type: 'conversation.create', projectId: f.web.projectId, title: 'T', brief: '', checks: [] }, peer, main))
      .rejects.toMatchObject({ code: 'BUDDY_FORBIDDEN' })
    expect(await texts(f, f.web.conversationId, owner)).not.toContain('A post')
    // Its own chat it answers in.
    await send(f, chat, 'Here is the summary', {}, peer, main)
    expect(await texts(f, chat, peer)).toContain('Here is the summary')
  })
})

describe('a project session', () => {
  it('starts in its project\'s folder and reads that project alone', async () => {
    const f = await swarm()
    const { chat } = await buddy(f)
    await send(f, chat, 'MAIN CHAT SENTINEL: the secret plan')
    await send(f, f.secret.conversationId, 'SECRET PROJECT SENTINEL', {}, owner)
    const before = (await f.store.read(peer, f.tab)).state.starts!.length
    const { thread, agentId } = await projectSession(f, chat, f.web.projectId, 'Draft the web proposal')
    const state = (await f.store.read(peer, f.tab)).state
    const start = state.starts!.slice(before).find(s => s.request.buddySession?.thread === thread)!
    expect(start.request).toMatchObject({ cwd: `/swarm/${f.web.projectId}`, worktree: true, buddySession: { projectId: f.web.projectId } })
    expect(state.agents.find(a => a.id === agentId)).toMatchObject({ projectId: f.web.projectId, buddySession: { projectId: f.web.projectId } })
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
    const sent = await send(f, chat, 'Send this to the web PM', { replyTo: root, newSession: true, sessionProjectId: f.web.projectId })
    const agentId = await f.launch(String(sent.result.startId))
    const read = await f.store.messages(peer, f.tab, chat, { thread: root }, agentId)
    expect(JSON.stringify(read)).not.toContain('MAIN BUDDY SENTINEL')
    expect(read.messages.map(m => m.text)).toEqual(['Send this to the web PM'])
    // The root by its id reads exactly as a made-up id does.
    const invented = await f.store.messages(peer, f.tab, chat, { messageId: 'invented-message-id' }, agentId)
    expect(await f.store.messages(peer, f.tab, chat, { messageId: root }, agentId)).toEqual(invented)
  })

  it('writes into its own project only a proposal its person asked for in its thread', async () => {
    const f = await swarm()
    const { chat } = await buddy(f)
    const mainAsk = String((await send(f, chat, 'Send the plan to the web PM')).result.messageId)
    const { thread, agentId } = await projectSession(f, chat, f.web.projectId, 'Let us plan web offline sync')
    const ask = String((await send(f, chat, 'Send it to the PM', { replyTo: thread })).result.messageId)
    // Never directly into a project chat, its own included, nor into another project.
    for (const target of [f.web.conversationId, 'lead', f.secret.conversationId]) {
      await expect(send(f, target, 'A post', {}, peer, agentId)).rejects.toMatchObject({ code: 'BUDDY_FORBIDDEN' })
    }
    // Not for a message in the main chat.
    await expect(f.execute({ type: 'buddy.propose', conversationId: chat, ownerMessageId: mainAsk, goal: 'G', scope: 'S', priority: 'normal' }, peer, agentId))
      .rejects.toMatchObject({ code: 'PROPOSAL_UNASKED' })
    const sentId = String((await f.execute({ type: 'buddy.propose', conversationId: chat, ownerMessageId: ask, goal: 'Offline sync', scope: 'Web only',
      priority: 'normal' }, peer, agentId)).result.messageId)
    const row = await db.superTabMessage.findFirstOrThrow({ where: { tabId: f.tab, id: sentId } })
    expect(row).toMatchObject({ conversationId: f.web.conversationId, recipientIds: [f.pms.web], source: { kind: 'buddy-proposal', personId: peer.sub } })
  })

  it('a plain New session reads like the main Buddy and proposes nothing', async () => {
    const f = await swarm()
    const { chat } = await buddy(f)
    const { thread, agentId } = await projectSession(f, chat, undefined, 'Measure prod CPU')
    expect(await texts(f, f.web.conversationId, peer, agentId)).toBeDefined()
    const ask = String((await send(f, chat, 'Send it', { replyTo: thread })).result.messageId)
    await expect(f.execute({ type: 'buddy.propose', conversationId: chat, ownerMessageId: ask, goal: 'G', scope: 'S', priority: 'normal' }, peer, agentId))
      .rejects.toMatchObject({ code: 'BUDDY_PROPOSE_SESSION' })
  })

  it('cannot be started in a project its person does not read', async () => {
    const f = await swarm()
    const { chat } = await buddy(f)
    await f.execute({ type: 'project.sharing', projectId: f.secret.projectId, visibility: 'private', memberIds: [owner.sub] })
    await expect(send(f, chat, 'Work on secret', { newSession: true, sessionProjectId: f.secret.projectId })).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

describe('the PM\'s lines and losing a project', () => {
  it('puts a PM\'s private line in the one chat, marked with its project, and in the old chat for older apps', async () => {
    const f = await swarm()
    const { chat } = await buddy(f)
    await f.execute({ type: 'person.tell', personId: peer.sub, text: 'WEB PM LINE' }, owner, f.pms.web)
    const rows = await db.superTabMessage.findMany({ where: { tabId: f.tab, text: 'WEB PM LINE' } })
    const old = String((await f.execute({ type: 'buddy.chat', projectId: f.web.projectId }, peer)).result.conversationId)
    expect(rows.map(r => r.conversationId).sort()).toEqual([chat, old].sort())
    expect(rows.find(r => r.conversationId === chat)!.source).toMatchObject({ projectId: f.web.projectId })
  })

  it('takes a lost project out of the Buddy: its sessions end, its lines hide, and the main Buddy reads it no more', async () => {
    const f = await swarm()
    const { chat, main } = await buddy(f)
    const { thread, agentId } = await projectSession(f, chat, f.secret.projectId, 'SECRET SESSION SENTINEL')
    await f.execute({ type: 'person.tell', personId: peer.sub, text: 'SECRET PM LINE' }, owner, f.pms.secret)
    expect(await texts(f, chat, peer)).toContain('SECRET PM LINE')
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

describe('older apps', () => {
  it('keeps an old project chat readable, and a message there reaches a session of that project', async () => {
    const f = await swarm()
    const old = String((await f.execute({ type: 'buddy.chat', projectId: f.web.projectId }, peer)).result.conversationId)
    await send(f, old, 'OLD HISTORY')
    const { main } = await buddy(f)
    expect(await texts(f, old, peer)).toContain('OLD HISTORY')
    const before = (await f.store.read(peer, f.tab)).state.starts!.length
    const sent = await send(f, old, 'Hello from the phone')
    const start = (await f.store.read(peer, f.tab)).state.starts!.slice(before).find(s => s.id === String(sent.result.startId))!
    expect(start.request).toMatchObject({ conversationId: old, cwd: `/swarm/${f.web.projectId}`, worktree: true, buddyNarrow: true })
    const agentId = await f.launch(start.id)
    expect(agentId).not.toBe(main)
    const queued = await f.store.deliveries(peer, f.tab, agentId)
    expect(queued.map(d => d.messageId)).toContain(String(sent.result.messageId))
    await expect(f.store.messages(peer, f.tab, 'lead', {}, agentId)).rejects.toThrow(UNAVAILABLE)
  })
})
