import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { applyCommand, commandSchema, type Command, type CommandContext } from './commands.js'
import { machineTeamWork, teamWorkRefusal, type ContributedMachine, type MachinePrivacy } from './machines.js'
import { createSuperTab, SuperTabError, visibleState, type Actor, type AgentConfiguration, type SuperTabState } from './model.js'

// Task #2806 (Scholes, 11-04): the machine's owner, and nobody else, records whether teammates' work may run in their own
// account. Swarm v3 has no Team accounts (task #4120): a person's own agent works any project they read in their own account,
// and no start moves to a Team account, so the choice no longer moves a start. What stays here is the choice itself, who may
// set it and how routing reads it. Everything runs with Team accounts required everywhere, the strictest setting.
beforeEach(() => { process.env.SWARM_TEAM_ACCOUNT_REQUIRED = '1' })
afterEach(() => { delete process.env.SWARM_TEAM_ACCOUNT_REQUIRED })

const NOW = 50_000_000
const owner: Extract<Actor, { kind: 'person' }> = { kind: 'person', userId: 'owner', email: 'owner@example.com' }
const gray: Extract<Actor, { kind: 'person' }> = { kind: 'person', userId: 'gray', email: 'gray@example.com' }
const mate: Extract<Actor, { kind: 'person' }> = { kind: 'person', userId: 'mate', email: 'mate@example.com' }
const config: AgentConfiguration = { engine: 'codex', model: 'fixture-model', effort: 'high', contextWindow: 200000, engineVersion: 'fixture' }
const requirements = { memoryBytes: 0, diskBytes: 0, maxCpuPercent: 100, tools: [], devices: [], quotaRequired: false }
const resources = { cpuPercent: 1, memoryTotalBytes: 8, memoryUsedBytes: 1, diskFreeBytes: 8, diskTotalBytes: 8, projectDiskFreeBytes: 8,
  deviceType: null, chip: null, os: null, gpuPercent: null }
const PASSED: MachinePrivacy = { mode: 'account', passed: true, checkedAt: NOW - 60_000 }
type Reading = NonNullable<ContributedMachine['observation']>
const reading = (sessionKind: 'team' | 'computer', privacy?: MachinePrivacy): Reading => ({ generation: 'g1', receivedAt: NOW, sessionKind, resources,
  tools: {}, quotas: [], runningHarnessIds: [], stoppedHarnessIds: [], ...(privacy ? { privacy: { ...privacy, seenAt: NOW } } : {}) })
const refusal = (body: () => unknown): SuperTabError | null => {
  try { body(); return null } catch (error) { if (error instanceof SuperTabError) return error; throw error }
}

/** The owner's Swarm with two teammates. Gray's Mac was added as Gray joined (teamAccountOnly), with its Harness Team account,
 *  whose privacy check passed. Projects: the owner's 'lead', and Gray's own. */
