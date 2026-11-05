// Task #3462: each crew wake and move is recorded when it finishes, from its start to the moment the agent runs again,
// with its reason (docs/plans/2026-11-06-crew-wake-move-times-plan.md).
import { describe, expect, it } from 'vitest'
import { agentOnly, type Agent, type SuperTabState } from './model.js'
import { crewTimingOf, finishedWakes, moveTimingRow, startWake } from './crewTimes.js'
import { applyCommand, type Command } from './commands.js'
import { applyCrewKeep } from './crewKeep.js'
import { config as crewConfig, fixture, machine, NOW, person } from './crewKeep.test-support.js'

const SECOND = 1000
const T = Date.UTC(2026, 10, 6, 3)
const config = { engine: 'claude', model: 'opus', effort: 'high', contextWindow: null, engineVersion: null }
const member = (over: Partial<Agent> = {}): Agent => ({ id: 'ada', machineId: 'mac', harnessId: 'h-ada', machineOwnerId: 'o', contributorId: 'p',
  membershipGeneration: 'g', name: 'Ada', configuration: config, crew: { role: 'Engineer', at: 1, by: 'p' }, ...over }) as Agent
/** A Swarm whose project chat `chat` is led by `pm`, with [agents], and machine `mac`'s last reading when given. */
const swarm = (agents: Agent[], reading?: { receivedAt: number; running: string[] }) => ({
  id: 't', ownerId: 'p', name: 'S', environment: 'prod', paused: false,
  people: [{ id: 'p', email: 'p@example.com', role: 'owner', generation: 'g' }],
  agents: [member({ id: 'pm', harnessId: 'h-pm', name: 'River', crew: undefined }), ...agents],
  projects: [{ id: 'lead', name: 'App', ownerId: 'p', leadConversationId: 'chat', visibility: 'public', members: [] }],
  machines: reading ? [{ machineId: 'mac', name: 'Studio', observation: { runningHarnessIds: reading.running, stoppedHarnessIds: [], receivedAt: reading.receivedAt } }] : [],
  conversations: [{ id: 'chat', title: 'App', leadId: 'pm', agentIds: ['pm', 'ada'], archived: false, brief: '', checks: [], assignment: null, lastMessageSequence: 0 },
    { id: 'task7', number: 7, title: 'Fix login', leadId: null, agentIds: ['ada'], archived: false, brief: '', checks: [], assignment: null, lastMessageSequence: 0 }],
} as unknown as SuperTabState)

describe('a crew wake is timed from the work that woke it to its session running again (#3462)', () => {
  it('finishes at the first reading that lists the session running, with the task as its reason', () => {
    const ada = member()
    startWake(ada, 'task7', T)
    expect(ada.crewWaking).toEqual({ at: T, conversationId: 'task7' })
    // Its session is not back yet: nothing is recorded, and the wake stays open.
    expect(finishedWakes(swarm([ada], { receivedAt: T + 5 * SECOND, running: ['h-pm'] }), T + 6 * SECOND)).toEqual([])
    expect(ada.crewWaking).toBeDefined()
    const rows = finishedWakes(swarm([ada], { receivedAt: T + 12 * SECOND, running: ['h-pm', 'h-ada'] }), T + 14 * SECOND)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ conversationId: 'chat', recipients: [], author: expect.objectContaining({ kind: 'agent', id: 'pm' }) })
    expect(crewTimingOf(rows[0]!.source)).toEqual({ what: 'wake', agentId: 'ada', startedAt: T, runningAt: T + 12 * SECOND, reason: 'work on #7' })
    // The coordinator's alone: people do not read it.
    expect(agentOnly(rows[0]!.source, rows[0]!.recipients)).toBe(true)
    expect(ada.crewWaking).toBeUndefined()
  })

  it('never counts a reading from before the wake, or a machine that has not read since', () => {
    const ada = member()
    startWake(ada, 'task7', T)
    expect(finishedWakes(swarm([ada], { receivedAt: T - SECOND, running: ['h-ada'] }), T + SECOND)).toEqual([])
    expect(finishedWakes(swarm([ada]), T + SECOND)).toEqual([])
    expect(ada.crewWaking).toBeDefined()
  })

  it('keeps the time it ran again until its project chat is loaded, so a dormant chat loses no wake', () => {
    const ada = member()
    startWake(ada, 'task7', T)
    const unloaded = swarm([ada], { receivedAt: T + 9 * SECOND, running: ['h-ada'] })
    unloaded.conversations = unloaded.conversations.filter(c => c.id !== 'chat')
    expect(finishedWakes(unloaded, T + 10 * SECOND)).toEqual([])
    expect(ada.crewWaking).toEqual({ at: T, conversationId: 'task7', runningAt: T + 9 * SECOND })
    // Later, with the chat loaded and a newer reading: timed to the first reading that showed it running.
    const rows = finishedWakes(swarm([ada], { receivedAt: T + 300 * SECOND, running: ['h-ada'] }), T + 301 * SECOND)
    expect(crewTimingOf(rows[0]!.source)).toMatchObject({ startedAt: T, runningAt: T + 9 * SECOND })
    expect(ada.crewWaking).toBeUndefined()
  })

  it('records one row per wake: a second pass after it finished writes nothing', () => {
    const ada = member()
    startWake(ada, 'task7', T)
    const state = swarm([ada], { receivedAt: T + 3 * SECOND, running: ['h-ada'] })
    expect(finishedWakes(state, T + 4 * SECOND)).toHaveLength(1)
    expect(finishedWakes(state, T + 34 * SECOND)).toEqual([])
  })
})

