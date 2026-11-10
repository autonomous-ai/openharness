import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { applyCommand, commandSchema, type Command, type CommandContext } from './commands.js'
import { availableSlots, machineSlots, type ContributedMachine } from './machines.js'
import { createSuperTab, SuperTabError, visibleState, type Actor, type AgentConfiguration, type SuperTabState } from './model.js'

// Teammates' work on Swarm machines. Everything below runs with SWARM_TEAM_ACCOUNT_REQUIRED=1, except the block of a machine
// added as its person joined.
beforeEach(() => { process.env.SWARM_TEAM_ACCOUNT_REQUIRED = '1' })
afterEach(() => { delete process.env.SWARM_TEAM_ACCOUNT_REQUIRED })

const NOW = 50_000_000
const MINUTE = 60_000
const owner: Extract<Actor, { kind: 'person' }> = { kind: 'person', userId: 'owner', email: 'owner@example.com' }
const mate: Extract<Actor, { kind: 'person' }> = { kind: 'person', userId: 'mate', email: 'mate@example.com' }
const config: AgentConfiguration = { engine: 'codex', model: 'fixture-model', effort: 'high', contextWindow: 200000, engineVersion: 'fixture' }
const requirements = { memoryBytes: 0, diskBytes: 0, maxCpuPercent: 100, tools: [], devices: [], quotaRequired: false }
const resources = { cpuPercent: 1, memoryTotalBytes: 64e9, memoryUsedBytes: 1e9, diskFreeBytes: 8, diskTotalBytes: 8, projectDiskFreeBytes: 8,
  deviceType: null, chip: null, os: null, gpuPercent: null }
type Reading = NonNullable<ContributedMachine['observation']>
/** A reading as the store keeps it. */
const reading = (): Reading => ({
  generation: 'g1', receivedAt: NOW, resources, tools: {}, quotas: [], runningHarnessIds: [], stoppedHarnessIds: [] })
const refusal = (body: () => unknown): SuperTabError | null => {
  try { body(); return null } catch (error) { if (error instanceof SuperTabError) return error; throw error }
}

/** The owner's Swarm: the owner's project ('lead') and the teammate's own project, the owner's Mac and the teammate's
 *  personal MacBook, both contributed for every project. */
function swarm() {
  let state: SuperTabState = createSuperTab('tab', 'Pilot', { id: 'owner', email: owner.email }, 'prod')
  let sequence = 0
  const run = (command: Command, actor: Actor = owner, context: Partial<CommandContext> = {}) => {
    const effects = applyCommand(state, actor, command, { now: NOW, operationId: `op-${++sequence}`, ...context })
    state = effects.state
    return effects
  }
  const invited = run({ type: 'invite.create', email: mate.email, role: 'collaborator', conversationId: 'lead' })
  run({ type: 'invite.accept', inviteId: invited.result.inviteId as string }, mate)
  const generation = (userId: string) => state.people.find(p => p.id === userId)!.generation
  const pool = (machineId: string, contributorId: string, name: string, observation: Reading): ContributedMachine => ({ machineId, name, contributorId,
    membershipGeneration: generation(contributorId), generation: 'g1', cwd: '/swarm', scope: 'swarm', engines: ['codex'], maxAgents: 4, paused: false, observation })
  state.machines = [
    pool('owner-mac', 'owner', 'Owner Mac', reading()),
    pool('mate-mac', 'mate', 'MacBook Pro', reading()),
  ]
  const mine = String(run({ type: 'project.create', name: 'Mine', visibility: 'public', brief: '' }, mate).result.projectId)
  const group = (projectId = 'lead', actor: Actor = owner) => String(run({ type: 'conversation.create', projectId, title: 'Work', brief: 'Build it.',
    checks: [{ description: 'Tests pass.', independent: false }] }, actor).result.conversationId)
  /** An agent already in the Swarm on [machineId], run by [contributorId]'s grant there. */
  const member = (id: string, machineId: string, contributorId: string, projectId = 'lead', extra: Record<string, unknown> = {}) => {
    state.agents.push({ id, machineId, harnessId: `harness-${id}`, projectId, machineOwnerId: contributorId, contributorId,
      membershipGeneration: generation(contributorId), hostGrant: null, name: id, configuration: config, ...extra })
    return id
  }
  const machine = (machineId: string) => state.machines!.find(m => m.machineId === machineId)!
  /** A start request for [conversationId] on a contributed machine, in the folder the contribution gives that project. */
  const request = (conversationId: string, machineId: string, projectId = 'lead') =>
    ({ conversationId, machineId, engine: 'codex', name: 'Builder', cwd: `/swarm/${projectId}`, worktree: true, requirements })
  const pooled = (machineId: string) => ({ contribution: { machineOwnerId: machine(machineId).contributorId, contributorId: machine(machineId).contributorId, hostGrant: null } })
  return { run, group, member, machine, request, pooled, mine, get state() { return state } }
}

