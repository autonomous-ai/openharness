import { afterEach, describe, expect, it } from 'vitest'
import { applyCommand, commandSchema, type Command, type CommandContext } from './commands.js'
import type { ContributedMachine, MachinePrivacy } from './machines.js'
import { createSuperTab, SuperTabError, type Actor, type AgentConfiguration, type SuperTabState } from './model.js'

// A project's Product Manager started by the Swarm on one of its machines (Dee, 10-29, option B): on another person's Mac it
// runs only in that Mac's Harness Team account, never as the Mac's owner; with no machine free it waits for one.

const NOW = 50_000_000
const MINUTE = 60_000
const owner: Extract<Actor, { kind: 'person' }> = { kind: 'person', userId: 'owner', email: 'owner@example.com' }
const mate: Extract<Actor, { kind: 'person' }> = { kind: 'person', userId: 'mate', email: 'mate@example.com' }
const config: AgentConfiguration = { engine: 'claude', model: 'opus', effort: 'high', contextWindow: null, engineVersion: null }
const resources = { cpuPercent: 1, memoryTotalBytes: 8, memoryUsedBytes: 1, diskFreeBytes: 8, diskTotalBytes: 8, projectDiskFreeBytes: 8,
  deviceType: null, chip: null, os: null, gpuPercent: null }
const PASSED: MachinePrivacy = { mode: 'account', passed: true, checkedAt: NOW - MINUTE }
const FAILED: MachinePrivacy = { mode: 'account', passed: false, item: 'gitconfig', detail: 'The team account could read ~/.gitconfig.', checkedAt: NOW - MINUTE }
const REPO = 'https://github.com/example/app'
type Reading = NonNullable<ContributedMachine['observation']>
/** A reading as the store keeps it, from a host that starts Product Managers unless [capable] is false. */
const reading = (sessionKind: 'team' | 'computer', privacy?: MachinePrivacy, capable = true): Reading => ({
  generation: 'g1', receivedAt: NOW, sessionKind, resources, tools: {}, quotas: [], runningHarnessIds: [], stoppedHarnessIds: [],
  ...(capable ? { capabilities: ['leadStart'] } : {}), ...(privacy ? { privacy: { ...privacy, seenAt: NOW } } : {}) })
const refusal = (body: () => unknown): SuperTabError | null => {
  try { body(); return null } catch (error) { if (error instanceof SuperTabError) return error; throw error }
}

afterEach(() => { delete process.env.SWARM_TEAM_ACCOUNT_REQUIRED })

/** The owner's Swarm with the owner's project App: the owner's Mac, and the teammate's MacBook with its Harness Team account. */
function swarm() {
  let state: SuperTabState = createSuperTab('tab', 'Pilot', { id: 'owner', email: owner.email }, 'prod')
  let sequence = 0
  const run = (command: Command, actor: Actor = owner, context: Partial<CommandContext> = {}) => {
    const teamMachines = (state.machines ?? []).filter(m => m.observation?.sessionKind === 'team').map(m => m.machineId)
    const effects = applyCommand(state, actor, command, { now: NOW, operationId: `op-${++sequence}`, teamMachines, ...context })
    state = effects.state
    return effects
  }
  const invited = run({ type: 'invite.create', email: mate.email, role: 'collaborator', conversationId: 'lead' })
  run({ type: 'invite.accept', inviteId: invited.result.inviteId as string }, mate)
  const generation = (userId: string) => state.people.find(p => p.id === userId)!.generation
  const pool = (machineId: string, contributorId: string, name: string, observation: Reading, extra: Partial<ContributedMachine> = {}): ContributedMachine => ({
    machineId, name, contributorId, membershipGeneration: generation(contributorId), generation: 'g1', cwd: '/swarm', scope: 'swarm',
    engines: ['claude', 'codex'], maxAgents: 4, paused: false, observation, ...extra })
  state.machines = [
    pool('owner-mac', 'owner', 'Owner Mac', reading('computer')),
    pool('mate-mac', 'mate', 'MacBook Pro', reading('computer')),
    pool('mate-team', 'mate', 'MacBook Pro', reading('team', PASSED), { hostMachineId: 'mate-mac', cwd: '/team-swarm' }),
  ]
  const app = run({ type: 'project.create', name: 'App', visibility: 'private', brief: 'Build the app.' }).result as { projectId: string; conversationId: string }
  const machine = (machineId: string) => state.machines!.find(m => m.machineId === machineId)!
  const project = () => state.projects!.find(p => p.id === app.projectId)!
  const lead = (machineId: string | null, extra: Record<string, unknown> = {}, actor: Actor = owner, context: Partial<CommandContext> = {}) =>
    run({ type: 'lead.start', projectId: app.projectId, machineId, engine: 'claude', repositoryUrl: REPO, ...extra } as Command, actor, context)
  return { run, app, machine, project, lead, get state() { return state } }
}

