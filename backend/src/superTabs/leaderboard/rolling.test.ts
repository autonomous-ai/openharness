import { describe, expect, it } from 'vitest'
import type { ContributedMachine } from '../machines.js'
import { createSuperTab, type Agent, type Check, type Conversation, type SuperTabState } from '../model.js'
import { addLent } from './lent.js'
import { recordVerdict, type GroupLedger } from './record.js'
import { HOUR_MS as HOUR, lentIn, periodSpans, reviewsIn, type PeriodName } from './rolling.js'
import { leaderboard } from './stats.js'
import { DAY_MS as DAY, WEEK_MS as WEEK, weekStart } from './week.js'

// Wednesday 2026-11-25 12:00 UTC.
const NOW = Date.UTC(2026, 10, 25, 12), TODAY = Date.UTC(2026, 10, 25), THIS_WEEK = weekStart(NOW)
const reach = { projects: new Set(['lead']), unsplit: true }
const opus = { engine: 'claude', model: 'opus', effort: 'high' }

function swarm(): SuperTabState {
  const state = createSuperTab('tab', 'Pilot', { id: 'ken', email: 'ken@example.com' }, 'prod')
  state.people.push({ id: 'dee', email: 'dee@example.com', role: 'collaborator', generation: 'g' })
  return state
}
let n = 0
const group = (extra: Partial<Conversation> & { ledger?: GroupLedger } = {}): Conversation => ({ id: `r${++n}`, projectId: 'lead', title: `Group ${n}`, leadId: null,
  agentIds: [], archived: false, brief: '', checks: [], assignment: null, lastMessageSequence: 0, ...extra })
const shipped = (at: number, extra: Partial<Conversation> = {}) => group({ requesterId: 'dee', pullRequestUrls: ['https://github.com/o/r/pull/1'], ledger: { askedAt: at - HOUR, shippedAt: at }, ...extra })
const machine = (extra: Partial<ContributedMachine>): ContributedMachine => ({ machineId: 'mac', name: 'Studio', contributorId: 'dee', membershipGeneration: 'g', generation: 'g1',
  cwd: '/repo', engines: ['claude'], maxAgents: 2, paused: false, ...extra })
const read = (period: PeriodName, groups: Conversation[], machines: ContributedMachine[] = [], now = NOW) =>
  leaderboard({ state: swarm(), groups, machines, projectId: 'lead', week: weekStart(now), now, period })
const dee = (view: ReturnType<typeof read>) => view.people.find(p => p.personId === 'dee')!
const spans = (name: PeriodName) => periodSpans(name, NOW)

describe('the rolling periods', () => {
  it('counts a shipped request by its exact time, in the period and the one before it', () => {
    const groups = [shipped(NOW - 23 * HOUR), shipped(NOW - 25 * HOUR), shipped(NOW - 6 * DAY), shipped(NOW - 8 * DAY), shipped(NOW - 29 * DAY), shipped(NOW - 31 * DAY)]
    expect(read('24h', groups).goal).toMatchObject({ thisWeek: { shipped: 1 }, lastWeek: { shipped: 1 } })
    expect(read('7d', groups).goal).toMatchObject({ thisWeek: { shipped: 3 }, lastWeek: { shipped: 1 } })
    expect(read('30d', groups).goal.thisWeek.shipped).toBe(5)
  })

  it('names the period it summed; a week\'s answer names none', () => {
    expect(read('7d', [])).toMatchObject({ week: THIS_WEEK, period: { name: '7d', start: NOW + 1 - WEEK, end: NOW } })
    expect(leaderboard({ state: swarm(), groups: [], machines: [], projectId: 'lead', week: THIS_WEEK, now: NOW })).not.toHaveProperty('period')
  })

  it('has no comparison for Last 30d: nothing says 0 when nothing was read', () => {
    const view = read('30d', [shipped(NOW - DAY)])
    expect(view.goal.lastWeek).toBeNull()
    expect(view.models.lastWeek).toBeNull()
    expect(dee(view).prevWeekPoints).toBeNull()
  })

  it('scores points, details, agents and models over the same period', () => {
    const answers = group({ ledger: { unblocks: [{ personId: 'dee', at: NOW - HOUR, waitedMs: 0, kind: 'decision' }, { personId: 'dee', at: NOW - 3 * DAY, waitedMs: 0, kind: 'decision' }] } })
    const ran = shipped(NOW - HOUR, { ledger: { askedAt: NOW - 2 * HOUR, shippedAt: NOW - HOUR, runs: [{ assignmentId: 'a', at: NOW - 2 * HOUR, ...opus }] } })
    const view = read('24h', [answers, ran, shipped(NOW - 3 * DAY)])
    expect(dee(view)).toMatchObject({ points: 4, prevWeekPoints: 0, shipped: { count: 1 }, unblocked: { count: 1 } })
    expect(dee(view).details.shipped).toHaveLength(1)
    expect(view.byModel).toMatchObject([{ model: 'opus', shipped: { count: 1 }, attempts: 1 }])
    expect(dee(read('7d', [answers, ran, shipped(NOW - 3 * DAY)]))).toMatchObject({ points: 8, shipped: { count: 2 }, unblocked: { count: 2 } })
  })

  it('never counts a private conversation or a machine it was not handed', () => {
    const hidden = shipped(NOW - HOUR, { audience: { people: [{ id: 'dee', generation: 'g' }] }, ledger: { askedAt: 0, shippedAt: NOW - HOUR,
      reviewHours: [{ hour: TODAY, ...opus, count: 9 }] } })
    const view = read('7d', [hidden])
    expect(dee(view).shipped.count).toBe(0)
    expect(view.byModel).toEqual([])
    expect(JSON.stringify(view)).not.toContain(hidden.title)
  })
})