// Swarm v3 has no Team accounts (task #4120, the PM's ruling): an agent a person brought works on any task of a project that
// person can read, in their own account, and a new agent starts only on its own person's computer.
describe('starting a teammate\'s work', () => {
  it('runs on the teammate\'s own computer, in their own account, when they start it', () => {
    const f = swarm(), group = f.group()
    f.run({ type: 'agent.start', request: f.request(group, 'mate-mac') }, mate, f.pooled('mate-mac'))
    expect(f.state.starts).toEqual([expect.objectContaining({ request: expect.objectContaining({ machineId: 'mate-mac', cwd: '/swarm/lead' }) })])
  })

  it('is never started by another person on the teammate\'s computer', () => {
    const f = swarm(), group = f.group()
    expect(refusal(() => f.run({ type: 'agent.start', request: f.request(group, 'mate-mac') }, owner, f.pooled('mate-mac'))))
      .toMatchObject({ code: 'NOT_YOUR_COMPUTER', status: 403 })
    expect(f.state.starts ?? []).toEqual([])
  })

  it('leaves a person\'s own projects on their own machines as they were', () => {
    const f = swarm()
    f.run({ type: 'agent.start', request: f.request(f.group(), 'owner-mac') }, owner, f.pooled('owner-mac'))
    const mine = f.group(f.mine, mate)
    f.run({ type: 'agent.start', request: f.request(mine, 'mate-mac', f.mine) }, mate, f.pooled('mate-mac'))
    expect(f.state.starts).toHaveLength(2)
    // The teammate's project on the owner's Mac is another person's computer.
    expect(refusal(() => f.run({ type: 'agent.start', request: f.request(mine, 'owner-mac', f.mine) }, mate, f.pooled('owner-mac')))?.code).toBe('NOT_YOUR_COMPUTER')
  })

  it('runs off the Machines list on its person\'s own computer, for a project they read', () => {
    const f = swarm(), group = f.group()
    f.run({ type: 'agent.start', request: { ...f.request(group, 'mate-laptop'), cwd: '/work' } }, mate, { contribution: { machineOwnerId: 'mate', contributorId: 'mate' } })
    f.run({ type: 'agent.start', request: { ...f.request(f.group(f.mine, mate), 'mate-laptop'), cwd: '/work' } }, mate, { contribution: { machineOwnerId: 'mate', contributorId: 'mate' } })
    // Through another person's machine share it would run in their account: refused (security review 2 of #3446).
    expect(refusal(() => f.run({ type: 'agent.start', request: { ...f.request(group, 'shared-mac'), cwd: '/work' } }, owner,
      { contribution: { machineOwnerId: 'mate', contributorId: 'owner', hostGrant: 'grant-1' } }))?.code).toBe('NOT_YOUR_COMPUTER')
    expect(f.state.starts).toHaveLength(2)
  })
})

describe('giving an existing agent a teammate\'s work', () => {
  it('adding a Reviewer to a group, which hands it the review, is admitted for the teammate\'s own agent', () => {
    const f = swarm(), group = f.group()
    const reviewer = f.member('reviewer', 'mate-mac', 'mate', 'lead', { role: 'reviewer' })
    f.run({ type: 'conversation.agent', conversationId: group, agentId: reviewer, present: true, lead: false })
    expect(f.state.conversations.find(c => c.id === group)!.agentIds).toContain(reviewer)
  })
})

