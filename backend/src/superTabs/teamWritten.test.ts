import { describe, expect, it } from 'vitest'
import { applyCommand, type Command, type CommandContext } from './commands.js'
import type { ContributedMachine } from './machines.js'
import { createSuperTab, SuperTabError, type Actor, type AgentConfiguration, type SuperTabState } from './model.js'
import { LEAD_CAPABILITY } from './leadStart.js'
import { applyPushOrigin, TEAM_WRITTEN_STOP, TEAM_WRITTEN_WORK, teamWrittenTask } from './teamWritten.js'

// Audit H2: a branch a Team agent wrote never runs with another person's rights (docs/plans/2026-11-02-team-written-branch-plan.md).
// Swarm v3 has no Team accounts to run it (task #4120, the PM's ruling there): the mark stays on every branch a Team agent pushed
// before the release, and only the project owner's own agent, on their own computer, may take one over. A teammate's agent, here
// mate's, is refused as the main account's was.
const NOW = 50_000_000
const owner: Extract<Actor, { kind: 'person' }> = { kind: 'person', userId: 'owner', email: 'owner@example.com' }
const config: AgentConfiguration = { engine: 'claude', model: 'fixture-model', effort: 'high', contextWindow: 200000, engineVersion: 'fixture' }
const requirements = { memoryBytes: 0, diskBytes: 0, maxCpuPercent: 100, tools: [], devices: [], quotaRequired: false }
const resources = { cpuPercent: 1, memoryTotalBytes: 8, memoryUsedBytes: 1, diskFreeBytes: 8, diskTotalBytes: 8, projectDiskFreeBytes: 8,
  deviceType: null, chip: null, os: null, gpuPercent: null }
const reading = { generation: 'g1', receivedAt: NOW, resources, tools: {}, quotas: [], runningHarnessIds: [], stoppedHarnessIds: [] }

function swarm() {
  let state: SuperTabState = createSuperTab('tab', 'Pilot', { id: 'owner', email: owner.email }, 'prod')
  let sequence = 0
  const generation = state.people.find(p => p.id === 'owner')!.generation
  const pool = (machineId: string, extra: Partial<ContributedMachine> = {}): ContributedMachine => ({ machineId, name: machineId, contributorId: 'owner',
    membershipGeneration: generation, generation: 'g1', cwd: '/swarm', scope: 'swarm', engines: ['claude'], maxAgents: 4, paused: false, observation: reading, ...extra })
  state.people.push({ id: 'mate', email: 'mate@example.com', role: 'collaborator', generation: 'm1' })
  state.machines = [pool('mac'), pool('mate-mac', { contributorId: 'mate', membershipGeneration: 'm1' })]
  const run = (command: Command, actor: Actor = owner, context: Partial<CommandContext> = {}) => {
    const effects = applyCommand(state, actor, command, { now: NOW, operationId: `op-${++sequence}`,
      contribution: { machineOwnerId: 'owner', contributorId: 'owner', hostGrant: null }, ...context })
    state = effects.state
    return effects
  }
  const member = (id: string, machineId: string) => {
    state.agents.push({ id, machineId, harnessId: `harness-${id}`, projectId: 'lead', machineOwnerId: 'owner', contributorId: 'owner',
      membershipGeneration: generation, hostGrant: null, name: id, configuration: config })
    return id
  }
  /** A teammate's own agent on their own computer: the one Team-written code refuses (the main account's, before v3). */
  const mates = (id: string) => {
    state.agents.push({ id, machineId: 'mate-mac', harnessId: `harness-${id}`, projectId: 'lead', machineOwnerId: 'mate', contributorId: 'mate',
      membershipGeneration: 'm1', hostGrant: null, name: id, configuration: config })
    return id
  }
  /** [agentId] already in [conversationId]. */
  const within = (conversationId: string, agentId: string) => {
    const group = state.conversations.find(c => c.id === conversationId)!
    group.agentIds = [...new Set([...group.agentIds, agentId])]
  }
  const group = (extra: Partial<Extract<Command, { type: 'conversation.create' }>> = {}, actor: Actor = owner) => String(run({ type: 'conversation.create', projectId: 'lead', title: 'Work', brief: 'Build it.',
    checks: [], ...extra }, actor).result.conversationId)
  const start = (conversationId: string, machineId: string, actor: Actor = owner, context: Partial<CommandContext> = {}) => run({ type: 'agent.start',
    request: { conversationId, machineId, engine: 'claude', name: 'Reviewer', cwd: '/swarm/lead', worktree: true, requirements } }, actor, context)
  /** As a teammate, on their own computer under their own grant. */
  const asMate: Actor = { kind: 'person', userId: 'mate', email: 'mate@example.com' }
  const mateGrant = { contribution: { machineOwnerId: 'mate', contributorId: 'mate', hostGrant: null } }
  /** A task marked Team-written before the release, its builder still in it with its finished assignment, so a review can begin. */
  const written = () => {
    const task = group(), builder = member('builder', 'mac')
    const stored = state.conversations.find(c => c.id === task)!
    Object.assign(stored, { teamWritten: true, teamWrittenBy: { kind: 'assigned' } })
    stored.assignment = { id: 'built', agentId: builder, status: 'done', configuration: config, result: null,
      execution: { machineId: 'mac', harnessId: `harness-${builder}`, machineOwnerId: 'owner' } } as never
    within(task, builder)
    return task
  }
  return { run, group, member, mates, within, start, asMate, mateGrant, written, get state() { return state } }
}
const refusal = (body: () => unknown): string | null => {
  try { body(); return null } catch (error) { if (error instanceof SuperTabError) return error.code; throw error }
}

