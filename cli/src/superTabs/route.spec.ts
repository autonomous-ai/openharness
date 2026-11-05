// cli/src/superTabs/route.spec.ts
import { afterEach, describe, expect, it, vi } from 'vitest'
import { API_BUILDERS, CHOOSE_BY_INSTRUCTIONS, CODEX_DEFAULT_NOT_OFFERED, NONE_COVERS, catalogFrom, quotaBrief, catalogRow, choose, decide, gridStrength, LOCAL_NONE, OTHER_REPOSITORY, parseAssessment, quotaOf2, recordOf, repoMatch, repositoryKey, strengthOf,
  type Assessment, type Catalog, type Commitment, type MemberFrame, type Probe, type RoutePlugin, type TaskFolder } from './route.js'

const object = (v: unknown) => v as Record<string, unknown>

/** Today's rows, with Haiku not offered unless named (backend superTabs/catalog.ts). */
const policy: Catalog = { grid: { strength: 1, models: [] }, models: [
  { engine: 'claude', model: 'opus', effort: 'high', strength: 3, cost: 3, offered: true },
  { engine: 'codex', model: 'default', effort: 'default', strength: 3, cost: 2, offered: true },
  { engine: 'codex', model: 'gpt-6.1-sol', effort: 'high', strength: 3, cost: 2, offered: true },
  { engine: 'claude', model: 'sonnet', effort: 'medium', strength: 2, cost: 2, offered: true },
  { engine: 'claude', model: 'haiku', effort: 'auto', strength: 1, cost: 1, offered: false },
] }
/** How the catalog rates a model, as a member's row: its strength and cost, or null when it does not rate it. */
const rate = (c: Catalog, engine: string, model: string | null, effort: string | null, engineDefault = false) => {
  const row = catalogRow(c, engine, model, effort, engineDefault)
  return row ? { quality: row.strength, cost: row.cost } : null
}
const a = (patch: Partial<Assessment> = {}): Assessment => ({ difficulty: 'medium', risk: 'low', size: 'medium', why: 'API change.', needs: { tools: [], devices: [] }, ...patch })
const probe = (patch: Partial<Probe> = {}): Probe => ({ kind: 'new', machineId: 'm1', machineName: 'remote-1', engine: 'claude', model: 'sonnet',
  effort: 'medium', quality: 2, cost: 2, quota: { known: true, leftPercent: 50, resetsAt: 1_000 }, activity: 'new', known: true, refusals: [], notes: [], ...patch })

const NOW = 1_000_000_000, M = 60_000, H = 3_600_000, D = 86_400_000
/** A reading with a 5-hour and a weekly window, each as [percent left, resets in] (either may be missing). */
type Win = [left: number, resetsIn: number | null] | null
const windows = (five: Win, week: Win, account?: string): Probe['quota'] => {
  const read = ([['5-hour', five], ['weekly', week]] as const).flatMap(([name, w]) => w ? [{ name, leftPercent: w[0], resetsAt: w[1] === null ? null : NOW + w[1] }] : [])
  return { known: true, leftPercent: Math.min(...read.map(w => w.leftPercent)), resetsAt: null, windows: read, ...(account ? { account } : {}) }
}
const ok = (r: ReturnType<typeof choose>) => { if ('error' in r) throw new Error('x'); return r }

describe('assessment', () => {
  it('parses an assessment and explains what is wrong', () => {
    expect(parseAssessment({ difficulty: 'high', risk: 'low', size: 'large', why: ' Schema. ', needs: { tools: ['git'] } }))
      .toEqual({ difficulty: 'high', risk: 'low', size: 'large', why: 'Schema.', needs: { tools: ['git'], devices: [] } })
    expect(parseAssessment({ difficulty: 'high', risk: 'low', size: 'huge', why: 'x' })).toContain('size')
    expect(parseAssessment({ difficulty: 'high', risk: 'low', size: 'toString', why: 'x' })).toContain('size')
    expect(parseAssessment({ difficulty: 'hard', risk: 'low', why: 'x' })).toContain('difficulty')
    expect(parseAssessment({ difficulty: 'low', risk: 'low', why: 'x'.repeat(301) })).toContain('300')
    expect(parseAssessment({ difficulty: 'low', risk: 'low', why: 'x', needs: { cwd: 'relative' } })).toContain('absolute')
    expect(parseAssessment(null)).toContain('difficulty')
  })
  // Task #3047: what the work needs to reach, by the names machines list it under.
  it('parses needs.access, trimmed and once each, and explains a bad one', () => {
    expect(parseAssessment({ difficulty: 'low', risk: 'low', why: 'x', needs: { access: [' Lamp ', 'Lamp', 'Fusion  360'] } }))
      .toMatchObject({ needs: { access: ['Lamp', 'Fusion 360'] } })
    expect(parseAssessment({ difficulty: 'low', risk: 'low', why: 'x', needs: { access: [] } })).not.toHaveProperty('needs.access')
    for (const access of ['Lamp', [''], ['x'.repeat(61)], [3]]) {
      expect(parseAssessment({ difficulty: 'low', risk: 'low', why: 'x', needs: { access } }), JSON.stringify(access)).toContain('needs.access')
    }
  })
  it('parses the task\'s kind', () => {
    expect(parseAssessment({ difficulty: 'low', risk: 'low', why: 'x', kind: 'ui' })).toMatchObject({ kind: 'ui' })
    expect(parseAssessment({ difficulty: 'low', risk: 'low', why: 'x', kind: 'UI work' })).toContain('kind')
    expect(parseAssessment({ difficulty: 'low', risk: 'low', why: 'x' })).not.toHaveProperty('kind')
  })
})

describe('quota and rates', () => {
  it('normalizes reset times from epoch seconds, milliseconds and ISO strings and uses the tightest window', () => {
    expect(quotaOf2({ known: true, windows: [{ usedPercent: 20, resetsAt: 1_800_000_000 }, { usedPercent: 70, resetsAt: '2026-10-19T12:00:00Z' }] }))
      .toMatchObject({ known: true, leftPercent: 30, resetsAt: Date.parse('2026-10-19T12:00:00Z') })
    expect(quotaOf2({ known: true, windows: [{ usedPercent: 10, resetsAt: 1_800_000_000 }] }).resetsAt).toBe(1_800_000_000_000)
    expect(quotaOf2({ known: true, windows: [{ usedPercent: 10, resetsAt: 1_800_000_000_000 }] }).resetsAt).toBe(1_800_000_000_000)
    expect(quotaOf2({ known: true, windows: [{ usedPercent: 10, resetsAt: 'soon' }] }).resetsAt).toBeNull()
    expect(quotaOf2({ known: false, windows: [] })).toEqual({ known: false, leftPercent: null, resetsAt: null })
    // The reading's account key goes with it, read or not, so models on one subscription share it.
    expect(quotaOf2({ known: false, windows: [], account: 'k1' })).toEqual({ known: false, leftPercent: null, resetsAt: null, account: 'k1' })
    expect(quotaOf2({ known: true, windows: [{ usedPercent: 10, resetsAt: null }], account: 'k1' }).account).toBe('k1')
    expect(quotaOf2({ known: true, windows: [{ usedPercent: 10, resetsAt: null }], account: null })).not.toHaveProperty('account')
  })
  it('rates a member by its catalog row, then by model, else not at all', () => {
    expect(rate(policy, 'claude', 'opus', 'high')).toEqual({ quality: 3, cost: 3 })
    expect(rate(policy, 'claude', 'opus', 'max')).toEqual({ quality: 3, cost: 3 })
    expect(rate(policy, 'claude', null, null)).toBeNull()
    // A model the catalog does not name, a small Codex variant among them, is unrated (review of #2137); one launched on the
    // engine's own model takes the `default` row, whatever slug it reports.
    expect(rate(policy, 'codex', 'gpt-5.5-mini', 'high')).toBeNull()
    expect(rate(policy, 'codex', 'gpt-6.1-sol', 'high', true)).toEqual({ quality: 3, cost: 2 })
    expect(rate(policy, 'codex', 'default', 'default')).toEqual({ quality: 3, cost: 2 })
    expect(rate(policy, 'claude', 'claude-opus-4-7', 'high', true)).toEqual({ quality: 3, cost: 3 })
  })
  // The catalog names Astra (backend superTabs/catalog.ts), and the route rates it by that row at any effort.
  it('rates Codex GPT-6-Astra by the catalog\'s Astra row, at xhigh or any other effort, and unrated from a catalog without it', () => {
    const astra = { engine: 'codex' as const, model: 'gpt-6-astra', effort: 'xhigh', strength: 3, cost: 5, offered: true }
    const served = { ...policy, models: [...policy.models, astra] }
    expect(rate(served, 'codex', 'gpt-6-astra', 'xhigh')).toEqual({ quality: 3, cost: 5 })
    expect(rate(served, 'codex', 'gpt-6-astra', 'high')).toEqual({ quality: 3, cost: 5 })
    expect(strengthOf(policy, 'codex', 'gpt-6-astra', 'xhigh')).toBeNull()
  })
  it('rates a Codex model by its own row in the catalog, and leaves an unnamed slug unrated', () => {
    const served = { ...policy, models: [...policy.models, { engine: 'codex' as const, model: 'gpt-6.1-sol', effort: 'high', strength: 3, cost: 2, offered: true }] }
    expect(rate(served, 'codex', 'gpt-6.1-sol', 'xhigh')).toEqual({ quality: 3, cost: 2 })
    expect(rate(served, 'codex', 'gpt-7-unknown', 'high')).toBeNull()
  })
})

// Task #2972 (Ken, 2026-11-04): the route put `Codex default default` first 67 times of 71 Codex picks; it ran whatever the
// account's CLI defaulted to. The catalog now names Sol as the engine's default (`engineDefault`) and has no `default` row.
describe('Codex default in the catalog', () => {
  const sol = { engine: 'codex' as const, model: 'gpt-6.1-sol', effort: 'high', strength: 3, cost: 2, offered: true }
  const named: Catalog = { grid: policy.grid, models: [{ engine: 'claude', model: 'opus', effort: 'high', strength: 3, cost: 3, offered: true }, { ...sol, engineDefault: true }] }
  it('rates a member launched on Codex\'s own model as the catalog\'s named default, and a small variant not at all', () => {
    expect(rate(named, 'codex', null, null)).toEqual({ quality: 3, cost: 2 })
    expect(rate(named, 'codex', 'default', 'default')).toEqual({ quality: 3, cost: 2 })
    expect(rate(named, 'codex', 'gpt-5.5', 'high', true)).toEqual({ quality: 3, cost: 2 })
    expect(rate(named, 'codex', 'gpt-5.5-mini', 'high', true)).toBeNull()
    expect(rate(named, 'codex', 'gpt-5.5', 'high')).toBeNull()
  })
  it('reads the named default from the served catalog, and never offers a `default` Codex row an older backend still serves', () => {
    const rows = [{ engine: 'codex', model: 'default', effort: 'default', strength: 3, cost: 2, offered: true },
      { engine: 'codex', model: 'gpt-6.1-sol', effort: 'high', strength: 3, cost: 2, offered: true, engineDefault: true },
      { engine: 'codex', model: 'gpt-6-astra', effort: 'xhigh', strength: 3, cost: 5, offered: true }]
    const read = catalogFrom({ catalog: { models: rows, grid: { strength: 1, models: [] } } })
    expect(read.models.filter(m => m.offered).map(m => `${m.model} ${m.effort}`)).toEqual(['gpt-6.1-sol high', 'gpt-6-astra xhigh'])
    expect(read.models.find(m => m.model === 'gpt-6.1-sol')).toMatchObject({ engineDefault: true })
    // A member launched on the engine's own model is still rated, by that row.
    expect(rate(read, 'codex', null, null, true)).toEqual({ quality: 3, cost: 2 })
    // The same from an older backend that serves only its policy.
    const old = catalogFrom({ policy: { models: rows.map(({ strength, offered, ...r }) => ({ ...r, quality: strength, enabled: offered })) } })
    expect(old.models.filter(m => m.offered).map(m => `${m.model} ${m.effort}`)).toEqual(['gpt-6.1-sol high', 'gpt-6-astra xhigh'])
  })
})

