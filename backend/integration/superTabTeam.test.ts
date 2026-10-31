import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterAll, beforeAll, describe, expect, it, onTestFinished, vi } from 'vitest'
import { MongoMemoryReplSet } from 'mongodb-memory-server-core'
import { PrismaClient } from '@prisma/client'
import type { AuthUser } from '../src/lib/ssoAuth.js'
import { SuperTabStore } from '../src/superTabs/store.js'
import { SwarmReads } from '../src/superTabs/read/service.js'
import type { Command } from '../src/superTabs/commands.js'
import type { ContributedMachine } from '../src/superTabs/machines.js'
import * as parts from '../src/superTabs/parts/index.js'
import { stableId, type SuperTabState } from '../src/superTabs/model.js'
import { roleVersion } from '../src/superTabs/projects.js'
import { assignmentRows, poolRows, rosterRows } from './hostRows.test-support.js'

// A team session (docs/plans/2026-10-24-swarm-team-account.md, Task 1) is the owner's account signed in on a second
// macOS user of the owner's Mac. In a Swarm it may host its own machine and speak as the agents running there, and
// nothing else: never as the person, never for the person's other machines. A fresh loopback replica set, created here.
let replica: MongoMemoryReplSet
let db: PrismaClient

/** A Swarm's whole state as its parts hold it (test helper: the store keeps no single document). */
async function storedState(tab: string): Promise<SuperTabState> {
  return parts.reassemble(await db.$transaction(tx => parts.loadAll(tx, tab)))
}
/** Replaces a Swarm's parts with `state`, as an older release would have left them. Versions keep rising. */
async function saveState(tab: string, state: SuperTabState) {
  await db.$transaction(async tx => {
    const current = await parts.loadAll(tx, tab)
    const version = Math.max(current.head.version, ...[...current.members, ...current.agents, ...current.groups, ...current.machines,
      ...current.starts, ...current.progress].map(p => p.version)) + 1
    for (const model of [tx.swarmHead, tx.swarmMember, tx.swarmAgent, tx.swarmGroup, tx.swarmMachine, tx.swarmStart, tx.swarmProgress] as unknown as
      Array<{ deleteMany(args: unknown): Promise<unknown> }>) await model.deleteMany({ where: { tabId: tab } })
    await parts.insertParts(tx, { ...parts.split(state, { tabId: tab, version, now: Date.now(), visibilityEpoch: current.visibilityEpoch }),
      sequenceBase: current.sequenceBase })
  })
}
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
/** What the team account's privacy check reports (cli/src/team/privacy.ts): passed, or the first item that failed. */
const PASSED = { mode: 'account', passed: true, checkedAt: Date.now() } as const
const FAILED = { mode: 'account', passed: false, item: 'gitconfig', detail: 'The team account could read ~/.gitconfig.', checkedAt: Date.now() } as const
/** A machine's reading. It always claims a privacy check; only a team session's claim is kept. */
const reading = (generation: string, privacy: Record<string, unknown> = PASSED) => ({ generation, resources: { cpuPercent: 10, memoryTotalBytes: 32e9, memoryUsedBytes: 4e9,
  diskFreeBytes: 120e9, diskTotalBytes: 500e9, projectDiskFreeBytes: 120e9, deviceType: 'Laptop', chip: 'Fixture', os: 'macOS', gpuPercent: null },
  quotas: [], tools: {}, runningHarnessIds: [], stoppedHarnessIds: [], privacy }) as Parameters<SuperTabStore['observeMachine']>[3]

/** The owner's Swarm with the person in it: the owner's Lead on the owner's machine, the person's own agent on the
 *  person's personal Mac in the person's own project, and the person's Team machine contributed, with one agent of the
 *  owner's project started there by its team daemon. */
async function fixture() {
  const tab = (await store.create(owner, randomUUID(), 'Team pilot')).id
  const invitation = await run(tab, { type: 'invite.create', email: person.email, role: 'collaborator', conversationId: 'lead' })
  await run(tab, { type: 'invite.accept', inviteId: invitation.result.inviteId as string }, person)
  const lead = String((await run(tab, { type: 'agent.add', conversationId: 'lead', machineId: 'owner-host', harnessId: randomUUID(),
    name: 'Lead', configuration: config, lead: true })).result.agentId)
  const group = async (title: string, projectId = 'lead', user = owner) => String((await run(tab, { type: 'conversation.create', projectId, title, brief: 'Do it',
    checks: [{ description: 'Verified', independent: false }] }, user)).result.conversationId)
  const own = String((await run(tab, { type: 'project.create', name: 'Own', visibility: 'public', brief: '' }, person)).result.projectId)
  const personalGroup = await group('Personal work', own, person), teamGroup = await group('Team work')
  const personal = String((await run(tab, { type: 'agent.add', conversationId: personalGroup, machineId: 'personal-mac',
    harnessId: randomUUID(), name: 'Personal', configuration: config, lead: false }, person)).result.agentId)
  await run(tab, { type: 'machine.contribute', machineId: 'team-mac', name: 'MacBook Pro · Team', cwd: '/team', engines: ['codex'], maxAgents: 4 }, person)
  const generation = (await poolRows(store, team, 'team-mac')).find(p => p.tabId === tab)!.machine.generation
  await store.observeMachine(team, tab, 'team-mac', reading(generation))
  const startId = String((await run(tab, { type: 'agent.start', request: { conversationId: teamGroup, machineId: 'team-mac', engine: 'codex',
    name: 'Builder', cwd: '/team', worktree: false, requirements } })).result.startId)
  await hostRun(tab, { type: 'agent.startDispatch', startId })
  const started = await hostRun(tab, { type: 'agent.started', startId, harnessId: `team-builder-${randomUUID()}`, configuration: config })
  await hostRun(tab, { type: 'agent.startSettled', startId, warning: null })
  const builder = String(started.result.agentId)
  return { tab, lead, personal, builder, personalGroup, teamGroup, startId, generation, own }
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
  await machine('personal-laptop', person.sub, 'dddddddddddddddddddddddddddddddd', 'computer')
  await machine('team-mac', person.sub, TEAM_COMPUTER, 'team')
})
afterAll(async () => {
  await db?.$disconnect()
  await replica?.stop()
})

describe('a team session hosting its own machine', () => {
  it('reads its pools, its agents\' rows, terminal requests and assignments, and reports its machine', async () => {
    const f = await fixture()
    expect((await poolRows(store, team, 'team-mac')).map(p => p.tabId)).toContain(f.tab)
    expect((await rosterRows(store, team, 'team-mac')).filter(r => r.tabId === f.tab).map(r => r.agent.id)).toEqual([f.builder])
    expect(await store.hostTerminal(team, 'team-mac')).toEqual([])
    const assignmentId = String((await run(f.tab, { type: 'work.assign', conversationId: f.teamGroup, agentId: f.builder })).result.assignmentId)
    expect(await assignmentRows(store, team, 'team-mac')).toContainEqual(expect.objectContaining({ tabId: f.tab, assignmentId }))
    await store.observeMachine(team, f.tab, 'team-mac', reading(f.generation))
    // The reading is stamped with how the machine is signed in, from the session and never from the request.
    const pool = () => store.read(owner, f.tab).then(r => r.state.machines!.find(m => m.machineId === 'team-mac')!)
    expect((await pool()).observation).toMatchObject({ sessionKind: 'team' })
    // The person's own sign-in may not report for it (security review 2 of #2089): only its team session hosts it.
    await expect(store.observeMachine(person, f.tab, 'team-mac', reading(f.generation))).rejects.toMatchObject({ code: 'TEAM_HOST_ONLY', status: 403 })
    expect((await pool()).observation).toMatchObject({ sessionKind: 'team' })
  })

  it('settles the starts queued for its own machine, as the pool host', async () => {
    const f = await fixture()
    expect(await store.start(team, f.tab, f.startId, undefined, 'team-mac')).toMatchObject({ id: f.startId, poolSettled: true })
  })

  it('never hosts the person\'s other machines', async () => {
    const f = await fixture()
    await run(f.tab, { type: 'machine.contribute', machineId: 'personal-mac', name: 'MacBook Pro', cwd: '/work', scope: 'swarm', engines: ['codex'], maxAgents: 2 }, person)
    const generation = (await poolRows(store, person, 'personal-mac')).find(p => p.tabId === f.tab)!.machine.generation
    await store.observeMachine(person, f.tab, 'personal-mac', reading(generation))
    const queued = String((await run(f.tab, { type: 'agent.start', request: { conversationId: f.personalGroup, machineId: 'personal-mac', engine: 'codex',
      name: 'Another', cwd: `/work/${f.own}`, worktree: false, requirements } }, person)).result.startId)
    await expect(poolRows(store, team, 'personal-mac')).rejects.toMatchObject(LIMITED)
    await expect(rosterRows(store, team, 'personal-mac')).rejects.toMatchObject(LIMITED)
    await expect(store.hostTerminal(team, 'personal-mac')).rejects.toMatchObject(LIMITED)
    await expect(assignmentRows(store, team, 'personal-mac')).rejects.toMatchObject(LIMITED)
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
      await expect(rosterRows(store, team, 'team-mac')).rejects.toMatchObject(LIMITED)
      await expect(store.read(team, f.tab, f.builder)).rejects.toMatchObject(LIMITED)
    } finally { await db.machine.update({ where: { machineId: 'team-mac' }, data: { deletedAt: null } }) }
  })
})

