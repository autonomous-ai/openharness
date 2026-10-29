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
import { configureSwarmStamps, SwarmCache } from '../src/superTabs/cache.js'
import { MemoryStamps } from '../src/superTabs/cache.test-support.js'
import { SWEEP_EVERY_MS } from '../src/superTabs/liveness.js'
import { memberId } from '../src/superTabs/workspaceStore.js'
import type { MessagesPolled, MessagesPollMemory } from '../src/superTabs/quietMessages.js'

// The quiet messages poll (WebSocket roadmap, Phase 2 item 3): a forward poll with nothing new, by a caller whose full read
// passed within SWEEP_EVERY_MS while the Swarm is unchanged, is answered without loading the Swarm, and every access check
// that rests outside the Swarm runs again. A fresh loopback replica set; never DATABASE_URL.
let replica: MongoMemoryReplSet
let db: PrismaClient
/** Every read of a Swarm part's collection, by model: what loading the Swarm costs when nothing is held. */
let partReads = 0
const PARTS = new Set(['SwarmHead', 'SwarmMember', 'SwarmGroup', 'SwarmAgent', 'SwarmMachine', 'SwarmStart', 'SwarmProgress'])
const stamps = new MemoryStamps()
let clock = Date.now()
const owner: AuthUser = { sub: '400000000000000000000001', email: 'owner@example.com', autonomousEnv: 'prod', role: 'user' }
const peer: AuthUser = { sub: '400000000000000000000002', email: 'peer@example.com', autonomousEnv: 'prod', role: 'user' }
const config = { engine: 'claude', model: 'fixture-model', effort: 'high', contextWindow: 200000, engineVersion: 'fixture' }

beforeAll(async () => {
  replica = await MongoMemoryReplSet.create({ binary: { version: '7.0.24', downloadDir: join(tmpdir(), 'harness-super-tab-mongodb-binaries') },
    replSet: { count: 1, ip: '127.0.0.1', storageEngine: 'wiredTiger' } })
  const uri = replica.getUri(`swarm_quiet_messages_test_${randomUUID().replaceAll('-', '_')}`)
  await promisify(execFile)(join(process.cwd(), 'node_modules/.bin/prisma'), ['db', 'push', '--skip-generate'], {
    env: { ...process.env, DATABASE_URL: uri }, timeout: 60000,
  })
  const base = new PrismaClient({ datasources: { db: { url: uri } } })
  db = base.$extends({ query: { $allModels: { async $allOperations({ model, args, query }) {
    if (PARTS.has(model)) partReads++
    return query(args)
  } } } }) as unknown as PrismaClient
  // The stamps every commit here bumps, so a write moves what the store reads, as Redis would.
  configureSwarmStamps(stamps)
  for (const user of [owner, peer]) await db.user.create({ data: { id: user.sub, externalId: `fixture-${user.sub}`, email: user.email, autonomousEnv: 'prod' } })
})
afterAll(async () => {
  await db?.$disconnect()
  await replica?.stop()
})

/** The memory as Redis keeps it, in this process. */
function memory(): MessagesPollMemory & { held: Map<string, MessagesPolled> } {
  const held = new Map<string, MessagesPolled>()
  return { held, get: async key => held.get(key), set: async (key, value) => { held.set(key, value) } }
}

/** A Swarm whose Lead runs on the owner's Mac, with one message in the Lead conversation. The store holds nothing between
 *  reads (`maxAgeMs` 0), so every load of the Swarm reads its parts from Mongo. `quiet` false is the switch off. */
async function swarm(quiet: boolean | MessagesPollMemory = true, leadMachine?: string) {
  const polls = quiet === true ? memory() : quiet === false ? undefined : quiet
  const store = new SuperTabStore(db, () => clock, null, { readCache: new SwarmCache(stamps, { maxAgeMs: 0 }), ...(polls ? { messagePolls: polls } : {}) })
  const machineId = leadMachine ?? `mac-${randomUUID().slice(0, 8)}`
  if (!leadMachine) {
    await db.machine.create({ data: { machineId, userId: owner.sub, apiKey: `fixture-${machineId}`, managerId: 'fixture', autonomousEnv: 'prod', authMode: 'remote' } })
  }
  const tab = (await store.create(owner, randomUUID(), 'Quiet', 'public')).id
  const execute = (command: Command) => store.execute(owner, tab, { operationId: randomUUID(), command })
  const lead = String((await execute({ type: 'agent.add', conversationId: 'lead', machineId, harnessId: randomUUID(), name: 'PM',
    configuration: config, lead: true })).result.agentId)
  await execute({ type: 'message.send', conversationId: 'lead', text: 'First', replyTo: null, recipientIds: [] })
  const page = await store.messages(owner, tab, 'lead', {})
  const last = page.messages.at(-1)!
  const after = { after: last.sequence, afterId: last.id }
  /** One poll after the last message, and how many part reads it made. */
  const poll = async (asAgentId?: string) => {
    const before = partReads
    const answer = await store.messages(owner, tab, 'lead', after, asAgentId)
    return { answer, reads: partReads - before }
  }
  return { store, tab, execute, lead, machineId, last, poll, polls: polls as ReturnType<typeof memory> | undefined }
}

