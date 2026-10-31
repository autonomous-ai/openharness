// cli/src/superTabs/routeMeasured.spec.ts
import { describe, expect, it } from 'vitest'
import { choose, type Assessment, type Catalog, type Probe } from './route.js'
import { MEASURED, MEASURED_MAKER, measuredFrom, measuredPlugin, readMeasured, type MeasuredRow } from './routeMeasured.js'
import { ROUTE_PLUGIN_MAKERS, type PluginInput } from './routePlugins.js'

/** Today's strong rows (backend superTabs/catalog.ts): at equal strength Codex's cost 2 ranks before Opus's 3. */
const catalog: Catalog = { grid: { strength: 1, models: [{ model: 'kimi k3', strength: 2 }] }, models: [
  { engine: 'claude', model: 'opus', effort: 'high', strength: 3, cost: 3, offered: true },
  { engine: 'claude', model: 'opus', effort: 'xhigh', strength: 3, cost: 4, offered: true },
  { engine: 'codex', model: 'gpt-6.1-sol', effort: 'high', strength: 3, cost: 2, offered: true },
  { engine: 'claude', model: 'sonnet', effort: 'medium', strength: 2, cost: 2, offered: true },
] }
const NOW = 1_000_000_000
const task = (patch: Partial<Assessment> = {}): Assessment => ({ difficulty: 'medium', risk: 'low', size: 'small', why: 'Parser fix.', kind: 'build',
  needs: { tools: [], devices: [] }, ...patch })
const probe = (patch: Partial<Probe> = {}): Probe => ({ kind: 'new', machineId: 'm1', machineName: 'mac-1', engine: 'claude', model: 'opus', effort: 'high',
  quality: 3, cost: 3, quota: { known: true, leftPercent: null, resetsAt: null, metered: true }, activity: 'new', known: true, refusals: [], notes: [], ...patch })
const opus = probe(), codex = probe({ machineId: 'm2', machineName: 'mac-2', engine: 'codex', model: 'gpt-6.1-sol', effort: 'high', cost: 2 })
const row = (patch: Partial<MeasuredRow>): MeasuredRow => ({ engine: 'claude', model: 'opus', effort: 'high', kind: 'build', firstReviews: 10, firstReviewPassed: 9,
  shipped: 10, costPerShipped: 5, fullCostPerShipped: 6, ...patch })
/** Opus passes 9 of 10 first reviews; Codex 6 of 10. Codex's own attempts are cheaper per shipped change ($3 against $5), but
 *  its failed reviews take rework rounds and their reviews: in full it costs $9 against Opus's $6. */
const measured = [row({}), row({ engine: 'codex', model: 'gpt-6.1-sol', firstReviewPassed: 6, costPerShipped: 3, fullCostPerShipped: 9 })]
const route = (rows: MeasuredRow[], probes: Probe[] = [opus, codex], a: Assessment = task(), truncated = false) => {
  const choice = choose(probes, catalog, a, NOW, [], [], [], [measuredPlugin({ rows, truncated })])
  if ('error' in choice) throw new Error('no candidate')
  return choice
}
const order = (choice: ReturnType<typeof route>) => choice.shown.map(s => `${s.engine} ${s.model}`)
const mine = (s: { notes: string[] }) => s.notes.filter(n => n.startsWith(`${MEASURED}: `))

