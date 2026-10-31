// cli/src/superTabs/windowPull.spec.ts
import { describe, expect, it } from 'vitest'
import { choose, decide, recordOf, type Assessment, type Catalog, type Commitment, type Fit, type Probe, type RoutePlugin } from './route.js'
import { makePlugins, ROUTE_PLUGIN_MAKERS, type PluginInput } from './routePlugins.js'
import { MAX_DISCOUNT, pendingPicks, PENDING_MS, WINDOW_PULL, windowPull, windowPullAdjust, windowPullMaker, weeklyUnused } from './windowPull.js'

/** Today's rows (route.spec.ts): Opus high and Codex default both strength 3, Codex cheaper; Sonnet weaker. */
const policy: Catalog = { grid: { strength: 1, models: [] }, models: [
  { engine: 'claude', model: 'opus', effort: 'high', strength: 3, cost: 3, offered: true },
  { engine: 'codex', model: 'default', effort: 'default', strength: 3, cost: 2, offered: true },
  { engine: 'claude', model: 'sonnet', effort: 'medium', strength: 2, cost: 2, offered: true },
] }
const NOW = 1_800_000_000_000, M = 60_000, H = 3_600_000, D = 86_400_000
const a = (patch: Partial<Assessment> = {}): Assessment => ({ difficulty: 'medium', risk: 'low', size: 'medium', why: 'API change.', needs: { tools: [], devices: [] }, ...patch })
/** A reading with a 5-hour and a weekly window, each as [percent left, resets in]. */
type Win = [left: number, resetsIn: number | null] | null
const windows = (five: Win, week: Win, account: string): Probe['quota'] => {
  const read = ([['5-hour', five], ['weekly', week]] as const).flatMap(([name, w]) => w ? [{ name, leftPercent: w[0], resetsAt: w[1] === null ? null : NOW + w[1] }] : [])
  return { known: true, leftPercent: Math.min(...read.map(w => w.leftPercent)), resetsAt: null, windows: read, account }
}
/** Fresh: a weekly window far from its reset. Soon: resets in 12 hours with 60% left, of which this week's pace (40% used over
 *  156 hours) would spend about 3%, so about 57% would go unused. */
const FRESH = windows([80, 3 * H], [90, 5 * D], 'acct-fresh'), SOON = windows([80, 3 * H], [60, 12 * H], 'acct-soon')
const codex = (machine: string, quota: Probe['quota'], patch: Partial<Probe> = {}): Probe => ({ kind: 'new', machineId: machine, machineName: machine,
  engine: 'codex', model: 'default', effort: 'default', quality: 3, cost: 2, quota, activity: 'new agent', known: true, refusals: [], notes: [], ...patch })
const opusMember = (machine: string, quota: Probe['quota']): Probe => ({ ...codex(machine, quota), kind: 'member', agentId: 'agent-1', name: 'Orion',
  engine: 'claude', model: 'opus', effort: 'high', cost: 3, activity: 'idle', frame: null })
const ok = (r: ReturnType<typeof choose>) => { if ('error' in r) throw new Error('no candidate'); return r }
const route = (probes: Probe[], plugins: RoutePlugin[], open: Commitment[] = [], task: Partial<Assessment> = {}) => ok(choose(probes, policy, a(task), NOW, open, [], [], plugins))
const pull = windowPull([])
const noteOf = (p: { notes: string[] }) => p.notes.find(n => n.startsWith(`${WINDOW_PULL}:`))
/** A candidate as the plug-in sees it, after the route's fit. */
const fitted = (p: Probe, fit: Partial<Fit> = {}): Probe & { fit: Fit } => ({ ...p, fit: { status: 'fits', coverage: 1, effectiveCost: p.cost, expiring: 0,
  spend: { '5-hour': 30, weekly: 4 }, account: p.quota.account ?? '', ...fit } })

