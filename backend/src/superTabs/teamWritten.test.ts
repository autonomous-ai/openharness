import { describe, expect, it } from 'vitest'
import { applyCommand, type Command, type CommandContext } from './commands.js'
import type { ContributedMachine } from './machines.js'
import { createSuperTab, SuperTabError, type Actor, type AgentConfiguration, type SuperTabState } from './model.js'
import { LEAD_CAPABILITY } from './leadStart.js'
import { TEAM_WRITTEN_STOP, TEAM_WRITTEN_WORK, teamWrittenTask } from './teamWritten.js'

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

  it('takes GitHub\'s record of a bot\'s push: a clean task is marked for good and refuses the main account', () => {
    const f = swarm(), task = f.group(), step = f.group({ reviewOf: task, step: 'Review' }), main = f.member('main-reviewer', 'mac')
    expect(refusal(() => f.run({ type: 'work.assign', conversationId: step, agentId: main }, owner, { pushOrigin: 'team' }))).toBe(TEAM_WRITTEN_WORK)
    // Refused, so nothing it did stays: the next reading decides again, and a clean reading never clears a mark.
    f.state.conversations.find(c => c.id === task)!.teamWritten = true
    expect(refusal(() => f.run({ type: 'work.assign', conversationId: step, agentId: main }, owner, { pushOrigin: 'clean' }))).toBe(TEAM_WRITTEN_WORK)
  })

  it('refuses the main account while GitHub cannot say who pushed, without marking the task, and takes it once GitHub answers', () => {
    const f = swarm(), task = f.group(), step = f.group({ reviewOf: task, step: 'Review' }), main = f.member('main-reviewer', 'mac')
    expect(refusal(() => f.run({ type: 'work.assign', conversationId: step, agentId: main }, owner, { pushOrigin: 'unknown' }))).toBe(TEAM_WRITTEN_WORK)
    expect(f.state.conversations.find(c => c.id === task)!.teamWritten).toBeUndefined()
    expect(refusal(() => f.run({ type: 'work.assign', conversationId: step, agentId: main }, owner, { pushOrigin: 'clean' }))).toBeNull()
  })

  it('still gives a Team agent the work while GitHub cannot say who pushed', () => {
    const f = swarm(), step = f.group({ reviewOf: f.group(), step: 'Review' })
    expect(refusal(() => f.run({ type: 'work.assign', conversationId: step, agentId: f.member('team-reviewer', 'mac-team') }, owner, { pushOrigin: 'unknown' }))).toBeNull()
  })

  it('tells a main-account agent on a step to stop when a Ready shows a bot\'s push on the owner\'s branch', () => {
    const f = swarm(), task = f.group(), builder = f.member('main-builder', 'mac'), reviewer = f.member('main-reviewer', 'mac')
    f.run({ type: 'work.assign', conversationId: task, agentId: builder })
    const assignmentId = f.state.conversations.find(c => c.id === task)!.assignment!.id
    f.run({ type: 'work.assign', conversationId: f.group({ reviewOf: task, step: 'Review' }), agentId: reviewer })
    const effects = f.run({ type: 'work.status', conversationId: task, assignmentId, status: 'review', result: 'https://github.com/acme/app/pull/7' },
      { kind: 'agent', agentId: builder, machineOwnerId: 'owner' }, { pushOrigin: 'team' })
    expect(f.state.conversations.find(c => c.id === task)!.teamWritten).toBe(true)
    expect(effects.messages.find(m => m.text === TEAM_WRITTEN_STOP)?.recipients).toEqual([reviewer])
  })

  it('tells every main-account member once when it is marked, finished steps included, and never the coordinator or a Team agent', () => {
    const f = swarm(), task = f.group(), builder = f.member('main-builder', 'mac'), tester = f.member('main-tester', 'mac'), team = f.member('team-reviewer', 'mac-team')
    f.run({ type: 'work.assign', conversationId: task, agentId: builder })
    const assignmentId = f.state.conversations.find(c => c.id === task)!.assignment!.id
    const testStep = f.group({ reviewOf: task, step: 'Test' }), reviewStep = f.group({ reviewOf: task, step: 'Review' })
    f.run({ type: 'work.assign', conversationId: testStep, agentId: tester })
    f.run({ type: 'work.assign', conversationId: reviewStep, agentId: team })
    // The Tester's step ended: it is still a member, and the same-step re-ask would reach it.
    f.state.conversations.find(c => c.id === testStep)!.assignment!.status = 'done'
    const effects = f.run({ type: 'work.status', conversationId: task, assignmentId, status: 'review', result: 'https://github.com/acme/app/pull/7' }, owner, { pushOrigin: 'team' })
    const told = effects.messages.filter(m => m.text === TEAM_WRITTEN_STOP).flatMap(m => m.recipients)
    expect(told.sort()).toEqual([builder, tester].sort())
  })

  it('tells the main-account members when a Team agent is assigned to their clean task', () => {
    const f = swarm(), task = f.group(), builder = f.member('main-builder', 'mac')
    f.run({ type: 'conversation.agent', conversationId: task, agentId: builder, present: true, lead: false })
    const effects = f.run({ type: 'work.assign', conversationId: task, agentId: f.member('team-builder', 'mac-team') })
    expect(effects.messages.find(m => m.text === TEAM_WRITTEN_STOP)?.recipients).toEqual([builder])
  })

  it('refuses a post that names a main-account member of a marked task: the re-test the workflow asks for', () => {
    const f = swarm(), task = f.group(), builder = f.member('main-builder', 'mac'), tester = f.member('main-tester', 'mac')
    f.run({ type: 'work.assign', conversationId: task, agentId: builder })
    const step = f.group({ reviewOf: task, step: 'Test' })
    f.run({ type: 'work.assign', conversationId: step, agentId: tester })
    f.state.conversations.find(c => c.id === task)!.teamWritten = true
    const asBuilder: Actor = { kind: 'agent', agentId: builder, machineOwnerId: 'owner' }
    const post = (conversationId: string, recipientIds: string[], actor: Actor) => f.run({ type: 'message.send', conversationId, text: 'Please test again.', replyTo: null, recipientIds }, actor)
    expect(refusal(() => post(step, [tester], asBuilder))).toBe(TEAM_WRITTEN_WORK)
    expect(refusal(() => post(task, [tester], asBuilder))).toBe(TEAM_WRITTEN_WORK)
    // A Team agent may still be named, and a person speaks to whom they choose.
    const team = f.member('team-tester', 'mac-team')
    f.run({ type: 'conversation.agent', conversationId: task, agentId: team, present: true, lead: false })
    expect(refusal(() => post(task, [team], asBuilder))).toBeNull()
    expect(refusal(() => post(task, [tester], owner))).toBeNull()
  })

  // #2963: @Name in the text names an agent too, but only one the sender may name; it never turns a post into a refusal.
  it('skips a main-account member a post names by @Name in a marked task, and still posts', () => {
    const f = swarm(), task = f.group(), builder = f.member('main-builder', 'mac'), tester = f.member('main-tester', 'mac')
    f.run({ type: 'work.assign', conversationId: task, agentId: builder })
    f.run({ type: 'conversation.agent', conversationId: task, agentId: tester, present: true, lead: false })
    f.state.conversations.find(c => c.id === task)!.teamWritten = true
    const team = f.member('team-tester', 'mac-team')
    f.run({ type: 'conversation.agent', conversationId: task, agentId: team, present: true, lead: false })
    const sent = f.run({ type: 'message.send', conversationId: task, text: '@main-tester and @team-tester, please test again.', replyTo: null, recipientIds: [] },
      { kind: 'agent', agentId: builder, machineOwnerId: 'owner' })
    expect(sent.messages[0]!.recipients).toEqual([team])
  })

  it('reads who pushed before adding an agent: a bot\'s push or an unknown refuses the main account, and a Team agent still joins', () => {
    const f = swarm(), task = f.group(), main = f.member('main-reviewer', 'mac')
    const add = (agentId: string, pushOrigin: 'team' | 'unknown') => f.run({ type: 'conversation.agent', conversationId: task, agentId, present: true, lead: false }, owner, { pushOrigin })
    expect(refusal(() => add(main, 'unknown'))).toBe(TEAM_WRITTEN_WORK)
    expect(refusal(() => add(main, 'team'))).toBe(TEAM_WRITTEN_WORK)
    expect(refusal(() => add(f.member('team-a', 'mac-team'), 'unknown'))).toBeNull()
  })

  it('refuses a PM start in the main account on a branch a bot pushed or GitHub cannot place, and takes a clean one', () => {
    for (const [pushOrigin, code] of [['team', TEAM_WRITTEN_WORK], ['unknown', TEAM_WRITTEN_WORK], ['clean', null]] as const) {
      const f = swarm()
      const projectId = String(f.run({ type: 'project.create', name: 'New', visibility: 'public', brief: '' }).result.projectId)
      f.state.machines!.find(m => m.machineId === 'mac')!.observation!.capabilities = [LEAD_CAPABILITY]
      expect(refusal(() => f.run({ type: 'lead.start', projectId, machineId: 'mac', engine: 'claude', branchRef: 'refs/remotes/origin/fix', repositoryUrl: 'https://github.com/acme/app' }, owner, { pushOrigin, machineVersions: { mac: '99.0.0', 'mac-team': '99.0.0' } })), pushOrigin).toBe(code)
    }
  })

  it('marks only on the server\'s own read: a client asking for the mark without one is refused', () => {
    const f = swarm(), task = f.group()
    expect(refusal(() => f.run({ type: 'work.teamWritten', conversationId: task }))).toBe('NOT_FOUND')
    expect(f.state.conversations.find(c => c.id === task)!.teamWritten).toBeUndefined()
    f.run({ type: 'work.teamWritten', conversationId: task }, owner, { pushOrigin: 'team' })
    expect(f.state.conversations.find(c => c.id === task)!.teamWritten).toBe(true)
  })

  it('does not mark a clean task when a Team agent with a step on it joins its chat: it reads or tests, and a push of its own shows in GitHub', () => {
    const f = swarm(), task = f.group(), builder = f.member('main-builder', 'mac'), tester = f.member('team-tester', 'mac-team')
    f.run({ type: 'work.assign', conversationId: task, agentId: builder })
    f.run({ type: 'work.assign', conversationId: f.group({ reviewOf: task, step: 'Test' }), agentId: tester })
    const stored = f.state.conversations.find(c => c.id === task)!
    // Named after leaving the task's chat, and posting there itself: each joins it again.
    stored.agentIds = stored.agentIds.filter(id => id !== tester)
    const named = f.run({ type: 'message.send', conversationId: task, text: 'Please test again.', replyTo: null, recipientIds: [tester] }, { kind: 'agent', agentId: builder, machineOwnerId: 'owner' })
    expect(f.state.conversations.find(c => c.id === task)!.teamWritten).toBeUndefined()
    expect(named.messages.some(m => m.text === TEAM_WRITTEN_STOP)).toBe(false)
    const again = f.state.conversations.find(c => c.id === task)!
    again.agentIds = again.agentIds.filter(id => id !== tester)
    f.run({ type: 'message.send', conversationId: task, text: 'Testing now.', replyTo: null, recipientIds: [] }, { kind: 'agent', agentId: tester, machineOwnerId: 'owner' })
    expect(f.state.conversations.find(c => c.id === task)!.teamWritten).toBeUndefined()
  })

  it('still marks a task when a Team agent with a step on it is assigned the task itself', () => {
    const f = swarm(), task = f.group(), tester = f.member('team-tester', 'mac-team')
    f.run({ type: 'work.assign', conversationId: f.group({ reviewOf: task, step: 'Test' }), agentId: tester })
    f.state.conversations.find(c => c.id === task)!.assignment = null
    const free = f.state.conversations.find(c => c.reviewOf === task)!
    free.assignment!.status = 'done'
    f.run({ type: 'work.assign', conversationId: task, agentId: tester })
    expect(f.state.conversations.find(c => c.id === task)!.teamWritten).toBe(true)
  })

  it('marks a clean task when another agent names a Team agent into it', () => {
    const f = swarm(), task = f.group(), builder = f.member('main-builder', 'mac')
    f.run({ type: 'work.assign', conversationId: task, agentId: builder })
    f.run({ type: 'message.send', conversationId: task, text: 'Please look.', replyTo: null, recipientIds: [f.member('team-a', 'mac-team')] }, { kind: 'agent', agentId: builder, machineOwnerId: 'owner' })
    expect(f.state.conversations.find(c => c.id === task)!.teamWritten).toBe(true)
  })

  it('reads who pushed the branch a start names: a bot\'s push moves it to the Team account, an unknown branch stays out of the main account', () => {
    const f = swarm(), task = f.group()
    const request = (conversationId: string) => ({ type: 'agent.start' as const, request: { conversationId, machineId: 'mac', engine: 'claude', name: 'Tester', cwd: '/swarm/lead', worktree: true, branchRef: 'refs/remotes/origin/fix', requirements } })
    expect(refusal(() => f.run(request(task), owner, { pushOrigin: 'unknown' }))).toBe(TEAM_WRITTEN_WORK)
    f.run(request(task), owner, { pushOrigin: 'team' })
    expect(f.state.starts!.at(-1)!.request).toMatchObject({ machineId: 'mac-team', projectSettings: 'off' })
    expect(f.state.conversations.find(c => c.id === task)!.teamWritten).toBe(true)
  })

  it('refuses an agent of another project as it refuses one on any task, so the answer says nothing of the mark', () => {
    const f = swarm(), task = f.written()
    const other = String(f.run({ type: 'project.create', name: 'Other', visibility: 'public', brief: '' }).result.projectId)
    const outsider = f.member('outsider', 'mac')
    f.state.agents.find(a => a.id === outsider)!.projectId = other
    const code = (conversationId: string) => { try { f.run({ type: 'work.assign', conversationId, agentId: outsider }); return null } catch (error) { return (error as SuperTabError).code } }
    f.state.conversations.find(c => c.id === task)!.assignment = null
    const clean = f.group()
    expect(code(task)).toBe(code(clean))
    expect(code(task)).not.toBe(TEAM_WRITTEN_WORK)
  })

  it('marks the task and not the agent: the same Team agent\'s next task elsewhere starts clean until it is assigned there', () => {
    const f = swarm(), task = f.written(), clean = f.group()
    expect(f.state.conversations.find(c => c.id === task)!.teamWritten).toBe(true)
    expect(f.state.conversations.find(c => c.id === clean)!.teamWritten).toBeUndefined()
    expect(refusal(() => f.run({ type: 'work.assign', conversationId: clean, agentId: f.member('main-builder', 'mac') }))).toBeNull()
  })

  it('keeps the coordinator on a marked task, and it marks nothing when it runs in a Team account', () => {
    const f = swarm(), task = f.written(), lead = f.member('lead-on-team', 'mac-team'), clean = f.group()
    f.state.projects!.find(p => p.id === 'lead')!.leadConversationId = 'lead'
    f.state.conversations.find(c => c.id === 'lead')!.leadId = lead
    f.run({ type: 'conversation.agent', conversationId: clean, agentId: lead, present: true, lead: false })
    expect(f.state.conversations.find(c => c.id === clean)!.teamWritten).toBeUndefined()
    expect(f.state.conversations.find(c => c.id === task)!.teamWritten).toBe(true)
  })

  it('reads a mark set before its assignee existed in the Swarm\'s record, on an open task, by its current assignee', () => {
    const f = swarm(), task = f.written(), stored = f.state.conversations.find(c => c.id === task)!
    delete stored.teamWritten
    expect(teamWrittenTask(f.state, stored)).toBe(true)
  })
})
