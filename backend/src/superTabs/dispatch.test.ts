import { describe, expect, it } from 'vitest'
import { applyCommand, commandSchema, type Command, type CommandContext } from './commands.js'
import { createSuperTab, type Actor, type AgentConfiguration, type Conversation } from './model.js'
import { DISPATCH_RULES, laneOf } from './dispatch.js'

// Task #3400 (anh Dee's Swarm redesign, 2026-11-05): the server hands a free crew member its next task.
const owner: Extract<Actor, { kind: 'person' }> = { kind: 'person', userId: 'owner', email: 'owner@example.com' }
const config: AgentConfiguration = { engine: 'claude', model: 'test-model', effort: 'high', contextWindow: 200000, engineVersion: 'fixture' }
const contribution = { machineOwnerId: 'host-owner', contributorId: 'owner' }

/** A Swarm with a PM and the agents [names], all on 'host'; `task` opens a task owning [owns]. */
export function crewSwarm(names: string[] = []) {
  let state = createSuperTab('tab', 'Pilot', { id: 'owner', email: owner.email }, 'prod')
  let sequence = 0
  const run = (command: Command, actor: Actor = owner, context: Partial<CommandContext> = {}) => {
    const effects = applyCommand(state, actor, commandSchema.parse(command), { now: 1000, operationId: `op-${++sequence}`, ...context })
    state = effects.state
    return effects
  }
  const add = (name: string, lead = false) => run({ type: 'agent.add', conversationId: 'lead', machineId: 'host', harnessId: name,
    name, configuration: config, lead }, owner, { contribution }).result.agentId as string
  const pm = add('PM', true)
  const ids = Object.fromEntries(names.map(name => [name, add(name)]))
  const as = (agentId: string): Actor => ({ kind: 'agent', agentId, machineOwnerId: 'host-owner' })
  const task = (title: string, owns: string[], extra: Record<string, unknown> = {}) => run({ type: 'conversation.create', title,
    task: { goal: `${title}.`, changes: 'The change.', constraints: 'None.', owns }, checks: [], ...extra } as Command).result.conversationId as string
  const group = (id: string): Conversation => state.conversations.find(c => c.id === id)!
  return { run, add, pm, ids, as, task, group, get state() { return state } }
}

describe('a task\'s lane', () => {
  const lanes = DISPATCH_RULES.lanes

  it('is the lane that owns most of its paths, a tie going to the table\'s first', () => {
    const s = crewSwarm()
    expect(laneOf(s.group(s.task('Server', ['backend/src/superTabs/x.ts'])), lanes)).toBe('backend')
    expect(laneOf(s.group(s.task('Board', ['desktop/lib/a.dart', 'backend/src/b.ts', 'desktop/test/c_test.dart'])), lanes)).toBe('Desktop')
    expect(laneOf(s.group(s.task('Both', ['cli/src/a.ts', 'mobile/lib/b.dart'])), lanes)).toBe('CLI')
    expect(laneOf(s.group(s.task('Docs', ['docs/plans/'])), lanes)).toBe('docs')
    expect(laneOf(s.group(s.task('Elsewhere', ['firmware/main.c'])), lanes)).toBeNull()
    // A path that only starts like a lane's is not in it.
    expect(laneOf(s.group(s.task('Lookalike', ['backend-tools/run.sh'])), lanes)).toBeNull()
  })

  it('is the one the PM or a person set, over its paths, and null clears it', () => {
    const s = crewSwarm()
    const id = s.task('Server', ['backend/src/x.ts'])
    s.run({ type: 'work.lane', conversationId: id, lane: 'desktop' }, s.as(s.pm))
    expect(s.group(id).lane).toBe('Desktop')
    expect(laneOf(s.group(id), lanes)).toBe('Desktop')
    s.run({ type: 'work.lane', conversationId: id, lane: 'mobile' })
    expect(laneOf(s.group(id), lanes)).toBe('mobile')
    s.run({ type: 'work.lane', conversationId: id, lane: null }, s.as(s.pm))
    expect(s.group(id)).not.toHaveProperty('lane')
    expect(laneOf(s.group(id), lanes)).toBe('backend')
  })

  it('is set by no other agent, and only to a lane of the table, on a task', () => {
    const s = crewSwarm(['Builder'])
    const id = s.task('Server', ['backend/src/x.ts'])
    const before = structuredClone(s.state)
    expect(() => s.run({ type: 'work.lane', conversationId: id, lane: 'CLI' }, s.as(s.ids.Builder!)))
      .toThrow(expect.objectContaining({ code: 'COORDINATOR_REQUIRED' }))
    expect(() => s.run({ type: 'work.lane', conversationId: id, lane: 'firmware' }))
      .toThrow(expect.objectContaining({ code: 'LANE_UNKNOWN', status: 400, message: 'Name a lane: backend, CLI, Desktop, mobile or docs.' }))
    expect(() => s.run({ type: 'work.lane', conversationId: 'lead', lane: 'CLI' }))
      .toThrow(expect.objectContaining({ code: 'LANE_TASK_ONLY', status: 400 }))
    expect(s.state).toEqual(before)
  })
})