describe('the window pull ranks', () => {
  it('an account whose weekly window resets soon with quota left first, and says why', () => {
    const probes = [codex('alpha', FRESH), codex('zulu', SOON)]
    // Without it, the two tie on strength, price and fit, and the title decides.
    expect(route(probes, []).shown.map(s => s.machineId)).toEqual(['alpha', 'zulu'])
    const choice = route(probes, [pull])
    expect(choice.shown.map(s => s.machineId)).toEqual(['zulu', 'alpha'])
    const reason = 'Window pull: its account\'s weekly window resets in 12h, and at this week\'s pace about 57% of it would go unused; this task spends it first'
    expect(choice.shown[0]!.notes).toContain(reason)
    expect(choice.shown[0]!.label).toContain(reason)
    expect(noteOf(choice.shown[1]!)).toBeUndefined()
    const verdict = decide(choice)
    expect(verdict.pick.machineId).toBe('zulu')
    expect(verdict.why).toContain('plug-ins')
    expect(JSON.stringify(recordOf(choice, verdict, a()))).toContain(reason)
    // What the candidate is shown and recorded as stays as measured.
    expect(choice.shown[0]!.fit.effectiveCost).toBe(2)
  })
  it('an idle agent on such an account over a cheaper new agent: it pulls the queued task', () => {
    const probes = [codex('alpha', FRESH), opusMember('zulu', SOON)]
    // Codex is cheaper than Opus at the same strength.
    expect(route(probes, []).shown[0]!.kind).toBe('new')
    const choice = route(probes, [pull])
    expect(choice.shown[0]).toMatchObject({ kind: 'member', agentId: 'agent-1' })
    expect(noteOf(choice.shown[0]!)).toMatch(/this idle agent takes queued work first$/)
  })
  it('never above a stronger model', () => {
    const sonnet = codex('zulu', SOON, { engine: 'claude', model: 'sonnet', effort: 'medium', quality: 2 })
    const choice = route([codex('alpha', FRESH), sonnet], [pull])
    expect(choice.shown.map(s => s.model)).toEqual(['default', 'sonnet'])
    expect(noteOf(choice.shown[1]!)).toBeDefined()
  })
  it('makes a choice at most half as costly, never free, so a clearly better record still wins (pieces 3 and 6 together)', () => {
    // At most half, however much would go unused.
    expect(windowPullAdjust(fitted(codex('zulu', SOON)), NOW, [])?.cost).toBe(-2 * MAX_DISCOUNT)
    expect(windowPullAdjust(fitted(codex('zulu', SOON), { effectiveCost: 1.2 }), NOW, [])?.cost).toBe(-0.6)
    // A stand-in for piece 3's measured plug-in until it merges: a first-review record worth more than half the price.
    const measured: RoutePlugin = { name: 'Measured', adjust: c => c.machineId === 'alpha' ? { cost: -1.2, reason: 'passed first review on 9 of its last 10 builds' } : null }
    const probes = [codex('alpha', FRESH), codex('zulu', SOON)]
    expect(route(probes, [pull]).shown[0]!.machineId).toBe('zulu')
    for (const plugins of [[measured, pull], [pull, measured]]) {
      const choice = route(probes, plugins)
      expect(choice.shown.map(s => s.machineId)).toEqual(['alpha', 'zulu'])
      expect(noteOf(choice.shown[1]!)).toBeDefined()
    }
  })
  it('takes off only the part of the task the window would leave unused', () => {
    // 16% left a day before the reset, at a pace of 84% over six days: about 2% unused, half the task's 4%.
    const thin = codex('zulu', windows([80, 3 * H], [16, 24 * H], 'acct-soon'))
    expect(weeklyUnused(thin, NOW, [])?.unused).toBeCloseTo(2)
    expect(windowPullAdjust(fitted(thin), NOW, [])?.cost).toBe(-0.5)
  })
})

