import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Readable } from 'node:stream'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MongoMemoryReplSet } from 'mongodb-memory-server-core'
import { PrismaClient } from '@prisma/client'
import type { AuthUser } from '../src/lib/ssoAuth.js'
import { SuperTabStore } from '../src/superTabs/store.js'
import { MemoryAttachmentStore } from '../src/superTabs/attachments.js'
import type { Command } from '../src/superTabs/commands.js'
import { poolRows } from './hostRows.test-support.js'
import { beforeFirstWrite } from './interleave.test-support.js'
import { readInbox } from '../src/superTabs/read/inbox.js'
import { SwarmReads } from '../src/superTabs/read/service.js'

// One Buddy per person per Swarm (docs/specs/2026-10-31-one-buddy-per-swarm.md; Dee, 10-31): one chat at Swarm level, a main
// Buddy that reads every project its person reads and writes nowhere but that chat, and project sessions, the only Buddies that
// write into a project. A fresh loopback replica set, created here.
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
 * owner's Mac; peer a member with their own Mac, whose host says it runs a Swarm Buddy and its sessions (or not: `capable`).
 */
async function swarm({ capable = true, maxAgents = 8 } = {}) {
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
  await execute({ type: 'machine.contribute', machineId: 'peer-mac', name: 'Peer Mac', cwd: '/swarm', scope: 'swarm', engines: ['claude'], maxAgents }, peer)
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
  return { store, tab, execute, host, launch, report, clock, pms, web, secret, generation, running }
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

describe('the one Buddy sends a proposal to a project its person reads (Scholes, 11-02)', () => {
  const propose = (f: Swarm, chat: string, ownerMessageId: string, projectId: string | undefined, as: string, extra: Record<string, unknown> = {}, user = peer) =>
    f.execute({ type: 'buddy.propose', conversationId: chat, ownerMessageId, text: 'Send it to the web PM', ...(projectId ? { projectId } : {}), goal: 'Offline sync', scope: 'Web only', priority: 'normal', ...extra } as Command, user, as)
  const ask = async (f: Swarm, chat: string, text = 'Send it to the web PM') => String((await send(f, chat, text)).result.messageId)
  const upload = async (f: Swarm, chat: string, name: string, as?: string) =>
    (await f.store.upload(peer, f.tab, chat, { name, mime: 'text/plain', body: Readable.from([Buffer.from(name)]) }, as)).attachment.id

  it('reaches the named project\'s PM alone, with its person as requester and its one Buddy credited', async () => {
    const f = await swarm()
    const { chat, main } = await buddy(f)
    const sent = String((await propose(f, chat, await ask(f, chat), f.web.projectId, main)).result.messageId)
    const row = await db.superTabMessage.findFirstOrThrow({ where: { tabId: f.tab, id: sent } })
    // Its person's own words, the one row the PM is woken for, with the goal and scope kept for the PM (task #2926).
    expect(row).toMatchObject({ conversationId: f.web.conversationId, recipientIds: [f.pms.web], author: { kind: 'person', id: peer.sub }, text: 'Send it to the web PM',
      source: { kind: 'buddy-proposal', personId: peer.sub, goal: 'Offline sync', scope: 'Web only', priority: 'normal' } })
    expect(await db.superTabMessage.count({ where: { tabId: f.tab, replyTo: sent } })).toBe(0)
    expect(await db.superTabDelivery.count({ where: { tabId: f.tab, messageId: sent, agentId: f.pms.web } })).toBe(1)
    for (const elsewhere of ['lead', f.secret.conversationId]) expect(await texts(f, elsewhere, owner)).not.toContain(row.text)
    const group = String((await f.execute({ type: 'conversation.create', title: 'Offline sync', brief: '', checks: [], proposalMessageId: sent }, owner, f.pms.web)).result.conversationId)
    expect((await f.store.read(owner, f.tab)).state.conversations.find(c => c.id === group)).toMatchObject({ requesterId: peer.sub,
      brief: 'Goal: Offline sync\nScope: Web only\nPriority: normal' })
    expect((await db.swarmGroup.findFirstOrThrow({ where: { tabId: f.tab, key: group } })).data).toMatchObject({ ledger: { proposal: { buddyId: main } } })
  })

  // anh Dee, task #2926: the line its Buddy showed them, okayed in their next message, goes out in full as theirs; nothing else.
  it('posts the line its Buddy showed its person just before their ok, and nothing they never saw', async () => {
    const f = await swarm()
    const { chat, main } = await buddy(f)
    const line = 'Web keeps edits made offline and syncs them when the connection comes back, with no lost drafts after a reload'
    await send(f, chat, 'An idea I had earlier', {})
    await send(f, chat, 'I\'ll post this as you: “Also ship the phone app”', {}, peer, main)
    await send(f, chat, 'Not that, offline edits', {})
    await send(f, chat, `I'll post this as you: “${line}” OK?`, {}, peer, main)
    const ok = await ask(f, chat, 'ok')
    // A line from before its person's previous message is not the one they okayed.
    await expect(propose(f, chat, ok, f.web.projectId, main, { text: 'Also ship the phone app' })).rejects.toMatchObject({ code: 'PROPOSAL_UNSHOWN' })
    await expect(propose(f, chat, ok, f.web.projectId, main, { text: 'An idea I had earlier' })).rejects.toMatchObject({ code: 'PROPOSAL_UNSHOWN' })
    expect(await texts(f, f.web.conversationId, owner)).not.toContain('Also ship the phone app')
    const sent = String((await propose(f, chat, ok, f.web.projectId, main, { text: line })).result.messageId)
    expect(await db.superTabMessage.findFirstOrThrow({ where: { tabId: f.tab, id: sent } })).toMatchObject({ text: line, author: { kind: 'person', id: peer.sub } })
    // The Buddy wrote its goal and scope and picked its words: the PM, on another account, gets it marked as that account's
    // (security review 2 of #3024), as the Buddy's details reply was (audit M3).
    const delivery = await db.superTabDelivery.findFirstOrThrow({ where: { tabId: f.tab, messageId: sent, agentId: f.pms.web } })
    expect(await f.store.delivery(owner, f.tab, f.pms.web, delivery.id, { type: 'claim', claimId: randomUUID() })).toMatchObject({ otherAccount: true })
  })

  it('refuses private text after an unquoted offer, then posts only the quoted line after a fresh ok', async () => {
    const f = await swarm()
    const { chat, main } = await buddy(f)
    const line = 'Keep drafts offline'
    const privateText = 'This sentence is only for you. My plans must stay private.'
    await send(f, chat, `I'll post this as you: ${line}\n\n${privateText}`, {}, peer, main)
    const firstOk = await ask(f, chat, 'ok')
    for (const text of [line, `${line}\n\n${privateText}`]) {
      await expect(propose(f, chat, firstOk, f.web.projectId, main, { text })).rejects.toMatchObject({ code: 'PROPOSAL_UNSHOWN' })
    }
    expect(await texts(f, f.web.conversationId, owner)).not.toContain(privateText)
    await send(f, chat, `I'll post this as you: "${line}"\n\n${privateText}`, {}, peer, main)
    const ok = await ask(f, chat, 'ok')
    await expect(propose(f, chat, ok, f.web.projectId, main, { text: `${line}\n\n${privateText}` })).rejects.toMatchObject({ code: 'PROPOSAL_UNSHOWN' })
    const sent = String((await propose(f, chat, ok, f.web.projectId, main, { text: line })).result.messageId)
    expect(await db.superTabMessage.findUniqueOrThrow({ where: { id: sent } })).toMatchObject({ text: line, author: { kind: 'person', id: peer.sub } })
    expect(JSON.stringify(await texts(f, f.web.conversationId, owner))).not.toContain(privateText)
  })

  it('tells its person in their chat, in the Swarm\'s own words, waking nobody; a refused send says nothing', async () => {
    const f = await swarm()
    const { chat, main } = await buddy(f)
    const line = 'Your Buddy sent this to the Web PM for you.\n\nGoal: Offline sync\nScope: Web only'
    await expect(propose(f, chat, await ask(f, chat), 'made-up-project', main)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(await texts(f, chat, peer)).not.toContain(line)
    const sent = String((await propose(f, chat, await ask(f, chat), f.web.projectId, main)).result.messageId)
    expect(await texts(f, chat, peer)).toContain(line)
    const row = await db.superTabMessage.findFirstOrThrow({ where: { tabId: f.tab, conversationId: chat, text: line } })
    expect(row).toMatchObject({ recipientIds: [], source: { kind: 'buddy-proposal-sent', projectId: f.web.projectId } })
    expect(row.id).not.toBe(sent)
    expect(await db.superTabDelivery.count({ where: { tabId: f.tab, messageId: row.id } })).toBe(0)
    // It is not its person's word: a Swarm line never asks for the next proposal.
    await expect(propose(f, chat, row.id, f.web.projectId, main)).rejects.toMatchObject({ code: 'PROPOSAL_UNASKED' })
    // Only its person reads it.
    await expect(f.store.messages(owner, f.tab, chat, {})).rejects.toThrow(UNAVAILABLE)
    expect((await texts(f, f.web.conversationId, owner)).join()).not.toContain(line)
  })

  it('reaches a project chat gone quiet', async () => {
    const f = await swarm()
    const { chat, main } = await buddy(f)
    await db.swarmGroup.updateMany({ where: { tabId: f.tab, key: f.web.conversationId }, data: { dormant: true } })
    const sent = String((await propose(f, chat, await ask(f, chat), f.web.projectId, main)).result.messageId)
    expect(await db.superTabMessage.findFirstOrThrow({ where: { tabId: f.tab, id: sent } })).toMatchObject({ conversationId: f.web.conversationId })
  })

  it('is refused a project its person cannot read, in the words a made-up id gets, and sends nothing', async () => {
    const f = await swarm()
    const { chat, main } = await buddy(f)
    const before = await texts(f, f.secret.conversationId, owner)
    const unknown = await propose(f, chat, await ask(f, chat), 'made-up-project', main).catch(e => e as { code: string; message: string })
    expect(unknown).toMatchObject({ code: 'NOT_FOUND' })
    // Its person loses the project while its Buddy is running: the very next proposal is refused the same way.
    await f.execute({ type: 'project.sharing', projectId: f.secret.projectId, visibility: 'private', memberIds: [owner.sub] })
    const refused = await propose(f, chat, await ask(f, chat), f.secret.projectId, main).catch(e => e as { code: string; message: string })
    expect(refused).toMatchObject({ code: unknown.code, message: (unknown as { message: string }).message })
    expect(await texts(f, f.secret.conversationId, owner)).toEqual(before)
    // That ask was not spent: the same message may still go to a project they read.
    const stillAsk = await ask(f, chat)
    await expect(propose(f, chat, stillAsk, f.web.projectId, main)).resolves.toBeDefined()
  })

  it('refuses a project session that names another project, and another person\'s Buddy or chat', async () => {
    const f = await swarm()
    const { chat, main } = await buddy(f)
    const { thread, agentId } = await projectSession(f, chat, f.web.projectId)
    const inThread = String((await send(f, chat, 'Send it', { replyTo: thread })).result.messageId)
    await expect(propose(f, chat, inThread, f.secret.projectId, agentId)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(propose(f, chat, inThread, f.web.projectId, agentId, { text: 'Send it' })).resolves.toBeDefined()
    // The owner's own chat, named by peer's Buddy; and peer's Buddy for a message the owner wrote.
    const theirs = String((await f.execute({ type: 'buddy.chat' }, owner)).result.conversationId)
    const theirAsk = String((await send(f, theirs, 'Send it', {}, owner)).result.messageId)
    await expect(propose(f, theirs, theirAsk, f.web.projectId, main)).rejects.toMatchObject({ code: 'BUDDY_FORBIDDEN' })
    await expect(propose(f, chat, theirAsk, f.web.projectId, main)).rejects.toMatchObject({ code: 'PROPOSAL_UNASKED' })
    // A PM is no Buddy, and a person sends no proposal themselves.
    await expect(propose(f, chat, await ask(f, chat), f.web.projectId, f.pms.web, {}, owner)).rejects.toBeDefined()
    await expect(f.execute({ type: 'buddy.propose', conversationId: chat, ownerMessageId: await ask(f, chat), text: 'Send it', projectId: f.web.projectId, goal: 'G', scope: 'S', priority: 'normal' }, peer))
      .rejects.toMatchObject({ code: 'BUDDY_ONLY' })
  })

  it('sends one proposal for one message, whichever project it names: never to two', async () => {
    const f = await swarm()
    const { chat, main } = await buddy(f)
    const message = await ask(f, chat)
    await propose(f, chat, message, f.web.projectId, main)
    const before = await texts(f, f.secret.conversationId, owner)
    await expect(propose(f, chat, message, f.secret.projectId, main)).rejects.toMatchObject({ code: 'PROPOSAL_SENT' })
    expect(await texts(f, f.secret.conversationId, owner)).toEqual(before)
  })

  it('never answers an old ask, or a message that went to a session of another project', async () => {
    const f = await swarm()
    const { chat, main } = await buddy(f)
    const old = await ask(f, chat, 'An old idea')
    const { thread } = await projectSession(f, chat, f.secret.projectId, 'Secret plan')
    const inSession = String((await send(f, chat, 'Send it', { replyTo: thread })).result.messageId)
    for (const message of [thread, inSession]) await expect(propose(f, chat, message, f.web.projectId, main)).rejects.toMatchObject({ code: 'PROPOSAL_UNASKED' })
    await ask(f, chat, 'A newer message')
    f.clock.now += 61 * 60_000
    await expect(propose(f, chat, old, f.web.projectId, main)).rejects.toMatchObject({ code: 'PROPOSAL_STALE' })
  })

  it('carries its own upload and a file its person sent in the main chat, never one sent in a session\'s thread', async () => {
    const f = await swarm()
    const { chat, main } = await buddy(f)
    const plan = await upload(f, chat, 'plan.md', main)
    const log = await upload(f, chat, 'main.log')
    await send(f, chat, 'Here is the log', { attachmentIds: [log] })
    const { thread } = await projectSession(f, chat, f.secret.projectId, 'Secret plan')
    const secretFile = await upload(f, chat, 'secret.log')
    await send(f, chat, 'A secret file', { replyTo: thread, attachmentIds: [secretFile] })
    await expect(propose(f, chat, await ask(f, chat), f.web.projectId, main, { attachmentIds: [secretFile] })).rejects.toMatchObject({ code: 'ATTACHMENT_UNAVAILABLE' })
    const sent = String((await propose(f, chat, await ask(f, chat), f.web.projectId, main, { attachmentIds: [plan, log] })).result.messageId)
    // The files go with the proposal, its person's message in the project chat (task #2926).
    const read = (await f.store.messages(owner, f.tab, f.web.conversationId, {})).messages.find(m => m.id === sent)
    expect(read?.attachments?.map(a => a.name).sort()).toEqual(['main.log', 'plan.md'])
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
    // A proposal names its project: without one it goes nowhere.
    await expect(f.execute({ type: 'buddy.propose', conversationId: chat, ownerMessageId: ask, text: 'Send it', goal: 'G', scope: 'S', priority: 'normal' }, peer, main))
      .rejects.toMatchObject({ code: 'BUDDY_PROPOSE_PROJECT' })
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

  it('reopens with its history and its project, as a thread\'s reply box sends it, naming none; of another project it reads none of it', async () => {
    const f = await swarm()
    const { chat } = await buddy(f)
    const { thread, agentId } = await projectSession(f, chat, f.web.projectId, 'Plan web sync')
    await send(f, chat, 'EARLIER ANSWER: use a queue', { replyTo: thread }, peer, agentId)
    await f.execute({ type: 'buddy.sessionEnd', conversationId: chat, thread, reason: 'idle' }, peer)
    const reopen = async (text: string, projectId?: string) =>
      f.launch(String((await send(f, chat, text, { replyTo: thread, newSession: true, ...(projectId ? { sessionProjectId: projectId } : {}) })).result.startId))
    const again = await reopen('Carry on')
    expect((await f.store.read(peer, f.tab)).state.agents.find(a => a.id === again)).toMatchObject({ projectId: f.web.projectId, buddySession: { projectId: f.web.projectId } })
    expect(await texts(f, chat, peer, again, { thread })).toEqual(['Plan web sync', 'EARLIER ANSWER: use a queue', 'Session ended: idle for 30 minutes.', 'Carry on'])
    await send(f, chat, 'SECOND ANSWER', { replyTo: thread }, peer, again)
    await f.execute({ type: 'buddy.sessionEnd', conversationId: chat, thread, reason: 'ended' }, peer)
    // Another project's session in that thread reads its person's words alone, and the next keeps that project.
    const other = await reopen('Now the secret project', f.secret.projectId)
    const read = JSON.stringify(await f.store.messages(peer, f.tab, chat, { thread }, other))
    expect(read).not.toContain('EARLIER ANSWER')
    expect(read).not.toContain('SECOND ANSWER')
    expect(read).toContain('Plan web sync')
    await f.execute({ type: 'buddy.sessionEnd', conversationId: chat, thread, reason: 'ended' }, peer)
    const third = await reopen('Back again')
    expect((await f.store.read(peer, f.tab)).state.agents.find(a => a.id === third)).toMatchObject({ projectId: f.secret.projectId })
  })

  it('reopens a plain session plain, and refuses to reopen in a project its person lost, as it refuses a made-up one', async () => {
    const f = await swarm()
    const { chat } = await buddy(f)
    const plain = await projectSession(f, chat, undefined, 'Measure prod CPU')
    await f.execute({ type: 'buddy.sessionEnd', conversationId: chat, thread: plain.thread, reason: 'ended' }, peer)
    const started = await send(f, chat, 'Carry on', { replyTo: plain.thread, newSession: true })
    const again = await f.launch(String(started.result.startId))
    expect((await f.store.read(peer, f.tab)).state.agents.find(a => a.id === again)!.buddySession!.projectId).toBeUndefined()

    const lost = await projectSession(f, chat, f.secret.projectId, 'SECRET SESSION SENTINEL')
    await f.execute({ type: 'buddy.sessionEnd', conversationId: chat, thread: lost.thread, reason: 'ended' }, peer)
    const madeUp = await send(f, chat, 'x', { replyTo: lost.thread, newSession: true, sessionProjectId: 'invented-project' }).catch((e: { code?: string }) => e.code)
    await f.execute({ type: 'project.sharing', projectId: f.secret.projectId, visibility: 'private', memberIds: [owner.sub] })
    const before = (await f.store.read(peer, f.tab)).state.agents.length
    const refused = await send(f, chat, 'y', { replyTo: lost.thread, newSession: true }).catch((e: { code?: string; message?: string }) => e)
    expect((refused as { code?: string }).code).toBe(madeUp)
    expect(JSON.stringify((refused as { message?: string }).message)).not.toContain('Secret')
    expect((await f.store.read(peer, f.tab)).state.agents.length).toBe(before)
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
    await expect(f.execute({ type: 'buddy.propose', conversationId: chat, ownerMessageId: mainAsk, text: 'Send it', goal: 'G', scope: 'S', priority: 'normal' }, peer, agentId))
      .rejects.toMatchObject({ code: 'PROPOSAL_UNASKED' })
    const sentId = String((await f.execute({ type: 'buddy.propose', conversationId: chat, ownerMessageId: ask, text: 'Send it to the PM', goal: 'Offline sync', scope: 'Web only',
      priority: 'normal' }, peer, agentId)).result.messageId)
    const row = await db.superTabMessage.findFirstOrThrow({ where: { tabId: f.tab, id: sentId } })
    expect(row).toMatchObject({ conversationId: f.web.conversationId, recipientIds: [f.pms.web], source: { kind: 'buddy-proposal', personId: peer.sub } })
    expect(await db.superTabMessage.count({ where: { tabId: f.tab, replyTo: sentId } })).toBe(0)
  })

  /** peer's session proposes in web, the PM opens the group from it and the group's PR merges; the session then ends. */
  async function shippedFromSession(f: Swarm, { endBeforeOpen = false } = {}) {
    const { chat, main } = await buddy(f)
    const { thread, agentId } = await projectSession(f, chat, f.web.projectId, 'Let us plan web offline sync')
    const ask = String((await send(f, chat, 'Send it to the PM', { replyTo: thread })).result.messageId)
    const proposal = String((await f.execute({ type: 'buddy.propose', conversationId: chat, ownerMessageId: ask, text: 'Send it to the PM', goal: 'Offline sync', scope: 'Web only',
      priority: 'normal' }, peer, agentId)).result.messageId)
    // Sessions end by themselves after 30 idle minutes, so the PM often opens the group after the session is gone.
    if (endBeforeOpen) await f.execute({ type: 'buddy.sessionEnd', conversationId: chat, thread, reason: 'ended' }, peer)
    const group = String((await f.execute({ type: 'conversation.create', projectId: f.web.projectId, title: 'Offline sync', brief: 'Web keeps edits offline.',
      checks: [], proposalMessageId: proposal }, owner, f.pms.web)).result.conversationId)
    await f.execute({ type: 'conversation.merged', conversationId: group, pullRequestUrl: 'https://github.com/example/app/pull/7' })
    if (!endBeforeOpen) await f.execute({ type: 'buddy.sessionEnd', conversationId: chat, thread, reason: 'ended' }, peer)
    return { chat, main, agentId, group }
  }
  const buddyRows = async (f: Swarm, user: AuthUser, projectId: string) =>
    (await new SwarmReads(f.store).leaderboard(user, f.tab, projectId)).agents.filter(a => a.kind === 'buddy')

  it('credits a shipped proposal to the person\'s one Buddy, so its row keeps its name and person after the session ends (Diego, 11-02)', async () => {
    const f = await swarm()
    const { main, agentId, group } = await shippedFromSession(f)
    // The session is gone; the credit was recorded under the one Buddy, not the session.
    expect((await f.store.read(peer, f.tab)).state.agents.map(a => a.id)).not.toContain(agentId)
    expect((await f.store.read(owner, f.tab)).state.conversations.find(c => c.id === group)!.ledger!.proposal!.buddyId).toBe(main)
    const name = (await f.store.read(peer, f.tab)).state.agents.find(a => a.id === main)!.displayName
    const rows = await buddyRows(f, peer, f.web.projectId)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ agentId: main, displayName: name, personId: peer.sub, shipped: 1, points: 3 })
    expect(rows[0]!.displayName).not.toBe('Former Buddy')
    // The same row to another reader of the project, and in a project it shipped nothing in: listed, with 0 shipped.
    expect((await buddyRows(f, owner, f.web.projectId)).map(r => [r.agentId, r.displayName, r.personId, r.shipped])).toEqual([[main, name, peer.sub, 1]])
    expect((await buddyRows(f, peer, 'lead')).map(r => [r.agentId, r.displayName, r.personId, r.shipped])).toEqual([[main, name, peer.sub, 0]])
  })

  it('credits the one Buddy when the session ended before the PM opened the group from its proposal (reviewer of #2507)', async () => {
    const f = await swarm()
    const { main, agentId, group } = await shippedFromSession(f, { endBeforeOpen: true })
    expect((await f.store.read(peer, f.tab)).state.agents.map(a => a.id)).not.toContain(agentId)
    expect((await f.store.read(owner, f.tab)).state.conversations.find(c => c.id === group)!.ledger!.proposal!.buddyId).toBe(main)
    const name = (await f.store.read(peer, f.tab)).state.agents.find(a => a.id === main)!.displayName
    expect((await buddyRows(f, peer, f.web.projectId)).map(r => [r.agentId, r.displayName, r.personId, r.shipped])).toEqual([[main, name, peer.sub, 1]])
  })

  it('names nobody when the session ended and its person lost the project before the PM opened the group', async () => {
    const f = await swarm()
    const { chat, main } = await buddy(f)
    const { thread, agentId } = await projectSession(f, chat, f.web.projectId, 'Plan it')
    const ask = String((await send(f, chat, 'Send it', { replyTo: thread })).result.messageId)
    const proposal = String((await f.execute({ type: 'buddy.propose', conversationId: chat, ownerMessageId: ask, text: 'Send it', goal: 'G', scope: 'S', priority: 'normal' },
      peer, agentId)).result.messageId)
    await f.execute({ type: 'buddy.sessionEnd', conversationId: chat, thread, reason: 'ended' }, peer)
    await f.execute({ type: 'project.sharing', projectId: f.web.projectId, visibility: 'private', memberIds: [owner.sub] })
    const group = String((await f.execute({ type: 'conversation.create', projectId: f.web.projectId, title: 'T', brief: '', checks: [], proposalMessageId: proposal },
      owner, f.pms.web)).result.conversationId)
    await f.execute({ type: 'conversation.merged', conversationId: group, pullRequestUrl: 'https://github.com/example/app/pull/8' })
    const board = await new SwarmReads(f.store).leaderboard(owner, f.tab, f.web.projectId)
    expect(board.agents.filter(a => a.kind === 'buddy').map(a => [a.agentId, a.displayName, a.personId, a.machineId])).toEqual([[main, 'Former Buddy', null, '']])
    expect(JSON.stringify(board)).not.toMatch(/Peer Mac|peer-mac/)
  })

  it('never names the one Buddy, its person or its Mac on a board of a project its person no longer reads', async () => {
    const f = await swarm()
    const { main } = await shippedFromSession(f)
    await f.execute({ type: 'project.sharing', projectId: f.web.projectId, visibility: 'private', memberIds: [owner.sub] })
    const board = await new SwarmReads(f.store).leaderboard(owner, f.tab, f.web.projectId)
    expect(board.agents.filter(a => a.kind === 'buddy').map(a => [a.agentId, a.displayName, a.personId, a.machineId, a.shipped])).toEqual([[main, 'Former Buddy', null, '', 1]])
    expect(JSON.stringify(board)).not.toMatch(/peer-mac|Peer Mac/)
    // The person lost the project: the board is closed to them like a made-up project.
    await expect(new SwarmReads(f.store).leaderboard(peer, f.tab, f.web.projectId)).rejects.toThrow()
    // And a private project the person reads lists their Buddy there, which a person who is not in it never sees.
    expect((await buddyRows(f, peer, f.secret.projectId)).map(r => r.agentId)).toEqual([main])
    await expect(new SwarmReads(f.store).leaderboard(other, f.tab, f.secret.projectId)).rejects.toThrow()
  })

  it('keeps a session\'s proposal credited to the one Buddy while the session still runs, with no row of its own', async () => {
    const f = await swarm()
    const { chat, main } = await buddy(f)
    const { thread, agentId } = await projectSession(f, chat, f.web.projectId, 'Plan it')
    const ask = String((await send(f, chat, 'Send it', { replyTo: thread })).result.messageId)
    const proposal = String((await f.execute({ type: 'buddy.propose', conversationId: chat, ownerMessageId: ask, text: 'Send it', goal: 'G', scope: 'S', priority: 'normal' },
      peer, agentId)).result.messageId)
    await f.execute({ type: 'conversation.create', projectId: f.web.projectId, title: 'T', brief: '', checks: [], proposalMessageId: proposal }, owner, f.pms.web)
    expect((await buddyRows(f, peer, f.web.projectId)).map(r => r.agentId)).toEqual([main])
  })

  it('a plain New session reads like the main Buddy and proposes as it does, for its person\'s message in its thread', async () => {
    const f = await swarm()
    const { chat, main } = await buddy(f)
    const { thread, agentId } = await projectSession(f, chat, undefined, 'Measure prod CPU')
    expect(await texts(f, f.web.conversationId, peer, agentId)).toBeDefined()
    const ask = String((await send(f, chat, 'Send it', { replyTo: thread })).result.messageId)
    await expect(f.execute({ type: 'buddy.propose', conversationId: chat, ownerMessageId: ask, text: 'Send it', goal: 'G', scope: 'S', priority: 'normal' }, peer, agentId))
      .rejects.toMatchObject({ code: 'BUDDY_PROPOSE_PROJECT' })
    const mainAsk = String((await send(f, chat, 'Send it from the main chat')).result.messageId)
    await expect(f.execute({ type: 'buddy.propose', conversationId: chat, ownerMessageId: mainAsk, text: 'Send it', projectId: f.web.projectId, goal: 'G', scope: 'S', priority: 'normal' }, peer, agentId))
      .rejects.toMatchObject({ code: 'PROPOSAL_UNASKED' })
    const sent = String((await f.execute({ type: 'buddy.propose', conversationId: chat, ownerMessageId: ask, text: 'Send it', projectId: f.web.projectId, goal: 'G', scope: 'S', priority: 'normal' }, peer, agentId)).result.messageId)
    expect(await db.superTabMessage.findFirstOrThrow({ where: { tabId: f.tab, id: sent } })).toMatchObject({ conversationId: f.web.conversationId, recipientIds: [f.pms.web] })
    // Credited to the person's one Buddy, as a project session's is: a session ends.
    const group = String((await f.execute({ type: 'conversation.create', title: 'From the session', brief: '', checks: [], proposalMessageId: sent }, owner, f.pms.web)).result.conversationId)
    const row = (await f.store.read(owner, f.tab)).state.conversations.find(c => c.id === group)
    expect(row?.requesterId).toBe(peer.sub)
    expect((await db.swarmGroup.findFirstOrThrow({ where: { tabId: f.tab, key: group } })).data).toMatchObject({ ledger: { proposal: { buddyId: main } } })
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

describe('the inbox (security review 1 of #2435)', () => {
  it('never previews a lost project\'s line in the one Buddy chat, nor its session threads', async () => {
    const f = await swarm()
    const { chat } = await buddy(f)
    await send(f, chat, 'An earlier word of mine')
    await f.execute({ type: 'person.tell', personId: peer.sub, text: 'SECRET PM LINE' }, owner, f.pms.secret)
    const preview = async () => JSON.stringify((await readInbox(f.store, peer, f.tab)).latest.filter(l => l.conversationId === chat))
    expect(await preview()).toContain('SECRET PM LINE')
    await f.execute({ type: 'project.sharing', projectId: f.secret.projectId, visibility: 'private', memberIds: [owner.sub] })
    const after = await preview()
    expect(after).not.toContain('SECRET PM LINE')
    expect(after).toContain('An earlier word of mine')
  })
})

describe('a phone\'s message racing Remove Buddy (security review 2 of #2435)', () => {
  it('never leaves a Buddy starting in the old chat once its person removed their one Buddy', async () => {
    const f = await swarm()
    await buddy(f)
    const old = String((await f.execute({ type: 'buddy.chat', projectId: f.web.projectId }, peer)).result.conversationId)
    let raced = false
    const racing = new SuperTabStore(beforeFirstWrite(db, async () => {
      if (raced) return
      raced = true
      await f.execute({ type: 'buddy.remove' }, peer)
    }), () => f.clock.now, { store: new MemoryAttachmentStore(), prefix: 'super-tabs', publicBase: 'https://cdn.example.test' })
    await racing.execute(peer, f.tab, { operationId: randomUUID(), command: { type: 'message.send', conversationId: old, text: 'From the phone',
      replyTo: null, recipientIds: [] } })
    expect(raced).toBe(true)
    const state = (await f.store.read(peer, f.tab)).state
    expect(state.agents.filter(a => a.buddyOf?.personId === peer.sub)).toEqual([])
    expect((state.starts ?? []).filter(s => s.request.conversationId === old && !s.error && !s.harnessId)).toEqual([])
  })
})

describe('security reviews of #2435', () => {
  it('refuses a write into an older project chat from an app that knows one Buddy, and keeps an older app\'s', async () => {
    const f = await swarm()
    await buddy(f)
    const old = String((await f.execute({ type: 'buddy.chat', projectId: f.web.projectId }, peer)).result.conversationId)
    const line = String((await send(f, old, 'From the phone')).result.messageId)
    await expect(send(f, old, 'From new Desktop', { oneBuddy: true })).rejects.toMatchObject({ code: 'BUDDY_CHAT_EARLIER' })
    await expect(send(f, old, 'A thread reply', { replyTo: line, oneBuddy: true })).rejects.toMatchObject({ code: 'BUDDY_CHAT_EARLIER' })
    await expect(f.execute({ type: 'message.react', conversationId: old, messageId: line, emoji: 'eyes', on: true, oneBuddy: true }, peer))
      .rejects.toMatchObject({ code: 'BUDDY_CHAT_EARLIER' })
    await f.execute({ type: 'message.react', conversationId: old, messageId: line, emoji: 'eyes', on: true }, peer)
    expect(await texts(f, old, peer)).not.toContain('From new Desktop')
  })

  it('ends the one Buddy\'s session in an older project chat when its person loses the project', async () => {
    const f = await swarm()
    await buddy(f)
    const old = String((await f.execute({ type: 'buddy.chat', projectId: f.secret.projectId }, peer)).result.conversationId)
    const sent = await send(f, old, 'From the phone')
    const narrow = await f.launch(String(sent.result.startId))
    // Read as the owner, who still reads the project and so would see the agent if it were left: peer's own read hides it anyway.
    expect((await f.store.read(owner, f.tab)).state.agents.map(a => a.id)).toContain(narrow)
    await f.execute({ type: 'project.sharing', projectId: f.secret.projectId, visibility: 'private', memberIds: [owner.sub] })
    expect((await f.store.read(owner, f.tab)).state.agents.map(a => a.id)).not.toContain(narrow)
  })

  // Task #2356 (Diego): a New session there started wide, so it read its person's whole home, other projects' clones included.
  it('starts a New session in an older project chat narrow, as that chat\'s own Buddy is', async () => {
    const f = await swarm()
    await buddy(f)
    const old = String((await f.execute({ type: 'buddy.chat', projectId: f.web.projectId }, peer)).result.conversationId)
    await f.launch(String((await send(f, old, 'From the phone')).result.startId))
    const startId = String((await send(f, old, 'Work on this', { newSession: true })).result.startId)
    const state = (await f.store.read(peer, f.tab)).state
    expect(state.starts!.find(s => s.id === startId)!.request).toMatchObject({ worktree: true, buddyNarrow: true })
    const session = await f.launch(startId)
    expect((await f.store.read(peer, f.tab)).state.agents.find(a => a.id === session)).toMatchObject({ buddyNarrow: true, projectId: f.web.projectId })
  })

  it('ends a New session in an older project chat when its person loses the project', async () => {
    const f = await swarm()
    await buddy(f)
    const old = String((await f.execute({ type: 'buddy.chat', projectId: f.secret.projectId }, peer)).result.conversationId)
    await f.launch(String((await send(f, old, 'From the phone')).result.startId))
    const session = await f.launch(String((await send(f, old, 'Work on this', { newSession: true })).result.startId))
    const pending = String((await send(f, old, 'And this', { newSession: true })).result.startId)
    expect((await f.store.read(owner, f.tab)).state.agents.map(a => a.id)).toContain(session)
    await f.execute({ type: 'project.sharing', projectId: f.secret.projectId, visibility: 'private', memberIds: [owner.sub] })
    const state = (await f.store.read(owner, f.tab)).state
    expect(state.agents.map(a => a.id)).not.toContain(session)
    // Its host never launches the start still pending.
    await expect(f.launch(pending)).rejects.toBeDefined()
  })

  it('shows a project session none of its chat\'s sessions: other threads, other projects\' and starts still pending', async () => {
    const f = await swarm()
    const { chat } = await buddy(f)
    const { agentId } = await projectSession(f, chat, f.web.projectId, 'Web work')
    await send(f, chat, 'SECRET THREAD ROOT', { newSession: true, sessionProjectId: f.secret.projectId })
    const read = (await f.store.read(peer, f.tab, agentId)).state.conversations.find(c => c.id === chat)!
    expect(read.buddySessions).toBeUndefined()
    expect(JSON.stringify(read)).not.toContain(f.secret.projectId)
  })

  it('carries a project session\'s project on every row of its thread, so hiding has no limit', async () => {
    const f = await swarm()
    const { chat } = await buddy(f)
    const { thread, agentId } = await projectSession(f, chat, f.secret.projectId, 'Secret work')
    await send(f, chat, 'SESSION REPLY', { replyTo: thread }, peer, agentId)
    const rows = await db.superTabMessage.findMany({ where: { tabId: f.tab, conversationId: chat, thread } })
    expect(rows.length).toBeGreaterThanOrEqual(2)
    expect(rows.every(r => r.buddyProject === f.secret.projectId)).toBe(true)
  })
})

describe('security re-check 2 of #2435', () => {
  it('keeps a phone\'s message in an older Buddy chat and starts nothing when the machine is full, paused, or the Swarm is paused', async () => {
    // Security review 1 re-check of #2435: a machine that cannot take a one-project Buddy now refuses nothing the person wrote.
    const cases: Array<[string, (f: Swarm) => Promise<unknown>]> = [
      ['at its limit', async () => undefined],
      ['paused by its owner', f => f.execute({ type: 'machine.pause', machineId: 'peer-mac', paused: true }, peer)],
      ['in a paused Swarm', f => f.execute({ type: 'tab.pause', paused: true })],
    ]
    for (const [label, pause] of cases) {
      // At its limit: the one Buddy takes the machine's only slot.
      const f = await swarm({ maxAgents: label === 'at its limit' ? 1 : 8 })
      await buddy(f)
      const old = String((await f.execute({ type: 'buddy.chat', projectId: f.web.projectId }, peer)).result.conversationId)
      await pause(f)
      const sent = await send(f, old, `From the phone, ${label}`)
      expect(sent.result.startId, label).toBeUndefined()
      expect(((await f.store.read(peer, f.tab)).state.starts ?? []).filter(s => s.request.conversationId === old), label).toEqual([])
      expect(await texts(f, old, peer), label).toContain(`From the phone, ${label}`)
    }
  })

  it('reads the machine again for a phone\'s Buddy start: a host that stops offering it while it starts gets no start', async () => {
    // The machine's own report, from its host, changes while the phone's message starts its Buddy: it no longer says it runs
    // the one Buddy. Only the machine's part ties the two writes (touches.ts: every start a post makes reads its machine).
    const f = await swarm()
    await buddy(f)
    const old = String((await f.execute({ type: 'buddy.chat', projectId: f.web.projectId }, peer)).result.conversationId)
    let raced = false
    const racing = new SuperTabStore(beforeFirstWrite(db, async () => {
      if (raced) return
      raced = true
      await f.store.observeMachine(peer, f.tab, 'peer-mac', { generation: f.generation, resources: { cpuPercent: 10, memoryTotalBytes: 32e9, memoryUsedBytes: 4e9,
        diskFreeBytes: 120e9, diskTotalBytes: 500e9, projectDiskFreeBytes: 120e9, deviceType: 'Laptop', chip: 'Fixture', os: 'macOS', gpuPercent: null },
      quotas: [], tools: {}, runningHarnessIds: [...f.running], stoppedHarnessIds: [], capabilities: [] })
    }), () => f.clock.now, { store: new MemoryAttachmentStore(), prefix: 'super-tabs', publicBase: 'https://cdn.example.test' })
    const sent = await racing.execute(peer, f.tab, { operationId: randomUUID(), command: { type: 'message.send', conversationId: old, text: 'From the phone',
      replyTo: null, recipientIds: [] } })
    expect(raced).toBe(true)
    expect(sent.result.startId).toBeUndefined()
    expect(((await f.store.read(peer, f.tab)).state.starts ?? []).filter(s => s.request.conversationId === old)).toEqual([])
    // The phone's message is kept, though no Buddy could start for it.
    expect(await texts(f, old, peer)).toContain('From the phone')
  })

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

  it('counts nothing of a lost project in what the person missed in # buddy', async () => {
    const f = await swarm()
    const { chat } = await buddy(f)
    await send(f, chat, 'Mine')
    await f.execute({ type: 'person.tell', personId: peer.sub, text: 'SECRET PM LINE' }, owner, f.pms.secret)
    // The PM's line is the one row by someone else: it is what they missed.
    expect(await f.store.catchUp(peer, f.tab, chat, 0)).toMatchObject({ unread: 1 })
    await f.execute({ type: 'project.sharing', projectId: f.secret.projectId, visibility: 'private', memberIds: [owner.sub] })
    expect(await f.store.catchUp(peer, f.tab, chat, 0)).toMatchObject({ unread: 0 })
  })
})

// Review of #2447: a phone's message in an older Buddy chat that no Buddy can answer was kept, and its person heard nothing.
describe('a phone\'s message no Buddy can answer', () => {
  const line = (why: string) => `I can't start in this chat right now: ${why}. Your message is kept.`
  const rows = async (f: Swarm, chat: string) => (await f.store.messages(peer, f.tab, chat, {})).messages

  it('tells its person why, in plain words, once per outage and not once per message, from their Buddy, to them alone', async () => {
    const cases: Array<[string, string, (f: Swarm) => Promise<unknown>]> = [
      ['at its limit', 'Peer Mac already runs as many agents as it takes', async () => undefined],
      ['paused by its owner', 'Peer Mac is paused', f => f.execute({ type: 'machine.pause', machineId: 'peer-mac', paused: true }, peer)],
      ['in a paused Swarm', 'the Swarm is paused', f => f.execute({ type: 'tab.pause', paused: true })],
      ['offline', 'Peer Mac is offline', async f => { f.clock.now += 60 * 60_000 }],
    ]
    for (const [label, why, outage] of cases) {
      const f = await swarm({ maxAgents: label === 'at its limit' ? 1 : 8 })
      const { main } = await buddy(f)
      const old = String((await f.execute({ type: 'buddy.chat', projectId: f.web.projectId }, peer)).result.conversationId)
      await outage(f)
      for (const n of [1, 2, 3]) expect((await send(f, old, `From the phone ${n}`)).result.startId, label).toBeUndefined()
      const seen = await rows(f, old)
      expect(seen.map(m => m.text), label).toEqual(['From the phone 1', line(why), 'From the phone 2', 'From the phone 3'])
      expect(seen[1]!.author, label).toMatchObject({ kind: 'agent', id: main })
      // Their own chat: the Swarm's owner reads none of it.
      await expect(f.store.messages(owner, f.tab, old, {}), label).rejects.toThrow(UNAVAILABLE)
    }
  })

  it('tells again in the next outage, once a Buddy could start in between', async () => {
    const f = await swarm()
    await buddy(f)
    const old = String((await f.execute({ type: 'buddy.chat', projectId: f.web.projectId }, peer)).result.conversationId)
    const pause = (paused: boolean) => f.execute({ type: 'machine.pause', machineId: 'peer-mac', paused }, peer)
    await pause(true)
    await send(f, old, 'First outage')
    await pause(false)
    const started = String((await send(f, old, 'Back')).result.startId)
    expect(started).not.toBe('undefined')
    await f.host({ type: 'agent.startFailed', startId: started, error: 'The session could not open.' })
    await pause(true)
    await send(f, old, 'Second outage')
    await send(f, old, 'Still out')
    expect((await rows(f, old)).map(m => m.text)).toEqual(['First outage', line('Peer Mac is paused'), 'Back',
      expect.stringMatching(/^Could not start peer's Buddy/), 'Second outage', line('Peer Mac is paused'), 'Still out'])
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
