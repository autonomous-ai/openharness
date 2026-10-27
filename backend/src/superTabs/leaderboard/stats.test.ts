import { describe, expect, it } from 'vitest'
import type { ContributedMachine } from '../machines.js'
import { createSuperTab, type Assignment, type Conversation, type SuperTabState, type WorkStatus } from '../model.js'
import type { GroupLedger } from './record.js'
import { leaderboard } from './stats.js'
import { DAY_MS, WEEK_MS } from './week.js'

// Monday 2026-10-26 00:00 UTC; "now" is Thursday noon of that week.
const WEEK = Date.UTC(2026, 9, 26), LAST = WEEK - WEEK_MS, NOW = WEEK + 3 * DAY_MS + 12 * 3_600_000
const HOUR = 3_600_000

/** A fixture Swarm: Ken owns it; Dee, Tony and Scholes are members. */
function swarm(): SuperTabState {
  const state = createSuperTab('tab', 'Pilot', { id: 'ken', email: 'ken@example.com' }, 'prod')
  state.people.push(...['dee', 'tony', 'scholes'].map(id => ({ id, email: `${id}@example.com`, role: 'collaborator' as const, generation: 'g' })))
  return state
}
let n = 0
function group(extra: Partial<Conversation> & { ledger?: GroupLedger; status?: WorkStatus } = {}): Conversation {
  const { status, ...rest } = extra
  const id = `g${++n}`
  const assignment: Assignment | null = status ? { id: `a-${id}`, agentId: 'worker', status, result: null,
    configuration: { engine: 'claude', model: 'opus', effort: 'high', contextWindow: null, engineVersion: null },
    execution: { machineId: 'mac', harnessId: 'h', machineOwnerId: 'ken' } } : null
  return { id, projectId: 'lead', title: `Group ${id}`, leadId: null, agentIds: [], archived: false, brief: 'Do it', checks: [], assignment,
    lastMessageSequence: 0, ...rest }
}
/** A request by [requesterId] asked at [askedAt] and shipped at [shippedAt] with a linked PR. */
const shipped = (requesterId: string, askedAt: number, shippedAt: number, extra: Partial<Conversation> = {}) =>
  group({ requesterId, status: 'done', pullRequestUrls: ['https://github.com/o/r/pull/1'], ledger: { askedAt, shippedAt }, ...extra })
const answered = (...unblocks: Array<[personId: string, at: number, waitedMs: number]>) =>
  group({ status: 'working', ledger: { unblocks: unblocks.map(([personId, at, waitedMs]) => ({ personId, at, waitedMs })) } })
function machine(contributorId: string, lent: Array<[week: number, agentMs: number]>, machineId = `mac-${contributorId}`): ContributedMachine {
  return { machineId, name: machineId, contributorId, membershipGeneration: 'g', generation: 'g1', cwd: '/repo', scope: 'swarm', engines: ['claude'],
    maxAgents: 2, paused: false, lent: lent.map(([week, agentMs]) => ({ week, agentMs })) }
}
const board = (state: SuperTabState, groups: Conversation[], week = WEEK, now = NOW, machines = state.machines ?? []) =>
  leaderboard({ state, groups, machines, projectId: 'lead', week, now })
const person = (view: ReturnType<typeof board>, id: string) => view.people.find(p => p.personId === id)!

