import { describe, expect, it } from 'vitest'
import { applyCommand, commandSchema, type Command, type CommandContext } from './commands.js'
import { admitMachineStart, type ContributedMachine } from './machines.js'
import { createSuperTab, SuperTabError, visibleState, type Actor, type AgentConfiguration, type SuperTabState } from './model.js'

// Task #2390 (Tony, 11-03): a machine's owner chooses which of the Swarm's projects may run agents on it. Default all, as
// before; only its owner sets it, or the Lead passing on the owner's own chat message (as machine.engineResume).
const NOW = 50_000_000
const owner: Extract<Actor, { kind: 'person' }> = { kind: 'person', userId: 'owner', email: 'owner@example.com' }
const tony: Extract<Actor, { kind: 'person' }> = { kind: 'person', userId: 'tony', email: 'tony@example.com' }
const config: AgentConfiguration = { engine: 'codex', model: 'fixture-model', effort: 'high', contextWindow: 200000, engineVersion: 'fixture' }
const resources = { cpuPercent: 1, memoryTotalBytes: 8, memoryUsedBytes: 1, diskFreeBytes: 8, diskTotalBytes: 8, projectDiskFreeBytes: 8,
  deviceType: null, chip: null, os: null, gpuPercent: null }
const reading = (): NonNullable<ContributedMachine['observation']> => ({ generation: 'g1', receivedAt: NOW, sessionKind: 'computer', resources, tools: {},
  quotas: [], runningHarnessIds: [], stoppedHarnessIds: [] })
const refusal = (body: () => unknown): SuperTabError | null => {
  try { body(); return null } catch (error) { if (error instanceof SuperTabError) return error; throw error }
}

/** The owner's Swarm ('lead' is its first project, "Pilot"), with Tony's MacBook and the owner's Mac contributed for every
 *  project, and the owner's other projects: lampos (public) and secret (private, Tony not a member). */
function swarm() {
  let state: SuperTabState = createSuperTab('tab', 'Pilot', { id: 'owner', email: owner.email }, 'prod')
  let sequence = 0
  const run = (command: Command, actor: Actor = owner, context: Partial<CommandContext> = {}) => {
    const effects = applyCommand(state, actor, command, { now: NOW, operationId: `op-${++sequence}`, teamMachines: [], ...context })
    state = effects.state
    return effects
  }
  const invited = run({ type: 'invite.create', email: tony.email, role: 'collaborator', conversationId: 'lead' })
  run({ type: 'invite.accept', inviteId: invited.result.inviteId as string }, tony)
  const generation = (userId: string) => state.people.find(p => p.id === userId)!.generation
  const pool = (machineId: string, contributorId: string, name: string, extra: Partial<ContributedMachine> = {}): ContributedMachine => ({ machineId, name,
    contributorId, membershipGeneration: generation(contributorId), generation: 'g1', cwd: '/swarm', scope: 'swarm', engines: ['codex'], maxAgents: 4,
    paused: false, observation: reading(), ...extra })
  state.machines = [pool('tony-mac', 'tony', 'MacBook Pro'), pool('owner-mac', 'owner', 'Owner Mac')]
  const lampos = String(run({ type: 'project.create', name: 'lampos', visibility: 'public', brief: '' }).result.projectId)
  const secret = String(run({ type: 'project.create', name: 'secret', visibility: 'private', brief: '' }).result.projectId)
  const lead = String(run({ type: 'agent.add', conversationId: 'lead', machineId: 'owner-mac', harnessId: 'lead', name: 'Lead', configuration: config, lead: true },
    owner, { contribution: { machineOwnerId: 'owner', contributorId: 'owner' } }).result.agentId)
  const leadActor: Actor = { kind: 'agent', agentId: lead, machineOwnerId: 'owner' }
  const machine = (machineId: string) => state.machines!.find(m => m.machineId === machineId)!
  const limit = (projectIds: string[] | null, machineId = 'tony-mac', actor: Actor = tony, context: Partial<CommandContext> = {}, extra: Record<string, unknown> = {}) =>
    run({ type: 'machine.projects', machineId, projectIds, ...extra } as Command, actor, context)
  const group = (projectId: string) => String(run({ type: 'conversation.create', projectId, title: 'Work', brief: 'Build it.', checks: [] }).result.conversationId)
  const requirements = { memoryBytes: 0, diskBytes: 0, maxCpuPercent: 100, tools: [], devices: [], quotaRequired: false }
  const request = (conversationId: string, machineId: string, projectId: string) =>
    ({ conversationId, machineId, engine: 'codex', name: 'Builder', cwd: `/swarm/${projectId}`, worktree: true, requirements })
  const start = (conversationId: string, machineId: string, projectId: string) => run({ type: 'agent.start', request: request(conversationId, machineId, projectId) },
    owner, { contribution: { machineOwnerId: machine(machineId).contributorId, contributorId: machine(machineId).contributorId, hostGrant: null } })
  /** An agent already in the Swarm on [machineId], of [projectId]. */
  const member = (id: string, machineId: string, projectId: string) => {
    const contributorId = machine(machineId).contributorId
    state.agents.push({ id, machineId, harnessId: `harness-${id}`, projectId, machineOwnerId: contributorId, contributorId,
      membershipGeneration: generation(contributorId), hostGrant: null, name: id, configuration: config })
    return id
  }
  return { run, machine, limit, lampos, secret, leadActor, pool, group, request, start, member, get state() { return state } }
}

