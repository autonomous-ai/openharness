import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { PrismaClient } from '@prisma/client'
import { MongoMemoryReplSet } from 'mongodb-memory-server-core'
import type { AuthUser } from '../../lib/ssoAuth.js'
import { SuperTabStore } from '../store.js'
import { commandSchema } from '../commands.js'
import { SwarmReads } from '../read/service.js'
import { HostReads } from '../read/host.js'

// Catch a lost requester on proposal conversion, a missing approval gate, or a join that
// needs separate machine admission. Only the CLI launch itself is represented by host commands.
let db: PrismaClient, replica: MongoMemoryReplSet
const owner: AuthUser = { sub: '590000000000000000000001', email: 'owner@example.test', autonomousEnv: 'prod', role: 'user' }
const member: AuthUser = { sub: '590000000000000000000002', email: 'member@example.test', autonomousEnv: 'prod', role: 'user' }
const configuration = { engine: 'codex', model: 'fixture', effort: 'high', contextWindow: 200000, engineVersion: 'fixture' }
beforeAll(async () => {
  replica = await MongoMemoryReplSet.create({ binary: { version: '7.0.24', downloadDir: join(tmpdir(), 'harness-super-tab-mongodb-binaries') },
    replSet: { count: 1, ip: '127.0.0.1', storageEngine: 'wiredTiger' } })
  const uri = replica.getUri(`swarm_v3_acceptance_${randomUUID().replaceAll('-', '_')}`)
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

it.each(['autoApprove', 'review'] as const)('new member → Buddy → PM proposal → personal Tasks (%s)', async mode => {
  const store = new SuperTabStore(db, Date.now, null, { readCache: null }), reads = new SwarmReads(store)
  const tab = (await store.create(owner, randomUUID(), 'Acceptance', 'public')).id
  const execute = (command: unknown, user = owner, asAgentId?: string, hostMachineId?: string) =>
    store.execute(user, tab, { operationId: randomUUID(), command: commandSchema.parse(command) }, asAgentId, hostMachineId)
  const invite = await execute({ type: 'invite.create', email: member.email, role: 'collaborator', conversationId: 'lead' })
  await execute({ type: 'invite.accept', inviteId: invite.result.inviteId }, member)
  expect((await store.read(member, tab)).state.people).toContainEqual(expect.objectContaining({ id: member.sub, role: 'collaborator' }))
  expect((await reads.firstLoad(member, tab)).personalTasks).toMatchObject({ approvalMode: 'autoApprove', upserts: [] })
  const pm = String((await execute({ type: 'agent.add', conversationId: 'lead', machineId: owner.sub, harnessId: randomUUID(), name: 'PM', configuration, lead: true })).result.agentId)

  // The member has a computer in Harness, but it has never been contributed to this Swarm.
  const added = await execute({ type: 'buddy.create', machineId: member.sub, engine: 'codex',
    setup: { name: 'Member computer', cwd: '/fixture', engines: ['codex'] } }, member)
  const running: string[] = []
  const host = (command: unknown) => execute(command, member, undefined, member.sub)
  const report = async () => {
    const own = (await new HostReads(store).changes(member, member.sub, { full: true })).tabs.find(row => row.tabId === tab)
    if (!own || !('pool' in own) || !own.pool) throw new Error('The member computer has no host pool')
    const generation = own.pool.machine.generation
    await store.observeMachine(member, tab, member.sub, { generation, resources: { cpuPercent: 10, memoryTotalBytes: 32e9, memoryUsedBytes: 4e9,
      diskFreeBytes: 120e9, diskTotalBytes: 500e9, projectDiskFreeBytes: 120e9, deviceType: 'Laptop', chip: 'Fixture', os: 'macOS', gpuPercent: null },
    quotas: [], tools: {}, runningHarnessIds: [...running], stoppedHarnessIds: [], capabilities: ['buddySessions', 'swarmBuddy', 'regularAgent'] })
  }
  const launch = async (startId: string) => {
    await host({ type: 'agent.startDispatch', startId })
    const harnessId = randomUUID(); running.push(harnessId)
    const id = String((await host({ type: 'agent.started', startId, harnessId, configuration })).result.agentId)
    await host({ type: 'agent.startSettled', startId, warning: null })
    await report()
    return id
  }
  const buddy = await launch(String(added.result.startId)), chat = String(added.result.conversationId)
  expect((await store.read(member, tab)).state.agents).toContainEqual(expect.objectContaining({ id: buddy, buddyOf: expect.objectContaining({ personId: member.sub }) }))
  // + New agent admits work capacity as part of creating a Regular agent, after joining with the Buddy.
  await execute({ type: 'machine.contribute', machineId: member.sub, name: 'Member computer', cwd: '/fixture', scope: 'swarm', engines: ['codex'], maxAgents: 8 }, member)
  await report()
  const regular = await execute({ type: 'agent.new', kind: 'regular', name: 'Worker', machineId: member.sub, engine: 'codex' }, member)
  const worker = await launch(String(regular.result.startId))
  if (mode === 'review') await execute({ type: 'member.approvalMode', mode }, member)

  const propose = async (text: string) => {
    const ask = await execute({ type: 'message.send', conversationId: chat, text, recipientIds: [buddy], replyTo: null }, member)
    const sent = await execute({ type: 'buddy.propose', conversationId: chat, projectId: 'lead', ownerMessageId: ask.result.messageId,
      text, goal: text, scope: 'Keep drafts', priority: 'normal' }, member, buddy)
    const messageId = String(sent.result.messageId)
    expect((await store.deliveries(owner, tab, pm)).map(row => row.messageId)).toContain(messageId)
    return messageId
  }
  const convert = async (text: string) => {
    const proposalMessageId = await propose(text)
    return String((await execute({ type: 'conversation.create', title: text, priority: 'P2', proposalMessageId,
      task: { goal: text, changes: 'Keep drafts', constraints: 'No credential reads', owns: ['fixture/'] },
      checks: [{ description: 'Draft returns', independent: false }] }, owner, pm)).result.conversationId)
  }
  const task = await convert('Restore my draft')
  const row = async (id: string) => (await reads.firstLoad(member, tab)).personalTasks!.upserts.find(row => row.id === id)!
  expect(await row(task)).toMatchObject({ status: mode === 'review' ? 'proposal' : 'planned', canApprove: mode === 'review' })
  if (mode === 'review') {
    await execute({ type: 'task.suggest', conversationId: task, agentId: worker }, owner, pm)
    expect(await row(task)).toMatchObject({ status: 'proposal', canApprove: true, suggested: true, agent: { id: worker } })
    await expect(execute({ type: 'work.assign', conversationId: task, agentId: worker }, owner, pm)).rejects.toMatchObject({ code: 'TASK_APPROVAL_REQUIRED' })
    await expect(execute({ type: 'task.approve', conversationId: task }, owner, pm)).rejects.toMatchObject({ code: 'TASK_APPROVAL_FORBIDDEN' })
    const rejected = await convert('Another draft')
    await execute({ type: 'task.suggest', conversationId: rejected, agentId: worker }, owner, pm)
    await execute({ type: 'task.reject', conversationId: rejected, reason: 'Keep this for later' }, member)
    expect(await row(rejected)).toMatchObject({ status: 'rejected', canApprove: false, reason: 'Keep this for later' })
    await expect(execute({ type: 'work.assign', conversationId: rejected, agentId: worker }, owner, pm)).rejects.toMatchObject({ code: 'TASK_APPROVAL_REQUIRED' })
    await execute({ type: 'task.approve', conversationId: task }, member)
  }
  await execute({ type: 'work.assign', conversationId: task, agentId: worker }, owner, pm)
  expect(await row(task)).toMatchObject({ status: 'working', canApprove: false, agent: { id: worker } })

  expect((await reads.firstLoad(owner, tab)).personalTasks!.upserts).toEqual([])
})
