// A Swarm for the tests of a Member's task sessions (task #4543): the owner's projects, and mate's computer with mate's main
// Swarm Buddy on it, which is mate's Member until build task 9 makes every agent one.
import { applyCommand, type Command, type CommandContext } from './commands.js'
import { createSuperTab, SuperTabError, type Actor, type Agent, type AgentConfiguration, type SuperTabState } from './model.js'
import type { ContributedMachine } from './machines.js'
import { openSwarmBuddyChat } from './buddies.js'

export const NOW = 50_000_000
export const owner: Extract<Actor, { kind: 'person' }> = { kind: 'person', userId: 'owner', email: 'owner@example.com' }
export const mate: Extract<Actor, { kind: 'person' }> = { kind: 'person', userId: 'mate', email: 'mate@example.com' }
export const config: AgentConfiguration = { engine: 'claude', model: 'opus', effort: 'high', contextWindow: null, engineVersion: null }
export const own = (userId: string): Partial<CommandContext> => ({ contribution: { machineOwnerId: userId, contributorId: userId } })
const resources = { cpuPercent: 1, memoryTotalBytes: 64 * 1024 ** 3, memoryUsedBytes: 1, diskFreeBytes: 8, diskTotalBytes: 8, projectDiskFreeBytes: 8,
  deviceType: null, chip: null, os: null, gpuPercent: null }
export const code = (body: () => unknown): string | null => {
  try { body(); return null } catch (error) { return error instanceof SuperTabError ? error.code : 'INVALID' }
}

export function swarm(capabilities = ['regularAgent', 'swarmBuddy', 'memberProjects']) {
  let state: SuperTabState = createSuperTab('tab', 'Pilot', { id: 'owner', email: owner.email }, 'prod')
  let sequence = 0
  const run = (command: Command, actor: Actor = owner, context: Partial<CommandContext> = {}) => {
    const effects = applyCommand(state, actor, command, { now: NOW, operationId: `op-${++sequence}`, ...context })
    state = effects.state
    return effects
  }
  const invited = run({ type: 'invite.create', email: mate.email, role: 'collaborator', conversationId: 'lead' })
  run({ type: 'invite.accept', inviteId: invited.result.inviteId as string }, mate)
  const person = state.people.find(p => p.id === 'mate')!
  state.machines = [{ machineId: 'mate-mac', name: 'mate-mac', contributorId: 'mate', membershipGeneration: person.generation, generation: 'g1',
    cwd: '/swarm', scope: 'swarm', engines: ['claude'], maxAgents: 8, paused: false,
    observation: { generation: 'g1', receivedAt: NOW, sessionKind: 'computer', resources, tools: {}, quotas: [], runningHarnessIds: ['h-buddy'],
      stoppedHarnessIds: [], capabilities, projectsOnDisk: [] } } as ContributedMachine]
  // Mate's main Swarm Buddy, running in mate's Buddy chat.
  const buddy = { id: 'buddy', machineId: 'mate-mac', harnessId: 'h-buddy', machineOwnerId: 'mate', contributorId: 'mate',
    membershipGeneration: person.generation, name: 'Bo', configuration: config, buddyOf: { personId: 'mate', generation: person.generation },
    buddyScope: 'swarm' } as Agent
  state.agents.push(buddy)
  openSwarmBuddyChat(state, person).agentIds.push(buddy.id)
  /** A project of the owner's, [visibility], with its PM and one task. */
  const project = (name: string, visibility: 'public' | 'private' = 'public') => {
    const created = run({ type: 'project.create', name, visibility, brief: '' }).result as { projectId: string; conversationId: string }
    const pm = run({ type: 'agent.add', conversationId: created.conversationId, machineId: `${name}-mac`, harnessId: `h-pm-${name}`, name: `PM ${name}`,
      configuration: config, lead: true }, owner, own('owner')).result.agentId as string
    const task = (title = `${name} task`) => run({ type: 'conversation.create', projectId: created.projectId, title, brief: 'Do it.', checks: [] } as Command)
      .result.conversationId as string
    return { ...created, pm, task: task(), newTask: task, asPm: { kind: 'agent', agentId: pm, machineOwnerId: 'owner' } as Actor }
  }
  const agent = (id: string) => state.agents.find(a => a.id === id)!
  const group = (id: string) => state.conversations.find(c => c.id === id)!
  const machine = () => state.machines!.find(m => m.machineId === 'mate-mac')!
  return { run, project, agent, group, machine, buddy: buddy.id, get state() { return state } }
}
export type Swarm = ReturnType<typeof swarm>
