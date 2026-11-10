import { describe, expect, it } from 'vitest'
import { applyCommand, type Command, type CommandContext } from './commands.js'
import { AGENT_MEMORY_BYTES, projectFolder, type ContributedMachine } from './machines.js'
import { createSuperTab, type Actor, type SuperTabState } from './model.js'
import { canReadAgent, projectOf } from './projects.js'
import * as store from './parts/index.js'
import { readerView } from './read/views.js'

// Task #4697 (anh Dee 11-07 21:20, card #4693 part A): one Member per person and project, made on their first accepted task
// there. Swarm v4 retired task approval (2026-11-10), so no Member starts now; one started before still runs.
const NOW = 50_000_000
const owner: Extract<Actor, { kind: 'person' }> = { kind: 'person', userId: 'owner', email: 'owner@example.com' }
const kai: Extract<Actor, { kind: 'person' }> = { kind: 'person', userId: 'kai', email: 'kai@example.com' }
const resources = { cpuPercent: 1, memoryTotalBytes: 64e9, memoryUsedBytes: 1e9, diskFreeBytes: 500e9, diskTotalBytes: 1e12, projectDiskFreeBytes: 500e9,
  deviceType: null, chip: null, os: null, gpuPercent: null }
type Quota = { engine: string; known: boolean; windows: Array<{ name: string; usedPercent: number; resetsAt: null }> }
const subscription = (usedPercent = 10): Quota => ({ engine: 'claude', known: true, windows: [{ name: 'weekly', usedPercent, resetsAt: null }] })

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

/** Kai's Member in [projectId], as the first Accept started it before Swarm v4 retired task approval (2026-11-10): its start on
 *  Kai's computer, in a chat of its own with Kai, then launched by Kai's host. Returns its agent id. */
function startedMember(f: ReturnType<typeof swarm>, projectId: string, harnessId: string): string {
  const kaiPerson = f.state.people.find(p => p.id === 'kai')!
  const chatId = `member-chat-${projectId}`
  f.state.conversations.push({ id: chatId, kind: 'agent-chat', title: 'Kai · member', leadId: null, agentIds: [], archived: false, brief: '', checks: [],
    assignment: null, lastMessageSequence: 0, audience: { people: [{ id: 'kai', generation: kaiPerson.generation }] } })
  const id = `member-${projectId}`
  ;(f.state.starts ??= []).push({ poolGeneration: 'g1', id, creationId: `super-${id}`, actorKey: 'person:kai', contributorId: 'kai',
    membershipGeneration: kaiPerson.generation, machineOwnerId: 'kai', hostGrant: null, harnessId: null, dispatched: false, error: null, requestedAt: NOW,
    request: { conversationId: chatId, machineId: 'kai-mac', engine: 'claude', name: 'Kai · member', worktree: true,
      cwd: projectFolder(f.state.machines!.find(m => m.machineId === 'kai-mac')!, projectOf(f.state, projectId)),
      requirements: { memoryBytes: AGENT_MEMORY_BYTES, diskBytes: 1024 ** 3, maxCpuPercent: 100, tools: ['git'], devices: [], quotaRequired: false },
      regular: true, mainProjectId: projectId, member: { projectId } } })
  const own = { contribution: { machineOwnerId: 'kai', contributorId: 'kai' } }
  f.run({ type: 'agent.startDispatch', startId: id }, kai, own)
  const member = f.run({ type: 'agent.started', startId: id, harnessId,
    configuration: { engine: 'claude', model: 'opus', effort: 'high', contextWindow: null, engineVersion: null } }, kai, own).result.agentId as string
  f.run({ type: 'agent.startSettled', startId: id, warning: null }, kai, own)
  return member
}

function withMember(f = swarm()) {
  const lamp = f.project('lamp')
  return { f, lamp, member: startedMember(f, lamp, 'h-member') }
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
    const secret = f.run({ type: 'project.create', name: 'secret', visibility: 'private', brief: '' }).result.projectId as string
    f.run({ type: 'project.sharing', projectId: secret, visibility: 'private', memberIds: ['kai'] })
    const member = startedMember(f, secret, 'h-secret')
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
