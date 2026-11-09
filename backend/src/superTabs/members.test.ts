import { describe, expect, it } from 'vitest'
import { applyCommand, type Command, type CommandContext } from './commands.js'
import type { ContributedMachine } from './machines.js'
import { createSuperTab, SuperTabError, type Actor, type SuperTabState } from './model.js'
import { helperCheck, memberPlan, memberQueue } from './members.js'
import { dispatchPlan, DISPATCH_RULES } from './dispatch.js'
import { touchesFor } from './parts/touches.js'
import { canReadAgent } from './projects.js'
import * as store from './parts/index.js'
import { readerView } from './read/views.js'

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
    // In its project's folder with a worktree, as any project agent's (#4698: a helper copies from it, sleep reopens it in place).
    expect(start!.request).toMatchObject({ machineId: 'kai-mac', regular: true, mainProjectId: lamp, member: { projectId: lamp },
      cwd: `/swarm/${lamp}`, worktree: true })
    expect(start!.request.name).toMatch(/^[A-Z][a-z]+ · lamp$/)
    expect(f.group(start!.request.conversationId)).toMatchObject({ kind: 'agent-chat', title: start!.request.name })
  })

  // Two Accepts at once never take one free name or one slot: the start meets others on the head and its computer's ledger.
  it('meets other starts on the head and on its computer\'s slots', () => {
    const f = swarm()
    f.run({ type: 'member.approvalMode', mode: 'review' }, kai)
    const lamp = f.project('lamp')
    const id = f.ask(lamp, 'Fix the boot logo')
    const before = f.state
    const command: Command = { type: 'task.approve', conversationId: id }
    const effects = f.run(command, kai)
    const touches = touchesFor(command, kai, before, effects)
    expect(touches).toEqual(expect.arrayContaining([{ kind: 'head', key: 'head' }, { kind: 'machine', key: 'kai-mac' }]))
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
  f.run({ type: 'agent.startSettled', startId: start.id, warning: null }, kai, own)
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
    f.run({ type: 'member.start', conversationId: id }, kai)
    expect(f.state.starts!.filter(s => s.request.member)).toHaveLength(1)
    expect(memberPlan(f.state, lamp, NOW)).toEqual([])
  })

  // The host contract of #4698 (Threadland): a host that says memberSetUp reports the project set up before work comes.
  // Its mark names its project, which may be private: readers never get it, as its main project's id (read/views.ts).
  // Security review 2 of #3575: its set-up record names that project too, with its commands or failure text.
  it('keeps its mark and set-up out of what readers get, its host alone reads them', () => {
    const { f, lamp, member } = withMember()
    f.run({ type: 'agent.setUp', projectId: lamp, ok: true, steps: ['npm ci'] } as Command, { kind: 'agent', agentId: member, machineOwnerId: 'kai' })
    const parts = readerView(store.split(f.state, { tabId: 'tab', version: 9_000, now: NOW }), owner, NOW, {}).parts
    const row = parts.agents.find(a => a.key === member)?.data
    expect(row).not.toHaveProperty('member')
    expect(row).not.toHaveProperty('setUp')
  })

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

  // Until the migration (#4693 part D) makes them Members, a person's own crew agents in the project take their asks as today.
  it('is not started for a person whose own crew agent works in that project', () => {
    const f = swarm([api])
    f.run({ type: 'member.approvalMode', mode: 'review' }, kai)
    f.run({ type: 'member.approvalMode', mode: 'autoApprove' }, kai)
    const lamp = f.project('lamp')
    const chat = f.state.projects!.find(p => p.id === lamp)!.leadConversationId
    const config = { engine: 'claude' as const, model: 'opus', effort: 'high', contextWindow: null, engineVersion: null }
    const crew = f.run({ type: 'agent.add', conversationId: chat, machineId: 'kai-mac', harnessId: 'kai-crew', name: 'Kai crew', configuration: config, lead: false },
      kai, { contribution: { machineOwnerId: 'kai', contributorId: 'kai' } }).result.agentId as string
    f.state.agents.find(a => a.id === crew)!.crew = { role: 'engineer', at: NOW, by: 'owner' }
    f.ask(lamp, 'Their own crew takes it')
    expect(memberPlan(f.state, lamp, NOW)).toEqual([])
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
    const f = swarm()
    const config = { engine: 'claude' as const, model: 'opus', effort: 'high', contextWindow: null, engineVersion: null }
    const add = (name: string, lead = false) => f.run({ type: 'agent.add', conversationId: 'lead', machineId: 'owner-mac', harnessId: name, name,
      configuration: config, lead }, owner, { contribution: { machineOwnerId: 'owner', contributorId: 'owner' } }).result.agentId as string
    add('PM', true)
    const ada = add('Ada')
    f.run({ type: 'crew.add', agentId: ada, role: 'engineer', lane: 'backend' })
    const task = (title: string, extra: Record<string, unknown>) => f.run({ type: 'conversation.create', title, brief: 'Do it.',
      task: { goal: title, changes: 'Change it.', constraints: 'None.', owns: ['backend/src/a.ts'] }, checks: [], ...extra } as unknown as Command).result.conversationId as string
    f.run({ type: 'member.approvalMode', mode: 'review' }, kai)
    const asked = task('Asked', { requesterId: 'kai' })
    f.run({ type: 'task.approve', conversationId: asked }, kai)
    const free = task('Free', {})
    expect(dispatchPlan(f.state, 'lead', DISPATCH_RULES, NOW).map(p => p.conversationId)).toEqual([free])
  })
})