describe('a forward messages poll with nothing new', () => {
  it('is answered without loading the Swarm once a full read passed, with the same answer', async () => {
    const f = await swarm()
    const full = await f.poll()
    expect(full.reads).toBeGreaterThan(0)
    const quiet = await f.poll()
    expect(quiet.answer).toEqual(full.answer)
    expect(quiet.answer).toEqual({ messages: [], next: null, reactionSeq: 0 })
    expect(quiet.reads).toBe(0)
    // So is the Lead agent's own poll, after its own full read.
    expect((await f.poll(f.lead)).reads).toBeGreaterThan(0)
    expect((await f.poll(f.lead)).reads).toBe(0)
  })

  it('reads in full with the switch off', async () => {
    const f = await swarm(false)
    await f.poll()
    expect((await f.poll()).reads).toBeGreaterThan(0)
  })

  it('reads in full once the last full read is SWEEP_EVERY_MS old', async () => {
    const f = await swarm()
    await f.poll()
    clock += SWEEP_EVERY_MS
    expect((await f.poll()).reads).toBeGreaterThan(0)
    expect((await f.poll()).reads).toBe(0)
  })

  it('answers a new message in full', async () => {
    const f = await swarm()
    await f.poll()
    await f.execute({ type: 'message.send', conversationId: 'lead', text: 'Second', replyTo: null, recipientIds: [] })
    expect((await f.poll()).answer.messages.map(m => m.text)).toEqual(['Second'])
  })

  it('learns a reaction in full: it writes no message row, but moves the Swarm\'s stamp', async () => {
    const f = await swarm()
    await f.poll()
    expect((await f.poll()).reads).toBe(0)
    await f.execute({ type: 'message.react', conversationId: 'lead', messageId: f.last.id, emoji: 'thumbs_up', on: true })
    const reacted = await f.poll()
    expect(reacted.reads).toBeGreaterThan(0)
    expect(reacted.answer.reactionSeq).toBe(1)
  })

  it('refuses an agent whose machine was deleted, though no Swarm write recorded it', async () => {
    const f = await swarm()
    await f.poll(f.lead)
    expect((await f.poll(f.lead)).reads).toBe(0)
    await db.machine.update({ where: { machineId: f.machineId }, data: { deletedAt: new Date() } })
    await expect(f.store.messages(owner, f.tab, 'lead', { after: f.last.sequence, afterId: f.last.id }, f.lead))
      .rejects.toMatchObject({ code: 'HOST_UNAVAILABLE' })
  })

  it('refuses a person no longer in the Swarm\'s Workspace, though no Swarm write recorded it yet', async () => {
    const f = await swarm()
    await f.poll()
    expect((await f.poll()).reads).toBe(0)
    const workspaceId = (await db.superTab.findUnique({ where: { id: f.tab }, select: { workspaceId: true } }))!.workspaceId!
    const member = { where: { id: memberId(workspaceId, owner.sub) } }
    await db.swarmWorkspaceMember.update({ ...member, data: { removedAt: new Date() } })
    try {
      await expect(f.store.messages(owner, f.tab, 'lead', { after: f.last.sequence, afterId: f.last.id }))
        .rejects.toMatchObject({ code: 'WORKSPACE_ACCESS_REVOKED' })
    } finally {
      // Every Swarm here is in the owner's own Workspace.
      await db.swarmWorkspaceMember.update({ ...member, data: { removedAt: null } })
    }
  })

  it('refuses a teammate removed from the Swarm at their next poll', async () => {
    const f = await swarm()
    const invitation = await f.execute({ type: 'invite.create', email: peer.email, role: 'collaborator', conversationId: 'lead' })
    await f.store.execute(peer, f.tab, { operationId: randomUUID(), command: { type: 'invite.accept', inviteId: invitation.result.inviteId as string } })
    const after = { after: f.last.sequence, afterId: f.last.id }
    await f.store.messages(peer, f.tab, 'lead', after)
    // Joined the Workspace with the Swarm, read once in full: the next poll is quiet.
    const before = partReads
    expect((await f.store.messages(peer, f.tab, 'lead', after)).messages).toEqual([])
    expect(partReads - before).toBe(0)
    await f.execute({ type: 'member.remove', userId: peer.sub })
    await expect(f.store.messages(peer, f.tab, 'lead', after)).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('refuses once the Swarm is gone', async () => {
    const f = await swarm()
    await f.poll()
    expect((await f.poll()).reads).toBe(0)
    await db.superTab.delete({ where: { id: f.tab } })
    await expect(f.store.messages(owner, f.tab, 'lead', { after: f.last.sequence, afterId: f.last.id })).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('refuses a team session whose computer now signs in as another machine', async () => {
    // The owner's Harness Team account on a Mac: its daemon reads as the Lead it hosts, on that machine only (store.ts actor).
    const computerId = randomUUID().replaceAll('-', '')
    const team: AuthUser = { ...owner, harnessSessionId: `team-${computerId}`, harnessSessionKind: 'team', harnessComputerId: computerId }
    const machine = (machineId: string) => db.machine.create({ data: { machineId, userId: owner.sub, computerId, sessionKind: 'team',
      apiKey: `fixture-${machineId}`, managerId: 'fixture', autonomousEnv: 'prod', authMode: 'remote' } })
    const teamMac = `team-${randomUUID().slice(0, 8)}`
    await machine(teamMac)
    const f = await swarm(true, teamMac)
    const after = { after: f.last.sequence, afterId: f.last.id }
    await f.store.messages(team, f.tab, 'lead', after, f.lead)
    const before = partReads
    expect((await f.store.messages(team, f.tab, 'lead', after, f.lead)).messages).toEqual([])
    expect(partReads - before).toBe(0)
    // The computer now signs in as another machine of the account: the session may no longer speak for the first one's agent.
    await db.machine.update({ where: { machineId: teamMac }, data: { computerId: 'moved' } })
    await machine(`team-${randomUUID().slice(0, 8)}`)
    await expect(f.store.messages(team, f.tab, 'lead', after, f.lead)).rejects.toMatchObject({ code: 'TEAM_SESSION_LIMITED' })
  })

  it('refuses the host of an agent on a shared machine once the share is taken back', async () => {
    // peer's machine, shared with the owner, runs the owner's agent: its host reads as that agent, through the share.
    const f = await swarm()
    const invitation = await f.execute({ type: 'invite.create', email: peer.email, role: 'collaborator', conversationId: 'lead' })
    await f.store.execute(peer, f.tab, { operationId: randomUUID(), command: { type: 'invite.accept', inviteId: invitation.result.inviteId as string } })
    const sharedMac = `shared-${randomUUID().slice(0, 8)}`
    await db.machine.create({ data: { machineId: sharedMac, userId: peer.sub, apiKey: `fixture-${sharedMac}`, managerId: 'fixture', autonomousEnv: 'prod', authMode: 'remote' } })
    await db.machineShare.create({ data: { machineId: sharedMac, ownerId: peer.sub, autonomousEnv: 'prod', emails: [owner.email] } })
    const worker = String((await f.execute({ type: 'agent.add', conversationId: 'lead', machineId: sharedMac, harnessId: randomUUID(), name: 'Worker',
      configuration: config, lead: false })).result.agentId)
    const page = await f.store.messages(peer, f.tab, 'lead', {}, worker)
    const after = { after: page.messages.at(-1)!.sequence, afterId: page.messages.at(-1)!.id }
    await f.store.messages(peer, f.tab, 'lead', after, worker)
    const before = partReads
    expect((await f.store.messages(peer, f.tab, 'lead', after, worker)).messages).toEqual([])
    expect(partReads - before).toBe(0)
    await db.machineShare.delete({ where: { machineId: sharedMac } })
    await expect(f.store.messages(peer, f.tab, 'lead', after, worker)).rejects.toMatchObject({ code: 'CONTRIBUTION_REVOKED' })
  })

  it('reads in full while its memory fails', async () => {
    const failing: MessagesPollMemory = { get: async () => { throw new Error('redis down') }, set: async () => { throw new Error('redis down') } }
    const f = await swarm(failing)
    expect((await f.poll()).answer).toEqual({ messages: [], next: null, reactionSeq: 0 })
    expect((await f.poll()).reads).toBeGreaterThan(0)
  })

  it('never answers a caller that did not pass a full read, nor from another caller\'s', async () => {
    const f = await swarm()
    await f.poll()
    const stranger: AuthUser = { sub: '400000000000000000000009', email: 'stranger@example.com', autonomousEnv: 'prod', role: 'user' }
    await expect(f.store.messages(stranger, f.tab, 'lead', { after: f.last.sequence, afterId: f.last.id })).rejects.toMatchObject({ code: 'WORKSPACE_ACCESS_REVOKED' })
    // The owner speaking as an agent it never read as is checked in full.
    expect((await f.poll(f.lead)).reads).toBeGreaterThan(0)
    expect([...f.polls!.held.keys()].every(k => !k.includes(stranger.sub))).toBe(true)
  })
})