describe('Shipped: requests a person asked for, done with a linked PR, 3 points each', () => {
  it('counts each shipped request of the week for its requester', () => {
    const view = board(swarm(), [shipped('dee', WEEK, WEEK + HOUR), shipped('dee', WEEK - DAY_MS, WEEK + 2 * HOUR), shipped('ken', LAST, LAST + HOUR)])
    expect(person(view, 'dee')).toMatchObject({ points: 6, shipped: { count: 2 } })
    expect(person(view, 'ken')).toMatchObject({ points: 0, shipped: { count: 0 } })
  })

  it('needs a linked PR: done work without one has not landed', () => {
    const view = board(swarm(), [shipped('dee', WEEK, WEEK + HOUR, { pullRequestUrls: [] })])
    expect(person(view, 'dee').shipped.count).toBe(0)
  })

  it('counts a request, not its review group, and never a group nobody asked for', () => {
    const view = board(swarm(), [shipped('dee', WEEK, WEEK + HOUR, { reviewOf: 'g0' }), shipped('', WEEK, WEEK + HOUR, { requesterId: undefined })])
    expect(view.people.map(p => [p.personId, p.shipped.count])).toEqual([['dee', 0], ['ken', 0], ['scholes', 0], ['tony', 0]])
  })

  it('never counts a private conversation, even one carrying a ship record', () => {
    const view = board(swarm(), [shipped('dee', WEEK, WEEK + HOUR, { audience: { people: [{ id: 'dee', generation: 'g' }] } })])
    expect(person(view, 'dee').shipped.count).toBe(0)
    expect(view.goal.thisWeek.shipped).toBe(0)
  })

  it('still counts a shipped request once its group is archived', () => {
    expect(person(board(swarm(), [shipped('dee', WEEK, WEEK + HOUR, { archived: true })]), 'dee').shipped.count).toBe(1)
  })

  it('gives each person the median time from asking to shipping', () => {
    const view = board(swarm(), [shipped('dee', WEEK, WEEK + HOUR), shipped('dee', WEEK, WEEK + 3 * HOUR), shipped('dee', WEEK, WEEK + 8 * HOUR)])
    expect(person(view, 'dee').shipped.medianAskToShipMs).toBe(3 * HOUR)
  })
})

describe('Unblocked: waiting items a person answered, 1 point each plus 1 per 2 agent-hours waited', () => {
  it('adds the answers and the agent-hours they freed', () => {
    const view = board(swarm(), [answered(['tony', WEEK + HOUR, 3 * HOUR], ['tony', WEEK + 2 * HOUR, 90 * 60_000]), answered(['tony', LAST, 10 * HOUR])])
    // Two answers this week, 4.5 agent-hours between them: 2 + 2.
    expect(person(view, 'tony')).toMatchObject({ points: 4, unblocked: { count: 2, agentMs: 4.5 * HOUR, medianAnswerMs: 2.25 * HOUR } })
  })
})

describe('Lent: agent-hours run on a person\'s machines, 1 point per 10', () => {
  it('counts this week\'s agent-hours on every machine the person contributed', () => {
    const state = swarm()
    state.machines = [machine('scholes', [[WEEK, 14 * HOUR], [LAST, 50 * HOUR]]), machine('scholes', [[WEEK, 7 * HOUR]], 'gpu'), machine('ken', [[LAST, 40 * HOUR]])]
    const view = board(state, [])
    expect(person(view, 'scholes')).toMatchObject({ points: 2, lent: { machines: 2, agentMs: 21 * HOUR } })
    expect(person(view, 'ken')).toMatchObject({ points: 0, lent: { machines: 0, agentMs: 0 } })
  })

  it('sums only the machines the reader may see', () => {
    const state = swarm()
    state.machines = [machine('scholes', [[WEEK, 14 * HOUR]]), machine('scholes', [[WEEK, 30 * HOUR]], 'project-mac')]
    expect(person(board(state, [], WEEK, NOW, [state.machines[0]!]), 'scholes').lent).toEqual({ machines: 1, agentMs: 14 * HOUR })
  })
})

describe('ranking and medals', () => {
  it('ranks by points with medals for the top three, ties sharing a place', () => {
    const view = board(swarm(), [shipped('ken', WEEK, WEEK + HOUR), shipped('ken', WEEK, WEEK + HOUR), shipped('dee', WEEK, WEEK + HOUR),
      shipped('tony', WEEK, WEEK + HOUR), answered(['scholes', WEEK + HOUR, 0])])
    expect(view.people.map(p => [p.personId, p.points, p.rank, p.medal])).toEqual([
      ['ken', 6, 1, 'gold'], ['dee', 3, 2, 'silver'], ['tony', 3, 2, 'silver'], ['scholes', 1, 4, null]])
  })

  it('gives no medal to a person with no points', () => {
    const view = board(swarm(), [shipped('ken', WEEK, WEEK + HOUR)])
    expect(view.people.filter(p => p.medal).map(p => p.personId)).toEqual(['ken'])
  })

  it('lists only people who can read the project', () => {
    const state = swarm()
    state.projects![0] = { ...state.projects![0]!, visibility: 'private', members: [{ id: 'dee', generation: 'g' }] }
    expect(board(state, []).people.map(p => p.personId).sort()).toEqual(['dee', 'ken'])
  })
})

