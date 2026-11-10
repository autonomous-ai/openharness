/**
 * Swarm v3 removes Team accounts (task #4120, anh Dee 2026-11-07; gone for good 2026-11-10). The PM's rulings in the task: an
 * agent a person brought works on any task of a project that person can read, in their own account, and a new agent starts
 * only on its own person's computer; a task whose code a Team agent pushed stays guarded, and only the project owner's own
 * agent may take it over. Since 2026-11-10 no Team account is left, and that guard went with them.
 */
import { describe, expect, it } from 'vitest'
import { applyCommand, type Command, type CommandContext } from './commands.js'
import type { ContributedMachine } from './machines.js'
import { createSuperTab, SuperTabError, type Actor, type AgentConfiguration, type SuperTabState } from './model.js'

const NOW = 50_000_000
const owner: Extract<Actor, { kind: 'person' }> = { kind: 'person', userId: 'owner', email: 'owner@example.com' }
const mate: Extract<Actor, { kind: 'person' }> = { kind: 'person', userId: 'mate', email: 'mate@example.com' }
const config: AgentConfiguration = { engine: 'claude', model: 'opus', effort: 'high', contextWindow: 200000, engineVersion: 'fixture' }
const requirements = { memoryBytes: 0, diskBytes: 0, maxCpuPercent: 100, tools: [], devices: [], quotaRequired: false }
const resources = { cpuPercent: 1, memoryTotalBytes: 8e9, memoryUsedBytes: 1, diskFreeBytes: 8e9, diskTotalBytes: 8e9, projectDiskFreeBytes: 8e9,
  deviceType: null, chip: null, os: 'macOS', gpuPercent: null }
const reading = { generation: 'g1', receivedAt: NOW, resources, tools: {},
  quotas: [{ engine: 'claude', known: true, windows: [{ name: 'weekly', usedPercent: 10, resetsAt: null }] }], runningHarnessIds: [], stoppedHarnessIds: [],
  readiness: { engines: [{ engine: 'claude', installed: true, signedIn: true }] } }
const refusal = (body: () => unknown): SuperTabError | null => {
  try { body(); return null } catch (error) { if (error instanceof SuperTabError) return error; throw error }
}

/** The owner's project 'lead', the teammate's own Mac and the owner's Mac. */
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
  const pool = (machineId: string, contributorId: string, name: string): ContributedMachine => ({ machineId, name,
    contributorId, membershipGeneration: generation(contributorId), generation: 'g1', cwd: '/swarm', scope: 'swarm', engines: ['claude'], maxAgents: 4,
    paused: false, observation: reading as never })
  state.machines = [pool('owner-mac', 'owner', 'Owner Mac'), pool('mate-mac', 'mate', 'MacBook Pro')]
  /** An agent already in the Swarm on [machineId], under [contributorId]'s grant there. */
  const member = (id: string, machineId: string, contributorId: string, roleName = 'Engineer') => {
    state.agents.push({ id, machineId, harnessId: `harness-${id}`, projectId: 'lead', machineOwnerId: contributorId, contributorId,
      membershipGeneration: generation(contributorId), hostGrant: null, name: id, configuration: config, roleName } as never)
    return id
  }
  const pm = member('pm', 'owner-mac', 'owner', 'PM')
  const chat = state.conversations.find(c => c.id === 'lead')!
  chat.leadId = pm
  chat.agentIds = [...chat.agentIds, pm]
  const as = (agentId: string): Actor => ({ kind: 'agent', agentId, machineOwnerId: state.agents.find(a => a.id === agentId)!.machineOwnerId })
  const task = String(run({ type: 'conversation.create', projectId: 'lead', title: 'Work', brief: 'Build it.', priority: 'P2', requesterId: 'owner',
    checks: [{ description: 'Tests pass.', independent: false }] } as Command, as(pm)).result.conversationId)
  const machine = (machineId: string) => state.machines!.find(m => m.machineId === machineId)!
  const start = (machineId: string, actor: Actor) => run({ type: 'agent.start', request: { conversationId: task, machineId, engine: 'claude', name: 'Builder',
    cwd: '/swarm/lead', worktree: true, requirements } } as Command, actor, { contribution: { machineOwnerId: machine(machineId).contributorId,
    contributorId: machine(machineId).contributorId, hostGrant: null } as never })
  return { run, member, start, as, pm, task, get state() { return state } }
}

