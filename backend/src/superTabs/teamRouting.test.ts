import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { applyCommand, commandSchema, type Command, type CommandContext } from './commands.js'
import { admitMachineStart, availableSlots, machineSlots, removalPreview, type ContributedMachine } from './machines.js'
import { createSuperTab, SuperTabError, visibleState, type Actor, type AgentConfiguration, type AgentStart, type SuperTabState } from './model.js'
import type { RouteDecision } from './routeRecord.js'

// Teammates' work runs only on Team machines (docs/plans/2026-10-24-swarm-team-account.md, Task 3): a start or an
// assignment for a project whose owner did not contribute the machine needs a Harness Team account whose privacy check
// passed, or a machine used only for agents. A person's own projects on their own machine are unchanged.
//
// Everything below runs with the rule required everywhere (SWARM_TEAM_ACCOUNT_REQUIRED=1), except the last block: until
// then, a machine without a team account takes a teammate's work as it did before.
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
/** A reading as the store keeps it: stamped with the reporting session's kind and, from a team session, its privacy. */
const reading = (sessionKind: 'team' | 'computer', receivedAt = NOW): Reading => ({
  generation: 'g1', receivedAt, sessionKind, resources, tools: {}, quotas: [], runningHarnessIds: [], stoppedHarnessIds: [] })
const refusal = (body: () => unknown): SuperTabError | null => {
  try { body(); return null } catch (error) { if (error instanceof SuperTabError) return error; throw error }
}

