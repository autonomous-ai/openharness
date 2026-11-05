import { describe, expect, it } from 'vitest'
import { applyCommand, commandSchema, type Command, type CommandContext } from './commands.js'
import { createSuperTab, type Actor, type AgentConfiguration, type Conversation } from './model.js'
import { DISPATCH_RULES, dispatchPlan, freeCrew, laneOf, returnReason } from './dispatch.js'

const NOW = Date.parse('2026-11-05T15:00:00Z')

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

describe('what a free crew member gets', () => {
  /** A crew of [names] (Engineers with no lane unless [lanes] gives one), and four tasks: two backend, one Desktop, one CLI. */
  function crew(names: string[], lanes: Record<string, string> = {}) {
    const s = crewSwarm(names)
    for (const name of names) {
      const member = s.state.agents.find(a => a.id === s.ids[name])!
      member.crew = { role: 'Engineer', ...lanes[name] ? { lane: lanes[name] } : {}, at: 1000, by: 'owner' }
    }
    const tasks = { api: s.task('Api', ['backend/src/a.ts']), store: s.task('Store', ['backend/src/b.ts']),
      board: s.task('Board', ['desktop/lib/c.dart']), hosts: s.task('Hosts', ['cli/src/d.ts']) }
    const picks = (now = NOW) => dispatchPlan(s.state, 'lead', DISPATCH_RULES, now).map(p => [nameOf(s, p.agentId), titleOf(s, p.conversationId), p.why])
    return { ...s, tasks, picks }
  }
  const nameOf = (s: ReturnType<typeof crewSwarm>, id: string) => s.state.agents.find(a => a.id === id)!.name
  const titleOf = (s: ReturnType<typeof crewSwarm>, id: string) => s.group(id).title
  /** Gives [agentId] [conversationId] in [status], as work.assign and then work.status leave it (written directly: before
   *  #3399 work.assign still counts a handed task as busy). */
  const holding = (s: ReturnType<typeof crewSwarm>, agentId: string, conversationId: string, status: 'working' | 'review' | 'done' = 'working') => {
    s.group(conversationId).assignment = { id: `held-${conversationId}`, agentId, status, configuration: config,
      execution: { machineId: 'host', harnessId: agentId, machineOwnerId: 'host-owner' }, result: null }
  }

  it('is its lane\'s top task, the queue\'s order, each task to one member', () => {
    const s = crew(['Ash', 'Birch', 'Cedar'], { Ash: 'backend', Birch: 'backend', Cedar: 'desktop' })
    expect(s.picks()).toEqual([['Ash', 'Api', 'lane'], ['Birch', 'Store', 'lane'], ['Cedar', 'Board', 'lane']])
  })

  it('puts a P0 first, wherever the queue has it', () => {
    const s = crew(['Ash'], { Ash: 'backend' })
    s.run({ type: 'work.priority', conversationId: s.tasks.store, priority: 'P0' })
    expect(s.picks()).toEqual([['Ash', 'Store', 'lane']])
  })

  it('gives a crew Engineer with no lane the project\'s top task, and any other role nothing', () => {
    const s = crew(['Ash', 'Birch'])
    s.state.agents.find(a => a.id === s.ids.Birch)!.crew!.role = 'Reviewer'
    s.run({ type: 'work.queue', conversationId: s.tasks.hosts, after: null })
    expect(s.picks()).toEqual([['Ash', 'Hosts', 'lane']])
  })

  it('gives a member its pinned task first, and a pin whose member left the crew goes to the lane', () => {
    const s = crew(['Ash', 'Birch'], { Ash: 'backend', Birch: 'backend' })
    s.group(s.tasks.store).pin = { agentId: s.ids.Birch!, why: 'ci', at: 2000 }
    expect(s.picks()).toEqual([['Ash', 'Api', 'lane'], ['Birch', 'Store', 'pin']])
    delete s.state.agents.find(a => a.id === s.ids.Birch)!.crew
    expect(s.picks()).toEqual([['Ash', 'Api', 'lane']])
  })

  it('counts a member free with fewer than 3 handed tasks and nothing in its hands', () => {
    const s = crew(['Ash'], { Ash: 'backend' })
    holding(s, s.ids.Ash!, s.tasks.api, 'review')
    expect(s.picks()).toEqual([['Ash', 'Store', 'lane']])
    holding(s, s.ids.Ash!, s.tasks.board, 'review')
    expect(freeCrew(s.state, 'lead', DISPATCH_RULES, NOW).map(a => a.name)).toEqual(['Ash'])
    holding(s, s.ids.Ash!, s.tasks.hosts, 'review')
    expect(s.picks()).toEqual([])
    // A finished one counts no more; one in its hands keeps it busy.
    holding(s, s.ids.Ash!, s.tasks.hosts, 'done')
    expect(s.picks()).toEqual([['Ash', 'Store', 'lane']])
    holding(s, s.ids.Ash!, s.task('Cache', ['backend/src/e.ts']))
    expect(s.picks()).toEqual([])
  })

  it('leaves out the PM, a Buddy, a stopping member, a moving one and an agent not in the crew; an asleep one is free', () => {
    const s = crew(['Ash', 'Birch', 'Cedar', 'Dune'], { Ash: 'backend', Birch: 'backend', Cedar: 'backend', Dune: 'backend' })
    const pm = s.state.agents.find(a => a.id === s.pm)!
    pm.crew = { role: 'PM', at: 1000, by: 'owner' }
    const agent = (name: string) => s.state.agents.find(a => a.id === s.ids[name])!
    agent('Ash').workDecision = 'stop'
    Object.assign(agent('Birch'), { movedTo: { machineId: 'other', at: 2000 } })
    Object.assign(agent('Cedar'), { asleep: { since: 2000 } })
    s.add('Elm')
    expect(freeCrew(s.state, 'lead', DISPATCH_RULES, NOW).map(a => a.name)).toEqual(['Cedar', 'Dune'])
  })

  it('never picks a step, an archived task, a chat, a finished task or one not to start before a later day', () => {
    const s = crew(['Ash'], { Ash: 'backend' })
    s.run({ type: 'conversation.create', title: 'Review', brief: 'Review it.', reviewOf: s.tasks.board, step: 'Review', checks: [] })
    s.run({ type: 'conversation.archive', conversationId: s.tasks.api, archived: true })
    s.run({ type: 'work.queue', conversationId: s.tasks.store, notBefore: '2026-11-06' })
    expect(s.picks()).toEqual([])
    s.run({ type: 'work.queue', conversationId: s.tasks.store, notBefore: '2026-11-05' })
    expect(s.picks()).toEqual([['Ash', 'Store', 'lane']])
    holding(s, s.ids.Ash!, s.tasks.store, 'done')
    expect(s.picks()).toEqual([])
  })

  it('does not hand a member the task it lost for no progress at once; another member takes it', () => {
    const s = crew(['Ash', 'Birch'], { Ash: 'backend', Birch: 'desktop' })
    holding(s, s.ids.Ash!, s.tasks.api)
    const assignment = s.group(s.tasks.api).assignment!
    assignment.status = 'lost'
    assignment.lost = { reason: returnReason('backend'), at: NOW }
    s.group(s.tasks.api).lostAttempt = { id: assignment.id, agentId: s.ids.Ash!, machineId: 'host', engine: 'claude' }
    expect(s.picks()).toEqual([['Ash', 'Store', 'lane'], ['Birch', 'Board', 'lane']])
    s.group(s.tasks.store).lane = 'Desktop'
    s.group(s.tasks.board).lane = 'backend'
    expect(s.picks()).toEqual([['Ash', 'Board', 'lane'], ['Birch', 'Store', 'lane']])
  })

  it('hands out nothing while the Swarm is paused', () => {
    const s = crew(['Ash'], { Ash: 'backend' })
    s.state.paused = true
    expect(s.picks()).toEqual([])
  })
})