describe('routing by measured cost and results (Goals piece 3)', () => {
  it('today, without measures, Codex ranks first by its lower catalog cost', () => {
    expect(order(route([]))).toEqual(['codex gpt-6.1-sol', 'claude opus'])
  })

  it('the choice that costs less per shipped change in full wins, rework rounds and their reviews counted', () => {
    // 9 of 10 against 6 of 10: their 95% ranges overlap, so cost decides; counted in full, Opus is cheaper.
    const choice = route(measured)
    expect(order(choice)).toEqual(['claude opus', 'codex gpt-6.1-sol'])
    expect(choice.adjusted).toBe(true)
    expect(mine(choice.shown[0]!)).toEqual([`${MEASURED}: build work, last 7 days: 9 of 10 first reviews passed, $6.00 per shipped change over 10 (failed attempts and every review round included); ranked as cost 2.0 instead of 3`])
    expect(mine(choice.shown[1]!)).toEqual([`${MEASURED}: build work, last 7 days: 6 of 10 first reviews passed, $9.00 per shipped change over 10 (failed attempts and every review round included); ranked as cost 3.0 instead of 2`])
  })

  it('never ranks by the cost of its own attempts alone, which leaves the rework out', () => {
    // Without a full cost (a backend before it) nothing is measured, even with a cheaper cost per shipped change of its own.
    const old = measured.map(({ fullCostPerShipped: _full, ...r }) => ({ ...r, fullCostPerShipped: null }))
    const choice = route(old)
    expect(order(choice)).toEqual(['codex gpt-6.1-sol', 'claude opus'])
    expect(choice.adjusted).toBeUndefined()
  })

  it('a clearly lower first-review pass rate ranks below its strength\'s other choices, whatever it costs', () => {
    // 2 of 12 against 11 of 12: the ranges do not overlap. Codex is cheaper in full here and still goes second.
    const choice = route([row({ firstReviews: 12, firstReviewPassed: 11, fullCostPerShipped: 9 }),
      row({ engine: 'codex', model: 'gpt-6.1-sol', firstReviews: 12, firstReviewPassed: 2, fullCostPerShipped: 3 })])
    expect(order(choice)).toEqual(['claude opus', 'codex gpt-6.1-sol'])
    expect(mine(choice.shown[1]!)[0]).toContain('2 of 12 first reviews passed, clearly fewer than Claude opus high\'s 11 of 12, so it ranks after its strength\'s other choices')
    // Still above a weaker model: the plug-in moves a candidate within its strength, never across it.
    const sonnet = probe({ machineId: 'm3', machineName: 'mac-3', model: 'sonnet', effort: 'medium', quality: 2, cost: 2 })
    expect(order(route([row({ firstReviews: 12, firstReviewPassed: 11 }), row({ engine: 'codex', model: 'gpt-6.1-sol', firstReviews: 12, firstReviewPassed: 2 })],
      [opus, codex, sonnet]))).toEqual(['claude opus', 'codex gpt-6.1-sol', 'claude sonnet'])
  })

  it('below the minimum sample today\'s ranking stays, and nothing is said', () => {
    const thin = route(measured.map(r => ({ ...r, shipped: 2 })))
    expect(order(thin)).toEqual(['codex gpt-6.1-sol', 'claude opus'])
    expect(thin.shown.flatMap(mine)).toEqual([])
    // Too few first reviews keep only the pass rate out: cost still decides with enough shipped changes.
    const fewReviews = route(measured.map(r => ({ ...r, firstReviews: 4, firstReviewPassed: Math.min(r.firstReviewPassed, 4) })))
    expect(order(fewReviews)).toEqual(['claude opus', 'codex gpt-6.1-sol'])
    expect(mine(fewReviews.shown[0]!)[0]).toContain('first reviews too few to compare (4)')
    // One measured choice has nothing to compare with: its numbers are shown, its place is today's.
    const alone = route([measured[1]!])
    expect(order(alone)).toEqual(['codex gpt-6.1-sol', 'claude opus'])
    expect(mine(alone.shown[0]!)[0]).toMatch(/\$9\.00 per shipped change over 10 .*; no other choice for build work has a cost to compare, so its place is unchanged$/)
    // Nor do choices that cost nothing (own hardware), or a run whose model was never known.
    for (const others of [[row({ fullCostPerShipped: 0 }), row({ engine: 'codex', model: 'gpt-6.1-sol', fullCostPerShipped: 0 })],
      [row({ model: 'unknown', effort: 'unknown' }), measured[1]!]]) {
      expect(order(route(others))).toEqual(['codex gpt-6.1-sol', 'claude opus'])
    }
  })

  it('a clearly lower pass rate counts with too few shipped changes to compare cost, also against another engine\'s choice', () => {
    const choice = route([row({ firstReviews: 12, firstReviewPassed: 11, shipped: 1, engine: 'opencode', model: 'big' }),
      row({ engine: 'codex', model: 'gpt-6.1-sol', firstReviews: 12, firstReviewPassed: 2, shipped: 2 })])
    expect(order(choice)).toEqual(['claude opus', 'codex gpt-6.1-sol'])
    expect(mine(choice.shown[1]!)).toEqual([`${MEASURED}: build work, last 7 days: 2 of 12 first reviews passed, clearly fewer than opencode big high's 11 of 12, so it ranks after its strength's other choices, too few shipped changes with known costs to compare cost (2 shipped)`])
    expect(mine(choice.shown[0]!)).toEqual([])
  })

  it('a Claude model it has no family for is matched by its own name', () => {
    const odd = probe({ model: 'claude-experimental', effort: 'default', cost: 1, quality: 3 })
    const choice = route([...measured, row({ model: 'claude-experimental', effort: 'default', fullCostPerShipped: 60 })], [odd, codex])
    expect(order(choice)).toEqual(['codex gpt-6.1-sol', 'claude claude-experimental'])
  })

  it('a task with no kind, or a kind nothing was measured for, ranks as today', () => {
    for (const a of [task({ kind: undefined }), task({ kind: 'docs' })]) {
      const choice = route(measured, [opus, codex], a)
      expect(order(choice)).toEqual(['codex gpt-6.1-sol', 'claude opus'])
      expect(choice.adjusted).toBeUndefined()
    }
  })

  it('only reorders what the route allows: a refused candidate stays out, and the plug-in adds none', () => {
    const blocked = { ...opus, refusals: ['Machine is offline or unreachable.'] }
    const choice = choose([blocked, codex], catalog, task(), NOW, [], [], [], [measuredPlugin({ rows: measured, truncated: false })])
    if ('error' in choice) throw new Error('no candidate')
    expect(order(choice)).toEqual(['codex gpt-6.1-sol'])
    expect(choice.excluded.map(e => e.reason)).toEqual(['Machine is offline or unreachable.'])
    expect(measuredPlugin({ rows: measured, truncated: false }).candidates).toBeUndefined()
  })

  it('matches a member by its model\'s family and a grid agent by its grid model', () => {
    const member = probe({ kind: 'member', agentId: 'a1', name: 'Jules', model: 'claude-opus-5-5[1m]', machineId: 'm4', machineName: 'mac-4' })
    const grid = probe({ machineId: 'm5', machineName: 'grid-1', model: 'default', effort: 'default', quality: 3, cost: 1, gridModel: 'moonshotai/kimi-k3', gridName: 'g', gridLabel: 'Kimi K3', gridKind: 'api' })
    const rows = [...measured, row({ model: 'moonshotai/kimi-k3', effort: 'default', firstReviewPassed: 5, fullCostPerShipped: 30 })]
    const choice = route(rows, [member, codex, grid])
    expect(order(choice)).toEqual(['claude claude-opus-5-5[1m]', 'codex gpt-6.1-sol', 'claude default'])
    expect(mine(choice.shown[2]!)[0]).toContain('$30.00 per shipped change')
  })

  it('says when the read held only the newest attempts', () => {
    expect(mine(route(measured, [opus, codex], task(), true).shown[0]!)[0]).toMatch(/; only the newest attempts were read$/)
  })
})

