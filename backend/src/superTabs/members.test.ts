import { describe, expect, it } from 'vitest'
import { applyCommand, type Command, type CommandContext } from './commands.js'
import type { ContributedMachine } from './machines.js'
import { createSuperTab, SuperTabError, type Actor, type SuperTabState } from './model.js'
import { touchesFor } from './parts/touches.js'
import { canReadAgent } from './projects.js'
import * as store from './parts/index.js'
import { readerView } from './read/views.js'

// Task #4697 (anh Dee 11-07 21:20, card #4693 part A): one Member per person and project, made on their first accepted task
// there; every asked task needs its person's Accept, and Accept all is refused for subscription accounts.
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

function swarm(quotas: Quota[] = [subscription()]) {
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
    observation: { generation: 'g1', receivedAt: NOW, resources, tools: {}, quotas, runningHarnessIds: [], stoppedHarnessIds: [],
      capabilities: ['regularAgent'] }, ...extra })
  state.machines = [machine('kai-mac', 'kai'), machine('owner-mac', 'owner')]
  const project = (name: string) => run({ type: 'project.create', name, visibility: 'public', brief: '' }).result.projectId as string
  /** A task Kai asks for in [projectId], made by its Lead as an asked task is. */
  const ask = (projectId: string, title: string) => {
    const chat = state.projects!.find(p => p.id === projectId)!.leadConversationId
    return run({ type: 'conversation.create', title, brief: 'Do it.', projectId, requesterId: 'kai', priority: 'P2',
      task: { goal: title, changes: 'Change it.', constraints: 'None.', owns: ['src/a/'] }, checks: [{ description: 'Works.', independent: false }] } as unknown as Command, owner).result.conversationId as string ?? chat
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

  it('never uses another person\'s computer or a Buddy-only one, and says why when it has none', () => {
    const f = swarm()
    f.state.machines = [f.machine('owner-mac', 'owner'), f.machine('kai-buddy', 'kai', { buddyOnly: true })]
    const { first } = accepted(f)
    expect(memberStarts(f)).toHaveLength(0)
    expect(f.group(first).taskApproval?.state).toBe('approved')
    expect(f.state.conversations.find(c => c.id === first)).toBeTruthy()
    const said = f.run({ type: 'task.approve', conversationId: f.ask(f.state.projects!.find(p => p.name === 'lamp')!.id, 'Again') }, kai).messages
    expect(said.map(m => m.text)).toContainEqual(expect.stringContaining('no computer in this Swarm'))
  })
})

/** Kai's Member in lamp, started by Kai's first accepted task there and running on Kai's computer. */
function withMember(f = swarm()) {
  f.run({ type: 'member.approvalMode', mode: 'review' }, kai)
  const lamp = f.project('lamp')
  f.run({ type: 'task.approve', conversationId: f.ask(lamp, 'Task 0') }, kai)
  const start = f.state.starts!.find(s => s.request.member)!
  const own = { contribution: { machineOwnerId: 'kai', contributorId: 'kai' } }
  f.run({ type: 'agent.startDispatch', startId: start.id }, kai, own)
  const member = f.run({ type: 'agent.started', startId: start.id, harnessId: 'h-member',
    configuration: { engine: 'claude', model: 'opus', effort: 'high', contextWindow: null, engineVersion: null } }, kai, own).result.agentId as string
  f.run({ type: 'agent.startSettled', startId: start.id, warning: null }, kai, own)
  return { f, lamp, member }
}

describe('the Member', () => {
  // Its mark names its project, which may be private: readers never get it, as its main project's id (read/views.ts).
  it('keeps its mark out of what readers get', () => {
    const { f, member } = withMember()
    const parts = readerView(store.split(f.state, { tabId: 'tab', version: 9_000, now: NOW }), owner, NOW, {}).parts
    const row = parts.agents.find(a => a.key === member)?.data
    expect(row).not.toHaveProperty('member')
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
