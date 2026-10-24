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
import type { ContributedMachine } from '../src/superTabs/machines.js'

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
  const generation = (await store.hostPools(team, 'team-mac')).find(p => p.tabId === tab)!.machine.generation
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
    await run(f.tab, { type: 'machine.contribute', machineId: 'personal-mac', name: 'MacBook Pro', cwd: '/work', scope: 'swarm', engines: ['codex'], maxAgents: 2 }, person)
    const generation = (await store.hostPools(person, 'personal-mac')).find(p => p.tabId === f.tab)!.machine.generation
    await store.observeMachine(person, f.tab, 'personal-mac', reading(generation))
    const queued = String((await run(f.tab, { type: 'agent.start', request: { conversationId: f.personalGroup, machineId: 'personal-mac', engine: 'codex',
      name: 'Another', cwd: `/work/${f.own}`, worktree: false, requirements } }, person)).result.startId)
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

// Teammates' work runs only on Team machines (Task 3): the owner's project on the person's machines needs the person's
// Harness Team account with its privacy check passed. The person's own projects run on the person's machines as before.
describe('a teammate\'s work and the machines that take it', () => {
  // With the rule required everywhere, as it will be once team accounts can be made (machines.ts teamAccountRequired).
  beforeAll(() => { process.env.SWARM_TEAM_ACCOUNT_REQUIRED = '1' })
  afterAll(() => { delete process.env.SWARM_TEAM_ACCOUNT_REQUIRED })
  /** The person's personal MacBook, contributed for every project, reporting from the person's own sign-in. */
  async function personalMac(f: Awaited<ReturnType<typeof fixture>>) {
    await run(f.tab, { type: 'machine.contribute', machineId: 'personal-mac', name: 'MacBook Pro', cwd: '/work', scope: 'swarm', engines: ['codex'], maxAgents: 2 }, person)
    const generation = (await store.hostPools(person, 'personal-mac')).find(p => p.tabId === f.tab)!.machine.generation
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
    // A reading of the team machine from the person's own sign-in drops the check; its account row still says team.
    await store.observeMachine(person, f.tab, 'team-mac', reading(f.generation))
    expect((await pool(f.tab, 'team-mac')).teamWork).toMatchObject({ allowed: false, code: 'PRIVACY_UNCHECKED' })
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
    await store.observeMachine(person, f.tab, 'team-mac', reading(f.generation))
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
    expect((await store.messages(owner, f.tab, f.teamGroup, {})).messages.at(-1)!.text).toMatch(/^Could not start Builder: The Harness Team account on MacBook Pro · Team is not private/)
    expect((await store.hostPools(team, 'team-mac')).find(p => p.tabId === f.tab)!.starts.map(s => s.id)).not.toContain(queued)
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
    const row = await db.superTab.findUniqueOrThrow({ where: { id: f.tab } })
    const state = structuredClone(row.state) as unknown as { conversations: Array<{ id: string; agentIds: string[]; assignment: unknown }> }
    const work = state.conversations.find(c => c.id === f.teamGroup)!
    work.assignment = { id: 'assigned-before', agentId: old, status: 'working', configuration: config, result: null,
      execution: { machineId: 'personal-mac', harnessId: 'before-release', machineOwnerId: person.sub } }
    await db.superTab.update({ where: { id: f.tab }, data: { state: state as never, revision: row.revision + 1 } })
    await db.superTabRun.create({ data: { id: old, tabId: f.tab, assignmentId: 'assigned-before', machineId: 'personal-mac', harnessId: 'before-release' } })

    await store.observeMachine(person, f.tab, 'personal-mac', reading(generation))
    expect((await store.hostTabs(person, 'personal-mac')).find(r => r.tabId === f.tab && r.agent.id === old)).toMatchObject({ stopRequested: false })
    expect(await store.hostAssignments(person, 'personal-mac')).toContainEqual({ tabId: f.tab, assignmentId: 'assigned-before', harnessId: 'before-release' })
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
describe('one machine: a Mac and its Harness Team account', () => {
  it('the Mac\'s host adds its team account, which then takes the owner\'s project started on the Mac', async () => {
    await db.machine.update({ where: { machineId: 'team-mac' }, data: { hostMachineId: 'personal-mac' } })
    try {
      const tab = (await store.create(owner, randomUUID(), 'One machine')).id
      const invitation = await run(tab, { type: 'invite.create', email: person.email, role: 'collaborator', conversationId: 'lead' })
      await run(tab, { type: 'invite.accept', inviteId: invitation.result.inviteId as string }, person)
      await run(tab, { type: 'machine.contribute', machineId: 'personal-mac', name: 'MacBook Pro', cwd: '/work', scope: 'swarm', engines: ['codex'], maxAgents: 3 }, person)
      const joins = async () => (await store.hostTabs(person, 'personal-mac')).filter(r => r.tabId === tab && 'joinTeam' in r)
      expect(await joins()).toEqual([{ tabId: tab, joinTeam: { machineId: 'team-mac', name: 'MacBook Pro', maxAgents: 3 } }])
      // The team account's own daemon is never asked, and cannot add itself.
      expect((await store.hostTabs(team, 'team-mac')).some(r => 'joinTeam' in r)).toBe(false)
      await expect(store.execute(team, tab, { operationId: randomUUID(), command: { type: 'machine.contribute', machineId: 'team-mac', name: 'x', cwd: '/team',
        scope: 'swarm', engines: ['codex'], maxAgents: 1, ifMissing: true } })).rejects.toMatchObject(LIMITED)
      // The Mac's host adds it, as the person: the backend gives it the Mac's name and slots, and the Mac it lives on.
      await run(tab, { type: 'machine.contribute', machineId: 'team-mac', name: 'MacBook Pro · Team', cwd: '/team', scope: 'swarm', engines: ['codex'],
        maxAgents: 1, ifMissing: true }, person)
      expect(await joins()).toEqual([])
      const listed = (await store.read(owner, tab)).state.machines!.find(m => m.machineId === 'team-mac')!
      expect(listed).toMatchObject({ hostMachineId: 'personal-mac', name: 'MacBook Pro', maxAgents: 3, cwd: '/team' })
      const generation = (await store.hostPools(team, 'team-mac')).find(p => p.tabId === tab)!.machine.generation
      await store.observeMachine(team, tab, 'team-mac', reading(generation))
      const group = String((await run(tab, { type: 'conversation.create', projectId: 'lead', title: 'Work', brief: 'Do it',
        checks: [{ description: 'Verified', independent: false }] })).result.conversationId)
      const started = await run(tab, { type: 'agent.start', request: { conversationId: group, machineId: 'personal-mac', engine: 'codex', name: 'Builder',
        cwd: '/work/lead', worktree: false, requirements } })
      const queued = (await store.hostPools(team, 'team-mac')).find(p => p.tabId === tab)!.starts
      expect(queued).toEqual([expect.objectContaining({ id: started.result.startId, request: expect.objectContaining({ machineId: 'team-mac', cwd: '/team/lead' }) })])
      expect((await store.hostPools(person, 'personal-mac')).find(p => p.tabId === tab)!.starts).toEqual([])
    } finally {
      await db.machine.update({ where: { machineId: 'team-mac' }, data: { hostMachineId: null } })
    }
  })
})