/** The owner's Swarm: the owner's project ('lead') and the teammate's own project, the owner's Mac, the teammate's
 *  personal MacBook and the teammate's Team machine, all contributed for every project. */
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
    pool('owner-mac', 'owner', 'Owner Mac', reading('computer')),
    pool('mate-mac', 'mate', 'MacBook Pro', reading('computer')),
    pool('mate-team', 'mate', 'MacBook Pro · Team', reading('team')),
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

  it('never starts in a Team account, whatever its privacy check says', () => {
    for (const observation of [reading('team'), reading('team'), reading('team')]) {
      const f = swarm(), group = f.group()
      f.machine('mate-team').observation = observation
      expect(refusal(() => f.run({ type: 'agent.start', request: f.request(group, 'mate-team') }, mate, f.pooled('mate-team')))?.code).toBe('TEAM_ACCOUNTS_REMOVED')
    }
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

  it('is refused when its host launches it in a Team account, though it was admitted before the release', () => {
    const f = swarm(), group = f.group()
    const start = { id: 'before-release', request: f.request(group, 'mate-team'), poolGeneration: 'g1' } as unknown as AgentStart
    expect(refusal(() => admitMachineStart(f.state, start.request, NOW, start))?.code).toBe('TEAM_ACCOUNTS_REMOVED')
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
  it('adding a Reviewer to a group, which hands it the review, is admitted for the teammate\'s own agent and refused in a Team account', () => {
    const f = swarm(), group = f.group()
    const reviewer = f.member('reviewer', 'mate-mac', 'mate', 'lead', { role: 'reviewer' })
    f.run({ type: 'conversation.agent', conversationId: group, agentId: reviewer, present: true, lead: false })
    expect(f.state.conversations.find(c => c.id === group)!.agentIds).toContain(reviewer)
    const teamReviewer = f.member('team-reviewer', 'mate-team', 'mate', 'lead', { role: 'reviewer' })
    expect(refusal(() => f.run({ type: 'conversation.agent', conversationId: group, agentId: teamReviewer, present: true, lead: false }))?.code).toBe('TEAM_ACCOUNTS_REMOVED')
  })
})

describe('routing a teammate\'s work', () => {
  const candidate = (id: string, machineId: string, patch: Record<string, unknown> = {}) => ({ id, kind: 'new', machineId, engine: 'codex',
    model: 'default', effort: 'default', quality: 3, cost: 2, title: `${id} on ${machineId}`, label: `Label ${id}`, ...patch })
  const record = (candidates: unknown[], pick = 'c0') => ({ assessment: { difficulty: 'medium', risk: 'low', why: 'A small change.' },
    candidates, excluded: [{ title: 'Owner Mac · claude', reason: 'Subscription exhausted.' }], floor: 2, notes: false, pick, via: 'order', p: null,
    belowFloor: false, why: 'Policy order.' })
  function routed() {
    const f = swarm()
    const lead = String(f.run({ type: 'agent.add', conversationId: 'lead', machineId: 'owner-mac', harnessId: 'lead', name: 'Lead', configuration: config, lead: true },
      owner, { contribution: { machineOwnerId: 'owner', contributorId: 'owner' } }).result.agentId)
    const group = f.group()
    const leadActor: Actor = { kind: 'agent', agentId: lead, machineOwnerId: 'owner' }
    const personal = f.member('personal', 'mate-mac', 'mate')
    return { ...f, get state() { return f.state }, group, leadActor, personal }
  }

  it('leaves out a Team account and a new agent on another person\'s computer, keeps the teammate\'s own agent, and says why', () => {
    const f = routed()
    const effects = f.run({ type: 'route.record', conversationId: f.group, decision: record([candidate('c0', 'mate-team'), candidate('c1', 'mate-mac'),
      candidate('c2', 'mate-mac', { kind: 'member', agentId: f.personal, title: 'personal on mate-mac' }), candidate('c3', 'owner-mac')], 'c3') } as Command,
    f.leadActor, {})
    expect(effects.routeDecisions[0]).toMatchObject({ op: 'create', record: {
      candidates: [{ id: 'c2' }, { id: 'c3' }],
      excluded: [
        { title: 'c0 on mate-team', reason: 'Harness Team accounts are gone: an agent runs on its own person\'s computer, in their own account.' },
        { title: 'c1 on mate-mac', reason: 'A new agent starts only on its own person\'s computer, in their own account, never on another person\'s.' },
        { title: 'Owner Mac · claude', reason: 'Subscription exhausted.' },
      ] } })
    expect(effects.messages[0]!.source).toMatchObject({ pick: { id: 'c3' }, alternatives: [{ id: 'c2', title: 'personal on mate-mac' }] })
  })

  // Task #4194: a route that picked a Team account was refused whole, and routing again picked it again, so no PM could route.
  it('leaves out a pick that cannot take it and keeps the rest, with no pick, so the coordinator chooses among them', () => {
    const f = routed()
    const effects = f.run({ type: 'route.record', conversationId: f.group, decision: record([candidate('c0', 'mate-team'), candidate('c1', 'owner-mac')]) } as Command,
      f.leadActor, {})
    const [created] = effects.routeDecisions as Array<{ record: Record<string, unknown> }>
    expect(created!.record).toMatchObject({ candidates: [{ id: 'c1' }],
      excluded: [{ title: 'c0 on mate-team', reason: 'Harness Team accounts are gone: an agent runs on its own person\'s computer, in their own account.' },
        { title: 'Owner Mac · claude' }] })
    expect(created!.record.pick).toBeUndefined()
    // No row names a pick the record does not keep: the start or assignment posts the one it chose.
    expect(effects.messages.filter(m => m.source?.kind === 'route')).toEqual([])
  })

  // Task #2901 (Ken, 2026-11-04): a route names no pick, so no single refusal decides it; it is refused once no candidate is left.
  it('leaves out of a route that names no pick what cannot take it, and refuses it once nothing is left', () => {
    const f = routed()
    const pickless = (candidates: unknown[]) => {
      const { pick: _pick, ...rest } = record(candidates)
      return { ...rest, via: 'instructions', floor: 1, why: 'No ranking: the project\'s Routing instructions choose.' }
    }
    const effects = f.run({ type: 'route.record', conversationId: f.group, decision: pickless([candidate('c0', 'mate-mac'), candidate('c1', 'owner-mac')]) } as Command,
      f.leadActor, {})
    expect(effects.routeDecisions[0]).toMatchObject({ op: 'create', record: { candidates: [{ id: 'c1' }],
      excluded: [{ title: 'c0 on mate-mac', reason: 'A new agent starts only on its own person\'s computer, in their own account, never on another person\'s.' },
        { title: 'Owner Mac · claude' }] } })
    expect(refusal(() => f.run({ type: 'route.record', conversationId: f.group, decision: pickless([candidate('c0', 'mate-team')]) } as Command, f.leadActor, {})))
      .toMatchObject({ code: 'TEAM_ACCOUNTS_REMOVED', message: 'Harness Team accounts are gone: an agent runs on its own person\'s computer, in their own account. Route again.' })
  })

  it('refuses a person\'s reroute to a candidate in a Team account', () => {
    const f = routed()
    const decision = { id: 'd1', conversationId: f.group, record: record([candidate('c0', 'owner-mac'), candidate('c1', 'mate-team')]),
      final: null, override: null, assignmentId: null, outcome: null } as unknown as RouteDecision
    expect(refusal(() => f.run({ type: 'route.override', decisionId: 'd1', candidateId: 'c1', reason: 'More quota there.' }, owner, { routeDecision: decision }))?.code)
      .toBe('TEAM_ACCOUNTS_REMOVED')
  })

  it('keeps a person\'s own project routing as it was', () => {
    const f = routed()
    const effects = f.run({ type: 'route.record', conversationId: f.group, decision: record([candidate('c0', 'owner-mac')]) } as Command, f.leadActor, {})
    expect(effects.routeDecisions[0]).toMatchObject({ record: { candidates: [{ id: 'c0' }], excluded: [{ title: 'Owner Mac · claude' }] } })
  })
})

describe('agents already working in a Team account', () => {
  it('keep their task and their messages', () => {
    const f = swarm(), group = f.group()
    // Work assigned before the release: a teammate's Team-account agent doing the owner's project.
    const old = f.member('old', 'mate-team', 'mate')
    const work = f.state.conversations.find(c => c.id === group)!
    work.agentIds.push(old)
    work.assignment = { id: 'before-release', agentId: old, status: 'working', configuration: config,
      execution: { machineId: 'mate-team', harnessId: 'harness-old', machineOwnerId: 'mate' }, result: null }
    expect(f.run({ type: 'message.send', conversationId: group, text: 'Here it is.', replyTo: null, recipientIds: [old] }).messages[0]!.recipients).toEqual([old])
    expect(f.state.conversations.find(c => c.id === group)!.assignment).toMatchObject({ id: 'before-release', status: 'working' })
  })
})

// One machine ("One machine" in docs/plans/2026-10-24-swarm-team-account.md): a Mac's Harness Team account is a
// mechanism under the scenes. Its pool names the Mac it lives on (`hostMachineId`), shows the Mac's name, joins where
// the Mac was added and follows the Mac's pause, slots and removal. A teammate's project started on the Mac runs in
// the team account; the Mac's owner's own projects stay with the owner's daemon.
describe('one machine: a Mac and its Harness Team account', () => {
  function oneMachine() {
    const f = swarm()
    Object.assign(f.machine('mate-team'), { hostMachineId: 'mate-mac', name: 'MacBook Pro', cwd: '/team-swarm' })
    return f
  }

  it('a teammate\'s project started on the Mac stays on the Mac, in its person\'s own account and folder', () => {
    const f = oneMachine(), group = f.group()
    f.run({ type: 'agent.start', request: f.request(group, 'mate-mac') }, mate, f.pooled('mate-mac'))
    expect(f.state.starts).toEqual([expect.objectContaining({ request: expect.objectContaining({ machineId: 'mate-mac', cwd: '/swarm/lead' }) })])
  })

  it('takes nothing in its Team account', () => {
    const f = oneMachine(), group = f.group()
    expect(refusal(() => f.run({ type: 'agent.start', request: { ...f.request(group, 'mate-team'), cwd: '/team-swarm/lead' } }, mate,
      f.pooled('mate-team')))?.code).toBe('TEAM_ACCOUNTS_REMOVED')
    expect(f.state.starts ?? []).toEqual([])
  })

  it('leaves the Mac\'s owner\'s own projects on the owner\'s daemon', () => {
    const f = oneMachine(), mine = f.group(f.mine, mate)
    f.run({ type: 'agent.start', request: f.request(mine, 'mate-mac', f.mine) }, mate, f.pooled('mate-mac'))
    expect(f.state.starts![0]!.request).toMatchObject({ machineId: 'mate-mac', cwd: `/swarm/${f.mine}` })
  })

  it('joins by itself where its owner added the Mac, under the Mac\'s name, slots and pause', () => {
    const f = swarm()
    f.state.machines = f.state.machines!.filter(m => m.machineId !== 'mate-team')
    f.machine('mate-mac').paused = true
    const join = { type: 'machine.contribute', machineId: 'mate-team', name: 'MacBook Pro · Team', cwd: '/team-swarm', scope: 'swarm', engines: ['codex'],
      maxAgents: 2, ifMissing: true } as Command
    f.run(join, mate, { contribution: { machineOwnerId: 'mate', contributorId: 'mate', hostMachineId: 'mate-mac' } })
    expect(f.machine('mate-team')).toMatchObject({ hostMachineId: 'mate-mac', name: 'MacBook Pro', cwd: '/team-swarm', maxAgents: 4, paused: true, contributorId: 'mate' })
    // Once there, a join again changes nothing.
    f.run({ ...join, maxAgents: 1 } as Command, mate, { contribution: { machineOwnerId: 'mate', contributorId: 'mate', hostMachineId: 'mate-mac' } })
    expect(f.machine('mate-team').maxAgents).toBe(4)
  })

  it('never joins by itself where its Mac is not in the Swarm', () => {
    const f = swarm()
    f.state.machines = f.state.machines!.filter(m => m.machineId !== 'mate-team' && m.machineId !== 'mate-mac')
    expect(refusal(() => f.run({ type: 'machine.contribute', machineId: 'mate-team', name: 'x', cwd: '/team-swarm', scope: 'swarm', engines: ['codex'],
      maxAgents: 2, ifMissing: true } as Command, mate, { contribution: { machineOwnerId: 'mate', contributorId: 'mate', hostMachineId: 'mate-mac' } }))?.code).toBe('OWNER_REQUIRED')
  })

  it('follows its Mac: paused, given other slots, renamed and removed with it', () => {
    const f = oneMachine()
    const teamAgent = f.member('team-agent', 'mate-team', 'mate')
    f.run({ type: 'machine.pause', machineId: 'mate-mac', paused: true }, mate)
    expect(f.machine('mate-team').paused).toBe(true)
    f.run({ type: 'machine.contribute', machineId: 'mate-mac', name: 'Work MacBook', cwd: '/swarm', scope: 'swarm', engines: ['codex'], maxAgents: 6 }, mate,
      { contribution: { machineOwnerId: 'mate', contributorId: 'mate' } })
    // New settings keep the pause the owner chose, on the Mac and its team account (review of #2084).
    expect([f.machine('mate-mac').paused, f.machine('mate-team')]).toEqual([true, expect.objectContaining({ maxAgents: 6, paused: true, name: 'Work MacBook', generation: 'g1' })])
    f.run({ type: 'machine.pause', machineId: 'mate-mac', paused: false }, mate)
    expect(f.machine('mate-team').paused).toBe(false)
    const removed = f.run({ type: 'machine.remove', machineId: 'mate-mac' }, mate)
    expect(f.machine('mate-team').removal).toMatchObject({ state: 'cleaning' })
    expect(removed.result.removedAgents).toContain(teamAgent)
    expect(f.state.agents.some(a => a.id === teamAgent)).toBe(false)
  })

  it('a teammate never moves another person\'s team account with their own Mac', () => {
    const f = oneMachine()
    f.machine('mate-team').contributorId = 'owner'
    f.run({ type: 'machine.pause', machineId: 'mate-mac', paused: true }, mate)
    expect(f.machine('mate-team').paused).toBe(false)
  })
})

describe('one machine: the Mac\'s agent slots', () => {
  it('are shared by the Mac and its Harness Team account while an agent is still there', () => {
    const f = swarm()
    Object.assign(f.machine('mate-team'), { hostMachineId: 'mate-mac', name: 'MacBook Pro', cwd: '/team-swarm' })
    f.member('mine', 'mate-mac', 'mate', f.mine)
    f.member('team-agent', 'mate-team', 'mate')
    // One on the owner's daemon and one left in the team account: the Mac counts both, whichever side asks.
    expect(machineSlots(f.state, f.machine('mate-mac'))).toBe(2)
    expect(machineSlots(f.state, f.machine('mate-team'))).toBe(2)
    // A machine without a team account counts only its own.
    expect(machineSlots(f.state, f.machine('owner-mac'))).toBe(0)
  })
})

describe('one machine: a Mac whose Harness Team account was made again', () => {
  // `harness team remove`, then `harness team setup`: a new account, computer and machine, while the old team machine's
  // pool is still in the Swarm, silent. The Mac joins with the new one too (read/hostRows.ts).
  function remade() {
    const f = swarm()
    Object.assign(f.machine('mate-team'), { hostMachineId: 'mate-mac', name: 'MacBook Pro', cwd: '/old-team', observation: reading('team', NOW - 3_600_000) })
    f.state.machines!.push({ ...structuredClone(f.machine('mate-team')), machineId: 'mate-team-2', cwd: '/team-swarm', observation: reading('team') })
    return f
  }

  it('counts no slot of the Mac for the old account\'s leftover agent', () => {
    const f = remade()
    f.member('old-agent', 'mate-team', 'mate')
    expect(machineSlots(f.state, f.machine('mate-mac'))).toBe(0)
  })

  it('pauses and removes both with the Mac, and its removal preview names every agent it takes', () => {
    const f = remade()
    const old = f.member('old-agent', 'mate-team', 'mate'), fresh = f.member('new-agent', 'mate-team-2', 'mate')
    f.run({ type: 'machine.pause', machineId: 'mate-mac', paused: true }, mate)
    expect([f.machine('mate-team').paused, f.machine('mate-team-2').paused]).toEqual([true, true])
    expect(removalPreview(f.state, mate, 'mate-mac').agents.map(a => a.id).sort()).toEqual([fresh, old].sort())
    f.run({ type: 'machine.remove', machineId: 'mate-mac' }, mate)
    expect(f.machine('mate-team-2').removal?.state).toBe('cleaning')
    // The silent old one leaves the list at once; its cleanup waits for its host, as for any offline machine.
    expect(f.state.machines!.some(m => m.machineId === 'mate-team')).toBe(false)
    expect(f.state.machineCleanups).toEqual(expect.arrayContaining([expect.objectContaining({ machineId: 'mate-team' })]))
  })

})

// A machine Desktop adds as its person joins a Swarm (Scholes, 2026-10-29): nobody chose to lend it to teammates, so their
// work reaches it only through its Harness Team account, whose privacy check passed, even while the rule is not
// required everywhere. Until then it runs only its person's own projects, and never a teammate's agent as that person.
describe('a machine added as its person joined', () => {
  beforeEach(() => { delete process.env.SWARM_TEAM_ACCOUNT_REQUIRED })
  const joined: Extract<Command, { type: 'machine.contribute' }> = { type: 'machine.contribute', machineId: 'joined-mac', name: 'MacBook Air',
    cwd: '/swarm', scope: 'swarm', engines: ['codex'], maxAgents: 4, teamAccountOnly: true }
  const contribution = { contribution: { machineOwnerId: 'mate', contributorId: 'mate', hostGrant: null } }

  it('takes its person\'s own agent for any project they read, and no other person\'s start', () => {
    const f = swarm(), group = f.group(), own = f.group(f.mine, mate)
    f.run(joined, mate, contribution)
    f.machine('joined-mac').observation = reading('computer')
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
    f.machine('owner-mac').observation = reading('computer')
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

  it('counts a Mac and its Team account as one memory', () => {
    const f = swarm(), group = f.group()
    Object.assign(f.machine('mate-team'), { hostMachineId: 'mate-mac', name: 'MacBook Pro', cwd: '/team-swarm', maxAgents: 16 })
    Object.assign(f.machine('mate-mac'), { maxAgents: 16 })
    measured(f, 'mate-mac', 128, 3)
    measured(f, 'mate-team', 128, 3)
    const room = (id: string) => availableSlots(f.state, f.machine(id), machineSlots(f.state, f.machine(id)))
    expect([room('mate-mac'), room('mate-team')]).toEqual([1, 1])
    f.member('mine', 'mate-mac', 'mate', f.mine)
    expect(refusal(() => f.run({ type: 'agent.start', request: { ...f.request(group, 'mate-mac'), requirements: twoGiB } }, mate, f.pooled('mate-mac')))).toBeNull()
    // The one start holds the 2 GiB both readings show.
    expect([room('mate-mac'), room('mate-team')]).toEqual([0, 0])
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

  it('a Team account follows its Mac\'s setting', () => {
    const f = swarm()
    Object.assign(f.machine('mate-team'), { hostMachineId: 'mate-mac', name: 'MacBook Pro', cwd: '/team-swarm', maxAgents: 16, agents: 'atMost' })
    f.run({ type: 'machine.contribute', machineId: 'mate-mac', name: 'MacBook Pro', cwd: '/swarm', scope: 'swarm', engines: ['codex'], maxAgents: 16, agents: 'memory' } as Command,
      mate, { contribution: { machineOwnerId: 'mate', contributorId: 'mate', machineName: 'MacBook Pro' } } as never)
    expect(f.machine('mate-mac').agents).toBe('memory')
    expect(f.machine('mate-team').agents).toBe('memory')
  })
})
