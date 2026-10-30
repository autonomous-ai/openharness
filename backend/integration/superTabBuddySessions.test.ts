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

// Buddy thread sessions end to end through the store (buddySessions.ts; spec docs/superpowers/specs/2026-10-30-buddy-thread-
// sessions-design.md): a person's thread gets its own Buddy session beside the main one, which hears and answers only its
// thread, reads the main chat only up to where it started, and ends on its person's word, its host's, or its Buddy's removal.
let replica: MongoMemoryReplSet
let db: PrismaClient
const owner: AuthUser = { sub: '310000000000000000000001', email: 'owner@example.com', autonomousEnv: 'prod', role: 'user' }
const peer: AuthUser = { sub: '310000000000000000000002', email: 'peer@example.com', autonomousEnv: 'prod', role: 'user' }
const config = { engine: 'claude', model: 'opus', effort: 'high', contextWindow: 200000, engineVersion: 'fixture' }

beforeAll(async () => {
  replica = await MongoMemoryReplSet.create({ binary: { version: '7.0.24', downloadDir: join(tmpdir(), 'harness-super-tab-mongodb-binaries') },
    replSet: { count: 1, ip: '127.0.0.1', storageEngine: 'wiredTiger' } })
  const uri = replica.getUri(`swarm_buddy_sessions_test_${randomUUID().replaceAll('-', '_')}`)
  await promisify(execFile)(join(process.cwd(), 'node_modules/.bin/prisma'), ['db', 'push', '--skip-generate'], {
    env: { ...process.env, DATABASE_URL: uri }, timeout: 60000,
  })
  db = new PrismaClient({ datasources: { db: { url: uri } } })
  for (const user of [owner, peer]) await db.user.create({ data: { id: user.sub, externalId: `fixture-${user.sub}`, email: user.email, autonomousEnv: user.autonomousEnv } })
  for (const [machineId, user] of [['owner-mac', owner], ['peer-mac', peer]] as const) {
    await db.machine.create({ data: { machineId, userId: user.sub, apiKey: `fixture-${machineId}`, managerId: 'fixture', autonomousEnv: 'prod', authMode: 'remote' } })
  }
})
afterAll(async () => {
  await db?.$disconnect()
  await replica?.stop()
})

/** A Swarm whose PM runs on the owner's Mac, peer a member whose Mac's host can run thread sessions (or not: `capable`). */
async function swarm({ capable = true, maxAgents = 6 } = {}) {
  const store = new SuperTabStore(db, () => Date.now(), { store: new MemoryAttachmentStore(), prefix: 'super-tabs', publicBase: 'https://cdn.example.test' })
  const tab = (await store.create(owner, randomUUID(), 'Sessions', 'public')).id
  const execute = (command: Command, user = owner, asAgentId?: string, hostMachineId?: string) =>
    store.execute(user, tab, { operationId: randomUUID(), command }, asAgentId, hostMachineId)
  const invitation = await execute({ type: 'invite.create', email: peer.email, role: 'collaborator', conversationId: 'lead' })
  await execute({ type: 'invite.accept', inviteId: invitation.result.inviteId as string }, peer)
  await execute({ type: 'agent.add', conversationId: 'lead', machineId: 'owner-mac', harnessId: randomUUID(), name: 'PM', configuration: config, lead: true })
  await execute({ type: 'machine.contribute', machineId: 'peer-mac', name: 'Peer Mac', cwd: '/swarm', scope: 'swarm', engines: ['claude'], maxAgents }, peer)
  const generation = (await poolRows(store, peer, 'peer-mac')).find(p => p.tabId === tab)!.machine.generation
  await store.observeMachine(peer, tab, 'peer-mac', { generation, resources: { cpuPercent: 10, memoryTotalBytes: 32e9, memoryUsedBytes: 4e9,
    diskFreeBytes: 120e9, diskTotalBytes: 500e9, projectDiskFreeBytes: 120e9, deviceType: 'Laptop', chip: 'Fixture', os: 'macOS', gpuPercent: null },
  quotas: [], tools: {}, runningHarnessIds: [], stoppedHarnessIds: [], ...(capable ? { capabilities: ['buddySessions'] } : {}) })
  const host = (command: Command) => execute(command, peer, undefined, 'peer-mac')
  /** peer's main Buddy, added and started by peer-mac's host. */
  const added = await execute({ type: 'buddy.create', projectId: 'lead', machineId: 'peer-mac', engine: 'claude' }, peer)
  const chat = String(added.result.conversationId)
  await host({ type: 'agent.startDispatch', startId: String(added.result.startId) })
  const main = String((await host({ type: 'agent.started', startId: String(added.result.startId), harnessId: randomUUID(), configuration: config })).result.agentId)
  await host({ type: 'agent.startSettled', startId: String(added.result.startId), warning: null })
  /** peer's message in the main chat. */
  const say = async (text: string) => String((await execute({ type: 'message.send', conversationId: chat, text, replyTo: null, recipientIds: [] }, peer)).result.messageId)
  /** peer's reply in [root]'s thread, starting its session when `newSession`. */
  const reply = (root: string, text: string, extra: Partial<Extract<Command, { type: 'message.send' }>> = {}) =>
    execute({ type: 'message.send', conversationId: chat, text, replyTo: root, recipientIds: [], ...extra }, peer)
  /** Starts [root]'s session and its host launches it, as a running host does. */
  const session = async (root: string, text = 'Measure prod CPU for the last day') => {
    const sent = await reply(root, text, { newSession: true })
    const startId = String(sent.result.startId)
    await host({ type: 'agent.startDispatch', startId })
    const agentId = String((await host({ type: 'agent.started', startId, harnessId: randomUUID(), configuration: config })).result.agentId)
    return { agentId, startId, first: String(sent.result.messageId) }
  }
  const deliveriesTo = async (agentId: string) => (await db.superTabDelivery.findMany({ where: { tabId: tab, agentId } }))
  return { store, tab, execute, host, chat, main, say, reply, session, deliveriesTo }
}

