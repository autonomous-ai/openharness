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
import { poolRows } from './hostRows.test-support.js'
import type { PushOrigin } from '../src/github/pushOrigin.js'

// Task #3614: a start that names its task is assigned by the server when its agent is ready. Through the real store, the assignment
// is a work.assign in what it reads and records: who pushed the task's code (audit H2), the agent's run record. A fresh loopback
// replica set, created here.
let replica: MongoMemoryReplSet
let db: PrismaClient
const owner: AuthUser = { sub: '310000000000000000000001', email: 'owner@example.com', autonomousEnv: 'prod', role: 'user' }
const lead = { engine: 'claude', model: 'opus', effort: 'high', contextWindow: 200000, engineVersion: 'fixture' }
/** What a Codex agent at its own default joins with: no model yet. */
const joined: AgentConfiguration = { engine: 'claude', model: 'opus', effort: 'high', contextWindow: 200000, engineVersion: 'fixture' }

beforeAll(async () => {
  replica = await MongoMemoryReplSet.create({ binary: { version: '7.0.24', downloadDir: join(tmpdir(), 'harness-super-tab-mongodb-binaries') },
    replSet: { count: 1, ip: '127.0.0.1', storageEngine: 'wiredTiger' } })
  const uri = replica.getUri(`swarm_start_assign_test_${randomUUID().replaceAll('-', '_')}`)
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

/** A Swarm whose PM runs on the owner's Mac, which its host also starts agents on. [origin]: who GitHub says pushed the task's pull request. */
async function swarm(origin: PushOrigin = 'clean') {
  const store = new SuperTabStore(db, undefined, undefined, { pushOrigin: async () => origin })
  const tab = (await store.create(owner, randomUUID(), 'Assign', 'public')).id
  const execute = (command: Command, asAgentId?: string, hostMachineId?: string) =>
    store.execute(owner, tab, { operationId: randomUUID(), command }, asAgentId, hostMachineId)
  const pm = String((await execute({ type: 'agent.add', conversationId: 'lead', machineId: 'owner-mac', harnessId: randomUUID(), name: 'PM', configuration: lead, lead: true })).result.agentId)
  await execute({ type: 'machine.contribute', machineId: 'owner-mac', name: 'Owner Mac', cwd: '/swarm', scope: 'swarm', engines: ['claude', 'codex'], maxAgents: 4 })
  const generation = (await poolRows(store, owner, 'owner-mac')).find(p => p.tabId === tab)!.machine.generation
  await store.observeMachine(owner, tab, 'owner-mac', { generation, resources: { cpuPercent: 10, memoryTotalBytes: 64e9, memoryUsedBytes: 4e9,
    diskFreeBytes: 120e9, diskTotalBytes: 500e9, projectDiskFreeBytes: 120e9, deviceType: 'Desktop', chip: 'Fixture', os: 'macOS', gpuPercent: null },
  quotas: [], tools: { git: true }, runningHarnessIds: [], stoppedHarnessIds: [] })
  const host = (command: Command) => execute(command, undefined, 'owner-mac')
  /** The PM's start for a new task, with the host bringing the agent up. */
  const started = async (brief: string) => {
    const group = String((await execute({ type: 'conversation.create', title: 'Task', brief, checks: [{ description: 'Tests pass.', independent: false }], priority: 'P2', requesterId: owner.sub }, pm)).result.conversationId)
    const request = { conversationId: group, machineId: 'owner-mac', engine: 'claude', name: 'Builder', cwd: '/swarm/lead', worktree: false, assign: { message: 'Build it, then tell me.' },
      requirements: { memoryBytes: 1e9, diskBytes: 1e9, maxCpuPercent: 90, tools: ['git'], devices: [], quotaRequired: false } }
    const startId = String((await execute({ type: 'agent.start', request }, pm)).result.startId)
    await host({ type: 'agent.startDispatch', startId })
    const agentId = String((await host({ type: 'agent.started', startId, harnessId: randomUUID(), configuration: joined })).result.agentId)
    return { group, startId, agentId, settle: () => host({ type: 'agent.startSettled', startId, warning: null }) }
  }
  const assignment = async (group: string) => (await store.read(owner, tab)).state.conversations.find(c => c.id === group)?.assignment ?? null
  return { store, tab, started, assignment }
}

describe('a start that names its task, through the store', () => {
  it('assigns the agent when it settles, with its run record, as a work.assign would', async () => {
    const f = await swarm()
    const { group, agentId, settle } = await f.started('Build it.')
    expect(await f.assignment(group)).toBeNull()
    await settle()
    expect(await f.assignment(group)).toMatchObject({ agentId, status: 'working' })
    // The cross-Swarm busy lock a work.assign writes: this agent now owns this assignment (review of #3334).
    const run = await db.superTabRun.findUnique({ where: { id: agentId } })
    expect(run).toMatchObject({ tabId: f.tab, assignmentId: (await f.assignment(group))!.id })
    const brief = await db.superTabMessage.findMany({ where: { tabId: f.tab, conversationId: group, text: 'Build it, then tell me.' } })
    expect(brief).toHaveLength(1)
  })

  it('does not hand code a Team agent pushed to the main account\'s agent, which a work.assign refuses (audit H2)', async () => {
    const f = await swarm('team')
    const { group, settle } = await f.started('Continue the work in https://github.com/acme/app/pull/5.')
    await settle()
    expect(await f.assignment(group)).toBeNull()
    const told = await db.superTabMessage.findMany({ where: { tabId: f.tab, conversationId: group, text: { contains: 'could not be assigned' } } })
    expect(told).toHaveLength(1)
  })
})