describe('starting a project\'s Product Manager on a Swarm machine', () => {
  it('on the project owner\'s own machine, runs as its owner in the project\'s folder there', () => {
    const f = swarm()
    const started = f.lead('owner-mac', { model: 'opus', effort: 'high' })
    expect(f.state.starts).toEqual([expect.objectContaining({ id: started.result.startId, poolGeneration: 'g1', machineOwnerId: 'owner',
      contributorId: 'owner', actorKey: 'person:owner',
      request: expect.objectContaining({ conversationId: f.app.conversationId, machineId: 'owner-mac', engine: 'claude', model: 'opus', effort: 'high',
        cwd: `/swarm/${f.app.projectId}`, worktree: true, leadFor: { projectId: f.app.projectId, personId: 'owner', generation: expect.any(String) } }) })])
    expect(started.result).toMatchObject({ machineId: 'owner-mac' })
    expect(f.project().lead).toMatchObject({ status: 'starting', machineId: 'owner-mac', machineName: 'Owner Mac', startId: started.result.startId })
    // The repository it clones, recorded for the project.
    expect(f.project().repository).toEqual({ machineId: 'owner-mac', cwd: `/swarm/${f.app.projectId}`, repositoryUrl: REPO })
  })

  it('on a teammate\'s Mac, runs in that Mac\'s Harness Team account and its folder, never as the Mac\'s owner', () => {
    const f = swarm()
    f.lead('mate-mac')
    expect(f.state.starts).toEqual([expect.objectContaining({ machineOwnerId: 'mate',
      request: expect.objectContaining({ machineId: 'mate-team', cwd: `/team-swarm/${f.app.projectId}` }) })])
    expect(f.project().lead).toMatchObject({ status: 'starting', machineId: 'mate-team', machineName: 'MacBook Pro' })
  })

  it('is refused with the Team account\'s own reason, and records nothing', () => {
    const f = swarm()
    f.machine('mate-team').observation = reading('team', FAILED)
    expect(refusal(() => f.lead('mate-mac'))).toMatchObject({ code: 'PRIVACY_CHECK_FAILED', status: 403,
      message: 'The Harness Team account on MacBook Pro is not private (gitconfig: it could read its owner\'s ~/.gitconfig), so it runs only its owner\'s projects.' })
    f.machine('mate-team').observation = { ...reading('team', PASSED), receivedAt: NOW - 10 * MINUTE }
    expect(refusal(() => f.lead('mate-mac'))?.code).toBe('MACHINE_OFFLINE')
    expect(f.state.starts ?? []).toEqual([])
    expect(f.project().lead).toBeUndefined()
  })

  it('needs a Team account on another person\'s machine even while the Swarm does not yet require one', () => {
    // A worker would still run as the Mac's owner here; a Product Manager holds people's private chats, so it never does.
    delete process.env.SWARM_TEAM_ACCOUNT_REQUIRED
    const f = swarm()
    f.state.machines = f.state.machines!.filter(m => m.machineId !== 'mate-team')
    expect(refusal(() => f.lead('mate-mac'))?.code).toBe('TEAM_ACCOUNT_REQUIRED')
    // With no GitHub App the Team account takes no work, so the Mac would run it itself: refused too.
    expect(refusal(() => swarm().lead('mate-mac', {}, owner, { teamAccountsIdle: true }))?.code).toBe('TEAM_ACCOUNT_REQUIRED')
    expect(f.state.starts ?? []).toEqual([])
  })

  it('is refused on a machine whose Harness is too old to start a Product Manager', () => {
    const f = swarm()
    f.machine('mate-team').observation = reading('team', PASSED, false)
    expect(refusal(() => f.lead('mate-mac'))).toMatchObject({ code: 'HOST_OUTDATED',
      message: 'Update Harness on MacBook Pro to run a Product Manager there.' })
  })

  it('is refused off the Swarm\'s Machines list', () => {
    expect(refusal(() => swarm().lead('elsewhere'))?.code).toBe('MACHINE_NOT_LISTED')
  })

  it('is the project owner\'s to start: not a teammate\'s, nor an agent\'s', () => {
    const f = swarm()
    expect(refusal(() => f.lead('owner-mac', {}, mate))?.code).toBe('NOT_FOUND')
    f.run({ type: 'project.sharing', projectId: f.app.projectId, visibility: 'public', memberIds: [] })
    expect(refusal(() => f.lead('owner-mac', {}, mate))?.code).toBe('PROJECT_OWNER_REQUIRED')
    expect(f.state.starts ?? []).toEqual([])
  })

  it('needs the repository when the project has none yet', () => {
    const f = swarm()
    expect(refusal(() => f.lead('owner-mac', { repositoryUrl: undefined }))?.code).toBe('REPOSITORY_REQUIRED')
  })

  it('starts one Product Manager at a time', () => {
    const f = swarm()
    f.lead('owner-mac')
    expect(refusal(() => f.lead('mate-mac'))?.code).toBe('LEAD_STARTING')
  })

  it('is the only way to mark a start as a Product Manager\'s: an agent.start naming it is refused', () => {
    const request = { conversationId: 'c', machineId: 'm', engine: 'claude', name: 'PM', cwd: '/x', worktree: true,
      requirements: { memoryBytes: 0, diskBytes: 0, maxCpuPercent: 100, tools: [], devices: [], quotaRequired: false } }
    expect(commandSchema.safeParse({ type: 'agent.start', request }).success).toBe(true)
    expect(commandSchema.safeParse({ type: 'agent.start', request: { ...request, leadFor: { projectId: 'p', personId: 'owner', generation: 'g' } } }).success).toBe(false)
  })
})

