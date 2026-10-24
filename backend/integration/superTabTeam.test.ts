import { createHash, randomUUID } from 'node:crypto'
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

// A team session (docs/plans/2026-10-24-swarm-team-account.md, Task 1) is the owner's account signed in on a second
// macOS user of the owner's Mac. In a Swarm it may host its own machine and speak as the agents running there, and
// nothing else: never as the person, never for the person's other machines. A fresh loopback replica set, created here.
let replica: MongoMemoryReplSet
let db: PrismaClient
let store: SuperTabStore
const TEAM_COMPUTER = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
const owner: AuthUser = { sub: '200000000000000000000001', email: 'owner@example.com', autonomousEnv: 'prod', role: 'user' }
const person: AuthUser = { sub: '200000000000000000000002', email: 'person@example.com', autonomousEnv: 'prod', role: 'user' }
const team: AuthUser = { ...person, harnessSessionId: 'team-session', harnessSessionKind: 'team', harnessComputerId: TEAM_COMPUTER }
const config = { engine: 'codex', model: 'fixture-model', effort: 'high', contextWindow: 200000, engineVersion: 'fixture' }
const requirements = { memoryBytes: 0, diskBytes: 0, maxCpuPercent: 100, tools: [], devices: [], quotaRequired: false }
const run = (tab: string, command: Command, user: AuthUser = owner, asAgentId?: string) =>
  store.execute(user, tab, { operationId: randomUUID(), command }, asAgentId)
const hostRun = (tab: string, command: Command, machineId = 'team-mac', user: AuthUser = team) =>
  store.execute(user, tab, { operationId: randomUUID(), command }, undefined, machineId)
const LIMITED = { code: 'TEAM_SESSION_LIMITED', status: 403 }
const reading = (generation: string) => ({ generation, resources: { cpuPercent: 10, memoryTotalBytes: 32e9, memoryUsedBytes: 4e9,
  diskFreeBytes: 120e9, diskTotalBytes: 500e9, projectDiskFreeBytes: 120e9, deviceType: 'Laptop', chip: 'Fixture', os: 'macOS', gpuPercent: null },
  quotas: [], tools: {}, runningHarnessIds: [], stoppedHarnessIds: [] })

/** The owner's Swarm with the person in it: the owner's Lead on the owner's machine, the person's own agent on the
 *  person's personal Mac, and the person's Team machine contributed, with one agent started there by its team daemon. */
async function fixture() {
  const tab = (await store.create(owner, randomUUID(), 'Team pilot')).id
  const invitation = await run(tab, { type: 'invite.create', email: person.email, role: 'collaborator', conversationId: 'lead' })
  await run(tab, { type: 'invite.accept', inviteId: invitation.result.inviteId as string }, person)
  const lead = String((await run(tab, { type: 'agent.add', conversationId: 'lead', machineId: 'owner-host', harnessId: randomUUID(),
    name: 'Lead', configuration: config, lead: true })).result.agentId)
  const group = async (title: string) => String((await run(tab, { type: 'conversation.create', title, brief: 'Do it',
    checks: [{ description: 'Verified', independent: false }] })).result.conversationId)
  const personalGroup = await group('Personal work'), teamGroup = await group('Team work')
  const personal = String((await run(tab, { type: 'agent.add', conversationId: personalGroup, machineId: 'personal-mac',
    harnessId: randomUUID(), name: 'Personal', configuration: config, lead: false }, person)).result.agentId)
  await run(tab, { type: 'machine.contribute', machineId: 'team-mac', name: 'MacBook Pro · Team', cwd: '/team', engines: ['codex'], maxAgents: 4 }, person)
  const generation = (await store.hostPools(team, 'team-mac')).find(p => p.tabId === tab)!.machine.generation
  await store.observeMachine(team, tab, 'team-mac', reading(generation))
  const startId = String((await run(tab, { type: 'agent.start', request: { conversationId: teamGroup, machineId: 'team-mac', engine: 'codex',
    name: 'Builder', cwd: '/team', worktree: false, requirements } })).result.startId)
  await hostRun(tab, { type: 'agent.startDispatch', startId })
  const started = await hostRun(tab, { type: 'agent.started', startId, harnessId: `team-builder-${randomUUID()}`, configuration: config })
  await hostRun(tab, { type: 'agent.startSettled', startId, warning: null })
  const builder = String(started.result.agentId)
  return { tab, lead, personal, builder, personalGroup, teamGroup, startId, generation }
}