function swarm() {
  let state: SuperTabState = createSuperTab('tab', 'Pilot', { id: 'owner', email: owner.email }, 'prod')
  let sequence = 0
  const run = (command: Command, actor: Actor = owner, context: Partial<CommandContext> = {}) => {
    const teamMachines = (state.machines ?? []).filter(m => m.observation?.sessionKind === 'team').map(m => m.machineId)
    const effects = applyCommand(state, actor, command, { now: NOW, operationId: `op-${++sequence}`, teamMachines, ...context })
    state = effects.state
    return effects
  }
  for (const person of [gray, mate]) {
    const invited = run({ type: 'invite.create', email: person.email, role: 'collaborator', conversationId: 'lead' })
    run({ type: 'invite.accept', inviteId: invited.result.inviteId as string }, person)
  }
  const generation = (userId: string) => state.people.find(p => p.id === userId)!.generation
  const joined = { contribution: { machineOwnerId: 'gray', contributorId: 'gray', hostGrant: null } }
  // As Desktop adds it when Gray joins: teammates' work only through its Team account.
  run({ type: 'machine.contribute', machineId: 'gray-mac', name: 'Gray\'s Mac', cwd: '/swarm', scope: 'swarm', engines: ['codex'], maxAgents: 4,
    teamAccountOnly: true }, gray, joined)
  state.machines!.find(m => m.machineId === 'gray-mac')!.observation = reading('computer')
  state.machines!.push({ machineId: 'gray-team', name: 'Gray\'s Mac', contributorId: 'gray', membershipGeneration: generation('gray'), generation: 'g1',
    cwd: '/team-swarm', scope: 'swarm', engines: ['codex'], maxAgents: 4, paused: false, hostMachineId: 'gray-mac', observation: reading('team', PASSED) })
  state.machines!.push({ machineId: 'owner-mac', name: 'Owner Mac', contributorId: 'owner', membershipGeneration: generation('owner'), generation: 'g1',
    cwd: '/swarm', scope: 'swarm', engines: ['codex'], maxAgents: 4, paused: false, observation: reading('computer') })
  const grays = String(run({ type: 'project.create', name: 'Gray\'s', visibility: 'public', brief: '' }, gray).result.projectId)
  // The project's Lead (the PM), on the owner's Mac.
  const leadId = String(run({ type: 'agent.add', conversationId: 'lead', machineId: 'owner-mac', harnessId: 'lead', name: 'Lead', configuration: config, lead: true },
    owner, { contribution: { machineOwnerId: 'owner', contributorId: 'owner' } }).result.agentId)
  const leadActor: Actor = { kind: 'agent', agentId: leadId, machineOwnerId: 'owner' }
  const group = (projectId = 'lead', actor: Actor = owner) => String(run({ type: 'conversation.create', projectId, title: 'Work', brief: 'Build it.',
    checks: [] }, actor).result.conversationId)
  const machine = (machineId: string) => state.machines!.find(m => m.machineId === machineId)!
  const request = (conversationId: string, machineId = 'gray-mac', projectId = 'lead') =>
    ({ conversationId, machineId, engine: 'codex', name: 'Builder', cwd: `/swarm/${projectId}`, worktree: true, requirements })
  const start = (conversationId: string, actor: Actor = owner, projectId = 'lead') =>
    run({ type: 'agent.start', request: request(conversationId, 'gray-mac', projectId) }, actor, joined)
  const choose = (allowed: boolean, actor: Actor = gray, machineId = 'gray-mac', context: Partial<CommandContext> = {}, extra: Record<string, unknown> = {}) =>
    run({ type: 'machine.ownAccountWork', machineId, allowed, ...extra } as Command, actor, context)
  /** An agent of the Swarm, run on Gray's Mac by Gray's grant: a Lead, or a Buddy of Gray's. */
  const agent = (id: string, extra: Record<string, unknown> = {}): Actor => {
    state.agents.push({ id, machineId: 'gray-mac', harnessId: `harness-${id}`, projectId: 'lead', machineOwnerId: 'gray', contributorId: 'gray',
      membershipGeneration: generation('gray'), hostGrant: null, name: id, configuration: config, ...extra })
    return { kind: 'agent', agentId: id, machineOwnerId: 'gray' }
  }
  return { run, group, machine, request, start, choose, agent, joined, grays, leadActor, get state() { return state } }
}

