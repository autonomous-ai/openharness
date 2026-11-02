import { describe, expect, it } from 'vitest'
import { applyCommand, type Command, type CommandContext } from './commands.js'
import type { ContributedMachine } from './machines.js'
import { createSuperTab, SuperTabError, type Actor, type AgentConfiguration, type SuperTabState } from './model.js'
import { TEAM_WRITTEN_WORK, teamWrittenTask } from './teamWritten.js'

// Audit H2: a branch a Team agent wrote runs only in a Team account, whoever's project it is, so nothing the branch
// carries runs with the main account's rights (docs/plans/2026-11-02-team-written-branch-plan.md).
const NOW = 50_000_000
const owner: Extract<Actor, { kind: 'person' }> = { kind: 'person', userId: 'owner', email: 'owner@example.com' }
const config: AgentConfiguration = { engine: 'claude', model: 'fixture-model', effort: 'high', contextWindow: 200000, engineVersion: 'fixture' }
const requirements = { memoryBytes: 0, diskBytes: 0, maxCpuPercent: 100, tools: [], devices: [], quotaRequired: false }
const resources = { cpuPercent: 1, memoryTotalBytes: 8, memoryUsedBytes: 1, diskFreeBytes: 8, diskTotalBytes: 8, projectDiskFreeBytes: 8,
  deviceType: null, chip: null, os: null, gpuPercent: null }
const reading = (sessionKind: 'team' | 'computer') => ({ generation: 'g1', receivedAt: NOW, sessionKind, resources, tools: {}, quotas: [], runningHarnessIds: [], stoppedHarnessIds: [],
  ...(sessionKind === 'team' ? { privacy: { mode: 'account' as const, passed: true as const, checkedAt: NOW - 1000, seenAt: NOW - 1000 } } : {}) })

function swarm() {
  let state: SuperTabState = createSuperTab('tab', 'Pilot', { id: 'owner', email: owner.email }, 'prod')
  let sequence = 0
  const generation = state.people.find(p => p.id === 'owner')!.generation
  const pool = (machineId: string, sessionKind: 'team' | 'computer', extra: Partial<ContributedMachine> = {}): ContributedMachine => ({ machineId, name: machineId, contributorId: 'owner',
    membershipGeneration: generation, generation: 'g1', cwd: '/swarm', scope: 'swarm', engines: ['claude'], maxAgents: 4, paused: false, observation: reading(sessionKind), ...extra })
  state.machines = [pool('mac', 'computer'), pool('mac-team', 'team', { hostMachineId: 'mac' })]
  const run = (command: Command, actor: Actor = owner, context: Partial<CommandContext> = {}) => {
    const effects = applyCommand(state, actor, command, { now: NOW, operationId: `op-${++sequence}`, teamMachines: ['mac-team'],
      contribution: { machineOwnerId: 'owner', contributorId: 'owner', hostGrant: null }, ...context })
    state = effects.state
    return effects
  }
  const member = (id: string, machineId: string) => {
    state.agents.push({ id, machineId, harnessId: `harness-${id}`, projectId: 'lead', machineOwnerId: 'owner', contributorId: 'owner',
      membershipGeneration: generation, hostGrant: null, name: id, configuration: config })
    return id
  }
  const group = (extra: Partial<Extract<Command, { type: 'conversation.create' }>> = {}, actor: Actor = owner) => String(run({ type: 'conversation.create', projectId: 'lead', title: 'Work', brief: 'Build it.',
    checks: [], ...extra }, actor).result.conversationId)
  const start = (conversationId: string, machineId: string) => run({ type: 'agent.start', request: { conversationId, machineId, engine: 'claude', name: 'Reviewer', cwd: '/swarm/lead', worktree: true, requirements } })
  /** A task a Team agent was assigned, with its finished assignment left behind so a review can begin. */
  const written = () => {
    const task = group()
    run({ type: 'work.assign', conversationId: task, agentId: member('team-builder', 'mac-team') })
    return task
  }
  return { run, group, member, start, written, get state() { return state } }
}
const refusal = (body: () => unknown): string | null => {
  try { body(); return null } catch (error) { if (error instanceof SuperTabError) return error.code; throw error }
}