describe('choose', () => {
  it('returns NO_CANDIDATE with reasons when nothing can run', () => {
    expect(choose([probe({ refusals: ['Machine is offline.'] })], policy, a())).toEqual({ error: 'NO_CANDIDATE',
      excluded: [{ title: 'New agent · Claude sonnet medium · remote-1', reason: 'Machine is offline.', machine: 'remote-1' }] })
  })
  it('shows every candidate that can run, by machine name, a member in another repository after the others on its machine', () => {
    const r = choose([
      probe({ model: 'opus', effort: 'high', quality: 3, cost: 3, quota: windows([80, 3 * H], [90, 5 * D]) }),
      probe({ machineId: 'm2', machineName: 'mac', quota: windows([80, 3 * H], [90, 5 * D], 'B') }),
      probe({ quota: windows([60, 3 * H], [90, 5 * D]) }),
      probe({ kind: 'member', agentId: 'a1', name: 'Multiply', quota: windows([60, 3 * H], [90, 5 * D]), activity: 'idle' }),
      probe({ kind: 'member', agentId: 'a2', name: 'Elsewhere', repo: 'different', quota: windows([60, 3 * H], [90, 5 * D]), activity: 'idle' }),
      // Haiku's row is not offered by default: no new agent on it unless a person names it.
      probe({ model: 'haiku', effort: 'auto', quality: 1, cost: 1 }),
    ], policy, a(), NOW)
    if ('error' in r) throw new Error('unexpected')
    expect(r).toMatchObject({ floor: 1, belowFloor: false, excluded: [] })
    // A member in another repository would build in that repository's worktree: shown last, with why (#2377).
    expect(r.shown.map(s => s.title)).toEqual([
      'New agent · Claude sonnet medium · mac',
      'Multiply · Claude sonnet medium · remote-1',
      'New agent · Claude opus high · remote-1',
      'New agent · Claude sonnet medium · remote-1',
      'Elsewhere · Claude sonnet medium · remote-1',
    ])
    expect(r.shown.map(s => s.id)).toEqual(['c0', 'c1', 'c2', 'c3', 'c4'])
    expect(r.shown[4]!.label).toContain(OTHER_REPOSITORY)
  })
  // Diego, 10-30: a member in another repository tied a new agent and the title decided, so Ada took the task in her own
  // repository's worktree and Zed did not. Review of #2377: ranking it after a new agent was not enough, since what ranks
  // before placement (here: price and quota fit) still let it win. The route no longer tells a build from a review, so it is
  // shown after the others on its machine with why, never left out (project instructions: facts only). Since task #2901 nothing
  // else places a member: whether to reuse an idle agent is the Routing instructions' rule 3, so the title orders the rest.
  it('lists a member in another repository after the others on its machine, with why, whatever its name, price or quota', () => {
    const route = (member: Partial<Probe>, task: Partial<Assessment> = {}, others = [probe()]) =>
      ok(choose([...others, probe({ kind: 'member', agentId: 'a1', activity: 'idle', ...member })], policy, a(task), NOW))
    const order = (member: Partial<Probe>, task: Partial<Assessment> = {}) => route(member, task).shown.map(s => s.kind)
    expect(order({ name: 'Ada', repo: 'different' })).toEqual(['new', 'member'])
    expect(order({ name: 'Zed', repo: 'different' })).toEqual(['new', 'member'])
    const ada = route({ name: 'Ada', repo: 'different' })
    expect(ada.excluded).toEqual([])
    expect(ada.shown[1]!.notes).toContain(OTHER_REPOSITORY)
    expect(ada.shown[1]!.label).toContain(OTHER_REPOSITORY)
    // In the repository, unknown, or no folder named: the title orders it beside a new agent.
    expect(order({ name: 'Ada', repo: 'same' })).toEqual(['member', 'new'])
    expect(order({ name: 'Zed', repo: 'same' })).toEqual(['new', 'member'])
    expect(route({ name: 'Ada', repo: 'same' }).shown[0]!.notes).not.toContain(OTHER_REPOSITORY)
    expect(order({ name: 'Zed' })).toEqual(['new', 'member'])
    expect(order({ name: 'Ada', repo: 'unknown' })).toEqual(['member', 'new'])
    expect(order({ name: 'Zed', repo: 'unknown' })).toEqual(['new', 'member'])
    // Nothing brings it forward on its machine: cheaper, stronger, or more quota room.
    expect(order({ name: 'Zed', repo: 'different', cost: 1 })).toEqual(['new', 'member'])
    expect(order({ name: 'Zed', repo: 'different', model: 'opus', effort: 'high', quality: 3, cost: 3 })).toEqual(['new', 'member'])
    const roomy = windows([90, 3 * H], [90, 5 * D], 'A'), tight = windows([40, 3 * H], [60, 5 * D], 'B')
    const full = [probe({ quota: roomy, refusals: ['This machine runs as many agents as its owner allows.'] }), probe({ machineId: 'm2', machineName: 'mac', quota: tight })]
    expect(route({ name: 'Ada', repo: 'different', quota: roomy }, {}, full).shown.map(s => s.title))
      .toEqual(['New agent · Claude sonnet medium · mac', 'Ada · Claude sonnet medium · remote-1'])
    expect(route({ name: 'Ada', repo: 'same', quota: roomy }, {}, full).shown.map(s => s.title))
      .toEqual(['New agent · Claude sonnet medium · mac', 'Ada · Claude sonnet medium · remote-1'])
    // Only members in another repository: shown, with why, for the agent choosing (a review needs no worktree).
    const only = ok(choose([probe({ kind: 'member', agentId: 'a1', name: 'Ada', activity: 'idle', repo: 'different' })], policy, a(), NOW))
    expect(only.shown.map(s => [s.title, s.notes])).toEqual([['Ada · Claude sonnet medium · remote-1', [OTHER_REPOSITORY]]])
  })
  it('leaves out a member in another repository when the task names a repository; with none named it is listed after the others on its machine', () => {
    const member = probe({ kind: 'member', agentId: 'a1', name: 'Ada', activity: 'idle', repo: 'different' })
    const named = ok(choose([probe(), member], policy, a({ needs: { tools: [], devices: [], cwd: '/w/web' } }), NOW))
    expect(named.shown.map(s => s.kind)).toEqual(['new'])
    expect(named.excluded).toEqual([{ title: 'Ada · Claude sonnet medium · remote-1', reason: OTHER_REPOSITORY, machine: expect.any(String) }])
    const sameRepo = ok(choose([probe(), { ...member, repo: 'same' }], policy, a({ needs: { tools: [], devices: [], cwd: '/w/web' } }), NOW))
    expect(sameRepo.shown.map(s => s.kind)).toEqual(['member', 'new'])
    const none = ok(choose([probe(), member], policy, a(), NOW))
    expect(none.shown.map(s => s.kind)).toEqual(['new', 'member'])
    expect(none.shown[1]!.notes).toContain(OTHER_REPOSITORY)
    expect(none.excluded).toEqual([])
  })
  it('shows each candidate\'s fit, fits, unknown or short, in machine order', () => {
    const r = ok(choose([probe({ quality: 1 }), probe({ quality: 1, machineName: 'mac', quota: windows([90, null], [90, null]) })], policy, a({ difficulty: 'high' }), NOW))
    expect(r.shown.map(s => [s.machineName, s.fit.status])).toEqual([['mac', 'fits'], ['remote-1', 'unknown']])
    expect(r.excluded).toEqual([])
    // One candidate's being short says nothing of the route: only none covering the task is said.
    const short = ok(choose([probe({ quota: windows([10, null], [90, null]) }), probe({ machineName: 'mac', quota: windows([90, null], null) })], policy, a(), NOW))
    expect(short.shown.map(s => [s.machineName, s.fit.status])).toEqual([['mac', 'unknown'], ['remote-1', 'short']])
    expect(short.short).toBeUndefined()
  })
  // Every account the coordinator may pick by the project's order is in front of it: the route used to cut the list at 12, one
  // row a machine, and a Claude account with 99% left on a machine whose cheaper Codex was used up never showed (Ken, 2026-11-03).
  it('shows a row for every machine and engine, past 12', () => {
    const r = choose(Array.from({ length: 20 }, (_, i) => probe({ machineId: `m${i}`, machineName: `box-${String(i).padStart(2, '0')}` })), policy, a())
    if ('error' in r) throw new Error('unexpected')
    expect(r.shown).toHaveLength(20)
  })
})

/** The phase 1 examples (docs/plans/2026-10-21-swarm-routing-phase1.md), on every row offered and, since the project
 *  instructions, no reserve: nothing is left out for its quota. Since task #2901 they are facts on each candidate (its fit and
 *  effective cost), never its place: the list is by machine, and the Routing instructions choose. */
