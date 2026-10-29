import { afterEach, describe, expect, it } from 'vitest'
import { applyCommand, commandSchema, type Command, type CommandContext } from './commands.js'
import type { ContributedMachine, MachinePrivacy } from './machines.js'
import type { LeadContext } from './leadStart.js'
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
    // Every reader of the project reads it, so not the host's own words (startFailure.ts publicReason).
    expect(f.project().lead).toMatchObject({ status: 'failed', reason: 'Its machine could not prepare or launch it.' })
    // They can start it again.
    expect(f.lead('owner-mac').result.machineId).toBe('owner-mac')
  })

  it('never taken by its machine, fails as a Buddy\'s does', async () => {
    const { sweepLiveness, BUDDY_PICKUP_MS } = await import('./liveness.js')
    const f = swarm()
    f.lead('mate-mac')
    f.machine('mate-team').observation = { ...f.machine('mate-team').observation!, receivedAt: NOW + BUDDY_PICKUP_MS + MINUTE }
    const said = sweepLiveness(f.state, NOW + BUDDY_PICKUP_MS + MINUTE)
    expect(f.project().lead).toMatchObject({ status: 'failed', reason: 'Its machine did not start it. Harness there may need an update.' })
    // Said once in its project's conversation, in the name of the person who asked for it.
    // A system row of its project's conversation, not the asker's own words.
    expect(said.map(m => [m.conversationId, m.source])).toEqual([[f.app.conversationId, { kind: 'system' }]])
    expect(said[0]!.text).toBe('Could not start Product Manager: its machine did not start it. Harness there may need an update.')
    expect(sweepLiveness(f.state, NOW + BUDDY_PICKUP_MS + 2 * MINUTE)).toEqual([])
  })
})