describe('All projects', () => {
  const twoProjects = () => {
    const state = swarm()
    state.projects!.push({ ...state.projects![0]!, id: 'other', leadConversationId: 'other-lead', name: 'Other' }, { ...state.projects![0]!, id: 'secret', leadConversationId: 'secret-lead', name: 'Secret' })
    return state
  }
  const here = shipped(NOW - HOUR), there = shipped(NOW - 2 * HOUR, { projectId: 'other', title: 'Over there' }), tucked = shipped(NOW - 3 * HOUR, { projectId: 'secret', title: 'Tucked away' })
  const all = (projects: string[], groups: Conversation[]) => leaderboard({ state: twoProjects(), groups, machines: [], projectId: 'lead', week: THIS_WEEK, now: NOW, period: '7d', allProjects: projects })

  it('sums every project it is given, one project\'s board only its own', () => {
    const groups = [here, there]
    const view = all(['lead', 'other'], groups)
    expect(view.allProjects).toBe(true)
    expect(view.goal.thisWeek.shipped).toBe(2)
    expect(dee(view)).toMatchObject({ points: 6, shipped: { count: 2 } })
    const one = leaderboard({ state: twoProjects(), groups, machines: [], projectId: 'lead', week: THIS_WEEK, now: NOW, period: '7d' })
    expect(one).not.toHaveProperty('allProjects')
    expect(dee(one)).toMatchObject({ points: 3, shipped: { count: 1 } })
  })

  it('lists a person\'s one Buddy once across the projects summed, and only if they read one of them', () => {
    const state = twoProjects()
    state.projects![0]!.visibility = 'private'
    state.projects![1]!.visibility = 'private'
    state.projects![2]!.visibility = 'private'
    state.projects![1]!.members = [{ id: 'dee', generation: 'g' }]
    state.projects![2]!.members = [{ id: 'dee', generation: 'g' }]
    state.agents.push({ id: 'dee-buddy', machineId: 'mac', harnessId: 'h-b', machineOwnerId: 'dee', contributorId: 'dee', membershipGeneration: 'g', name: 'Dee Buddy',
      configuration: { engine: 'claude', model: 'opus', effort: 'high', contextWindow: null, engineVersion: null }, buddyOf: { personId: 'dee', generation: 'g' }, buddyScope: 'swarm' } as unknown as Agent)
    const reading = (projects: string[]) => leaderboard({ state, groups: [], machines: [], projectId: 'lead', week: THIS_WEEK, now: NOW, period: '7d', allProjects: projects }).agents
    expect(reading(['lead', 'other', 'secret']).filter(a => a.agentId === 'dee-buddy')).toHaveLength(1)
    expect(reading(['lead']).filter(a => a.agentId === 'dee-buddy')).toEqual([])
  })

  it('counts nothing of a project the reader may not read, though its group is at hand', () => {
    const view = all(['lead', 'other'], [here, there, tucked])
    expect(dee(view).shipped.count).toBe(2)
    expect(JSON.stringify(view)).not.toContain('Tucked away')
  })

  it('keeps the sidebar\'s recent models to the open project', () => {
    const run = (projectId: string, model: string) => group({ projectId, ledger: { runs: [{ assignmentId: `a-${model}`, at: NOW - HOUR, engine: 'claude', model }] } })
    const view = all(['lead', 'other'], [run('lead', 'opus'), run('other', 'sonnet')])
    expect(view.recentModels.map(m => m.model)).toEqual(['opus'])
    expect(view.byModel.map(m => m.model).sort()).toEqual(['opus', 'sonnet'])
  })
})