const text = (page: { messages: Array<{ text: string }> }) => page.messages.map(m => m.text)

describe('a Buddy thread session', () => {
  it('starts from a thread reply on its Buddy\'s machine, with no message text in its start, and hears that reply once it joins', async () => {
    const f = await swarm()
    const root = await f.say('Two things today')
    const sent = await f.reply(root, 'Measure prod CPU for the last day', { newSession: true })
    const startId = String(sent.result.startId), first = String(sent.result.messageId)
    const pool = (await poolRows(f.store, peer, 'peer-mac')).find(p => p.tabId === f.tab)!
    const start = pool.buddyStarts!.find(s => s.id === startId)!
    expect(start.request).toMatchObject({ conversationId: f.chat, machineId: 'peer-mac', engine: 'claude', model: 'opus', effort: 'high',
      buddyOf: { personId: peer.sub }, buddySession: { thread: root } })
    expect(JSON.stringify(start)).not.toContain('Measure prod CPU')
    // Nobody hears it while the session starts: the main Buddy never does.
    expect((await db.superTabDelivery.findMany({ where: { tabId: f.tab, messageId: first } }))).toEqual([])
    await f.host({ type: 'agent.startDispatch', startId })
    const agentId = String((await f.host({ type: 'agent.started', startId, harnessId: randomUUID(), configuration: config })).result.agentId)
    expect((await f.deliveriesTo(agentId)).map(d => d.messageId)).toEqual([first])
    expect((await f.deliveriesTo(f.main)).map(d => d.messageId)).not.toContain(first)
    const read = await f.store.read(peer, f.tab)
    expect(read.state.agents.find(a => a.id === agentId)).toMatchObject({ buddyOf: { personId: peer.sub }, buddySession: { thread: root } })
    // The main Buddy stays first: older clients take a Buddy chat's first agent for its Buddy.
    expect(read.state.conversations.find(c => c.id === f.chat)!.agentIds).toEqual([f.main, agentId])
  })

  it('answers a quick main-chat question while the session still holds its long one', async () => {
    const f = await swarm()
    const root = await f.say('Start here')
    const { agentId, first } = await f.session(root)
    // The session claims its long question and has not answered it.
    const long = (await f.store.deliveries(peer, f.tab, agentId)).find(d => d.messageId === first)!
    const sessionClaim = randomUUID()
    await f.store.delivery(peer, f.tab, agentId, long.id, { type: 'claim', claimId: sessionClaim })
    const quick = await f.say('What is the PR number for the login fix?')
    const waiting = (await f.store.deliveries(peer, f.tab, f.main)).find(d => d.messageId === quick)!
    const mainClaim = randomUUID()
    await f.store.delivery(peer, f.tab, f.main, waiting.id, { type: 'claim', claimId: mainClaim })
    await f.store.delivery(peer, f.tab, f.main, waiting.id, { type: 'ack', claimId: mainClaim, receipt: 'r', uncertain: false })
    await f.execute({ type: 'message.send', conversationId: f.chat, text: '#2290.', replyTo: quick, recipientIds: [] }, peer, f.main)
    expect(await db.superTabDelivery.findUniqueOrThrow({ where: { id: long.id } })).toMatchObject({ status: 'claimed' })
    expect(await db.superTabDelivery.findUniqueOrThrow({ where: { id: waiting.id } })).toMatchObject({ status: 'answered' })
  })

  it('keeps every reply in its thread: the person\'s reach it alone, and it can answer nowhere else', async () => {
    const f = await swarm()
    const root = await f.say('Start here'), elsewhere = await f.say('Another topic')
    const { agentId } = await f.session(root)
    const next = String((await f.reply(root, 'And memory too')).result.messageId)
    expect((await db.superTabDelivery.findMany({ where: { tabId: f.tab, messageId: next } })).map(d => d.agentId)).toEqual([agentId])
    expect(await db.superTabMessage.findUniqueOrThrow({ where: { id: next } })).toMatchObject({ thread: root, buddySession: true })
    const post = (extra: Partial<Extract<Command, { type: 'message.send' }>>) =>
      f.execute({ type: 'message.send', conversationId: f.chat, text: 'Result', replyTo: null, recipientIds: [], ...extra }, peer, agentId)
    await expect(post({})).rejects.toMatchObject({ code: 'BUDDY_SESSION_THREAD' })
    await expect(post({ replyTo: elsewhere })).rejects.toMatchObject({ code: 'BUDDY_SESSION_THREAD' })
    await expect(post({ replyTo: next, alsoSend: true })).rejects.toMatchObject({ code: 'BUDDY_SESSION_THREAD' })
    const answer = String((await post({ replyTo: next })).result.messageId)
    expect(await db.superTabMessage.findUniqueOrThrow({ where: { id: answer } })).toMatchObject({ thread: root, buddySession: true })
    // The main Buddy never answers in it, and the person never sends it to the main chat.
    await expect(f.execute({ type: 'message.send', conversationId: f.chat, text: 'Me too', replyTo: root, recipientIds: [] }, peer, f.main))
      .rejects.toMatchObject({ code: 'BUDDY_SESSION_THREAD' })
    await expect(f.reply(root, 'Share it', { alsoSend: true })).rejects.toMatchObject({ code: 'BUDDY_SESSION_THREAD' })
    await expect(f.reply(root, 'To the main one', { recipientIds: [f.main] })).rejects.toMatchObject({ code: 'INVALID_RECIPIENT' })
  })

  it('reads its own thread and the 10 main-chat messages before it started, never later ones or another session\'s thread', async () => {
    const f = await swarm()
    const said: string[] = []
    for (let i = 1; i <= 12; i++) said.push(await f.say(`main ${i}`))
    const root = said.at(-1)!
    const a = await f.session(root)
    const later = await f.say('main after the start')
    const other = await f.say('Second topic')
    const b = await f.session(other, 'The other long question')
    // Its own chat read is its thread alone, whatever it asks for.
    const own = await f.store.messages(peer, f.tab, f.chat, {}, a.agentId)
    expect(text(own)).toEqual(['main 12', 'Measure prod CPU for the last day'])
    expect((own as { context?: Array<{ text: string }> }).context!.map(c => c.text)).toEqual(['main 3', 'main 4', 'main 5', 'main 6', 'main 7', 'main 8',
      'main 9', 'main 10', 'main 11', 'main 12'])
    expect(JSON.stringify(own)).not.toContain('main after the start')
    expect(JSON.stringify(own)).not.toContain('The other long question')
    expect(text(await f.store.messages(peer, f.tab, f.chat, { thread: other }, a.agentId))).toEqual([])
    expect(text(await f.store.messages(peer, f.tab, f.chat, { messageId: later }, a.agentId))).toEqual([])
    expect(text(await f.store.messages(peer, f.tab, f.chat, { thread: other }, b.agentId))).toEqual(['Second topic', 'The other long question'])
    // A made-up thread reads as another thread: empty, saying nothing of what is there.
    expect(text(await f.store.messages(peer, f.tab, f.chat, { thread: 'ffffffffffffffffffffffff' }, a.agentId))).toEqual([])
    // The main Buddy reads the main chat and the roots, never a session's replies, and counts none of them.
    const main = await f.store.messages(peer, f.tab, f.chat, {}, f.main)
    expect(text(main)).toContain('main after the start')
    expect(JSON.stringify(main)).not.toContain('Measure prod CPU')
    expect(JSON.stringify(main)).not.toContain('The other long question')
    expect(text(await f.store.messages(peer, f.tab, f.chat, { thread: root }, f.main))).toEqual(['main 12'])
    expect(main.threads.filter(t => t.id === root || t.id === other)).toEqual([])
    // The person reads it all.
    expect(text(await f.store.messages(peer, f.tab, f.chat, { thread: root }))).toEqual(['main 12', 'Measure prod CPU for the last day'])
  })

  it('runs at most 3 at once, and of two starts racing for the last place exactly one wins', async () => {
    const f = await swarm()
    const roots = [await f.say('one'), await f.say('two'), await f.say('three'), await f.say('four')]
    await f.session(roots[0]!)
    await f.reply(roots[1]!, 'second', { newSession: true })
    const raced = await Promise.allSettled([f.reply(roots[2]!, 'third', { newSession: true }), f.reply(roots[3]!, 'fourth', { newSession: true })])
    expect(raced.filter(r => r.status === 'fulfilled')).toHaveLength(1)
    expect(raced.flatMap(r => r.status === 'rejected' ? [(r.reason as { code?: string }).code] : [])).toEqual(['BUDDY_SESSIONS_FULL'])
    const chat = (await f.store.read(peer, f.tab)).state.conversations.find(c => c.id === f.chat)!
    expect(chat.buddySessions).toHaveLength(3)
    await expect(f.reply(roots[0]!, 'again', { newSession: true })).rejects.toMatchObject({ code: 'BUDDY_SESSION_EXISTS' })
  })

  it('ends on its person\'s word: its session closes, its line stays in the thread, and only a new session continues there', async () => {
    const f = await swarm()
    const root = await f.say('Start here')
    const { agentId } = await f.session(root)
    const queued = String((await f.reply(root, 'One more')).result.messageId)
    await expect(f.execute({ type: 'buddy.sessionEnd', conversationId: f.chat, thread: root, reason: 'ended' }, owner)).rejects.toThrow()
    expect((await f.execute({ type: 'buddy.sessionEnd', conversationId: f.chat, thread: root, reason: 'ended' }, peer)).result.ended).toBe(true)
    expect((await f.execute({ type: 'buddy.sessionEnd', conversationId: f.chat, thread: root, reason: 'ended' }, peer)).result.ended).toBe(false)
    const read = await f.store.read(peer, f.tab)
    expect(read.state.agents.some(a => a.id === agentId)).toBe(false)
    expect(read.state.conversations.find(c => c.id === f.chat)!.buddySessions).toBeUndefined()
    expect(await db.superTabDelivery.findUniqueOrThrow({ where: { id: (await f.deliveriesTo(agentId)).find(d => d.messageId === queued)!.id } }))
      .toMatchObject({ status: 'cancelled' })
    const thread = await f.store.messages(peer, f.tab, f.chat, { thread: root })
    expect(thread.messages.at(-1)).toMatchObject({ text: 'Session ended: you ended it.', buddySession: true,
      source: { kind: 'buddy-session-ended', reason: 'ended', thread: root } })
    await expect(f.reply(root, 'Plain reply')).rejects.toMatchObject({ code: 'BUDDY_SESSION_ENDED' })
    const again = await f.session(root, 'Carry on')
    // The new session reads the whole thread, the one before it included.
    expect(text(await f.store.messages(peer, f.tab, f.chat, {}, again.agentId))).toEqual(['Start here', 'Measure prod CPU for the last day', 'One more',
      'Session ended: you ended it.', 'Carry on'])
  })

  it('ends when its host says it is idle or stopped, and when its start fails, saying why in the thread', async () => {
    const f = await swarm()
    const [a, b, c] = [await f.say('a'), await f.say('b'), await f.say('c')]
    await f.session(a)
    await f.session(b)
    const failing = String((await f.reply(c, 'Will fail', { newSession: true })).result.startId)
    // Its host acts as its person, as it confirms a closed session (agent.sessionClosed).
    await f.execute({ type: 'buddy.sessionEnd', conversationId: f.chat, thread: a, reason: 'idle' }, peer)
    await f.execute({ type: 'buddy.sessionEnd', conversationId: f.chat, thread: b, reason: 'stopped' }, peer)
    await f.host({ type: 'agent.startDispatch', startId: failing })
    await f.host({ type: 'agent.startFailed', startId: failing, error: 'Not enough memory' })
    const last = async (root: string) => (await f.store.messages(peer, f.tab, f.chat, { thread: root })).messages.at(-1)!.text
    expect(await last(a)).toBe('Session ended: idle for 30 minutes.')
    expect(await last(b)).toBe('Session ended: it stopped unexpectedly.')
    expect(await last(c)).toBe('Session ended: it couldn\'t start: Not enough memory')
    expect((await f.store.read(peer, f.tab)).state.conversations.find(x => x.id === f.chat)!.buddySessions).toBeUndefined()
  })

  it('goes with its Buddy: removing the Buddy ends every session and a start not yet running', async () => {
    const f = await swarm()
    const [a, b] = [await f.say('a'), await f.say('b')]
    const { agentId } = await f.session(a)
    const pending = String((await f.reply(b, 'pending', { newSession: true })).result.startId)
    await f.execute({ type: 'buddy.remove', projectId: 'lead' }, peer)
    const read = await f.store.read(peer, f.tab)
    expect(read.state.agents.filter(x => x.id === agentId || x.id === f.main)).toEqual([])
    expect(read.state.conversations.find(c => c.id === f.chat)!.buddySessions).toBeUndefined()
    expect(read.state.starts?.find(s => s.id === pending)?.error).toBeTruthy()
  })

  it('is refused without saying whose: an old host, no Buddy, another person, a made-up thread, a plain main message', async () => {
    const old = await swarm({ capable: false })
    const root = await old.say('Start')
    await expect(old.reply(root, 'x', { newSession: true })).rejects.toMatchObject({ code: 'BUDDY_SESSION_UNSUPPORTED' })
    const f = await swarm()
    const mine = await f.say('mine')
    await expect(f.execute({ type: 'message.send', conversationId: f.chat, text: 'x', replyTo: mine, recipientIds: [], newSession: true }, owner))
      .rejects.toThrow('unavailable')
    await expect(f.reply('ffffffffffffffffffffffff', 'x', { newSession: true })).rejects.toMatchObject({ code: 'INVALID_REPLY' })
    await expect(f.execute({ type: 'message.send', conversationId: f.chat, text: 'x', replyTo: null, recipientIds: [], newSession: true }, peer))
      .rejects.toMatchObject({ code: 'BUDDY_SESSION_CHAT' })
    await f.execute({ type: 'buddy.remove', projectId: 'lead' }, peer)
    await expect(f.reply(mine, 'x', { newSession: true })).rejects.toMatchObject({ code: 'BUDDY_SESSION_NO_BUDDY' })
  })

  it('proposes to the PM only for its person\'s ask in its own thread', async () => {
    const f = await swarm()
    const root = await f.say('Start here')
    const { agentId, first } = await f.session(root)
    const mainAsk = await f.say('Send the other thing to the PM')
    const propose = (ownerMessageId: string) => f.execute({ type: 'buddy.propose', conversationId: f.chat, ownerMessageId, goal: 'CPU fix',
      scope: 'Backend', priority: 'normal' }, peer, agentId)
    await expect(propose(mainAsk)).rejects.toMatchObject({ code: 'PROPOSAL_UNASKED' })
    await expect(propose(first)).resolves.toBeTruthy()
  })
})