describe('a helper', () => {
  const owns = (paths: string[]) => ({ task: { goal: 'Do it.', changes: 'Change it.', constraints: 'None.', owns: paths } })
  /** Kai's Member busy on a task owning src/a/, and a second task owning [second] waiting. */
  function busy(paths: string[], f = swarm()) {
    f.run({ type: 'member.approvalMode', mode: 'review' }, kai)
    const lamp = f.project('lamp')
    const running = f.ask(lamp, 'Running', owns(['src/a/']))
    const waiting = f.ask(lamp, 'Waiting', owns(paths))
    for (const id of [running, waiting]) f.run({ type: 'task.approve', conversationId: id }, kai)
    const start = f.state.starts!.find(s => s.request.member)!
    const own = { contribution: { machineOwnerId: 'kai', contributorId: 'kai' } }
    f.run({ type: 'agent.startDispatch', startId: start.id }, kai, own)
    const member = f.run({ type: 'agent.started', startId: start.id, harnessId: 'h-member',
      configuration: { engine: 'claude', model: 'opus', effort: 'high', contextWindow: null, engineVersion: null } }, kai, own).result.agentId as string
    f.run({ type: 'agent.startSettled', startId: start.id, warning: null }, kai, own)
    f.run({ type: 'work.assign', conversationId: running, agentId: member }, owner)
    const agent = () => f.state.agents.find(a => a.id === member)!
    return { f, lamp, running, waiting, member, agent }
  }

  it('starts when the task touches other code, the computer has room and the quota is above the floor', () => {
    const { f, lamp, waiting, agent } = busy(['src/b/'])
    expect(helperCheck(f.state, agent(), f.group(waiting), NOW)).toEqual({ ok: true })
    expect(memberPlan(f.state, lamp, NOW)).toEqual([{ kind: 'helper', conversationId: waiting }])
  })

  it('waits when the task touches the running work\'s code, or names no code to tell them apart', () => {
    for (const paths of [['src/a/b.ts'], ['src'], ['the login screen']]) {
      const { f, lamp, waiting, agent } = busy(paths)
      expect(helperCheck(f.state, agent(), f.group(waiting), NOW)).toEqual({ ok: false, reason: 'overlap' })
      expect(memberPlan(f.state, lamp, NOW)).toEqual([])
    }
  })

  it('waits when the computer has no room under its limit', () => {
    const f = swarm()
    const { waiting, agent } = busy(['src/b/'], f)
    f.state.machines!.find(m => m.machineId === 'kai-mac')!.maxAgents = 1
    expect(helperCheck(f.state, agent(), f.group(waiting), NOW)).toEqual({ ok: false, reason: 'room' })
  })

  it('waits when the quota is at the floor, or not known', () => {
    for (const quota of [subscription(96), unknown]) {
      const { f, waiting, agent } = busy(['src/b/'])
      f.state.machines!.find(m => m.machineId === 'kai-mac')!.observation!.quotas = [quota]
      expect(helperCheck(f.state, agent(), f.group(waiting), NOW)).toEqual({ ok: false, reason: 'quota' })
    }
  })

  it('starts once, on the Member\'s computer and account, in its task\'s conversation', () => {
    const { f, lamp, waiting, member } = busy(['src/b/'])
    f.run({ type: 'member.helper', conversationId: waiting }, kai)
    f.run({ type: 'member.helper', conversationId: waiting }, kai)
    const helpers = f.state.starts!.filter(s => s.request.helperOf)
    expect(helpers).toHaveLength(1)
    expect(helpers[0]).toMatchObject({ contributorId: 'kai', machineOwnerId: 'kai', hostGrant: null })
    expect(helpers[0]!.request).toMatchObject({ conversationId: waiting, machineId: 'kai-mac', mainProjectId: lamp, regular: true,
      helperOf: { agentId: member, harnessId: 'h-member' } })
    expect(memberPlan(f.state, lamp, NOW)).toEqual([])
  })

  it('refuses a helper the checks refuse, whoever asks', () => {
    const { f, waiting } = busy(['src/a/'])
    expect(code(() => f.run({ type: 'member.helper', conversationId: waiting }, kai))).toBe('HELPER_OVERLAP')
    // Nobody else asks for one.
    expect(code(() => f.run({ type: 'member.helper', conversationId: waiting }, owner))).toBe('FORBIDDEN')
  })

  // Review of #3575 (Secrev7): a helper that finished while work waited, whose last task its Member then took, stops too.
  it('stops, idle, once its person\'s queue empties, whoever took the last task', () => {
    const { f, lamp, running, waiting, member } = busy(['src/b/'])
    f.run({ type: 'member.helper', conversationId: waiting }, kai)
    const start = f.state.starts!.find(s => s.request.helperOf)!
    const own = { contribution: { machineOwnerId: 'kai', contributorId: 'kai' } }
    f.run({ type: 'agent.startDispatch', startId: start.id }, kai, own)
    const helper = f.run({ type: 'agent.started', startId: start.id, harnessId: 'h-helper',
      configuration: { engine: 'claude', model: 'opus', effort: 'high', contextWindow: null, engineVersion: null } }, kai, own).result.agentId as string
    f.run({ type: 'agent.startSettled', startId: start.id, warning: null }, kai, own)
    f.run({ type: 'work.assign', conversationId: waiting, agentId: helper }, owner)
    // A third task waits while the helper finishes its own: it stays.
    const third = f.ask(lamp, 'Third', owns(['src/a/c.ts']))
    f.run({ type: 'task.approve', conversationId: third }, kai)
    const done = (id: string, agentId: string) => f.run({ type: 'work.status', conversationId: id, assignmentId: f.group(id).assignment!.id, status: 'done',
      result: 'Done at abc: https://github.com/o/r/pull/3' }, { kind: 'agent', agentId, machineOwnerId: 'kai' })
    done(waiting, helper)
    expect(f.state.agents.find(a => a.id === helper)!.workDecision).not.toBe('stop')
    // The Member frees and takes the last waiting task: the idle helper stops.
    done(running, member)
    f.run({ type: 'work.assign', conversationId: third, agentId: member }, owner)
    expect(f.state.agents.find(a => a.id === helper)!.workDecision).toBe('stop')
  })

  it('takes its task, and stops once it ends with nothing waiting', () => {
    const { f, lamp, waiting } = busy(['src/b/'])
    f.run({ type: 'member.helper', conversationId: waiting }, kai)
    const start = f.state.starts!.find(s => s.request.helperOf)!
    const own = { contribution: { machineOwnerId: 'kai', contributorId: 'kai' } }
    f.run({ type: 'agent.startDispatch', startId: start.id }, kai, own)
    const helper = f.run({ type: 'agent.started', startId: start.id, harnessId: 'h-helper',
      configuration: { engine: 'claude', model: 'opus', effort: 'high', contextWindow: null, engineVersion: null } }, kai, own).result.agentId as string
    f.run({ type: 'agent.startSettled', startId: start.id, warning: null }, kai, own)
    // Its host tells a Member and a helper from other agents by these, set by the server alone (#4698).
    expect(f.state.agents.find(a => a.id === helper)!.helperOf).toEqual({ agentId: f.state.agents.find(a => a.member)!.id, harnessId: 'h-member' })
    expect(f.state.agents.find(a => a.member)!.member).toEqual({ projectId: lamp })
    expect(memberPlan(f.state, lamp, NOW)).toEqual([{ kind: 'assign', conversationId: waiting, agentId: helper }])
    f.run({ type: 'work.assign', conversationId: waiting, agentId: helper }, owner)
    const assignmentId = f.group(waiting).assignment!.id
    f.run({ type: 'work.status', conversationId: waiting, assignmentId, status: 'done', result: 'Done at abc: https://github.com/o/r/pull/2' },
      { kind: 'agent', agentId: helper, machineOwnerId: 'kai' })
    expect(f.state.agents.find(a => a.id === helper)!.workDecision).toBe('stop')
  })
})