describe('Lent in a rolling period', () => {
  it('shares a day out over the part of it that has passed, so the periods add up', () => {
    const pool = { lentDays: [{ day: TODAY, projectId: 'lead', busyMs: 6 * HOUR }, { day: TODAY - DAY, projectId: 'lead', busyMs: 12 * HOUR }, { day: TODAY - 2 * DAY, projectId: 'lead', busyMs: 24 * HOUR }] }
    // Now is noon: all of today, the second half of yesterday.
    expect(Math.round(lentIn(pool, spans('24h').current, NOW, reach) / HOUR)).toBe(12)
    expect(Math.round(lentIn(pool, spans('24h').previous!, NOW, reach) / HOUR)).toBe(18)
    expect(lentIn(pool, spans('7d').current, NOW, reach)).toBe(42 * HOUR)
  })

  it('reads days only for a period and weeks only for a week', () => {
    const pool = { lent: [{ week: THIS_WEEK, busyMs: 10 * HOUR }], lentDays: [{ day: TODAY, projectId: 'lead', busyMs: 10 * HOUR }] }
    expect(lentIn(pool, { start: THIS_WEEK, end: THIS_WEEK + WEEK, rolling: false }, NOW, reach)).toBe(10 * HOUR)
    expect(lentIn(pool, spans('7d').current, NOW, reach)).toBe(10 * HOUR)
  })

  it('counts a week recorded before the days once, at its end, and only what its days do not hold', () => {
    // Wednesday 2026-11-04, reading the week before the finer rows began.
    const now = Date.UTC(2026, 10, 4, 12), last = Date.UTC(2026, 9, 26), at = (name: PeriodName) => periodSpans(name, now).current
    const pool = { lent: [{ week: last, busyMs: 10 * HOUR }], lentDays: [{ day: last + 6 * DAY, projectId: 'lead', busyMs: 4 * HOUR }] }
    expect(lentIn(pool, at('30d'), now, reach)).toBe(10 * HOUR)
    // The unsplit 6 hours fall in the middle of that week: in Last 7d, with the day's row, and no lump in Last 24h.
    expect(lentIn(pool, at('7d'), now, reach)).toBe(10 * HOUR)
    expect(lentIn(pool, at('24h'), now, reach)).toBe(0)
  })

  it('reads the same however many times it is asked, and writes nothing', () => {
    const pool = machine({ lent: [{ week: THIS_WEEK - WEEK, busyMs: 22 * HOUR }], lentDays: [] })
    const before = structuredClone(pool)
    const first = read('30d', [], [pool]), second = read('30d', [], [pool])
    expect(dee(first).lent.agentMs).toBe(22 * HOUR)
    expect(dee(second)).toEqual(dee(first))
    expect(pool).toEqual(before)
  })

  it('ignores a week\'s old online hours, as the weekly read does', () => {
    expect(lentIn({ lent: [{ week: THIS_WEEK - WEEK, agentMs: 40 * HOUR }] }, spans('30d').current, NOW, reach)).toBe(0)
  })

  it('scores a machine by the period', () => {
    const pool = machine({ lentDays: [{ day: TODAY, projectId: 'lead', busyMs: 20 * HOUR }, { day: TODAY - 10 * DAY, projectId: 'lead', busyMs: 30 * HOUR }] })
    expect(dee(read('7d', [], [pool]))).toMatchObject({ points: 2, lent: { machines: 1, agentMs: 20 * HOUR }, details: { lent: [{ machineName: 'Studio', busyHours: 20 }] } })
    expect(dee(read('30d', [], [pool]))).toMatchObject({ points: 5, lent: { agentMs: 50 * HOUR } })
  })
})