describe('a machine\'s projects', () => {
  it('serves every project until its owner limits it, and every project again when they choose All', () => {
    const f = swarm()
    expect(f.machine('tony-mac').projects).toBeUndefined()
    f.limit(['lead'])
    expect(f.machine('tony-mac').projects).toEqual(['lead'])
    f.limit(['lead', f.lampos, 'lead'])
    expect(f.machine('tony-mac').projects).toEqual(['lead', f.lampos])
    f.limit(null)
    expect(f.machine('tony-mac').projects).toBeUndefined()
  })

  it('is changed by nobody but the machine\'s owner: not the Swarm owner, nor a Lead on its own word', () => {
    const f = swarm()
    expect(refusal(() => f.limit(['lead'], 'tony-mac', owner))?.code).toBe('OWNER_REQUIRED')
    expect(refusal(() => f.limit(['lead'], 'tony-mac', f.leadActor))?.code).toBe('OWNER_REQUIRED')
    expect(f.machine('tony-mac').projects).toBeUndefined()
  })

  it('is set by the Lead passing on the owner\'s own chat message from the last day, and not on anyone else\'s', () => {
    const f = swarm()
    const askedIn = { conversationId: 'lead', messageId: 'm-tony' }
    const said = (id: string, createdAt = NOW - 1000) => ({ askedIn: { author: { kind: 'person', id } as never, source: false, createdAt } })
    expect(refusal(() => f.limit(['lead'], 'tony-mac', f.leadActor, said('owner'), { askedIn }))?.code).toBe('OWNER_REQUIRED')
    expect(refusal(() => f.limit(['lead'], 'tony-mac', f.leadActor, said('tony', NOW - 2 * 24 * 60 * 60_000), { askedIn }))?.code).toBe('OWNER_REQUIRED')
    f.limit(['lead'], 'tony-mac', f.leadActor, said('tony'), { askedIn })
    expect(f.machine('tony-mac').projects).toEqual(['lead'])
  })

  it('names only projects of this Swarm its owner may read, at least one', () => {
    const f = swarm()
    expect(refusal(() => f.limit(['no-such-project']))?.code).toBe('NOT_FOUND')
    // Tony is no member of the private project: he cannot keep his machine for it.
    expect(refusal(() => f.limit([f.secret]))?.code).toBe('NOT_FOUND')
    expect(commandSchema.safeParse({ type: 'machine.projects', machineId: 'tony-mac', projectIds: [] }).success).toBe(false)
    f.limit([f.secret], 'owner-mac', owner)
    expect(f.machine('owner-mac').projects).toEqual([f.secret])
  })

  it('stays when the machine\'s settings are saved again', () => {
    const f = swarm()
    f.limit(['lead'])
    f.run({ type: 'machine.contribute', machineId: 'tony-mac', name: 'MacBook Pro', cwd: '/swarm', scope: 'swarm', engines: ['codex'], maxAgents: 6 }, tony,
      { contribution: { machineOwnerId: 'tony', contributorId: 'tony', hostGrant: null } })
    expect(f.machine('tony-mac')).toMatchObject({ maxAgents: 6, projects: ['lead'] })
  })

  it('loses a project that is deleted', () => {
    const f = swarm()
    f.limit(['lead', f.lampos])
    f.run({ type: 'project.delete', projectId: f.lampos })
    expect(f.machine('tony-mac').projects).toEqual(['lead'])
  })

  it('shows each reader only the projects they may read', () => {
    const f = swarm()
    f.limit(['lead', f.secret], 'owner-mac', owner)
    const seen = (actor: Actor) => visibleState(f.state, actor, NOW).machines!.find(m => m.machineId === 'owner-mac')!.projects
    expect(seen(owner)).toEqual(['lead', f.secret])
    expect(seen(tony)).toEqual(['lead'])
  })
})

