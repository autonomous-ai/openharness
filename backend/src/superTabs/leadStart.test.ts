import { describe, expect, it } from 'vitest'
import { applyCommand, commandSchema, type Command, type CommandContext } from './commands.js'
import type { ContributedMachine } from './machines.js'
import { storedTask } from './storedWork.test-support.js'
import { createSuperTab, SuperTabError, type Actor, type AgentConfiguration, type SuperTabState } from './model.js'

// A project's Product Manager started by the Swarm on the machine its person names (Dee, 10-29, option B). Swarm v3 (task
// #4120, the PM's ruling): that is its person's own computer, never another person's.

const NOW = 50_000_000
const MINUTE = 60_000
const owner: Extract<Actor, { kind: 'person' }> = { kind: 'person', userId: 'owner', email: 'owner@example.com' }
const mate: Extract<Actor, { kind: 'person' }> = { kind: 'person', userId: 'mate', email: 'mate@example.com' }
const config: AgentConfiguration = { engine: 'claude', model: 'opus', effort: 'high', contextWindow: null, engineVersion: null }
const resources = { cpuPercent: 1, memoryTotalBytes: 64e9, memoryUsedBytes: 1e9, diskFreeBytes: 8, diskTotalBytes: 8, projectDiskFreeBytes: 8,
  deviceType: null, chip: null, os: null, gpuPercent: null }
const REPO = 'https://github.com/example/app'
type Reading = NonNullable<ContributedMachine['observation']>
/** A reading as the store keeps it, from a host that starts Product Managers unless [capable] is false. */
const reading = (capable = true): Reading => ({
  generation: 'g1', receivedAt: NOW, resources, tools: {}, quotas: [], runningHarnessIds: [], stoppedHarnessIds: [],
  ...(capable ? { capabilities: ['leadStart'] } : {}) })
const refusal = (body: () => unknown): SuperTabError | null => {
  try { body(); return null } catch (error) { if (error instanceof SuperTabError) return error; throw error }
}