describe('a Product Manager waiting for a machine', () => {
  const full = (f: ReturnType<typeof swarm>, machineId: string) => { f.machine(machineId).maxAgents = 0 }
  const place = async (f: ReturnType<typeof swarm>, context: Partial<LeadContext> = {}) => {
    const { placeWaitingLeads } = await import('./leadStart.js')
    // Placed on a machine's reading: the machines report as of then.
    for (const m of f.state.machines!) if (m.observation) m.observation = { ...m.observation, receivedAt: context.now ?? NOW }
    const teamMachines = f.state.machines!.filter(m => m.observation?.sessionKind === 'team').map(m => m.machineId)
    return placeWaitingLeads(f.state, { now: NOW, teamMachines, ...context })
  }

  it('starts at once on a free machine, the project owner\'s own first', () => {
    const f = swarm()
    const asked = f.lead(null)
    expect(asked.result).toMatchObject({ machineId: 'owner-mac' })
    expect(f.project().lead).toMatchObject({ status: 'starting', chosen: null, machineId: 'owner-mac' })
  })

  it('then the free Team machine', () => {
    const f = swarm()
    full(f, 'owner-mac')
    expect(f.lead(null).result).toMatchObject({ machineId: 'mate-team' })
  })

  it('with none free, waits and says so, then starts on the first one that frees up', async () => {
    const f = swarm()
    full(f, 'owner-mac')
    f.machine('mate-team').observation = reading('team', FAILED)
    const asked = f.lead(null)
    expect(asked.result).toMatchObject({ waiting: true })
    expect(asked.result).not.toHaveProperty('startId')
    expect(f.state.starts ?? []).toEqual([])
    expect(f.project().lead).toMatchObject({ status: 'waiting', chosen: null })
    expect(asked.messages.map(m => m.text)).toEqual(['Waiting for a machine to start the Product Manager.'])
    // Nothing free yet: nothing changes.
    expect(await place(f)).toEqual([])
    expect(f.project().lead?.status).toBe('waiting')
    f.machine('owner-mac').maxAgents = 4
    expect(await place(f)).toEqual([f.app.projectId])
    expect(f.project().lead).toMatchObject({ status: 'starting', machineId: 'owner-mac', machineName: 'Owner Mac' })
    expect(f.state.starts).toEqual([expect.objectContaining({ actorKey: 'person:owner', request: expect.objectContaining({ machineId: 'owner-mac' }) })])
  })

  it('placed from the queue and failed there, waits for another machine and tries that one last', async () => {
    const f = swarm()
    const startId = f.lead(null).result.startId as string
    f.run({ type: 'agent.startFailed', startId, error: 'Out of disk.' }, owner, { contribution: { machineOwnerId: 'owner', contributorId: 'owner', hostGrant: null } })
    expect(f.project().lead).toMatchObject({ status: 'waiting', reason: 'Its machine could not prepare or launch it.', skipped: ['owner-mac'] })
    expect(await place(f, { now: NOW + MINUTE })).toEqual([f.app.projectId])
    expect(f.project().lead).toMatchObject({ status: 'starting', machineId: 'mate-team' })
  })

  // Security review 1 of #2089: a queued Product Manager that kept failing was placed again at every machine reading, each
  // failure a row in its conversation.
  it('failing again and again, waits longer each time, gives up after three, and says so once', async () => {
    const { LEAD_QUEUE_ATTEMPTS } = await import('./leadStart.js')
    expect(LEAD_QUEUE_ATTEMPTS).toBe(3)
    const f = swarm()
    const fail = (startId: string, now: number) => f.run({ type: 'agent.startFailed', startId, error: 'Out of disk.' }, owner,
      { now, contribution: { machineOwnerId: f.state.starts!.find(s => s.id === startId)!.machineOwnerId, contributorId: f.state.starts!.find(s => s.id === startId)!.contributorId, hostGrant: null } })
    const said = (effects: ReturnType<typeof f.run>) => effects.messages.filter(m => m.conversationId === f.app.conversationId).map(m => m.text)
    let startId = f.lead(null).result.startId as string
    expect(said(fail(startId, NOW))).toEqual([])
    expect(f.project().lead).toMatchObject({ status: 'waiting', failures: 1, retryAt: NOW + MINUTE })
    // Not before its time, then on the next free machine.
    expect(await place(f, { now: NOW + MINUTE - 1 })).toEqual([])
    expect(await place(f, { now: NOW + MINUTE })).toEqual([f.app.projectId])
    startId = f.project().lead!.startId!
    expect(said(fail(startId, NOW + MINUTE))).toEqual([])
    expect(f.project().lead).toMatchObject({ status: 'waiting', failures: 2, retryAt: NOW + 3 * MINUTE })
    expect(await place(f, { now: NOW + 3 * MINUTE })).toEqual([f.app.projectId])
    startId = f.project().lead!.startId!
    expect(said(fail(startId, NOW + 3 * MINUTE))).toEqual(['The Product Manager could not start after 3 tries. The last one: Its machine could not prepare or launch it. Start it again when a machine is ready.'])
    expect(f.project().lead).toMatchObject({ status: 'failed', failures: 3 })
    expect(await place(f, { now: NOW + 60 * MINUTE })).toEqual([])
  })

  it('is dropped when the person who asked left the Swarm, and waits while the Swarm is paused', async () => {
    const f = swarm()
    full(f, 'owner-mac'); full(f, 'mate-team')
    f.lead(null)
    f.machine('owner-mac').maxAgents = 4
    f.state.paused = true
    expect(await place(f)).toEqual([])
    f.state.paused = false
    f.state.people.find(p => p.id === 'owner')!.generation = 'rejoined'
    expect(await place(f)).toEqual([])
    expect(f.project().lead).toMatchObject({ status: 'failed', reason: 'The person who asked for it left the Swarm.' })
  })

  it('asked for again while waiting, takes the new request', () => {
    const f = swarm()
    full(f, 'owner-mac'); full(f, 'mate-team')
    f.lead(null, { model: 'sonnet' })
    f.lead(null, { model: 'opus' })
    expect(f.project().lead).toMatchObject({ status: 'waiting', request: expect.objectContaining({ model: 'opus' }) })
  })
})

