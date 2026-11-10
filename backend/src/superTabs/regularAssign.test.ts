import { describe, expect, it } from 'vitest'
import { applyCommand, type Command, type CommandContext } from './commands.js'
import { createSuperTab, SuperTabError, type Actor, type AgentConfiguration, type SuperTabState } from './model.js'
import type { ContributedMachine } from './machines.js'
import { agentProjectId, canReadAgent, canReadGroup, NO_PROJECT } from './projects.js'
import { closedAgents, STOPPED_REMOVE_MS } from './closedAgents.js'
import { storedAssignment, storedStatus } from './storedWork.test-support.js'

// Task #4116 (Swarm v3, anh Dee 11-07): "A Regular agent isn't tied to a project; the task decides where it works." While it
// works on a task it is that task's project's, and it is in none again once the task ends.
const NOW = 50_000_000
const owner: Extract<Actor, { kind: 'person' }> = { kind: 'person', userId: 'owner', email: 'owner@example.com' }
const mate: Extract<Actor, { kind: 'person' }> = { kind: 'person', userId: 'mate', email: 'mate@example.com' }
const config: AgentConfiguration = { engine: 'claude', model: 'opus', effort: 'high', contextWindow: null, engineVersion: null }
const own = (userId: string) => ({ contribution: { machineOwnerId: userId, contributorId: userId } })
const resources = { cpuPercent: 1, memoryTotalBytes: 64e9, memoryUsedBytes: 1e9, diskFreeBytes: 8, diskTotalBytes: 8, projectDiskFreeBytes: 8,
  deviceType: null, chip: null, os: null, gpuPercent: null }
const code = (body: () => unknown): string | null => {
  try { body(); return null } catch (error) { return error instanceof SuperTabError ? error.code : 'INVALID' }
}

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
  state.machines = [{ machineId: 'mate-mac', name: 'mate-mac', contributorId: 'mate', membershipGeneration: generation('mate'), generation: 'g1',
    cwd: '/swarm', scope: 'swarm', engines: ['claude'], maxAgents: 4, paused: false,
    observation: { generation: 'g1', receivedAt: NOW, sessionKind: 'computer', resources, tools: {}, quotas: [], runningHarnessIds: [], stoppedHarnessIds: [], capabilities: ['regularAgent'] } } as ContributedMachine]
  // Mate's Regular agent Ada, running in its chat.
  const made = run({ type: 'agent.new', kind: 'regular', name: 'Ada', engine: 'claude', machineId: 'mate-mac' } as Command, mate, own('mate'))
  const startId = made.result.startId as string
  run({ type: 'agent.startDispatch', startId }, mate, own('mate'))
  const ada = run({ type: 'agent.started', startId, harnessId: 'h-ada', configuration: config }, mate, own('mate')).result.agentId as string
  run({ type: 'agent.startSettled', startId, warning: null } as Command, mate, own('mate'))
  /** A project of the owner's, [visibility], with its PM and one task. */
  const project = (name: string, visibility: 'public' | 'private') => {
    const created = run({ type: 'project.create', name, visibility, brief: '' }).result as { projectId: string; conversationId: string }
    const pm = run({ type: 'agent.add', conversationId: created.conversationId, machineId: `${name}-mac`, harnessId: `h-pm-${name}`, name: `PM ${name}`,
      configuration: config, lead: true }, owner, own('owner')).result.agentId as string
    const task = run({ type: 'conversation.create', projectId: created.projectId, title: `${name} task`, brief: 'Do it.', checks: [] } as Command)
      .result.conversationId as string
    return { ...created, pm, task, asPm: { kind: 'agent', agentId: pm, machineOwnerId: 'owner' } as Actor }
  }
  const agent = (id: string) => state.agents.find(a => a.id === id)!
  const group = (id: string) => state.conversations.find(c => c.id === id)!
  return { run, ada, project, agent, group, get state() { return state } }
}

