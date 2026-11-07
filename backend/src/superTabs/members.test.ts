import { describe, expect, it } from 'vitest'
import { applyCommand, type Command, type CommandContext } from './commands.js'
import type { ContributedMachine } from './machines.js'
import { createSuperTab, SuperTabError, type Actor, type SuperTabState } from './model.js'

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