describe('a Product Manager\'s start, once its host reports it', () => {
  /** The host of [machineId] acting for the start's requester, as the store's host route does (store.ts poolHostActor). */
  const hosted = (f: ReturnType<typeof swarm>, machineId: string) => ({ contribution: { machineOwnerId: f.machine(machineId).contributorId,
    contributorId: f.machine(machineId).contributorId, hostGrant: null } })
  const messages = (effects: ReturnType<ReturnType<typeof swarm>['run']>, conversationId: string) =>
    effects.messages.filter(m => m.conversationId === conversationId).map(m => m.text)

  it('running, becomes the project\'s Lead and says on which machine', () => {
    const f = swarm()
    const startId = f.lead('mate-mac').result.startId as string
    const joined = f.run({ type: 'agent.started', startId, harnessId: 'pm', configuration: config }, owner, hosted(f, 'mate-team'))
    const agentId = joined.result.agentId as string
    const home = f.state.conversations.find(c => c.id === f.app.conversationId)!
    expect(home).toMatchObject({ leadId: agentId, agentIds: [agentId] })
    expect(f.state.agents.find(a => a.id === agentId)).toMatchObject({ machineId: 'mate-team', machineOwnerId: 'mate', projectId: f.app.projectId })
    expect(messages(joined, f.app.conversationId)).toEqual(['Product Manager started on MacBook Pro.'])
    expect(f.project().lead).toMatchObject({ status: 'started', machineId: 'mate-team', machineName: 'MacBook Pro' })
    // Settling it does not call the Product Manager ready for an assignment.
    const settled = f.run({ type: 'agent.startSettled', startId, warning: null }, owner, hosted(f, 'mate-team'))
    expect(messages(settled, f.app.conversationId)).toEqual([])
  })

  it('failed on the machine the person chose, says why and waits for them', () => {
    const f = swarm()
    const startId = f.lead('mate-mac').result.startId as string
    f.run({ type: 'agent.startFailed', startId, error: 'Could not clone the repository.' }, owner, hosted(f, 'mate-team'))
    expect(f.project().lead).toMatchObject({ status: 'failed', reason: 'Could not clone the repository.' })
    // They can start it again.
    expect(f.lead('owner-mac').result.machineId).toBe('owner-mac')
  })

  it('never taken by its machine, fails as a Buddy\'s does', async () => {
    const { sweepLiveness, BUDDY_PICKUP_MS } = await import('./liveness.js')
    const f = swarm()
    f.lead('mate-mac')
    f.machine('mate-team').observation = { ...f.machine('mate-team').observation!, receivedAt: NOW + BUDDY_PICKUP_MS + MINUTE }
    sweepLiveness(f.state, NOW + BUDDY_PICKUP_MS + MINUTE)
    expect(f.project().lead).toMatchObject({ status: 'failed', reason: 'MacBook Pro did not start this Product Manager. Update Harness on it, then start it again.' })
  })
})