describe('a task a Team agent worked on', () => {
  it('keeps its mark after its builder leaves it', () => {
    const f = swarm(), task = f.written()
    const stored = () => f.state.conversations.find(c => c.id === task)!
    expect(stored().teamWritten).toBe(true)
    stored().assignment = null
    expect(teamWrittenTask(f.state, stored())).toBe(true)
  })

  it('refuses a teammate\'s agent, assigned to its step or to the task itself, and takes the project owner\'s own', () => {
    const f = swarm(), task = f.written(), mates = f.mates('mates-reviewer')
    const step = f.group({ reviewOf: task, step: 'Review' })
    expect(refusal(() => f.run({ type: 'work.assign', conversationId: step, agentId: mates }))).toBe(TEAM_WRITTEN_WORK)
    f.state.conversations.find(c => c.id === task)!.assignment = null
    expect(refusal(() => f.run({ type: 'work.assign', conversationId: task, agentId: mates }))).toBe(TEAM_WRITTEN_WORK)
    expect(refusal(() => f.run({ type: 'work.assign', conversationId: step, agentId: f.member('owners-reviewer', 'mac') }))).toBeNull()
  })

  it('refuses adding a teammate\'s agent to it, and another agent\'s post naming it does not add it', () => {
    const f = swarm(), task = f.written(), mates = f.mates('main-reviewer')
    expect(refusal(() => f.run({ type: 'conversation.agent', conversationId: task, agentId: mates, present: true, lead: false }))).toBe(TEAM_WRITTEN_WORK)
    const sent = f.run({ type: 'message.send', conversationId: task, text: 'Please test this.', replyTo: null, recipientIds: [mates] },
      { kind: 'agent', agentId: 'builder', machineOwnerId: 'owner' })
    expect(f.state.conversations.find(c => c.id === task)!.agentIds).not.toContain(mates)
    expect(sent.result.notReached).toContain('main-reviewer')
  })

  it('starts only on the project owner\'s own computer, with project settings off', () => {
    const f = swarm(), task = f.written()
    f.start(f.group({ reviewOf: task, step: 'Review' }), 'mac')
    const started = f.state.starts!.at(-1)!.request
    expect(started.machineId).toBe('mac')
    expect(started.projectSettings).toBe('off')
  })

  it('refuses a start on a teammate\'s computer', () => {
    const f = swarm(), task = f.written(), step = f.group({ reviewOf: task, step: 'Review' })
    expect(refusal(() => f.start(step, 'mate-mac', f.asMate, f.mateGrant))).toBe(TEAM_WRITTEN_WORK)
  })

  it('leaves an owner\'s clean task as it was: a start in the main account, project settings on', () => {
    const f = swarm()
    f.start(f.group(), 'mac')
    const started = f.state.starts!.at(-1)!.request
    expect(started.machineId).toBe('mac')
    expect(started.projectSettings).toBeUndefined()
  })

  it('takes GitHub\'s record of a bot\'s push: a clean task is marked for good and refuses a teammate\'s agent', () => {
    const f = swarm(), task = f.group(), step = f.group({ reviewOf: task, step: 'Review' }), mates = f.mates('mates-reviewer')
    expect(refusal(() => f.run({ type: 'work.assign', conversationId: step, agentId: mates }, owner, { pushOrigin: 'team' }))).toBe(TEAM_WRITTEN_WORK)
    // Refused, so nothing it did stays: the next reading decides again, and a clean reading never clears a mark.
    f.state.conversations.find(c => c.id === task)!.teamWritten = true
    expect(refusal(() => f.run({ type: 'work.assign', conversationId: step, agentId: mates }, owner, { pushOrigin: 'clean' }))).toBe(TEAM_WRITTEN_WORK)
  })

  it('refuses a teammate\'s agent while GitHub cannot say who pushed, without marking the task, and takes it once GitHub answers', () => {
    const f = swarm(), task = f.group(), step = f.group({ reviewOf: task, step: 'Review' }), mates = f.mates('mates-reviewer')
    expect(refusal(() => f.run({ type: 'work.assign', conversationId: step, agentId: mates }, owner, { pushOrigin: 'unknown' }))).toBe(TEAM_WRITTEN_WORK)
    expect(f.state.conversations.find(c => c.id === task)!.teamWritten).toBeUndefined()
    expect(refusal(() => f.run({ type: 'work.assign', conversationId: step, agentId: mates }, owner, { pushOrigin: 'clean' }))).toBeNull()
  })

  it('lets the project owner\'s own agent take it while GitHub cannot say who pushed (task #4120)', () => {
    const f = swarm(), task = f.group(), step = f.group({ reviewOf: task, step: 'Review' }), own = f.member('owners-reviewer', 'mac')
    expect(refusal(() => f.run({ type: 'work.assign', conversationId: step, agentId: own }, owner, { pushOrigin: 'unknown' }))).toBeNull()
  })

  it('tells a teammate\'s agent on a step to stop when a Ready shows a bot\'s push on the owner\'s branch, never the owner\'s own', () => {
    const f = swarm(), task = f.group(), builder = f.member('main-builder', 'mac'), reviewer = f.mates('mates-reviewer')
    f.run({ type: 'work.assign', conversationId: task, agentId: builder })
    const assignmentId = f.state.conversations.find(c => c.id === task)!.assignment!.id
    f.run({ type: 'work.assign', conversationId: f.group({ reviewOf: task, step: 'Review' }), agentId: reviewer })
    const effects = f.run({ type: 'work.status', conversationId: task, assignmentId, status: 'review', result: 'https://github.com/acme/app/pull/7' },
      { kind: 'agent', agentId: builder, machineOwnerId: 'owner' }, { pushOrigin: 'team' })
    expect(f.state.conversations.find(c => c.id === task)!.teamWritten).toBe(true)
    expect(effects.messages.find(m => m.text === TEAM_WRITTEN_STOP)?.recipients).toEqual([reviewer])
  })

  it('tells every barred member once when it is marked, finished steps included, never the owner\'s own agent or the coordinator', () => {
    const f = swarm(), task = f.group(), builder = f.member('main-builder', 'mac'), tester = f.mates('mates-tester')
    f.run({ type: 'work.assign', conversationId: task, agentId: builder })
    const assignmentId = f.state.conversations.find(c => c.id === task)!.assignment!.id
    const testStep = f.group({ reviewOf: task, step: 'Test' })
    f.group({ reviewOf: task, step: 'Review' })
    f.run({ type: 'work.assign', conversationId: testStep, agentId: tester })
    // The Tester's step ended: it is still a member, and the same-step re-ask would reach it.
    f.state.conversations.find(c => c.id === testStep)!.assignment!.status = 'done'
    const effects = f.run({ type: 'work.status', conversationId: task, assignmentId, status: 'review', result: 'https://github.com/acme/app/pull/7' }, owner, { pushOrigin: 'team' })
    const told = effects.messages.filter(m => m.text === TEAM_WRITTEN_STOP).flatMap(m => m.recipients)
    expect(told).toEqual([tester])
    expect(told).not.toContain(builder)
  })

  it('delivers a post without a teammate\'s agent it names in a marked task, and says who was left out', () => {
    const f = swarm(), task = f.group(), builder = f.member('main-builder', 'mac'), tester = f.mates('main-tester')
    f.run({ type: 'work.assign', conversationId: task, agentId: builder })
    f.run({ type: 'conversation.agent', conversationId: task, agentId: tester, present: true, lead: false })
    f.state.conversations.find(c => c.id === task)!.teamWritten = true
    const asBuilder: Actor = { kind: 'agent', agentId: builder, machineOwnerId: 'owner' }
    const post = (conversationId: string, recipientIds: string[], actor: Actor) => f.run({ type: 'message.send', conversationId, text: 'Please test again.', replyTo: null, recipientIds }, actor)
    const sent = post(task, [tester], asBuilder)
    expect(sent.messages.find(m => m.text === 'Please test again.')!.recipients).not.toContain(tester)
    // The result names the agent who was left out, and says the post itself went out.
    expect(sent.result.notReached).toContain('main-tester')
    expect(sent.result.notReached).toContain('post was delivered')
    // A person speaks to whom they choose.
    const byPerson = post(task, [tester], owner)
    expect(byPerson.messages.find(m => m.text === 'Please test again.')!.recipients).toEqual([tester])
    expect(byPerson.result).not.toHaveProperty('notReached')
  })

  it('an agent\'s post naming a teammate\'s agent outside the group goes out without it, and the agent does not join', () => {
    const f = swarm(), task = f.written(), integrator = f.mates('main-integrator'), reviewer = f.member('owners-reviewer', 'mac')
    const step = f.group({ reviewOf: task, step: 'Review' })
    f.within(step, reviewer)
    const asReviewer: Actor = { kind: 'agent', agentId: reviewer, machineOwnerId: 'owner' }
    const sent = f.run({ type: 'message.send', conversationId: step, text: 'Ready to merge: Yes.', replyTo: null, recipientIds: [integrator] }, asReviewer)
    expect(sent.messages.find(m => m.text === 'Ready to merge: Yes.')!.recipients).not.toContain(integrator)
    expect(sent.result.notReached).toContain('main-integrator')
    expect(f.state.conversations.find(c => c.id === step)!.agentIds).not.toContain(integrator)
    expect(f.state.conversations.find(c => c.id === task)!.agentIds).not.toContain(integrator)
  })

  it('leaves out only the barred recipient when a post names a teammate\'s agent and the owner\'s own', () => {
    const f = swarm(), task = f.written(), integrator = f.mates('main-integrator'), reviewer = f.member('owners-reviewer', 'mac'), other = f.member('owners-other', 'mac')
    const step = f.group({ reviewOf: task, step: 'Review' })
    f.within(step, reviewer)
    f.within(step, other)
    const sent = f.run({ type: 'message.send', conversationId: step, text: 'Verdict.', replyTo: null, recipientIds: [integrator, other] }, { kind: 'agent', agentId: reviewer, machineOwnerId: 'owner' })
    expect(sent.messages.find(m => m.text === 'Verdict.')!.recipients).toEqual([other])
    expect(sent.result.notReached).toContain('main-integrator')
    expect(sent.result.notReached).not.toContain('owners-other')
  })

  it('does not fall back to the barred agent: its assignee, or the author of the message it answers', () => {
    const f = swarm(), task = f.group(), engineer = f.mates('main-engineer'), reviewer = f.member('owners-reviewer', 'mac')
    f.run({ type: 'work.assign', conversationId: task, agentId: engineer })
    f.within(task, reviewer)
    // Marked by GitHub's push record: the teammate's Engineer is still assigned and in the group.
    f.state.conversations.find(c => c.id === task)!.teamWritten = true
    const asReviewer: Actor = { kind: 'agent', agentId: reviewer, machineOwnerId: 'owner' }
    const sent = f.run({ type: 'message.send', conversationId: task, text: 'Please test again.', replyTo: null, recipientIds: [engineer] }, asReviewer)
    expect(sent.messages.find(m => m.text === 'Please test again.')!.recipients).toEqual([])
    expect(sent.result.notReached).toContain('main-engineer')
    const replied = f.run({ type: 'message.send', conversationId: task, text: 'And again.', replyTo: 'earlier', recipientIds: [engineer] }, asReviewer,
      { reply: { id: 'earlier', conversationId: task, author: { kind: 'agent', id: engineer, name: 'main-engineer' } } as never })
    expect(replied.messages.find(m => m.text === 'And again.')!.recipients).toEqual([])
    expect(replied.result.notReached).toContain('main-engineer')
  })

  it('does not change a post in a task no Team agent wrote: the main-account agent is named and joins as before', () => {
    const f = swarm(), task = f.group(), builder = f.member('main-builder', 'mac'), integrator = f.member('main-integrator', 'mac')
    f.run({ type: 'work.assign', conversationId: task, agentId: builder })
    const sent = f.run({ type: 'message.send', conversationId: task, text: 'Merge it.', replyTo: null, recipientIds: [integrator] }, { kind: 'agent', agentId: builder, machineOwnerId: 'owner' })
    expect(sent.messages.find(m => m.text === 'Merge it.')!.recipients).toEqual([integrator])
    expect(sent.result).not.toHaveProperty('notReached')
  })

  it('a teammate\'s agent\'s own post in a Team-written group is still refused: the rule about itself is unchanged', () => {
    const f = swarm(), task = f.written(), mates = f.mates('main-reviewer')
    const own = () => f.run({ type: 'message.send', conversationId: task, text: 'Looks fine.', replyTo: null, recipientIds: [] }, { kind: 'agent', agentId: mates, machineOwnerId: 'mate' })
    expect(refusal(own)).toBe(TEAM_WRITTEN_WORK)
  })

  it('skips a teammate\'s agent a post names by @Name in a marked task, and still posts', () => {
    const f = swarm(), task = f.group(), builder = f.member('main-builder', 'mac'), tester = f.mates('main-tester')
    f.run({ type: 'work.assign', conversationId: task, agentId: builder })
    f.run({ type: 'conversation.agent', conversationId: task, agentId: tester, present: true, lead: false })
    f.state.conversations.find(c => c.id === task)!.teamWritten = true
    const owners = f.member('owners-tester', 'mac')
    f.within(task, owners)
    const sent = f.run({ type: 'message.send', conversationId: task, text: '@main-tester and @owners-tester, please test again.', replyTo: null, recipientIds: [] },
      { kind: 'agent', agentId: builder, machineOwnerId: 'owner' })
    expect(sent.messages[0]!.recipients).toEqual([owners])
  })

  it('reads who pushed before adding an agent: a bot\'s push or an unknown refuses a teammate\'s agent', () => {
    const f = swarm(), task = f.group(), mates = f.mates('main-reviewer')
    const add = (agentId: string, pushOrigin: 'team' | 'unknown') => f.run({ type: 'conversation.agent', conversationId: task, agentId, present: true, lead: false }, owner, { pushOrigin })
    expect(refusal(() => add(mates, 'unknown'))).toBe(TEAM_WRITTEN_WORK)
    expect(refusal(() => add(mates, 'team'))).toBe(TEAM_WRITTEN_WORK)
  })

  it('refuses a PM start in the main account on a branch a bot pushed or GitHub cannot place, and takes a clean one', () => {
    for (const [pushOrigin, code] of [['team', TEAM_WRITTEN_WORK], ['unknown', TEAM_WRITTEN_WORK], ['clean', null]] as const) {
      const f = swarm()
      const projectId = String(f.run({ type: 'project.create', name: 'New', visibility: 'public', brief: '' }).result.projectId)
      f.state.machines!.find(m => m.machineId === 'mac')!.observation!.capabilities = [LEAD_CAPABILITY]
      expect(refusal(() => f.run({ type: 'lead.start', projectId, machineId: 'mac', engine: 'claude', branchRef: 'refs/remotes/origin/fix', repositoryUrl: 'https://github.com/acme/app' }, owner, { pushOrigin, machineVersions: { mac: '99.0.0' } })), pushOrigin).toBe(code)
    }
  })

  it('marks only on the server\'s own read: a client asking for the mark without one is refused', () => {
    const f = swarm(), task = f.group()
    expect(refusal(() => f.run({ type: 'work.teamWritten', conversationId: task }))).toBe('NOT_FOUND')
    expect(f.state.conversations.find(c => c.id === task)!.teamWritten).toBeUndefined()
    f.run({ type: 'work.teamWritten', conversationId: task }, owner, { pushOrigin: 'team' })
    expect(f.state.conversations.find(c => c.id === task)!.teamWritten).toBe(true)
  })

  it('reads who pushed the branch a start names: the owner\'s own computer takes a bot\'s push with project settings off, a teammate\'s takes neither it nor an unknown', () => {
    const f = swarm(), task = f.group()
    const request = (conversationId: string, machineId: string) => ({ type: 'agent.start' as const, request: { conversationId, machineId, engine: 'claude', name: 'Tester', cwd: '/swarm/lead', worktree: true, branchRef: 'refs/remotes/origin/fix', requirements } })
    expect(refusal(() => f.run(request(task, 'mate-mac'), f.asMate, { ...f.mateGrant, pushOrigin: 'unknown' }))).toBe(TEAM_WRITTEN_WORK)
    f.run(request(task, 'mac'), owner, { pushOrigin: 'team' })
    expect(f.state.starts!.at(-1)!.request).toMatchObject({ machineId: 'mac', projectSettings: 'off' })
    expect(f.state.conversations.find(c => c.id === task)!.teamWritten).toBe(true)
    expect(refusal(() => f.run(request(task, 'mate-mac'), f.asMate, { ...f.mateGrant, pushOrigin: 'team' }))).toBe(TEAM_WRITTEN_WORK)
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

  it('marks the task, not its agents: another task starts clean', () => {
    const f = swarm(), task = f.written(), clean = f.group()
    expect(f.state.conversations.find(c => c.id === task)!.teamWritten).toBe(true)
    expect(f.state.conversations.find(c => c.id === clean)!.teamWritten).toBeUndefined()
    expect(refusal(() => f.run({ type: 'work.assign', conversationId: clean, agentId: f.mates('mates-builder') }))).toBeNull()
  })

  it('keeps the coordinator on a marked task, and adding it marks nothing', () => {
    const f = swarm(), task = f.written(), lead = f.mates('mates-lead'), clean = f.group()
    f.state.projects!.find(p => p.id === 'lead')!.leadConversationId = 'lead'
    f.state.conversations.find(c => c.id === 'lead')!.leadId = lead
    f.run({ type: 'conversation.agent', conversationId: task, agentId: lead, present: true, lead: false })
    f.run({ type: 'conversation.agent', conversationId: clean, agentId: lead, present: true, lead: false })
    expect(f.state.conversations.find(c => c.id === clean)!.teamWritten).toBeUndefined()
    expect(f.state.conversations.find(c => c.id === task)!.teamWritten).toBe(true)
  })

  // #3304: a mark set by a join before this change clears once GitHub reads every pull request the task records as clean.
  describe('a clean read from GitHub', () => {
    const P = 'https://github.com/acme/app/pull/7', Q = 'https://github.com/acme/app/pull/8'
    /** A teammate's agent assigned to [step] after a clean read of [pushOriginPulls]: what a mark refuses. */
    const assignMain = (f: ReturnType<typeof swarm>, step: string, pushOriginPulls: string[]) =>
      refusal(() => f.run({ type: 'work.assign', conversationId: step, agentId: f.mates(`mates-${step}-${pushOriginPulls.length}`) }, owner, { pushOrigin: 'clean', pushOriginPulls }))
    /** A task marked as a join marked it before #3304: no cause, a step opened after it holding a copy. */
    const joinMarked = (f: ReturnType<typeof swarm>, recorded: string[]) => {
      const task = f.group(), stored = f.state.conversations.find(c => c.id === task)!
      stored.teamWritten = true
      // From before #3554 too: no code list, so it reads every pull request it recorded.
      delete stored.codePullRequestUrls
      stored.pullRequestUrls = recorded
      return { task, step: f.group({ reviewOf: task, step: 'Review' }) }
    }
    const marked = (f: ReturnType<typeof swarm>, id: string) => f.state.conversations.find(c => c.id === id)!.teamWritten

    it('clears a mark from before this change, on the task and its steps, once it covers every pull request the task records', () => {
      const f = swarm(), { task, step } = joinMarked(f, [P])
      expect(marked(f, step)).toBe(true)
      expect(assignMain(f, step, [P])).toBeNull()
      expect(marked(f, task)).toBeUndefined()
      expect(marked(f, step)).toBeUndefined()
    })

    it('keeps a mark when it did not read every pull request the task records, or the task records none', () => {
      const f = swarm(), { task, step } = joinMarked(f, [P, Q])
      expect(assignMain(f, step, [P])).toBe(TEAM_WRITTEN_WORK)
      expect(assignMain(f, step, [])).toBe(TEAM_WRITTEN_WORK)
      expect(marked(f, task)).toBe(true)
      const bare = joinMarked(f, [])
      expect(assignMain(f, bare.step, [P])).toBe(TEAM_WRITTEN_WORK)
    })

    it('keeps the mark of a Team agent assigned to build the task', () => {
      const f = swarm(), task = f.written(), stored = f.state.conversations.find(c => c.id === task)!
      stored.codePullRequestUrls = [P]
      stored.assignment = null
      expect(assignMain(f, f.group({ reviewOf: task, step: 'Review' }), [P])).toBe(TEAM_WRITTEN_WORK)
      expect(marked(f, task)).toBe(true)
    })

    it('keeps a bot push\'s mark until it covers the pull requests that push was read on', () => {
      const f = swarm(), task = f.group()
      f.state.conversations.find(c => c.id === task)!.codePullRequestUrls = [P]
      f.run({ type: 'work.teamWritten', conversationId: task }, owner, { pushOrigin: 'team', pushOriginPulls: [P, Q] })
      const step = f.group({ reviewOf: task, step: 'Review' })
      expect(assignMain(f, step, [P])).toBe(TEAM_WRITTEN_WORK)
      expect(assignMain(f, step, [P, Q])).toBeNull()
      expect(marked(f, task)).toBeUndefined()
    })

    it('keeps the mark of a bot\'s push on a branch a start named', () => {
      const f = swarm(), task = f.group()
      f.state.conversations.find(c => c.id === task)!.codePullRequestUrls = [P]
      f.run({ type: 'agent.start', request: { conversationId: task, machineId: 'mac', engine: 'claude', name: 'Tester', cwd: '/swarm/lead', worktree: true, branchRef: 'refs/remotes/origin/fix', requirements } }, owner, { pushOrigin: 'team' })
      expect(assignMain(f, f.group({ reviewOf: task, step: 'Review' }), [P])).toBe(TEAM_WRITTEN_WORK)
      expect(marked(f, task)).toBe(true)
    })

    it('keeps a step\'s own mark from a bot\'s push on the pull request it records', () => {
      const f = swarm(), { task, step } = joinMarked(f, [P])
      const other = f.group({ reviewOf: task, step: 'Test' }), stored = f.state.conversations.find(c => c.id === other)!
      stored.codePullRequestUrls = [Q]
      expect(assignMain(f, step, [P])).toBeNull()
      expect(marked(f, task)).toBeUndefined()
      expect(marked(f, other)).toBe(true)
    })
  })

})

// Task #3554: a step's own links (a reviewer's verdict citing another pull request) are read for the step alone. The task is marked
// only by the read of its own code, which the store passes beside the step's.
describe('a step\'s push read', () => {
  const OWN = 'https://github.com/acme/app/pull/7', OTHER = 'https://github.com/acme/app/pull/99'
  const setup = () => {
    const s = swarm()
    const task = s.group(), step = s.group({ reviewOf: task, step: 'Review' } as Partial<Extract<Command, { type: 'conversation.create' }>>)
    const find = (id: string) => s.state.conversations.find(c => c.id === id)!
    return { s, task: () => find(task), step: () => find(step) }
  }

  it('marks only the step when its own links read Team and the task\'s code reads clean', () => {
    const f = setup()
    applyPushOrigin(f.s.state, f.step(), 'team', [OTHER, OWN], { origin: 'clean', pulls: [OWN] })
    expect(f.step().teamWritten).toBe(true)
    expect(f.task().teamWritten).toBeUndefined()
  })

  it('marks the task and the step when the task\'s own code reads Team', () => {
    const f = setup()
    applyPushOrigin(f.s.state, f.step(), 'team', [OWN], { origin: 'team', pulls: [OWN] })
    expect(f.task().teamWritten).toBe(true)
    expect(f.task().teamWrittenBy).toEqual({ kind: 'pushed', pulls: [OWN] })
    expect(f.step().teamWritten).toBe(true)
  })

  it('marks the task as before when no read of its own code is given', () => {
    const f = setup()
    applyPushOrigin(f.s.state, f.step(), 'team', [OTHER])
    expect(f.task().teamWritten).toBe(true)
  })
})