describe('the window pull leaves alone', () => {
  const none = (p: Probe, fit: Partial<Fit> = {}, open: Commitment[] = []) => expect(windowPullAdjust(fitted(p, fit), NOW, open)).toBeNull()
  it('a candidate whose quota would run out partway, as the route\'s fit says', () => {
    const short = codex('zulu', windows([5, 3 * H], [60, 12 * H], 'acct-soon'))
    const choice = route([codex('alpha', FRESH), short], [pull])
    expect(choice.shown.find(s => s.machineId === 'zulu')!.fit.status).toBe('short')
    expect(choice.shown.every(s => !noteOf(s))).toBe(true)
    expect(choice.shown[0]!.machineId).toBe('alpha')
  })
  it('a reading that says nothing of a weekly window about to reset', () => {
    none(codex('zulu', { known: false, leftPercent: null, resetsAt: null, account: 'acct-soon' }))
    none(codex('zulu', { known: true, leftPercent: null, resetsAt: null, metered: true }))
    none(codex('zulu', SOON, { gridModel: 'kimi-k3', gridName: 'grid' }))
    none(codex('zulu', { known: true, leftPercent: 60, resetsAt: null, account: 'acct-soon' }))
    none(codex('zulu', windows([80, 3 * H], null, 'acct-soon')))
    none(codex('zulu', windows([80, 3 * H], [60, null], 'acct-soon')))
    // A reset already past is a reading from before the window refilled.
    none(codex('zulu', windows([80, 3 * H], [60, -M], 'acct-soon')))
    none(codex('zulu', windows([80, 3 * H], [60, 0], 'acct-soon')))
    // More than two days away: this week's pace says too little yet.
    none(codex('zulu', windows([80, 3 * H], [90, 49 * H], 'acct-soon')))
  })
  it('an account whose pace this week would use what is left', () => {
    // 10% left a day before the reset, after 90% in six days.
    none(codex('zulu', windows([80, 3 * H], [10, 24 * H], 'acct-soon')))
    // Under 1% unused is no reason to move work.
    none(codex('zulu', windows([80, 3 * H], [15, 24 * H], 'acct-soon')))
  })
  it('a task that spends nothing of the week, or a candidate already free', () => {
    none(codex('zulu', SOON), { spend: { '5-hour': 0, weekly: 0 } })
    none(codex('zulu', SOON), { effectiveCost: 0 })
  })
  it('a window the picks still at work on that account already fill, but not one whose picks are over or elsewhere', () => {
    const thin = codex('zulu', windows([80, 3 * H], [16, 24 * H], 'acct-soon'))
    const held = (patch: Partial<Commitment>): Commitment => ({ account: 'acct-soon', spend: { weekly: 4 }, size: 'medium', createdAt: NOW - M, ...patch })
    none(thin, {}, [held({})])
    expect(windowPullAdjust(fitted(thin), NOW, [held({ createdAt: NOW - 2 * H })])).not.toBeNull()
    expect(windowPullAdjust(fitted(thin), NOW, [held({ account: 'acct-fresh' })])).not.toBeNull()
    expect(windowPullAdjust(fitted(thin), NOW, [held({ spend: { '5-hour': 30 } })])).not.toBeNull()
    // Through the route: its context's picks at work count.
    const choice = route([codex('alpha', FRESH), thin], [pull], [held({})])
    expect(choice.shown.every(s => !noteOf(s))).toBe(true)
  })
})

describe('the window pull\'s reason', () => {
  it('names the window, never the account or the machine a reading was relayed from', () => {
    const relayed = codex('zulu', { ...windows([80, 3 * H], [60, 40 * M], 'acct-7f3a9c'), from: 'Ken\'s MacBook Pro' })
    const reason = windowPullAdjust(fitted(relayed), NOW, [])!.reason
    expect(reason).toContain('resets in 40m')
    expect(reason).not.toMatch(/acct|7f3a9c|Ken|MacBook/)
  })
})

