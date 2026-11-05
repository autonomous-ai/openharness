import { describe, expect, it } from 'vitest'
import { applyCommand, commandSchema, type Command, type CommandContext } from './commands.js'
import { createSuperTab, type Actor, type AgentConfiguration, type Conversation, type MessageDraft } from './model.js'
import { capacityLine, derivedLanes, DISPATCH_RULES, dispatchPlan, freeCrew, laneCapacity, laneOf, nudgeLine, pinBuilder, pullRequestPin, returnReason } from './dispatch.js'
import type { PullRequestWatch } from './pullRequestEvents.js'
import { sweepLiveness } from './liveness.js'

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

describe('the crew\'s clocks: 2 hours without progress tells the member, 3 hours puts the task back in its lane', () => {
  const HOUR = 3_600_000, AT = 1000
  /** Ash (crew, backend) working on Api since AT; Birch (crew, backend) free. */
  function working() {
    const s = crewSwarm(['Ash', 'Birch'])
    for (const name of ['Ash', 'Birch']) s.state.agents.find(a => a.id === s.ids[name])!.crew = { role: 'Engineer', lane: 'backend', at: AT, by: 'owner' }
    const api = s.task('Api', ['backend/src/a.ts'])
    s.run({ type: 'work.assign', conversationId: api, agentId: s.ids.Ash! }, s.as(s.pm))
    /** The liveness sweep at [now], with the machine reporting every session running and busy on screen till then. */
    const sweep = (now: number) => {
      s.state.machines = [{ machineId: 'host', name: 'Mac', observation: { runningHarnessIds: s.state.agents.map(a => a.harnessId),
        stoppedHarnessIds: [], receivedAt: now, harnessProgress: Object.fromEntries(s.state.agents.map(a => [a.harnessId, now])) } }] as never
      return sweepLiveness(s.state, now)
    }
    const lines = (rows: MessageDraft[]) => rows.filter(r => r.conversationId === api && r.recipients.includes(s.ids.Ash!)).map(r => r.text)
    return { ...s, api, sweep, lines }
  }

  it('tells the member once at 2 hours, and again only after a new spell of quiet', () => {
    const s = working()
    expect(s.lines(s.sweep(AT + 2 * HOUR - 60_000))).toEqual([])
    expect(s.lines(s.sweep(AT + 2 * HOUR))).toEqual([nudgeLine('backend')])
    expect(nudgeLine('backend')).toBe('No progress on this task for 2 hours. Post where it stands, or set it blocked with why; at 3 hours it goes back to the backend lane.')
    expect(s.lines(s.sweep(AT + 2 * HOUR + 30_000))).toEqual([])
    expect(s.group(s.api).assignment!.status).toBe('working')
    // Its own post at 2 h 10 restarts both clocks.
    s.run({ type: 'message.send', conversationId: s.api, text: 'Halfway: the store is done.', replyTo: null, recipientIds: [] }, s.as(s.ids.Ash!), { now: AT + 2 * HOUR + 10 * 60_000 })
    expect(s.lines(s.sweep(AT + 3 * HOUR))).toEqual([])
    expect(s.group(s.api).assignment!.status).toBe('working')
    expect(s.lines(s.sweep(AT + 4 * HOUR + 10 * 60_000))).toEqual([nudgeLine('backend')])
  })

  it('returns the task to its lane at 3 hours with the reason, for another member, not the same one', () => {
    const s = working()
    s.sweep(AT + 2 * HOUR)
    s.sweep(AT + 3 * HOUR)
    const group = s.group(s.api)
    expect(group.assignment!.status).toBe('lost')
    expect(group.assignment!.lost!.reason).toBe('no progress for 3 hours: back in the backend lane')
    expect(dispatchPlan(s.state, 'lead', DISPATCH_RULES, AT + 3 * HOUR).map(p => [p.agentId, p.conversationId])).toEqual([[s.ids.Birch!, s.api]])
  })

  it('never ticks while it waits on a person or a review, nor for a worker not in the crew', () => {
    const s = working()
    s.group(s.api).assignment!.status = 'needs_human'
    s.sweep(AT + 4 * HOUR)
    expect(s.group(s.api).assignment!.status).toBe('needs_human')
    s.group(s.api).assignment!.status = 'review'
    s.sweep(AT + 5 * HOUR)
    expect(s.group(s.api).assignment!.status).toBe('review')
    s.group(s.api).assignment!.status = 'working'
    delete s.state.agents.find(a => a.id === s.ids.Ash)!.crew
    expect(s.lines(s.sweep(AT + 6 * HOUR))).toEqual([])
    expect(s.group(s.api).assignment!.status).toBe('working')
  })
})

