import { describe, expect, it } from 'vitest'
import { applyCommand, type Command, type CommandContext } from './commands.js'
import type { ContributedMachine } from './machines.js'
import { createSuperTab, SuperTabError, type Actor, type SuperTabState } from './model.js'
import { agentKind } from './agentKind.js'
import * as store from './parts/index.js'
import { readerView } from './read/views.js'

// Task #4540 (spec 2026-11-07-members-and-leads, build task 4): every agent has a main project and is a Lead or a Member.
// + New agent takes a main project; New project makes its Lead. `kind` keeps its values for older clients.
const NOW = 50_000_000
const owner: Extract<Actor, { kind: 'person' }> = { kind: 'person', userId: 'owner', email: 'owner@example.com' }
const mate: Extract<Actor, { kind: 'person' }> = { kind: 'person', userId: 'mate', email: 'mate@example.com' }
const outsider: Extract<Actor, { kind: 'person' }> = { kind: 'person', userId: 'other', email: 'other@example.com' }
const resources = { cpuPercent: 1, memoryTotalBytes: 64e9, memoryUsedBytes: 1e9, diskFreeBytes: 8, diskTotalBytes: 8, projectDiskFreeBytes: 8,
  deviceType: null, chip: null, os: null, gpuPercent: null }
const reading = { generation: 'g1', receivedAt: NOW, resources, tools: {}, quotas: [], runningHarnessIds: [],
  stoppedHarnessIds: [], capabilities: ['leadStart', 'regularAgent'] }
const configuration = { engine: 'claude' as const, model: 'opus', effort: 'high', contextWindow: null, engineVersion: null }
const own = (userId: string) => ({ contribution: { machineOwnerId: userId, contributorId: userId } })
const code = (body: () => unknown): string | null => {
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
  for (const person of [mate, outsider]) {
    const invited = run({ type: 'invite.create', email: person.email, role: 'collaborator', conversationId: 'lead' }, owner)
    run({ type: 'invite.accept', inviteId: invited.result.inviteId as string }, person)
  }
  const generation = (userId: string) => state.people.find(p => p.id === userId)!.generation
  const pool = (machineId: string, contributorId: string): ContributedMachine => ({
    machineId, name: machineId, contributorId, membershipGeneration: generation(contributorId), generation: 'g1', cwd: '/swarm', scope: 'swarm',
    engines: ['claude', 'codex'], maxAgents: 4, paused: false, observation: reading })
  state.machines = [pool('mate-mac', 'mate')]
  const project = (name: string, visibility: 'public' | 'private' = 'public', by: Actor = owner) =>
    run({ type: 'project.create', name, visibility, brief: '' }, by).result.projectId as string
  /** Mate's start [made], dispatched and running: its agent's id. */
  const started = (startId: string, harnessId: string) => {
    run({ type: 'agent.startDispatch', startId }, mate, own('mate'))
    return run({ type: 'agent.started', startId, harnessId, configuration }, mate, own('mate')).result.agentId as string
  }
  const newAgent = (extra: Record<string, unknown>) =>
    run({ type: 'agent.new', engine: 'claude', machineId: 'mate-mac', ...extra } as Command, mate, own('mate'))
  const derived = (reader: Actor, agentId: string) =>
    readerView(store.split(state, { tabId: 'tab', version: 9_000, now: NOW }), reader, NOW, {}).derived.agents[agentId]
  return { run, project, started, newAgent, derived, get state() { return state } }
}

describe('+ New agent with a main project', () => {
  it('starts a Member whose main project is the one picked; kind stays regular for older clients', () => {
    const f = swarm()
    const harness = f.project('harness')
    const made = f.newAgent({ kind: 'regular', name: 'Ada', mainProjectId: harness })
    expect(f.state.starts!.find(s => s.id === made.result.startId)!.request.mainProjectId).toBe(harness)
    const agentId = f.started(made.result.startId as string, 'h-ada')
    const agent = f.state.agents.find(a => a.id === agentId)!
    expect(agent.mainProjectId).toBe(harness)
    expect(agentKind(f.state, agent)).toBe('regular')
    expect(f.derived(mate, agentId)).toMatchObject({ kind: 'regular', role: 'member', mainProjectId: harness })
  })

  it('refuses a main project the person cannot read, as one that is not there', () => {
    const f = swarm()
    const secret = f.project('secret', 'private')
    expect(code(() => f.newAgent({ kind: 'regular', name: 'Ada', mainProjectId: secret }))).toBe('NOT_FOUND')
    expect(code(() => f.newAgent({ kind: 'regular', name: 'Ada', mainProjectId: 'gone' }))).toBe('NOT_FOUND')
    expect(f.state.starts ?? []).toHaveLength(0)
  })

  it('takes a main project only on the Swarm\'s start of a Member: a local start or a Lead says so', () => {
    const f = swarm()
    const harness = f.project('harness')
    expect(code(() => f.newAgent({ kind: 'regular', name: 'Ada', local: true, mainProjectId: harness }))).toBe('MAIN_PROJECT_MEMBER_ONLY')
    expect(code(() => f.newAgent({ kind: 'pm', projectName: 'Docs', mainProjectId: harness }))).toBe('MAIN_PROJECT_MEMBER_ONLY')
  })

  it('without one, starts as before, with no main project', () => {
    const f = swarm()
    const made = f.newAgent({ kind: 'regular', name: 'Ada' })
    const agentId = f.started(made.result.startId as string, 'h-ada')
    expect(f.state.agents.find(a => a.id === agentId)).not.toHaveProperty('mainProjectId')
    expect(f.derived(mate, agentId)).toMatchObject({ kind: 'regular', role: 'member', mainProjectId: null })
  })
})

describe('New project', () => {
  it('makes its Lead, whose main project is the one it leads', () => {
    const f = swarm()
    const made = f.newAgent({ kind: 'pm', projectName: 'Docs site' })
    const agentId = f.started(made.result.startId as string, 'h-lead')
    expect(f.derived(mate, agentId)).toMatchObject({ kind: 'pm', role: 'lead', mainProjectId: made.result.projectId })
  })
})

describe('a main project\'s readers', () => {
  it('shows a private main project only to readers of that project, and keeps it out of the agent\'s own part', () => {
    const f = swarm()
    const secret = f.project('secret', 'private', mate)
    const made = f.newAgent({ kind: 'regular', name: 'Ada', mainProjectId: secret })
    const agentId = f.started(made.result.startId as string, 'h-ada')
    expect(f.derived(mate, agentId)).toMatchObject({ mainProjectId: secret })
    expect(f.derived(outsider, agentId)?.mainProjectId ?? null).toBeNull()
    const parts = readerView(store.split(f.state, { tabId: 'tab', version: 9_000, now: NOW }), outsider, NOW, {}).parts
    expect(JSON.stringify(parts.agents)).not.toContain(secret)
  })

  it('goes with its deleted project: the agent is removed, and a start still waiting loses it', () => {
    const f = swarm()
    const harness = f.project('harness')
    const agentId = f.started(f.newAgent({ kind: 'regular', name: 'Ada', mainProjectId: harness }).result.startId as string, 'h-ada')
    const waiting = f.newAgent({ kind: 'regular', name: 'Bo', mainProjectId: harness }).result.startId as string
    f.run({ type: 'project.delete', projectId: harness }, owner)
    // An idle Member is its main project's agent (task #4697), so it goes with the project, as the project's agents do.
    expect(f.state.agents.find(a => a.id === agentId)).toBeUndefined()
    expect(f.state.starts!.find(s => s.id === waiting)!.request).not.toHaveProperty('mainProjectId')
  })
})