describe('picks not started yet, from the route history', () => {
  const pick = (patch: Record<string, unknown> = {}) => ({ id: 'd1', conversationId: 'other', account: 'acct-soon', spend: { '5-hour': 30, weekly: 4 }, size: 'medium',
    outcome: null, final: null, createdAt: new Date(NOW - M).toISOString(), ...patch })
  const history = (decisions: unknown) => ({ ok: true, value: { decisions } })
  it('holds quota for another group\'s pick nobody started yet, as a pick at work does', () => {
    expect(pendingPicks(history([pick()]), 'g1', NOW)).toEqual([{ account: 'acct-soon', size: 'medium', createdAt: NOW - M, spend: { weekly: 4 } }])
  })
  it('leaves out what the route already holds or what holds nothing', () => {
    expect(pendingPicks(history([
      pick({ final: { kind: 'new', engine: 'codex', model: 'default' } }), // started: the route's own picks at work hold it
      pick({ outcome: 'superseded' }), pick({ outcome: 'done' }),
      pick({ conversationId: 'g1' }), // this group's own pick: routing it again supersedes it
      pick({ account: undefined }), pick({ size: 'huge' }), pick({ spend: null }), pick({ spend: 'x' }),
      pick({ createdAt: new Date(NOW - PENDING_MS).toISOString() }), pick({ createdAt: 'never' }), pick({ createdAt: new Date(NOW + 2 * M).toISOString() }),
      null, 'x',
    ]), 'g1', NOW)).toEqual([])
  })
  it('counts a pick the server stamped a little ahead of this clock as just made, and one with no weekly spend as nothing', () => {
    expect(pendingPicks(history([pick({ createdAt: new Date(NOW + 20_000).toISOString() }), pick({ spend: { weekly: 'lots' } })]), 'g1', NOW))
      .toEqual([{ account: 'acct-soon', size: 'medium', createdAt: NOW, spend: { weekly: 4 } }, { account: 'acct-soon', size: 'medium', createdAt: NOW - M, spend: {} }])
  })
  it('is unknown when the history could not be read', () => {
    for (const unread of [null, { ok: false }, { ok: true }, { ok: true, value: 'x' }, { ok: true, value: { decisionsUnreadable: true } }]) {
      expect(pendingPicks(unread as never, 'g1', NOW)).toBeNull()
    }
  })
})

describe('the window pull\'s maker', () => {
  const input = (history: unknown): PluginInput => ({ conversationId: 'g2', assessment: a(), read: {}, catalog: policy, history: Promise.resolve(history as never),
    request: async () => ({ ok: true }) })
  it('is in the route\'s list of makers', () => {
    expect(ROUTE_PLUGIN_MAKERS.map(m => m.name)).toContain(WINDOW_PULL)
  })
  it('two routes a minute apart do not both pull onto one window', async () => {
    // About 2% would go unused, half a medium task: the first route pulls; the second sees that pick, not yet started.
    const thin = windows([80, 3 * H], [16, 24 * H], 'acct-soon')
    const probes = [codex('alpha', FRESH), codex('zulu', thin)]
    const first = await makePlugins([windowPullMaker(() => NOW)], input({ ok: true, value: { decisions: [] } }))
    expect(route(probes, first.plugins).shown[0]!.machineId).toBe('zulu')
    const routed = { id: 'd1', conversationId: 'g1', account: 'acct-soon', spend: { weekly: 4 }, size: 'medium', outcome: null, final: null, createdAt: new Date(NOW - M).toISOString() }
    const second = await makePlugins([windowPullMaker(() => NOW)], input({ ok: true, value: { decisions: [routed] } }))
    const choice = route(probes, second.plugins)
    expect(choice.shown[0]!.machineId).toBe('alpha')
    expect(choice.shown.every(s => !noteOf(s))).toBe(true)
  })
  it('is left out, and the route answer says so, when the history could not be read', async () => {
    expect(await makePlugins([windowPullMaker()], input(null))).toEqual({ plugins: [],
      warnings: ['The routing plug-in "Window pull" was skipped: its maker failed. The route is ranked without it.'] })
  })
})