describe('the capacity line per lane', () => {
  it('counts each lane\'s waiting and busy tasks, its oldest wait, and the waiting tasks in hand-out order', () => {
    const s = crewSwarm(['Ash'])
    s.state.agents.find(a => a.id === s.ids.Ash)!.crew = { role: 'Engineer', lane: 'desktop', at: 1000, by: 'owner' }
    const [a, b, c] = [s.task('A', ['desktop/lib/a.dart']), s.task('B', ['desktop/lib/b.dart']), s.task('C', ['desktop/lib/c.dart'])]
    s.task('Server', ['backend/src/x.ts'])
    s.run({ type: 'work.priority', conversationId: c, priority: 'P0' })
    s.run({ type: 'work.assign', conversationId: a, agentId: s.ids.Ash! }, s.as(s.pm))
    s.group(b).liveness = { state: 'orphaned', why: 'unstarted', since: NOW - 2.5 * 3_600_000 }
    s.group(c).liveness = { state: 'orphaned', why: 'lost', since: NOW - 3_600_000 }
    expect(laneCapacity(s.state, 'lead', DISPATCH_RULES)).toEqual([
      { lane: 'backend', waiting: 1, busy: 0, oldestAt: null, taskIds: [s.state.conversations.find(g => g.title === 'Server')!.id] },
      { lane: 'Desktop', waiting: 2, busy: 1, oldestAt: NOW - 2.5 * 3_600_000, taskIds: [c, b] },
    ])
    const desktop = laneCapacity(s.state, 'lead', DISPATCH_RULES)[1]!
    expect(capacityLine(desktop, NOW)).toBe('Desktop: 2 waiting, 1 busy, oldest 2 h')
    expect(capacityLine({ ...desktop, oldestAt: NOW - 25 * 60_000 }, NOW)).toBe('Desktop: 2 waiting, 1 busy, oldest 25 min')
    expect(capacityLine({ ...desktop, oldestAt: null }, NOW)).toBe('Desktop: 2 waiting, 1 busy')
  })

  it('is read for each project with a crew that the reader reads, and for no other', () => {
    const s = crewSwarm(['Ash'])
    s.task('Server', ['backend/src/x.ts'])
    expect(derivedLanes(s.state, s.state)).toBeUndefined()
    s.state.agents.find(a => a.id === s.ids.Ash)!.crew = { role: 'Engineer', at: 1000, by: 'owner' }
    expect(derivedLanes(s.state, s.state)).toEqual({ lead: laneCapacity(s.state, 'lead', DISPATCH_RULES) })
    // A reader who reads no project reads no lanes.
    expect(derivedLanes(s.state, { ...s.state, projects: [] })).toBeUndefined()
  })
})

describe('pins: a task without active work waits for its builder after findings, red CI or a conflict', () => {
  const watch = (patch: Partial<PullRequestWatch> = {}): PullRequestWatch => ({ url: 'https://github.com/o/r/pull/1', number: 1, state: 'open', draft: false,
    head: 'abc1234', base: 'main', mergeable: true, checkRuns: [{ name: 'ci/required', status: 'completed', conclusion: 'success', completedAt: 1 }],
    checkSuites: [], ...patch } as PullRequestWatch)

  it('reads red CI and a conflict from the pull request, and nothing from a green one', () => {
    expect(pullRequestPin(watch())).toBeNull()
    expect(pullRequestPin(watch({ mergeable: null }))).toBeNull()
    expect(pullRequestPin(watch({ checkRuns: [{ name: 'ci/required', status: 'completed', conclusion: 'failure', completedAt: 1 }] }))).toBe('ci')
    expect(pullRequestPin(watch({ mergeable: false }))).toBe('conflict')
  })

  /** Ash built Api and lost it; Birch reviews it in a step. */
  function lostBuild() {
    const s = crewSwarm(['Ash', 'Birch'])
    const api = s.task('Api', ['backend/src/a.ts'])
    s.run({ type: 'work.assign', conversationId: api, agentId: s.ids.Ash! }, s.as(s.pm))
    const step = s.run({ type: 'conversation.create', title: 'Review', brief: 'Review it.', reviewOf: api, step: 'Review',
      checks: [{ description: 'It reads right.', independent: true }] }).result.conversationId as string
    s.run({ type: 'work.assign', conversationId: step, agentId: s.ids.Birch! }, s.as(s.pm))
    const build = s.group(api), assignment = build.assignment!
    assignment.status = 'lost'
    build.lostAttempt = { id: assignment.id, agentId: s.ids.Ash!, machineId: 'host', engine: 'claude' }
    return { ...s, api, step }
  }

  it('pins its builder when a step\'s agent fails the step, and not while the build is in someone\'s hands', () => {
    const s = lostBuild()
    const check = s.group(s.step).checks[0]!.id
    const assignmentId = s.group(s.step).assignment!.id
    s.run({ type: 'work.check', conversationId: s.step, assignmentId, checkId: check, passed: false, evidence: 'The total is wrong.' }, s.as(s.ids.Birch!), { now: 5000 })
    expect(s.group(s.api).pin).toEqual({ agentId: s.ids.Ash!, why: 'findings', at: 5000 })
    // Its next assignment clears it.
    s.run({ type: 'work.assign', conversationId: s.api, agentId: s.ids.Ash! }, s.as(s.pm))
    expect(s.group(s.api)).not.toHaveProperty('pin')
    s.run({ type: 'work.check', conversationId: s.step, assignmentId, checkId: check, passed: false, evidence: 'Still wrong.' }, s.as(s.ids.Birch!), { now: 6000 })
    expect(s.group(s.api)).not.toHaveProperty('pin')
  })

  it('pins as pinBuilder says: to the last attempt\'s agent, never over active work', () => {
    const s = lostBuild()
    pinBuilder(s.group(s.api), 'ci', 7000)
    expect(s.group(s.api).pin).toEqual({ agentId: s.ids.Ash!, why: 'ci', at: 7000 })
    // An older pin keeps its time: it has waited longer.
    pinBuilder(s.group(s.api), 'conflict', 8000)
    expect(s.group(s.api).pin).toEqual({ agentId: s.ids.Ash!, why: 'ci', at: 7000 })
    const fresh = s.group(s.task('Fresh', ['backend/src/f.ts']))
    pinBuilder(fresh, 'ci', 9000)
    expect(fresh).not.toHaveProperty('pin')
  })
})