describe('strength, fit and effective cost', () => {
  const defaults: Catalog = { ...policy, models: policy.models.map(m => ({ ...m, offered: true })) }
  const OPUS = { engine: 'claude', model: 'opus', effort: 'high', quality: 3, cost: 3 } as const
  const SONNET = { engine: 'claude', model: 'sonnet', effort: 'medium', quality: 2, cost: 2 } as const
  const HAIKU = { engine: 'claude', model: 'haiku', effort: 'auto', quality: 1, cost: 1 } as const
  const CODEX = { engine: 'codex', model: 'default', effort: 'default', quality: 3, cost: 2 } as const
  const on = (row: Partial<Probe>, machine: string, quota: Probe['quota']) => probe({ ...row, machineId: machine, machineName: machine, quota })
  const unknown = { known: false, leftPercent: null, resetsAt: null }
  const route = (probes: Probe[], patch: Partial<Assessment>, now = NOW, open: Commitment[] = []) => ok(choose(probes, defaults, a(patch), now, open))
  const picks = (r: ReturnType<typeof route>) => r.shown.map(s => `${s.model} on ${s.machineName}`)
  const row = (r: ReturnType<typeof route>, model: string, machine: string) => r.shown.find(s => s.model === model && s.machineName === machine)!

  it('1. high, medium: Opus high, whose window resets in 40 minutes, fits at no cost, beside Sonnet with more left', () => {
    const r = route([on(OPUS, 'a', windows([70, 40 * M], [80, 5 * D], 'A')), on(SONNET, 'b', windows([90, 3 * H], [80, 5 * D], 'B'))], { difficulty: 'high', size: 'medium' })
    expect(picks(r)).toEqual(['opus on a', 'sonnet on b'])
    expect(r.excluded).toEqual([])
    expect(r.shown[0].label).toContain('fits: needs about 30% of the 5-hour window (70% left, resets in 40m, otherwise unused); weekly 6% of 80%')
    expect(r.shown[0].fit).toEqual({ status: 'fits', coverage: 2.33, effectiveCost: 0, expiring: 1, spend: { '5-hour': 45, weekly: 6 }, account: 'A' })
  })
  it('2. high, large: Opus high is expected to run out and is shown short; Codex, whose window would go unused, fits', () => {
    const r = route([on(OPUS, 'a', windows([25, 4 * H], [80, 5 * D], 'A')), on(CODEX, 'a', windows([85, 3 * H], [80, 5 * D]))], { difficulty: 'high', size: 'large' })
    expect(picks(r)).toEqual(['opus on a', 'default on a'])
    expect(r.shown.map(s => s.fit.status)).toEqual(['short', 'fits'])
    expect(r.shown[1].fit.account).toBe('a:codex')
    expect(r.excluded).toEqual([])
  })
  it('3. low, small: the account nearly spent for the week costs more in effect than the one with room', () => {
    const A = windows([80, 4 * H], [2, 5 * D], 'A'), B = windows([60, 4 * H], [70, 5 * D], 'B')
    const r = route([OPUS, SONNET, HAIKU].flatMap(row => [on(row, 'a', A), on(row, 'b', B)]), { difficulty: 'low', size: 'small' })
    expect(row(r, 'opus', 'a').fit.effectiveCost).toBeGreaterThan(row(r, 'opus', 'b').fit.effectiveCost)
    // A's weekly budget is 0.4% a day; Haiku's 0.5% costs it 1 + 1 × 0.5 / 0.4.
    expect(r.shown.find(s => s.model === 'haiku' && s.machineName === 'a')!.fit.effectiveCost).toBe(2.25)
  })
  it('4. low, small: Opus high on the account whose 5-hour window resets in 20 minutes costs less in effect: it would otherwise go unused', () => {
    const A = windows([60, 20 * M], [60, 2 * D], 'A'), B = windows([90, 4 * H], [80, 5 * D], 'B')
    const r = route([OPUS, SONNET, HAIKU].flatMap(row => [on(row, 'a', A), on(row, 'b', B)]), { difficulty: 'low', size: 'small' })
    expect(row(r, 'opus', 'a').fit.expiring).toBeGreaterThan(0)
    expect(row(r, 'opus', 'a').fit.effectiveCost).toBeLessThan(row(r, 'opus', 'b').fit.effectiveCost)
  })
  it('5. a second high, medium route a minute after the first sees what the first one holds on its account', () => {
    const probes = [on(OPUS, 'a', windows([60, 3 * H], [80, 5 * D], 'A')), on(OPUS, 'b', windows([58, 3 * H], [80, 5 * D], 'B'))]
    const first = route(probes, { difficulty: 'high', size: 'medium' })
    expect(first.shown.map(s => s.fit.status)).toEqual(['fits', 'fits'])
    const held: Commitment = { account: first.shown[0].fit.account, spend: first.shown[0].fit.spend, size: 'medium', createdAt: NOW }
    const second = route(probes, { difficulty: 'high', size: 'medium' }, NOW + M, [held])
    expect(picks(second)).toEqual(['opus on a', 'opus on b'])
    expect(second.shown.map(s => s.fit.status)).toEqual(['short', 'fits'])
    expect(second.shown[0]!.label).toContain('short: ')
    // Once its run time is over a pick holds nothing.
    expect(route(probes, { difficulty: 'high', size: 'medium' }, NOW + 2 * H, [held]).shown[0]!.fit.status).toBe('fits')
  })
  it('6. high, large: a window that resets in an hour needs only the part of the task before the reset', () => {
    const r = route([on(OPUS, 'a', windows([40, H], [80, 5 * D]))], { difficulty: 'high', size: 'large' })
    expect(r.shown[0].fit).toMatchObject({ status: 'fits', coverage: 1.6 })
    expect(r.shown[0].label).toContain('needs about 25% of the 5-hour window')
  })
  it('7. high, large: each candidate shows whether it is short; the route warns only when none fits', () => {
    const r = route([on(OPUS, 'a', windows([30, 4 * H], [80, 5 * D], 'A')), on(CODEX, 'a', windows([40, 4.5 * H], [80, 5 * D])),
      on(SONNET, 's', windows([95, 4 * H], [80, 5 * D], 'S'))], { difficulty: 'high', size: 'large' })
    expect(picks(r)).toEqual(['opus on a', 'default on a', 'sonnet on s'])
    expect(r.shown.map(s => s.fit.status)).toEqual(['short', 'short', 'fits'])
    expect(r.short).toBeUndefined()
    // With no candidate that fits, it says so.
    expect(route(r.shown.slice(0, 2), { difficulty: 'high', size: 'large' }).short).toBe(NONE_COVERS)
  })
  it('8. an assessment without size is taken for medium', () => {
    const size = parseAssessment({ difficulty: 'high', risk: 'low', why: 'x' }) as Assessment
    expect(size.size).toBe('medium')
    expect(ok(choose([on(OPUS, 'a', windows([90, 3 * H], [80, 5 * D]))], defaults, size, NOW)).shown[0].fit.spend).toEqual({ '5-hour': 45, weekly: 6 })
  })
  it('reads what a pick holds per window, and leaves the weekly charge to work that is not hard', () => {
    // A pick logged with only a 5-hour spend holds nothing of the weekly window.
    const held: Commitment = { account: 'A', spend: { '5-hour': 30 }, size: 'large', createdAt: NOW }
    const r = route([on(SONNET, 'a', windows([90, 5 * H], [20, 7 * D], 'A'))], { size: 'medium' }, NOW, [held])
    expect(r.shown[0].fit).toMatchObject({ status: 'fits', coverage: 2 })
    // Weekly use above a day's share costs more, unless the task is hard.
    expect(r.shown[0].fit.effectiveCost).toBeGreaterThan(2)
    expect(route([on(SONNET, 'a', windows([90, 5 * H], [20, 7 * D], 'A'))], { difficulty: 'high', size: 'medium' }).shown[0].fit.effectiveCost).toBe(2)
    // A weekly window with no reset is one day's budget; one with nothing usable is short already, not charged.
    expect(route([on(SONNET, 'a', windows([90, 5 * H], [20, null]))], {}).shown[0].fit.effectiveCost).toBe(2)
    const spent = route([on(SONNET, 'a', windows([90, 5 * H], [0, 7 * D]))], {})
    expect(spent.shown[0].fit).toMatchObject({ status: 'short', effectiveCost: 2 })
    expect(spent.short).toBe(NONE_COVERS)
  })
  // A 5-hour window is never what runs out (Ken, 2026-11-03), and a Team account's Claude, whose 5-hour window its host does not
  // relay, read as unknown and fell behind every Codex that fit.
  it('reads an account with a weekly window in full on either engine, with or without its 5-hour window', () => {
    const CODEX = { engine: 'codex', model: 'default', effort: 'default', quality: 2, cost: 2 } as const
    const weekly = quotaOf2({ known: true, windows: [{ usedPercent: 19, resetsAt: (NOW + 6 * D) / 1000, name: 'weekly' }] })
    const r = route([on(CODEX, 'codex', weekly), on(SONNET, 'claude', windows([90, 3 * H], [80, 5 * D]))], { difficulty: 'low' })
    expect(r.shown.map(s => [s.engine, s.fit.status])).toEqual([['claude', 'fits'], ['codex', 'fits']])
    expect(r.excluded).toEqual([])
    const half = route([on(SONNET, 'half', weekly), on(SONNET, 'claude', windows([90, 3 * H], [80, 5 * D]))], { difficulty: 'low' })
    expect(half.shown.map(s => [s.machineName, s.fit.status])).toEqual([['claude', 'fits'], ['half', 'fits']])
    // A weekly window with no room is short; with no weekly reading the fit is not known.
    expect(route([on(SONNET, 'a', windows([90, 3 * H], [1, 5 * D]))], {}).shown[0].fit.status).toBe('short')
    expect(route([on(SONNET, 'a', windows([90, 3 * H], null))], {}).shown[0].fit.status).toBe('unknown')
  })
  it('keeps a row for each engine of every machine, though a cheaper engine there is used up', () => {
    const boxes = Array.from({ length: 14 }, (_, i) => `box-${String(i).padStart(2, '0')}`)
    const r = route(boxes.flatMap(b => [on(CODEX, b, windows(null, [0, 5 * D], `${b}-x`)), on(OPUS, b, windows(null, [99, D], `${b}-c`))]), { difficulty: 'high' })
    expect(r.shown).toHaveLength(28)
    for (const b of boxes) expect(r.shown.filter(s => s.machineName === b).map(s => [s.engine, s.fit.status]).sort()).toEqual([['claude', 'fits'], ['codex', 'short']])
  })
  // River, 2026-11-03: a Codex reading "unknown" did not say that its owner's machine must relay it.
  // The PM paces its own account by the day since its weekly reset (project instructions, 2026-11-03): "resets in 7 days", a
  // whole day either way, left it half a day off.
  it('says when a weekly window resets to the hour past two days', () => {
    const brief = (resetsIn: number) => quotaBrief({ quota: windows(null, [80, resetsIn]), fit: { status: 'fits' } }, NOW)
    expect(brief(6 * D + 13 * H + 10 * M)).toBe('fits: weekly 80% left, resets in 6d13h')
    expect(brief(5 * D)).toBe('fits: weekly 80% left, resets in 5d')
    expect(brief(2 * D + 23 * H + 40 * M)).toBe('fits: weekly 80% left, resets in 3d')
    expect(brief(30 * H)).toBe('fits: weekly 80% left, resets in 30h')
  })
  it('says why an unknown quota is unknown', () => {
    const why = 'This account runs on its owner\'s subscription; its allowance is read on the owner\'s machine.'
    expect(quotaBrief({ quota: { known: false, leftPercent: null, resetsAt: null, why }, fit: { status: 'unknown' } }, NOW)).toBe(`unknown: ${why}`)
    expect(quotaBrief({ quota: { known: false, leftPercent: null, resetsAt: null }, fit: { status: 'unknown' } }, NOW)).toBe('unknown: weekly unknown')
  })
  it('shows at most 64 rows, what the backend keeps of a decision, the best-ranked first', () => {
    const boxes = Array.from({ length: 40 }, (_, i) => `box-${String(i).padStart(2, '0')}`)
    const r = route(boxes.flatMap(b => [on(CODEX, b, windows(null, [50, 5 * D], `${b}-x`)), on(OPUS, b, windows(null, [99, D], `${b}-c`))]), { difficulty: 'high' })
    expect(r.shown).toHaveLength(64)
    expect(r.shown.at(-1)!.id).toBe('c63')
  })
  it('an engine on an API key is metered: it fits with no window, beside a subscription machine', () => {
    const metered = quotaOf2({ known: true, windows: [] })
    expect(metered).toEqual({ known: true, leftPercent: null, resetsAt: null, metered: true })
    const r = route([on(SONNET, 'key', metered), on(SONNET, 'sub', windows([90, 3 * H], [80, 5 * D], 'S')), on(SONNET, 'unread', unknown)], { difficulty: 'low' })
    expect(r.shown.map(s => [s.machineName, s.fit.status])).toEqual([['key', 'fits'], ['sub', 'fits'], ['unread', 'unknown']])
    expect(r.excluded).toEqual([])
    expect(r.shown[0].fit).toEqual({ status: 'fits', coverage: null, effectiveCost: 2, expiring: 0, spend: { '5-hour': 30, weekly: 4 }, account: 'key:claude' })
    expect(r.shown[0].label).toContain('fits: metered, no usage window to run out')
    expect(r.shown[0].label).toContain('quota metered')
  })
  it('keeps the best row of every machine inside the shown rows, then fills by rank', () => {
    const full = windows([90, 3 * H], [80, 5 * D], 'S')
    const crowd = Array.from({ length: 14 }, (_, i) => probe({ kind: 'member', agentId: `m${i}`, name: `Member ${String(i).padStart(2, '0')}`, machineId: 'a', machineName: 'a', quota: full }))
    const far = on({ ...HAIKU }, 'z', windows([90, 3 * H], [80, 5 * D], 'Z'))
    const r = route([...crowd, far], { difficulty: 'low' })
    expect(r.shown).toHaveLength(12)
    // The weaker machine z ranks 15th, behind all of a's rows, yet its best row is shown, in place of a's 12th.
    expect(r.shown.map(s => s.machineName)).toEqual([...Array(11).fill('a'), 'z'])
    expect(r.shown.map(s => s.id)).toEqual(Array.from({ length: 12 }, (_, i) => `c${i}`))
  })
  it('with more machines than rows shown, shows a new agent and a member of every one', () => {
    const many = Array.from({ length: 14 }, (_, i) => on(SONNET, `m${String(i).padStart(2, '0')}`, windows([90 - i, 3 * H], [80, 5 * D], `A${i}`)))
    const r = route([...many, ...many.map(p => ({ ...p, kind: 'member' as const, agentId: p.machineId, name: 'Extra' }))], { difficulty: 'low' })
    expect(new Set(r.shown.map(s => s.machineName)).size).toBe(14)
    expect(r.shown).toHaveLength(28)
  })
  it('lists the short by machine, and labels a window with no reset known', () => {
    const r = route([on(SONNET, 'b', windows([20, null], [80, null], 'B')), on(SONNET, 'a', windows([20, null], [80, null], 'A')), on(SONNET, 'c', windows([25, null], [80, null], 'C'))], {})
    expect(picks(r)).toEqual(['sonnet on a', 'sonnet on b', 'sonnet on c'])
    expect(r.short).toBe(NONE_COVERS)
    expect(r.shown[2].label).toContain('short: needs about 30% of the 5-hour window (25% left); weekly 4% of 80%')
    expect(route([on(SONNET, 'a', windows(null, [80, null]))], {}).shown[0].label).toContain('fits: 5-hour window unknown; weekly 4% of 80%')
  })
})

// Ken, 2026-11-04 (task #2901): PMs took the route's top line, nearly always Opus or Astra, against the project's Routing
// instructions (soonest reset, most left, fewer working agents, grid first for small work). The route now leaves out what cannot
// run, keeps every fact, and lists the rest in a neutral order the instructions choose from.
describe('no ranking: the project\'s Routing instructions choose (task #2901)', () => {
  const STRONG = { engine: 'claude', model: 'opus', effort: 'high', quality: 3, cost: 3 } as const
  const CHEAP = { engine: 'claude', model: 'haiku', effort: 'auto', quality: 1, cost: 1 } as const
  const CODEX = { engine: 'codex', model: 'default', effort: 'default', quality: 3, cost: 2 } as const
  const all: Catalog = { ...policy, models: policy.models.map(m => ({ ...m, offered: true })) }
  const on = (machine: string, row: Partial<Probe>, quota = windows([80, 3 * H], [90, 5 * D], `${machine}-${row.engine ?? 'claude'}`)) =>
    probe({ machineId: machine, machineName: machine, ...row, quota })
  const order = (r: ReturnType<typeof choose>) => ok(r).shown.map(s => `${s.machineName} ${s.engine} ${s.model}`)

  it('lists candidates by machine name, then engine: never the stronger, the cheaper or the better fit first', () => {
    const probes = [on('zeta', STRONG, windows([99, 3 * H], [99, 2 * D], 'Z')), on('alpha', CODEX, windows([5, 3 * H], [3, 6 * D], 'AX')),
      on('alpha', CHEAP, windows([40, 3 * H], [40, 6 * D], 'AC')), on('mid', CHEAP, windows([90, 3 * H], [90, 5 * D], 'M'))]
    const r = choose(probes, all, a({ difficulty: 'high', size: 'large' }), NOW)
    expect(order(r)).toEqual(['alpha claude haiku', 'alpha codex default', 'mid claude haiku', 'zeta claude opus'])
    // The same whatever order the machines answered in.
    expect(order(choose([...probes].reverse(), all, a({ difficulty: 'high', size: 'large' }), NOW))).toEqual(order(r))
  })
  it('a plug-in\'s strength or cost adjustment is a note on its candidate, never the order', () => {
    const boost: RoutePlugin = { name: 'Boost', adjust: c => c.machineName === 'zeta' ? { strength: 5, cost: -10, reason: 'measured twice as good here' } : null }
    const r = ok(choose([on('zeta', STRONG), on('alpha', STRONG)], all, a(), NOW, [], [], [], [boost]))
    expect(r.shown.map(s => s.machineName)).toEqual(['alpha', 'zeta'])
    expect(r.shown[1]!.notes).toEqual(['Boost: measured twice as good here'])
    expect(r.shown[1]!.label).toContain('Boost: measured twice as good here')
    expect(r.adjusted).toBe(true)
  })
  it('names no pick: its why sends the choice to the Routing instructions, and the record carries no pick', () => {
    const c = ok(choose([on('zeta', STRONG), on('alpha', CHEAP)], all, a(), NOW))
    const v = decide(c)
    expect(v).not.toHaveProperty('pick')
    expect(v).toMatchObject({ via: 'instructions', p: null })
    expect(v.why).toContain('Routing instructions')
    expect(v.why).not.toMatch(/strength|price/i)
    const record = recordOf(c, v, a())
    expect(record).not.toHaveProperty('pick')
    expect(record).toMatchObject({ via: 'instructions', why: v.why })
    // A backend from before this takes only a record with a pick: c0 stands in for one, as the old order would have named it.
    expect(recordOf(c, v, a(), 'picked')).toMatchObject({ pick: 'c0', via: 'order' })
    expect(recordOf(c, v, a(), 'v1')).toMatchObject({ pick: 'c0', via: 'order' })
    expect(decide(ok(choose([on('alpha', CHEAP)], all, a(), NOW)))).toMatchObject({ via: 'only' })
  })
  it('still leaves out what cannot run, a plug-in\'s refusal among it', () => {
    const fence: RoutePlugin = { name: 'Fit', adjust: c => c.machineName === 'mid' ? { refuse: true, reason: 'no disk for an end-to-end run' } : null }
    const r = ok(choose([on('zeta', STRONG, undefined), on('alpha', { ...STRONG, refusals: ['Machine is offline.'] }), on('mid', CHEAP)], all, a(), NOW, [], [], [], [fence]))
    expect(r.shown.map(s => s.machineName)).toEqual(['zeta'])
    expect(r.excluded).toEqual([{ title: 'New agent · Claude opus high · alpha', reason: 'Machine is offline.', machine: 'alpha' },
      { title: 'New agent · Claude haiku auto · mid', reason: 'Fit: no disk for an end-to-end run', machine: 'mid' }])
  })
  it('keeps every fact on each candidate: strength, price, quota fit, weekly % left and reset, the agents on its machine', () => {
    const load = { agents: 3, freeMemoryBytes: 8e9, hasFolder: true }
    const r = ok(choose([on('alpha', { ...CODEX, load }, windows([60, 2 * H], [42, 3 * D + 5 * H], 'AX')), on('zeta', STRONG)], all, a(), NOW))
    const alpha = r.shown[0]!
    expect(alpha.label).toContain('strength 3, cost 2')
    expect(alpha.label).toContain('weekly 42% left (resets in 3 days)')
    expect(alpha.label).toContain('3 agents running')
    expect(alpha.fit).toMatchObject({ status: 'fits', account: 'AX' })
    expect(quotaBrief(alpha, NOW)).toBe('fits: weekly 42% left, resets in 3d5h')
  })
  it('says when no candidate is expected to cover the task, naming none as first', () => {
    const spent = windows([90, 3 * H], [0, 5 * D])
    const none = ok(choose([on('alpha', CHEAP, spent), on('zeta', STRONG, spent)], all, a(), NOW))
    expect(none.short).toBe('No candidate is expected to cover this task on its quota.')
    // One that fits is in the list with its fit; nothing is said of a first candidate, since there is none.
    expect(ok(choose([on('alpha', CHEAP), on('zeta', STRONG, spent)], all, a(), NOW)).short).toBeUndefined()
  })
})

const frame = (patch: Partial<MemberFrame> = {}): MemberFrame => ({ title: 'Fix auth', project: 'api', cwd: '/w/api', root: '/w/api', remote: 'github.com/acme/api', branch: 'feat/auth', updatedAt: 1_000_000 - 2 * 3_600_000, ...patch })
const folder = (patch: Partial<TaskFolder> = {}): TaskFolder => ({ cwd: '/w/api', kind: 'git', name: 'api', root: '/w/api', remote: 'github.com/acme/api', ...patch })

