import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PrismaClient } from '@prisma/client'
import { MongoMemoryReplSet } from 'mongodb-memory-server-core'
import type { AuthUser } from '../src/lib/ssoAuth.js'
import { SuperTabStore } from '../src/superTabs/store.js'
import { commandSchema } from '../src/superTabs/commands.js'
import { SwarmReads } from '../src/superTabs/read/service.js'
import { HostReads } from '../src/superTabs/read/host.js'

// Task #4248, from the v3 flows audit (#4212): what a member who joined with their own computer meets, through the store.
let db: PrismaClient, replica: MongoMemoryReplSet
const owner: AuthUser = { sub: '610000000000000000000001', email: 'owner@example.test', autonomousEnv: 'prod', role: 'user' }
const member: AuthUser = { sub: '610000000000000000000002', email: 'member@example.test', autonomousEnv: 'prod', role: 'user' }
const configuration = { engine: 'codex', model: 'fixture', effort: 'high', contextWindow: 200000, engineVersion: 'fixture' }

beforeAll(async () => {
  replica = await MongoMemoryReplSet.create({ binary: { version: '7.0.24', downloadDir: join(tmpdir(), 'harness-super-tab-mongodb-binaries') },
    replSet: { count: 1, ip: '127.0.0.1', storageEngine: 'wiredTiger' } })
  const uri = replica.getUri(`swarm_v3_flows_${randomUUID().replaceAll('-', '_')}`)
  await promisify(execFile)(join(process.cwd(), 'node_modules/.bin/prisma'), ['db', 'push', '--skip-generate'], {
    env: { ...process.env, DATABASE_URL: uri }, timeout: 60000,
  })
  db = new PrismaClient({ datasources: { db: { url: uri } } })
  for (const user of [owner, member]) {
    await db.user.create({ data: { id: user.sub, externalId: `fixture-${user.sub}`, email: user.email, autonomousEnv: 'prod' } })
    await db.machine.create({ data: { machineId: user.sub, userId: user.sub, apiKey: `fixture-${user.sub}`, managerId: 'fixture', autonomousEnv: 'prod', authMode: 'remote' } })
  }
})
afterAll(async () => { await db?.$disconnect(); await replica?.stop() })

/** The owner's Swarm with the member in it, their computer listed as Desktop's join lists it, and reporting. */
async function joined() {
  const store = new SuperTabStore(db, Date.now, null, { readCache: null }), reads = new SwarmReads(store)
  const tab = (await store.create(owner, randomUUID(), 'Flows', 'public')).id
  const execute = (command: unknown, user = owner, asAgentId?: string, hostMachineId?: string) =>
    store.execute(user, tab, { operationId: randomUUID(), command: commandSchema.parse(command) }, asAgentId, hostMachineId)
  const invite = await execute({ type: 'invite.create', email: member.email, role: 'collaborator', conversationId: 'lead' })
  await execute({ type: 'invite.accept', inviteId: invite.result.inviteId }, member)
  // Desktop's join (agent_launcher.dart) lists the computer with teamAccountOnly, as clients from before v3 did too.
  await execute({ type: 'machine.contribute', machineId: member.sub, name: 'Member computer', cwd: '/fixture', scope: 'swarm', engines: ['codex'],
    maxAgents: 4, agents: 'memory', teamAccountOnly: true }, member)
  const running: string[] = []
  const report = async () => {
    const own = (await new HostReads(store).changes(member, member.sub, { full: true })).tabs.find(row => row.tabId === tab)
    if (!own || !('pool' in own) || !own.pool) throw new Error('The member computer has no host pool')
    await store.observeMachine(member, tab, member.sub, { generation: own.pool.machine.generation, resources: { cpuPercent: 10, memoryTotalBytes: 32e9,
      memoryUsedBytes: 4e9, diskFreeBytes: 120e9, diskTotalBytes: 500e9, projectDiskFreeBytes: 120e9, deviceType: 'Laptop', chip: 'Fixture', os: 'macOS',
      gpuPercent: null }, quotas: [], tools: {}, runningHarnessIds: [...running], stoppedHarnessIds: [], capabilities: ['regularAgent'] })
  }
  await report()
  const host = (command: unknown) => execute(command, member, undefined, member.sub)
  const launch = async (startId: string) => {
    await host({ type: 'agent.startDispatch', startId })
    const harnessId = randomUUID(); running.push(harnessId)
    const id = String((await host({ type: 'agent.started', startId, harnessId, configuration })).result.agentId)
    await host({ type: 'agent.startSettled', startId, warning: null })
    await report()
    return id
  }
  return { store, reads, tab, execute, launch }
}

describe('a Regular agent\'s own chat (#4212 finding 1)', () => {
  it('is in its person\'s read, opens, takes read marks, and carries messages both ways', async () => {
    const f = await joined()
    const made = await f.execute({ type: 'agent.new', kind: 'regular', name: 'Worker', machineId: member.sub, engine: 'codex' }, member)
    const chat = String(made.result.conversationId), worker = await f.launch(String(made.result.startId))

    expect((await f.store.read(member, f.tab)).state.conversations.map(c => c.id)).toContain(chat)
    expect(JSON.stringify((await f.reads.firstLoad(member, f.tab)))).toContain(chat)
    const asked = await f.execute({ type: 'message.send', conversationId: chat, text: 'Fix the footer', replyTo: null, recipientIds: [] }, member)
    expect((await f.store.deliveries(member, f.tab, worker)).map(row => row.messageId)).toContain(asked.result.messageId)
    await f.execute({ type: 'message.send', conversationId: chat, text: 'On it', replyTo: null, recipientIds: [] }, member, worker)
    const opened = await f.store.messages(member, f.tab, chat, {})
    expect(JSON.stringify(opened)).toContain('On it')
    await f.reads.markRead(member, f.tab, chat, 2)

    // Still nobody else's: the Swarm's owner neither reads nor opens it.
    expect((await f.store.read(owner, f.tab)).state.conversations.map(c => c.id)).not.toContain(chat)
    await expect(f.store.messages(owner, f.tab, chat, {})).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

describe('a member\'s computer listed as they joined (#4212 finding 8)', () => {
  it('reads as taking the owner\'s projects\' work, so the route keeps the member\'s own agents', async () => {
    const f = await joined()
    const row = (await f.store.read(owner, f.tab)).state.machines!.find(m => m.machineId === member.sub) as { teamWork?: unknown }
    expect(row.teamWork).toEqual({ allowed: true })
    const derived = (await f.reads.firstLoad(owner, f.tab)) as unknown as { derived?: { machines?: Record<string, { teamWork: unknown }> } }
    expect(derived.derived?.machines?.[member.sub]?.teamWork).toEqual({ allowed: true })
  })
})
