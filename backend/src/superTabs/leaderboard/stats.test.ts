import { describe, expect, it } from 'vitest'
import type { ContributedMachine } from '../machines.js'
import { createSuperTab, type Agent, type Assignment, type Conversation, type SuperTabState, type WorkStatus } from '../model.js'
import type { GroupLedger, Run } from './record.js'
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
function machine(contributorId: string, lent: Array<[week: number, busyMs: number]>, machineId = `mac-${contributorId}`): ContributedMachine {
  return { machineId, name: machineId, contributorId, membershipGeneration: 'g', generation: 'g1', cwd: '/repo', scope: 'swarm', engines: ['claude'],
    maxAgents: 2, paused: false, lent: lent.map(([week, busyMs]) => ({ week, busyMs })) }
}
const board = (state: SuperTabState, groups: Conversation[], week = WEEK, now = NOW, machines = state.machines ?? [], names?: ReadonlyMap<string, string>) =>
  leaderboard({ state, groups, machines, projectId: 'lead', week, now, names })
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

describe('Unblocked: items a person answered, 1 point each plus 1 per 2 hours each waited, at most 3', () => {
  it('weighs each answer by how long it waited', () => {
    const view = board(swarm(), [answered(['tony', WEEK + HOUR, 3 * HOUR], ['tony', WEEK + 2 * HOUR, 90 * 60_000]), answered(['tony', LAST, 10 * HOUR])])
    // 3 hours waited: 1 + 1; 1.5 hours: 1 + 0.
    expect(person(view, 'tony')).toMatchObject({ points: 3, unblocked: { count: 2, agentMs: 4.5 * HOUR, medianAnswerMs: 2.25 * HOUR } })
  })

  it('caps one answer at 3 points, however long it waited', () => {
    expect(person(board(swarm(), [answered(['tony', WEEK + HOUR, 30 * HOUR])]), 'tony').points).toBe(3)
  })

  it('counts approvals and answers in the project\'s Lead conversation, though its work never ships', () => {
    const lead = group({ id: 'lead', ledger: { unblocks: [{ personId: 'ken', at: WEEK + HOUR, waitedMs: 0, kind: 'approval', item: 'm1' }] } })
    expect(person(board(swarm(), [lead]), 'ken')).toMatchObject({ points: 1, unblocked: { count: 1 } })
  })
})