describe('teammates\' work in a Mac owner\'s own account', () => {
  it('is off by default, and a teammate\'s own start on their own Mac stays there, never moved to its Team account (task #4120)', () => {
    const f = swarm()
    expect(f.machine('gray-mac').ownAccountChoice).toBeUndefined()
    f.start(f.group(), gray)
    expect(f.state.starts![0]!.request).toMatchObject({ machineId: 'gray-mac', cwd: '/swarm/lead' })
  })

  it('is turned on by the machine\'s owner, recording who and when', () => {
    const f = swarm()
    f.choose(true)
    expect(f.machine('gray-mac').ownAccountChoice).toEqual({ allowed: true, by: 'gray', at: new Date(NOW).toISOString() })
    expect(f.machine('gray-mac').teamAccountOnly).toBe(true)
    // Routing reads it as a machine that takes a teammate's work.
    expect(teamWorkRefusal(f.machine('gray-mac'), NOW)).toBeNull()
    expect(machineTeamWork(f.machine('gray-mac'), NOW, ['gray-team'])).toBeNull()
  })

  it('is changed by nobody but the machine\'s owner: not the Swarm\'s owner, a teammate, an agent or a Buddy', () => {
    const f = swarm()
    const worker = f.agent('gray-worker')
    const buddy = f.agent('gray-buddy', { buddyOf: 'gray', buddyScope: 'swarm' })
    for (const actor of [owner, mate, f.leadActor, worker, buddy]) {
      // A Buddy is refused before the owner check, by the rule that it writes nowhere but its own chat.
      expect(['OWNER_REQUIRED', 'BUDDY_FORBIDDEN'], JSON.stringify(actor)).toContain(refusal(() => f.choose(true, actor))?.code)
    }
    expect(f.machine('gray-mac').ownAccountChoice).toBeUndefined()
    expect(commandSchema.safeParse({ type: 'machine.ownAccountWork', machineId: 'gray-mac', allowed: 'yes' }).success).toBe(false)
  })

  it('is set by the Lead passing on the owner\'s own chat message from the last day, and not on anyone else\'s', () => {
    const f = swarm()
    const askedIn = { askedIn: { conversationId: 'lead', messageId: 'm-gray' } }
    const said = (id: string, createdAt = NOW - 1000) => ({ askedIn: { author: { kind: 'person', id } as never, source: false, createdAt } })
    // The Swarm's owner, a teammate, an old message of Gray's, and a Buddy passing Gray's message on: refused.
    for (const [actor, context] of [[f.leadActor, said('owner')], [f.leadActor, said('mate')], [f.leadActor, said('gray', NOW - 2 * 24 * 60 * 60_000)],
      [f.agent('gray-buddy', { buddyOf: 'gray', buddyScope: 'swarm' }), said('gray')]] as const) {
      expect(['OWNER_REQUIRED', 'BUDDY_FORBIDDEN']).toContain(refusal(() => f.choose(true, actor, 'gray-mac', context, askedIn))?.code)
    }
    expect(f.machine('gray-mac').ownAccountChoice).toBeUndefined()
    // Turning it on loosens a privacy guard: only the owner's own session, which shows the warning (security review 2 of
    // #2981). A Lead passing on even the owner's own message cannot.
    expect(refusal(() => f.choose(true, f.leadActor, 'gray-mac', said('gray'), askedIn))?.code).toBe('OWNER_SESSION_REQUIRED')
    expect(f.machine('gray-mac').ownAccountChoice).toBeUndefined()
    f.choose(true)
    // Turning it off only tightens it: the Lead may, on the owner's own message. Recorded as Gray's choice, whose word it is.
    f.choose(false, f.leadActor, 'gray-mac', said('gray'), askedIn)
    // With the message it passed on, so an audit reads the words behind it (security review 1 of #2981).
    expect(f.machine('gray-mac').ownAccountChoice).toEqual({ allowed: false, by: 'gray', at: new Date(NOW).toISOString(),
      askedIn: { conversationId: 'lead', messageId: 'm-gray' } })
  })

  // Swarm v3 (task #4218): the Mac reads as itself whether the choice is on or not; its Team account takes no new work.
  it('reads the Mac itself, not its Team account, for routing', () => {
    const f = swarm()
    f.machine('gray-team').observation = { ...reading('team', PASSED), privacy: { ...PASSED, seenAt: NOW - 24 * 60 * 60_000 } }
    expect(machineTeamWork(f.machine('gray-mac'), NOW, ['gray-team'])).toBeNull()
    f.choose(true)
    expect(machineTeamWork(f.machine('gray-mac'), NOW, ['gray-team'])).toBeNull()
  })

  it('checks the owner before saying an entry is a Team account\'s', () => {
    const f = swarm()
    expect(refusal(() => f.choose(true, mate, 'gray-team'))?.code).toBe('OWNER_REQUIRED')
  })

  it('is set only on a Mac\'s own entry: not on its Team account, a machine being removed, or one not in the Swarm', () => {
    const f = swarm()
    expect(refusal(() => f.choose(true, gray, 'gray-team'))?.code).toBe('TEAM_ACCOUNT_ENTRY')
    expect(refusal(() => f.choose(true, gray, 'nowhere'))?.code).toBe('NOT_FOUND')
    f.machine('gray-mac').removal = { id: 'r', state: 'cleaning', requestedAt: new Date(NOW).toISOString() }
    expect(refusal(() => f.choose(true))?.code).toBe('MACHINE_REMOVED')
  })

  it('survives Desktop saving the contribution again, with or without the join\'s rule', () => {
    const f = swarm()
    f.choose(true)
    const save: Extract<Command, { type: 'machine.contribute' }> = { type: 'machine.contribute', machineId: 'gray-mac', name: 'Gray\'s Mac', cwd: '/swarm',
      scope: 'swarm', engines: ['codex'], maxAgents: 2 }
    f.run({ ...save, teamAccountOnly: true }, gray, f.joined)
    expect(f.machine('gray-mac').ownAccountChoice).toMatchObject({ allowed: true, by: 'gray' })
    f.run(save, gray, f.joined)
    expect(f.machine('gray-mac')).toMatchObject({ maxAgents: 2, ownAccountChoice: { allowed: true } })
  })

  it('starts at the safe default when the Mac is removed and added again', () => {
    const f = swarm()
    f.choose(true)
    // Offline: it leaves the list at once.
    f.machine('gray-mac').observation = { ...reading('computer'), receivedAt: 0 }
    f.run({ type: 'machine.remove', machineId: 'gray-mac' }, gray)
    expect(f.state.machines!.some(m => m.machineId === 'gray-mac')).toBe(false)
    // Its host's cleanup is past waiting for (machines.ts cleanupOverdue), so it may be added again.
    for (const cleanup of f.state.machineCleanups ?? []) cleanup.requestedAt = new Date(NOW - 60 * 60_000).toISOString()
    f.run({ type: 'machine.contribute', machineId: 'gray-mac', name: 'Gray\'s Mac', cwd: '/swarm', scope: 'swarm', engines: ['codex'], maxAgents: 4,
      teamAccountOnly: true }, gray, f.joined)
    expect(f.machine('gray-mac').ownAccountChoice).toBeUndefined()
  })

  it('starts at the safe default when added again over a removal its host never confirmed', () => {
    const f = swarm()
    f.choose(true)
    f.machine('gray-mac').removal = { id: 'r', state: 'cleaning', requestedAt: new Date(NOW - 60 * 60_000).toISOString() }
    f.run({ type: 'machine.contribute', machineId: 'gray-mac', name: 'Gray\'s Mac', cwd: '/swarm', scope: 'swarm', engines: ['codex'], maxAgents: 4,
      teamAccountOnly: true }, gray, f.joined)
    expect(f.machine('gray-mac').ownAccountChoice).toBeUndefined()
  })

  it('turned back off, is recorded as off, and agents already running stay', () => {
    const f = swarm()
    f.choose(true)
    const running = f.agent('running', { projectId: 'lead' })
    f.choose(false)
    expect(f.machine('gray-mac').ownAccountChoice).toEqual({ allowed: false, by: 'gray', at: new Date(NOW).toISOString() })
    expect(f.state.agents.find(a => a.id === (running as { agentId: string }).agentId)!.machineId).toBe('gray-mac')
  })

  it('says nothing for a start that is not moved: the owner\'s own project stays with the owner', () => {
    const f = swarm()
    const own = f.start(f.group(f.grays, gray), gray, f.grays)
    expect(f.state.starts![0]!.request.machineId).toBe('gray-mac')
    expect(own.result.moved).toBeUndefined()
  })

  it('never runs code a Team agent wrote on a teammate\'s Mac, whatever its owner chose: only the project owner\'s own agent (task #4120)', () => {
    const f = swarm()
    f.choose(true)
    const group = f.group()
    Object.assign(f.state.conversations.find(c => c.id === group)!, { teamWritten: true })
    expect(refusal(() => f.start(group, gray))?.code).toBe('TEAM_WRITTEN_WORK')
  })

  it('is kept per Swarm: turning it on in one Swarm leaves another Swarm\'s entry for the same Mac as it was (task #2993)', () => {
    const ours = swarm(), theirs = swarm()
    ours.choose(true)
    expect(theirs.machine('gray-mac').ownAccountChoice).toBeUndefined()
  })
})

