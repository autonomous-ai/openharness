import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { applyCommand, commandSchema, type Command, type CommandContext } from './commands.js'
import { machineTeamWork, teamWorkRefusal, type ContributedMachine, type MachinePrivacy } from './machines.js'
import { createSuperTab, SuperTabError, visibleState, type Actor, type AgentConfiguration, type SuperTabState } from './model.js'

// Task #2806 (Scholes, 11-04): a Mac added as its person joined runs teammates' work only in its Harness Team account
// (teamAccountOnly). The lampOS mobile team needs it in the owner's own account on Gray's Mac (Flutter and the phone signing
// are there). The machine's owner, and nobody else, may say that teammates' work may run in their own account; the default
// stays Team-account-only. Everything here runs with Team accounts required everywhere, the strictest setting.
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
  it('is off by default: a teammate\'s start on a Mac added as its person joined goes to its Team account', () => {
    const f = swarm()
    expect(f.machine('gray-mac').ownAccountChoice).toBeUndefined()
    f.start(f.group())
    expect(f.state.starts![0]!.request).toMatchObject({ machineId: 'gray-team', cwd: '/team-swarm/lead' })
  })

  it('is turned on by the machine\'s owner, recording who and when, and then a teammate\'s start runs on the Mac itself', () => {
    const f = swarm()
    f.choose(true)
    expect(f.machine('gray-mac').ownAccountChoice).toEqual({ allowed: true, by: 'gray', at: new Date(NOW).toISOString() })
    // The Team account rule stays: only the move to the Team account is off.
    expect(f.machine('gray-mac').teamAccountOnly).toBe(true)
    f.start(f.group())
    expect(f.state.starts![0]!.request).toMatchObject({ machineId: 'gray-mac', cwd: '/swarm/lead' })
    // Routing reads it as a machine that takes a teammate's work.
    expect(teamWorkRefusal(f.machine('gray-mac'), NOW)).toBeNull()
    expect(machineTeamWork(f.state, f.machine('gray-mac'), NOW, ['gray-team'])).toBeNull()
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

  it('counts only a choice recorded as the machine owner\'s', () => {
    const f = swarm()
    f.machine('gray-mac').ownAccountChoice = { allowed: true, by: 'mate', at: new Date(NOW).toISOString() }
    f.start(f.group())
    expect(f.state.starts![0]!.request.machineId).toBe('gray-team')
  })

  it('reads the Mac itself, not its Team account, for routing once it is on', () => {
    const f = swarm()
    // A stale privacy check on the Team account refuses teammates there; with the owner's choice on, starts run on the Mac.
    f.machine('gray-team').observation = { ...reading('team', PASSED), privacy: { ...PASSED, seenAt: NOW - 24 * 60 * 60_000 } }
    expect(machineTeamWork(f.state, f.machine('gray-mac'), NOW, ['gray-team'])?.code).toBe('PRIVACY_CHECK_STALE')
    f.choose(true)
    expect(machineTeamWork(f.state, f.machine('gray-mac'), NOW, ['gray-team'])).toBeNull()
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

  it('turned back off, moves the next start to the Team account again and says why; agents already running stay', () => {
    const f = swarm()
    f.choose(true)
    f.start(f.group())
    const running = f.agent('running', { projectId: 'lead' })
    f.choose(false)
    expect(f.machine('gray-mac').ownAccountChoice).toEqual({ allowed: false, by: 'gray', at: new Date(NOW).toISOString() })
    const moved = f.start(f.group())
    expect(f.state.starts!.at(-1)!.request).toMatchObject({ machineId: 'gray-team' })
    // The choice is per Swarm: the note says where this Swarm's is (task #2993: Gray turned it on in another Swarm).
    expect(moved.result.moved).toBe('Gray\'s Mac runs teammates\' work in its Harness Team account in this Swarm. Its owner can change that in this Swarm\'s Manage > Machines.')
    expect(f.state.agents.find(a => a.id === (running as { agentId: string }).agentId)!.machineId).toBe('gray-mac')
  })

  it('says nothing for a start that is not moved: the owner\'s own project stays with the owner', () => {
    const f = swarm()
    const own = f.start(f.group(f.grays, gray), gray, f.grays)
    expect(f.state.starts![0]!.request.machineId).toBe('gray-mac')
    expect(own.result.moved).toBeUndefined()
  })

  it('still sends code a Team agent wrote to the Team account', () => {
    const f = swarm()
    f.choose(true)
    const group = f.group()
    const conversation = f.state.conversations.find(c => c.id === group)!
    Object.assign(conversation, { teamWritten: true })
    const result = refusal(() => f.start(group))
    // Moved or refused, never run as Gray.
    expect(result === null ? f.state.starts!.at(-1)!.request.machineId : result.code).not.toBe('gray-mac')
  })

  it('says a Team-written start moved for its code, not for a choice its owner can change (task #2993)', () => {
    const f = swarm()
    f.choose(true)
    const group = f.group()
    Object.assign(f.state.conversations.find(c => c.id === group)!, { teamWritten: true })
    const moved = f.start(group)
    expect(f.state.starts!.at(-1)!.request).toMatchObject({ machineId: 'gray-team' })
    expect(moved.result.moved).toBe('A Harness Team agent wrote this task\'s code, so it runs in the Harness Team account on Gray\'s Mac.')
  })

  it('is kept per Swarm: turning it on in one Swarm leaves another Swarm\'s entry for the same Mac as it was (task #2993)', () => {
    const ours = swarm(), theirs = swarm()
    ours.choose(true)
    expect(theirs.machine('gray-mac').ownAccountChoice).toBeUndefined()
    const moved = theirs.start(theirs.group())
    expect(theirs.state.starts!.at(-1)!.request).toMatchObject({ machineId: 'gray-team' })
    expect(moved.result.moved).toContain('in this Swarm\'s Manage > Machines')
  })
})

// Task #3060 (Scholes, 11-05): on 11-04 a lamp start named Gray's Team account entry itself, not the Mac, after Gray had
// turned own-account work on. Both entries were named 'Gray.local', and the server placed it as named, with no note. A
// start that names the Team entry for a teammate's work no Team agent wrote is refused, with a pointer to the Mac's own
// entry: moving it would put the work in a person's own account when the start named the isolated one.
describe('a start that names a Mac\'s Team account entry while its owner runs teammates\' work in their own account', () => {
  const startOnTeam = (f: ReturnType<typeof swarm>, group: string, actor: Actor = f.leadActor, projectId = 'lead') =>
    f.run({ type: 'agent.start', request: { ...f.request(group, 'gray-team', projectId), cwd: `/team-swarm/${projectId}` } }, actor, f.joined)

  it('is refused for a teammate\'s task, pointing at the Mac\'s own entry, and nothing starts', () => {
    const f = swarm()
    f.choose(true)
    const result = refusal(() => startOnTeam(f, f.group()))
    expect(result?.code).toBe('OWN_ACCOUNT_WORK')
    expect(result?.message).toContain('Gray\'s Mac')
    expect(result?.message).toContain('gray-mac')
    expect(f.state.starts ?? []).toHaveLength(0)
  })

  it('is refused for a person\'s start too', () => {
    const f = swarm()
    f.choose(true)
    expect(refusal(() => startOnTeam(f, f.group(), owner))?.code).toBe('OWN_ACCOUNT_WORK')
  })

  it('still starts work a Team agent wrote in the Team account', () => {
    const f = swarm()
    f.choose(true)
    const group = f.group()
    Object.assign(f.state.conversations.find(c => c.id === group)!, { teamWritten: true })
    startOnTeam(f, group)
    expect(f.state.starts!.at(-1)!.request).toMatchObject({ machineId: 'gray-team', cwd: '/team-swarm/lead' })
  })

  it('starts there as before when its owner has not turned own-account work on, or turned it off', () => {
    const f = swarm()
    startOnTeam(f, f.group())
    expect(f.state.starts!.at(-1)!.request).toMatchObject({ machineId: 'gray-team' })
    f.choose(true)
    f.choose(false)
    startOnTeam(f, f.group())
    expect(f.state.starts!.at(-1)!.request).toMatchObject({ machineId: 'gray-team' })
  })

  it('leaves a choice recorded by someone other than the owner unread, as ownAccountWork does', () => {
    const f = swarm()
    f.machine('gray-mac').ownAccountChoice = { allowed: true, by: 'mate', at: new Date(NOW).toISOString() }
    startOnTeam(f, f.group())
    expect(f.state.starts!.at(-1)!.request).toMatchObject({ machineId: 'gray-team' })
  })
})

// Task #3060: both of Gray's entries were named 'Gray.local', so whoever picked one could not tell the Team account from the Mac.
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
