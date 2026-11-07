import { describe, expect, it } from 'vitest'
import { applyCommand, type Command, type CommandContext } from './commands.js'
import type { ContributedMachine } from './machines.js'
import { createSuperTab, SuperTabError, type Actor, type SuperTabState } from './model.js'
import { memberPlan, memberQueue } from './members.js'
import { crewSwarm } from './dispatch.test.js'
import { dispatchPlan, DISPATCH_RULES } from './dispatch.js'

// Task #4697 (anh Dee 11-07 21:20, card #4693 part A): one Member per person and project, made on their first accepted task
// there; that project's tasks they ask for go to it one at a time; helpers only by three checks; every asked task needs
// its person's Accept, and Accept all is refused for subscription accounts.
const NOW = 50_000_000
const owner: Extract<Actor, { kind: 'person' }> = { kind: 'person', userId: 'owner', email: 'owner@example.com' }
const kai: Extract<Actor, { kind: 'person' }> = { kind: 'person', userId: 'kai', email: 'kai@example.com' }
const resources = { cpuPercent: 1, memoryTotalBytes: 64e9, memoryUsedBytes: 1e9, diskFreeBytes: 500e9, diskTotalBytes: 1e12, projectDiskFreeBytes: 500e9,
  deviceType: null, chip: null, os: null, gpuPercent: null }
type Quota = { engine: string; known: boolean; windows: Array<{ name: string; usedPercent: number; resetsAt: null }> }
const subscription = (usedPercent = 10): Quota => ({ engine: 'claude', known: true, windows: [{ name: 'weekly', usedPercent, resetsAt: null }] })
const api: Quota = { engine: 'claude', known: true, windows: [] }
const unknown: Quota = { engine: 'claude', known: false, windows: [] }
const code = (body: () => unknown): string | null => {
  try { body(); return null } catch (error) { return error instanceof SuperTabError ? error.code : 'INVALID' }
}

export function swarm(quotas: Quota[] = [subscription()]) {
  let state: SuperTabState = createSuperTab('tab', 'Pilot', { id: 'owner', email: owner.email }, 'prod')
  let sequence = 0
  const run = (command: Command, actor: Actor = owner, context: Partial<CommandContext> = {}) => {
    const effects = applyCommand(state, actor, command, { now: NOW, operationId: `op-${++sequence}`, ...context })
    state = effects.state
    return effects
  }
  const invited = run({ type: 'invite.create', email: kai.email, role: 'collaborator', conversationId: 'lead' })
  run({ type: 'invite.accept', inviteId: invited.result.inviteId as string }, kai)
  const machine = (machineId: string, contributorId: string, extra: Partial<ContributedMachine> = {}): ContributedMachine => ({
    machineId, name: machineId, contributorId, membershipGeneration: state.people.find(p => p.id === contributorId)!.generation, generation: 'g1',
    cwd: '/swarm', scope: 'swarm', engines: ['claude'], maxAgents: 4, paused: false,
    observation: { generation: 'g1', receivedAt: NOW, sessionKind: 'computer', resources, tools: {}, quotas, runningHarnessIds: [], stoppedHarnessIds: [],
      capabilities: ['regularAgent'] }, ...extra })
  state.machines = [machine('kai-mac', 'kai'), machine('owner-mac', 'owner')]
  const project = (name: string) => run({ type: 'project.create', name, visibility: 'public', brief: '' }).result.projectId as string
  /** A task Kai asks for in [projectId], made by its Lead as an asked task is. */
  const ask = (projectId: string, title: string, extra: Record<string, unknown> = {}) => {
    const chat = state.projects!.find(p => p.id === projectId)!.leadConversationId
    return run({ type: 'conversation.create', title, brief: 'Do it.', projectId, requesterId: 'kai', priority: 'P2',
      task: { goal: title, changes: 'Change it.', constraints: 'None.', owns: ['src/a/'] }, checks: [{ description: 'Works.', independent: false }],
      ...extra } as unknown as Command, owner).result.conversationId as string ?? chat
  }
  const group = (id: string) => state.conversations.find(c => c.id === id)!
  return { run, machine, project, ask, group, get state() { return state }, set state(next: SuperTabState) { state = next } }
}