describe('Lent of a project out of reach (review of #2499)', () => {
  const secret = { day: TODAY, projectId: 'secret', busyMs: 20 * HOUR }, mine = { day: TODAY, projectId: 'lead', busyMs: 10 * HOUR }

  it('adds nothing to All projects or a project\'s board, only what those projects earned', () => {
    const pool = machine({ lentDays: [secret, mine] })
    expect(dee(read('7d', [], [pool]))).toMatchObject({ points: 1, lent: { agentMs: 10 * HOUR } })
    const all = (projects: string[]) => leaderboard({ state: swarm(), groups: [], machines: [pool], projectId: 'lead', week: THIS_WEEK, now: NOW, period: '7d', allProjects: projects })
    expect(dee(all(['lead'])).lent.agentMs).toBe(10 * HOUR)
    const asOwner = swarm()
    asOwner.projects!.push({ ...asOwner.projects![0]!, id: 'secret', leadConversationId: 'secret-lead' })
    expect(dee(leaderboard({ state: asOwner, groups: [], machines: [pool], projectId: 'lead', week: THIS_WEEK, now: NOW, period: '7d', allProjects: ['lead', 'secret'] })).lent.agentMs).toBe(30 * HOUR)
  })

  it('never comes back as unsplit weekly time', () => {
    const pool = { lent: [{ week: weekStart(TODAY), busyMs: 30 * HOUR }], lentDays: [secret, mine] }
    expect(lentIn(pool, spans('7d').current, NOW, reach)).toBe(10 * HOUR)
  })

  it('leaves a weekly row, which names no project, out for someone no board of the reader shows', () => {
    const state = swarm(), last = Date.UTC(2026, 9, 26), now = Date.UTC(2026, 10, 2, 12)
    state.projects![0]!.visibility = 'private'
    state.projects!.push({ ...state.projects![0]!, id: 'secret', leadConversationId: 'secret-lead', members: [{ id: 'dee', generation: 'g' }] })
    const pool = machine({ lent: [{ week: last, busyMs: 20 * HOUR }] })
    const asRead = (projects: string[]) => leaderboard({ state, groups: [], machines: [pool], projectId: 'lead', week: weekStart(now), now, period: '30d', allProjects: projects })
    expect(dee(asRead(['lead']))).toMatchObject({ points: 0, lent: { machines: 0, agentMs: 0 } })
    expect(dee(asRead(['lead', 'secret'])).lent.agentMs).toBe(20 * HOUR)
  })
})

describe('the week finer rows began', () => {
  it('leaves a week\'s unsplit part on the first day, so it never stays in Last 24h until Sunday', () => {
    // Thursday of the week of 2026-11-02, with Monday's and Tuesday's work recorded by week only.
    const now = Date.UTC(2026, 10, 5, 12), week = Date.UTC(2026, 10, 2)
    const pool = { lent: [{ week, busyMs: 8 * HOUR }] }, ledger = { reviews: [{ week, ...opus, count: 3 }] }
    expect(lentIn(pool, periodSpans('24h', now).current, now, reach)).toBe(0)
    expect(lentIn(pool, periodSpans('7d', now).current, now, reach)).toBe(8 * HOUR)
    expect(reviewsIn(ledger, periodSpans('24h', now).current)).toEqual([])
    expect(reviewsIn(ledger, periodSpans('7d', now).current)).toMatchObject([{ count: 3 }])
  })
})

describe('a week that just ended', () => {
  it('is no lump in Last 24h: read on the Monday after, its unsplit part sits mid-week', () => {
    const now = Date.UTC(2026, 10, 2, 6), last = Date.UTC(2026, 9, 26)
    const pool = { lent: [{ week: last, busyMs: 30 * HOUR }] }
    expect(lentIn(pool, periodSpans('24h', now).current, now, reach)).toBe(0)
    expect(lentIn(pool, periodSpans('7d', now).current, now, reach)).toBe(30 * HOUR)
  })
})