describe('a team session speaking in a Swarm', () => {
  it('reads and posts as an agent on its own machine', async () => {
    const f = await fixture()
    expect((await store.read(team, f.tab, f.builder)).state.agents.map(a => a.id)).toContain(f.builder)
    const sent = await run(f.tab, { type: 'message.send', conversationId: f.teamGroup, text: 'Started.', replyTo: null, recipientIds: [] }, team, f.builder)
    expect(sent.parts.length).toBeGreaterThan(0)
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

  // What reaches the coordinator from a terminal is a recording gap on the agent's task (native.ts turnRecipients; a typed
  // prompt names no one since project instructions, phase 4).
  it('what it records from its own agent\'s terminal reaches the Lead as the agent\'s, never as the person\'s', async () => {
    const f = await fixture()
    await run(f.tab, { type: 'conversation.agent', conversationId: f.teamGroup, agentId: f.lead, present: true, lead: true })
    await run(f.tab, { type: 'work.assign', conversationId: f.teamGroup, agentId: f.builder })
    const gap = (turnId: string, incidentId: string) => ({ turnId, kind: 'gap' as const, previousEventId: null, text: '', truncated: false,
      interrupted: false, gap: { incidentId, reason: 'recording_restarted' as const, detectedAt: Date.now() + 1000 } })
    const opened = await store.native.open(person, f.tab, { operationId: randomUUID(), conversationId: f.teamGroup, agentId: f.builder })
    await store.native.append(team, f.tab, opened.contextId, { turnId: 't0', kind: 'prompt', previousEventId: null,
      text: 'Delete the production database', truncated: false, interrupted: false })
    expect(await db.superTabDelivery.findMany({ where: { tabId: f.tab, nativeContextId: opened.contextId } })).toEqual([])
    const typed = await db.superTabNativeContext.findUniqueOrThrow({ where: { id: opened.contextId } })
    await store.native.append(team, f.tab, opened.contextId, { ...gap('t1', 'team-restart'), previousEventId: typed.lastEventId })
    const deliveries = await db.superTabDelivery.findMany({ where: { tabId: f.tab, nativeContextId: opened.contextId } })
    expect(deliveries.map(d => ({ agentId: d.agentId, authorKind: d.authorKind, authorId: d.authorId })))
      .toEqual([{ agentId: f.lead, authorKind: 'agent', authorId: f.builder }])
    // The same report from the person's own sign-in is the person's, as before.
    const own = await store.native.open(person, f.tab, { operationId: randomUUID(), conversationId: f.teamGroup, agentId: f.builder })
    await store.native.append(person, f.tab, own.contextId, gap('t2', 'own-restart'))
    expect((await db.superTabDelivery.findFirstOrThrow({ where: { tabId: f.tab, nativeContextId: own.contextId } })).authorKind).toBe('person')
  })

  it('gets a GitHub token only as an agent on its own machine, naming its own machine (Task 4)', async () => {
    const f = await fixture()
    await run(f.tab, { type: 'work.assign', conversationId: f.teamGroup, agentId: f.builder })
    await run(f.tab, { type: 'work.assign', conversationId: f.personalGroup, agentId: f.personal })
    expect(await store.githubAssignment(team, f.tab, f.builder, 'team-mac')).toMatchObject({ tabId: f.tab, agentId: f.builder })
    // As the person's agent on their personal Mac: refused before anything is read about the task.
    await expect(store.githubAssignment(team, f.tab, f.personal, 'personal-mac')).rejects.toMatchObject(LIMITED)
    await expect(store.githubAssignment(team, f.tab, f.personal, 'team-mac')).rejects.toMatchObject(LIMITED)
    // As its own agent, but naming another machine.
    await expect(store.githubAssignment(team, f.tab, f.builder, 'personal-mac')).rejects.toMatchObject({ status: 403 })
    // The person's own sign-in still gets one for the agent on their personal Mac.
    expect(await store.githubAssignment(person, f.tab, f.personal, 'personal-mac')).toMatchObject({ agentId: f.personal })
  })

  it('reads a custom role text only for its own machine\'s agents, never as the project\'s owner', async () => {
    const f = await fixture()
    const roles = [{ id: 'lead', name: 'Product Manager', kind: 'lead' as const, text: 'LEAD-TEXT' },
      { id: 'dev', name: 'Engineer', kind: 'builder' as const, text: 'DEV-TEXT' }, { id: 'review', name: 'Reviewer', kind: 'reviewer' as const, text: 'REVIEW-TEXT' }]
    /** The custom set an older client stored before project instructions, with its texts (role saves keep nothing now). */
    const seed = async (projectId: string) => {
      const state = await storedState(f.tab)
      Object.assign(state.projects!.find(p => p.id === projectId)!, { skillSet: 'custom', skillMode: 'default',
        roles: roles.map(({ text, ...role }) => ({ ...role, version: roleVersion(text) })) })
      await saveState(f.tab, state)
      for (const { id: roleId, text } of roles) await db.superTabRoleText.create({ data: { id: stableId(f.tab, projectId, roleId), tabId: f.tab, projectId, roleId,
        version: roleVersion(text), text } })
    }
    await seed('lead')
    const version = createHash('sha256').update('DEV-TEXT').digest('hex').slice(0, 16)
    expect(await store.roleText(team, f.tab, 'lead', 'dev')).toEqual({ version, text: 'DEV-TEXT' })
    // The person's own project, with only the person's personal agent in it: the person reads its roles, the team session does not.
    const mine = (await run(f.tab, { type: 'project.create', name: 'Mine', visibility: 'public', brief: '' }, person)).result
    await seed(String(mine.projectId))
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

// Teammates' work runs only on Team machines (Task 3): the owner's project on the person's machines needs the person's
// Harness Team account with its privacy check passed. The person's own projects run on the person's machines as before.
describe('a teammate\'s work and the machines that take it', () => {
  // With the rule required everywhere, as it will be once team accounts can be made (machines.ts teamAccountRequired).
  beforeAll(() => { process.env.SWARM_TEAM_ACCOUNT_REQUIRED = '1' })
  afterAll(() => { delete process.env.SWARM_TEAM_ACCOUNT_REQUIRED })
  /** The person's personal MacBook, contributed for every project, reporting from the person's own sign-in. */
  async function personalMac(f: Awaited<ReturnType<typeof fixture>>) {
    await run(f.tab, { type: 'machine.contribute', machineId: 'personal-mac', name: 'MacBook Pro', cwd: '/work', scope: 'swarm', engines: ['codex'], maxAgents: 2 }, person)
    const generation = (await poolRows(store, person, 'personal-mac')).find(p => p.tabId === f.tab)!.machine.generation
    await store.observeMachine(person, f.tab, 'personal-mac', reading(generation))
    return generation
  }
  /** A machine as a member reads it, with whether it takes teammates' projects now. */
  const pool = (tab: string, machineId: string, user: AuthUser = owner, at: SuperTabStore = store) => at.read(user, tab)
    .then(r => r.state.machines!.find(m => m.machineId === machineId)! as unknown as ContributedMachine & { teamWork: { allowed: boolean; code?: string; reason?: string } })
  /** A start of the owner's project's Builder, on the team machine (its contribution's folder) or a personal one. */
  const start = (tab: string, conversationId: string, machineId: string, user: AuthUser = owner, cwd = machineId === 'team-mac' ? '/team' : '/work/lead', at: SuperTabStore = store) =>
    at.execute(user, tab, { operationId: randomUUID(), command: { type: 'agent.start', request: { conversationId, machineId, engine: 'codex', name: 'Builder',
      cwd, worktree: false, requirements } } })
  const NO_TEAM_ACCOUNT = 'MacBook Pro has no Harness Team account yet, so it runs only its owner\'s projects.'

  it('keeps privacy only from the team account\'s own reading, and the read says which machines take teammates\' projects', async () => {
    const f = await fixture()
    await personalMac(f)
    expect((await pool(f.tab, 'team-mac')).observation!.privacy).toEqual({ ...PASSED, seenAt: expect.any(Number) })
    expect((await pool(f.tab, 'team-mac')).teamWork).toEqual({ allowed: true })
    // The person's own sign-in claimed the same check for its MacBook: an ordinary computer proves nothing about a team account.
    expect((await pool(f.tab, 'personal-mac')).observation).not.toHaveProperty('privacy')
    expect((await pool(f.tab, 'personal-mac')).teamWork).toEqual({ allowed: false, code: 'TEAM_ACCOUNT_REQUIRED', reason: NO_TEAM_ACCOUNT })
    // The same check sent again keeps the date it first arrived, so a check that stops running goes stale.
    const first = (await pool(f.tab, 'team-mac')).observation!.privacy!.seenAt
    await new Promise(resolve => setTimeout(resolve, 5))
    await store.observeMachine(team, f.tab, 'team-mac', reading(f.generation))
    expect((await pool(f.tab, 'team-mac')).observation!.privacy!.seenAt).toBe(first)
    // A failing check: every member reads the item, only its contributor reads the detail.
    await store.observeMachine(team, f.tab, 'team-mac', reading(f.generation, FAILED))
    expect((await pool(f.tab, 'team-mac', person)).observation!.privacy).toMatchObject({ item: 'gitconfig', detail: FAILED.detail })
    expect((await pool(f.tab, 'team-mac')).observation!.privacy).toEqual({ mode: 'account', passed: false, item: 'gitconfig', checkedAt: FAILED.checkedAt, seenAt: expect.any(Number) })
    expect((await pool(f.tab, 'team-mac')).teamWork).toMatchObject({ allowed: false, code: 'PRIVACY_CHECK_FAILED' })
    // The person's own sign-in may not report for the team machine at all (security review 2 of #2089).
    await expect(store.observeMachine(person, f.tab, 'team-mac', reading(f.generation))).rejects.toMatchObject({ code: 'TEAM_HOST_ONLY' })
  })

  it('refuses the owner\'s project on the person\'s personal Mac and admits it on their Team machine; the person\'s own work is unchanged', async () => {
    const f = await fixture()
    await personalMac(f)
    await expect(start(f.tab, f.teamGroup, 'personal-mac')).rejects.toMatchObject({ code: 'TEAM_ACCOUNT_REQUIRED', status: 403, message: NO_TEAM_ACCOUNT })
    expect((await start(f.tab, f.teamGroup, 'team-mac')).result.startId).toBeTruthy()
    expect((await start(f.tab, f.personalGroup, 'personal-mac', person, `/work/${f.own}`)).result.startId).toBeTruthy()
    // Off the Machines list nothing shows a privacy check, so the person's uncontributed laptop never takes the owner's project.
    await expect(start(f.tab, f.teamGroup, 'personal-laptop', person, '/work')).rejects.toMatchObject({ code: 'TEAM_ACCOUNT_REQUIRED' })
  })

  it('refuses it on a Team machine whose check failed, is missing or went stale', async () => {
    const f = await fixture()
    await store.observeMachine(team, f.tab, 'team-mac', reading(f.generation, FAILED))
    await expect(start(f.tab, f.teamGroup, 'team-mac')).rejects.toMatchObject({ code: 'PRIVACY_CHECK_FAILED',
      message: 'The Harness Team account on MacBook Pro · Team is not private (gitconfig: it could read its owner\'s ~/.gitconfig), so it runs only its owner\'s projects.' })
    // A reading with no check at all (the person's own sign-in may no longer report for it, security review 2 of #2089).
    const { privacy: _privacy, ...unchecked } = reading(f.generation) as Record<string, unknown>
    await store.observeMachine(team, f.tab, 'team-mac', unchecked as Parameters<SuperTabStore['observeMachine']>[3])
    await expect(start(f.tab, f.teamGroup, 'team-mac')).rejects.toMatchObject({ code: 'PRIVACY_UNCHECKED' })
    await store.observeMachine(team, f.tab, 'team-mac', reading(f.generation))
    // Twenty minutes on, the team daemon still sends the same check: it stopped running.
    const later = new SuperTabStore(db, () => Date.now() + 20 * 60_000)
    await later.observeMachine(team, f.tab, 'team-mac', reading(f.generation))
    await expect(start(f.tab, f.teamGroup, 'team-mac', owner, '/team', later)).rejects.toMatchObject({ code: 'PRIVACY_CHECK_STALE' })
    expect((await pool(f.tab, 'team-mac', owner, later)).teamWork.reason).toMatch(/^The privacy check on MacBook Pro · Team last passed 20 minutes ago/)
  })

  it('refuses work.assign of the owner\'s project to an agent on the person\'s personal Mac', async () => {
    const f = await fixture()
    await personalMac(f)
    // The person added an agent of theirs to the owner's project by hand.
    const volunteer = String((await run(f.tab, { type: 'agent.add', conversationId: f.teamGroup, machineId: 'personal-mac', harnessId: randomUUID(),
      name: 'Volunteer', configuration: config, lead: false }, person)).result.agentId)
    await expect(run(f.tab, { type: 'work.assign', conversationId: f.teamGroup, agentId: volunteer })).rejects.toMatchObject({ code: 'TEAM_ACCOUNT_REQUIRED', message: NO_TEAM_ACCOUNT })
    expect((await run(f.tab, { type: 'work.assign', conversationId: f.teamGroup, agentId: f.builder })).result.assignmentId).toBeTruthy()
    // The person's own project, to the person's own agent there, as before.
    expect((await run(f.tab, { type: 'work.assign', conversationId: f.personalGroup, agentId: f.personal }, person)).result.assignmentId).toBeTruthy()
  })

  // Joining a task by a post or by opening one checks team access as adding one does (spec, "Kept as access"; final review).
  it('refuses to add an agent on the person\'s personal Mac to the owner\'s task by naming it, by its own post or by its new task', async () => {
    const f = await fixture()
    await personalMac(f)
    // The person added an agent of theirs to the owner's project chat by hand: an agent of that project, in no task.
    const volunteer = String((await run(f.tab, { type: 'agent.add', conversationId: 'lead', machineId: 'personal-mac', harnessId: randomUUID(),
      name: 'Volunteer', configuration: config, lead: false }, person)).result.agentId)
    const post = (recipientIds: string[]) => ({ type: 'message.send', conversationId: f.teamGroup, text: 'Look at this.', replyTo: null, recipientIds }) as Command
    const refused = { code: 'TEAM_ACCOUNT_REQUIRED', message: NO_TEAM_ACCOUNT }
    await expect(run(f.tab, post([volunteer]), owner, f.lead)).rejects.toMatchObject(refused)
    await expect(run(f.tab, post([]), person, volunteer)).rejects.toMatchObject(refused)
    await expect(run(f.tab, { type: 'conversation.create', title: 'Its own task', brief: 'Do it', checks: [] }, person, volunteer)).rejects.toMatchObject(refused)
    const task = (await store.read(owner, f.tab)).state.conversations.find(c => c.id === f.teamGroup)!
    expect(task.agentIds).not.toContain(volunteer)
    // The agent on the person's Team machine is named into another task of the owner's project.
    const other = String((await run(f.tab, { type: 'conversation.create', title: 'Second', brief: 'Do it', checks: [] })).result.conversationId)
    await run(f.tab, { type: 'message.send', conversationId: other, text: 'Take a look.', replyTo: null, recipientIds: [f.builder] }, owner, f.lead)
    expect((await store.read(owner, f.tab)).state.conversations.find(c => c.id === other)!.agentIds).toContain(f.builder)
  })

  it('routes the owner\'s project around the machines that cannot take it, records why, and refuses a pick or reroute there', async () => {
    const f = await fixture()
    await personalMac(f)
    const volunteer = String((await run(f.tab, { type: 'agent.add', conversationId: f.teamGroup, machineId: 'personal-mac', harnessId: randomUUID(),
      name: 'Volunteer', configuration: config, lead: false }, person)).result.agentId)
    const candidate = (id: string, machineId: string, patch: Record<string, unknown> = {}) => ({ id, kind: 'new' as const, machineId, engine: 'codex' as const,
      model: 'default', effort: 'default', quality: 3, cost: 2, title: `Builder · ${machineId}`, label: `Codex on ${machineId}`, ...patch })
    const decision = (pick: string) => ({ assessment: { difficulty: 'medium' as const, risk: 'low' as const, why: 'A small change.' },
      candidates: [candidate('c0', 'team-mac'), candidate('c1', 'personal-mac'), candidate('c2', 'personal-mac', { kind: 'member', agentId: volunteer, title: 'Volunteer · personal-mac' })],
      excluded: [], floor: 2, notes: false, pick, via: 'order' as const, p: null, belowFloor: false, why: 'Policy order.' })
    const routed = await run(f.tab, { type: 'route.record', conversationId: f.teamGroup, decision: decision('c0') }, owner, f.lead)
    const recorded = await store.routeDecision(owner, f.tab, String(routed.result.routeDecisionId))
    expect(recorded.record.candidates.map(c => c.id)).toEqual(['c0'])
    expect(recorded.record.excluded).toEqual([{ title: 'Builder · personal-mac', reason: NO_TEAM_ACCOUNT }, { title: 'Volunteer · personal-mac', reason: NO_TEAM_ACCOUNT }])
    await expect(run(f.tab, { type: 'route.record', conversationId: f.teamGroup, decision: decision('c1') }, owner, f.lead))
      .rejects.toMatchObject({ code: 'TEAM_ACCOUNT_REQUIRED', message: `${NO_TEAM_ACCOUNT} Route again.` })
    // A person's reroute to a machine that stopped showing its privacy since the route.
    const both = await run(f.tab, { type: 'route.record', conversationId: f.teamGroup, decision: { ...decision('c1'), candidates: [candidate('c0', 'team-mac'), candidate('c1', 'owner-host')] } }, owner, f.lead)
    await store.observeMachine(team, f.tab, 'team-mac', reading(f.generation, FAILED))
    await expect(run(f.tab, { type: 'route.override', decisionId: String(both.result.routeDecisionId), candidateId: 'c0', reason: 'More quota there.' }))
      .rejects.toMatchObject({ code: 'PRIVACY_CHECK_FAILED' })
  })

  it('fails a queued start its Team machine will not take for good, and keeps one that waits on a stale check', async () => {
    const f = await fixture()
    const queued = String((await start(f.tab, f.teamGroup, 'team-mac')).result.startId)
    // The check failed before the team daemon launched it: the start fails with that reason, the group is told.
    await store.observeMachine(team, f.tab, 'team-mac', reading(f.generation, FAILED))
    await expect(hostRun(f.tab, { type: 'agent.startDispatch', startId: queued })).rejects.toMatchObject({ code: 'PRIVACY_CHECK_FAILED' })
    const failed = (await store.read(owner, f.tab)).state.starts!.find(s => s.id === queued)!
    expect(failed).toMatchObject({ dispatched: false, error: expect.stringContaining('is not private (gitconfig') })
    // The group reads a generic reason: the check's detail names the machine and files on it (review of #1847).
    expect((await store.messages(owner, f.tab, f.teamGroup, {})).messages.at(-1)!.text)
      .toBe('Could not start Builder: its machine could not prepare or launch it. Whoever started it, the Product Manager and the machine owner can read why.')
    expect((await poolRows(store, team, 'team-mac')).find(p => p.tabId === f.tab)!.starts.map(s => s.id)).not.toContain(queued)
    // A stale check may pass again by itself: that start keeps waiting for it.
    const passedAgain = { ...PASSED, checkedAt: Date.now() + 1 }
    await store.observeMachine(team, f.tab, 'team-mac', reading(f.generation, passedAgain))
    const waiting = String((await start(f.tab, f.teamGroup, 'team-mac')).result.startId)
    const later = new SuperTabStore(db, () => Date.now() + 20 * 60_000)
    await later.observeMachine(team, f.tab, 'team-mac', reading(f.generation, passedAgain))
    await expect(later.execute(team, f.tab, { operationId: randomUUID(), command: { type: 'agent.startDispatch', startId: waiting } }, undefined, 'team-mac'))
      .rejects.toMatchObject({ code: 'PRIVACY_CHECK_STALE' })
    expect((await store.read(owner, f.tab)).state.starts!.find(s => s.id === waiting)).toMatchObject({ dispatched: false, error: null })
  })

  it('never fails a start its host already launched when the dispatch is repeated after the check failed', async () => {
    const f = await fixture()
    const launched = String((await start(f.tab, f.teamGroup, 'team-mac')).result.startId)
    await hostRun(f.tab, { type: 'agent.startDispatch', startId: launched })
    await store.observeMachine(team, f.tab, 'team-mac', reading(f.generation, FAILED))
    await expect(hostRun(f.tab, { type: 'agent.startDispatch', startId: launched })).rejects.toMatchObject({ code: 'PRIVACY_CHECK_FAILED' })
    expect((await store.read(owner, f.tab)).state.starts!.find(s => s.id === launched)).toMatchObject({ dispatched: true, error: null })
    // Its agent still arrives.
    expect((await hostRun(f.tab, { type: 'agent.started', startId: launched, harnessId: `launched-${randomUUID()}`, configuration: config })).result.agentId).toBeTruthy()
  })

  it('leaves agents already working for the owner\'s project on a personal Mac running; only new work for them is refused', async () => {
    const f = await fixture()
    const generation = await personalMac(f)
    const old = String((await run(f.tab, { type: 'agent.add', conversationId: f.teamGroup, machineId: 'personal-mac', harnessId: 'before-release',
      name: 'Old', configuration: config, lead: false }, person)).result.agentId)
    // Its task was assigned by a release from before the rule: written into the stored Swarm as that release left it.
    const state = await storedState(f.tab)
    const work = state.conversations.find(c => c.id === f.teamGroup)!
    work.assignment = { id: 'assigned-before', agentId: old, status: 'working', configuration: config, result: null,
      execution: { machineId: 'personal-mac', harnessId: 'before-release', machineOwnerId: person.sub } }
    await saveState(f.tab, state)
    await db.superTabRun.create({ data: { id: old, tabId: f.tab, assignmentId: 'assigned-before', machineId: 'personal-mac', harnessId: 'before-release' } })

    await store.observeMachine(person, f.tab, 'personal-mac', reading(generation))
    expect((await rosterRows(store, person, 'personal-mac')).find(r => r.tabId === f.tab && r.agent.id === old)).toMatchObject({ stopRequested: false })
    expect(await assignmentRows(store, person, 'personal-mac')).toContainEqual({ tabId: f.tab, assignmentId: 'assigned-before', harnessId: 'before-release' })
    await run(f.tab, { type: 'work.status', conversationId: f.teamGroup, assignmentId: 'assigned-before', status: 'blocked', result: 'Needs a token.' }, person, old)
    await run(f.tab, { type: 'message.send', conversationId: f.teamGroup, text: 'Here it is.', replyTo: null, recipientIds: [old] })
    expect(await db.superTabDelivery.count({ where: { tabId: f.tab, agentId: old } })).toBeGreaterThan(0)
    await run(f.tab, { type: 'work.cancel', conversationId: f.teamGroup, assignmentId: 'assigned-before', reason: 'Moving it to the Team machine.' })
    await expect(run(f.tab, { type: 'work.assign', conversationId: f.teamGroup, agentId: old })).rejects.toMatchObject({ code: 'TEAM_ACCOUNT_REQUIRED' })
  })
})

// One machine (docs/plans/2026-10-24-swarm-team-account.md): the person's Mac and its Harness Team account are one
// machine. Its team account joins where the Mac is added, through the Mac's own daemon, and takes the teammates' work
// started on the Mac.
// A start records the CLI version its machine ran when it was dispatched, and reads say what the machine runs now, so routing
// lets a machine updated since its failed starts back in (cli routeCommand.ts `stalled`; Mac Auto, 2026-10-29).
describe('a machine\'s CLI version, on its starts and in reads', () => {
  it('stamps a start with the version its machine ran when dispatched, and reads show the version it runs now', async () => {
    await db.machine.update({ where: { machineId: 'team-mac' }, data: { clientVersion: '0.5.1' } })
    onTestFinished(async () => { await db.machine.update({ where: { machineId: 'team-mac' }, data: { clientVersion: null } }) })
    const f = await fixture()
    const read = async () => new SwarmReads(store).firstLoad(owner, f.tab)
    const first = await read()
    const dispatched = first.starts.map(p => p.data as { id: string; dispatchedVersion?: string }).find(s => s.id === f.startId)
    expect(dispatched?.dispatchedVersion).toBe('0.5.1')
    expect(first.derived.machines['team-mac']).toMatchObject({ clientVersion: '0.5.1' })
    await db.machine.update({ where: { machineId: 'team-mac' }, data: { clientVersion: '0.5.6' } })
    expect((await read()).derived.machines['team-mac']).toMatchObject({ clientVersion: '0.5.6' })
  })
})

describe('a project\'s repository, for its GitHub access', () => {
  it('is read by those who may open the project, and by nobody else', async () => {
    const f = await fixture()
    expect(await store.projectRepository(owner, f.tab, 'lead')).toEqual({ repositoryUrl: null, approvalRequired: false, name: expect.any(String),
      others: [{ id: expect.any(String), name: 'Own' }] })
    await run(f.tab, { type: 'tab.project', machineId: 'owner-host', project: { cwd: '/work', repositoryUrl: 'https://github.com/acme/app' } })
    expect(await store.projectRepository(owner, f.tab, 'lead')).toMatchObject({ repositoryUrl: 'https://github.com/acme/app' })
    expect(await store.projectRepository(person, f.tab, 'lead')).toMatchObject({ repositoryUrl: 'https://github.com/acme/app' })
    const secret = String((await run(f.tab, { type: 'project.create', name: 'Secret', visibility: 'private', brief: '' })).result.projectId)
    await expect(store.projectRepository(person, f.tab, secret)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(store.projectRepository(owner, f.tab, 'nope')).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

describe('one machine: a Mac and its Harness Team account', () => {
  it('with no GitHub App on the server, the team account is never asked to join', async () => {
    await db.machine.update({ where: { machineId: 'team-mac' }, data: { hostMachineId: 'personal-mac' } })
    try {
      const idle = new SuperTabStore(db, Date.now, null, { teamAccountsIdle: true })
      const tab = (await idle.create(owner, randomUUID(), 'No app')).id
      const invitation = await idle.execute(owner, tab, { operationId: randomUUID(), command: { type: 'invite.create', email: person.email, role: 'collaborator', conversationId: 'lead' } })
      await idle.execute(person, tab, { operationId: randomUUID(), command: { type: 'invite.accept', inviteId: invitation.result.inviteId as string } })
      await idle.execute(person, tab, { operationId: randomUUID(), command: { type: 'machine.contribute', machineId: 'personal-mac', name: 'MacBook Pro', cwd: '/work',
        scope: 'swarm', engines: ['codex'], maxAgents: 3 } })
      expect((await rosterRows(idle, person, 'personal-mac', { teamAccountsIdle: true })).some(r => r.tabId === tab && 'joinTeam' in r)).toBe(false)
      // The same Swarm on a server with the app asks the Mac's host to add it.
      expect((await rosterRows(store, person, 'personal-mac')).some(r => r.tabId === tab && 'joinTeam' in r)).toBe(true)
    } finally {
      await db.machine.update({ where: { machineId: 'team-mac' }, data: { hostMachineId: null } })
    }
  })

  // Tried in listed owners' Swarms only (machines.ts teamAccountSwarm, 2026-10-28): anyone else's Swarm never gets a team
  // account, and says so, so neither the Mac's daemon nor Desktop offers to set one up for it.
  it('joins only a Swarm the team account is tried in, and tells the others they use none', async () => {
    await db.machine.update({ where: { machineId: 'team-mac' }, data: { hostMachineId: 'personal-mac' } })
    onTestFinished(async () => {
      vi.unstubAllEnvs()
      await db.machine.update({ where: { machineId: 'team-mac' }, data: { hostMachineId: null } })
    })
    const tab = (await store.create(owner, randomUUID(), 'Elsewhere')).id
    const invitation = await run(tab, { type: 'invite.create', email: person.email, role: 'collaborator', conversationId: 'lead' })
    await run(tab, { type: 'invite.accept', inviteId: invitation.result.inviteId as string }, person)
    await run(tab, { type: 'machine.contribute', machineId: 'personal-mac', name: 'MacBook Pro', cwd: '/work', scope: 'swarm', engines: ['codex'], maxAgents: 3 }, person)
    const joins = async () => (await rosterRows(store, person, 'personal-mac')).some(r => r.tabId === tab && 'joinTeam' in r)
    const derived = async () => (await new SwarmReads(store).firstLoad(person, tab)).derived
    vi.stubEnv('SWARM_TEAM_ACCOUNT_OWNERS', 'someone@example.com')
    expect(await joins()).toBe(false)
    expect(await derived()).toMatchObject({ teamAccounts: false })
    vi.stubEnv('SWARM_TEAM_ACCOUNT_OWNERS', `someone@example.com,${owner.email.toUpperCase()}`)
    expect(await joins()).toBe(true)
    expect(await derived()).not.toHaveProperty('teamAccounts')
  })

  it('the Mac\'s host adds its team account, which then takes the owner\'s project started on the Mac', async () => {
    await db.machine.update({ where: { machineId: 'team-mac' }, data: { hostMachineId: 'personal-mac' } })
    try {
      const tab = (await store.create(owner, randomUUID(), 'One machine')).id
      const invitation = await run(tab, { type: 'invite.create', email: person.email, role: 'collaborator', conversationId: 'lead' })
      await run(tab, { type: 'invite.accept', inviteId: invitation.result.inviteId as string }, person)
      await run(tab, { type: 'machine.contribute', machineId: 'personal-mac', name: 'MacBook Pro', cwd: '/work', scope: 'swarm', engines: ['codex'], maxAgents: 3 }, person)
      const joins = async () => (await rosterRows(store, person, 'personal-mac')).filter(r => r.tabId === tab && 'joinTeam' in r)
      expect(await joins()).toEqual([{ tabId: tab, joinTeam: { machineId: 'team-mac', name: 'MacBook Pro', maxAgents: 3 } }])
      // The team account's own daemon is never asked, and cannot add itself.
      expect((await rosterRows(store, team, 'team-mac')).some(r => 'joinTeam' in r)).toBe(false)
      await expect(store.execute(team, tab, { operationId: randomUUID(), command: { type: 'machine.contribute', machineId: 'team-mac', name: 'x', cwd: '/team',
        scope: 'swarm', engines: ['codex'], maxAgents: 1, ifMissing: true } })).rejects.toMatchObject(LIMITED)
      // The Mac's host adds it, as the person: the backend gives it the Mac's name and slots, and the Mac it lives on.
      await run(tab, { type: 'machine.contribute', machineId: 'team-mac', name: 'MacBook Pro · Team', cwd: '/team', scope: 'swarm', engines: ['codex'],
        maxAgents: 1, ifMissing: true }, person)
      expect(await joins()).toEqual([])
      const listed = (await store.read(owner, tab)).state.machines!.find(m => m.machineId === 'team-mac')!
      expect(listed).toMatchObject({ hostMachineId: 'personal-mac', name: 'MacBook Pro', maxAgents: 3, cwd: '/team' })
      const generation = (await poolRows(store, team, 'team-mac')).find(p => p.tabId === tab)!.machine.generation
      await store.observeMachine(team, tab, 'team-mac', reading(generation))
      const group = String((await run(tab, { type: 'conversation.create', projectId: 'lead', title: 'Work', brief: 'Do it',
        checks: [{ description: 'Verified', independent: false }] })).result.conversationId)
      const started = await run(tab, { type: 'agent.start', request: { conversationId: group, machineId: 'personal-mac', engine: 'codex', name: 'Builder',
        cwd: '/work/lead', worktree: false, requirements } })
      const queued = (await poolRows(store, team, 'team-mac')).find(p => p.tabId === tab)!.starts
      expect(queued).toEqual([expect.objectContaining({ id: started.result.startId, request: expect.objectContaining({ machineId: 'team-mac', cwd: '/team/lead' }) })])
      expect((await poolRows(store, person, 'personal-mac')).find(p => p.tabId === tab)!.starts).toEqual([])
    } finally {
      await db.machine.update({ where: { machineId: 'team-mac' }, data: { hostMachineId: null } })
    }
  })

  // Diego's Mac, 2026-10-28: the Mac and its team account leave under one removal, and each host confirms its own cleanup
  // as the same person with the same operation (cli/src/superTabs/machines.ts runCleanup). The Mac's confirmation, second,
  // was refused as a reused operation on every retry, so the Mac stayed 'Cleaning up' for the day-long fallback.
  it('leaves with its team account once both hosts confirmed their cleanup, the team account first', async () => {
    await db.machine.update({ where: { machineId: 'team-mac' }, data: { hostMachineId: 'personal-mac' } })
    onTestFinished(() => db.machine.update({ where: { machineId: 'team-mac' }, data: { hostMachineId: null } }).then(() => undefined))
    const tab = (await store.create(owner, randomUUID(), 'Removed')).id
    const invitation = await run(tab, { type: 'invite.create', email: person.email, role: 'collaborator', conversationId: 'lead' })
    await run(tab, { type: 'invite.accept', inviteId: invitation.result.inviteId as string }, person)
    await run(tab, { type: 'machine.contribute', machineId: 'personal-mac', name: 'MacBook Pro', cwd: '/work', scope: 'swarm', engines: ['codex'], maxAgents: 3 }, person)
    await run(tab, { type: 'machine.contribute', machineId: 'team-mac', name: 'MacBook Pro · Team', cwd: '/team', scope: 'swarm', engines: ['codex'],
      maxAgents: 1, ifMissing: true }, person)
    // Both online, so both stay listed while their hosts clean up.
    for (const [user, machineId] of [[person, 'personal-mac'], [team, 'team-mac']] as const) {
      await store.observeMachine(user, tab, machineId, reading((await poolRows(store, user, machineId)).find(p => p.tabId === tab)!.machine.generation))
    }
    const removalId = String((await run(tab, { type: 'machine.remove', machineId: 'personal-mac' }, person)).result.removalId)
    const listed = async () => (await store.read(person, tab)).state.machines!.filter(m => ['personal-mac', 'team-mac'].includes(m.machineId))
      .map(m => [m.machineId, m.removal?.state])
    expect(await listed()).toEqual([['personal-mac', 'cleaning'], ['team-mac', 'cleaning']])
    const cleaned = (user: AuthUser, machineId: string) => store.execute(user, tab, { operationId: `machine-cleaned-${removalId}`,
      command: { type: 'machine.cleaned', machineId, removalId } })
    await cleaned(team, 'team-mac')
    expect(await listed()).toEqual([['personal-mac', 'cleaning']])
    await cleaned(person, 'personal-mac')
    expect(await listed()).toEqual([])
    // A host repeating its confirmation gets its own receipt back.
    await expect(cleaned(person, 'personal-mac')).resolves.toBeDefined()
    await expect(cleaned(team, 'team-mac')).resolves.toBeDefined()
    expect((await store.messages(person, tab, 'lead', {})).messages.filter(m => m.text.includes('left the Swarm')).map(m => m.text))
      .toEqual(['MacBook Pro left the Swarm: its host confirmed its cleanup.'])
  })

  it('leaves 30 minutes after its removal while its host keeps reporting without confirming, and the project\'s chat says why', async () => {
    let now = Date.now()
    const timed = new SuperTabStore(db, () => now)
    const tab = (await timed.create(owner, randomUUID(), 'Silent host')).id
    const invitation = await timed.execute(owner, tab, { operationId: randomUUID(), command: { type: 'invite.create', email: person.email, role: 'collaborator', conversationId: 'lead' } })
    await timed.execute(person, tab, { operationId: randomUUID(), command: { type: 'invite.accept', inviteId: invitation.result.inviteId as string } })
    await timed.execute(person, tab, { operationId: randomUUID(), command: { type: 'machine.contribute', machineId: 'personal-mac', name: 'MacBook Pro', cwd: '/work',
      scope: 'swarm', engines: ['codex'], maxAgents: 3 } })
    const generation = (await poolRows(timed, person, 'personal-mac')).find(p => p.tabId === tab)!.machine.generation
    const report = () => timed.observeMachine(person, tab, 'personal-mac', reading(generation))
    await report()
    const removalId = String((await timed.execute(person, tab, { operationId: randomUUID(), command: { type: 'machine.remove', machineId: 'personal-mac' } })).result.removalId)
    const listed = async () => (await storedState(tab)).machines?.map(m => m.machineId) ?? []
    const said = async () => (await timed.messages(owner, tab, 'lead', {})).messages.filter(m => m.text.includes('left the Swarm')).map(m => m.text)
    // It keeps reporting, fresh each time; nothing ends the removal until half an hour has passed.
    const removedAt = now
    for (let at = removedAt + 40_000; at < removedAt + 30 * 60_000; at += 40_000) {
      now = at
      await report()
    }
    now = removedAt + 30 * 60_000 - 1
    await report()
    expect(await listed()).toEqual(['personal-mac'])
    now = removedAt + 30 * 60_000
    await report()
    expect(await listed()).toEqual([])
    expect(await said()).toEqual(['MacBook Pro left the Swarm: its host did not confirm its cleanup within 30 minutes. It finishes the cleanup when it next connects.'])
    // Its cleanup still reaches its host, whose late confirmation closes it without another line.
    expect((await rosterRows(timed, person, 'personal-mac')).filter(r => r.tabId === tab && 'cleanup' in r)).toEqual([{ tabId: tab, cleanup: { machineId: 'personal-mac', removalId } }])
    await timed.execute(person, tab, { operationId: `machine-cleaned-${removalId}`, command: { type: 'machine.cleaned', machineId: 'personal-mac', removalId } })
    expect((await storedState(tab)).machineCleanups).toBeUndefined()
    expect(await said()).toHaveLength(1)
  })

  // Diego's Mac, 2026-10-28, after #1955: the Mac and its team account were removed together and went past the fallback
  // while their hosts kept reporting. Adding the Mac back said it was still cleaning up, and nothing finished it.
  it('a Mac and its team account past the fallback: each host is told its cleanup, both confirm, and the Mac is added again', async () => {
    await db.machine.update({ where: { machineId: 'team-mac' }, data: { hostMachineId: 'personal-mac' } })
    onTestFinished(() => db.machine.update({ where: { machineId: 'team-mac' }, data: { hostMachineId: null } }).then(() => undefined))
    let now = Date.now()
    const timed = new SuperTabStore(db, () => now)
    const exec = (user: AuthUser, tab: string, command: Command, operationId: string = randomUUID()) => timed.execute(user, tab, { operationId, command })
    const tab = (await timed.create(owner, randomUUID(), 'Removed together')).id
    const invitation = await exec(owner, tab, { type: 'invite.create', email: person.email, role: 'collaborator', conversationId: 'lead' })
    await exec(person, tab, { type: 'invite.accept', inviteId: invitation.result.inviteId as string })
    const addMac = () => exec(person, tab, { type: 'machine.contribute', machineId: 'personal-mac', name: 'MacBook Pro', cwd: '/work', scope: 'swarm', engines: ['codex'], maxAgents: 3 })
    await addMac()
    await exec(person, tab, { type: 'machine.contribute', machineId: 'team-mac', name: 'MacBook Pro · Team', cwd: '/team', scope: 'swarm', engines: ['codex'],
      maxAgents: 1, ifMissing: true })
    const hosts = [[person, 'personal-mac'], [team, 'team-mac']] as const
    const generations = new Map<string, string>()
    for (const [user, machineId] of hosts) generations.set(machineId, (await poolRows(timed, user, machineId)).find(p => p.tabId === tab)!.machine.generation)
    const report = async () => { for (const [user, machineId] of hosts) await timed.observeMachine(user, tab, machineId, reading(generations.get(machineId)!)).catch(() => null) }
    await report()
    await exec(person, tab, { type: 'machine.remove', machineId: 'personal-mac' })
    // Both hosts keep reporting and neither confirms, past the fallback.
    const removedAt = now
    for (let at = removedAt + 40_000; at <= removedAt + 31 * 60_000; at += 40_000) { now = at; await report() }
    expect((await storedState(tab)).machines?.map(m => m.machineId) ?? []).toEqual([])
    // Each host's feed names its own cleanup, and its confirmation, as cli/src/superTabs/machines.ts runCleanup sends it, clears it.
    for (const [user, machineId] of hosts) {
      const rows = (await rosterRows(timed, user, machineId)).filter(r => r.tabId === tab && 'cleanup' in r) as Array<{ cleanup: { machineId: string; removalId: string } }>
      expect(rows.map(r => r.cleanup.machineId)).toEqual([machineId])
      const { removalId } = rows[0]!.cleanup
      await exec(user, tab, { type: 'machine.cleaned', machineId, removalId }, `machine-cleaned-${removalId}`)
    }
    expect((await storedState(tab)).machineCleanups).toBeUndefined()
    await addMac()
    expect((await storedState(tab)).machines?.map(m => m.machineId)).toEqual(['personal-mac'])
  })

  // A cleanup's time is kept with it: lost, a fresh cleanup would read as overdue and let the add delete-race its host.
  it('keeps a fresh cleanup holding its owner\'s add until 30 minutes after the removal', async () => {
    let now = Date.now()
    const timed = new SuperTabStore(db, () => now)
    const exec = (user: AuthUser, tab: string, command: Command) => timed.execute(user, tab, { operationId: randomUUID(), command })
    const tab = (await timed.create(owner, randomUUID(), 'Fresh cleanup')).id
    const invitation = await exec(owner, tab, { type: 'invite.create', email: person.email, role: 'collaborator', conversationId: 'lead' })
    await exec(person, tab, { type: 'invite.accept', inviteId: invitation.result.inviteId as string })
    const add = () => exec(person, tab, { type: 'machine.contribute', machineId: 'personal-mac', name: 'MacBook Pro', cwd: '/work', scope: 'swarm', engines: ['codex'], maxAgents: 3 })
    await add()
    // Never reported, so offline: its records go at once and its cleanup waits for its host.
    await exec(person, tab, { type: 'machine.remove', machineId: 'personal-mac' })
    expect((await storedState(tab)).machineCleanups?.map(c => c.machineId)).toEqual(['personal-mac'])
    now += 30 * 60_000 - 1
    await expect(add()).rejects.toMatchObject({ code: 'MACHINE_CLEANING' })
    now += 1
    await add()
    expect((await storedState(tab)).machineCleanups).toBeUndefined()
  })

  // Ken's remote-deepseek and WIN-DELL, 2026-10-28: removed while offline, then their machine accounts were deleted. Their
  // cleanups waited for a host that could never come back, and kept the Swarm in every host's cleanup lookup.
  it('drops the cleanup of a machine whose account is deleted on the Swarm\'s next change, and keeps a live machine\'s', async () => {
    const tab = (await store.create(owner, randomUUID(), 'Retired machines')).id
    for (const [machineId, computerId] of [['retired-pc', 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'], ['kept-pc', 'ffffffffffffffffffffffffffffffff']]) {
      await db.machine.create({ data: { machineId, userId: owner.sub, computerId, sessionKind: 'computer', apiKey: `fixture-${machineId}`,
        managerId: 'fixture', autonomousEnv: 'prod', authMode: 'remote' } })
      onTestFinished(() => db.machine.delete({ where: { machineId } }).then(() => undefined))
      await run(tab, { type: 'machine.contribute', machineId, name: machineId, cwd: '/work', scope: 'swarm', engines: ['codex'], maxAgents: 1 })
      // Never reported, so offline: its records go at once and its cleanup waits for its host.
      await run(tab, { type: 'machine.remove', machineId })
    }
    const pending = async () => ({ cleanups: (await storedState(tab)).machineCleanups?.map(c => c.machineId).sort() ?? [],
      indexed: (await db.superTab.findUnique({ where: { id: tab } }))!.cleanupMachineIds.sort() })
    expect(await pending()).toEqual({ cleanups: ['kept-pc', 'retired-pc'], indexed: ['kept-pc', 'retired-pc'] })
    await db.machine.update({ where: { machineId: 'retired-pc' }, data: { deletedAt: new Date() } })
    await run(tab, { type: 'tab.rename', name: 'Next change' })
    expect(await pending()).toEqual({ cleanups: ['kept-pc'], indexed: ['kept-pc'] })
  })
})

// A project's Product Manager on another person's Team machine (leadStart.ts, Dee 10-29): on the machine its person names
// (Ken 10-29), launched from a list older hosts do not read, and the project's Lead once it runs.
describe('a project\'s Product Manager on a teammate\'s Team machine', () => {
  const capable = (generation: string) => ({ ...reading(generation), capabilities: ['leadStart'] }) as Parameters<SuperTabStore['observeMachine']>[3]

  it('needs a machine named, starts on the Team machine named, and leads the project', async () => {
    const f = await fixture()
    const created = (await run(f.tab, { type: 'project.create', name: 'App', visibility: 'private', brief: 'Build it.' })).result
    const projectId = String(created.projectId), home = String(created.conversationId)
    // Only its person knows which machine stays on: none is chosen for them.
    await expect(run(f.tab, { type: 'lead.start', projectId, machineId: null, engine: 'codex', repositoryUrl: 'https://github.com/example/app' }))
      .rejects.toMatchObject({ code: 'MACHINE_REQUIRED', status: 400 })
    expect((await poolRows(store, team, 'team-mac')).find(p => p.tabId === f.tab)!.leadStarts).toBeUndefined()
    // Contributed for every project, as a Mac added to a Swarm with projects is; the fixture's serves only the first. Its
    // Builder of that first project goes, so the account can serve this project alone.
    await run(f.tab, { type: 'machine.contribute', machineId: 'team-mac', name: 'MacBook Pro · Team', cwd: '/team', scope: 'swarm', engines: ['codex'], maxAgents: 4 }, person)
    await run(f.tab, { type: 'agent.remove', agentId: f.builder })
    const generation = (await poolRows(store, team, 'team-mac')).find(p => p.tabId === f.tab)!.machine.generation
    await store.observeMachine(team, f.tab, 'team-mac', capable(generation))
    await run(f.tab, { type: 'lead.start', projectId, machineId: 'team-mac', engine: 'codex', repositoryUrl: 'https://github.com/example/app' })
    const row = (await poolRows(store, team, 'team-mac')).find(p => p.tabId === f.tab)!
    expect(row.leadStarts).toEqual([expect.objectContaining({ request: expect.objectContaining({ machineId: 'team-mac', cwd: `/team/${projectId}`,
      leadFor: expect.objectContaining({ projectId, personId: owner.sub }) }) })])
    expect(row.starts.some(s => s.request.leadFor)).toBe(false)
    const startId = row.leadStarts![0]!.id
    await hostRun(f.tab, { type: 'agent.startDispatch', startId })
    const agentId = String((await hostRun(f.tab, { type: 'agent.started', startId, harnessId: `team-pm-${randomUUID()}`, configuration: config })).result.agentId)
    const read = await store.read(owner, f.tab)
    expect(read.state.conversations.find(c => c.id === home)).toMatchObject({ leadId: agentId })
    expect(read.state.projects!.find(p => p.id === projectId)!.lead).toMatchObject({ status: 'started', machineId: 'team-mac' })
    expect((await store.messages(owner, f.tab, home, {})).messages.map(m => m.text))
      .toEqual(expect.arrayContaining(['Product Manager started on MacBook Pro · Team.']))
  })

  // The isolated confidential run (docs/performance/2026-10-27-pm-confidential-isolated-run.test.mts), its Team machine case:
  // a Product Manager in another person's Team account, every way of watching or driving it through the Swarm.
  it('in another person\'s Team account: its project\'s owner only watches it, and the Mac\'s owner neither watches nor drives it', async () => {
    const f = await fixture()
    const created = (await run(f.tab, { type: 'project.create', name: 'App', visibility: 'public', brief: '' })).result
    const projectId = String(created.projectId)
    await run(f.tab, { type: 'machine.contribute', machineId: 'team-mac', name: 'MacBook Pro · Team', cwd: '/team', scope: 'swarm', engines: ['codex'], maxAgents: 4 }, person)
    const generation = (await poolRows(store, team, 'team-mac')).find(p => p.tabId === f.tab)!.machine.generation
    await store.observeMachine(team, f.tab, 'team-mac', capable(generation))
    // The fixture's own Builder of the owner's first project runs there: it goes first, so the account serves one project.
    await run(f.tab, { type: 'agent.remove', agentId: f.builder })
    const placed = await run(f.tab, { type: 'lead.start', projectId, machineId: 'team-mac', engine: 'codex', repositoryUrl: 'https://github.com/example/app' })
    const startId = String(placed.result.startId)
    await hostRun(f.tab, { type: 'agent.startDispatch', startId })
    const pm = String((await hostRun(f.tab, { type: 'agent.started', startId, harnessId: `team-pm-${randomUUID()}`, configuration: config })).result.agentId)
    const terminal = (user: AuthUser, command: Command) => run(f.tab, command, user).then(() => 'ok', (error: { code?: string }) => error.code)
    expect(await terminal(owner, { type: 'agent.screen', agentId: pm, scrollback: 50 })).toBe('ok')
    expect(await terminal(owner, { type: 'agent.input', agentId: pm, text: 'ls ~' })).toBe('TERMINAL_PRIVATE')
    expect(await terminal(person, { type: 'agent.screen', agentId: pm, scrollback: 50 })).toBe('TERMINAL_PRIVATE')
    expect(await terminal(person, { type: 'agent.input', agentId: pm, text: 'ls ~' })).toBe('TERMINAL_PRIVATE')
    // Its host's roster: confidential, watched by its project's owner alone, never by the Mac's owner.
    const row = (await rosterRows(store, team, 'team-mac')).find(r => r.tabId === f.tab && r.agent.id === pm)!
    expect(row).toMatchObject({ confidential: true })
    expect(row.observers.map((o: { email: string }) => o.email)).toEqual([owner.email])
    // Security review 2 of #2089: the Mac owner's own sign-in, ordinary tools, cannot act as the Team machine's host or as
    // its Product Manager: no reading the chats it reads, no claiming its deliveries, no posting as it.
    // People talk to the PM in its project's conversation (Chat with PM is closed on main): what it reads there, it reads.
    const chat = String(created.conversationId)
    await run(f.tab, { type: 'message.send', conversationId: chat, text: 'For the PM: the launch slips a week.', replyTo: null, recipientIds: [] })
    await expect(store.messages(person, f.tab, chat, {}, pm)).rejects.toMatchObject({ code: 'TEAM_HOST_ONLY', status: 403 })
    await expect(store.deliveries(person, f.tab, pm)).rejects.toMatchObject({ code: 'TEAM_HOST_ONLY', status: 403 })
    await expect(store.execute(person, f.tab, { operationId: randomUUID(), command: { type: 'message.send', conversationId: chat, text: 'as the PM',
      replyTo: null, recipientIds: [] } }, pm)).rejects.toMatchObject({ code: 'TEAM_HOST_ONLY', status: 403 })
    await expect(store.observeMachine(person, f.tab, 'team-mac', capable(generation))).rejects.toMatchObject({ code: 'TEAM_HOST_ONLY', status: 403 })
    // Its own team session still is its host.
    await expect(store.deliveries(team, f.tab, pm)).resolves.toBeInstanceOf(Array)
    // An ordinary sign-in connecting as the Team computer resets its account row's mark (lib/adapterWs.ts): the Swarm's own
    // record that it is a Team account still refuses the owner (security re-check 2 of #2089).
    await db.machine.update({ where: { machineId: 'team-mac' }, data: { sessionKind: 'computer' } })
    onTestFinished(async () => { await db.machine.update({ where: { machineId: 'team-mac' }, data: { sessionKind: 'team' } }) })
    await expect(store.messages(person, f.tab, chat, {}, pm)).rejects.toMatchObject({ code: 'TEAM_HOST_ONLY', status: 403 })
    await expect(store.deliveries(person, f.tab, pm)).rejects.toMatchObject({ code: 'TEAM_HOST_ONLY', status: 403 })
    await expect(store.observeMachine(person, f.tab, 'team-mac', capable(generation))).rejects.toMatchObject({ code: 'TEAM_HOST_ONLY', status: 403 })
    await expect(rosterRows(store, person, 'team-mac')).rejects.toMatchObject({ code: 'TEAM_HOST_ONLY', status: 403 })
    await db.machine.update({ where: { machineId: 'team-mac' }, data: { sessionKind: 'team' } })
    // And no other project's work starts there while it runs.
    await expect(run(f.tab, { type: 'agent.start', request: { conversationId: f.teamGroup, machineId: 'team-mac', engine: 'codex', name: 'Builder',
      cwd: '/team/lead', worktree: true, requirements } })).rejects.toMatchObject({ code: 'TEAM_ACCOUNT_HELD' })
  })

  // Review of #2142: the hold outlives its removal through the store's saves and loads, and only its host's confirmed close,
  // sent once its session data is deleted, releases it (commands.ts agent.sessionClosed).
  it('stays held for its project after its removal until its host confirms the close, across saves and loads', async () => {
    const f = await fixture()
    const projectId = String((await run(f.tab, { type: 'project.create', name: 'App', visibility: 'public', brief: '' })).result.projectId)
    await run(f.tab, { type: 'machine.contribute', machineId: 'team-mac', name: 'MacBook Pro · Team', cwd: '/team', scope: 'swarm', engines: ['codex'], maxAgents: 4 }, person)
    const generation = (await poolRows(store, team, 'team-mac')).find(p => p.tabId === f.tab)!.machine.generation
    await store.observeMachine(team, f.tab, 'team-mac', capable(generation))
    await run(f.tab, { type: 'agent.remove', agentId: f.builder })
    const startId = String((await run(f.tab, { type: 'lead.start', projectId, machineId: 'team-mac', engine: 'codex', repositoryUrl: 'https://github.com/example/app' })).result.startId)
    await hostRun(f.tab, { type: 'agent.startDispatch', startId })
    const harnessId = `team-pm-${randomUUID()}`
    const pm = String((await hostRun(f.tab, { type: 'agent.started', startId, harnessId, configuration: config })).result.agentId)
    await hostRun(f.tab, { type: 'agent.startSettled', startId, warning: null })
    // A Product Manager leaves with its project.
    await run(f.tab, { type: 'project.delete', projectId })
    const start = () => run(f.tab, { type: 'agent.start', request: { conversationId: f.teamGroup, machineId: 'team-mac', engine: 'codex', name: 'Builder',
      cwd: '/team/lead', worktree: true, requirements } }).then(() => 'started', (error: { code?: string }) => error.code)
    // Each command loads the Swarm from its stored parts: the hold is there each time.
    expect(await start()).toBe('TEAM_ACCOUNT_HELD')
    expect(await start()).toBe('TEAM_ACCOUNT_HELD')
    // No one else confirms it: not the Swarm's owner, nor anyone for another session.
    await expect(run(f.tab, { type: 'agent.sessionClosed', agentId: pm, harnessId })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(run(f.tab, { type: 'agent.sessionClosed', agentId: pm, harnessId: 'another' }, team)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(await start()).toBe('TEAM_ACCOUNT_HELD')
    // Nor the Mac's owner from an ordinary sign-in, which shares the Team session's person but is not its host, with no
    // purge run (both security reviews of 0a181c00c), even once that sign-in resets the account row's Team mark.
    const ordinary = () => run(f.tab, { type: 'agent.sessionClosed', agentId: pm, harnessId }, person).then(() => 'closed', (error: { code?: string }) => error.code)
    expect({ forged: await ordinary(), after: await start() }).toEqual({ forged: 'TEAM_HOST_ONLY', after: 'TEAM_ACCOUNT_HELD' })
    const row = (await db.machine.findFirst({ where: { machineId: 'team-mac' } }))!
    const restore = () => db.machine.update({ where: { machineId: 'team-mac' }, data: { sessionKind: row.sessionKind, hostMachineId: row.hostMachineId } })
    await db.machine.update({ where: { machineId: 'team-mac' }, data: { sessionKind: 'computer', hostMachineId: null } })
    onTestFinished(async () => { await restore() })
    expect({ forged: await ordinary(), after: await start() }).toEqual({ forged: 'TEAM_HOST_ONLY', after: 'TEAM_ACCOUNT_HELD' })
    await restore()
    await run(f.tab, { type: 'agent.sessionClosed', agentId: pm, harnessId }, team)
    expect(await start()).not.toBe('TEAM_ACCOUNT_HELD')
  })

  // Security review L3: a coordinator carries on its agents' starts (mayResumeStart), and its Team account's session, by its
  // Mac owner's grant, completed one on the owner's personal Mac with a session of its choosing, in the owner's own account.
  // Elsewhere it only fails another agent's start.
  it('completes only starts on its own machine; another agent\'s start elsewhere it only fails', async () => {
    const f = await fixture()
    const created = (await run(f.tab, { type: 'project.create', name: 'App', visibility: 'public', brief: '' })).result
    const projectId = String(created.projectId)
    await run(f.tab, { type: 'machine.contribute', machineId: 'team-mac', name: 'MacBook Pro · Team', cwd: '/team', scope: 'swarm', engines: ['codex'], maxAgents: 4 }, person)
    const generation = (await poolRows(store, team, 'team-mac')).find(p => p.tabId === f.tab)!.machine.generation
    await store.observeMachine(team, f.tab, 'team-mac', capable(generation))
    await run(f.tab, { type: 'agent.remove', agentId: f.builder })
    const placed = String((await run(f.tab, { type: 'lead.start', projectId, machineId: 'team-mac', engine: 'codex', repositoryUrl: 'https://github.com/example/app' })).result.startId)
    await hostRun(f.tab, { type: 'agent.startDispatch', startId: placed })
    const pm = String((await hostRun(f.tab, { type: 'agent.started', startId: placed, harnessId: `team-pm-${randomUUID()}`, configuration: config })).result.agentId)
    // The person's own agent of the project, on their personal Mac, starts another there: no contributed machine, so its
    // host completes it.
    const task = String((await run(f.tab, { type: 'conversation.create', projectId, title: 'Task', brief: 'Do it', checks: [] })).result.conversationId)
    const worker = String((await run(f.tab, { type: 'agent.add', conversationId: task, machineId: 'personal-mac', harnessId: randomUUID(), name: 'Worker',
      configuration: config, lead: false }, person)).result.agentId)
    const request = { conversationId: task, machineId: 'personal-mac', engine: 'codex', name: 'Helper', cwd: '/work', worktree: false, requirements }
    const startId = String((await run(f.tab, { type: 'agent.start', request }, person, worker)).result.startId)
    const session = `owner-session-${randomUUID()}`
    for (const command of [{ type: 'agent.startDispatch', startId }, { type: 'agent.started', startId, harnessId: session, configuration: config },
      { type: 'agent.startSettled', startId, warning: null }] as Command[]) {
      await expect(run(f.tab, command, team, pm), command.type).rejects.toMatchObject(LIMITED)
    }
    expect((await store.read(owner, f.tab)).state.agents.some(a => a.harnessId === session)).toBe(false)
    await expect(run(f.tab, { type: 'agent.startFailed', startId, error: 'Not started.' }, team, pm)).resolves.toBeDefined()
    await expect(run(f.tab, { type: 'agent.started', startId, harnessId: randomUUID(), configuration: config }, person, worker))
      .rejects.toMatchObject({ code: 'START_FAILED' })
  })

  it('on the teammate\'s personal Mac with no Team account, starts there, as its owner (Ken 10-29)', async () => {
    const f = await fixture()
    const projectId = String((await run(f.tab, { type: 'project.create', name: 'App', visibility: 'private', brief: '' })).result.projectId)
    await run(f.tab, { type: 'machine.contribute', machineId: 'personal-mac', name: 'MacBook Pro', cwd: '/work', scope: 'swarm', engines: ['codex'], maxAgents: 2 }, person)
    const generation = (await poolRows(store, person, 'personal-mac')).find(p => p.tabId === f.tab)!.machine.generation
    await store.observeMachine(person, f.tab, 'personal-mac', capable(generation))
    const placed = await run(f.tab, { type: 'lead.start', projectId, machineId: 'personal-mac', engine: 'codex', repositoryUrl: 'https://github.com/example/app' })
    expect(placed.result).toMatchObject({ machineId: 'personal-mac' })
    expect((await poolRows(store, person, 'personal-mac')).find(p => p.tabId === f.tab)!.leadStarts)
      .toEqual([expect.objectContaining({ request: expect.objectContaining({ machineId: 'personal-mac', cwd: `/work/${projectId}` }) })])
  })
})