describe('Lent: busy agent-hours run on a person\'s machines for other people\'s work, 1 point per 10', () => {
  it('leaves out the online hours recorded before only busy hours counted', () => {
    const state = swarm()
    state.machines = [{ ...machine('scholes', []), lent: [{ week: WEEK, agentMs: 40 * HOUR }] }]
    expect(person(board(state, []), 'scholes')).toMatchObject({ points: 0, lent: { machines: 0, agentMs: 0 }, details: { lent: [] } })
  })

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

describe('last week\'s points, names and details', () => {
  it('scores the week before the same way, for the arrow against last week', () => {
    const view = board(swarm(), [shipped('dee', LAST, LAST + HOUR), answered(['dee', LAST + HOUR, 3 * HOUR]), shipped('dee', WEEK, WEEK + HOUR)])
    expect(person(view, 'dee')).toMatchObject({ points: 3, prevWeekPoints: 5 })
  })

  it('names each person by their profile name, else their email\'s local part', () => {
    const view = board(swarm(), [], WEEK, NOW, [], new Map([['dee', 'Dee Tran'], ['tony', '   ']]))
    expect(['dee', 'tony', 'ken'].map(id => person(view, id).displayName)).toEqual(['Dee Tran', 'tony', 'ken'])
  })

  it('lists the week\'s shipped requests, newest first, with their PR and when they landed', () => {
    const older = shipped('dee', WEEK, WEEK + HOUR, { title: 'Offline edits', pullRequestUrls: ['https://github.com/o/r/pull/1', 'https://github.com/o/r/pull/2'] })
    const newer = shipped('dee', WEEK, WEEK + 2 * HOUR, { title: 'Dark mode' })
    const view = board(swarm(), [older, newer, shipped('dee', LAST, LAST + HOUR)])
    expect(person(view, 'dee').details.shipped).toEqual([
      { title: 'Dark mode', prUrl: 'https://github.com/o/r/pull/1', mergedAt: WEEK + 2 * HOUR },
      { title: 'Offline edits', prUrl: 'https://github.com/o/r/pull/2', mergedAt: WEEK + HOUR }])
  })

  it('lists the week\'s unblocks, newest first, with their kind and how long each waited', () => {
    const asked = group({ title: 'Plan', ledger: { unblocks: [{ personId: 'ken', at: WEEK + 2 * HOUR, waitedMs: 90 * 60_000, kind: 'approval', item: 'm' },
      { personId: 'ken', at: LAST, waitedMs: 0, kind: 'decision', item: 'd' }] } })
    // An answer recorded before kinds were kept was an answer to waiting work.
    const old = group({ title: 'Flag', ledger: { unblocks: [{ personId: 'ken', at: WEEK + HOUR, waitedMs: 20_000 }] } })
    expect(person(board(swarm(), [asked, old]), 'ken').details.unblocked).toEqual([
      { title: 'Plan', conversationId: asked.id, kind: 'approval', waitedMinutes: 90 },
      { title: 'Flag', conversationId: old.id, kind: 'needs_human', waitedMinutes: 0 }])
  })

  it('lists each machine\'s busy hours this week, busiest first', () => {
    const state = swarm()
    state.machines = [machine('scholes', [[WEEK, 2.25 * HOUR]], 'Studio'), machine('scholes', [[WEEK, 14 * HOUR], [LAST, 5 * HOUR]], 'GPU box'),
      machine('scholes', [[LAST, 5 * HOUR]], 'Laptop')]
    expect(person(board(state, []), 'scholes').details.lent).toEqual([{ machineName: 'GPU box', busyHours: 14 }, { machineName: 'Studio', busyHours: 2.3 }])
  })

  it('keeps each list to the 20 newest', () => {
    const many = Array.from({ length: 25 }, (_, i) => shipped('dee', WEEK, WEEK + i * 60_000, { title: `R${i}` }))
    const answers = answered(...Array.from({ length: 25 }, (_, i): [string, number, number] => ['dee', WEEK + i * 60_000, 0]))
    const { details } = person(board(swarm(), [...many, answers]), 'dee')
    expect(details.shipped.map(s => s.title)).toEqual(Array.from({ length: 20 }, (_, i) => `R${24 - i}`))
    expect(details.unblocked).toHaveLength(20)
  })

  it('shows only what is in the groups the reader may read, never a private conversation\'s', () => {
    const secret = shipped('dee', WEEK, WEEK + HOUR, { title: 'Secret', audience: { people: [{ id: 'dee', generation: 'g' }] } })
    const chat = group({ title: 'Chat', audience: { people: [{ id: 'ken', generation: 'g' }] },
      ledger: { unblocks: [{ personId: 'ken', at: WEEK + HOUR, waitedMs: 0, kind: 'tag_reply', item: 't' }] } })
    expect(JSON.stringify(board(swarm(), [secret, chat]))).not.toMatch(/Secret|Chat/)
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

describe('Models: the share of work on the Swarm\'s grid, and how often it passes its first review', () => {
  const run = (at: number, grid: boolean, firstReview?: boolean) =>
    ({ assignmentId: `r${++n}`, engine: 'claude', model: grid ? 'moonshotai/kimi-k3' : 'opus', ...(grid ? { grid: true as const } : {}), at,
      ...(firstReview === undefined ? {} : { firstReview }) })
  it('counts the week\'s attempts, those on the grid, and first-review passes by kind', () => {
    const view = board(swarm(), [
      group({ status: 'done', ledger: { runs: [run(WEEK + HOUR, true, false), run(WEEK + 2 * HOUR, false, true)] } }),
      group({ status: 'done', ledger: { runs: [run(WEEK + HOUR, true, true), run(LAST + HOUR, true, true)] } }),
      group({ status: 'working', ledger: { runs: [run(WEEK + HOUR, false)] } }),
      // A review group's attempts are reviews, not work.
      group({ status: 'done', reviewOf: 'g0', ledger: { runs: [run(WEEK + HOUR, false, true)] } }),
    ])
    expect(view.models).toEqual({
      thisWeek: { attempts: 4, grid: 2, reviewed: { grid: 2, subscription: 1 }, passedFirst: { grid: 1, subscription: 1 } },
      lastWeek: { attempts: 1, grid: 1, reviewed: { grid: 1, subscription: 0 }, passedFirst: { grid: 1, subscription: 0 } },
    })
  })
})

describe('Models: temporary workers by engine, model and effort, never by agent (Dee, 2026-10-29)', () => {
  /** An attempt on [model] at [at]; `firstReview` when its review is on record. */
  const run = (assignmentId: string, at: number, model = 'opus', effort: string | null = 'high', extra: Partial<Run> = {}): Run =>
    ({ assignmentId, engine: model.startsWith('gpt') ? 'codex' : 'claude', model, ...effort ? { effort } : {}, at, ...extra })
  /** A request shipped at [shippedAt] after [runs]. */
  const landed = (shippedAt: number, runs: Run[], extra: Partial<GroupLedger> = {}) =>
    shipped('dee', runs[0]?.at ?? shippedAt, shippedAt, { ledger: { askedAt: runs[0]?.at ?? shippedAt, shippedAt, runs, ...extra } })
  const model = (view: ReturnType<typeof board>, name: string, effort: string | null = 'high') =>
    view.byModel.find(m => m.model === name && m.effort === effort)!

  it('credits a shipped request to the model of the attempt that shipped it, 3 points, never to earlier attempts', () => {
    const view = board(swarm(), [landed(WEEK + 5 * HOUR, [run('a1', WEEK, 'gpt-5.5', 'medium'), run('a2', WEEK + 2 * HOUR)])])
    expect(model(view, 'opus')).toMatchObject({ engine: 'claude', points: 3, shipped: { count: 1 } })
    expect(model(view, 'gpt-5.5', 'medium')).toMatchObject({ points: 0, shipped: { count: 0 } })
  })

  it('times each shipped request from its shipping attempt and from its first attempt, as medians', () => {
    const view = board(swarm(), [
      landed(WEEK + 5 * HOUR, [run('a1', WEEK), run('a2', WEEK + 4 * HOUR)]),
      landed(WEEK + 3 * HOUR, [run('b1', WEEK + HOUR)]),
      landed(WEEK + 10 * HOUR, [run('c1', WEEK + 2 * HOUR)]),
    ])
    // Attempts: 1, 2 and 8 hours; requests: 5, 2 and 8 hours.
    expect(model(view, 'opus').shipped).toEqual({ count: 3, medianAttemptMs: 2 * HOUR, medianRequestMs: 5 * HOUR })
  })

  it('counts the week\'s attempts with a first review on record, and how many passed it', () => {
    const view = board(swarm(), [group({ status: 'working', ledger: { runs: [
      run('a1', WEEK, 'opus', 'high', { firstReview: true }), run('a2', WEEK + HOUR, 'opus', 'high', { firstReview: false }),
      run('a3', WEEK + 2 * HOUR, 'opus', 'high', { firstReview: true }), run('a4', WEEK + 3 * HOUR),
      run('a5', LAST, 'opus', 'high', { firstReview: true }),
    ] } })])
    expect(model(view, 'opus').firstReview).toEqual({ reviewed: 3, passed: 2 })
  })

  it('gives a reviewer model 1 point per finished review verdict of the week', () => {
    const counted = (week: number, count: number) => ({ week, engine: 'codex', model: 'gpt-5.5', effort: 'medium', count })
    const view = board(swarm(), [group({ status: 'review', ledger: { reviews: [counted(LAST, 1), counted(WEEK, 2)] } }),
      group({ status: 'review', ledger: { reviews: [counted(WEEK, 41)] } })])
    expect(model(view, 'gpt-5.5', 'medium')).toMatchObject({ points: 43, reviews: 43, shipped: { count: 0 } })
  })

  it('credits the model recorded when the request shipped, though its attempts have aged out since (review of #2097)', () => {
    const shippedBy = { assignmentId: 'a1', at: WEEK, engine: 'codex', model: 'gpt-5.5', effort: 'medium' }
    const view = board(swarm(), [landed(WEEK + 2 * HOUR, [], { shippedBy }),
      landed(WEEK + 2 * HOUR, [run('b1', WEEK + 3 * HOUR)], { shippedBy })])
    expect(model(view, 'gpt-5.5', 'medium').shipped).toMatchObject({ count: 2, medianAttemptMs: 2 * HOUR })
    expect(model(view, 'opus').shipped.count).toBe(0)
  })

  it('never times a ship as negative, when it merged before its attempt started (review of #2097)', () => {
    const shippedBy = { assignmentId: 'a1', at: WEEK + 2 * HOUR, engine: 'claude', model: 'opus', effort: 'high' }
    const view = board(swarm(), [landed(WEEK + HOUR, [run('a1', WEEK + 2 * HOUR)], { shippedBy, firstAssignedAt: WEEK + 2 * HOUR })])
    expect(model(view, 'opus').shipped).toMatchObject({ count: 1, medianAttemptMs: 0, medianRequestMs: 0 })
  })

  it('times the whole request from its first assignment, kept after its first attempt rolled off (review of #2097)', () => {
    const view = board(swarm(), [landed(WEEK + 5 * HOUR, [run('a21', WEEK + 4 * HOUR)], { firstAssignedAt: WEEK })])
    expect(model(view, 'opus').shipped).toMatchObject({ medianAttemptMs: HOUR, medianRequestMs: 5 * HOUR })
  })

  it('keeps each effort apart, and attempts recorded before effort was as their own row', () => {
    const view = board(swarm(), [landed(WEEK + HOUR, [run('a1', WEEK, 'opus', 'high')]), landed(WEEK + HOUR, [run('b1', WEEK, 'opus', 'xhigh')]),
      landed(WEEK + HOUR, [run('c1', WEEK, 'opus', null)])])
    expect(view.byModel.map(m => [m.model, m.effort, m.shipped.count])).toEqual([['opus', null, 1], ['opus', 'high', 1], ['opus', 'xhigh', 1]])
  })

  it('ranks models by points, ties sharing a place, and says which ran on the grid', () => {
    const view = board(swarm(), [landed(WEEK + HOUR, [run('a1', WEEK)]), landed(WEEK + HOUR, [run('a2', WEEK)]),
      landed(WEEK + HOUR, [run('b1', WEEK, 'moonshotai/kimi-k3', null, { grid: true })]),
      landed(WEEK + HOUR, [run('c1', WEEK, 'gpt-5.5', null)])])
    expect(view.byModel.map(m => [m.model, m.points, m.rank, m.grid])).toEqual([
      ['opus', 6, 1, false], ['gpt-5.5', 3, 2, false], ['moonshotai/kimi-k3', 3, 2, true]])
  })

  it('counts only requests shipped in the week, and nothing from a private conversation', () => {
    const view = board(swarm(), [landed(LAST + HOUR, [run('a1', LAST)]),
      landed(WEEK + HOUR, [run('b1', WEEK)]),
      { ...landed(WEEK + HOUR, [run('c1', WEEK)]), audience: { people: [{ id: 'dee', generation: 'g' }] } }])
    expect(model(view, 'opus').shipped.count).toBe(1)
  })
})

describe('Agents: the permanent agents, the PM and Buddies, by name like people (Dee, 2026-10-29)', () => {
  /** The project's PM, a Buddy of Dee's, and a builder, in [state]. */
  function agents(state: SuperTabState) {
    const agent = (id: string, extra: Partial<Agent> = {}): Agent => ({ id, projectId: 'lead', machineId: `mac-${id}`, harnessId: `h-${id}`,
      machineOwnerId: 'ken', contributorId: 'ken', membershipGeneration: 'g', name: id, displayName: id[0]!.toUpperCase() + id.slice(1),
      configuration: { engine: 'claude', model: 'opus', effort: 'high', contextWindow: null, engineVersion: null }, ...extra })
    state.agents.push(agent('river'), agent('sparky', { buddyOf: { personId: 'dee', generation: 'g' } }), agent('builder'))
    state.conversations.find(c => c.id === 'lead')!.leadId = 'river'
    return state
  }
  const of = (view: ReturnType<typeof board>, id: string) => view.agents.find(a => a.agentId === id)!

  it('lists the PM and the Buddies, never a builder or reviewer', () => {
    const view = board(agents(swarm()), [])
    expect(view.agents.map(a => [a.agentId, a.displayName, a.kind, a.personId, a.machineId])).toEqual([
      ['river', 'River', 'pm', null, 'mac-river'], ['sparky', 'Sparky', 'buddy', 'dee', 'mac-sparky']])
  })

  it('gives the PM 3 points per request of a group it led that shipped this week', () => {
    const view = board(agents(swarm()), [shipped('dee', WEEK, WEEK + HOUR, { leadId: 'river' }), shipped('ken', WEEK, WEEK + 2 * HOUR, { leadId: 'river' }),
      shipped('dee', LAST, LAST + HOUR, { leadId: 'river' }), shipped('dee', WEEK, WEEK + HOUR, { leadId: 'someone-else' })])
    expect(of(view, 'river')).toMatchObject({ points: 6, shipped: 2, rank: 1 })
  })

  it('credits a group opened from a proposal with no person named as its requester (review of #2097)', () => {
    const run = { assignmentId: 'a1', engine: 'claude', model: 'opus', effort: 'high', at: WEEK }
    const fromProposal = group({ leadId: 'river', status: 'done', pullRequestUrls: ['https://github.com/o/r/pull/1'],
      ledger: { askedAt: WEEK, shippedAt: WEEK + HOUR, runs: [run], proposal: { buddyId: 'sparky', messageId: 'm1' } } })
    const view = board(agents(swarm()), [fromProposal])
    expect(of(view, 'sparky')).toMatchObject({ points: 3, shipped: 1 })
    expect(of(view, 'river')).toMatchObject({ points: 3, shipped: 1 })
    expect(view.byModel.find(m => m.model === 'opus')!.shipped.count).toBe(1)
    // A person's points still need them to have asked.
    expect(view.people.every(p => p.shipped.count === 0)).toBe(true)
  })

  it('credits the PM who led the group when it shipped, not whoever leads it now (review of #2097)', () => {
    const ledger = (shippedLeadId: string | null) => ({ askedAt: WEEK, shippedAt: WEEK + HOUR, shippedLeadId })
    const view = board(agents(swarm()), [
      shipped('dee', WEEK, WEEK + HOUR, { leadId: 'someone-else', ledger: ledger('river') }),
      shipped('dee', WEEK, WEEK + HOUR, { leadId: null, ledger: ledger('river') }),
      // Led by nobody when it shipped: nobody's credit, though River leads it now.
      shipped('dee', WEEK, WEEK + HOUR, { leadId: 'river', ledger: ledger(null) }),
    ])
    expect(of(view, 'river')).toMatchObject({ points: 6, shipped: 2 })
  })

  it('gives a Buddy 3 points per group opened from its proposal that shipped this week', () => {
    const fromProposal = { askedAt: WEEK, shippedAt: WEEK + HOUR, proposal: { buddyId: 'sparky', messageId: 'm1' } }
    const view = board(agents(swarm()), [shipped('dee', WEEK, WEEK + HOUR, { ledger: fromProposal }), shipped('dee', WEEK, WEEK + HOUR)])
    expect(of(view, 'sparky')).toMatchObject({ points: 3, shipped: 1 })
    expect(of(view, 'river')).toMatchObject({ points: 0, shipped: 0, rank: 2 })
  })
})