/** The owner's Swarm with the owner's project App: the owner's Mac, and the teammate's MacBook. */
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
  const pool = (machineId: string, contributorId: string, name: string, observation: Reading, extra: Partial<ContributedMachine> = {}): ContributedMachine => ({
    machineId, name, contributorId, membershipGeneration: generation(contributorId), generation: 'g1', cwd: '/swarm', scope: 'swarm',
    engines: ['claude', 'codex'], maxAgents: 4, paused: false, observation, ...extra })
  state.machines = [
    pool('owner-mac', 'owner', 'Owner Mac', reading()),
    pool('mate-mac', 'mate', 'MacBook Pro', reading()),
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
    // Memory and disk gate it; CPU is one momentary sample, so a busy machine admits it as it does a routed Builder (Diego, 10-30).
    expect(f.state.starts![0]!.request.requirements).toEqual({ memoryBytes: 2 * 1024 ** 3, diskBytes: 1024 ** 3, maxCpuPercent: 100, tools: ['git'], devices: [], quotaRequired: false })
    expect(f.project().lead).toMatchObject({ status: 'starting', machineId: 'owner-mac', machineName: 'Owner Mac', startId: started.result.startId })
    // The repository it clones, recorded for the project.
    expect(f.project().repository).toEqual({ machineId: 'owner-mac', cwd: `/swarm/${f.app.projectId}`, repositoryUrl: REPO })
  })

  it('on a teammate\'s Mac, is refused: it starts only on its person\'s own computer, and records nothing', () => {
    const f = swarm()
    expect(refusal(() => f.lead('mate-mac'))).toMatchObject({ code: 'NOT_YOUR_COMPUTER', status: 403 })
    expect(f.state.starts ?? []).toEqual([])
    expect(f.project().lead).toBeUndefined()
  })

  it('is refused on a machine whose Harness is too old to start a Product Manager', () => {
    const f = swarm()
    f.machine('owner-mac').observation = reading(false)
    expect(refusal(() => f.lead('owner-mac'))).toMatchObject({ code: 'HOST_OUTDATED',
      message: 'Update Harness on Owner Mac to run a Product Manager there.' })
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

  it('is refused on a machine whose person left the Swarm, or while it is being removed, and records nothing', () => {
    const left = swarm()
    left.run({ type: 'member.remove', userId: 'mate' })
    expect(refusal(() => left.lead('mate-mac'))?.code).toBe('CONTRIBUTION_REVOKED')
    expect(left.state.starts ?? []).toEqual([])
    const removing = swarm()
    removing.machine('owner-mac').removal = { id: 'r1', state: 'cleaning', requestedAt: new Date(NOW).toISOString() }
    expect(refusal(() => removing.lead('owner-mac'))?.code).toBe('MACHINE_REMOVED')
    expect(removing.state.starts ?? []).toEqual([])
  })

  it('refuses a private project it cannot read exactly as one that does not exist, naming neither', () => {
    const f = swarm()
    const hidden = refusal(() => f.lead('mate-mac', {}, mate))
    const unknown = refusal(() => f.run({ type: 'lead.start', projectId: 'no-such-project', machineId: 'mate-mac', engine: 'claude', repositoryUrl: REPO }, mate))
    expect(hidden).toMatchObject({ code: 'NOT_FOUND' })
    expect([unknown?.code, unknown?.status, unknown?.message]).toEqual([hidden?.code, hidden?.status, hidden?.message])
    expect(hidden?.message).not.toContain('App')
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

describe('the Product Manager\'s model and effort (Scholes\'s roadmap, piece 1)', () => {
  const requestOf = (f: ReturnType<typeof swarm>) => f.state.starts!.at(-1)!.request
  it('asks for Claude Opus 5.5 at xhigh when its person names no model', () => {
    const f = swarm()
    f.lead('owner-mac')
    expect(requestOf(f)).toMatchObject({ engine: 'claude', model: 'opus', effort: 'xhigh' })
  })
  it('keeps a model or effort its person named, and leaves a Codex Product Manager on its engine\'s own model', () => {
    const named = swarm()
    named.lead('owner-mac', { model: 'sonnet', effort: 'high' })
    expect(requestOf(named)).toMatchObject({ model: 'sonnet', effort: 'high' })
    const effortOnly = swarm()
    effortOnly.lead('owner-mac', { effort: 'max' })
    expect(requestOf(effortOnly)).toMatchObject({ model: 'opus', effort: 'max' })
    const codex = swarm()
    codex.lead('owner-mac', { engine: 'codex' })
    expect(requestOf(codex)).not.toHaveProperty('model')
    expect(requestOf(codex)).not.toHaveProperty('effort')
  })
  // Task #3022 (Ken, 11-05): a PM runs at high effort or above, whoever starts it.
  it('refuses an effort below high, and changes nothing', () => {
    for (const effort of ['medium', 'low', 'minimal', 'Medium']) {
      const f = swarm()
      expect(refusal(() => f.lead('owner-mac', { effort }))?.code).toBe('EFFORT_TOO_LOW')
      expect(f.state.starts ?? []).toEqual([])
      expect(f.project().lead).toBeUndefined()
    }
    for (const effort of ['high', 'xhigh', 'max']) {
      const f = swarm()
      f.lead('owner-mac', { effort })
      expect(requestOf(f)).toMatchObject({ effort })
    }
  })
})

describe('a Product Manager\'s start, once its host reports it', () => {
  /** The host of [machineId] acting for the start's requester, as the store's host route does (store.ts poolHostActor). */
  const hosted = (f: ReturnType<typeof swarm>, machineId: string) => ({ contribution: { machineOwnerId: f.machine(machineId).contributorId,
    contributorId: f.machine(machineId).contributorId, hostGrant: null } })
  const messages = (effects: ReturnType<ReturnType<typeof swarm>['run']>, conversationId: string) =>
    effects.messages.filter(m => m.conversationId === conversationId).map(m => m.text)

  // Task #2248, both security reviews of #2636: a person set a coordinator by hand while the Swarm was still starting one.
  describe('a start that finishes after a person set another coordinator', () => {
    const late = () => {
      const f = swarm()
      const startId = f.lead('owner-mac').result.startId as string
      const hand = f.run({ type: 'agent.add', conversationId: f.app.conversationId, machineId: 'owner-mac', harnessId: 'by-hand', name: 'Mine',
        configuration: config, lead: true }, owner, { contribution: { machineOwnerId: 'owner', contributorId: 'owner', hostGrant: null } }).result.agentId as string
      const home = () => f.state.conversations.find(c => c.id === f.app.conversationId)!
      const finish = (operation?: string) => f.run({ type: 'agent.started', startId, harnessId: 'pm', configuration: config }, owner, { ...hosted(f, 'owner-mac'), ...(operation ? { operationId: operation } : {}) })
      return { f, startId, hand, home, finish }
    }

    it('never joins: no agent, the chat keeps its coordinator, and the start fails with the reason', () => {
      const t = late()
      const answer = t.finish()
      expect(answer.result.agentId).toBeUndefined()
      expect(answer.result.refused).toMatch(/already/)
      expect(t.f.state.agents.map(a => a.harnessId)).not.toContain('pm')
      expect(t.home()).toMatchObject({ leadId: t.hand, agentIds: [t.hand] })
      expect(t.f.state.starts!.find(s => s.id === t.startId)).toMatchObject({ error: answer.result.refused })
      expect(t.f.state.starts!.find(s => s.id === t.startId)!.harnessId).toBeFalsy()
    })

    it('leaves one row naming its machine, as a system row, and forgets where it was starting', () => {
      const t = late()
      const answer = t.finish()
      const rows = answer.messages.filter(m => m.conversationId === t.f.app.conversationId)
      expect(rows.map(m => m.text)).toEqual(['Product Manager started on Owner Mac, but this project already has Mine as its Product Manager, so it did not join.'])
      expect(rows[0]!.source).toEqual({ kind: 'system', machine: 'Owner Mac' })
      expect(rows[0]!.recipients).toEqual([])
      expect(t.f.project().lead).toBeUndefined()
    })

    it('a second report fails as any failed start does, with no second row', () => {
      const t = late()
      t.finish()
      expect(() => t.finish()).toThrow('This start failed')
    })

    it('takes over when the coordinator set by hand has left', () => {
      const t = late()
      Object.assign(t.home(), { leadId: null, agentIds: [] })
      const pm = t.finish().result.agentId as string
      expect(t.home()).toMatchObject({ leadId: pm, agentIds: [pm] })
    })

    it('leaves the PM switch working on the coordinator it left in place', () => {
      const t = late()
      t.finish()
      t.f.machine('owner-mac').observation!.capabilities = ['leadSwitch']
      t.f.run({ type: 'lead.switch', projectId: t.f.app.projectId, engine: 'codex', profileId: 'default' })
      expect(t.f.state.agents.find(a => a.id === t.hand)!.switchRequest).toMatchObject({ engine: 'codex', requestedBy: 'owner' })
    })

    it('a first start with nobody set joins and leads, as before', () => {
      const f = swarm()
      const startId = f.lead('owner-mac').result.startId as string
      const pm = f.run({ type: 'agent.started', startId, harnessId: 'pm', configuration: config }, owner, hosted(f, 'owner-mac')).result.agentId as string
      expect(f.state.conversations.find(c => c.id === f.app.conversationId)).toMatchObject({ leadId: pm, agentIds: [pm] })
      expect(f.project().lead).toMatchObject({ status: 'started' })
    })
  })

  it('says when it runs another model or effort than it asked for, and nothing when it cannot tell', () => {
    const joinedWith = (configuration: AgentConfiguration) => {
      const f = swarm()
      const startId = f.lead('owner-mac').result.startId as string
      return messages(f.run({ type: 'agent.started', startId, harnessId: 'pm', configuration }, owner, hosted(f, 'owner-mac')), f.app.conversationId)
    }
    expect(joinedWith({ ...config, model: 'claude-sonnet-5-5', effort: 'high' })).toEqual(
      ['Product Manager started on Owner Mac. It asked for opus at xhigh and runs claude-sonnet-5-5 at high there.'])
    expect(joinedWith({ ...config, model: 'claude-opus-5-5', effort: 'high' })).toEqual(
      ['Product Manager started on Owner Mac. It asked for opus at xhigh and runs claude-opus-5-5 at high there.'])
    expect(joinedWith({ ...config, model: 'claude-opus-5-5', effort: 'xhigh' })).toEqual(['Product Manager started on Owner Mac.'])
    expect(joinedWith({ ...config, model: 'claude-opus-5-5[1m]', effort: 'auto' })).toEqual(['Product Manager started on Owner Mac.'])
    expect(joinedWith({ ...config, model: null, effort: null })).toEqual(['Product Manager started on Owner Mac.'])
  })

  it('running, becomes the project\'s Lead and says on which machine', () => {
    const f = swarm()
    const startId = f.lead('owner-mac').result.startId as string
    const joined = f.run({ type: 'agent.started', startId, harnessId: 'pm', configuration: { ...config, effort: 'xhigh' } }, owner, hosted(f, 'owner-mac'))
    const agentId = joined.result.agentId as string
    const home = f.state.conversations.find(c => c.id === f.app.conversationId)!
    expect(home).toMatchObject({ leadId: agentId, agentIds: [agentId] })
    expect(f.state.agents.find(a => a.id === agentId)).toMatchObject({ machineId: 'owner-mac', machineOwnerId: 'owner', projectId: f.app.projectId })
    expect(messages(joined, f.app.conversationId)).toEqual(['Product Manager started on Owner Mac.'])
    expect(f.project().lead).toMatchObject({ status: 'started', machineId: 'owner-mac', machineName: 'Owner Mac' })
    // Settling it does not call the Product Manager ready for an assignment.
    const settled = f.run({ type: 'agent.startSettled', startId, warning: null }, owner, hosted(f, 'owner-mac'))
    expect(messages(settled, f.app.conversationId)).toEqual([])
  })

  it('failed on the machine the person chose, says why and waits for them', () => {
    const f = swarm()
    const startId = f.lead('owner-mac').result.startId as string
    f.run({ type: 'agent.startFailed', startId, error: 'Could not clone the repository.' }, owner, hosted(f, 'owner-mac'))
    // Every reader of the project reads it, so not the host's own words (startFailure.ts publicReason).
    expect(f.project().lead).toMatchObject({ status: 'failed', reason: 'Its machine could not prepare or launch it.' })
    // They can start it again.
    expect(f.lead('owner-mac').result.machineId).toBe('owner-mac')
  })

  it('never taken by its machine, fails', async () => {
    const { sweepLiveness, PM_PICKUP_MS } = await import('./liveness.js')
    const f = swarm()
    const { chatId } = f.lead('owner-mac').result as { chatId: string }
    f.machine('owner-mac').observation = { ...f.machine('owner-mac').observation!, receivedAt: NOW + PM_PICKUP_MS + MINUTE }
    const said = sweepLiveness(f.state, NOW + PM_PICKUP_MS + MINUTE)
    expect(f.project().lead).toMatchObject({ status: 'failed', reason: 'Its machine did not start it. Harness there may need an update.' })
    // Said once in its project's conversation, in the name of the person who asked for it, and in their chat with it (pmChat.ts).
    // A system row of its project's conversation, not the asker's own words.
    expect(said.map(m => [m.conversationId, m.source])).toEqual([[f.app.conversationId, { kind: 'system' }], [chatId, { kind: 'system' }]])
    expect(said[0]!.text).toBe('Could not start Product Manager: its machine did not start it. Harness there may need an update.')
    expect(sweepLiveness(f.state, NOW + PM_PICKUP_MS + 2 * MINUTE)).toEqual([])
  })
})

describe('the machine a Product Manager starts on', () => {
  it('is always named by its person: with none named it is refused, and nothing is recorded', () => {
    const f = swarm()
    expect(refusal(() => f.lead(null))).toMatchObject({ code: 'MACHINE_REQUIRED', status: 400, message: 'Choose the machine the Product Manager runs on.' })
    expect(f.state.starts ?? []).toEqual([])
    expect(f.project().lead).toBeUndefined()
  })

  it('full, refuses it rather than placing it on another', () => {
    const f = swarm()
    f.machine('owner-mac').observation!.resources.memoryUsedBytes = 64e9
    expect(refusal(() => f.lead('owner-mac'))?.code).toBe('MACHINE_FULL')
    expect(f.state.starts ?? []).toEqual([])
  })
})

describe('the terminal of a Product Manager on its owner\'s own machine', () => {
  /** Its Product Manager running on [machineId], started there. */
  function running(machineId: string) {
    const f = swarm()
    // Public, so the teammate reads the project as every member does.
    f.run({ type: 'project.sharing', projectId: f.app.projectId, visibility: 'public', memberIds: [] })
    const startId = f.lead(machineId).result.startId as string
    const pool = f.state.starts!.find(s => s.id === startId)!.request.machineId
    const contribution = { machineOwnerId: f.machine(pool).contributorId, contributorId: f.machine(pool).contributorId, hostGrant: null }
    const pm = f.run({ type: 'agent.started', startId, harnessId: 'pm', configuration: config }, owner, { contribution }).result.agentId as string
    const screen = (actor: Actor) => refusal(() => f.run({ type: 'agent.screen', agentId: pm, scrollback: 50 }, actor))?.code ?? 'ok'
    const input = (actor: Actor) => refusal(() => f.run({ type: 'agent.input', agentId: pm, text: 'ls ~' }, actor))?.code ?? 'ok'
    return { screen, input }
  }

  it('on the project owner\'s own machine, its owner still reads and types in it', () => {
    const t = running('owner-mac')
    expect(t.screen(owner)).toBe('ok')
    expect(t.input(owner)).toBe('ok')
    expect(t.input(mate)).toBe('TERMINAL_PRIVATE')
  })
})

// The trust change Ken chose (10-29): a teammate's Mac runs the Product Manager in its owner's own account. That owner can
// read whatever the Product Manager reads on their Mac. Project members watch its terminal live whichever account it runs in
// (Lead's ruling on #2228).
describe('the terminal of a Product Manager on a teammate\'s Mac, as its owner', () => {
  /** From before Swarm v3, which starts none there now (task #4120): a Product Manager on the teammate's Mac, as its owner. */
  async function running(visibility: 'private' | 'public') {
    const f = swarm()
    if (visibility === 'public') f.run({ type: 'project.sharing', projectId: f.app.projectId, visibility: 'public', memberIds: [] })
    const pm = 'pm'
    f.state.agents.push({ id: pm, machineId: 'mate-mac', harnessId: 'pm', projectId: f.app.projectId, machineOwnerId: 'mate', contributorId: 'mate',
      membershipGeneration: f.state.people.find(p => p.id === 'mate')!.generation, hostGrant: null, name: 'PM', configuration: config } as never)
    const home = f.state.conversations.find(c => c.id === f.app.conversationId)!
    home.agentIds.push(pm); home.leadId = pm
    const { canWatchAgent } = await import('./projects.js')
    const agent = f.state.agents.find(a => a.id === pm)!
    const code = (actor: Actor, command: Command) => refusal(() => f.run(command, actor))?.code ?? 'ok'
    return { agent, watch: (actor: Actor) => canWatchAgent(f.state, actor, agent),
      screen: (actor: Actor) => code(actor, { type: 'agent.screen', agentId: pm, scrollback: 50 }),
      input: (actor: Actor) => code(actor, { type: 'agent.input', agentId: pm, text: 'ls ~' }) }
  }

  it('its project\'s owner watches its terminal live, but neither types in it nor reads its screen in another person\'s account', async () => {
    for (const visibility of ['private', 'public'] as const) {
      const t = await running(visibility)
      expect(t.watch(owner)).toBe(true)
      expect(t.screen(owner)).toBe('TERMINAL_PRIVATE')
      expect(t.input(owner)).toBe('TERMINAL_PRIVATE')
    }
  })

  it('the Mac\'s owner reaches it through the Swarm only when they may read the project: a private one they are not in shows them nothing', async () => {
    const hidden = await running('private')
    expect(hidden.watch(mate)).toBe(false)
    expect(hidden.screen(mate)).toBe('AGENT_UNAVAILABLE')
    expect(hidden.input(mate)).toBe('AGENT_UNAVAILABLE')
    const open = await running('public')
    expect(open.watch(mate)).toBe(true)
    expect(open.screen(mate)).toBe('ok')
    expect(open.input(mate)).toBe('ok')
  })
})

describe('a machine hosting a Product Manager', () => {
  it('leaves the project owner\'s own machine as it is', () => {
    const f = swarm()
    f.lead('owner-mac')
    const web = f.run({ type: 'project.create', name: 'Web', visibility: 'public', brief: '' }).result as { projectId: string }
    const group = storedTask(f.state, { projectId: web.projectId, title: 'Work', brief: 'Build it.' })
    expect(f.run({ type: 'agent.start', request: { conversationId: group, machineId: 'owner-mac', engine: 'claude', name: 'Builder', cwd: `/swarm/${web.projectId}`,
      worktree: true, requirements: { memoryBytes: 0, diskBytes: 0, maxCpuPercent: 100, tools: [], devices: [], quotaRequired: false } } }, owner,
      { contribution: { machineOwnerId: 'owner', contributorId: 'owner', hostGrant: null } }).result.startId).toBeTruthy()
  })
})

// Security reviews of #2705 (destination access): moving a running Product Manager to another machine is a new start there, so it
// follows a new start's placement, recorded as the person who asked, and only the project's owner asks it. With Swarm v3 that is
// only another of its person's own computers (task #4120).
describe('moving a running Product Manager to another machine', () => {
  const contributionOf = (machineOwnerId: string) => ({ contribution: { machineOwnerId, contributorId: machineOwnerId, hostGrant: null } })
  /** The owner's Swarm with its Product Manager running on [on], every host able to start and switch one. */
  const moving = (on = 'owner-mac', prepare: (f: ReturnType<typeof swarm>) => void = () => {}) => {
    const f = swarm()
    // A project the teammate reads, so its refusals are about who may move it, not who may see it.
    f.project().visibility = 'public'
    // A second computer of the owner's own, where a move may go.
    f.state.machines!.push({ ...structuredClone(f.machine('owner-mac')), machineId: 'owner-mini', name: 'Owner Mini' })
    for (const pool of f.state.machines!) pool.observation = { ...pool.observation!, capabilities: ['leadStart', 'leadSwitch'] }
    prepare(f)
    const startId = f.lead(on).result.startId as string
    const machineOwnerId = f.machine(on).contributorId
    const pm = f.run({ type: 'agent.started', startId, harnessId: 'pm-1', configuration: config }, owner, contributionOf(machineOwnerId)).result.agentId as string
    f.run({ type: 'agent.startSettled', startId, warning: null }, owner, contributionOf(machineOwnerId))
    const move = (machineId: string, actor: Actor = owner, context: Partial<CommandContext> = {}) =>
      f.run({ type: 'lead.switch', projectId: f.app.projectId, engine: 'claude', profileId: 'default', machineId } as Command, actor, context)
    const candidates = () => (f.state.starts ?? []).filter(s => s.request.leadFor?.switchId)
    const agent = () => f.state.agents.find(a => a.id === pm)!
    return { f, pm, move, candidates, agent }
  }

  it('moves to another of its person\'s own computers, recorded as the person who asked', () => {
    const s = moving()
    s.move('owner-mini')
    expect(s.candidates()).toEqual([expect.objectContaining({ actorKey: 'person:owner', machineOwnerId: 'owner',
      request: expect.objectContaining({ machineId: 'owner-mini', leadFor: expect.objectContaining({ personId: 'owner', switchId: s.agent().switchRequest!.id }) }) })])
    expect(s.agent().switchRequest).toMatchObject({ targetMachineId: 'owner-mini', requestedBy: 'owner' })
  })

  it('refuses a teammate\'s Mac, and records nothing', () => {
    const s = moving()
    expect(refusal(() => s.move('mate-mac'))?.code).toBe('NOT_YOUR_COMPUTER')
    expect(s.candidates()).toEqual([])
    expect(s.agent().switchRequest).toBeUndefined()
  })

  it('refuses a member who owns neither the project nor the PM\'s machine', () => {
    const s = moving()
    expect(refusal(() => s.move('mate-mac', mate))?.code).toBe('PROJECT_OWNER_REQUIRED')
    expect(s.candidates()).toEqual([])
  })

  it('refuses a machine that is not in the Swarm, withdrawn or too old to switch, and records nothing', () => {
    const unlisted = moving()
    expect(refusal(() => unlisted.move('nowhere'))?.code).toBe('MACHINE_NOT_LISTED')
    const withdrawn = moving()
    withdrawn.f.machine('owner-mini').membershipGeneration = 'an earlier membership'
    expect(refusal(() => withdrawn.move('owner-mini'))?.code).toBe('CONTRIBUTION_REVOKED')
    const old = moving()
    old.f.machine('owner-mini').observation = { ...old.f.machine('owner-mini').observation!, capabilities: ['leadStart'] }
    const lead = structuredClone(old.f.project().lead)
    expect(refusal(() => old.move('owner-mini'))?.code).toBe('HOST_OUTDATED')
    for (const s of [unlisted, withdrawn, old]) {
      expect(s.candidates()).toEqual([])
      expect(s.agent().switchRequest).toBeUndefined()
    }
    expect(old.f.project().lead).toEqual(lead)
  })
})