describe('a machine kept for some projects', () => {
  const candidate = (id: string, machineId: string, patch: Record<string, unknown> = {}) => ({ id, kind: 'new', machineId, engine: 'codex',
    model: 'default', effort: 'default', quality: 3, cost: 2, title: `${id} on ${machineId}`, label: `Label ${id}`, ...patch })
  const record = (candidates: unknown[], pick = 'c0') => ({ assessment: { difficulty: 'medium', risk: 'low', why: 'A small change.' },
    candidates, excluded: [], floor: 2, notes: false, pick, via: 'order', p: null, belowFloor: false, why: 'Policy order.' })

  it('refuses a start for another project, and takes one for its own', () => {
    const f = swarm()
    f.limit(['lead'])
    expect(refusal(() => f.start(f.group(f.lampos), 'tony-mac', f.lampos))).toMatchObject({ code: 'MACHINE_PROJECTS', message: 'MacBook Pro runs only Pilot.' })
    expect(f.start(f.group('lead'), 'tony-mac', 'lead').result.startId).toBeTruthy()
  })

  it('refuses another project\'s Product Manager there', () => {
    const f = swarm()
    f.limit(['lead'])
    const chat = f.state.projects!.find(p => p.id === f.lampos)!.leadConversationId
    expect(refusal(() => admitMachineStart(f.state, { ...f.request(chat, 'tony-mac', f.lampos), leadFor: { projectId: f.lampos, personId: 'owner', generation: 'g' } }, NOW))
      ?.code).toBe('MACHINE_PROJECTS')
  })

  it('gives an agent there no task of another project, and lets none join one, while it keeps its own', () => {
    const f = swarm()
    const there = f.member('there', 'tony-mac', f.lampos)
    f.limit(['lead'])
    const work = f.group(f.lampos)
    expect(refusal(() => f.run({ type: 'work.assign', conversationId: work, agentId: there }))?.code).toBe('MACHINE_PROJECTS')
    expect(refusal(() => f.run({ type: 'conversation.agent', conversationId: work, agentId: there, present: true, lead: false }))?.code).toBe('MACHINE_PROJECTS')
    // Not removed: it stays listed, as an agent whose machine stopped taking teammates' work does.
    expect(f.state.agents.some(a => a.id === there)).toBe(true)
    const ours = f.member('ours', 'tony-mac', 'lead'), own = f.group('lead')
    f.run({ type: 'work.assign', conversationId: own, agentId: ours })
    expect(f.state.conversations.find(c => c.id === own)!.assignment).toMatchObject({ agentId: ours })
  })

  it('is left out of another project\'s route, saying why, and refused as its pick', () => {
    const f = swarm()
    f.limit(['lead'])
    const work = f.group(f.lampos)
    const effects = f.run({ type: 'route.record', conversationId: work, decision: record([candidate('c0', 'owner-mac'), candidate('c1', 'tony-mac')]) } as Command)
    expect(effects.routeDecisions[0]).toMatchObject({ op: 'create', record: { candidates: [{ id: 'c0' }],
      excluded: [{ title: 'c1 on tony-mac', reason: 'MacBook Pro runs only Pilot.' }] } })
    expect(refusal(() => f.run({ type: 'route.record', conversationId: f.group(f.lampos), decision: record([candidate('c0', 'tony-mac')]) } as Command))).toMatchObject({ code: 'MACHINE_PROJECTS', message: 'MacBook Pro runs only Pilot. Route again.' })
  })

  it('holds for its Mac\'s Harness Team account too', () => {
    const f = swarm()
    f.state.machines!.push(f.pool('tony-team', 'tony', 'MacBook Pro · Team', { hostMachineId: 'tony-mac',
      observation: { ...f.machine('tony-mac').observation!, sessionKind: 'team', privacy: { mode: 'dedicated', seenAt: NOW } } }))
    f.limit(['lead'])
    const theirs = f.group(f.lampos), ours = f.group('lead')
    expect(refusal(() => admitMachineStart(f.state, f.request(theirs, 'tony-team', f.lampos), NOW, undefined, ['tony-team']))?.code).toBe('MACHINE_PROJECTS')
    expect(admitMachineStart(f.state, f.request(ours, 'tony-team', 'lead'), NOW, undefined, ['tony-team'])?.machineId).toBe('tony-team')
    // It is set on the Mac, never on its account.
    expect(refusal(() => f.limit(['lead'], 'tony-team'))?.code).toBe('NOT_FOUND')
  })

  it('counts a private project it is kept for, never naming it', () => {
    const f = swarm()
    f.limit(['lead', f.secret], 'owner-mac', owner)
    expect(refusal(() => f.start(f.group(f.lampos), 'owner-mac', f.lampos))?.message).toBe('Owner Mac runs only Pilot and 1 other project.')
    f.limit([f.secret], 'owner-mac', owner)
    expect(refusal(() => f.start(f.group(f.lampos), 'owner-mac', f.lampos))?.message).toBe('Owner Mac runs only 1 other project.')
  })

  it('kept only for a deleted project, takes no project\'s work, and says so', () => {
    const f = swarm()
    f.limit([f.lampos])
    f.run({ type: 'project.delete', projectId: f.lampos })
    expect(refusal(() => f.start(f.group('lead'), 'tony-mac', 'lead'))?.message).toBe('MacBook Pro runs no project now: its owner can choose its projects again.')
  })

  it('with no list, takes every project\'s work as before', () => {
    const f = swarm()
    expect(f.start(f.group(f.lampos), 'tony-mac', f.lampos).result.startId).toBeTruthy()
    expect(f.start(f.group('lead'), 'tony-mac', 'lead').result.startId).toBeTruthy()
  })
})