describe('Accept', () => {
  it('stages the task of a person who asks to accept each one', () => {
    const f = swarm()
    f.run({ type: 'member.approvalMode', mode: 'review' }, kai)
    const lamp = f.project('lamp')
    expect(f.group(f.ask(lamp, 'Fix the boot logo')).taskApproval).toMatchObject({ personId: 'kai', state: 'proposal' })
  })

  it('refuses Accept all for a subscription account, or one whose kind is not known yet', () => {
    for (const quota of [subscription(), unknown]) {
      const f = swarm([quota])
      expect(code(() => f.run({ type: 'member.approvalMode', mode: 'autoApprove' }, kai))).toBe('ACCEPT_ALL_SUBSCRIPTION')
    }
    // Ask me stays theirs to choose.
    const f = swarm()
    f.run({ type: 'member.approvalMode', mode: 'review' }, kai)
    expect(f.state.people.find(p => p.id === 'kai')!.approvalMode).toBe('review')
  })

  it('allows Accept all for API accounts alone, and then does not stage their tasks', () => {
    const f = swarm([api])
    f.run({ type: 'member.approvalMode', mode: 'review' }, kai)
    f.run({ type: 'member.approvalMode', mode: 'autoApprove' }, kai)
    const lamp = f.project('lamp')
    expect(f.group(f.ask(lamp, 'Fix the boot logo')).taskApproval).toBeUndefined()
  })

  it('still stages a task for an Accept all kept from before on a subscription account', () => {
    const f = swarm()
    f.state.people.find(p => p.id === 'kai')!.approvalMode = 'autoApprove'
    const lamp = f.project('lamp')
    expect(f.group(f.ask(lamp, 'Fix the boot logo')).taskApproval).toMatchObject({ state: 'proposal' })
  })
})

describe('the first Accept', () => {
  /** Kai, asking to accept each task, with a task asked in lamp and accepted. */
  function accepted(f = swarm()) {
    f.run({ type: 'member.approvalMode', mode: 'review' }, kai)
    const lamp = f.project('lamp')
    const first = f.ask(lamp, 'Fix the boot logo')
    const approved = f.run({ type: 'task.approve', conversationId: first }, kai)
    return { f, lamp, first, approved }
  }
  const memberStarts = (f: ReturnType<typeof swarm>) => (f.state.starts ?? []).filter(s => s.request.member)

  it('starts the person\'s Member for that project on their own computer and account, named for it', () => {
    const { f, lamp } = accepted()
    const [start] = memberStarts(f)
    expect(memberStarts(f)).toHaveLength(1)
    expect(start).toMatchObject({ contributorId: 'kai', machineOwnerId: 'kai', hostGrant: null })
    expect(start!.request).toMatchObject({ machineId: 'kai-mac', regular: true, mainProjectId: lamp, member: { projectId: lamp }, worktree: true })
    expect(start!.request.name).toMatch(/^[A-Z][a-z]+ · lamp$/)
    expect(f.group(start!.request.conversationId)).toMatchObject({ kind: 'agent-chat', title: start!.request.name })
  })

  it('starts none for a later Accept in the same project', () => {
    const { f, lamp } = accepted()
    const second = f.ask(lamp, 'Fix the fan')
    f.run({ type: 'task.approve', conversationId: second }, kai)
    expect(memberStarts(f)).toHaveLength(1)
  })

  it('never uses another person\'s computer, a Team account or a Buddy-only one, and says why when it has none', () => {
    const f = swarm()
    f.state.machines = [f.machine('owner-mac', 'owner'), f.machine('kai-team', 'kai', { observation: { ...f.machine('x', 'kai').observation!, sessionKind: 'team' } }),
      f.machine('kai-buddy', 'kai', { buddyOnly: true })]
    const { first } = accepted(f)
    expect(memberStarts(f)).toHaveLength(0)
    expect(f.group(first).taskApproval?.state).toBe('approved')
    expect(f.state.conversations.find(c => c.id === first)).toBeTruthy()
    const said = f.run({ type: 'task.approve', conversationId: f.ask(f.state.projects!.find(p => p.name === 'lamp')!.id, 'Again') }, kai).messages
    expect(said.map(m => m.text)).toContainEqual(expect.stringContaining('no computer in this Swarm'))
  })
})

/** Kai's Member in lamp, started and running on Kai's computer, with [count] more of Kai's tasks there accepted. */
export function withMember(f = swarm(), count = 1) {
  f.run({ type: 'member.approvalMode', mode: 'review' }, kai)
  const lamp = f.project('lamp')
  const tasks = Array.from({ length: count + 1 }, (_, i) => f.ask(lamp, `Task ${i}`))
  for (const id of tasks) f.run({ type: 'task.approve', conversationId: id }, kai)
  const start = f.state.starts!.find(s => s.request.member)!
  const own = { contribution: { machineOwnerId: 'kai', contributorId: 'kai' } }
  f.run({ type: 'agent.startDispatch', startId: start.id }, kai, own)
  const member = f.run({ type: 'agent.started', startId: start.id, harnessId: 'h-member',
    configuration: { engine: 'claude', model: 'opus', effort: 'high', contextWindow: null, engineVersion: null } }, kai, own).result.agentId as string
  return { f, lamp, tasks, member }
}