// Security review 1 of #3575: an agent starts on a person's computer only for work they accepted, whoever names them requester.
describe('a task its requester never accepted', () => {
  it('starts no Member or helper, and stays with the crew as before', () => {
    const f = swarm()
    const lamp = f.project('lamp')
    // Kai never chose a mode: nothing is staged, and nothing is accepted either.
    const id = f.ask(lamp, 'Named by someone else')
    expect(f.group(id).taskApproval).toBeUndefined()
    expect(memberQueue(f.state, lamp, 'kai', NOW)).toEqual([])
    expect(memberPlan(f.state, lamp, NOW)).toEqual([])
    expect(code(() => f.run({ type: 'member.start', conversationId: id }, kai))).toBe('TASK_NOT_ACCEPTED')
    expect(code(() => f.run({ type: 'member.helper', conversationId: id }, kai))).toBe('TASK_NOT_ACCEPTED')
    expect(f.state.starts ?? []).toEqual([])
  })
})

// Security review 2 of #3575 (Secrev7): the rule holds for an assignment by hand too, not only for the dispatch pass.
describe('an accepted ask assigned by hand', () => {
  it('is refused to another person\'s agent, and taken by its person\'s own', () => {
    const { f, lamp, tasks, member } = withMember()
    const config = { engine: 'claude' as const, model: 'opus', effort: 'high', contextWindow: null, engineVersion: null }
    // Another person's agent in the same project: only the new check can refuse it.
    const chat = f.state.projects!.find(p => p.id === lamp)!.leadConversationId
    const other = f.run({ type: 'agent.add', conversationId: chat, machineId: 'owner-mac', harnessId: 'owner-agent', name: 'Owner agent',
      configuration: config, lead: false }, owner, { contribution: { machineOwnerId: 'owner', contributorId: 'owner' } }).result.agentId as string
    expect(code(() => f.run({ type: 'work.assign', conversationId: tasks[0]!, agentId: other }, owner))).toBe('ASKED_BY_ANOTHER')
    f.run({ type: 'work.assign', conversationId: tasks[0]!, agentId: member }, owner)
    expect(f.group(tasks[0]!).assignment?.agentId).toBe(member)
  })
})

