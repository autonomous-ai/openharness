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
import type { AgentConfiguration } from '../src/superTabs/model.js'
import { SwarmReads } from '../src/superTabs/read/service.js'
import { poolRows } from './hostRows.test-support.js'

// Scholes, 2026-10-30: the sidebar's Models listed "Codex, model not reported". End to end through the store and the
// leaderboard read the sidebar shows: a Codex agent its host starts on Codex's own model, work assigned to it, and the row it
// counts under. A fresh loopback replica set, created here.
let replica: MongoMemoryReplSet
let db: PrismaClient
const owner: AuthUser = { sub: '310000000000000000000001', email: 'owner@example.com', autonomousEnv: 'prod', role: 'user' }
const lead = { engine: 'claude', model: 'opus', effort: 'high', contextWindow: 200000, engineVersion: 'fixture' }
/** What a Codex agent at its own default joins with: no model yet. */
const joined: AgentConfiguration = { engine: 'codex', model: null, effort: null, contextWindow: null, engineVersion: '0.165.0' }
const reading: AgentConfiguration = { ...joined, model: 'gpt-6.1-sol', effort: 'auto' }

beforeAll(async () => {
  replica = await MongoMemoryReplSet.create({ binary: { version: '7.0.24', downloadDir: join(tmpdir(), 'harness-super-tab-mongodb-binaries') },
    replSet: { count: 1, ip: '127.0.0.1', storageEngine: 'wiredTiger' } })
  const uri = replica.getUri(`swarm_attempt_models_test_${randomUUID().replaceAll('-', '_')}`)
  await promisify(execFile)(join(process.cwd(), 'node_modules/.bin/prisma'), ['db', 'push', '--skip-generate'], {
    env: { ...process.env, DATABASE_URL: uri }, timeout: 60000,
  })
  db = new PrismaClient({ datasources: { db: { url: uri } } })
  await db.user.create({ data: { id: owner.sub, externalId: `fixture-${owner.sub}`, email: owner.email, autonomousEnv: 'prod' } })
  await db.machine.create({ data: { machineId: 'owner-mac', userId: owner.sub, apiKey: 'fixture-owner-mac', managerId: 'fixture', autonomousEnv: 'prod', authMode: 'remote' } })
})
afterAll(async () => {
  await db?.$disconnect()
  await replica?.stop()
})

/** A Swarm whose owner's Mac runs Codex agents for it, each started by that Mac's host. */
async function swarm() {
  const store = new SuperTabStore(db)
  const reads = new SwarmReads(store)
  const tab = (await store.create(owner, randomUUID(), 'Models', 'public')).id
  const execute = (command: Command, asAgentId?: string, hostMachineId?: string) =>
    store.execute(owner, tab, { operationId: randomUUID(), command }, asAgentId, hostMachineId)
  await execute({ type: 'agent.add', conversationId: 'lead', machineId: 'owner-mac', harnessId: randomUUID(), name: 'PM', configuration: lead, lead: true })
  await execute({ type: 'machine.contribute', machineId: 'owner-mac', name: 'Owner Mac', cwd: '/swarm', scope: 'swarm', engines: ['claude', 'codex'], maxAgents: 4 })
  const generation = (await poolRows(store, owner, 'owner-mac')).find(p => p.tabId === tab)!.machine.generation
  await store.observeMachine(owner, tab, 'owner-mac', { generation, resources: { cpuPercent: 10, memoryTotalBytes: 64e9, memoryUsedBytes: 4e9,
    diskFreeBytes: 120e9, diskTotalBytes: 500e9, projectDiskFreeBytes: 120e9, deviceType: 'Desktop', chip: 'Fixture', os: 'macOS', gpuPercent: null },
  quotas: [], tools: { git: true }, runningHarnessIds: [], stoppedHarnessIds: [] })
  /** A task with a Codex agent on its own model started for it by the host, which settles it with [settled] or nothing. */
  const task = async (title: string, settled?: AgentConfiguration) => {
    const group = String((await execute({ type: 'conversation.create', title, brief: 'Build it.', checks: [{ description: 'Tests pass.', independent: false }] }))
      .result.conversationId)
    const request = { conversationId: group, machineId: 'owner-mac', engine: 'codex', name: 'Builder', cwd: '/swarm/lead', worktree: false,
      requirements: { memoryBytes: 1e9, diskBytes: 1e9, maxCpuPercent: 90, tools: ['git'], devices: [], quotaRequired: false } }
    const startId = String((await execute({ type: 'agent.start', request })).result.startId)
    const host = (command: Command) => execute(command, undefined, 'owner-mac')
    await host({ type: 'agent.startDispatch', startId })
    const agentId = String((await host({ type: 'agent.started', startId, harnessId: randomUUID(), configuration: joined })).result.agentId)
    await host({ type: 'agent.startSettled', startId, warning: null, ...(settled ? { configuration: settled } : {}) })
    const assignmentId = String((await execute({ type: 'work.assign', conversationId: group, agentId })).result.assignmentId)
    return { group, agentId, assignmentId }
  }
  const models = async () => (await reads.leaderboard(owner, tab, 'lead')).recentModels.map(m => [m.engine, m.model, m.attempts])
  return { store, tab, execute, task, models }
}

describe('the model each attempt ran on, as the sidebar\'s Models reads it', () => {
  it('names a Codex agent\'s model from its start\'s settle, before its first report', async () => {
    const f = await swarm()
    await f.task('Settled with its model', reading)
    expect(await f.models()).toEqual([['codex', 'gpt-6.1-sol', 1]])
  })

  it('names it once the agent first reports it, though its work ended before, and keeps it through a later report', async () => {
    const f = await swarm()
    const { group, agentId, assignmentId } = await f.task('Settled without a model')
    expect(await f.models()).toEqual([['codex', null, 1]])
    await f.execute({ type: 'work.cancel', conversationId: group, assignmentId, reason: 'Not needed any more.' })
    const report = async (configuration: AgentConfiguration) => {
      const agent = (await f.store.read(owner, f.tab)).state.agents.find(a => a.id === agentId)!
      await f.execute({ type: 'agent.configuration', previousVersion: agent.configurationVersion ?? null, configuration }, agentId)
    }
    await report(reading)
    expect(await f.models()).toEqual([['codex', 'gpt-6.1-sol', 1]])
    await report({ ...reading, model: 'gpt-6.1-luna' })
    expect(await f.models()).toEqual([['codex', 'gpt-6.1-sol', 1]])
  })
})
