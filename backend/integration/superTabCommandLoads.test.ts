import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { MongoMemoryReplSet } from 'mongodb-memory-server-core'
import { PrismaClient, type Prisma } from '@prisma/client'
import type { AuthUser } from '../src/lib/ssoAuth.js'
import { SuperTabStore } from '../src/superTabs/store.js'
import type { Command } from '../src/superTabs/commands.js'
import { logger } from '../src/utils/logger.js'
import type { Conversation } from '../src/superTabs/model.js'

// Ken's prod DB profile, 2026-11-02: a command naming the PM read every group the PM was ever in, 1,628 of them and growing with
// every task, up to 1.66 s a read. Those that write its groups need them; those that only ask about it do not.
const REFUSED = 'Swarm command refused'
let replica: MongoMemoryReplSet
let db: PrismaClient
const owner: AuthUser = { sub: '220000000000000000000001', email: 'owner@example.com', autonomousEnv: 'prod', role: 'user' }
const config = { engine: 'codex', model: 'fixture-model', effort: 'high', contextWindow: 200000, engineVersion: 'fixture' }

beforeAll(async () => {
  replica = await MongoMemoryReplSet.create({ binary: { version: '7.0.24', downloadDir: join(tmpdir(), 'harness-super-tab-mongodb-binaries') },
    replSet: { count: 1, ip: '127.0.0.1', storageEngine: 'wiredTiger' } })
  const uri = replica.getUri(`swarm_command_loads_test_${randomUUID().replaceAll('-', '_')}`)
  await promisify(execFile)(join(process.cwd(), 'node_modules/.bin/prisma'), ['db', 'push', '--skip-generate'], {
    env: { ...process.env, DATABASE_URL: uri }, timeout: 60000,
  })
  db = new PrismaClient({ datasources: { db: { url: uri } } })
  await db.user.create({ data: { id: owner.sub, externalId: `fixture-${owner.sub}`, email: owner.email, autonomousEnv: owner.autonomousEnv } })
  await db.machine.create({ data: { machineId: 'mac', userId: owner.sub, apiKey: 'fixture-mac', managerId: 'fixture', autonomousEnv: 'prod', authMode: 'remote' } })
}, 120_000)
afterAll(async () => {
  await db?.$disconnect()
  await replica?.stop()
})

/** A Swarm with a coordinator, a worker and [dormant] archived-free dormant groups holding the coordinator. */
async function swarm(dormant = 0) {
  const store = new SuperTabStore(db)
  const tab = (await store.create(owner, randomUUID(), 'Loads', 'public')).id
  const execute = (command: Command, asAgentId?: string) => store.execute(owner, tab, { operationId: randomUUID(), command }, asAgentId)
  await execute({ type: 'machine.contribute', machineId: 'mac', name: 'Mac', cwd: '/repo', engines: ['codex'], maxAgents: 8 })
  const harness = { lead: randomUUID(), worker: randomUUID() }
  const lead = String((await execute({ type: 'agent.add', conversationId: 'lead', machineId: 'mac', harnessId: harness.lead, name: 'Lead', configuration: config, lead: true })).result.agentId)
  const group = String((await execute({ type: 'conversation.create', title: 'Ship the parser', brief: 'Implement it', checks: [] })).result.conversationId)
  const worker = String((await execute({ type: 'agent.add', conversationId: group, machineId: 'mac', harnessId: harness.worker, name: 'Worker', configuration: config, lead: false })).result.agentId)
  const part = await db.swarmGroup.findFirstOrThrow({ where: { tabId: tab, key: group } })
  const { id: _id, ...shape } = part
  const rows: Prisma.SwarmGroupCreateManyInput[] = Array.from({ length: dormant }, (_, i) => {
    const key = `old-${i}`
    return { ...shape, id: `${tab}:group:${key}`, key, dormant: true, agentIds: [lead], executionMachineId: null,
      data: { ...part.data as object, id: key, title: `Old ${i}`, agentIds: [lead], leadId: lead, assignment: null, dormant: true } } as Prisma.SwarmGroupCreateManyInput
  })
  for (let i = 0; i < rows.length; i += 200) await db.swarmGroup.createMany({ data: rows.slice(i, i + 200) })
  return { store, tab, execute, lead, worker, group, harness }
}

/** The SwarmGroup rows Mongo returned for [run], whichever read asked. */
async function groupsRead(run: () => Promise<unknown>): Promise<number> {
  await db.$runCommandRaw({ profile: 2 })
  await run()
  await db.$runCommandRaw({ profile: 0 })
  const found = await db.$runCommandRaw({ find: 'system.profile', filter: { ns: { $regex: '\\.SwarmGroup$' } }, projection: { nreturned: 1 }, batchSize: 100000 }) as
    unknown as { cursor: { firstBatch: Array<{ nreturned?: number }> } }
  await db.$runCommandRaw({ drop: 'system.profile' })
  return found.cursor.firstBatch.reduce((sum, row) => sum + (row.nreturned ?? 0), 0)
}