describe('a Regular agent and its task', () => {
  it('is in no project until it holds a task in a project its person reads; then it works there, and is in none again after', () => {
    const f = swarm()
    expect(agentProjectId(f.state, f.agent(f.ada))).toBe(NO_PROJECT)
    const app = f.project('app', 'public')
    // That project's PM sees it; its person reads the project.
    expect(canReadAgent(f.state, app.asPm, f.agent(f.ada))).toBe(true)
    storedAssignment(f.state, app.task, f.ada, NOW)
    expect(agentProjectId(f.state, f.agent(f.ada))).toBe(app.projectId)
    const asAda: Actor = { kind: 'agent', agentId: f.ada, machineOwnerId: 'mate' }
    expect(canReadGroup(f.state, asAda, f.group(app.task))).toBe(true)
    storedStatus(f.state, app.task, 'done', 'Done.')
    expect(agentProjectId(f.state, f.agent(f.ada))).toBe(NO_PROJECT)
  })

  // Security review of #4116 (Layoutfix): its one terminal carries every project it worked in and its person's private chat, so
  // only its person reads or types in it, whichever project's task it holds now.
  it('keeps its terminal its person\'s alone, even from the PM whose task it holds, and from the Swarm\'s owner', () => {
    const f = swarm()
    const app = f.project('app', 'public'), web = f.project('web', 'public')
    storedAssignment(f.state, app.task, f.ada, NOW)
    for (const type of ['agent.screen', 'agent.input'] as const) {
      const command = (type === 'agent.screen' ? { type, agentId: f.ada } : { type, agentId: f.ada, text: 'ls' }) as Command
      expect(code(() => f.run(command, app.asPm))).toBe('TERMINAL_PRIVATE')
      expect(code(() => f.run(command, web.asPm))).not.toBeNull()
      expect(code(() => f.run(command, owner))).not.toBeNull()
      expect(code(() => f.run(command, mate))).not.toBe('TERMINAL_PRIVATE')
    }
  })

  it('keeps its terminal its person\'s alone even once it is out of its own chat', () => {
    const f = swarm()
    const app = f.project('app', 'public')
    storedAssignment(f.state, app.task, f.ada, NOW)
    for (const chat of f.state.conversations.filter(c => c.kind === 'agent-chat')) chat.agentIds = chat.agentIds.filter(id => id !== f.ada)
    expect(code(() => f.run({ type: 'agent.screen', agentId: f.ada } as Command, app.asPm))).toBe('TERMINAL_PRIVATE')
  })

  // Security review 2 of #4116, second read (Rowan): a Regular agent comes into a project only through a task, which is where its
  // private mark is recorded. Added to a chat while idle, it would hear a private project with nothing recorded, or sit in
  // several projects' chats at once.
  it('is never added to a project\'s chat while it has no task there', () => {
    const f = swarm()
    const secret = f.project('secret', 'private'), web = f.project('web', 'public')
    f.run({ type: 'project.sharing', projectId: secret.projectId, visibility: 'private', memberIds: ['owner', 'mate'] } as Command)
    expect(code(() => f.run({ type: 'conversation.agent', conversationId: secret.task, agentId: f.ada, present: true, lead: false } as Command, secret.asPm))).toBe('REGULAR_TASK_ONLY')
    // A person who cannot see it is refused sooner: it is no agent of theirs to add.
    expect(code(() => f.run({ type: 'conversation.agent', conversationId: secret.conversationId, agentId: f.ada, present: true, lead: false } as Command))).not.toBeNull()
    // Working in one project, it joins none of another's.
    storedAssignment(f.state, web.task, f.ada, NOW)
    expect(code(() => f.run({ type: 'conversation.agent', conversationId: secret.task, agentId: f.ada, present: true, lead: false } as Command, secret.asPm))).not.toBeNull()
    expect(f.group(secret.task).agentIds).not.toContain(f.ada)
  })

  it('is seen idle by its person and itself, and by no other person', () => {
    const f = swarm()
    expect(canReadAgent(f.state, mate, f.agent(f.ada))).toBe(true)
    expect(canReadAgent(f.state, { kind: 'agent', agentId: f.ada, machineOwnerId: 'mate' }, f.agent(f.ada))).toBe(true)
    expect(canReadAgent(f.state, owner, f.agent(f.ada))).toBe(false)
  })
})

// Task #4218: a closed session removed its Regular agent, and nothing brought it back: its own chat made it count as
// confidential, and it has no project to restore into. It is its person's, as a Buddy is: it stays, shown closed, in its chat.
describe('a Regular agent whose session closed', () => {
  it('stays listed in its own chat, to come back when its session runs again', () => {
    const f = swarm()
    f.agent(f.ada).downSince = new Date(NOW - 10 * STOPPED_REMOVE_MS).toISOString()
    const report = { runningHarnessIds: ['h-other'], stoppedHarnessIds: ['h-ada'] }
    expect(closedAgents(f.state, 'mate-mac', report, NOW)).toEqual([])
    expect(f.state.conversations.some(c => c.kind === 'agent-chat' && c.agentIds.includes(f.ada))).toBe(true)
  })
})