// R2 (Lead, #895): a Team account runs every teammate's work as one macOS user, its folders holding other projects' clones.
// Typing in a Product Manager there is a shell that reads them, so nobody types in it through the Swarm; its project's owner
// may watch it, and the Mac's owner neither watches nor types. On the project owner's own machine nothing changes.
describe('the terminal of a Product Manager in a Team account', () => {
  async function running(machineId: string) {
    const f = swarm()
    // Public, so the Mac's owner reads the project as every member does.
    f.run({ type: 'project.sharing', projectId: f.app.projectId, visibility: 'public', memberIds: [] })
    const startId = f.lead(machineId).result.startId as string
    const pool = f.state.starts!.find(s => s.id === startId)!.request.machineId
    const contribution = { machineOwnerId: f.machine(pool).contributorId, contributorId: f.machine(pool).contributorId, hostGrant: null }
    const pm = f.run({ type: 'agent.started', startId, harnessId: 'pm', configuration: config }, owner, { contribution }).result.agentId as string
    const { canWatchAgent } = await import('./projects.js')
    const watch = (actor: Actor) => canWatchAgent(f.state, actor, f.state.agents.find(a => a.id === pm)!)
    const screen = (actor: Actor) => refusal(() => f.run({ type: 'agent.screen', agentId: pm, scrollback: 50 }, actor))?.code ?? 'ok'
    const input = (actor: Actor) => refusal(() => f.run({ type: 'agent.input', agentId: pm, text: 'ls ~' }, actor))?.code ?? 'ok'
    return { f, pm, watch, screen, input }
  }

  it('its project\'s owner watches it but cannot type in it', async () => {
    const t = await running('mate-mac')
    expect(t.watch(owner)).toBe(true)
    expect(t.screen(owner)).toBe('ok')
    expect(t.input(owner)).toBe('TERMINAL_PRIVATE')
  })

  it('the Mac\'s owner neither watches it nor reads or types in it', async () => {
    const t = await running('mate-mac')
    expect(t.watch(mate)).toBe(false)
    expect(t.screen(mate)).toBe('TERMINAL_PRIVATE')
    expect(t.input(mate)).toBe('TERMINAL_PRIVATE')
  })

  it('is known by its machine, however it joined: a Lead added by hand in a Team account is held the same way', () => {
    const f = swarm()
    f.run({ type: 'project.sharing', projectId: f.app.projectId, visibility: 'public', memberIds: [] })
    const home = f.state.conversations.find(c => c.id === f.app.conversationId)!
    f.state.agents.push({ id: 'added-pm', machineId: 'mate-team', harnessId: 'h', projectId: f.app.projectId, machineOwnerId: 'mate', contributorId: 'mate',
      membershipGeneration: f.state.people.find(p => p.id === 'mate')!.generation, hostGrant: null, name: 'PM', configuration: config })
    home.agentIds.push('added-pm'); home.leadId = 'added-pm'
    const code = (actor: Actor, command: Command) => refusal(() => f.run(command, actor))?.code ?? 'ok'
    expect(code(owner, { type: 'agent.screen', agentId: 'added-pm', scrollback: 50 })).toBe('ok')
    expect(code(owner, { type: 'agent.input', agentId: 'added-pm', text: 'ls' })).toBe('TERMINAL_PRIVATE')
    expect(code(mate, { type: 'agent.screen', agentId: 'added-pm', scrollback: 50 })).toBe('TERMINAL_PRIVATE')
  })

  // Security review 2 of #2089: a sibling worker there is the same macOS user, and reads people's chats with it.
  it('while it holds the account, nobody types in any agent there: its project\'s workers neither', async () => {
    const t = await running('mate-mac')
    const group = t.f.run({ type: 'conversation.create', projectId: t.f.app.projectId, title: 'Work', brief: 'Build it.', checks: [] }).result.conversationId as string
    t.f.run({ type: 'agent.add', conversationId: group, machineId: 'mate-team', harnessId: 'sibling', name: 'Sibling', configuration: config, lead: false }, owner,
      { contribution: { machineOwnerId: 'mate', contributorId: 'mate', hostGrant: null } })
    const sibling = t.f.state.agents.find(a => a.harnessId === 'sibling')!.id
    const code = (actor: Actor, command: Command) => refusal(() => t.f.run(command, actor))?.code ?? 'ok'
    expect(code(owner, { type: 'agent.input', agentId: sibling, text: 'cat ~/.claude/projects/*' })).toBe('TERMINAL_PRIVATE')
    expect(code(owner, { type: 'agent.screen', agentId: sibling, scrollback: 50 })).toBe('ok')
  })

  it('stays held when its machine row is gone: the rules never fall back to the old ones', async () => {
    const t = await running('mate-mac')
    expect(t.f.state.agents.find(a => a.id === t.pm)).toMatchObject({ teamAccount: true })
    t.f.state.machines = t.f.state.machines!.filter(m => m.machineId !== 'mate-team')
    expect(t.input(owner)).toBe('TERMINAL_PRIVATE')
    expect(t.screen(mate)).toBe('TERMINAL_PRIVATE')
  })

  it('on the project owner\'s own machine, its owner still reads and types in it', async () => {
    const t = await running('owner-mac')
    expect(t.screen(owner)).toBe('ok')
    expect(t.input(owner)).toBe('ok')
    expect(t.input(mate)).toBe('TERMINAL_PRIVATE')
  })
})

