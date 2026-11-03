import { describe, expect, it } from 'vitest'
import { applyCommand, commandSchema, type Command, type CommandContext } from './commands.js'
import type { ContributedMachine } from './machines.js'
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
  return { run, machine, limit, lampos, secret, leadActor, pool, get state() { return state } }
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