describe('with Team accounts removed', () => {
  it('starts the teammate\'s own agent on their own Mac, for a project they read, in their own account', () => {
    const f = swarm()
    f.start('mate-mac', mate)
    expect(f.state.starts!.at(-1)!.request.machineId).toBe('mate-mac')
  })

  it('starts a new agent only on its own person\'s computer: never the PM on another person\'s', () => {
    const f = swarm()
    expect(refusal(() => f.start('mate-mac', f.as(f.pm)))).toMatchObject({ code: 'NOT_YOUR_COMPUTER' })
    expect(refusal(() => f.start('mate-mac', owner))).toMatchObject({ code: 'NOT_YOUR_COMPUTER' })
    expect(refusal(() => f.start('owner-mac', f.as(f.pm)))).toBeNull()
  })

  it('routes past another person\'s computer, and keeps a teammate\'s own agent', () => {
    const f = swarm()
    const own = f.member('mates-own', 'mate-mac', 'mate')
    const candidate = (id: string, machineId: string, agentId?: string) => ({ id, kind: agentId ? 'member' : 'new', ...agentId ? { agentId } : {}, machineId,
      engine: 'claude', model: 'opus', effort: 'high', quality: 3, cost: 2, title: `${id} on ${machineId}`, label: id })
    const decision = { assessment: { difficulty: 'low', risk: 'low', why: 'Work.' }, excluded: [], floor: 2, notes: false, via: 'instructions', p: null,
      belowFloor: false, why: 'Instructions.', candidates: [candidate('c2', 'mate-mac'), candidate('c3', 'mate-mac', own), candidate('c4', 'owner-mac')] }
    const routed = f.run({ type: 'route.record', conversationId: f.task, decision } as Command, f.as(f.pm))
    const record = (routed.routeDecisions[0] as { record: { candidates: Array<{ id: string }>; excluded: Array<{ title: string; reason: string }> } }).record
    expect(record.candidates.map(c => c.id)).toEqual(['c3', 'c4'])
    expect(record.excluded.map(e => e.title)).toEqual(['c2 on mate-mac'])
  })

  // Security review 2 of #3446: off the Machines list, or through a machine share, the grant's contributor is not the machine's
  // owner; the start must be its owner's own, with no share, as agent.new checks.
  it('starts nothing on a computer shared through a machine share', () => {
    const f = swarm()
    const startOn = (machineId: string, contribution: Record<string, unknown>) => () => f.run({ type: 'agent.start', request: { conversationId: f.task,
      machineId, engine: 'claude', name: 'Builder', cwd: '/swarm/lead', worktree: true, requirements } } as Command, mate, { contribution: contribution as never })
    expect(refusal(startOn('strangers-mac', { machineOwnerId: 'stranger', contributorId: 'mate', hostGrant: 'share-1' }))).toMatchObject({ code: 'NOT_YOUR_COMPUTER' })
  })

  // The Team-written guard went with Team accounts (2026-11-10): a mark a task kept from before is no longer read, and a Team
  // machine leaving marks nothing.
  it('starts a person\'s own agent on a task marked Team-written from before, with its project settings on', () => {
    const f = swarm(), byId = (id: string) => f.state.conversations.find(c => c.id === id)!
    Object.assign(byId(f.task), { teamWritten: true, teamWrittenBy: { kind: 'assigned' } })
    f.start('mate-mac', mate)
    expect(f.state.starts!.at(-1)!.request).toMatchObject({ machineId: 'mate-mac' })
    expect(f.state.starts!.at(-1)!.request).not.toHaveProperty('projectSettings')
  })

  it('marks no task when a Team machine leaves', () => {
    const f = swarm(), byId = (id: string) => f.state.conversations.find(c => c.id === id)!
    const team = f.member('mates-team', 'mate-team', 'mate')
    byId(f.task).assignment = { id: 'a1', agentId: team, status: 'working', configuration: config, result: null,
      execution: { machineId: 'mate-team', harnessId: 'harness-mates-team', machineOwnerId: 'mate' } } as never
    f.run({ type: 'machine.teamGone', machineId: 'mate-team' } as Command, owner, { teamMachineGone: true })
    expect(f.state.agents.map(a => a.id)).not.toContain(team)
    expect(byId(f.task)).not.toHaveProperty('teamWritten')
  })
})
