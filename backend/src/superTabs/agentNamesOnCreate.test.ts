import { describe, expect, it } from 'vitest'
import { AGENT_NAMES } from './agentNames.js'
import { applyCommand, type Command, type CommandContext } from './commands.js'
import type { ContributedMachine } from './machines.js'
import { createSuperTab, SuperTabError, type Actor, type SuperTabState } from './model.js'

// Task #4568 (anh Dee, 11-07 19:40): every agent gets a real name when it is made, the first one a person brings when they
// join included; no more "<person>'s Buddy". Names are unique in the Swarm.
const NOW = 50_000_000
const owner: Extract<Actor, { kind: 'person' }> = { kind: 'person', userId: 'owner', email: 'owner@example.com' }
const resources = { cpuPercent: 1, memoryTotalBytes: 8, memoryUsedBytes: 1, diskFreeBytes: 8, diskTotalBytes: 8, projectDiskFreeBytes: 8,
  deviceType: null, chip: null, os: null, gpuPercent: null }
const reading = { generation: 'g1', receivedAt: NOW, resources, tools: {}, quotas: [], runningHarnessIds: [],
  stoppedHarnessIds: [], capabilities: ['leadStart', 'regularAgent'] }
const configuration = { engine: 'claude' as const, model: 'opus', effort: 'high', contextWindow: null, engineVersion: null }
const own = (userId: string) => ({ contribution: { machineOwnerId: userId, contributorId: userId } })
const code = (body: () => unknown): string | null => {
  try { body(); return null } catch (error) { return error instanceof SuperTabError ? error.code : 'INVALID' }
}
const person = (n: number): Extract<Actor, { kind: 'person' }> => ({ kind: 'person', userId: `p${n}`, email: `person${n}@example.com` })

function swarm(people = 1) {
  let state: SuperTabState = createSuperTab('tab', 'Pilot', { id: 'owner', email: owner.email }, 'prod')
  let sequence = 0
  const run = (command: Command, actor: Actor, context: Partial<CommandContext> = {}) => {
    const effects = applyCommand(state, actor, command, { now: NOW, operationId: `op-${++sequence}`, ...context })
    state = effects.state
    return effects
  }
  for (let n = 0; n < people; n++) {
    const invited = run({ type: 'invite.create', email: person(n).email, role: 'collaborator', conversationId: 'lead' }, owner)
    run({ type: 'invite.accept', inviteId: invited.result.inviteId as string }, person(n))
  }
  const listed = (machineId: string, contributorId: string): ContributedMachine => ({ machineId, name: machineId, contributorId,
    membershipGeneration: state.people.find(p => p.id === contributorId)!.generation, generation: 'g1', cwd: '/swarm', scope: 'swarm',
    engines: ['claude', 'codex'], maxAgents: 4, paused: false, observation: reading })
  const chatOf = (id: unknown) => state.conversations.find(c => c.id === id)!
  const started = (startId: string, who: Actor, userId: string) => {
    run({ type: 'agent.startDispatch', startId }, who, own(userId))
    return run({ type: 'agent.started', startId, harnessId: `h-${startId}`, configuration }, who, own(userId)).result.agentId as string
  }
  return { run, listed, chatOf, started, get state() { return state }, set machines(list: ContributedMachine[]) { state.machines = list } }
}

describe('+ New agent', () => {
  function withComputer() {
    const f = swarm(1)
    f.machines = [f.listed('p0-mac', 'p0')]
    const add = (extra: Record<string, unknown>) =>
      f.run({ type: 'agent.new', kind: 'regular', engine: 'claude', machineId: 'p0-mac', ...extra } as Command, person(0), own('p0'))
    return { f, add }
  }

  it('gets a real name when its person names none, or only its engine (Desktop\'s Cmd-N)', () => {
    const { f, add } = withComputer()
    for (const extra of [{}, { name: 'Claude Code' }, { name: 'Codex', local: true }]) {
      const chat = f.chatOf(add(extra).result.conversationId)
      expect(AGENT_NAMES).toContain(chat.title)
    }
    const titles = f.state.conversations.filter(c => c.kind === 'agent-chat').map(c => c.title)
    expect(new Set(titles).size).toBe(3)
  })

  it('refuses a name another agent or a person already has', () => {
    const { f, add } = withComputer()
    const taken = f.chatOf(add({}).result.conversationId).title
    expect(code(() => add({ name: taken }))).toBe('AGENT_NAME_TAKEN')
    expect(code(() => add({ name: 'person0' }))).toBe('AGENT_NAME_TAKEN')
    expect(f.chatOf(add({ name: 'Moonbeam' }).result.conversationId).title).toBe('Moonbeam')
  })

  // Security review 2 of #3560: an agent never comes up with a teammate's shown name or username, an agent passing as a person.
  it('never picks a name a person in the Swarm goes by', () => {
    const first = withComputer()
    const name = first.f.chatOf(first.add({}).result.conversationId).title
    for (const field of ['name', 'username'] as const) {
      const { f, add } = withComputer()
      // The Swarm's owner goes by the name this person's agent would be offered first.
      Object.assign(f.state.people.find(p => p.id === 'owner')!, { [field]: name })
      const picked = f.chatOf(add({}).result.conversationId).title
      expect(AGENT_NAMES).toContain(picked)
      expect(picked.toLowerCase()).not.toBe(name.toLowerCase())
    }
  })
})

describe('renaming an agent', () => {
  it('refuses an engine\'s name, which reads as no name', () => {
    const f = swarm(1)
    f.machines = [f.listed('p0-mac', 'p0')]
    const made = f.run({ type: 'agent.new', kind: 'regular', engine: 'claude', machineId: 'p0-mac', name: 'Moonbeam' } as Command, person(0), own('p0'))
    const agentId = f.started(made.result.startId as string, person(0), 'p0')
    expect(code(() => f.run({ type: 'agent.rename', agentId, name: 'Codex' }, person(0)))).toBe('AGENT_NAME_ROLE')
    f.run({ type: 'agent.rename', agentId, name: 'Sunrise' }, person(0))
    expect(f.state.agents.find(a => a.id === agentId)!.displayName).toBe('Sunrise')
    // Back to the name it started with, which its own chat still shows.
    f.run({ type: 'agent.rename', agentId, name: 'Moonbeam' }, person(0))
    expect(f.state.agents.find(a => a.id === agentId)!.displayName).toBe('Moonbeam')
  })
})
