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
import { overdueDecisions } from '../src/superTabs/overdueDecisions.js'
import { poolRows } from './hostRows.test-support.js'

// Task #4525 (anh Dee, 11-07): everything waiting on a person shows in their Decisions, their own Buddy's questions included, and
// an answer in chat or in Decisions settles it in both. Through the store, on a fresh loopback replica set.
let replica: MongoMemoryReplSet
let db: PrismaClient
const owner: AuthUser = { sub: '320000000000000000000001', email: 'owner@example.com', autonomousEnv: 'prod', role: 'user' }
const peer: AuthUser = { sub: '320000000000000000000002', email: 'peer@example.com', autonomousEnv: 'prod', role: 'user' }
const other: AuthUser = { sub: '320000000000000000000003', email: 'other@example.com', autonomousEnv: 'prod', role: 'user' }
const config = { engine: 'claude', model: 'fixture-model', effort: 'high', contextWindow: 200000, engineVersion: 'fixture' }

beforeAll(async () => {
  replica = await MongoMemoryReplSet.create({ binary: { version: '7.0.24', downloadDir: join(tmpdir(), 'harness-super-tab-mongodb-binaries') },
    replSet: { count: 1, ip: '127.0.0.1', storageEngine: 'wiredTiger' } })
  const uri = replica.getUri(`swarm_buddy_decisions_test_${randomUUID().replaceAll('-', '_')}`)
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

const question = { question: 'Keep the old flag?', options: ['Keep it', 'Drop it'], recommended: 1, unblocks: 'The cleanup' }
const words = { text: 'Drop the old flag from the CLI.', goal: 'No dead flags', scope: 'The CLI flag only', priority: 'normal' as const }
async function asked(f: Swarm, q: Record<string, unknown> = question) {
  const b = await buddy(f)
  const ask = await f.execute({ type: 'decision.ask', conversationId: b.chat, personId: peer.sub, questions: [q] } as Command, peer, b.main)
  return { ...b, id: (ask.result.decisionIds as string[])[0]! }
}
const open = async (f: Swarm) => (await f.store.decisions(peer, f.tab, 'open')).decisions.map(d => d.id)
const lines = async (f: Swarm, chat: string) => (await f.store.messages(peer, f.tab, chat, {})).messages.map(m => m.text)

describe('a Buddy’s question in its owner’s Decisions', () => {
  it('shows in their open Decisions as their Buddy’s, which the 24-hour sweep never takes', async () => {
    const f = await swarm()
    const b = await asked(f)
    const listed = (await f.store.decisions(peer, f.tab, 'open')).decisions
    expect(listed).toEqual([expect.objectContaining({ id: b.id, fromBuddy: true, send: false, pmTakesOver: false, question: question.question })])
    expect((await f.store.decisions(owner, f.tab, 'open')).decisions).toEqual([])
    expect((await overdueDecisions(db, f.clock.now + 25 * 3_600_000)).map(d => d.id)).not.toContain(b.id)
  })

  it('settles from Decisions, and the Buddy hears it in its chat', async () => {
    const f = await swarm()
    const b = await asked(f)
    await f.execute({ type: 'decision.answer', decisionId: b.id, choice: 0 }, peer)
    expect(await open(f)).toEqual([])
    expect(await lines(f, b.chat)).toContain('Keep it — Keep the old flag?')
  })

  it('settles from chat when its Buddy names its owner’s answer there, and only then', async () => {
    const f = await swarm()
    const b = await asked(f)
    await expect(f.execute({ type: 'decision.answer', decisionId: b.id, choice: 1, ownerMessageId: 'nothere' }, peer, b.main)).rejects.toMatchObject({ code: 'BUDDY_DECISION_UNASKED' })
    const said = await send(f, b.chat, 'drop it')
    await f.execute({ type: 'decision.answer', decisionId: b.id, choice: 1, ownerMessageId: String(said.result.messageId) }, peer, b.main)
    expect(await open(f)).toEqual([])
    expect((await f.store.decisions(peer, f.tab, 'settled')).decisions).toEqual([expect.objectContaining({ id: b.id, choice: 1, answer: 'Drop it' })])
  })

  it('Send posts exactly the shown words in the project chat as its owner, once', async () => {
    const f = await swarm()
    const b = await asked(f, { send: { ...words, projectId: f.web.projectId } })
    const listed = (await f.store.decisions(peer, f.tab, 'open')).decisions
    expect(listed).toEqual([expect.objectContaining({ id: b.id, send: true, question: words.text, options: ['Send', 'Not now'] })])
    await f.execute({ type: 'decision.answer', decisionId: b.id, choice: 0 }, peer)
    const posted = (await f.store.messages(owner, f.tab, f.web.conversationId, {})).messages.filter(m => m.text === words.text)
    expect(posted).toEqual([expect.objectContaining({ author: expect.objectContaining({ kind: 'person', id: peer.sub }) })])
    await expect(f.execute({ type: 'decision.answer', decisionId: b.id, choice: 0 }, peer)).rejects.toMatchObject({ code: 'DECISION_ANSWERED' })
  })

  it('refuses another person’s Buddy asking for them', async () => {
    const f = await swarm()
    const b = await buddy(f)
    await expect(f.execute({ type: 'decision.ask', conversationId: b.chat, personId: owner.sub, questions: [question] }, peer, b.main)).rejects.toMatchObject({ code: 'BUDDY_ASKS_OWNER' })
  })
})