describe('a crew move is timed from the keeper picking a machine to the new session taking over (#3462)', () => {
  it('writes one row with the move start, the takeover and the trouble that moved it', () => {
    const moved = member({ id: 'ada2', harnessId: 'h-ada2', machineId: 'mini' })
    const state = swarm([moved])
    const row = moveTimingRow(state, moved.id, T, 'offline', T + 140 * SECOND)
    expect(row).toMatchObject({ conversationId: 'chat', recipients: [] })
    expect(crewTimingOf(row!.source)).toEqual({ what: 'move', agentId: 'ada2', startedAt: T, runningAt: T + 140 * SECOND, reason: 'offline' })
    // Retried with the same times: the same row, so it is written once.
    expect(moveTimingRow(state, moved.id, T, 'offline', T + 140 * SECOND)!.id).toBe(row!.id)
  })

  it('reads nothing but its own rows', () => {
    expect(crewTimingOf({ kind: 'system', status: 'done' })).toBeNull()
    expect(crewTimingOf({ kind: 'crew-timing', what: 'nap', agentId: 'a', startedAt: 1, runningAt: 2, reason: 'x' })).toBeNull()
    expect(crewTimingOf({ kind: 'crew-timing', what: 'wake', agentId: 'a', startedAt: 5, runningAt: 2, reason: 'x' })).toBeNull()
    expect(crewTimingOf(null)).toBeNull()
  })
})

// The crew keeper's hooks (#3229 on main): work.assign starts a wake, agent.started's takeover finishes a move.
describe('the crew keeper times its own wakes and moves (#3462)', () => {
  const host = { contribution: { machineOwnerId: 'owner', contributorId: 'owner' } }
  const run = (state: SuperTabState, command: Command, operationId: string, now: number, extra: Record<string, unknown> = {}) =>
    applyCommand(state, person, command, { now, operationId, ...extra })
  const task = (f: ReturnType<typeof fixture>) => {
    f.state = run(f.state, { type: 'conversation.create', title: 'Fix it', brief: 'Fix the thing', checks: [] } as Command, 'task-1', NOW - 3_600_000).state
    return f.state.conversations.find(c => c.title === 'Fix it')!
  }

  it('new work on an asleep member starts its wake; work for an awake one starts none', () => {
    const asleep = fixture()
    asleep.ada.asleep = { since: NOW - 7_200_000 }
    const work = task(asleep)
    asleep.state = run(asleep.state, { type: 'work.assign', conversationId: work.id, agentId: asleep.ada.id } as Command, 'assign-1', NOW).state
    expect(asleep.state.agents.find(a => a.id === asleep.ada.id)!.crewWaking).toEqual({ at: NOW, conversationId: work.id })
    const awake = fixture()
    const other = task(awake)
    awake.state = run(awake.state, { type: 'work.assign', conversationId: other.id, agentId: awake.ada.id } as Command, 'assign-1', NOW).state
    expect(awake.state.agents.find(a => a.id === awake.ada.id)!.crewWaking).toBeUndefined()
  })

  it('a move\'s new session taking over writes one timing row, from the keeper\'s pick to the takeover', () => {
    const f = fixture([machine('mac', { signedIn: false }), machine('mini')])
    applyCrewKeep(f.state, NOW, { admits: () => true })
    const start = f.state.starts!.find(s => s.request.crewMoveOf === f.ada.id)!
    const effects = run(f.state, { type: 'agent.started', startId: start.id, harnessId: 'ada-2', configuration: crewConfig } as Command, 'started-1', NOW + 95_000, host)
    const moved = effects.state.agents.find(a => a.harnessId === 'ada-2')!
    const timings = effects.messages.flatMap(m => crewTimingOf(m.source) ? [{ row: m, timing: crewTimingOf(m.source)! }] : [])
    expect(timings).toHaveLength(1)
    expect(timings[0]!.timing).toEqual({ what: 'move', agentId: moved.id, startedAt: NOW, runningAt: NOW + 95_000, reason: 'signed-out' })
    expect(timings[0]!.row.conversationId).toBe('lead')
  })

  it('the crew keeper reads crew membership through crew.ts isCrew, with no copy of its own', async () => {
    expect(Object.keys(await import('./crewKeep.js'))).not.toContain('isCrewMember')
  })
})