describe('a shipping streak', () => {
  it('counts the days in a row, up to today, with a shipped request', () => {
    const today = WEEK + 3 * DAY_MS
    const view = board(swarm(), [shipped('dee', LAST, today + HOUR), shipped('dee', LAST, today - DAY_MS + HOUR), shipped('dee', LAST, today - 2 * DAY_MS),
      shipped('dee', LAST, today - 4 * DAY_MS)])
    expect(person(view, 'dee').streakDays).toBe(3)
  })

  it('keeps yesterday\'s streak alive until today ends', () => {
    const today = WEEK + 3 * DAY_MS
    const view = board(swarm(), [shipped('dee', LAST, today - DAY_MS), shipped('dee', LAST, today - 2 * DAY_MS)])
    expect(person(view, 'dee').streakDays).toBe(2)
  })

  it('is zero after a day without shipping', () => {
    const today = WEEK + 3 * DAY_MS
    expect(person(board(swarm(), [shipped('dee', LAST, today - 2 * DAY_MS)]), 'dee').streakDays).toBe(0)
  })
})

describe('the team goal', () => {
  it('compares shipped requests, points and the median ask-to-ship time with last week', () => {
    const view = board(swarm(), [shipped('dee', WEEK, WEEK + 2 * HOUR), shipped('ken', WEEK, WEEK + 4 * HOUR),
      shipped('dee', LAST, LAST + 10 * HOUR), answered(['tony', LAST + HOUR, 0])])
    expect(view.goal.thisWeek).toEqual({ shipped: 2, points: 6, medianAskToShipMs: 3 * HOUR })
    expect(view.goal.lastWeek).toEqual({ shipped: 1, points: 4, medianAskToShipMs: 10 * HOUR })
  })

  it('counts the project\'s open requests: shared work not yet shipped, cancelled or archived', () => {
    const view = board(swarm(), [group({ status: 'working', requesterId: 'dee' }), group({}), group({ status: 'cancelled' }), group({ archived: true }),
      group({ reviewOf: 'g0', status: 'working' }), shipped('dee', WEEK, WEEK + HOUR), group({ audience: { people: [] } })])
    expect(view.goal.openRequests).toBe(2)
  })
})

describe('agents waiting on a person now', () => {
  it('shows how many items wait on each person, in name order, never ranked', () => {
    const view = board(swarm(), [group({ status: 'needs_human', requesterId: 'tony' }), group({ status: 'needs_human' }), group({ status: 'needs_human' }),
      group({ status: 'working', requesterId: 'tony' })])
    expect(view.waiting).toEqual({ total: 3, people: [
      { personId: 'ken', count: 2, conversationIds: [expect.any(String), expect.any(String)] },
      { personId: 'tony', count: 1, conversationIds: [expect.any(String)] }] })
    expect(Object.keys(view.waiting.people[0]!).sort()).toEqual(['conversationIds', 'count', 'personId'])
  })

  it('drops an answered item at once, though its worker has not moved on yet (review of #1762)', () => {
    const answered = group({ status: 'needs_human' }), open = group({ status: 'needs_human' })
    answered.ledger = { waiting: { assignmentId: answered.assignment!.id, since: WEEK, messageId: 'm', answeredAt: WEEK + HOUR } }
    expect(board(swarm(), [answered, open]).waiting).toEqual({ total: 1, people: [{ personId: 'ken', count: 1, conversationIds: [open.id] }] })
  })

  it('keeps showing an item that was waiting before answers were recorded', () => {
    expect(board(swarm(), [group({ status: 'needs_human', ledger: { askedAt: WEEK } })]).waiting.total).toBe(1)
  })

  it('waits on the project owner once the requester has left the Swarm', () => {
    const state = swarm()
    state.people = state.people.filter(p => p.id !== 'tony')
    const view = board(state, [group({ status: 'needs_human', requesterId: 'tony' })])
    expect(view.waiting.people.map(p => p.personId)).toEqual(['ken'])
  })

  it('never includes a private conversation', () => {
    const view = board(swarm(), [group({ status: 'needs_human', audience: { people: [{ id: 'ken', generation: 'tab' }] } })])
    expect(view.waiting).toEqual({ total: 0, people: [] })
  })
})

describe('the week asked for', () => {
  it('reads last week as its own week, with the week before for comparison', () => {
    const view = board(swarm(), [shipped('dee', LAST, LAST + HOUR)], LAST)
    expect(view).toMatchObject({ week: LAST, goal: { thisWeek: { shipped: 1 }, lastWeek: { shipped: 0 } } })
    expect(person(view, 'dee').shipped.count).toBe(1)
  })
})