// A machine Desktop adds as its person joins a Swarm (Scholes, 2026-10-29): nobody chose to lend it to teammates, so it never
// runs a teammate's agent as that person.
describe('a machine added as its person joined', () => {
  beforeEach(() => { delete process.env.SWARM_TEAM_ACCOUNT_REQUIRED })
  const joined: Extract<Command, { type: 'machine.contribute' }> = { type: 'machine.contribute', machineId: 'joined-mac', name: 'MacBook Air',
    cwd: '/swarm', scope: 'swarm', engines: ['codex'], maxAgents: 4, teamAccountOnly: true }
  const contribution = { contribution: { machineOwnerId: 'mate', contributorId: 'mate', hostGrant: null } }

  it('takes its person\'s own agent for any project they read, and no other person\'s start', () => {
    const f = swarm(), group = f.group(), own = f.group(f.mine, mate)
    f.run(joined, mate, contribution)
    f.machine('joined-mac').observation = reading()
    expect(refusal(() => f.run({ type: 'agent.start', request: f.request(group, 'joined-mac') }, owner, f.pooled('joined-mac')))?.code).toBe('NOT_YOUR_COMPUTER')
    f.run({ type: 'agent.start', request: f.request(own, 'joined-mac', f.mine) }, mate, f.pooled('joined-mac'))
    f.run({ type: 'agent.start', request: f.request(group, 'joined-mac') }, mate, f.pooled('joined-mac'))
    expect(f.state.starts).toHaveLength(2)
  })

  it('keeps the rule when its settings are saved again, which sends the contribution without it', () => {
    const f = swarm()
    f.run(joined, mate, contribution)
    const { teamAccountOnly: _rule, ...settings } = joined
    f.run({ ...settings, maxAgents: 2 }, mate, contribution)
    expect(f.machine('joined-mac')).toMatchObject({ maxAgents: 2, teamAccountOnly: true })
  })

  it('is a choice only its person makes: the field is refused on any other command shape', () => {
    expect(commandSchemaOf(joined).success).toBe(true)
    expect(commandSchemaOf({ ...joined, teamAccountOnly: false }).success).toBe(false)
  })
})

const commandSchemaOf = (command: unknown) => commandSchema.safeParse(command)