describe('verdict and record', () => {
  const choice = () => { const r = choose([probe({ kind: 'member', agentId: 'a1', name: 'Multiply', activity: 'idle' }), probe({ machineName: 'mac' })], policy, a()); if ('error' in r) throw new Error('x'); return r }
  it('names no pick, and says when it was the only candidate', () => {
    expect(decide(choice())).toEqual({ via: 'instructions', p: null, why: CHOOSE_BY_INSTRUCTIONS })
    expect(decide(ok(choose([probe()], policy, a())))).toMatchObject({ via: 'only', p: null })
  })
  it('produces a record the backend schema accepts, with no floor and no policy notes', () => {
    const c = choice(), v = decide(c)
    const v1 = { assessment: { difficulty: 'medium', risk: 'low', why: 'API change.' },
      candidates: c.shown.map(s => ({ id: s.id, kind: s.kind, ...(s.agentId ? { agentId: s.agentId } : {}), machineId: s.machineId,
        engine: s.engine, model: s.model, effort: s.effort, quality: s.quality, cost: s.cost, title: s.title, label: s.label })),
      excluded: [], floor: 1, notes: false, pick: 'c0', via: 'order', p: null, belowFloor: false, why: v.why }
    const { pick: _pick, ...unpicked } = v1
    expect(recordOf(c, v, a())).toEqual({ ...unpicked, via: 'instructions', assessment: { ...v1.assessment, size: 'medium' },
      candidates: v1.candidates.map(x => ({ ...x, fit: { status: 'unknown', coverage: null, effectiveCost: 2, expiring: 0, spend: { '5-hour': 30, weekly: 4 }, account: 'm1:claude' } })) })
    // The server stamps the instructions' revision; the route sends none (phase 4, decision 12).
    expect(recordOf(c, v, a())).not.toHaveProperty('instructionsRevision')
    // For a backend from before sizes and fit.
    expect(recordOf(c, v, a(), 'v1')).toEqual(v1)
    // The task's kind is recorded, so attempts can be compared by the kind of job they were (backend costs/read.ts).
    expect(recordOf(c, v, a({ kind: 'ui' })).assessment).toEqual({ difficulty: 'medium', risk: 'low', why: 'API change.', size: 'medium', kind: 'ui' })
    // A backend from before kinds gets everything else; one from before phase 1 gets neither.
    expect(recordOf(c, v, a({ kind: 'ui' }), 'unkinded').assessment).toEqual({ difficulty: 'medium', risk: 'low', why: 'API change.', size: 'medium' })
    expect(object(recordOf(c, v, a({ kind: 'ui' }), 'v1').assessment)).not.toHaveProperty('kind')
  })
})

describe('edges', () => {
  const unknownQuota = { known: false, leftPercent: null, resetsAt: null }
  const ok = (r: ReturnType<typeof choose>) => { if ('error' in r) throw new Error('x'); return r }
  it('rejects a bad risk or a missing why and ignores malformed needs', () => {
    expect(parseAssessment({ difficulty: 'low', risk: 'urgent', why: 'x' })).toContain('risk')
    expect(parseAssessment({ difficulty: 'low', risk: 'low', why: 7 })).toContain('why')
    expect(parseAssessment({ difficulty: 'low', risk: 'low', why: 'x', needs: null }))
      .toEqual({ difficulty: 'low', risk: 'low', size: 'medium', why: 'x', needs: { tools: [], devices: [] } })
    expect(parseAssessment({ difficulty: 'low', risk: 'low', why: 'x', needs: { tools: 'git', devices: [1], cwd: 5 } })).toContain('absolute')
    expect(parseAssessment({ difficulty: 'low', risk: 'low', why: 'x', needs: { devices: ['cam'], cwd: '/work' } }))
      .toEqual({ difficulty: 'low', risk: 'low', size: 'medium', why: 'x', needs: { tools: [], devices: ['cam'], cwd: '/work' } })
  })
  it('keeps the tightest window whatever its order and drops an unusable reset', () => {
    expect(quotaOf2({ known: true, windows: [{ usedPercent: 70, resetsAt: 1_800_000_000 }, { usedPercent: 20, resetsAt: null }] }))
      .toMatchObject({ known: true, leftPercent: 30, resetsAt: 1_800_000_000_000 })
    expect(quotaOf2({ known: true, windows: [{ usedPercent: 20, resetsAt: null }] }).resetsAt).toBeNull()
    expect(quotaOf2({ known: true, windows: [{ usedPercent: 130, resetsAt: null }] }).leftPercent).toBe(0)
  })
  it('rates default models, and leaves unknown models and unknown engines unrated', () => {
    expect(rate(policy, 'codex', null, null)).toEqual({ quality: 3, cost: 2 })
    expect(rate(policy, 'claude', 'sonnet', null)).toEqual({ quality: 2, cost: 2 })
    expect(rate(policy, 'codex', 'gpt-x', 'high')).toBeNull()
    expect(rate(policy, 'codex', 'gpt-x', 'high', true)).toEqual({ quality: 3, cost: 2 })
    // A small model it reports is never promoted by its launch (review of ee4ee6c9a).
    expect(rate(policy, 'codex', 'gpt-5.5-mini', 'high', true)).toBeNull()
    expect(rate(policy, 'codex', 'gpt-5-nano', 'high', true)).toBeNull()
    expect(rate(policy, 'claude', null, null, true)).toBeNull()
    expect(rate(policy, 'other', 'gpt-x', 'high')).toBeNull()
  })
  it('rates a working member by the model its engine reported, not only by the catalog alias', () => {
    expect(rate(policy, 'claude', 'claude-opus-4-7', 'high')).toEqual({ quality: 3, cost: 3 })
    expect(rate(policy, 'claude', 'claude-opus-4-7', 'xhigh')).toEqual({ quality: 3, cost: 3 })
    expect(rate(policy, 'claude', 'claude-sonnet-4-5[1m]', 'medium')).toEqual({ quality: 2, cost: 2 })
    expect(rate(policy, 'claude', 'sonnet[1m]', null)).toEqual({ quality: 2, cost: 2 })
    expect(rate(policy, 'claude', 'claude-haiku-4-5', 'auto')).toEqual({ quality: 1, cost: 1 })
    // Codex reports a real slug; its catalog row is `default`, for an agent launched on the engine's own model.
    expect(rate(policy, 'codex', 'gpt-5.5', 'high', true)).toEqual({ quality: 3, cost: 2 })
    expect(rate(policy, 'codex', 'gpt-5.5', 'high')).toBeNull()
    // A model that matches nothing and an engine without a default row are unrated.
    expect(rate(policy, 'claude', 'claude-mystery-1', 'high')).toBeNull()
  })
  it('titles and labels nameless members, unknown quota and quota without a reset', () => {
    const r = ok(choose([
      probe({ kind: 'member', agentId: 'a1', quota: { known: true, leftPercent: null, resetsAt: null } }),
      probe({ machineName: 'mac', quota: { known: true, leftPercent: 40, resetsAt: null } }),
    ], policy, a()))
    expect(r.shown.map(s => s.title)).toEqual(['New agent · Claude sonnet medium · mac', 'Member · Claude sonnet medium · remote-1'])
    expect(r.shown[1].label).toContain('Member ·')
    expect(r.shown[1].label).toContain('quota unknown')
    expect(r.shown[0].label).toContain('quota 40% left')
    expect(ok(choose([probe({ known: false, quota: unknownQuota })], policy, a())).shown[0].label).toContain('quota unknown')
    expect(ok(choose([probe({ quota: { known: true, leftPercent: 50, resetsAt: 0 } })], policy, a())).shown[0].label).toContain('resets in 1m')
  })
  it('tells how far away a reset is, which reads the same whenever the log is opened', () => {
    const label = (resetsAt: number) => ok(choose([probe({ quota: { known: true, leftPercent: 50, resetsAt } })], policy, a(), 1_000_000)).shown[0].label
    expect(label(1_000_000 + 30 * 60_000)).toContain('quota 50% left, resets in 30m')
    expect(label(1_000_000 + 2 * 3_600_000)).toContain('resets in 2h')
    expect(label(1_000_000 + 4.5 * 3_600_000)).toContain('resets in 4h30')
    expect(label(1_000_000 + 20 * 3_600_000)).toContain('resets in 20h')
    expect(label(1_000_000 + 5 * 86_400_000)).toContain('resets in 5 days')
    expect(label(1_000_000 - 5_000)).toContain('resets in 1m')
    // Without a clock argument it reads the real one.
    const soon = { known: true, leftPercent: 50, resetsAt: Date.now() + 3 * 3_600_000 }
    expect(ok(choose([probe({ quota: soon })], policy, a())).shown[0].label).toContain('resets in 3h')
  })
  it('shows unknown probes, and lists every candidate in one order whatever the order they came in', () => {
    expect(ok(choose([probe({ known: false, quota: unknownQuota })], policy, a())).shown).toHaveLength(1)
    const tie = ok(choose([
      probe({ machineName: 'b', quota: unknownQuota }), probe({ machineName: 'a', quota: unknownQuota }),
      probe({ kind: 'member', agentId: 'a1', name: 'M', machineName: 'z', quota: unknownQuota }),
    ], policy, a()))
    expect(tie.shown.map(s => s.title.split(' · ')[2])).toEqual(['a', 'b', 'z'])
    // By machine name, a member or not.
    expect(ok(choose([probe({ machineName: 'b' }), probe({ kind: 'member', agentId: 'a1', name: 'M' })], policy, a())).shown[0].kind).toBe('new')
    expect(ok(choose([probe({ kind: 'member', agentId: 'a1', name: 'M' }), probe({ machineName: 'b' })], policy, a())).shown[0].kind).toBe('new')
  })
  it('shows a candidate low on quota or unknown beside the others, in machine order', () => {
    const low = { known: true, leftPercent: 5, resetsAt: null }
    const r = ok(choose([probe({ quality: 1 }), probe({ quality: 3, machineName: 'mac', quota: low })], policy, a({ difficulty: 'high' })))
    expect(r.shown.map(s => s.title)).toEqual(['New agent · Claude sonnet medium · mac', 'New agent · Claude sonnet medium · remote-1'])
    const u = ok(choose([probe({ quality: 1 }), probe({ quality: 3, machineName: 'mac', known: false, quota: unknownQuota })], policy, a({ difficulty: 'high' })))
    expect(u.shown.map(s => s.title)).toEqual(['New agent · Claude sonnet medium · mac', 'New agent · Claude sonnet medium · remote-1'])
  })
  it('trims what the record carries to the backend limits', () => {
    const long = 'x'.repeat(900)
    const r = ok(choose([probe({ kind: 'member', agentId: 'a_1-B', name: long, machineId: 'm-1_X', notes: [long, long] }), probe({ machineName: long })], policy, a()))
    const rec = recordOf({ ...r, excluded: Array.from({ length: 250 }, () => ({ title: long.slice(0, 160), reason: long })) },
      decide(r), a()) as { candidates: Array<Record<string, string>>; excluded: Array<{ reason: string }>; why: string; notes: boolean; p: number | null }
    expect(rec.candidates.every(c => /^c\d{1,2}$/.test(c.id) && c.title.length <= 160 && c.label.length <= 640 && /^[A-Za-z0-9_-]+$/.test(c.machineId))).toBe(true)
    expect(rec.excluded).toHaveLength(200)
    expect(rec.excluded.every(e => e.reason.length <= 500)).toBe(true)
    expect(rec.why.length).toBeLessThanOrEqual(300)
    expect(rec.notes).toBe(false)
    expect(rec.p).toBeNull()
  })
})