// Security review 2 of #3575 (Secrev8): a private project's Member is tied to it from its start, not from its first task, so
// once its person stops reading the project no other project's Lead sees it, or the project's name in it, or gives it work.
describe('a private project\'s Member', () => {
  it('stays its project\'s alone after its person stops reading it', () => {
    const f = swarm()
    f.run({ type: 'member.approvalMode', mode: 'review' }, kai)
    const secret = f.run({ type: 'project.create', name: 'secret', visibility: 'private', brief: '' }).result.projectId as string
    f.run({ type: 'project.sharing', projectId: secret, visibility: 'private', memberIds: ['kai'] })
    const id = f.ask(secret, 'Private work')
    f.run({ type: 'task.approve', conversationId: id }, kai)
    const start = f.state.starts!.find(s => s.request.member)!
    const own = { contribution: { machineOwnerId: 'kai', contributorId: 'kai' } }
    f.run({ type: 'agent.startDispatch', startId: start.id }, kai, own)
    const member = f.run({ type: 'agent.started', startId: start.id, harnessId: 'h-secret',
      configuration: { engine: 'claude', model: 'opus', effort: 'high', contextWindow: null, engineVersion: null } }, kai, own).result.agentId as string
    f.run({ type: 'agent.startSettled', startId: start.id, warning: null }, kai, own)
    expect(f.state.agents.find(a => a.id === member)!.privateProjectId).toBe(secret)
    // Kai stops reading it; another project's Lead never sees the Member nor gives it work.
    f.run({ type: 'project.sharing', projectId: secret, visibility: 'private', memberIds: [] })
    const lamp = f.project('lamp')
    const chat = f.state.projects!.find(p => p.id === lamp)!.leadConversationId
    const config = { engine: 'claude' as const, model: 'opus', effort: 'high', contextWindow: null, engineVersion: null }
    const lead = f.run({ type: 'agent.add', conversationId: chat, machineId: 'owner-mac', harnessId: 'lamp-lead', name: 'Lamp lead', configuration: config, lead: true },
      owner, { contribution: { machineOwnerId: 'owner', contributorId: 'owner' } }).result.agentId as string
    expect(canReadAgent(f.state, { kind: 'agent', agentId: lead, machineOwnerId: 'owner' }, f.state.agents.find(a => a.id === member)!)).toBe(false)
  })
})