describe('review verdicts in a rolling period', () => {
  it('counts each hour\'s verdicts in the one period that holds them', () => {
    const ledger = { reviewHours: [{ hour: NOW - HOUR, ...opus, count: 2 }, { hour: NOW - 30 * HOUR, ...opus, count: 5 }] }
    expect(reviewsIn(ledger, spans('24h').current)).toMatchObject([{ count: 2 }])
    expect(reviewsIn(ledger, spans('24h').previous!)).toMatchObject([{ count: 5 }])
    expect(read('24h', [group({ ledger })]).byModel).toMatchObject([{ model: 'opus', reviews: 2, points: 2 }])
  })

  it('counts a week recorded before the hours once, per model, without what the hours hold', () => {
    const week = THIS_WEEK - WEEK, sonnet = { ...opus, model: 'sonnet' }
    const ledger = { reviews: [{ week, ...opus, count: 3 }, { week, ...sonnet, count: 1 }], reviewHours: [{ hour: week + DAY, ...opus, count: 3 }, { hour: week + DAY, ...sonnet, count: 0 }] }
    const rows = reviewsIn(ledger, spans('30d').current)
    expect(rows.filter(r => r.model === 'opus').reduce((sum, r) => sum + r.count, 0)).toBe(3)
    expect(rows.filter(r => r.model === 'sonnet').reduce((sum, r) => sum + r.count, 0)).toBe(1)
  })

  it('reads a week by its weekly rows alone', () => {
    const ledger = { reviews: [{ week: THIS_WEEK, ...opus, count: 3 }], reviewHours: [{ hour: NOW - HOUR, ...opus, count: 3 }] }
    expect(reviewsIn(ledger, { start: THIS_WEEK, end: THIS_WEEK + WEEK, rolling: false })).toMatchObject([{ count: 3 }])
  })
})

describe('what a verdict writes', () => {
  const check = { id: 'c1', description: 'Passes', status: 'pending' } as unknown as Check
  const reviewer = { id: 'rev', harnessId: 'h-rev', machineId: 'mac', configuration: { engine: 'claude', model: 'opus', effort: 'high', contextWindow: null, engineVersion: null } } as unknown as Agent
  const reviewed = () => group({ assignment: { id: 'a', agentId: 'worker' } as Conversation['assignment'], ledger: { runs: [{ assignmentId: 'a', at: NOW - DAY, engine: 'claude', model: 'opus' }] } })

  it('counts it in its week and its hour, one row per hour and model', () => {
    const g = reviewed()
    recordVerdict(swarm(), g, check, reviewer, NOW + 1, true)
    recordVerdict(swarm(), g, check, reviewer, NOW + 2, true)
    expect(g.ledger!.reviews).toEqual([{ week: THIS_WEEK, ...opus, count: 2 }])
    expect(g.ledger!.reviewHours).toEqual([{ hour: NOW, ...opus, count: 2 }])
  })

  it('lets go of hours older than the weeks kept', () => {
    const g = reviewed()
    g.ledger!.reviewHours = [{ hour: NOW - 36 * DAY, ...opus, count: 7 }, { hour: NOW - 34 * DAY, ...opus, count: 1 }]
    recordVerdict(swarm(), g, check, reviewer, NOW, true)
    expect(g.ledger!.reviewHours.map(r => r.hour)).toEqual([NOW - 34 * DAY, NOW])
  })

  it('keeps an assignee\'s own verdict out of both', () => {
    const g = reviewed()
    recordVerdict(swarm(), g, check, { ...reviewer, id: 'worker' }, NOW, true)
    expect(g.ledger).not.toHaveProperty('reviewHours')
  })
})

describe('what readings write', () => {
  const pool = () => machine({ observation: { receivedAt: NOW - 10_000 } as ContributedMachine['observation'] })

  it('adds a reading to its week and its day', () => {
    const m = pool()
    addLent(m, NOW, 2, { lead: 1, other: 1 })
    addLent(m, NOW, 0)
    expect(m.lent).toEqual([{ week: THIS_WEEK, busyMs: 20_000 }])
    expect(m.lentDays).toEqual([{ day: TODAY, projectId: 'lead', busyMs: 10_000 }, { day: TODAY, projectId: 'other', busyMs: 10_000 }])
  })

  it('keeps a machine\'s days bounded, and every day Last 30d can ask for', () => {
    const m = pool()
    m.lentDays = Array.from({ length: 60 }, (_, back) => ({ day: TODAY - back * DAY, projectId: 'lead', busyMs: 1 }))
    addLent(m, NOW, 1, { lead: 1 })
    expect(m.lentDays.length).toBeLessThanOrEqual(35)
    expect(Math.min(...m.lentDays.map(d => d.day))).toBeLessThanOrEqual(NOW - 30 * DAY)
    expect(m.lentDays.find(d => d.day === TODAY)!.busyMs).toBe(10_001)
  })

  it('never counts a day and its week twice', () => {
    const m = pool()
    addLent(m, NOW, 1, { lead: 1 })
    expect(lentIn(m, spans('7d').current, NOW, reach)).toBe(10_000)
    expect(lentIn(m, spans('30d').current, NOW, reach)).toBe(10_000)
  })
})