describe('a Mac\'s Team account entry, as every read shows it', () => {
  it('goes by its Mac\'s name and "· Team account", while the Mac keeps its own name', () => {
    const f = swarm()
    const shown = (actor: Actor) => Object.fromEntries((visibleState(f.state, actor, NOW).machines ?? []).map(m => [m.machineId, m.name]))
    for (const reader of [owner, gray, mate, f.leadActor]) {
      expect(shown(reader)['gray-team']).toBe('Gray\'s Mac · Team account')
      expect(shown(reader)['gray-mac']).toBe('Gray\'s Mac')
      expect(shown(reader)['owner-mac']).toBe('Owner Mac')
    }
  })

  it('keeps the stored name its Mac\'s, which renames and the server\'s own sentences read', () => {
    const f = swarm()
    visibleState(f.state, owner, NOW)
    expect(f.machine('gray-team').name).toBe('Gray\'s Mac')
  })
})

describe('the choice in a Swarm read (task #4289)', () => {
  it('reaches no reader, the machine\'s owner included: Swarm v3 has no choice of where teammates\' work runs', () => {
    const f = swarm()
    f.choose(true)
    expect(f.machine('gray-mac').ownAccountChoice).toMatchObject({ allowed: true })
    for (const actor of [gray, owner, mate, f.leadActor]) {
      const read = (visibleState(f.state, actor, NOW).machines ?? []).find(m => m.machineId === 'gray-mac')
      expect(read).toBeDefined()
      expect(read).not.toHaveProperty('ownAccountChoice')
    }
  })
})