describe('a task a Team agent worked on', () => {
  it('keeps its mark after the Team agent leaves it', () => {
    const f = swarm(), task = f.written()
    const stored = () => f.state.conversations.find(c => c.id === task)!
    expect(stored().teamWritten).toBe(true)
    stored().assignment = null
    expect(teamWrittenTask(f.state, stored())).toBe(true)
  })

  it('is marked when a Team agent opens it or is added to it', () => {
    const f = swarm()
    const opened = f.group({}, { kind: 'agent', agentId: f.member('team-a', 'mac-team'), machineOwnerId: 'owner' })
    expect(f.state.conversations.find(c => c.id === opened)!.teamWritten).toBe(true)
    const added = f.group()
    f.run({ type: 'conversation.agent', conversationId: added, agentId: f.member('team-b', 'mac-team'), present: true, lead: false })
    expect(f.state.conversations.find(c => c.id === added)!.teamWritten).toBe(true)
  })

  it('refuses an agent in the main account: assigned to its step, or to the task itself', () => {
    const f = swarm(), task = f.written(), main = f.member('main-reviewer', 'mac')
    const step = f.group({ reviewOf: task, step: 'Review' })
    expect(refusal(() => f.run({ type: 'work.assign', conversationId: step, agentId: main }))).toBe(TEAM_WRITTEN_WORK)
    f.state.conversations.find(c => c.id === task)!.assignment = null
    expect(refusal(() => f.run({ type: 'work.assign', conversationId: task, agentId: main }))).toBe(TEAM_WRITTEN_WORK)
  })

  it('refuses joining the main account\'s agent to it, by a person or by another agent\'s post', () => {
    const f = swarm(), task = f.written(), main = f.member('main-reviewer', 'mac')
    expect(refusal(() => f.run({ type: 'conversation.agent', conversationId: task, agentId: main, present: true, lead: false }))).toBe(TEAM_WRITTEN_WORK)
    expect(refusal(() => f.run({ type: 'message.send', conversationId: task, text: 'Please test this.', replyTo: null, recipientIds: [main] },
      { kind: 'agent', agentId: 'team-builder', machineOwnerId: 'owner' }))).toBe(TEAM_WRITTEN_WORK)
  })

  it('takes a Team agent as its Reviewer, and that does not mark a clean task', () => {
    const f = swarm(), task = f.written(), reviewer = f.member('team-reviewer', 'mac-team')
    const step = f.group({ reviewOf: task, step: 'Review' })
    expect(refusal(() => f.run({ type: 'work.assign', conversationId: step, agentId: reviewer }))).toBeNull()
    const clean = f.group(), cleanStep = f.group({ reviewOf: clean, step: 'Test' })
    f.run({ type: 'work.assign', conversationId: cleanStep, agentId: f.member('team-tester', 'mac-team') })
    expect(f.state.conversations.find(c => c.id === clean)!.teamWritten).toBeUndefined()
    expect(refusal(() => f.run({ type: 'work.assign', conversationId: clean, agentId: f.member('main-builder', 'mac') }))).toBeNull()
  })

  it('moves a start on the Mac into its Team account, with project settings off', () => {
    const f = swarm(), task = f.written()
    f.start(f.group({ reviewOf: task, step: 'Review' }), 'mac')
    const started = f.state.starts!.at(-1)!.request
    expect(started.machineId).toBe('mac-team')
    expect(started.projectSettings).toBe('off')
  })

  it('refuses a start where the Mac has no Team account', () => {
    const f = swarm(), task = f.written(), step = f.group({ reviewOf: task, step: 'Review' })
    f.state.machines = f.state.machines!.filter(m => m.machineId !== 'mac-team')
    expect(refusal(() => f.start(step, 'mac'))).toBe(TEAM_WRITTEN_WORK)
  })

  it('leaves an owner\'s clean task as it was: a start in the main account, project settings on', () => {
    const f = swarm()
    f.start(f.group(), 'mac')
    const started = f.state.starts!.at(-1)!.request
    expect(started.machineId).toBe('mac')
    expect(started.projectSettings).toBeUndefined()
  })

  it('reads a mark set before its assignee existed in the Swarm\'s record, on an open task, by its current assignee', () => {
    const f = swarm(), task = f.written(), stored = f.state.conversations.find(c => c.id === task)!
    delete stored.teamWritten
    expect(teamWrittenTask(f.state, stored)).toBe(true)
  })
})
