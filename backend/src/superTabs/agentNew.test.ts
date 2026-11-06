import { describe, expect, it } from 'vitest'
import { applyCommand, type Command, type CommandContext } from './commands.js'
import type { ContributedMachine } from './machines.js'
import { createSuperTab, SuperTabError, type Actor, type SuperTabState } from './model.js'
import { agentKind } from './agentKind.js'

// Task #4116 (Swarm v3, anh Dee 11-07): "+ New agent" makes a Regular or a PM agent on the person's own computer and account.
// A PM names and starts a project; a Regular agent is in no project, and the task it is given decides where it works.
const NOW = 50_000_000
const owner: Extract<Actor, { kind: 'person' }> = { kind: 'person', userId: 'owner', email: 'owner@example.com' }
const mate: Extract<Actor, { kind: 'person' }> = { kind: 'person', userId: 'mate', email: 'mate@example.com' }
const resources = { cpuPercent: 1, memoryTotalBytes: 8, memoryUsedBytes: 1, diskFreeBytes: 8, diskTotalBytes: 8, projectDiskFreeBytes: 8,
  deviceType: null, chip: null, os: null, gpuPercent: null }
const reading = { generation: 'g1', receivedAt: NOW, sessionKind: 'computer' as const, resources, tools: {}, quotas: [], runningHarnessIds: [],
  stoppedHarnessIds: [], capabilities: ['leadStart'] }
const own = (userId: string) => ({ contribution: { machineOwnerId: userId, contributorId: userId } })
const code = (body: () => unknown): string | null => {
  // A schema refusal (a missing field) has no code of its own.
  try { body(); return null } catch (error) { return error instanceof SuperTabError ? error.code : 'INVALID' }
}

function swarm() {
  let state: SuperTabState = createSuperTab('tab', 'Pilot', { id: 'owner', email: owner.email }, 'prod')
  let sequence = 0
  const run = (command: Command, actor: Actor = mate, context: Partial<CommandContext> = {}) => {
    const effects = applyCommand(state, actor, command, { now: NOW, operationId: `op-${++sequence}`, ...context })
    state = effects.state
    return effects
  }
  const invited = run({ type: 'invite.create', email: mate.email, role: 'collaborator', conversationId: 'lead' }, owner)
  run({ type: 'invite.accept', inviteId: invited.result.inviteId as string }, mate)
  const generation = (userId: string) => state.people.find(p => p.id === userId)!.generation
  const pool = (machineId: string, contributorId: string, extra: Partial<ContributedMachine> = {}): ContributedMachine => ({
    machineId, name: machineId, contributorId, membershipGeneration: generation(contributorId), generation: 'g1', cwd: '/swarm', scope: 'swarm',
    engines: ['claude', 'codex'], maxAgents: 4, paused: false, observation: reading, ...extra })
  state.machines = [pool('owner-mac', 'owner'), pool('mate-mac', 'mate'), pool('mate-buddy', 'mate', { buddyOnly: true, maxAgents: 1 })]
  const add = (extra: Record<string, unknown>, actor: Actor = mate, context: Partial<CommandContext> = own(actor.kind === 'person' ? actor.userId : 'x')) =>
    run({ type: 'agent.new', engine: 'claude', machineId: 'mate-mac', ...extra } as Command, actor, context)
  return { run, add, get state() { return state } }
}

describe('+ New agent, PM', () => {
  it('names a new project of the person and starts its PM on their own computer, with no repository needed', () => {
    const f = swarm()
    const made = f.add({ kind: 'pm', projectName: 'Docs site' })
    const project = f.state.projects!.find(p => p.id === made.result.projectId)!
    expect(project).toMatchObject({ name: 'Docs site', ownerId: 'mate' })
    expect(made.result.conversationId).toBe(project.leadConversationId)
    const start = f.state.starts!.find(s => s.id === made.result.startId)!
    expect(start.request).toMatchObject({ machineId: 'mate-mac', conversationId: project.leadConversationId, engine: 'claude' })
    expect(start).toMatchObject({ contributorId: 'mate', machineOwnerId: 'mate' })
  })

  it('needs a project name', () => {
    const f = swarm()
    expect(code(() => f.add({ kind: 'pm' }))).not.toBeNull()
    expect(f.state.projects ?? []).toHaveLength(0)
  })
})

describe('+ New agent, Regular', () => {
  it('starts on the person\'s own computer in a chat of its own, in no project', () => {
    const f = swarm()
    const made = f.add({ kind: 'regular', name: 'Ada' })
    const chat = f.state.conversations.find(c => c.id === made.result.conversationId)!
    expect(chat).toMatchObject({ title: 'Ada', audience: { people: [{ id: 'mate' }] } })
    const start = f.state.starts!.find(s => s.id === made.result.startId)!
    expect(start.request).toMatchObject({ machineId: 'mate-mac', conversationId: chat.id, engine: 'claude', name: 'Ada', regular: true })
    expect(start).toMatchObject({ contributorId: 'mate', machineOwnerId: 'mate' })
    expect(f.state.projects ?? []).toHaveLength(0)
  })

  it('once started, is a Regular agent in its own chat', () => {
    const f = swarm()
    const made = f.add({ kind: 'regular', name: 'Ada' })
    const startId = made.result.startId as string
    f.run({ type: 'agent.startDispatch', startId }, mate, own('mate'))
    const agentId = f.run({ type: 'agent.started', startId, harnessId: 'h-ada',
      configuration: { engine: 'claude', model: 'opus', effort: 'high', contextWindow: null, engineVersion: null } }, mate, own('mate')).result.agentId as string
    const agent = f.state.agents.find(a => a.id === agentId)!
    expect(agentKind(f.state, agent)).toBe('regular')
    expect(f.state.conversations.find(c => c.id === made.result.conversationId)!.agentIds).toContain(agentId)
  })
})

describe('+ New agent, on whose computer', () => {
  it('runs only on the person\'s own listed computer, never another person\'s, a Buddy-only one or one not listed', () => {
    const f = swarm()
    for (const kind of ['pm', 'regular']) {
      const extra = { kind, projectName: 'P', name: 'A' }
      expect(code(() => f.add({ ...extra, machineId: 'owner-mac' }, mate, { contribution: { machineOwnerId: 'owner', contributorId: 'owner' } }))).toBe('AGENT_OWN_MACHINE')
      expect(code(() => f.add({ ...extra, machineId: 'mate-buddy' }))).toBe('MACHINE_NOT_LISTED')
      expect(code(() => f.add({ ...extra, machineId: 'nowhere' }))).toBe('MACHINE_NOT_LISTED')
      expect(code(() => f.add(extra, { kind: 'agent', agentId: 'x', machineOwnerId: 'mate' }))).not.toBeNull()
    }
    expect(f.state.projects ?? []).toHaveLength(0)
    expect(f.state.starts ?? []).toHaveLength(0)
  })
})