describe('reading the measures', () => {
  const answer = (rows: unknown[], extra: Record<string, unknown> = {}) => ({ ok: true, value: { days: 7, truncated: false, rows, ...extra } })

  it('asks for the last 7 days and keeps only the fields it ranks by', async () => {
    const asked: unknown[] = []
    const read = await readMeasured(async payload => { asked.push(payload); return answer([{ ...row({}), tokens: { input: 1 }, outcomes: { done: 1 } }], { truncated: true }) })
    expect(asked).toEqual([{ action: 'costs', days: 7 }])
    expect(read).toEqual({ rows: [row({})], truncated: true })
  })

  it('a refusal, a failure, a slow read or an answer it cannot read gives no measures, so the route ranks as today', async () => {
    expect(await readMeasured(async () => ({ error: 'FORBIDDEN' }))).toBeNull()
    expect(await readMeasured(async () => { throw new Error('gone') })).toBeNull()
    expect(await readMeasured(() => new Promise(() => {}), 5)).toBeNull()
    expect(measuredFrom({ ok: true, value: { rows: 'x' } })).toBeNull()
    // A row it cannot read is dropped; the rest count.
    expect(measuredFrom(answer([{ engine: 'claude' }, row({}), { ...row({}), shipped: -1 }, { ...row({}), fullCostPerShipped: Number.NaN }]))).toEqual({ rows: [row({})], truncated: false })
    // A backend before full costs sends none: read as unknown.
    const { fullCostPerShipped: _f, ...older } = row({})
    expect(measuredFrom(answer([older]))).toEqual({ rows: [row({ fullCostPerShipped: null })], truncated: false })
  })
})

describe('the maker', () => {
  const made = (a: Assessment, request: PluginInput['request']) => MEASURED_MAKER.make({ conversationId: 'g1', assessment: a, read: {}, catalog,
    history: Promise.resolve(null), request })
  const costs = (rows: unknown[]) => async () => ({ ok: true, value: { truncated: false, rows } })

  it('is in the route\'s list of makers', () => {
    expect(ROUTE_PLUGIN_MAKERS).toContain(MEASURED_MAKER)
  })

  it('reads nothing for a task with no kind of work', async () => {
    let asked = 0
    expect(await made(task({ kind: undefined }), async () => { asked++; return {} })).toBeNull()
    expect(asked).toBe(0)
  })

  it('makes the plug-in when the kind was measured, has nothing to say when it was not, and fails when the read fails', async () => {
    const plugin = await made(task(), costs(measured))
    expect(plugin?.name).toBe(MEASURED)
    expect(await made(task({ kind: 'docs' }), costs(measured))).toBeNull()
    await expect(made(task(), async () => ({ error: 'FORBIDDEN' }))).rejects.toThrow()
  })
})