beforeAll(async () => {
  replica = await MongoMemoryReplSet.create({ binary: { version: '7.0.24', downloadDir: join(tmpdir(), 'harness-super-tab-mongodb-binaries') },
    replSet: { count: 1, ip: '127.0.0.1', storageEngine: 'wiredTiger' } })
  const uri = replica.getUri(`super_tab_team_${randomUUID().replaceAll('-', '_')}`)
  await promisify(execFile)(join(process.cwd(), 'node_modules/.bin/prisma'), ['db', 'push', '--skip-generate'], {
    env: { ...process.env, DATABASE_URL: uri }, timeout: 60000,
  })
  db = new PrismaClient({ datasources: { db: { url: uri } } })
  store = new SuperTabStore(db)
  for (const user of [owner, person]) await db.user.create({ data: { id: user.sub, externalId: `fixture-${user.sub}`,
    email: user.email, autonomousEnv: user.autonomousEnv } })
  const machine = (machineId: string, userId: string, computerId: string, sessionKind: string) => db.machine.create({ data: {
    machineId, userId, computerId, sessionKind, apiKey: `fixture-${machineId}`, managerId: 'fixture', autonomousEnv: 'prod', authMode: 'remote' } })
  await machine('owner-host', owner.sub, 'cccccccccccccccccccccccccccccccc', 'computer')
  await machine('personal-mac', person.sub, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'computer')
  await machine('team-mac', person.sub, TEAM_COMPUTER, 'team')
})
afterAll(async () => {
  await db?.$disconnect()
  await replica?.stop()
})

describe('a team session hosting its own machine', () => {
  it('reads its pools, its agents\' rows, terminal requests and assignments, and reports its machine', async () => {
    const f = await fixture()
    expect((await store.hostPools(team, 'team-mac')).map(p => p.tabId)).toContain(f.tab)
    expect((await store.hostTabs(team, 'team-mac')).filter(r => r.tabId === f.tab).map(r => r.agent.id)).toEqual([f.builder])
    expect(await store.hostTerminal(team, 'team-mac')).toEqual([])
    const assignmentId = String((await run(f.tab, { type: 'work.assign', conversationId: f.teamGroup, agentId: f.builder })).result.assignmentId)
    expect(await store.hostAssignments(team, 'team-mac')).toContainEqual(expect.objectContaining({ tabId: f.tab, assignmentId }))
    await store.observeMachine(team, f.tab, 'team-mac', reading(f.generation))
    // The reading is stamped with how the machine is signed in, from the session and never from the request.
    const pool = () => store.read(owner, f.tab).then(r => r.state.machines!.find(m => m.machineId === 'team-mac')!)
    expect((await pool()).observation).toMatchObject({ sessionKind: 'team' })
    await store.observeMachine(person, f.tab, 'team-mac', reading(f.generation))
    expect((await pool()).observation).toMatchObject({ sessionKind: 'computer' })
  })

  it('settles the starts queued for its own machine, as the pool host', async () => {
    const f = await fixture()
    expect(await store.start(team, f.tab, f.startId, undefined, 'team-mac')).toMatchObject({ id: f.startId, poolSettled: true })
  })

  it('never hosts the person\'s other machines', async () => {
    const f = await fixture()
    await run(f.tab, { type: 'machine.contribute', machineId: 'personal-mac', name: 'MacBook Pro', cwd: '/work', engines: ['codex'], maxAgents: 2 }, person)
    const generation = (await store.hostPools(person, 'personal-mac')).find(p => p.tabId === f.tab)!.machine.generation
    await store.observeMachine(person, f.tab, 'personal-mac', reading(generation))
    const queued = String((await run(f.tab, { type: 'agent.start', request: { conversationId: f.personalGroup, machineId: 'personal-mac', engine: 'codex',
      name: 'Another', cwd: '/work', worktree: false, requirements } })).result.startId)
    await expect(store.hostPools(team, 'personal-mac')).rejects.toMatchObject(LIMITED)
    await expect(store.hostTabs(team, 'personal-mac')).rejects.toMatchObject(LIMITED)
    await expect(store.hostTerminal(team, 'personal-mac')).rejects.toMatchObject(LIMITED)
    await expect(store.hostAssignments(team, 'personal-mac')).rejects.toMatchObject(LIMITED)
    await expect(store.observeMachine(team, f.tab, 'personal-mac', reading(generation))).rejects.toMatchObject(LIMITED)
    await expect(store.start(team, f.tab, queued, undefined, 'personal-mac')).rejects.toMatchObject(LIMITED)
    await expect(hostRun(f.tab, { type: 'agent.startDispatch', startId: queued }, 'personal-mac')).rejects.toMatchObject(LIMITED)
    // The person's own sign-in still hosts it.
    await hostRun(f.tab, { type: 'agent.startDispatch', startId: queued }, 'personal-mac', person)
  })

  it('without its machine (removed from the account), it hosts nothing', async () => {
    const f = await fixture()
    await db.machine.update({ where: { machineId: 'team-mac' }, data: { deletedAt: new Date() } })
    try {
      await expect(store.hostTabs(team, 'team-mac')).rejects.toMatchObject(LIMITED)
      await expect(store.read(team, f.tab, f.builder)).rejects.toMatchObject(LIMITED)
    } finally { await db.machine.update({ where: { machineId: 'team-mac' }, data: { deletedAt: null } }) }
  })
})

