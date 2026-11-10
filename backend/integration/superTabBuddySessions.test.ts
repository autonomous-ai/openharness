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
import { storeBuddy, storeSession } from './storedBuddies.test-support.js'

// Buddy thread sessions through the store (buddySessions.ts; spec docs/superpowers/specs/2026-10-30-buddy-thread-sessions-
// design.md): a session beside a person's main Buddy hears and answers only its thread, and reads the main chat only up to
// where it started. Nothing starts one since Swarm v4 (2026-11-10): these are the read rules for those a v3 release stored,
// which hold until the conversion ends them (buddyConversion.ts).
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

/** A Swarm whose PM runs on the owner's Mac, and peer a member whose main Buddy, on their Mac, a v3 release stored in their one
 *  Buddy chat. */
async function swarm() {
  const store = new SuperTabStore(db, () => Date.now(), { store: new MemoryAttachmentStore(), prefix: 'super-tabs', publicBase: 'https://cdn.example.test' })
  const tab = (await store.create(owner, randomUUID(), 'Sessions', 'public')).id
  const execute = (command: Command, user = owner, asAgentId?: string) => store.execute(user, tab, { operationId: randomUUID(), command }, asAgentId)
  const invitation = await execute({ type: 'invite.create', email: peer.email, role: 'collaborator', conversationId: 'lead' })
  await execute({ type: 'invite.accept', inviteId: invitation.result.inviteId as string }, peer)
  await execute({ type: 'agent.add', conversationId: 'lead', machineId: 'owner-mac', harnessId: randomUUID(), name: 'PM', configuration: config, lead: true })
  const { chat, agentId: main } = await storeBuddy(db, tab, { personId: peer.sub, machineId: 'peer-mac', configuration: config })
  /** peer's message in the main chat, or in [replyTo]'s thread. */
  const say = async (text: string, replyTo: string | null = null) =>
    String((await execute({ type: 'message.send', conversationId: chat, text, replyTo, recipientIds: [] }, peer)).result.messageId)
  /** [root]'s session, as its start left it: [first], the person's message that started it, in its thread and marked the session's
   *  (a top-level one is the root itself), and the session reading the main chat up to the row before it. */
  const session = async (root: string, first = root) => {
    await db.superTabMessage.update({ where: { id: first }, data: { buddySession: true } })
    const from = (await db.superTabMessage.findUniqueOrThrow({ where: { id: first } })).sequence - 1
    return { agentId: (await storeSession(db, tab, chat, { thread: root, from })).agentId, first }
  }
  return { store, tab, execute, chat, main, say, session }
}

const text = (page: { messages: Array<{ text: string }> }) => page.messages.map(m => m.text)

describe('a Buddy thread session', () => {
  it('reads its own thread and the 10 main-chat messages before it started, never later ones or another session\'s thread', async () => {
    const f = await swarm()
    const said: string[] = []
    for (let i = 1; i <= 12; i++) said.push(await f.say(`main ${i}`))
    const root = said.at(-1)!
    const a = await f.session(root, await f.say('Measure prod CPU for the last day', root))
    const later = await f.say('main after the start')
    const other = await f.say('Second topic')
    const b = await f.session(other, await f.say('The other long question', other))
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

  it('rooted at the person\'s own main-chat message, is read by its session alone of the Buddies, and by the chat\'s readers', async () => {
    const f = await swarm()
    await f.say('Earlier in the main chat')
    const ask = 'Measure prod CPU for the last day'
    const { agentId } = await f.session(await f.say(ask))
    // The main Buddy never reads it; its session reads its own thread from that root.
    const mainReads = text(await f.store.messages(peer, f.tab, f.chat, {}, f.main))
    expect(mainReads).toContain('Earlier in the main chat')
    expect(mainReads).not.toContain(ask)
    expect(text(await f.store.messages(peer, f.tab, f.chat, {}, agentId))).toEqual([ask])
    // The person reads it in the main chat, as the root of its thread.
    expect(text(await f.store.messages(peer, f.tab, f.chat, {})).slice(-2)).toEqual(['Earlier in the main chat', ask])
    // Another member reads none of the chat, as before.
    await expect(f.store.messages(owner, f.tab, f.chat, {})).rejects.toThrow()
  })

  it('reacts only to what it reads (security review 2)', async () => {
    const f = await swarm()
    const [a, b] = [await f.say('a'), await f.say('b')]
    const one = await f.session(a, await f.say('first', a)), two = await f.session(b, await f.say('second', b))
    const react = (messageId: string, agentId: string) => f.execute({ type: 'message.react', conversationId: f.chat, messageId, emoji: 'thumbs_up', on: true }, peer, agentId)
    await expect(react(a, one.agentId)).resolves.toBeTruthy()
    await expect(react(one.first, one.agentId)).resolves.toBeTruthy()
    const elsewhere = await f.say('main only')
    await expect(react(elsewhere, one.agentId)).rejects.toThrow()
    await expect(react(two.first, one.agentId)).rejects.toThrow()
    await expect(react(one.first, f.main)).rejects.toThrow()
  })
})