describe('machines take agents as memory allows (Dee, 11-04: "remove the limit")', () => {
  const GiB = 1024 ** 3
  /** A Mac with [freeGiB] free of [totalGiB], read just now. */
  const measured = (f: ReturnType<typeof swarm>, machineId: string, totalGiB: number, freeGiB: number) => {
    const m = f.machine(machineId)
    m.observation = { ...m.observation!, resources: { ...m.observation!.resources, memoryTotalBytes: totalGiB * GiB, memoryUsedBytes: (totalGiB - freeGiB) * GiB } }
  }
  const twoGiB = { memoryBytes: 2 * GiB, diskBytes: 0, maxCpuPercent: 100, tools: [], devices: [], quotaRequired: false }
  const start = (f: ReturnType<typeof swarm>, group: string, machineId = 'owner-mac') =>
    f.run({ type: 'agent.start', request: { ...f.request(group, machineId), requirements: twoGiB } }, owner, f.pooled(machineId))
  const fill = (f: ReturnType<typeof swarm>, machineId: string, count: number) => {
    for (let i = 0; i < count; i++) f.member(`running-${machineId}-${i}`, machineId, f.machine(machineId).contributorId)
  }

  it('joining stores no fixed count: a Mac added with the suggested 16 takes a 17th start while memory allows', () => {
    const f = swarm(), group = f.group()
    f.state.machines = f.state.machines!.filter(m => m.machineId !== 'owner-mac')
    f.run({ type: 'machine.contribute', machineId: 'owner-mac', name: 'Owner Mac', cwd: '/swarm', scope: 'swarm', engines: ['codex'], maxAgents: 16, agents: 'memory' } as Command,
      owner, { contribution: { machineOwnerId: 'owner', contributorId: 'owner', machineName: 'Owner Mac' } } as never)
    f.machine('owner-mac').observation = reading()
    measured(f, 'owner-mac', 128, 60)
    expect(f.machine('owner-mac').agents).toBe('memory')
    fill(f, 'owner-mac', 16)
    expect(refusal(() => start(f, group))).toBeNull()
  })

  it('an older row holding the old join suggestion reads as memory allows', () => {
    const f = swarm(), group = f.group()
    // Mac 3 (Dee, 11-04): 16 stored when it joined, 16 running, plenty free.
    Object.assign(f.machine('owner-mac'), { maxAgents: 16 })
    measured(f, 'owner-mac', 128, 60)
    fill(f, 'owner-mac', 16)
    expect(refusal(() => start(f, group))).toBeNull()
    // A 32 GiB Mac whose join suggested 8 (one per 4 GiB): the same.
    const g = swarm(), other = g.group()
    Object.assign(g.machine('owner-mac'), { maxAgents: 8 })
    measured(g, 'owner-mac', 32, 20)
    fill(g, 'owner-mac', 8)
    expect(refusal(() => start(g, other))).toBeNull()
  })

  // The lead, 2026-11-10: the owner deleted capacity settings, so a count an owner saved before, At most N from a new client or a
  // plain number from an older one, holds no start back. Free memory still does.
  it('takes agents as memory allows, whatever count its owner saved before', () => {
    const f = swarm(), group = f.group()
    Object.assign(f.machine('owner-mac'), { maxAgents: 16, agents: 'atMost' })
    measured(f, 'owner-mac', 128, 60)
    fill(f, 'owner-mac', 16)
    expect(refusal(() => start(f, group))).toBeNull()
    const g = swarm(), other = g.group()
    Object.assign(g.machine('owner-mac'), { maxAgents: 3 })
    measured(g, 'owner-mac', 128, 60)
    fill(g, 'owner-mac', 3)
    expect(refusal(() => start(g, other))).toBeNull()
  })

  // Review of #3865: with no saved count left to bound it, a start that asks for no memory is held to an agent's.
  it('holds a start that asks for no memory to an agent\'s', () => {
    const f = swarm(), group = f.group()
    measured(f, 'owner-mac', 128, 1)
    const none = refusal(() => f.run({ type: 'agent.start', request: { ...f.request(group, 'owner-mac'), requirements: { ...twoGiB, memoryBytes: 0 } } }, owner, f.pooled('owner-mac')))
    expect(none?.message).toBe('Owner Mac is out of free memory: 1 GB free, and an agent needs 2 GB. Try again when an agent there finishes, or pick another machine.')
  })

  it('a start refused for memory says so plainly', () => {
    const f = swarm(), group = f.group()
    Object.assign(f.machine('owner-mac'), { maxAgents: 16 })
    measured(f, 'owner-mac', 128, 1.5)
    const short = refusal(() => start(f, group))
    expect(short?.code).toBe('MACHINE_FULL')
    expect(short?.message).toBe('Owner Mac is out of free memory: 1.5 GB free, and an agent needs 2 GB. Try again when an agent there finishes, or pick another machine.')
    expect(short?.message).not.toMatch(/limit/)
  })

  it('the route counts a machine\'s room by its free memory', () => {
    const f = swarm()
    Object.assign(f.machine('owner-mac'), { maxAgents: 16 })
    measured(f, 'owner-mac', 128, 21)
    fill(f, 'owner-mac', 16)
    // 16 running and 21 GiB free: ten more of 2 GiB, not the zero a count of 16 left.
    expect(availableSlots(f.state, f.machine('owner-mac'), machineSlots(f.state, f.machine('owner-mac')))).toBe(10)
    // A count its owner saved before is no limit.
    Object.assign(f.machine('owner-mac'), { agents: 'atMost', maxAgents: 18 })
    expect(availableSlots(f.state, f.machine('owner-mac'), machineSlots(f.state, f.machine('owner-mac')))).toBe(10)
  })

  // Review of #3001: the reading shows no memory for starts not launched yet.
  it('counts the memory of starts admitted and not yet launched', () => {
    const f = swarm(), group = f.group()
    Object.assign(f.machine('owner-mac'), { maxAgents: 16 })
    measured(f, 'owner-mac', 128, 5)
    const room = () => availableSlots(f.state, f.machine('owner-mac'), machineSlots(f.state, f.machine('owner-mac')))
    expect(room()).toBe(2)
    expect(refusal(() => start(f, group))).toBeNull()
    expect(room()).toBe(1)
    expect(refusal(() => start(f, group))).toBeNull()
    expect(room()).toBe(0)
    const third = refusal(() => start(f, group))
    expect(third?.message).toBe('Owner Mac is out of free memory: 1 GB free, and an agent needs 2 GB. Try again when an agent there finishes, or pick another machine.')
    expect(third?.details).toEqual({ reason: 'memory' })
  })

  it('stores the Agents setting a client sends, for it to read back, and none when it sends none', () => {
    const f = swarm()
    const save = (extra: Record<string, unknown>) => f.run({ type: 'machine.contribute', machineId: 'owner-mac', name: 'Owner Mac', cwd: '/swarm', scope: 'swarm',
      engines: ['codex'], maxAgents: 16, ...extra } as Command, owner, { contribution: { machineOwnerId: 'owner', contributorId: 'owner', machineName: 'Owner Mac' } } as never)
    save({ agents: 'atMost' })
    expect(f.machine('owner-mac')).toMatchObject({ agents: 'atMost', maxAgents: 16 })
    save({})
    expect(f.machine('owner-mac').agents).toBeUndefined()
  })
})