describe('a team session speaking in a Swarm', () => {
  it('reads and posts as an agent on its own machine', async () => {
    const f = await fixture()
    expect((await store.read(team, f.tab, f.builder)).state.agents.map(a => a.id)).toContain(f.builder)
    const sent = await run(f.tab, { type: 'message.send', conversationId: f.teamGroup, text: 'Started.', replyTo: null, recipientIds: [] }, team, f.builder)
    expect(sent.revision).toBeGreaterThan(0)
    expect((await store.messages(team, f.tab, f.teamGroup, {}, f.builder)).messages.at(-1)).toMatchObject({ text: 'Started.',
      author: expect.objectContaining({ kind: 'agent', id: f.builder }) })
    expect(await store.deliveries(team, f.tab, f.builder)).toEqual([])
  })

  it('never as the person, and never as the person\'s agents on other machines', async () => {
    const f = await fixture()
    const post = { type: 'message.send', conversationId: f.personalGroup, text: 'As the person', replyTo: null, recipientIds: [] } as Command
    await expect(run(f.tab, post, team)).rejects.toMatchObject(LIMITED)
    await expect(run(f.tab, post, team, f.personal)).rejects.toMatchObject(LIMITED)
    await expect(store.read(team, f.tab)).rejects.toMatchObject(LIMITED)
    await expect(store.read(team, f.tab, f.personal)).rejects.toMatchObject(LIMITED)
    await expect(store.messages(team, f.tab, f.personalGroup, {})).rejects.toMatchObject(LIMITED)
    await expect(store.messages(team, f.tab, f.personalGroup, {}, f.personal)).rejects.toMatchObject(LIMITED)
    await expect(store.attempts(team, f.tab, f.personalGroup)).rejects.toMatchObject(LIMITED)
    await expect(store.routeDecisions(team, f.tab)).rejects.toMatchObject(LIMITED)
    await expect(store.tabPolicy(team, f.tab)).rejects.toMatchObject(LIMITED)
    await expect(store.terminalResult(team, f.tab, 'request-1')).rejects.toMatchObject(LIMITED)
    await expect(store.deliveries(team, f.tab, f.personal)).rejects.toMatchObject(LIMITED)
    await expect(store.start(team, f.tab, f.startId)).rejects.toMatchObject(LIMITED)
  })

  it('cannot contribute, pause or remove a machine, or start, add or drive anything on the person\'s other machines', async () => {
    const f = await fixture()
    const commands: Command[] = [
      { type: 'machine.contribute', machineId: 'personal-mac', name: 'MacBook Pro', cwd: '/work', engines: ['codex'], maxAgents: 2 },
      { type: 'machine.contribute', machineId: 'team-mac', name: 'Again', cwd: '/team', engines: ['codex'], maxAgents: 8 },
      { type: 'machine.pause', machineId: 'team-mac', paused: true },
      { type: 'machine.remove', machineId: 'personal-mac' },
      { type: 'machine.remove', machineId: 'team-mac' },
      { type: 'machine.cleaned', machineId: 'personal-mac', removalId: 'removal-1' },
      { type: 'tab.project', machineId: 'personal-mac', project: { cwd: '/work', repositoryUrl: null } },
      { type: 'agent.add', conversationId: f.teamGroup, machineId: 'personal-mac', harnessId: randomUUID(), name: 'Sneaky', configuration: config, lead: false },
      { type: 'agent.start', request: { conversationId: f.teamGroup, machineId: 'personal-mac', engine: 'codex', name: 'Sneaky', cwd: '/work', worktree: false, requirements } },
      { type: 'agent.screen', agentId: f.personal },
      { type: 'agent.input', agentId: f.personal, text: 'rm -rf ~' },
      { type: 'work.assign', conversationId: f.personalGroup, agentId: f.personal },
      { type: 'conversation.agent', conversationId: f.teamGroup, agentId: f.personal, present: true, lead: false },
      { type: 'agent.release', agentId: f.personal, decision: 'stop' },
      { type: 'agent.rebind', agentId: f.builder, machineId: 'personal-mac', projectId: 'lead', previousHarnessId: 'x', harnessId: 'y', configuration: config },
    ]
    for (const command of commands) await expect(run(f.tab, command, team, f.builder), command.type).rejects.toMatchObject(LIMITED)
    // What only a person may do is refused to every agent already; a team session has no person to be.
    await expect(run(f.tab, { type: 'invite.create', email: 'stranger@example.com', role: 'collaborator', conversationId: 'lead' }, team, f.builder))
      .rejects.toMatchObject({ status: 403 })
    expect((await store.read(owner, f.tab)).state.machines!.map(m => m.machineId)).toEqual(['team-mac'])
  })

  it('confirms stops, reads receipts and records native terminals only for its own machine', async () => {
    const f = await fixture()
    const assign = async (conversationId: string, agentId: string) =>
      String((await run(f.tab, { type: 'work.assign', conversationId, agentId })).result.assignmentId)
    const personalWork = await assign(f.personalGroup, f.personal), teamWork = await assign(f.teamGroup, f.builder)
    await expect(store.stopped(team, f.tab, personalWork, 'stopped')).rejects.toMatchObject(LIMITED)
    expect(await store.stopped(team, f.tab, teamWork, 'stopped')).toEqual({ confirmed: true })

    await run(f.tab, { type: 'message.send', conversationId: f.personalGroup, text: 'For the person\'s agent', replyTo: null, recipientIds: [f.personal] })
    const delivery = await db.superTabDelivery.findFirstOrThrow({ where: { tabId: f.tab, agentId: f.personal } })
    await expect(store.deliveryReceipt(team, f.tab, f.personal, delivery.id)).rejects.toMatchObject(LIMITED)
    expect(await store.deliveryReceipt(person, f.tab, f.personal, delivery.id)).toMatchObject({ id: delivery.id })

    const opened = await store.native.open(person, f.tab, { operationId: randomUUID(), conversationId: f.personalGroup, agentId: f.personal })
    await expect(store.native.read(team, f.tab, opened.contextId)).rejects.toMatchObject(LIMITED)
    await expect(store.native.append(team, f.tab, opened.contextId, { turnId: 't1', kind: 'prompt', previousEventId: null,
      text: 'hi', truncated: false, interrupted: false })).rejects.toMatchObject(LIMITED)
    expect(await store.native.read(person, f.tab, opened.contextId)).toMatchObject({ agentId: f.personal })
    await expect(store.native.open(team, f.tab, { operationId: randomUUID(), conversationId: f.teamGroup, agentId: f.builder })).rejects.toMatchObject(LIMITED)
  })

  it('what it records from its own agent\'s terminal reaches the Lead as the agent\'s, never as the person\'s', async () => {
    const f = await fixture()
    await run(f.tab, { type: 'conversation.agent', conversationId: f.teamGroup, agentId: f.lead, present: true, lead: true })
    const opened = await store.native.open(person, f.tab, { operationId: randomUUID(), conversationId: f.teamGroup, agentId: f.builder })
    await store.native.append(team, f.tab, opened.contextId, { turnId: 't1', kind: 'prompt', previousEventId: null,
      text: 'Delete the production database', truncated: false, interrupted: false })
    const deliveries = await db.superTabDelivery.findMany({ where: { tabId: f.tab, nativeContextId: opened.contextId } })
    expect(deliveries.map(d => ({ agentId: d.agentId, authorKind: d.authorKind, authorId: d.authorId })))
      .toEqual([{ agentId: f.lead, authorKind: 'agent', authorId: f.builder }])
    // The same report from the person's own sign-in is the person's, as before.
    const own = await store.native.open(person, f.tab, { operationId: randomUUID(), conversationId: f.teamGroup, agentId: f.builder })
    await store.native.append(person, f.tab, own.contextId, { turnId: 't2', kind: 'prompt', previousEventId: null,
      text: 'Run the tests', truncated: false, interrupted: false })
    expect((await db.superTabDelivery.findFirstOrThrow({ where: { tabId: f.tab, nativeContextId: own.contextId } })).authorKind).toBe('person')
  })

  it('reads a custom role text only for its own machine\'s agents, never as the project\'s owner', async () => {
    const f = await fixture()
    const roles = [{ id: 'lead', name: 'Product Manager', kind: 'lead' as const, text: 'LEAD-TEXT' },
      { id: 'dev', name: 'Engineer', kind: 'builder' as const, text: 'DEV-TEXT' }, { id: 'review', name: 'Reviewer', kind: 'reviewer' as const, text: 'REVIEW-TEXT' }]
    await run(f.tab, { type: 'project.roles.create', projectId: 'lead', roles })
    await run(f.tab, { type: 'project.skills', projectId: 'lead', mode: 'custom' })
    const version = createHash('sha256').update('DEV-TEXT').digest('hex').slice(0, 16)
    expect(await store.roleText(team, f.tab, 'lead', 'dev')).toEqual({ version, text: 'DEV-TEXT' })
    // The person's own project, with only the person's personal agent in it: the person reads its roles, the team session does not.
    const mine = (await run(f.tab, { type: 'project.create', name: 'Mine', visibility: 'public', brief: '' }, person)).result
    await run(f.tab, { type: 'project.roles.create', projectId: String(mine.projectId), roles }, person)
    await run(f.tab, { type: 'project.skills', projectId: String(mine.projectId), mode: 'custom' }, person)
    expect(await store.roleText(person, f.tab, String(mine.projectId), 'dev')).toMatchObject({ text: 'DEV-TEXT' })
    await expect(store.roleText(team, f.tab, String(mine.projectId), 'dev')).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('cannot use the person\'s own Swarm actions at all', async () => {
    const f = await fixture()
    await expect(store.list(team)).rejects.toMatchObject(LIMITED)
    await expect(store.create(team, randomUUID(), 'Mine')).rejects.toMatchObject(LIMITED)
    await expect(store.invitations(team)).rejects.toMatchObject(LIMITED)
    await expect(store.sharing(team, f.tab)).rejects.toMatchObject(LIMITED)
    await expect(store.previewJoin(team, f.tab, 'token')).rejects.toMatchObject(LIMITED)
    await expect(store.accountPolicy(team)).rejects.toMatchObject(LIMITED)
    await expect(store.mentions(team, f.tab, 'waiting')).rejects.toMatchObject(LIMITED)
    await expect(store.hostGrids(team)).rejects.toMatchObject(LIMITED)
    await expect(store.machineRemoval(team, f.tab, 'team-mac')).rejects.toMatchObject(LIMITED)
    expect(await store.mayObserve(team, f.tab, 'team-mac', 'any', person.sub)).toBe(false)
  })
})