// Every agent in a Team account runs as one macOS user and can read the others' files, the Product Manager's saved
// sessions with people's private chats among them. So a Team account hosting a Product Manager serves only its project.
describe('a Team account hosting a Product Manager', () => {
  const other = (f: ReturnType<typeof swarm>) => {
    const web = f.run({ type: 'project.create', name: 'Web', visibility: 'public', brief: '' }).result as { projectId: string; conversationId: string }
    const group = f.run({ type: 'conversation.create', projectId: web.projectId, title: 'Work', brief: 'Build it.', checks: [] }).result.conversationId as string
    const request = { conversationId: group, machineId: 'mate-mac', engine: 'claude', name: 'Builder', cwd: `/swarm/${web.projectId}`, worktree: true,
      requirements: { memoryBytes: 0, diskBytes: 0, maxCpuPercent: 100, tools: [], devices: [], quotaRequired: false } }
    const pooled = { contribution: { machineOwnerId: 'mate', contributorId: 'mate', hostGrant: null } }
    return { start: () => f.run({ type: 'agent.start', request }, owner, pooled), web }
  }

  it('takes no other project\'s new work while the Product Manager starts or runs there', () => {
    const f = swarm(), web = other(f)
    f.lead('mate-mac')
    expect(refusal(() => web.start())).toMatchObject({ code: 'TEAM_ACCOUNT_HELD',
      message: 'The Harness Team account on MacBook Pro runs another project\'s Product Manager, so it takes only that project\'s work for now.' })
  })

  it('is not where a Product Manager goes while another project\'s agents run there', () => {
    const f = swarm(), web = other(f)
    web.start()
    expect(refusal(() => f.lead('mate-mac'))).toMatchObject({ code: 'TEAM_ACCOUNT_BUSY',
      message: 'The Harness Team account on MacBook Pro runs other projects\' agents, so it cannot host this Product Manager now.' })
    // From the queue it goes to the next free machine instead.
    expect(f.lead(null).result).toMatchObject({ machineId: 'owner-mac' })
  })

  it('holds an agent added by hand as it holds a start', () => {
    const f = swarm()
    const web = f.run({ type: 'project.create', name: 'Web', visibility: 'public', brief: '' }).result as { projectId: string; conversationId: string }
    const add = (conversationId: string, harnessId: string, lead: boolean) => f.run({ type: 'agent.add', conversationId, machineId: 'mate-team', harnessId,
      name: harnessId, configuration: config, lead }, mate, { contribution: { machineOwnerId: 'mate', contributorId: 'mate', hostGrant: null } })
    f.lead('mate-mac')
    expect(refusal(() => add(web.conversationId, 'web-worker', false))?.code).toBe('TEAM_ACCOUNT_HELD')
    // The other way round: another project's agent there first, a Product Manager added by hand is refused.
    const g = swarm()
    const web2 = g.run({ type: 'project.create', name: 'Web', visibility: 'public', brief: '' }).result as { projectId: string; conversationId: string }
    const group = g.run({ type: 'conversation.create', projectId: web2.projectId, title: 'Work', brief: 'Build it.', checks: [] }).result.conversationId as string
    const pooled = { contribution: { machineOwnerId: 'mate', contributorId: 'mate', hostGrant: null } }
    g.run({ type: 'agent.add', conversationId: group, machineId: 'mate-team', harnessId: 'web-worker', name: 'W', configuration: config, lead: false }, mate, pooled)
    expect(refusal(() => g.run({ type: 'agent.add', conversationId: g.app.conversationId, machineId: 'mate-team', harnessId: 'pm', name: 'PM',
      configuration: config, lead: true }, owner, pooled))?.code).toBe('TEAM_ACCOUNT_BUSY')
    // And one added by hand there is marked as in a Team account.
    expect(g.state.agents.find(a => a.harnessId === 'web-worker')).toMatchObject({ teamAccount: true })
  })

  it('leaves the project owner\'s own machine as it is', () => {
    const f = swarm()
    f.lead('owner-mac')
    const web = f.run({ type: 'project.create', name: 'Web', visibility: 'public', brief: '' }).result as { projectId: string }
    const group = f.run({ type: 'conversation.create', projectId: web.projectId, title: 'Work', brief: 'Build it.', checks: [] }).result.conversationId as string
    expect(f.run({ type: 'agent.start', request: { conversationId: group, machineId: 'owner-mac', engine: 'claude', name: 'Builder', cwd: `/swarm/${web.projectId}`,
      worktree: true, requirements: { memoryBytes: 0, diskBytes: 0, maxCpuPercent: 100, tools: [], devices: [], quotaRequired: false } } }, owner,
      { contribution: { machineOwnerId: 'owner', contributorId: 'owner', hostGrant: null } }).result.startId).toBeTruthy()
  })
})