describe('candidate labels', () => {
  const now = 1_000_000
  const members = (patch: Partial<Probe> = {}) => ok(choose([
    probe({ kind: 'member', agentId: 'a1', name: 'Multiply', activity: 'idle', frame: frame(), repo: 'same', earlier: [{ group: 'API', outcome: 'done' }], ...patch }),
    probe({ machineName: 'mac', load: { agents: 3, freeMemoryBytes: 6.5e9, hasFolder: true } }),
  ], policy, a(), now))

  it('tells what a member is doing, where, and whether it is the task\'s repository', () => {
    const label = members().shown.find(s => s.kind === 'member')!.label
    expect(label).toContain('same repo')
    expect(label).toContain('on "Fix auth"')
    expect(label).toContain('api, branch feat/auth')
    expect(label).toContain('last active 2h ago')
    expect(label).toContain('earlier here: API done')
    expect(members({ repo: 'different' }).shown.find(s => s.kind === 'member')!.label).toContain('different repo')
    expect(members({ repo: 'unknown' }).shown.find(s => s.kind === 'member')!.label).toContain('repo unknown')
    expect(members({ repo: undefined }).shown.find(s => s.kind === 'member')!.label).not.toMatch(/repo/)
  })
  it('says unknown for a member whose activity could not be read, and shows what is missing from a frame', () => {
    const none = members({ frame: null, repo: 'unknown', earlier: [] }).shown.find(s => s.kind === 'member')!.label
    expect(none).toContain('activity unknown')
    expect(none).not.toContain('earlier here')
    const bare = members({ frame: frame({ title: null, project: null, branch: null, updatedAt: null }) }).shown.find(s => s.kind === 'member')!.label
    expect(bare).toContain('last active unknown')
    expect(bare).not.toMatch(/on "|branch/)
    const noBranch = members({ frame: frame({ branch: null }) }).shown.find(s => s.kind === 'member')!.label
    expect(noBranch).toContain('in api')
    expect(noBranch).not.toContain('branch')
    expect(members({ frame: frame({ project: null, branch: 'main' }) }).shown.find(s => s.kind === 'member')!.label).toContain('branch main')
    expect(members({ frame: frame({ updatedAt: 1_000_000 + 5_000 }) }).shown.find(s => s.kind === 'member')!.label).toContain('last active 1m ago')
  })
  it('tells what a new agent starts on: the task folder, the agents running and the memory free', () => {
    const label = members().shown.find(s => s.kind === 'new')!.label
    expect(label).toContain('has the task folder')
    expect(label).toContain('3 agents running')
    expect(label).toContain('6.5 GB memory free')
    const one = ok(choose([probe({ load: { agents: 1, freeMemoryBytes: 2.5e8, hasFolder: false } })], policy, a(), now)).shown[0].label
    expect(one).toContain('no task folder')
    expect(one).toContain('1 agent running')
    expect(one).toContain('250 MB memory free')
    const unknown = ok(choose([probe({ load: { agents: null, freeMemoryBytes: null, hasFolder: null } })], policy, a(), now)).shown[0].label
    expect(unknown).toContain('agents running unknown · free memory unknown')
    expect(unknown).not.toMatch(/folder/)
    expect(ok(choose([probe({ load: { agents: 2, freeMemoryBytes: null, hasFolder: null } })], policy, a(), now)).shown[0].label).toContain('2 agents running · free memory unknown')
    expect(ok(choose([probe()], policy, a(), now)).shown[0].label).not.toMatch(/running|memory|folder/)
  })
  it('puts earlier work before the quota, so a length cut removes the quota first', () => {
    const label = members().shown.find(s => s.kind === 'member')!.label
    expect(label.indexOf('earlier here')).toBeLessThan(label.indexOf('quota'))
  })
  it('lists every quota window with what is left and when it resets', () => {
    const quota = { known: true, leftPercent: 40, resetsAt: now + 2 * 3_600_000, windows: [
      { name: '5-hour', leftPercent: 40, resetsAt: now + 2 * 3_600_000 }, { name: 'weekly', leftPercent: 90, resetsAt: now + 5 * 86_400_000 }, { name: null, leftPercent: 75, resetsAt: null }] }
    const label = ok(choose([probe({ quota })], policy, a(), now)).shown[0].label
    expect(label).toContain('quota 5-hour 40% left (resets in 2h), weekly 90% left (resets in 5 days), window 75% left')
  })
})

describe('repositoryKey', () => {
  it('names a repository the same way over HTTPS and SSH, without credentials or case', () => {
    for (const url of ['https://github.com/Acme/App.git', 'https://someone:secret@github.com/acme/app/', 'git@github.com:Acme/App.git',
      'ssh://git@github.com:22/acme/app.git', ' HTTPS://GitHub.com/acme/app ']) expect(repositoryKey(url)).toBe('github.com/acme/app')
  })
  it('keeps nothing of a query or fragment, where a credential can be too', () => {
    for (const url of ['https://example.test/Acme/Repo.git?access_token=SYNTHETIC_SECRET', 'https://example.test/acme/repo#token=SYNTHETIC_SECRET',
      'git@example.test:acme/repo.git?access_token=SYNTHETIC_SECRET', 'ssh://git@example.test/acme/repo.git#SYNTHETIC_SECRET']) {
      expect(repositoryKey(url)).toBe('example.test/acme/repo')
    }
  })
  it('names nothing for a folder on disk or an address it cannot read', () => {
    for (const url of ['/srv/remote.git', 'file:///srv/remote.git', '', 'https://github.com', 'not a url']) expect(repositoryKey(url)).toBeNull()
  })
})

describe('repoMatch', () => {
  it('marks a member as in the task\'s repository by remote, then root, then folder', () => {
    expect(repoMatch(null, frame(), true)).toBeUndefined()
    expect(repoMatch(folder(), null, true)).toBe('unknown')
    expect(repoMatch(folder({ kind: 'unknown' }), frame(), true)).toBe('unknown')
    // The same remote is the same repository wherever the checkout is.
    expect(repoMatch(folder(), frame({ cwd: '/other/api', root: '/other/api' }), false)).toBe('same')
    expect(repoMatch(folder(), frame({ remote: 'github.com/acme/web' }), true)).toBe('different')
    expect(repoMatch(folder({ remote: null }), frame({ remote: null }), true)).toBe('same')
    expect(repoMatch(folder({ remote: null }), frame({ remote: null, root: '/w/web', cwd: '/w/web' }), true)).toBe('different')
    // Paths on two machines say nothing without a remote.
    expect(repoMatch(folder({ remote: null }), frame({ remote: null, root: '/w/web', cwd: '/w/web' }), false)).toBe('unknown')
    expect(repoMatch(folder({ kind: 'none', root: null, remote: null }), frame({ root: null, remote: null }), true)).toBe('same')
    expect(repoMatch(folder({ kind: 'none', root: null, remote: null }), frame({ root: null, remote: null, cwd: '/w/else' }), true)).toBe('different')
    expect(repoMatch(folder({ kind: 'none', root: null, remote: null }), frame({ root: null, remote: null, cwd: null }), true)).toBe('unknown')
    // A task folder inside a repository is judged by the repository's root.
    expect(repoMatch(folder({ cwd: '/w/api/sub', remote: null }), frame({ remote: null }), true)).toBe('same')
    // The Lead's machine may not have the folder at all: a member standing in it is in it, on any machine.
    const missing = folder({ kind: 'missing', root: null, remote: null, name: null })
    expect(repoMatch(missing, frame({ remote: null, root: '/w/api', cwd: '/w/api' }), false)).toBe('same')
    expect(repoMatch(missing, frame({ remote: null, root: '/w/api-wt', cwd: '/w/api' }), false)).toBe('same')
    expect(repoMatch(missing, frame({ remote: null, root: '/w/web', cwd: '/w/web' }), false)).toBe('unknown')
    expect(repoMatch(missing, frame({ remote: null, root: '/w/web', cwd: '/w/web' }), true)).toBe('different')
  })
})

describe('local models on the Swarm\'s grid', () => {
  const local = (patch: Partial<Probe> = {}) => probe({ model: 'default', effort: 'default', quality: 1, cost: 1, quota: { known: false, leftPercent: null, resetsAt: null },
    gridModel: 'qwen3', gridName: 'swarm-0123456789ab', gridLabel: 'Qwen 3', ...patch })
  it('reads local only as true, and leaves it out otherwise', () => {
    expect(parseAssessment({ difficulty: 'low', risk: 'low', why: 'x', local: true })).toMatchObject({ local: true })
    expect(parseAssessment({ difficulty: 'low', risk: 'low', why: 'x', local: false })).not.toHaveProperty('local')
    expect(parseAssessment({ difficulty: 'low', risk: 'low', why: 'x', local: 'yes' })).toContain('local')
  })
  it('fits a local model on no subscription, names it as local and records where it is served', () => {
    const r = ok(choose([local()], policy, a({ difficulty: 'low', kind: 'docs' }), NOW))
    expect(r.shown[0]).toMatchObject({ title: 'New agent · Claude on Qwen 3 (local) · remote-1', fit: { status: 'fits', account: 'local:swarm-0123456789ab:qwen3' } })
    expect(r.shown[0]!.label).toContain('Claude on Qwen 3 (local)')
    expect((recordOf(r, decide(r), a()) as { candidates: unknown[] }).candidates[0]).toMatchObject({ gridModel: 'qwen3', gridName: 'swarm-0123456789ab' })
    // Without a name or a label: the model stands for both, and nothing about the grid is recorded without a grid.
    const bare = ok(choose([local({ gridName: undefined, gridLabel: undefined })], policy, a({ difficulty: 'low', kind: 'docs' }), NOW))
    expect(bare.shown[0]).toMatchObject({ title: 'New agent · Claude on qwen3 (local) · remote-1', fit: { account: 'local::qwen3' } })
    expect((recordOf(bare, decide(bare), a()) as { candidates: unknown[] }).candidates[0]).not.toHaveProperty('gridModel')
  })
  it('lists a local model after its machine\'s engines, and keeps it beside a subscription row of the same name', () => {
    const r = ok(choose([local(), probe()], policy, a({ kind: 'docs' }), NOW))
    expect(r.shown.map(s => s.gridModel)).toEqual([undefined, 'qwen3'])
    // Same machine, engine, model and effort as a subscription `default` row: both stay, being different models.
    const both = ok(choose([probe({ model: 'default', effort: 'default', quality: 1, cost: 1, quota: windows([80, 3 * H], [90, 5 * D]) }), local()], policy, a({ difficulty: 'low', kind: 'docs' }), NOW))
    expect(both.shown).toHaveLength(2)
  })
  it('considers only local models when a person asked for one, whatever the floor, and says when none is served', () => {
    const r = ok(choose([probe({ model: 'opus', effort: 'high', quality: 3, cost: 3 }), local()], policy, a({ difficulty: 'high', local: true }), NOW))
    expect(r.shown.map(s => s.gridModel)).toEqual(['qwen3'])
    expect(r.belowFloor).toBe(false)
    expect(choose([probe()], policy, a({ local: true }), NOW)).toEqual({ error: 'NO_CANDIDATE', excluded: [{ title: 'Local models', reason: LOCAL_NONE }] })
  })

  it('offers only the model a person named, whatever its strength, and says when nothing runs it', () => {
    const api = local({ gridModel: 'deepseek/deepseek-v4.1-flash-1017', gridLabel: 'deepseek/deepseek-v4.1-flash-1017 · OpenRouter', gridKind: 'api' })
    const older = local({ gridModel: 'DeepSeek-V4-Flash-0731', gridLabel: undefined, gridKind: 'shared' })
    const opus = probe({ model: 'opus', effort: 'high', quality: 3, cost: 3, quota: windows([80, 3 * H], [90, 5 * D]) })
    const r = ok(choose([opus, older, api], policy, a({ difficulty: 'high', model: 'deepseek 4.1 flash' }), NOW))
    expect(r.shown.map(s => s.gridModel)).toEqual(['deepseek/deepseek-v4.1-flash-1017'])
    expect(r.shown[0]!.title).toBe('New agent · Claude on deepseek/deepseek-v4.1-flash-1017 · OpenRouter (API) · remote-1')
    expect(r.belowFloor).toBe(false)
    // A subscription model by name, and the engine's name counts as one of its words.
    expect(ok(choose([opus, api], policy, a({ model: 'Claude Opus' }), NOW)).shown.map(s => s.model)).toEqual(['opus'])
    expect(ok(choose([older], policy, a({ difficulty: 'low', kind: 'docs' }), NOW)).shown[0]!.title).toContain('(shared)')
    expect(choose([opus], policy, a({ model: 'gpt 9' }), NOW)).toEqual({ error: 'NO_CANDIDATE',
      excluded: [{ title: 'Named model', reason: 'No candidate runs "gpt 9". Share it with the Swarm (Your models), or check its name.' }] })
    expect(parseAssessment({ difficulty: 'low', risk: 'low', why: 'x', model: ' deepseek 4.1 flash ' })).toMatchObject({ model: 'deepseek 4.1 flash' })
    expect(parseAssessment({ difficulty: 'low', risk: 'low', why: 'x', model: '...' })).toContain('model')
    expect(parseAssessment({ difficulty: 'low', risk: 'low', why: 'x', model: 7 })).toContain('model')
    expect(parseAssessment({ difficulty: 'low', risk: 'low', why: 'x', model: 'x'.repeat(201) })).toContain('model')
  })

  it('offers the agent already on a named model, and says who holds a named or local model it cannot offer', () => {
    // A member running the named model is a candidate like any other.
    const wren = probe({ kind: 'member', agentId: 'wren', name: 'Wren', model: 'deepseek/deepseek-v4.1-flash-1017', effort: 'xhigh', quality: 1, cost: 1 })
    expect(ok(choose([probe(), wren], policy, a({ model: 'deepseek 4.1 flash' }), NOW)).shown.map(s => s.agentId)).toEqual(['wren'])
    const ds = { model: 'deepseek/deepseek-v4.1-flash-1017', label: 'deepseek/deepseek-v4.1-flash-1017 · OpenRouter', kind: 'api' as const, holders: ['Wren', 'Ada', 'Bo', 'Cy'] }
    const qwen = { model: 'qwen3:4b', label: 'Qwen 3 4B', kind: 'local' as const, holders: ['Faye'] }
    expect(choose([probe()], policy, a({ model: 'deepseek 4.1 flash' }), NOW, [], [qwen, ds])).toEqual({ error: 'NO_CANDIDATE', excluded: [{ title: 'Named model',
      reason: `"deepseek/deepseek-v4.1-flash-1017 · OpenRouter" is shared with the Swarm, but Wren, Ada, Bo and Cy are on it: an API model takes ${API_BUILDERS} agents at a time. Assign the work to one of them once it is free, or stop one to free the model.` }] })
    // A name nothing holds, on an engine no machine here runs, still reads as not shared.
    expect(choose([probe()], policy, a({ model: 'gpt 9' }), NOW, [], [qwen])).toMatchObject({ excluded: [{ reason: expect.stringContaining('No candidate runs "gpt 9"') }] })
    expect(choose([probe()], policy, a({ local: true }), NOW, [], [qwen])).toEqual({ error: 'NO_CANDIDATE', excluded: [{ title: 'Local models',
      reason: '"Qwen 3 4B" is shared with the Swarm, but Faye is on it: a local model serves one agent at a time. Assign the work to that agent once it is free, or stop it to free the model.' }] })
    expect(LOCAL_NONE).toContain('Your models')
  })

  it('rates a grid model by the catalog\'s first named grid row it matches, else the grid\'s strength', () => {
    const rows = { ...policy, grid: { strength: 1, models: [{ model: 'kimi k3', strength: 2 }, { model: 'deepseek v4.1', strength: 3 }] } }
    expect(gridStrength(rows, 'moonshotai/kimi-k3')).toBe(2)
    expect(gridStrength(rows, 'ds-1017', 'DeepSeek V4.1 Flash')).toBe(3)
    expect(gridStrength(rows, 'qwen3:4b')).toBe(1)
    expect(gridStrength({ ...policy, grid: { strength: 2, models: [] } }, 'moonshotai/kimi-k3')).toBe(2)
    expect(gridStrength(policy, 'moonshotai/kimi-k3')).toBe(1)
  })
})

// Project instructions, phase 4: the route leaves out only what cannot run, and shows the rest with their facts; since task
// #2901 it ranks none of them. Rules, floors and kinds are gone; what they said is a note on the candidate.
describe('facts, not ranking', () => {
  const NOTE = 'Not offered by default: no Engineer runs on Claude Sonnet or Claude Haiku (Ken and Dee, 2026-10-30).'
  const catalog: Catalog = { models: [
    { engine: 'claude', model: 'opus', effort: 'high', strength: 3, cost: 3, offered: true },
    { engine: 'codex', model: 'default', effort: 'default', strength: 3, cost: 2, offered: true },
    { engine: 'claude', model: 'sonnet', effort: 'medium', strength: 2, cost: 2, offered: false, note: NOTE },
    { engine: 'claude', model: 'haiku', effort: 'auto', strength: 1, cost: 1, offered: false, note: NOTE },
  ], grid: { strength: 1, models: [{ model: 'kimi k3', strength: 2 }] } }
  const fits = windows([90, 4 * H], [80, 5 * D])
  const at = (patch: Partial<Probe>) => probe({ notes: [], quota: fits, ...patch })
  const opus = at({ machineId: 'm1', machineName: 'a', model: 'opus', effort: 'high', quality: 3, cost: 3 })
  const codex = at({ machineId: 'm1', machineName: 'a', engine: 'codex', model: 'default', effort: 'default', quality: 3, cost: 2 })
  const sonnet = at({ machineId: 'm1', machineName: 'a', model: 'sonnet', effort: 'medium', quality: 2, cost: 2 })
  const kimi = at({ machineId: 'm1', machineName: 'a', model: 'default', effort: 'default', quality: 2, cost: 1, quota: { known: false, leftPercent: null, resetsAt: null },
    gridModel: 'moonshotai/kimi-k3', gridName: 'swarm-g', gridLabel: 'Kimi K3', gridKind: 'api' })
  const qwen = at({ ...kimi, quality: 1, gridModel: 'qwen3:4b', gridLabel: 'Qwen 3 4B', gridKind: 'local' })
  const offline = at({ machineId: 'm9', machineName: 'gone', model: 'opus', effort: 'high', quality: 3, cost: 3, refusals: ['Machine is offline or unreachable.'] })
  const shownOf = (r: ReturnType<typeof choose>) => ok(r).shown.map(s => s.gridModel ?? `${s.engine} ${s.model}`)

  it('leaves out only what cannot run', () => {
    const risky = a({ difficulty: 'high', risk: 'high' })
    const r = ok(choose([offline, opus, codex, sonnet, kimi, qwen], catalog, risky, NOW))
    expect(r.excluded).toEqual([{ title: 'New agent · Claude opus high · gone', reason: 'Machine is offline or unreachable.', machine: 'gone' }])
    // A grid model for a high-risk build and a strength-1 model for a high-difficulty task are offered; Sonnet is not, unnamed.
    expect(shownOf(r)).toEqual(expect.arrayContaining(['moonshotai/kimi-k3', 'qwen3:4b', 'claude opus', 'codex default']))
    expect(shownOf(r)).not.toContain('claude sonnet')
    expect(r).toMatchObject({ floor: 1, belowFloor: false })
    // Named, Sonnet is offered, with the catalog's note in its notes and its line.
    const named = ok(choose([opus, codex, sonnet], catalog, a({ model: 'sonnet' }), NOW))
    expect(named.shown.map(s => s.model)).toEqual(['sonnet'])
    expect(named.shown[0]!.notes).toEqual([NOTE])
    expect(named.shown[0]!.label).toContain(NOTE)
    // A member already on Sonnet is a candidate, with the same note.
    const member = ok(choose([{ ...sonnet, kind: 'member', agentId: 'a1', name: 'Multiply' }], catalog, a(), NOW))
    expect(member.shown[0]).toMatchObject({ agentId: 'a1', notes: [NOTE] })
  })

  it('lists by machine and engine, never by strength, price, quota fit or idle members (task #2901)', () => {
    expect(shownOf(choose([kimi, opus, codex], catalog, a(), NOW))).toEqual(['claude opus', 'codex default', 'moonshotai/kimi-k3'])
    // A strong candidate short of quota is shown, with fit short.
    const short = at({ ...opus, machineId: 'm2', machineName: 'b', quota: windows([20, 4 * H], [80, 5 * D]) })
    const r = ok(choose([short, opus], catalog, a(), NOW))
    expect(r.shown.map(s => [s.machineName, s.fit.status])).toEqual([['a', 'fits'], ['b', 'short']])
    expect(r.excluded).toEqual([])
    // An idle member is not placed before a new agent: reusing one is the Routing instructions' rule 3.
    const member = { ...codex, kind: 'member' as const, agentId: 'a1', name: 'Zed' }
    expect(ok(choose([codex, member], catalog, a(), NOW)).shown.map(s => s.kind)).toEqual(['new', 'member'])
  })

  it('offers a named model the catalog does not list, unrated', () => {
    const elsewhere = { ...opus, machineId: 'm2', machineName: 'b' }
    const gpt = ok(choose([opus, codex, elsewhere], catalog, a({ model: 'gpt-6.2' }), NOW))
    expect(gpt.shown.map(s => [s.engine, s.model, s.machineName, s.unrated])).toEqual([['codex', 'gpt-6.2', 'a', true]])
    expect(gpt.shown[0]!.label).toContain('unrated')
    const claude = ok(choose([opus, codex, elsewhere], catalog, a({ model: 'claude-opus-6' }), NOW))
    expect(claude.shown.map(s => [s.engine, s.model, s.machineName])).toEqual([['claude', 'claude-opus-6', 'a'], ['claude', 'claude-opus-6', 'b']])
    expect(claude.shown.every(s => s.unrated && s.quality === 1 && s.label.includes('unrated'))).toBe(true)
    // With no machine of that engine, nothing runs it, and the route says so.
    expect(choose([opus], catalog, a({ model: 'gpt-6.2' }), NOW)).toMatchObject({ error: 'NO_CANDIDATE',
      excluded: [{ title: 'Named model', reason: expect.stringContaining('No candidate runs "gpt-6.2"') }] })
  })

  // Final review: "kimi k3" with its host down became "New agent · Codex kimi-k3 default", unrated; the fact is that nothing
  // serves it now, and the route says so.
  it('offers no unrated stand-in for a named model of the grid that nothing serves now', () => {
    const none = (r: ReturnType<typeof choose>) => { expect(r).toMatchObject({ error: 'NO_CANDIDATE' }); return (r as { excluded: unknown[] }).excluded }
    // A catalog grid row, in the person's words or the served id.
    for (const model of ['kimi k3', 'moonshotai/kimi-k3', 'Kimi']) {
      expect(none(choose([opus, codex], catalog, a({ model }), NOW))).toEqual([{ title: 'Named model', reason: expect.stringContaining(`No candidate runs "${model}"`) }])
    }
    // A model a host now offline served, which the catalog does not name.
    expect(none(choose([opus, codex], catalog, a({ model: 'qwen coder' }), NOW, [], [], [{ title: 'Qwen Coder 32B', reason: 'Its host Rig is offline, so an agent on it would never start.' }])))
      .toEqual([{ title: 'Named model', reason: expect.stringContaining('No candidate runs "qwen coder"') }])
    // A model neither names is still offered unrated.
    expect(ok(choose([opus, codex], catalog, a({ model: 'gpt-6.2' }), NOW, [], [], [{ title: 'Qwen Coder 32B', reason: 'offline' }])).shown[0]).toMatchObject({ model: 'gpt-6.2', unrated: true })
  })

  it('reads the catalog the backend serves, or one derived from an older backend\'s policy', () => {
    const served = { policy: { version: 1, models: [] }, catalog: { models: catalog.models, grid: catalog.grid, priors: {}, prices: [] } }
    // A Codex row at `default` is kept to rate a member launched on the engine's own model, but is never offered (task #2972).
    expect(catalogFrom(served)).toEqual({ ...catalog, models: catalog.models.map(m => m.engine === 'codex' && m.model === 'default'
      ? { ...m, offered: false, note: CODEX_DEFAULT_NOT_OFFERED } : m) })
    const old = { policy: { version: 1, floor: { low: 1, medium: 2, high: 3 }, quotaReserve: 10, notes: '', models: [
      { engine: 'claude', model: 'opus', effort: 'high', quality: 3, cost: 3, enabled: true },
      { engine: 'claude', model: 'sonnet', effort: 'medium', quality: 2, cost: 2, enabled: false },
      { engine: 'opencode', model: 'default', effort: 'default', quality: 3, cost: 1, enabled: true }],
      localModels: { quality: 1, enabled: true, models: [{ model: 'kimi k3', quality: 2 }] } } }
    expect(catalogFrom(old)).toEqual({ models: [
      { engine: 'claude', model: 'opus', effort: 'high', strength: 3, cost: 3, offered: true },
      { engine: 'claude', model: 'sonnet', effort: 'medium', strength: 2, cost: 2, offered: false }],
      grid: { strength: 1, models: [{ model: 'kimi k3', strength: 2 }] } })
    // Nothing readable is an empty catalog, not a throw.
    expect(catalogFrom({})).toEqual({ models: [], grid: { strength: 1, models: [] } })
    // A served grid with no strength of its own counts as 1; a grid row without a strength is dropped.
    expect(catalogFrom({ catalog: { models: [], grid: { models: [{ model: 'kimi k3' }, { strength: 2 }] } } }).grid).toEqual({ strength: 1, models: [] })
  })

  it('rates a model by its exact row, its other effort, the engine\'s default row when launched on it, else unrated', () => {
    expect(strengthOf(catalog, 'claude', 'opus', 'high')).toBe(3)
    expect(strengthOf(catalog, 'claude', 'claude-opus-4-7', 'max')).toBe(3)
    expect(strengthOf(catalog, 'claude', 'claude-sonnet-4-5[1m]', 'medium')).toBe(2)
    expect(strengthOf(catalog, 'codex', 'gpt-6.1-sol', 'high', true)).toBe(3)
    expect(strengthOf(catalog, 'codex', 'gpt-6.1-sol', 'high')).toBeNull()
    expect(strengthOf(catalog, 'codex', 'gpt-5.5-mini', 'high', true)).toBeNull()
    expect(gridStrength(catalog, 'moonshotai/kimi-k3', '')).toBe(2)
    expect(gridStrength(catalog, 'qwen3:4b', 'Qwen 3 4B')).toBe(1)
  })
})

/** Scholes's goals, pieces 3 to 6, each change the ranking; they plug into choose() rather than edit it. These are today's
 *  answers for a fixed set of tasks and machines, captured before the hook existed: with no plug-ins every answer, label and
 *  record must stay byte for byte the same. */
describe('route answers without plug-ins', () => {
  const OPUS = { model: 'opus', effort: 'high', quality: 3, cost: 3 } as const
  // Codex as the route offers it since task #2972: the catalog's named model, never `default default`.
  const CODEX = { engine: 'codex', model: 'gpt-6.1-sol', effort: 'high', quality: 3, cost: 2 } as const
  const on = (machine: string, row: Partial<Probe>, quota: Probe['quota'] = windows([80, 3 * H], [90, 5 * D], machine)) =>
    probe({ machineId: machine, machineName: machine, ...row, quota })
  const frame: MemberFrame = { title: 'Fix the dial', project: 'openharness', cwd: '/r', root: '/r', remote: 'github.com/o/r', branch: 'fix/dial', updatedAt: NOW - 20 * M }
  const grid = (patch: Partial<Probe> = {}) => probe({ model: 'default', effort: 'default', quality: 1, cost: 1, quota: { known: false, leftPercent: null, resetsAt: null },
    gridModel: 'qwen3', gridName: 'swarm-0123456789ab', gridLabel: 'Qwen 3', ...patch })
  type Args = Parameters<typeof choose>
  const SCENARIOS: Array<[string, Args]> = [
    ['mixed members and new agents', [[on('a', OPUS), on('b', {}), on('a', {}, windows([60, 3 * H], [90, 5 * D], 'a')),
      on('a', { kind: 'member', agentId: 'm1', name: 'Multiply', activity: 'idle', repo: 'same', frame, earlier: [{ group: 'Dial fix', outcome: 'merged' }] }),
      on('b', { kind: 'member', agentId: 'm2', name: 'Elsewhere', activity: 'idle', repo: 'different', frame: null }),
      on('a', { model: 'haiku', effort: 'auto', quality: 1, cost: 1 })], policy, a(), NOW]],
    ['high, large: a strong candidate short, a weaker one fits', [[on('a', OPUS, windows([20, 4 * H], [50, 5 * D], 'A')), on('b', CODEX, windows([5, 4 * H], [60, 3 * D], 'B')),
      on('c', {}, windows([90, 4 * H], [90, 6 * D], 'C'))], policy, a({ difficulty: 'high', size: 'large' }), NOW]],
    ['low, small: weekly day budget and an expiring window', [[on('a', OPUS, windows([70, 20 * M], [10, 6 * D], 'A')), on('b', OPUS, windows([40, 4 * H], [80, 2 * D], 'B')),
      on('c', CODEX, windows(null, [30, 6 * D], 'C'))], policy, a({ difficulty: 'low', size: 'small', kind: 'docs' }), NOW]],
    ['picks still at work hold their quota', [[on('a', OPUS, windows([50, 3 * H], [50, 5 * D], 'A')), on('b', OPUS, windows([45, 3 * H], [50, 5 * D], 'B'))],
      policy, a({ difficulty: 'high' }), NOW, [{ account: 'A', spend: { '5-hour': 30, weekly: 4 }, size: 'medium', createdAt: NOW - 10 * M }]]],
    ['metered, unknown and unreadable quota', [[on('a', CODEX, { known: true, leftPercent: null, resetsAt: null, metered: true }),
      on('b', CODEX, { known: false, leftPercent: null, resetsAt: null, why: 'signed out of usage' }), on('c', CODEX, { known: true, leftPercent: 40, resetsAt: NOW + 2 * H }),
      on('d', CODEX, { known: true, leftPercent: 40, resetsAt: null, from: 'Team Mac' })], policy, a(), NOW]],
    ['more machines than rows shown', [Array.from({ length: 15 }, (_, i) => on(`m${String(i).padStart(2, '0')}`, i % 2 ? OPUS : {},
      windows([30 + i * 4, 3 * H], [90, 5 * D], `acct${i}`))), policy, a(), NOW]],
    ['a task naming a repository leaves out a member in another', [[on('a', {}), on('b', { kind: 'member', agentId: 'm2', name: 'Zed', activity: 'idle', repo: 'different' }),
      on('c', { refusals: ['Machine is offline.'] }), on('d', { load: { agents: 2, freeMemoryBytes: 8e9, hasFolder: true }, notes: ['Its last task here was lost.'] })],
      policy, a({ needs: { tools: ['git'], devices: [], cwd: '/repo' } }), NOW]],
    ['a person asked for a local model', [[on('a', OPUS), grid(), grid({ machineId: 'b', machineName: 'b', gridModel: 'kimi-k3', gridLabel: 'Kimi K3', gridKind: 'api' })],
      { ...policy, grid: { strength: 1, models: [{ model: 'kimi k3', strength: 2 }] } }, a({ local: true, difficulty: 'low', kind: 'docs' }), NOW]],
    ['a named model the catalog does not list', [[on('a', OPUS), on('b', CODEX), on('c', {})], policy, a({ model: 'claude-opus-6' }), NOW]],
    ['a named model somebody holds', [[on('a', OPUS)], policy, a({ model: 'deepseek 4.1' }), NOW,
      [], [{ model: 'deepseek/deepseek-v4.1', label: 'DeepSeek v4.1', kind: 'api', holders: ['Wren', 'Ada'] }]]],
    ['a named model served by a host now offline', [[on('a', OPUS)], policy, a({ model: 'qwen coder' }), NOW, [], [],
      [{ title: 'Qwen Coder 32B', reason: 'Its host Rig is offline, so an agent on it would never start.' }]]],
    ['nothing can run', [[on('a', { refusals: ['Machine is offline.'] }), on('b', CODEX, undefined)].map((p, i) => i ? { ...p, refusals: ['Codex is signed out.'] } : p),
      policy, a(), NOW]],
    ['an unrated member and a single candidate', [[on('a', { kind: 'member', agentId: 'm3', model: 'gpt-x', unrated: true, quality: 1, cost: 1, activity: 'working',
      terminalUnverified: true, frame: { ...frame, title: null, project: null, branch: null, updatedAt: null } })], policy, a({ size: 'small' }), NOW]],
  ]
  const answer = ([name, args]: [string, Args]) => {
    const choice = choose(...args)
    if ('error' in choice) return { name, choice }
    const verdict = decide(choice)
    return { name, choice, verdict, record: recordOf(choice, verdict, args[2]) }
  }

  it('answers every scenario as recorded: no pick, by machine (task #2901)', async () => {
    await expect(`${JSON.stringify(SCENARIOS.map(answer), null, 1)}\n`).toMatchFileSnapshot('./__snapshots__/route.answers.json')
  })
  it('answers the same with an empty plug-in list, and with plug-ins that have nothing to say', () => {
    const before = JSON.stringify(SCENARIOS.map(answer))
    const silent: RoutePlugin[] = [{ name: 'Quiet' }, { name: 'Nothing to add', candidates: () => [], adjust: () => null }]
    for (const plugins of [[], silent]) {
      const full = ([probes, catalog, task, now, open = [], held = [], offline = []]: Args): Args => [probes, catalog, task, now, open, held, offline, plugins]
      expect(JSON.stringify(SCENARIOS.map(([name, args]) => answer([name, full(args)])))).toBe(before)
    }
  })
})

/** The hook pieces 3 to 6 plug into: an ordered list of plug-ins, each able to add candidates, to note a finding on a candidate
 *  with a reason people read, and to leave out one that cannot run. Since task #2901 a finding never moves a candidate. */
describe('routing plug-ins', () => {
  const OPUS = { model: 'opus', effort: 'high', quality: 3, cost: 3 } as const
  const on = (machine: string, row: Partial<Probe> = {}) => probe({ machineId: machine, machineName: machine, ...OPUS, quota: windows([80, 3 * H], [90, 5 * D], machine), ...row })
  const route = (probes: Probe[], plugins: RoutePlugin[], task: Partial<Assessment> = {}) => choose(probes, policy, a(task), NOW, [], [], [], plugins)
  const titles = (r: ReturnType<typeof choose>) => ok(r).shown.map(s => s.machineName)

  it('a plug-in\'s cost adjustment leaves the order alone, and its reason shows on the candidate, in the label and in the record', () => {
    expect(titles(route([on('a'), on('b')], []))).toEqual(['a', 'b'])
    const measured: RoutePlugin = { name: 'Measured cost', adjust: c => c.machineId === 'b' ? { cost: -1, reason: 'its last 5 builds here cost half the catalog price' } : null }
    const r = ok(route([on('a'), on('b')], [measured]))
    expect(titles(r)).toEqual(['a', 'b'])
    const reason = 'Measured cost: its last 5 builds here cost half the catalog price'
    expect(r.shown[1]!.notes).toEqual([reason])
    expect(r.shown[1]!.label).toContain(reason)
    expect(r.shown[0]!.notes).toEqual([])
    const verdict = decide(r)
    expect(verdict.why).toBe(`${CHOOSE_BY_INSTRUCTIONS} Plug-ins' findings are in each candidate's notes.`)
    const record = recordOf(r, verdict, a()) as { candidates: Array<{ label: string; fit: { effectiveCost: number }; quality: number; cost: number }> }
    // What the candidate is and what its quota costs are recorded as measured; only the reason is added.
    expect(record.candidates[1]).toMatchObject({ quality: 3, cost: 3, fit: { effectiveCost: ok(route([on('b')], [])).shown[0]!.fit.effectiveCost } })
    expect(record.candidates[1]!.label).toContain(reason)
  })
  it('a strength adjustment leaves the order alone too; the notes of several plug-ins add up in their order', () => {
    const weaker = on('s', { model: 'sonnet', effort: 'medium', quality: 2, cost: 2 })
    const results: RoutePlugin = { name: 'Results', adjust: c => c.model === 'sonnet' ? { strength: 0.75, reason: 'merged 9 of its last 10 docs tasks' } : null }
    const fit: RoutePlugin = { name: 'Machine fit', adjust: c => c.model === 'sonnet' ? { strength: 0.5, reason: 'has the task folder' } : null }
    expect(titles(route([on('a'), weaker], [results]))).toEqual(['a', 's'])
    const r = ok(route([on('a'), weaker], [results, fit]))
    expect(titles(r)).toEqual(['a', 's'])
    expect(r.shown[1]!.notes).toEqual(['Results: merged 9 of its last 10 docs tasks', 'Machine fit: has the task folder'])
    expect(r.shown[1]!.quality).toBe(2)
  })
  it('a refusal leaves a candidate out with the plug-in\'s reason; refusing every one is no candidate', () => {
    const tooSmall: RoutePlugin = { name: 'Machine fit', adjust: c => c.machineId === 'a' ? { refuse: true, reason: 'has 1 GB free, the task needs 4 GB' } : null }
    const r = ok(route([on('a'), on('b')], [tooSmall]))
    expect(titles(r)).toEqual(['b'])
    expect(r.excluded).toEqual([{ title: 'New agent · Claude opus high · a', reason: 'Machine fit: has 1 GB free, the task needs 4 GB', machine: 'a' }])
    expect(decide(r).via).toBe('only')
    const none = route([on('a')], [tooSmall])
    expect(none).toEqual({ error: 'NO_CANDIDATE', excluded: [{ title: 'New agent · Claude opus high · a', reason: 'Machine fit: has 1 GB free, the task needs 4 GB', machine: 'a' }] })
  })
  // Lead, 10-31: a plug-in can never bring back a choice the route rules out. The route's filters are facts of a machine and
  // engine (offline, engine signed out, tools, devices, a stalled machine), carried as refusals on its probes, and choose()'s own
  // rules (catalog rows offered, a named or local model, the repository); the owner's rules and review limits are no longer the
  // route's (project instructions, phase 4).
  it('a plug-in cannot bring back a choice the route rules out: an added candidate stands on a machine and engine the route probed, with their refusals and notes', () => {
    const given = [on('a', { notes: ['Its last task here was lost.'] }), on('b', { refusals: ['Machine is offline.'] }),
      on('k', { kind: 'member', agentId: 'k1', name: 'Kai', activity: 'idle' })]
    const sonnet = { model: 'sonnet', effort: 'medium', quality: 2, cost: 2 } as const
    const sneaky: RoutePlugin = { name: 'More models', candidates: () => [
      on('a', { ...sonnet, quota: windows([100, 3 * H], [100, 5 * D], 'fresh') }),
      on('b', sonnet),
      on('a', { engine: 'codex', model: 'default', effort: 'default', cost: 2 }),
      on('k', sonnet),
      on('z', sonnet),
      on('a', { kind: 'member', agentId: 'ghost', name: 'Ghost', activity: 'idle' }),
      on('a', { model: 'haiku', effort: 'auto', quality: 1, cost: 1 }),
    ] }
    const r = ok(choose(given, policy, a(), NOW, [], [], [], [sneaky]))
    // By machine, as without plug-ins.
    expect(r.shown.map(s => s.title)).toEqual(['New agent · Claude opus high · a', 'New agent · Claude sonnet medium · a', 'Kai · Claude opus high · k'])
    // The added Sonnet on a keeps a's note and quota reading, not its own.
    expect(r.shown[1]).toMatchObject({ notes: ['Its last task here was lost.'], quota: given[0]!.quota })
    expect(r.excluded).toEqual([
      { title: 'New agent · Claude opus high · b', reason: 'Machine is offline.', machine: 'b' },
      { title: 'New agent · Claude sonnet medium · b', reason: 'Machine is offline.', machine: 'b' },
      { title: 'New agent · Codex default default · a', reason: 'More models: this route offers no new agent on Codex on a, so one added there is left out.', machine: 'a' },
      { title: 'New agent · Claude sonnet medium · k', reason: 'More models: this route offers no new agent on Claude on k, so one added there is left out.', machine: 'k' },
      { title: 'New agent · Claude sonnet medium · z', reason: 'More models: this route offers no new agent on Claude on z, so one added there is left out.', machine: 'z' },
      { title: 'Ghost · Claude opus high · a', reason: 'More models: a plug-in adds new agents only; it adjusts the agents the route found.', machine: 'a' },
    ].sort((x, y) => (x.reason === 'Machine is offline.' ? 0 : 1) - (y.reason === 'Machine is offline.' ? 0 : 1)))
    // Not offered by default, so left out as any Haiku row is, unless a person names it.
    expect(r.shown.some(s => s.model === 'haiku')).toBe(false)
    // Its own refusals and notes add to the machine's, once each; the machine's load goes with it; a model on the grid keeps its
    // own quota, as a local probe does (routeCommand.ts localProbes).
    const load = { agents: 1, freeMemoryBytes: 8e9, hasFolder: true }
    const own: RoutePlugin = { name: 'Own', candidates: () => [
      on('c', { ...sonnet, refusals: ['No room.'], notes: ['Base note.', 'Own note.'] }),
      on('c', { ...sonnet, model: 'default', effort: 'default', quality: 1, cost: 1, gridModel: 'qwen3', gridName: 'swarm-1', quota: { known: false, leftPercent: null, resetsAt: null } }),
    ] }
    const withOwn = ok(choose([on('c', { notes: ['Base note.'], load })], policy, a(), NOW, [], [], [], [own]))
    expect(withOwn.excluded).toEqual([{ title: 'New agent · Claude sonnet medium · c', reason: 'No room.', machine: 'c' }])
    expect(withOwn.shown.map(s => [s.gridModel ?? s.model, s.notes, s.load, s.quota.known])).toEqual([
      ['opus', ['Base note.'], load, true], ['qwen3', ['Base note.'], load, false]])
  })
  it('a plug-in adds candidates, which every rule then treats like the others; a later plug-in sees an earlier one\'s', () => {
    const seen: string[][] = []
    const given = [on('a'), on('x', { model: 'sonnet', effort: 'medium', quality: 2, cost: 2 })]
    const extra: RoutePlugin = { name: 'More models', candidates: probes => [on('x', {}),
      // A catalog row not offered by default stays out unless a person names it, as for any candidate.
      on('x', { model: 'haiku', effort: 'auto', quality: 1, cost: 1 })].filter(() => probes.length > 0) }
    const watch: RoutePlugin = { name: 'Watch', candidates: probes => { seen.push(probes.map(p => `${p.model} on ${p.machineId}`)); return [] } }
    const r = ok(route(given, [extra, watch]))
    expect(r.shown.map(s => `${s.model} on ${s.machineName}`)).toEqual(['opus on a', 'opus on x', 'sonnet on x'])
    expect(seen).toEqual([['opus on a', 'sonnet on x', 'opus on x', 'haiku on x']])
    // A person naming a model still considers that model alone.
    expect(titles(route(given, [extra], { model: 'haiku' }))).toEqual(['x'])
  })
  it('a plug-in sees the task, the time, the catalog, the picks at work and each candidate\'s fit', () => {
    const contexts: unknown[] = [], fits: string[] = []
    const look: RoutePlugin = { name: 'Look', candidates: (_p, context) => { contexts.push(context); return [] }, adjust: (c, context) => { contexts.push(context); fits.push(c.fit.status); return null } }
    const open: Commitment[] = [{ account: 'z', spend: { weekly: 1 }, size: 'small', createdAt: NOW }]
    choose([on('a')], policy, a({ kind: 'docs' }), NOW, open, [], [], [look])
    expect(contexts).toEqual([{ assessment: a({ kind: 'docs' }), now: NOW, catalog: policy, open }, { assessment: a({ kind: 'docs' }), now: NOW, catalog: policy, open }])
    expect(fits).toEqual(['fits'])
  })
  afterEach(() => { vi.restoreAllMocks() })
  it('a plug-in that runs too long is skipped whole: the route answers as without it and says so', () => {
    let clock = 0
    vi.spyOn(performance, 'now').mockImplementation(() => clock)
    const plain = ok(route([on('a'), on('b')], []))
    const slowAdjust: RoutePlugin = { name: 'Slow', adjust: c => { clock += 150; return { cost: -5, reason: `looked at ${c.machineId}` } } }
    const slowAdd: RoutePlugin = { name: 'Slow add', candidates: () => { clock += 201; return [on('a', { model: 'sonnet', effort: 'medium', quality: 2, cost: 2 })] } }
    const quick: RoutePlugin = { name: 'Quick', adjust: () => { clock += 10; return null } }
    const { warnings, ...rest } = ok(route([on('a'), on('b')], [slowAdd, slowAdjust, quick]))
    expect(rest).toEqual(plain)
    expect(warnings).toEqual(['Slow add', 'Slow'].map(n => `The routing plug-in "${n}" was skipped: it took longer than 200 ms. The route is shown without it.`))
  })
  it('plug-ins run in their list\'s fixed order, and the same route answers the same every time', () => {
    const one: RoutePlugin = { name: 'One', adjust: () => ({ cost: 0.5, reason: 'first' }) }
    const two: RoutePlugin = { name: 'Two', adjust: () => ({ cost: -0.5, reason: 'second' }) }
    const r = ok(route([on('a'), on('b')], [one, two]))
    expect(r.shown[0]!.notes).toEqual(['One: first', 'Two: second'])
    expect(ok(route([on('a'), on('b')], [two, one])).shown[0]!.notes).toEqual(['Two: second', 'One: first'])
    expect(JSON.stringify(route([on('a'), on('b')], [one, two]))).toBe(JSON.stringify(r))
  })
  it('a plug-in that throws or answers what cannot be ranked is skipped whole and named in a warning, never with its error', () => {
    const plain = ok(route([on('a'), on('b')], []))
    const half: RoutePlugin = { name: 'Half', adjust: c => { if (c.machineId === 'b') throw new Error('token=secret at /Users/x'); return { cost: -5, reason: 'x' } } }
    const nan: RoutePlugin = { name: 'NaN', adjust: () => ({ cost: Number.NaN, reason: 'x' }) }
    const blank: RoutePlugin = { name: 'Blank', adjust: () => ({ strength: 1, reason: ' ' }) }
    const broken: RoutePlugin = { name: 'Broken', candidates: () => { throw new Error('secret') } }
    const junk: RoutePlugin = { name: 'Junk', candidates: () => [{ machineId: 'q' } as Probe] }
    const notList: RoutePlugin = { name: 'Not a list', candidates: () => null as unknown as Probe[] }
    const r = ok(route([on('a'), on('b')], [half, nan, blank, broken, junk, notList]))
    const { warnings, ...rest } = r
    expect(rest).toEqual(plain)
    // Candidates are gathered before any is judged, so those plug-ins are named first.
    expect(warnings).toEqual(['Broken', 'Junk', 'Not a list', 'Half', 'NaN', 'Blank'].map(n => `The routing plug-in "${n}" was skipped: it failed. The route is shown without it.`))
    expect(JSON.stringify(r)).not.toContain('secret')
    // Nothing can run: the warning still goes with the answer.
    expect(route([on('a', { refusals: ['Machine is offline.'] })], [broken])).toMatchObject({ error: 'NO_CANDIDATE', warnings: [expect.stringContaining('"Broken"')] })
  })
})

/** Task #3163 (Ken, 2026-11-05, production): each slot kept whichever candidate's title sorted first, so for small work Astra
 *  xhigh was offered 2,010 times against Sol high 67, and Opus high 2,356 against Sonnet high 127. The Routing rules call for
 *  Sonnet high or Sol high for small, low or medium work, and Opus high or Astra xhigh for big, hard, risky, security or review
 *  work. These run on the catalog's rows as served (backend superTabs/catalog.ts). */
describe('the model the task\'s size calls for', () => {
  const served: Catalog = { grid: { strength: 1, models: [{ model: 'kimi k3', strength: 2 }] }, models: [
    { engine: 'claude', model: 'opus', effort: 'high', strength: 3, cost: 3, offered: true },
    { engine: 'claude', model: 'opus', effort: 'xhigh', strength: 3, cost: 4, offered: true },
    { engine: 'codex', model: 'gpt-6.1-sol', effort: 'high', strength: 3, cost: 2, offered: true, engineDefault: true },
    { engine: 'codex', model: 'gpt-6-astra', effort: 'xhigh', strength: 3, cost: 5, offered: true },
    { engine: 'claude', model: 'sonnet', effort: 'high', strength: 2, cost: 2, offered: true },
    { engine: 'claude', model: 'haiku', effort: 'auto', strength: 1, cost: 1, offered: false },
  ] }
  /** Every row of the catalog as a new agent on [machine], one per engine it runs, as routeCommand.ts probes them. */
  const rows = (machine: string, engines: Array<'claude' | 'codex'> = ['claude', 'codex']) => served.models.filter(m => engines.includes(m.engine))
    .map(m => probe({ machineId: machine, machineName: machine, engine: m.engine, model: m.model, effort: m.effort, quality: m.strength, cost: m.cost,
      quota: windows([80, 3 * H], [70, 4 * D], `${machine}-${m.engine}`) }))
  const offers = (r: ReturnType<typeof choose>, kind: Probe['kind'] = 'new') => ok(r).shown.filter(s => s.kind === kind && !s.gridModel)
  const models = (r: ReturnType<typeof choose>) => [...new Set(offers(r).map(s => `${s.engine} ${s.model} ${s.effort}`))].sort()
  const machines = ['Gray.local', 'daniel-pc', 'Kay.local']

  it('offers Sonnet high and Sol high for small, low or medium work, never Opus or Astra', () => {
    for (const patch of [{ size: 'small', difficulty: 'low' }, { size: 'small', difficulty: 'medium', risk: 'medium' }, { size: 'medium', difficulty: 'medium' }] as const) {
      const r = choose(machines.flatMap(m => rows(m)), served, a(patch), NOW)
      expect(models(r), JSON.stringify(patch)).toEqual(['claude sonnet high', 'codex gpt-6.1-sol high'])
      // Every machine keeps its row of each engine.
      for (const m of machines) expect(offers(r).filter(s => s.machineName === m).map(s => s.engine).sort()).toEqual(['claude', 'codex'])
    }
  })
  it('offers Opus high and Astra xhigh for big, hard, risky, security or review work', () => {
    for (const patch of [{ size: 'large' }, { size: 'small', difficulty: 'high' }, { size: 'small', risk: 'high' }, { size: 'small', kind: 'security' }, { size: 'small', kind: 'review' }] as const) {
      const r = choose(machines.flatMap(m => rows(m)), served, a({ difficulty: 'low', ...patch }), NOW)
      // Under 12 rows the route fills with more rows of the same tier (Opus xhigh), never with Sonnet or Sol.
      expect(models(r).filter(m => /sonnet|sol/.test(m)), JSON.stringify(patch)).toEqual([])
      for (const m of machines) {
        expect(offers(r).filter(s => s.machineName === m).map(s => `${s.engine} ${s.model} ${s.effort}`))
          .toEqual(expect.arrayContaining(['claude opus high', 'codex gpt-6-astra xhigh']))
      }
    }
  })
  it('keeps both models of each slot when the task gives no size', () => {
    const unsized = parseAssessment({ difficulty: 'low', risk: 'low', why: 'Older agent.' }) as Assessment
    expect(unsized).toMatchObject({ size: 'medium', unsized: true })
    // The marker is the route's own: the record sends the size as before.
    expect(parseAssessment({ difficulty: 'low', risk: 'low', size: 'small', why: 'x' })).not.toHaveProperty('unsized')
    const r = choose(machines.flatMap(m => rows(m)), served, unsized, NOW)
    for (const m of machines) {
      const here = offers(r).filter(s => s.machineName === m).map(s => `${s.engine} ${s.model} ${s.effort}`)
      expect(here).toEqual(expect.arrayContaining(['claude opus high', 'claude sonnet high', 'codex gpt-6-astra xhigh', 'codex gpt-6.1-sol high']))
    }
    // An unsized task that is hard is still strong work.
    expect(models(choose(machines.flatMap(m => rows(m)), served, { ...unsized, difficulty: 'high' }, NOW))).toEqual(['claude opus high', 'codex gpt-6-astra xhigh'])
  })
  it('keeps a slot whose machine offers neither model of the tier, on its first row', () => {
    const only = served.models.filter(m => m.model === 'opus' && m.effort === 'xhigh')
      .map(m => probe({ machineId: 'x', machineName: 'x', engine: m.engine, model: m.model, effort: m.effort, quality: m.strength, cost: m.cost }))
    expect(offers(choose(only, served, a({ size: 'small', difficulty: 'low' }), NOW)).map(s => s.title)).toEqual(['New agent · Claude opus xhigh · x'])
  })
  it('prefers the idle member on the tier\'s model, reading a member\'s reported model through the catalog', () => {
    const member = (agentId: string, model: string, effort: string) => probe({ kind: 'member', agentId, name: agentId, machineId: 'Gray.local', machineName: 'Gray.local',
      engine: 'claude', model, effort, activity: 'idle' })
    const members = [member('Cedar', 'claude-opus-4-7', 'high'), member('Ash', 'claude-sonnet-4-5', 'high')]
    const small = choose([...rows('Gray.local'), ...members], served, a({ size: 'small', difficulty: 'low' }), NOW)
    expect(offers(small, 'member').map(s => s.name)).toEqual(['Ash'])
    const large = choose([...rows('Gray.local'), ...members], served, a({ size: 'large' }), NOW)
    expect(offers(large, 'member').map(s => s.name)).toEqual(['Cedar'])
  })
  // The shape of an 11-05 route on production: 22 machines by their real names, some with Claude only, idle members on Opus,
  // Sonnet and Astra, and a grid model on one.
  it('over a real-shaped list, offers per model what the size calls for, on every machine', () => {
    const names = ['2Apple-MK1-A3s-MacBook-Pro.local', 'daniel-pc', 'Darren-MacBook.local', 'Diego\'s Mac', 'Elvis-MacBook-Pro.local', 'Gray.local', 'Kay.local',
      'Mac 3', 'MacBook-Pro-TD.local', 'MacbookPro.local', 'MacBookPro2021.local', 'Mac-Studio.local', 'Mini-1.local', 'Mini-2.local', 'nam-mbp.local',
      'Phong-MacBook.local', 'remote-1', 'Tony-MacBook-Pro.local', 'tri-mac.local', 'Vinh-Air.local', 'Win-Rig', 'zeta-linux']
    const claudeOnly = new Set(['Diego\'s Mac', 'Win-Rig'])
    const fresh = names.flatMap(n => rows(n, claudeOnly.has(n) ? ['claude'] : ['claude', 'codex']))
    const member = (agentId: string, machine: string, engine: 'claude' | 'codex', model: string, effort: string) =>
      probe({ kind: 'member', agentId, name: agentId, machineId: machine, machineName: machine, engine, model, effort, activity: 'idle' })
    const members = [member('Fir', 'daniel-pc', 'claude', 'claude-opus-4-7', 'high'), member('Cedar', 'Gray.local', 'claude', 'opus', 'medium'),
      member('Guide', 'Gray.local', 'codex', 'gpt-6-astra', 'xhigh'), member('Rowan3', 'Elvis-MacBook-Pro.local', 'claude', 'opus', 'high'),
      member('Elm', 'MacbookPro.local', 'claude', 'sonnet', 'high'), member('Ginkgo', 'MacBookPro2021.local', 'claude', 'opus', 'high'),
      member('Wren', 'MacBookPro2021.local', 'claude', 'sonnet', 'high')]
    const grid = probe({ machineId: 'Kay.local', machineName: 'Kay.local', engine: 'codex', model: 'default', effort: 'default', quality: 2, cost: 0,
      gridModel: 'kimi-k3', gridName: 'Kimi K3', gridKind: 'local' })
    const all = [...members, ...fresh, grid].reverse()
    const count = (r: ReturnType<typeof choose>) => {
      const by: Record<string, number> = {}
      for (const s of offers(r)) by[`${s.model} ${s.effort}`] = (by[`${s.model} ${s.effort}`] ?? 0) + 1
      return by
    }
    const codexMachines = names.length - claudeOnly.size
    const small = choose(all, served, a({ size: 'small', difficulty: 'low' }), NOW)
    expect(count(small)).toEqual({ 'sonnet high': names.length, 'gpt-6.1-sol high': codexMachines })
    expect(ok(small).shown.length).toBeLessThanOrEqual(64)
    // Members stay, one per machine and engine, on the tier's model where one is idle there.
    expect(offers(small, 'member').map(s => s.name).sort()).toEqual(['Cedar', 'Elm', 'Fir', 'Guide', 'Rowan3', 'Wren'])
    expect(ok(small).shown.filter(s => s.gridModel).map(s => s.machineName)).toEqual(['Kay.local'])
    const big = choose(all, served, a({ size: 'large', difficulty: 'high' }), NOW)
    expect(count(big)).toEqual({ 'opus high': names.length, 'gpt-6-astra xhigh': codexMachines })
    expect(offers(big, 'member').map(s => s.name).sort()).toEqual(['Cedar', 'Elm', 'Fir', 'Ginkgo', 'Guide', 'Rowan3'])
  })
})

/** Task #3163: since the record without a pick (#3010) only each candidate's account and spend were kept, so 3,905 of 3,915
 *  Codex candidates on production had no fit status, and quota at route time could not be measured. */
describe('each candidate\'s quota in the record', () => {
  const c = () => ok(choose([probe({ machineId: 'a', machineName: 'a', quota: windows([60, 2 * H], [42, 3 * D], 'A') }),
    probe({ machineId: 'b', machineName: 'b', quota: { known: false, leftPercent: null, resetsAt: null } }),
    probe({ machineId: 'c', machineName: 'c', quota: { known: true, leftPercent: 30, resetsAt: NOW + D } })], policy, a(), NOW))
  const fits = (record: Record<string, unknown>) => (record.candidates as Array<{ fit?: Record<string, unknown> }>).map(x => x.fit)
  it('records each candidate\'s fit status, weekly % left and reset', () => {
    const choice = c()
    expect(fits(recordOf(choice, decide(choice), a()))).toEqual([
      expect.objectContaining({ status: 'fits', left: 42, resetsAt: NOW + 3 * D }),
      expect.objectContaining({ status: 'unknown', left: null, resetsAt: null }),
      // A reading with no windows named: its tightest, as quotaBrief reads it.
      expect.objectContaining({ left: 30, resetsAt: NOW + D }),
    ])
  })
  it('leaves them out for a backend from before them, which refuses them', () => {
    const choice = c(), v = decide(choice)
    const unquoted = recordOf(choice, v, a(), 'unquoted')
    expect(unquoted).not.toHaveProperty('pick')
    expect(unquoted.via).toBe('instructions')
    for (const fit of fits(unquoted)) expect(Object.keys(fit!)).toEqual(['status', 'coverage', 'effectiveCost', 'expiring', 'spend', 'account'])
    for (const fit of fits(recordOf(choice, v, a(), 'picked'))) expect(fit).not.toHaveProperty('left')
    for (const fit of fits(recordOf(choice, v, a(), 'unkinded'))) expect(fit).not.toHaveProperty('resetsAt')
  })
})