describe('the waiting queue', () => {
  it('orders a person\'s tasks by priority, then age', () => {
    const f = swarm()
    f.run({ type: 'member.approvalMode', mode: 'review' }, kai)
    const lamp = f.project('lamp')
    const old2 = f.ask(lamp, 'Old P2', { priority: 'P2' }), p1 = f.ask(lamp, 'P1', { priority: 'P1' })
    const new2 = f.ask(lamp, 'New P2', { priority: 'P2' }), p0 = f.ask(lamp, 'P0', { priority: 'P0' })
    for (const id of [old2, p1, new2, p0]) f.run({ type: 'task.approve', conversationId: id }, kai)
    expect(memberQueue(f.state, lamp, 'kai', NOW).map(g => g.id)).toEqual([p0, p1, old2, new2])
  })

  it('leaves out a task its person has not accepted', () => {
    const f = swarm()
    f.run({ type: 'member.approvalMode', mode: 'review' }, kai)
    const lamp = f.project('lamp')
    f.ask(lamp, 'Not accepted')
    expect(memberQueue(f.state, lamp, 'kai', NOW)).toEqual([])
  })
})

describe('the Member', () => {
  it('is planned its person\'s next task when free, and nothing while it holds one', () => {
    const { f, lamp, tasks, member } = withMember()
    expect(memberPlan(f.state, lamp, NOW)).toEqual([{ kind: 'assign', conversationId: tasks[0], agentId: member }])
    f.run({ type: 'work.assign', conversationId: tasks[0]!, agentId: member }, owner)
    expect(memberPlan(f.state, lamp, NOW).filter(p => p.kind === 'assign')).toEqual([])
  })

  it('is asked to start for a person whose waiting task has no Member yet, as Accept all\'s tasks have none', () => {
    const f = swarm([api])
    f.run({ type: 'member.approvalMode', mode: 'review' }, kai)
    f.run({ type: 'member.approvalMode', mode: 'autoApprove' }, kai)
    const lamp = f.project('lamp')
    const id = f.ask(lamp, 'No Accept needed')
    expect(memberPlan(f.state, lamp, NOW)).toEqual([{ kind: 'start', conversationId: id }])
    f.run({ type: 'member.start', conversationId: id }, owner)
    expect(f.state.starts!.filter(s => s.request.member)).toHaveLength(1)
    expect(memberPlan(f.state, lamp, NOW)).toEqual([])
  })

  // The host contract of #4698 (Threadland): a host that says memberSetUp reports the project set up before work comes.
  it('waits for its set-up on a host that reports one, and is refused another agent\'s report', () => {
    const f = swarm()
    f.state.machines!.find(m => m.machineId === 'kai-mac')!.observation!.capabilities!.push('memberSetUp')
    const { lamp, tasks, member } = withMember(f)
    expect(memberPlan(f.state, lamp, NOW)).toEqual([])
    const me: Actor = { kind: 'agent', agentId: member, machineOwnerId: 'kai' }
    expect(code(() => f.run({ type: 'agent.setUp', projectId: lamp, ok: true, steps: ['npm ci'] } as Command, owner))).not.toBeNull()
    f.run({ type: 'agent.setUp', projectId: lamp, ok: true, steps: ['npm ci'] } as Command, me)
    expect(f.state.agents.find(a => a.id === member)!.setUp).toMatchObject({ projectId: lamp, steps: ['npm ci'] })
    expect(memberPlan(f.state, lamp, NOW)).toEqual([{ kind: 'assign', conversationId: tasks[0], agentId: member }])
  })

  it('sleeps once its task ends with nothing waiting, and wakes for its next one', () => {
    const { f, tasks, member } = withMember(swarm(), 0)
    const assigned = f.run({ type: 'work.assign', conversationId: tasks[0]!, agentId: member }, owner)
    const assignmentId = f.group(tasks[0]!).assignment!.id
    const me: Actor = { kind: 'agent', agentId: member, machineOwnerId: 'kai' }
    f.run({ type: 'work.status', conversationId: tasks[0]!, assignmentId, status: 'done', result: 'Done at abc: https://github.com/o/r/pull/1' }, me)
    expect(f.state.agents.find(a => a.id === member)!.asleep).toEqual({ since: NOW })
    expect(assigned).toBeTruthy()
  })
})

describe('a crew agent', () => {
  it('is never planned a task another person asked for, and still gets work nobody asked for', () => {
    const s = crewSwarm(['Ada'])
    s.run({ type: 'crew.add', agentId: s.ids.Ada!, role: 'engineer', lane: 'backend' })
    const asked = s.task('Asked', ['backend/src/a.ts'])
    s.state.people.push({ id: 'kai', email: kai.email, role: 'collaborator', generation: 'g' })
    s.group(asked).requesterId = 'kai'
    const free = s.task('Free', ['backend/src/b.ts'])
    expect(dispatchPlan(s.state, 'lead', DISPATCH_RULES, 1000).map(p => p.conversationId)).toEqual([free])
  })
})