const FEW = 100

describe('a refused command in the log', () => {
  const secret = 'do-not-log-this'
  it('writes one line, its code and type and no values; one that passes writes none (Ken, 2026-11-04)', async () => {
    const { execute, tab } = await swarm()
    const said = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    try {
      await execute({ type: 'conversation.create', title: secret, brief: secret, checks: [] })
      expect(said.mock.calls.filter(([line]) => line === REFUSED)).toEqual([])
      await expect(execute({ type: 'conversation.rename', conversationId: secret, title: secret })).rejects.toMatchObject({ code: 'NOT_FOUND' })
      // And whose (#2675): its Swarm, no agent, and no declared client; never its words.
      expect(said.mock.calls.filter(([line]) => line === REFUSED)).toEqual([[REFUSED, { code: 'NOT_FOUND', type: 'conversation.rename',
        tabId: tab, agentId: null, asAgent: false, client: 'other', version: null }]])
      expect(JSON.stringify(said.mock.calls)).not.toContain(secret)
    } finally {
      said.mockRestore()
    }
  })
})

describe('a refused command from an agent, in the log (#2675)', () => {
  it('names the agent the command names, that an agent sent it, and the client and version it declared', async () => {
    const { store, tab, lead } = await swarm()
    const said = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    try {
      await expect(store.execute(owner, tab, { operationId: randomUUID(), command: { type: 'agent.alert', agentId: 'gone-agent', alert: 'prompt', active: true } },
        lead, undefined, { kind: 'cli', version: '0.5.34' })).rejects.toBeTruthy()
      expect(said.mock.calls.filter(([line]) => line === REFUSED)).toEqual([[REFUSED, expect.objectContaining({ type: 'agent.alert', tabId: tab,
        agentId: 'gone-agent', asAgent: true, client: 'cli', version: '0.5.34' })]])
    } finally {
      said.mockRestore()
    }
  })
})

describe('a command naming the coordinator', () => {
  it('agent.alert reads none of its 1,000 dormant groups, and its row still lands', async () => {
    const f = await swarm(1000)
    const read = await groupsRead(() => f.execute({ type: 'agent.alert', agentId: f.lead, alert: 'prompt', active: true }, f.lead))
    expect(read).toBeLessThan(FEW)
    const row = (await db.superTabMessage.findMany({ where: { tabId: f.tab } })).find(m => (m.source as { kind?: string } | null)?.kind === 'terminal-alert')
    expect(row?.conversationId).toBe('lead')
  })

  it('agent.rebind reads none of them', async () => {
    const f = await swarm(1000)
    const read = await groupsRead(() => f.execute({ type: 'agent.rebind', agentId: f.lead, machineId: 'mac', projectId: 'lead', harnessId: randomUUID(), previousHarnessId: f.harness.lead, configuration: config } as Command, f.lead))
    expect(read).toBeLessThan(FEW)
  })

  it('agent.input reads none of them, and its terminal stays closed to another agent', async () => {
    const f = await swarm(1000)
    let refused: unknown
    const read = await groupsRead(() => f.execute({ type: 'agent.input', agentId: f.lead, text: 'hello' } as Command, f.worker).catch(error => { refused = error }))
    expect(read).toBeLessThan(FEW)
    expect(refused).toMatchObject({ code: expect.stringMatching(/TERMINAL_PRIVATE|FORBIDDEN|CONFIDENTIAL/) })
  })
})

describe('what still reads an agent\'s dormant groups', () => {
  it('a worker\'s alert finds its only group, asleep', async () => {
    const f = await swarm()
    const part = await db.swarmGroup.findFirstOrThrow({ where: { tabId: f.tab, key: f.group } })
    await db.swarmGroup.update({ where: { id: part.id }, data: { dormant: true, data: { ...part.data as object, dormant: true } } })
    await f.execute({ type: 'agent.alert', agentId: f.worker, alert: 'prompt', active: true }, f.worker)
    const row = (await db.superTabMessage.findMany({ where: { tabId: f.tab } })).find(m => (m.source as { kind?: string } | null)?.kind === 'terminal-alert')
    expect(row?.conversationId).toBe(f.group)
  })

  it('removing a worker takes it out of a dormant group too', async () => {
    const f = await swarm()
    const part = await db.swarmGroup.findFirstOrThrow({ where: { tabId: f.tab, key: f.group } })
    await db.swarmGroup.update({ where: { id: part.id }, data: { dormant: true, data: { ...part.data as object, dormant: true } } })
    await f.execute({ type: 'agent.remove', agentId: f.worker })
    const after = await db.swarmGroup.findFirstOrThrow({ where: { tabId: f.tab, key: f.group } })
    expect((after.data as unknown as Conversation).agentIds).not.toContain(f.worker)
    expect(after.agentIds).not.toContain(f.worker)
  })
})
