import { describe, expect, it } from 'vitest'
import { applyCommand, type Command, type CommandContext } from './commands.js'
import { createSuperTab, SuperTabError, type Actor, type AgentConfiguration, type SuperTabState } from './model.js'
import type { ContributedMachine } from './machines.js'
import { agentProjectId, canReadAgent, canReadGroup, NO_PROJECT } from './projects.js'

// Task #4116 (Swarm v3, anh Dee 11-07): "A Regular agent isn't tied to a project; the task decides where it works." Its PM gives
// it a task only in a project its person can read, so nothing reaches its person that they could not read anyway; while it
// works there it is that project's, and it is in none again once the task ends.
const NOW = 50_000_000
const owner: Extract<Actor, { kind: 'person' }> = { kind: 'person', userId: 'owner', email: 'owner@example.com' }
const mate: Extract<Actor, { kind: 'person' }> = { kind: 'person', userId: 'mate', email: 'mate@example.com' }
const config: AgentConfiguration = { engine: 'claude', model: 'opus', effort: 'high', contextWindow: null, engineVersion: null }
const own = (userId: string) => ({ contribution: { machineOwnerId: userId, contributorId: userId } })
const resources = { cpuPercent: 1, memoryTotalBytes: 8, memoryUsedBytes: 1, diskFreeBytes: 8, diskTotalBytes: 8, projectDiskFreeBytes: 8,
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
  it('is in no project until its PM gives it a task in a project its person reads; then it works there, and is in none again after', () => {
    const f = swarm()
    expect(agentProjectId(f.state, f.agent(f.ada))).toBe(NO_PROJECT)
    const app = f.project('app', 'public')
    // That project's PM sees it to give it work; its person reads the project.
    expect(canReadAgent(f.state, app.asPm, f.agent(f.ada))).toBe(true)
    const assigned = f.run({ type: 'work.assign', conversationId: app.task, agentId: f.ada }, app.asPm)
    expect(f.group(app.task).assignment).toMatchObject({ agentId: f.ada })
    expect(agentProjectId(f.state, f.agent(f.ada))).toBe(app.projectId)
    const asAda: Actor = { kind: 'agent', agentId: f.ada, machineOwnerId: 'mate' }
    expect(canReadGroup(f.state, asAda, f.group(app.task))).toBe(true)
    f.run({ type: 'work.status', conversationId: app.task, assignmentId: assigned.result.assignmentId as string, status: 'done', result: 'Done.' } as Command, asAda)
    expect(agentProjectId(f.state, f.agent(f.ada))).toBe(NO_PROJECT)
  })

  it('takes no task in a project its person cannot read, whose PM never sees it', () => {
    const f = swarm()
    const secret = f.project('secret', 'private')
    expect(canReadAgent(f.state, secret.asPm, f.agent(f.ada))).toBe(false)
    expect(code(() => f.run({ type: 'work.assign', conversationId: secret.task, agentId: f.ada }, secret.asPm))).not.toBeNull()
    expect(f.group(secret.task).assignment).toBeNull()
  })

  it('works in one project at a time', () => {
    const f = swarm()
    const app = f.project('app', 'public'), web = f.project('web', 'public')
    f.run({ type: 'work.assign', conversationId: app.task, agentId: f.ada }, app.asPm)
    expect(code(() => f.run({ type: 'work.assign', conversationId: web.task, agentId: f.ada }, web.asPm))).not.toBeNull()
  })

  // Security review of #4116 (Layoutfix): its one terminal carries every project it worked in and its person's private chat, so
  // only its person reads or types in it, whichever project's task it holds now.
  it('keeps its terminal its person\'s alone, even from the PM whose task it holds, and from the Swarm\'s owner', () => {
    const f = swarm()
    const app = f.project('app', 'public'), web = f.project('web', 'public')
    f.run({ type: 'work.assign', conversationId: app.task, agentId: f.ada }, app.asPm)
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
    f.run({ type: 'work.assign', conversationId: app.task, agentId: f.ada }, app.asPm)
    for (const chat of f.state.conversations.filter(c => c.kind === 'agent-chat')) chat.agentIds = chat.agentIds.filter(id => id !== f.ada)
    expect(code(() => f.run({ type: 'agent.screen', agentId: f.ada } as Command, app.asPm))).toBe('TERMINAL_PRIVATE')
  })

  // Security review 2 of #4116 (Rowan): the agent keeps one conversation, so what it learned in a private project would reach
  // the members of the next project it works in. Once it has worked in a private project it takes tasks only there; work in
  // public projects, which every member reads, moves on freely.
  it('after a task in a private project, takes tasks only in that project, and no other project\'s PM sees it', () => {
    const f = swarm()
    const secret = f.project('secret', 'private'), web = f.project('web', 'public')
    f.run({ type: 'project.sharing', projectId: secret.projectId, visibility: 'private', memberIds: ['owner', 'mate'] } as Command)
    const done = (task: string, assignmentId: string) => f.run({ type: 'work.status', conversationId: task, assignmentId, status: 'done', result: 'Done.' } as Command,
      { kind: 'agent', agentId: f.ada, machineOwnerId: 'mate' })
    const first = f.run({ type: 'work.assign', conversationId: secret.task, agentId: f.ada }, secret.asPm)
    done(secret.task, first.result.assignmentId as string)
    expect(canReadAgent(f.state, web.asPm, f.agent(f.ada))).toBe(false)
    expect(code(() => f.run({ type: 'work.assign', conversationId: web.task, agentId: f.ada }, web.asPm))).not.toBeNull()
    const again = f.run({ type: 'conversation.create', projectId: secret.projectId, title: 'secret again', brief: 'Do it.', checks: [] } as Command).result.conversationId as string
    expect(code(() => f.run({ type: 'work.assign', conversationId: again, agentId: f.ada }, secret.asPm))).toBeNull()
  })

  it('after tasks in public projects only, takes a task in any project its person reads', () => {
    const f = swarm()
    const app = f.project('app', 'public'), secret = f.project('secret', 'private')
    f.run({ type: 'project.sharing', projectId: secret.projectId, visibility: 'private', memberIds: ['owner', 'mate'] } as Command)
    const first = f.run({ type: 'work.assign', conversationId: app.task, agentId: f.ada }, app.asPm)
    f.run({ type: 'work.status', conversationId: app.task, assignmentId: first.result.assignmentId as string, status: 'done', result: 'Done.' } as Command,
      { kind: 'agent', agentId: f.ada, machineOwnerId: 'mate' })
    expect(code(() => f.run({ type: 'work.assign', conversationId: secret.task, agentId: f.ada }, secret.asPm))).toBeNull()
  })

  // Security review 2 of #4116, second read (Rowan): a Regular agent comes into a project only through a task, which is where its
  // private mark is recorded. Added to a chat while idle, it would hear a private project with nothing recorded, or sit in
  // several projects' chats at once.
  it('is never added to a project\'s chat while it has no task there', () => {
    const f = swarm()
    const secret = f.project('secret', 'private'), web = f.project('web', 'public')
    f.run({ type: 'project.sharing', projectId: secret.projectId, visibility: 'private', memberIds: ['owner', 'mate'] } as Command)
    expect(code(() => f.run({ type: 'conversation.agent', conversationId: secret.task, agentId: f.ada, present: true, lead: false } as Command, secret.asPm))).toBe('REGULAR_TASK_ONLY')
    expect(code(() => f.run({ type: 'conversation.agent', conversationId: secret.conversationId, agentId: f.ada, present: true, lead: false } as Command))).toBe('REGULAR_TASK_ONLY')
    // Working in one project, it joins none of another's.
    f.run({ type: 'work.assign', conversationId: web.task, agentId: f.ada }, web.asPm)
    expect(code(() => f.run({ type: 'conversation.agent', conversationId: secret.task, agentId: f.ada, present: true, lead: false } as Command, secret.asPm))).not.toBeNull()
    expect(f.group(secret.task).agentIds).not.toContain(f.ada)
  })

  it('once in a project that is then made private, takes tasks only there', () => {
    const f = swarm()
    const app = f.project('app', 'public'), web = f.project('web', 'public')
    const first = f.run({ type: 'work.assign', conversationId: app.task, agentId: f.ada }, app.asPm)
    f.run({ type: 'work.status', conversationId: app.task, assignmentId: first.result.assignmentId as string, status: 'done', result: 'Done.' } as Command,
      { kind: 'agent', agentId: f.ada, machineOwnerId: 'mate' })
    f.run({ type: 'project.sharing', projectId: app.projectId, visibility: 'private', memberIds: ['owner', 'mate'] } as Command)
    expect(code(() => f.run({ type: 'work.assign', conversationId: web.task, agentId: f.ada }, web.asPm))).not.toBeNull()
  })

  it('is seen idle by its person and itself, and by no other person', () => {
    const f = swarm()
    expect(canReadAgent(f.state, mate, f.agent(f.ada))).toBe(true)
    expect(canReadAgent(f.state, { kind: 'agent', agentId: f.ada, machineOwnerId: 'mate' }, f.agent(f.ada))).toBe(true)
    expect(canReadAgent(f.state, owner, f.agent(f.ada))).toBe(false)
  })
})
