// cli/src/superTabs/route.spec.ts
import { describe, expect, it } from 'vitest'
import { API_BUILDERS, LOCAL_NONE, breaks, choose, gridQuality, reviewRefusals, decide, floorFor, parseAssessment, quotaOf2, rateFor, recordOf, repoMatch, repositoryKey, type Assessment, type Commitment, type MemberFrame, type Policy, type Probe, type SwarmRule, type TaskFolder } from './route.js'

const object = (v: unknown) => v as Record<string, unknown>

const policy: Policy = { version: 1, floor: { low: 1, medium: 2, high: 3 }, quotaReserve: 10, notes: 'Frontend prefers Claude.', models: [
  { engine: 'claude', model: 'opus', effort: 'high', quality: 3, cost: 3, enabled: true },
  { engine: 'codex', model: 'default', effort: 'default', quality: 3, cost: 2, enabled: true },
  { engine: 'claude', model: 'sonnet', effort: 'medium', quality: 2, cost: 2, enabled: true },
  { engine: 'claude', model: 'haiku', effort: 'auto', quality: 1, cost: 1, enabled: false },
] }
const a = (patch: Partial<Assessment> = {}): Assessment => ({ difficulty: 'medium', risk: 'low', size: 'medium', why: 'API change.', needs: { tools: [], devices: [] }, ...patch })
const probe = (patch: Partial<Probe> = {}): Probe => ({ kind: 'new', machineId: 'm1', machineName: 'remote-1', engine: 'claude', model: 'sonnet',
  effort: 'medium', quality: 2, cost: 2, quota: { known: true, leftPercent: 50, resetsAt: 1_000 }, activity: 'new', known: true, refusals: [], ...patch })

const NOW = 1_000_000_000, M = 60_000, H = 3_600_000, D = 86_400_000
/** A reading with a 5-hour and a weekly window, each as [percent left, resets in] (either may be missing). */
type Win = [left: number, resetsIn: number | null] | null
const windows = (five: Win, week: Win, account?: string): Probe['quota'] => {
  const read = ([['5-hour', five], ['weekly', week]] as const).flatMap(([name, w]) => w ? [{ name, leftPercent: w[0], resetsAt: w[1] === null ? null : NOW + w[1] }] : [])
  return { known: true, leftPercent: Math.min(...read.map(w => w.leftPercent)), resetsAt: null, windows: read, ...(account ? { account } : {}) }
}
const ok = (r: ReturnType<typeof choose>) => { if ('error' in r) throw new Error('x'); return r }

describe('assessment and floor', () => {
  it('parses a Lead assessment and explains what is wrong', () => {
    expect(parseAssessment({ difficulty: 'high', risk: 'low', size: 'large', why: ' Schema. ', needs: { tools: ['git'] } }))
      .toEqual({ difficulty: 'high', risk: 'low', size: 'large', why: 'Schema.', needs: { tools: ['git'], devices: [] } })
    expect(parseAssessment({ difficulty: 'high', risk: 'low', size: 'huge', why: 'x' })).toContain('size')
    expect(parseAssessment({ difficulty: 'high', risk: 'low', size: 'toString', why: 'x' })).toContain('size')
    expect(parseAssessment({ difficulty: 'hard', risk: 'low', why: 'x' })).toContain('difficulty')
    expect(parseAssessment({ difficulty: 'low', risk: 'low', why: 'x'.repeat(301) })).toContain('300')
    expect(parseAssessment({ difficulty: 'low', risk: 'low', why: 'x', needs: { cwd: 'relative' } })).toContain('absolute')
    expect(parseAssessment(null)).toContain('difficulty')
  })
  it('raises the floor by one for high risk, to at most 3', () => {
    expect(floorFor(policy, a())).toBe(2)
    expect(floorFor(policy, a({ risk: 'high' }))).toBe(3)
    expect(floorFor(policy, a({ difficulty: 'high', risk: 'high' }))).toBe(3)
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
  it('rates a member by its policy row, then by model, else conservatively', () => {
    expect(rateFor(policy, 'claude', 'opus', 'high')).toEqual({ quality: 3, cost: 3 })
    expect(rateFor(policy, 'claude', 'opus', 'max')).toEqual({ quality: 3, cost: 3 })
    expect(rateFor(policy, 'claude', null, null)).toEqual({ quality: 1, cost: 1 })
  })
})

describe('choose', () => {
  it('returns NO_CANDIDATE with reasons when nothing can run', () => {
    expect(choose([probe({ refusals: ['Machine is offline.'] })], policy, a())).toEqual({ error: 'NO_CANDIDATE',
      excluded: [{ title: 'New agent · Claude sonnet medium · remote-1', reason: 'Machine is offline.' }] })
  })
  it('shows only floor-meeting candidates, ordered by effective cost, quality, room on the tightest window, member first', () => {
    const r = choose([
      probe({ model: 'opus', effort: 'high', quality: 3, cost: 3, quota: windows([80, 3 * H], [90, 5 * D]) }),
      probe({ machineId: 'm2', machineName: 'mac', quota: windows([80, 3 * H], [90, 5 * D], 'B') }),
      probe({ quota: windows([60, 3 * H], [90, 5 * D]) }),
      probe({ kind: 'member', agentId: 'a1', name: 'Multiply', quota: windows([60, 3 * H], [90, 5 * D]), activity: 'idle' }),
      probe({ kind: 'member', agentId: 'a2', name: 'Elsewhere', repo: 'different', quota: windows([60, 3 * H], [90, 5 * D]), activity: 'idle' }),
      probe({ model: 'haiku', effort: 'auto', quality: 1, cost: 1 }),
    ], policy, a(), NOW)
    if ('error' in r) throw new Error('unexpected')
    expect(r.belowFloor).toBe(false)
    // A member in another repository saves no start, so it ranks as a new agent would.
    expect(r.shown.map(s => s.title)).toEqual([
      'New agent · Claude sonnet medium · mac',
      'Multiply · Claude sonnet medium · remote-1',
      'Elsewhere · Claude sonnet medium · remote-1',
      'New agent · Claude sonnet medium · remote-1',
      'New agent · Claude opus high · remote-1',
    ])
    expect(r.shown.map(s => s.id)).toEqual(['c0', 'c1', 'c2', 'c3', 'c4'])
  })
  it('marks belowFloor when nobody meets it, and shows those that fit before the unknown and the short', () => {
    const r = ok(choose([probe({ quality: 1 }), probe({ quality: 1, machineName: 'mac', quota: windows([90, null], [90, null]) })], policy, a({ difficulty: 'high' }), NOW))
    expect(r.belowFloor).toBe(true)
    expect(r.shown.map(s => s.fit.status)).toEqual(['fits'])
    expect(r.excluded).toEqual([{ title: 'New agent · Claude sonnet medium · remote-1', reason: 'Its quota could not be read in full, and another candidate\'s quota fits this task.' }])
    // Under the reserve is short, and goes after a candidate that is only partly known.
    const reserve = ok(choose([probe({ quota: windows([10, null], [90, null]) }), probe({ machineName: 'mac', quota: windows([90, null], null) })], policy, a(), NOW))
    expect(reserve.shown.map(s => [s.machineName, s.fit.status])).toEqual([['mac', 'unknown']])
    expect(reserve.excluded[0].reason).toBe('The 5-hour window is expected to run out right away.')
    expect(reserve.short).toBeUndefined()
  })
  it('shows at most 12 candidates', () => {
    const r = choose(Array.from({ length: 20 }, (_, i) => probe({ machineId: `m${i}`, machineName: `box-${String(i).padStart(2, '0')}` })), policy, a())
    if ('error' in r) throw new Error('unexpected')
    expect(r.shown).toHaveLength(12)
  })
})

/** The phase 1 examples (docs/plans/2026-10-21-swarm-routing-phase1.md), on the default policy with a 10% reserve. */
describe('strength, fit and effective cost', () => {
  const defaults: Policy = { ...policy, notes: '', models: policy.models.map(m => ({ ...m, enabled: true })) }
  const OPUS = { engine: 'claude', model: 'opus', effort: 'high', quality: 3, cost: 3 } as const
  const SONNET = { engine: 'claude', model: 'sonnet', effort: 'medium', quality: 2, cost: 2 } as const
  const HAIKU = { engine: 'claude', model: 'haiku', effort: 'auto', quality: 1, cost: 1 } as const
  const CODEX = { engine: 'codex', model: 'default', effort: 'default', quality: 3, cost: 2 } as const
  const on = (row: Partial<Probe>, machine: string, quota: Probe['quota']) => probe({ ...row, machineId: machine, machineName: machine, quota })
  const unknown = { known: false, leftPercent: null, resetsAt: null }
  const route = (probes: Probe[], patch: Partial<Assessment>, now = NOW, open: Commitment[] = []) => ok(choose(probes, defaults, a(patch), now, open))
  const picks = (r: ReturnType<typeof route>) => r.shown.map(s => `${s.model} on ${s.machineName}`)

  it('1. high, medium: Opus high, though its window resets in 40 minutes, over Sonnet with more left', () => {
    const r = route([on(OPUS, 'a', windows([70, 40 * M], [80, 5 * D], 'A')), on(SONNET, 'b', windows([90, 3 * H], [80, 5 * D], 'B'))], { difficulty: 'high', size: 'medium' })
    expect(picks(r)).toEqual(['opus on a'])
    // Strength filters: the weaker model is neither shown nor excluded.
    expect(r.excluded).toEqual([])
    expect(r.shown[0].label).toContain('fits: needs about 30% of the 5-hour window (60% left, resets in 40m, otherwise unused); weekly 6% of 70%')
    expect(r.shown[0].fit).toEqual({ status: 'fits', coverage: 2, effectiveCost: 0, expiring: 1, spend: { '5-hour': 45, weekly: 6 }, account: 'A' })
  })
  it('2. high, large: Codex, because Opus high is expected to run out', () => {
    const r = route([on(OPUS, 'a', windows([25, 4 * H], [80, 5 * D], 'A')), on(CODEX, 'a', windows([85, 3 * H], [80, 5 * D]))], { difficulty: 'high', size: 'large' })
    expect(picks(r)).toEqual(['default on a'])
    expect(r.shown[0].fit.account).toBe('a:codex')
    expect(r.excluded).toEqual([{ title: 'New agent · Claude opus high · a', reason: 'The 5-hour window is expected to run out about a quarter of the way in; resets in 4h.' }])
  })
  it('3. low, small: Haiku on the account whose weekly window has room, not on the one nearly spent for the week', () => {
    const A = windows([80, 4 * H], [12, 5 * D], 'A'), B = windows([60, 4 * H], [70, 5 * D], 'B')
    const r = route([OPUS, SONNET, HAIKU].flatMap(row => [on(row, 'a', A), on(row, 'b', B)]), { difficulty: 'low', size: 'small' })
    expect(picks(r)[0]).toBe('haiku on b')
    // A's weekly budget is 0.4% a day; Haiku's 0.5% costs it 1 + 1 × 0.5 / 0.4.
    expect(r.shown.find(s => s.model === 'haiku' && s.machineName === 'a')!.fit.effectiveCost).toBe(2.25)
  })
  it('4. low, small: Opus high on the account whose 5-hour window resets in 20 minutes, which would otherwise go unused', () => {
    const A = windows([60, 20 * M], [60, 2 * D], 'A'), B = windows([90, 4 * H], [80, 5 * D], 'B')
    const r = route([OPUS, SONNET, HAIKU].flatMap(row => [on(row, 'a', A), on(row, 'b', B)]), { difficulty: 'low', size: 'small' })
    expect(picks(r).slice(0, 4)).toEqual(['opus on a', 'sonnet on a', 'haiku on a', 'haiku on b'])
  })
  it('5. two high, medium routes a minute apart go to two accounts', () => {
    const probes = [on(OPUS, 'a', windows([60, 3 * H], [80, 5 * D], 'A')), on(OPUS, 'b', windows([58, 3 * H], [80, 5 * D], 'B'))]
    const first = route(probes, { difficulty: 'high', size: 'medium' })
    expect(picks(first)[0]).toBe('opus on a')
    const held: Commitment = { account: first.shown[0].fit.account, spend: first.shown[0].fit.spend, size: 'medium', createdAt: NOW }
    const second = route(probes, { difficulty: 'high', size: 'medium' }, NOW + M, [held])
    expect(picks(second)).toEqual(['opus on b'])
    expect(second.excluded[0]).toMatchObject({ title: 'New agent · Claude opus high · a', reason: expect.stringContaining('expected to run out') })
    // Once its run time is over a pick holds nothing.
    expect(picks(route(probes, { difficulty: 'high', size: 'medium' }, NOW + 2 * H, [held]))[0]).toBe('opus on a')
  })
  it('6. high, large: a window that resets in an hour needs only the part of the task before the reset', () => {
    const r = route([on(OPUS, 'a', windows([40, H], [80, 5 * D]))], { difficulty: 'high', size: 'large' })
    expect(r.shown[0].fit).toMatchObject({ status: 'fits', coverage: 1.2 })
    expect(r.shown[0].label).toContain('needs about 25% of the 5-hour window')
  })
  it('7. high, large: Codex and never Sonnet when every strong candidate is short, and the Lead is told', () => {
    const r = route([on(OPUS, 'a', windows([30, 4 * H], [80, 5 * D], 'A')), on(CODEX, 'a', windows([40, 4.5 * H], [80, 5 * D])),
      on(SONNET, 's', windows([95, 4 * H], [80, 5 * D], 'S'))], { difficulty: 'high', size: 'large' })
    expect(picks(r)).toEqual(['default on a', 'opus on a'])
    expect(r.shown.map(s => s.fit.status)).toEqual(['short', 'short'])
    expect(r.short).toBe('No candidate is expected to cover this task; its 5-hour quota is expected to run out partway and resets in 4h30.')
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
    expect(r.shown[0].fit).toMatchObject({ status: 'fits', coverage: 1.67 })
    // Weekly use above a day's share costs more, unless the task is hard.
    expect(r.shown[0].fit.effectiveCost).toBeGreaterThan(2)
    expect(route([on(SONNET, 'a', windows([90, 5 * H], [20, 7 * D], 'A'))], { difficulty: 'high', size: 'medium' }).shown[0].fit.effectiveCost).toBe(2)
    // A weekly window with no reset is one day's budget; one with nothing usable is short already, not charged.
    expect(route([on(SONNET, 'a', windows([90, 5 * H], [20, null]))], {}).shown[0].fit.effectiveCost).toBe(2)
    const spent = route([on(SONNET, 'a', windows([90, 5 * H], [5, 7 * D]))], {})
    expect(spent.shown[0].fit).toMatchObject({ status: 'short', effectiveCost: 2 })
    expect(spent.short).toBe('No candidate is expected to cover this task; its weekly quota is expected to run out partway and resets in 7 days.')
  })
  it('a Codex account that has only a weekly window is read in full; a Claude one missing its 5-hour window is not', () => {
    const CODEX = { engine: 'codex', model: 'default', effort: 'default', quality: 2, cost: 2 } as const
    const weekly = quotaOf2({ known: true, windows: [{ usedPercent: 19, resetsAt: (NOW + 6 * D) / 1000, name: 'weekly' }] })
    const r = route([on(CODEX, 'codex', weekly), on(SONNET, 'claude', windows([90, 3 * H], [80, 5 * D]))], { difficulty: 'low' })
    expect(r.shown.map(s => [s.engine, s.fit.status])).toEqual([['claude', 'fits'], ['codex', 'fits']])
    expect(r.excluded).toEqual([])
    const half = route([on(SONNET, 'half', weekly), on(SONNET, 'claude', windows([90, 3 * H], [80, 5 * D]))], { difficulty: 'low' })
    expect(half.excluded.map(e => e.title)).toEqual(['New agent · Claude sonnet medium · half'])
  })
  it('an engine on an API key is metered: it fits with no window, beside a subscription machine and ranked after it', () => {
    const metered = quotaOf2({ known: true, windows: [] })
    expect(metered).toEqual({ known: true, leftPercent: null, resetsAt: null, metered: true })
    const r = route([on(SONNET, 'key', metered), on(SONNET, 'sub', windows([90, 3 * H], [80, 5 * D], 'S')), on(SONNET, 'unread', unknown)], { difficulty: 'low' })
    expect(r.shown.map(s => [s.machineName, s.fit.status])).toEqual([['sub', 'fits'], ['key', 'fits']])
    expect(r.excluded).toEqual([{ title: 'New agent · Claude sonnet medium · unread', reason: 'Its quota could not be read in full, and another candidate\'s quota fits this task.' }])
    expect(r.shown[1].fit).toEqual({ status: 'fits', coverage: null, effectiveCost: 2, expiring: 0, spend: { '5-hour': 30, weekly: 4 }, account: 'key:claude' })
    expect(r.shown[1].label).toContain('fits: metered, no usage window to run out')
    expect(r.shown[1].label).toContain('quota metered')
  })
  it('keeps the best row of every machine inside the shown rows, then fills by rank', () => {
    const full = windows([90, 3 * H], [80, 5 * D], 'S')
    const crowd = Array.from({ length: 14 }, (_, i) => probe({ kind: 'member', agentId: `m${i}`, name: `Member ${String(i).padStart(2, '0')}`, machineId: 'a', machineName: 'a', quota: full }))
    const far = on({ ...OPUS }, 'z', windows([90, 3 * H], [80, 5 * D], 'Z'))
    const r = route([...crowd, far], { difficulty: 'low' })
    expect(r.shown).toHaveLength(12)
    // The costlier machine z ranks 15th, behind all of a's rows, yet its best row is shown, in place of a's 12th.
    expect(r.shown.map(s => s.machineName)).toEqual([...Array(11).fill('a'), 'z'])
    expect(r.shown.map(s => s.id)).toEqual(Array.from({ length: 12 }, (_, i) => `c${i}`))
  })
  it('with more machines than rows shown, keeps the best rows of the best-ranked machines', () => {
    const many = Array.from({ length: 14 }, (_, i) => on(SONNET, `m${String(i).padStart(2, '0')}`, windows([90 - i, 3 * H], [80, 5 * D], `A${i}`)))
    const r = route([...many, ...many.map(p => ({ ...p, kind: 'member' as const, agentId: p.machineId, name: 'Extra' }))], { difficulty: 'low' })
    expect(new Set(r.shown.map(s => s.machineName)).size).toBe(12)
  })
  it('orders the short by how far they get, then by the policy order, and says when no reset is known', () => {
    const r = route([on(SONNET, 'b', windows([25, null], [80, null], 'B')), on(SONNET, 'a', windows([25, null], [80, null], 'A')), on(SONNET, 'c', windows([30, null], [80, null], 'C'))], {})
    expect(picks(r)).toEqual(['sonnet on c', 'sonnet on a', 'sonnet on b'])
    expect(r.short).toBe('No candidate is expected to cover this task; its 5-hour quota is expected to run out partway.')
    expect(r.shown[0].label).toContain('short: needs about 30% of the 5-hour window (20% left); weekly 4% of 70%')
    expect(route([on(SONNET, 'a', windows(null, [80, null]))], {}).shown[0].label).toContain('unknown: 5-hour window unknown; weekly 4% of 70%')
  })
})

const frame = (patch: Partial<MemberFrame> = {}): MemberFrame => ({ title: 'Fix auth', project: 'api', cwd: '/w/api', root: '/w/api', remote: 'github.com/acme/api', branch: 'feat/auth', updatedAt: 1_000_000 - 2 * 3_600_000, ...patch })
const folder = (patch: Partial<TaskFolder> = {}): TaskFolder => ({ cwd: '/w/api', kind: 'git', name: 'api', root: '/w/api', remote: 'github.com/acme/api', ...patch })

describe('verdict and record', () => {
  const choice = () => { const r = choose([probe({ kind: 'member', agentId: 'a1', name: 'Multiply', activity: 'idle' }), probe({ machineName: 'mac' })], policy, a()); if ('error' in r) throw new Error('x'); return r }
  it('takes the first in the fixed order, and says when it was the only candidate', () => {
    expect(decide(choice())).toEqual({ pick: choice().shown[0], via: 'order', p: null, why: "First by the owner's rules and the policy order." })
    expect(decide(ok(choose([probe()], policy, a())))).toMatchObject({ via: 'only', p: null })
  })
  it('produces a record the backend schema accepts', () => {
    const c = choice(), v = decide(c)
    const v1 = { assessment: { difficulty: 'medium', risk: 'low', why: 'API change.' },
      candidates: c.shown.map(s => ({ id: s.id, kind: s.kind, ...(s.agentId ? { agentId: s.agentId } : {}), machineId: s.machineId,
        engine: s.engine, model: s.model, effort: s.effort, quality: s.quality, cost: s.cost, title: s.title, label: s.label })),
      excluded: [], floor: 2, notes: true, pick: 'c0', via: 'order', p: null, belowFloor: false, why: v.why }
    expect(recordOf(c, v, a(), policy)).toEqual({ ...v1, assessment: { ...v1.assessment, size: 'medium' },
      candidates: v1.candidates.map(x => ({ ...x, fit: { status: 'unknown', coverage: null, effectiveCost: 2, expiring: 0, spend: { '5-hour': 30, weekly: 4 }, account: 'm1:claude' } })) })
    // For a backend from before sizes and fit.
    expect(recordOf(c, v, a(), policy, 'v1')).toEqual(v1)
    // The task's kind is recorded, so attempts can be compared by the kind of job they were (backend costs/read.ts).
    expect(recordOf(c, v, a({ kind: 'ui' }), policy).assessment).toEqual({ difficulty: 'medium', risk: 'low', why: 'API change.', size: 'medium', kind: 'ui' })
    // A backend from before kinds gets everything else; one from before phase 1 gets neither.
    expect(recordOf(c, v, a({ kind: 'ui' }), policy, 'unkinded').assessment).toEqual({ difficulty: 'medium', risk: 'low', why: 'API change.', size: 'medium' })
    expect(object(recordOf(c, v, a({ kind: 'ui' }), policy, 'v1').assessment)).not.toHaveProperty('kind')
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
  it('rates default models, unknown models and unknown engines', () => {
    expect(rateFor(policy, 'codex', null, null)).toEqual({ quality: 3, cost: 2 })
    expect(rateFor(policy, 'claude', 'sonnet', null)).toEqual({ quality: 2, cost: 2 })
    expect(rateFor(policy, 'codex', 'gpt-x', 'high')).toEqual({ quality: 3, cost: 2 })
    expect(rateFor(policy, 'other', 'gpt-x', 'high')).toEqual({ quality: 1, cost: 1 })
  })
  it('rates a working member by the model its engine reported, not only by the catalog alias', () => {
    expect(rateFor(policy, 'claude', 'claude-opus-4-7', 'high')).toEqual({ quality: 3, cost: 3 })
    expect(rateFor(policy, 'claude', 'claude-opus-4-7', 'xhigh')).toEqual({ quality: 3, cost: 3 })
    expect(rateFor(policy, 'claude', 'claude-sonnet-4-5[1m]', 'medium')).toEqual({ quality: 2, cost: 2 })
    expect(rateFor(policy, 'claude', 'sonnet[1m]', null)).toEqual({ quality: 2, cost: 2 })
    expect(rateFor(policy, 'claude', 'claude-haiku-4-5', 'auto')).toEqual({ quality: 1, cost: 1 })
    // Codex reports a real slug; its catalog row is `default`.
    expect(rateFor(policy, 'codex', 'gpt-5.5', 'high')).toEqual({ quality: 3, cost: 2 })
    // A model that matches nothing and an engine without a default row stay at the floor.
    expect(rateFor(policy, 'claude', 'claude-mystery-1', 'high')).toEqual({ quality: 1, cost: 1 })
  })
  it('titles and labels nameless members, unknown quota and quota without a reset', () => {
    const r = ok(choose([
      probe({ kind: 'member', agentId: 'a1', quota: { known: true, leftPercent: null, resetsAt: null } }),
      probe({ machineName: 'mac', quota: { known: true, leftPercent: 40, resetsAt: null } }),
    ], policy, a()))
    expect(r.shown.map(s => s.title)).toEqual(['Member · Claude sonnet medium · remote-1', 'New agent · Claude sonnet medium · mac'])
    expect(r.shown[0].label).toContain('Member ·')
    expect(r.shown[0].label).toContain('quota unknown')
    expect(r.shown[1].label).toContain('quota 40% left')
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
  it('falls back to unknown probes, to underfunded ones, and breaks every tie deterministically', () => {
    expect(ok(choose([probe({ known: false, quota: unknownQuota })], policy, a())).shown).toHaveLength(1)
    const tie = ok(choose([
      probe({ machineName: 'b', quota: unknownQuota }), probe({ machineName: 'a', quota: unknownQuota }),
      probe({ kind: 'member', agentId: 'a1', name: 'M', machineName: 'z', quota: unknownQuota }),
    ], policy, a()))
    expect(tie.shown.map(s => s.title.split(' · ')[2])).toEqual(['z', 'a', 'b'])
    expect(ok(choose([probe({ machineName: 'b' }), probe({ kind: 'member', agentId: 'a1', name: 'M' })], policy, a())).shown[0].kind).toBe('member')
    expect(ok(choose([probe({ kind: 'member', agentId: 'a1', name: 'M' }), probe({ machineName: 'b' })], policy, a())).shown[0].kind).toBe('member')
  })
  it('keeps a floor-meeting candidate even when it is low on quota or unknown', () => {
    const low = { known: true, leftPercent: 5, resetsAt: null }
    const r = ok(choose([probe({ quality: 1 }), probe({ quality: 3, machineName: 'mac', quota: low })], policy, a({ difficulty: 'high' })))
    expect(r.belowFloor).toBe(false)
    expect(r.shown.map(s => s.title)).toEqual(['New agent · Claude sonnet medium · mac'])
    const u = ok(choose([probe({ quality: 1 }), probe({ quality: 3, machineName: 'mac', known: false, quota: unknownQuota })], policy, a({ difficulty: 'high' })))
    expect(u.belowFloor).toBe(false)
    expect(u.shown.map(s => s.title)).toEqual(['New agent · Claude sonnet medium · mac'])
  })
  it('trims what the record carries to the backend limits', () => {
    const long = 'x'.repeat(900)
    const r = ok(choose([probe({ kind: 'member', agentId: 'a_1-B', name: long, machineId: 'm-1_X' }), probe({ machineName: long })], policy, a()))
    const rec = recordOf({ ...r, excluded: Array.from({ length: 250 }, () => ({ title: long.slice(0, 160), reason: long })) },
      decide(r), a(), { ...policy, notes: '' }) as { candidates: Array<Record<string, string>>; excluded: Array<{ reason: string }>; why: string; notes: boolean; p: number | null }
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

describe('the owner\'s rules', () => {
  const rule = (r: SwarmRule['rule'], text = 'Rule.'): SwarmRule => ({ rule: r, text })
  const titles = (r: ReturnType<typeof choose>) => ok(r).shown.map(s => s.title)
  const haiku = probe({ machineName: 'cheap', model: 'haiku', effort: 'auto', quality: 2, cost: 1 })
  const sonnet = probe({ machineName: 'mac' })
  it('leaves out a candidate that breaks a hard rule, with the owner\'s words as the reason', () => {
    const r = ok(choose([haiku, sonnet], policy, a(), NOW, [], [rule({ kind: 'forbidModel', model: 'HAIKU' }, 'No Haiku.')]))
    expect(r.shown.map(s => s.machineName)).toEqual(['mac'])
    expect(r.excluded).toEqual([{ title: 'New agent · Claude haiku auto · cheap', reason: 'Breaks the owner\'s rule: No Haiku.' }])
    // A full model id is caught too, a rule for another engine is not, and `default` is never matched.
    expect(breaks([rule({ kind: 'forbidModel', model: 'haiku' })], { machineId: 'm', engine: 'claude', model: 'claude-haiku-4-5', effort: 'high' })).toContain('Rule.')
    expect(breaks([rule({ kind: 'forbidModel', engine: 'codex', model: 'haiku' })], { machineId: 'm', engine: 'claude', model: 'haiku', effort: 'high' })).toBeNull()
    // `default` is not known, so nothing matches it; a rule naming a full id matches the alias a start asks for.
    expect(breaks([rule({ kind: 'forbidModel', model: 'def' })], { machineId: 'm', engine: 'codex', model: 'default', effort: 'high' })).toBeNull()
    expect(breaks([rule({ kind: 'forbidModel', model: 'claude-haiku-4-5' })], { machineId: 'm', engine: 'claude', model: 'haiku', effort: 'high' })).toContain('Rule.')
    expect(breaks([rule({ kind: 'forbidModel', model: 'claude-haiku-4-5' })], { machineId: 'm', engine: 'claude', model: 'sonnet', effort: 'high' })).toBeNull()
  })
  it('keeps agents to the owner\'s machines', () => {
    const r = choose([sonnet, probe({ machineId: 'm2', machineName: 'other' })], policy, a(), NOW, [], [rule({ kind: 'machines', machineIds: ['m2'] })])
    expect(titles(r)).toEqual(['New agent · Claude sonnet medium · other'])
    // When nobody is left, the Lead is told why each one was left out.
    expect(choose([sonnet], policy, a(), NOW, [], [rule({ kind: 'machines', machineIds: ['m9'] }, 'Only m9.')]))
      .toEqual({ error: 'NO_CANDIDATE', excluded: [{ title: 'New agent · Claude sonnet medium · mac', reason: 'Breaks the owner\'s rule: Only m9.' }] })
  })
  it('holds a minimum effort, and lifts a new agent whose effort the engine chooses to that minimum', () => {
    const codex = probe({ machineName: 'box', engine: 'codex', model: 'default', effort: 'default', quality: 3, cost: 2 })
    const member = probe({ kind: 'member', agentId: 'a1', name: 'Low', effort: 'low' })
    const unknown = probe({ kind: 'member', agentId: 'a2', name: 'Auto', effort: 'auto' })
    const r = ok(choose([codex, member, unknown, sonnet], policy, a(), NOW, [], [rule({ kind: 'minEffort', effort: 'high' }, 'High effort.')]))
    expect(r.shown.map(s => s.title)).toEqual(['New agent · Codex default high · box'])
    expect(r.excluded.map(e => e.title)).toEqual(['Low · Claude sonnet low · remote-1', 'Auto · Claude sonnet auto · remote-1', 'New agent · Claude sonnet medium · mac'])
    // The highest minimum that applies to the engine wins; one for another engine is ignored.
    const two = ok(choose([codex], policy, a(), NOW, [], [rule({ kind: 'minEffort', effort: 'medium' }), rule({ kind: 'minEffort', engine: 'codex', effort: 'xhigh' }), rule({ kind: 'minEffort', engine: 'claude', effort: 'max' })]))
    expect(two.shown[0].effort).toBe('xhigh')
    // A lifted row that equals another on the same machine is shown once.
    const high = probe({ machineName: 'box', engine: 'codex', model: 'default', effort: 'high', quality: 3, cost: 2 })
    expect(ok(choose([codex, high], policy, a(), NOW, [], [rule({ kind: 'minEffort', effort: 'high' })])).shown.map(s => s.title)).toEqual(['New agent · Codex default high · box'])
    const auto = probe({ machineName: 'box', engine: 'codex', model: 'default', effort: 'auto', quality: 3, cost: 2 })
    expect(ok(choose([codex, auto], policy, a(), NOW, [], [rule({ kind: 'minEffort', effort: 'high' })])).shown).toHaveLength(1)
    // Without a minimum, nothing is lifted.
    expect(ok(choose([codex], policy, a(), NOW, [], [rule({ kind: 'minEffort', engine: 'claude', effort: 'high' })])).shown[0].effort).toBe('default')
  })
  it('ranks by the preferred engine for the task\'s kind, before cost, without changing who is shown', () => {
    const codex = probe({ machineName: 'box', engine: 'codex', model: 'default', effort: 'default', quality: 2, cost: 3 })
    const plain = ok(choose([codex, sonnet], policy, a(), NOW))
    expect(plain.shown.map(s => s.engine)).toEqual(['claude', 'codex'])
    const rules = [rule({ kind: 'preferEngine', taskKind: 'ui', engine: 'codex' }), rule({ kind: 'preferEngine', taskKind: null, engine: 'claude' })]
    expect(ok(choose([codex, sonnet], policy, a({ kind: 'ui' }), NOW, [], rules)).shown.map(s => s.engine)).toEqual(['codex', 'claude'])
    // Another kind falls to the rule for every task.
    expect(ok(choose([sonnet, codex], policy, a({ kind: 'docs' }), NOW, [], rules)).shown.map(s => s.engine)).toEqual(['claude', 'codex'])
    expect(ok(choose([codex, sonnet], policy, a(), NOW, [], [rules[0]])).shown).toHaveLength(plain.shown.length)
  })
  it('puts idle members first, then the least busy machine, when the owner prefers idle agents', () => {
    const member = probe({ kind: 'member', agentId: 'a1', name: 'Idle', cost: 3, quality: 2 })
    const busy = probe({ machineName: 'busy', cost: 1, load: { agents: 5, freeMemoryBytes: null, hasFolder: null } })
    const quiet = probe({ machineName: 'quiet', cost: 2, load: { agents: 1, freeMemoryBytes: null, hasFolder: null } })
    const unread = probe({ machineName: 'unread', cost: 1 })
    expect(titles(choose([busy, member, quiet, unread], policy, a(), NOW))[0]).toBe('New agent · Claude sonnet medium · busy')
    expect(titles(choose([busy, member, quiet, unread], policy, a(), NOW, [], [rule({ kind: 'preferIdle' })])).map(t => t.split(' · ')[0] === 'Idle' ? 'Idle' : t.split(' · ')[2]))
      .toEqual(['Idle', 'quiet', 'busy', 'unread'])
  })
  it('parses the task\'s kind', () => {
    expect(parseAssessment({ difficulty: 'low', risk: 'low', why: 'x', kind: 'ui' })).toMatchObject({ kind: 'ui' })
    expect(parseAssessment({ difficulty: 'low', risk: 'low', why: 'x', kind: 'UI work' })).toContain('kind')
    expect(parseAssessment({ difficulty: 'low', risk: 'low', why: 'x' })).not.toHaveProperty('kind')
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
    const r = ok(choose([local()], policy, a({ difficulty: 'low' }), NOW))
    expect(r.shown[0]).toMatchObject({ title: 'New agent · Claude on Qwen 3 (local) · remote-1', fit: { status: 'fits', account: 'local:swarm-0123456789ab:qwen3' } })
    expect(r.shown[0]!.label).toContain('Claude on Qwen 3 (local)')
    expect((recordOf(r, decide(r), a(), policy) as { candidates: unknown[] }).candidates[0]).toMatchObject({ gridModel: 'qwen3', gridName: 'swarm-0123456789ab' })
    // Without a name or a label: the model stands for both, and nothing about the grid is recorded without a grid.
    const bare = ok(choose([local({ gridName: undefined, gridLabel: undefined })], policy, a({ difficulty: 'low' }), NOW))
    expect(bare.shown[0]).toMatchObject({ title: 'New agent · Claude on qwen3 (local) · remote-1', fit: { account: 'local::qwen3' } })
    expect((recordOf(bare, decide(bare), a(), policy) as { candidates: unknown[] }).candidates[0]).not.toHaveProperty('gridModel')
  })
  it('keeps a local model under the floor of a harder task, and keeps it beside a subscription row of the same name', () => {
    const r = ok(choose([probe(), local()], policy, a(), NOW))
    expect(r.shown.map(s => s.gridModel)).toEqual([undefined])
    // Same machine, engine, model and effort as a subscription `default` row: both stay, being different models.
    const both = ok(choose([probe({ model: 'default', effort: 'default', quality: 1, cost: 1, quota: windows([80, 3 * H], [90, 5 * D]) }), local()], policy, a({ difficulty: 'low' }), NOW))
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
    expect(ok(choose([older], policy, a({ difficulty: 'low' }), NOW)).shown[0]!.title).toContain('(shared)')
    expect(choose([opus], policy, a({ model: 'gpt 9' }), NOW)).toEqual({ error: 'NO_CANDIDATE',
      excluded: [{ title: 'Named model', reason: 'No candidate runs "gpt 9". Share it with the Swarm (Your models), or check its name.' }] })
    expect(parseAssessment({ difficulty: 'low', risk: 'low', why: 'x', model: ' deepseek 4.1 flash ' })).toMatchObject({ model: 'deepseek 4.1 flash' })
    expect(parseAssessment({ difficulty: 'low', risk: 'low', why: 'x', model: '...' })).toContain('model')
    expect(parseAssessment({ difficulty: 'low', risk: 'low', why: 'x', model: 7 })).toContain('model')
    expect(parseAssessment({ difficulty: 'low', risk: 'low', why: 'x', model: 'x'.repeat(201) })).toContain('model')
  })

  it('puts a model that runs on a machine before an API or another grid\'s model, at equal cost and strength', () => {
    const api = local({ gridModel: 'aaa-api', gridLabel: 'aaa-api', gridKind: 'api' })
    const shared = local({ gridModel: 'aab-shared', gridLabel: 'aab-shared', gridKind: 'shared' })
    const engine = local({ gridModel: 'zzz-llama', gridLabel: 'zzz-llama', gridKind: 'local' })
    expect(ok(choose([api, shared, engine], policy, a({ local: true }), NOW)).shown.map(s => s.gridModel)).toEqual(['zzz-llama', 'aaa-api', 'aab-shared'])
    // A model with no kind runs on the Swarm's grid, as an engine does.
    const bare = local({ gridModel: 'zzz-bare', gridLabel: 'zzz-bare', gridKind: undefined })
    expect(ok(choose([api, bare], policy, a({ local: true }), NOW)).shown.map(s => s.gridModel)).toEqual(['zzz-bare', 'aaa-api'])
  })

  it('offers the Builder already on a named model, and says who holds a named or local model it cannot offer', () => {
    // A member running the named model is a candidate like any other.
    const wren = probe({ kind: 'member', agentId: 'wren', name: 'Wren', model: 'deepseek/deepseek-v4.1-flash-1017', effort: 'xhigh', quality: 1, cost: 1 })
    expect(ok(choose([probe(), wren], policy, a({ model: 'deepseek 4.1 flash' }), NOW)).shown.map(s => s.agentId)).toEqual(['wren'])
    const ds = { model: 'deepseek/deepseek-v4.1-flash-1017', label: 'deepseek/deepseek-v4.1-flash-1017 · OpenRouter', kind: 'api' as const, holders: ['Wren', 'Ada', 'Bo', 'Cy'] }
    const qwen = { model: 'qwen3:4b', label: 'Qwen 3 4B', kind: 'local' as const, holders: ['Faye'] }
    expect(choose([probe()], policy, a({ model: 'deepseek 4.1 flash' }), NOW, [], [], [qwen, ds])).toEqual({ error: 'NO_CANDIDATE', excluded: [{ title: 'Named model',
      reason: `"deepseek/deepseek-v4.1-flash-1017 · OpenRouter" is shared with the Swarm, but Builders Wren, Ada, Bo and Cy are on it: an API model takes ${API_BUILDERS} Builders at a time. Assign the work to one of them once it is free, or stop one to free the model.` }] })
    // A name nothing holds still reads as not shared.
    expect(choose([probe()], policy, a({ model: 'gpt 9' }), NOW, [], [], [qwen])).toMatchObject({ excluded: [{ reason: expect.stringContaining('No candidate runs "gpt 9"') }] })
    expect(choose([probe()], policy, a({ local: true }), NOW, [], [], [qwen])).toEqual({ error: 'NO_CANDIDATE', excluded: [{ title: 'Local models',
      reason: '"Qwen 3 4B" is shared with the Swarm, but Builder Faye is on it: a local model serves one Builder at a time. Assign the work to that Builder once it is free, or stop it to free the model.' }] })
    expect(LOCAL_NONE).toContain('Your models')
  })

  describe('first for simple work (roadmap, Dec: about 30% of work on cheaper models)', () => {
    const simple = a({ difficulty: 'low', risk: 'low', size: 'small' })
    // Opus on an account whose 5-hour window resets in 20 minutes costs nothing in effect, so it ranked above a free model.
    const expiring = probe({ machineName: 'mac', model: 'opus', effort: 'high', quality: 3, cost: 3, quota: windows([60, 20 * M], [60, 2 * D]) })
    const haiku = probe({ machineName: 'mac', model: 'haiku', effort: 'auto', quality: 1, cost: 1, quota: windows([90, 4 * H], [80, 5 * D]) })
    const idle = probe({ kind: 'member', agentId: 'a1', name: 'Idle', model: 'sonnet', quota: windows([90, 4 * H], [80, 5 * D]) })
    const grid = local({ machineName: 'mac' })
    const firstOf = (r: ReturnType<typeof choose>) => ok(r).shown[0]!.gridModel ?? ok(r).shown[0]!.model
    it('ranks a model on the Swarm\'s grid first for low-difficulty, low-risk work', () => {
      expect(firstOf(choose([expiring, haiku, grid], policy, simple, NOW))).toBe('qwen3')
      expect(firstOf(choose([idle, grid], policy, simple, NOW, [], [{ rule: { kind: 'preferIdle' }, text: 'Idle first.' }]))).toBe('qwen3')
    })
    it('ranks a strong grid model first for medium docs, copy, tests, fixtures, a specified fix or a mechanical refactor (Ken, 2026-10-29)', () => {
      const kimi = local({ machineName: 'mac', quality: 2, gridModel: 'moonshotai/kimi-k3', gridLabel: 'Kimi K3' })
      for (const kind of ['docs', 'copy', 'tests', 'fixtures', 'fix', 'refactor']) {
        expect(firstOf(choose([expiring, kimi], policy, { ...simple, difficulty: 'medium', kind }, NOW))).toBe('moonshotai/kimi-k3')
      }
      // A small model stays under the medium floor, and other kinds keep the policy order.
      expect(firstOf(choose([expiring, grid], policy, { ...simple, difficulty: 'medium', kind: 'docs' }, NOW))).toBe('opus')
      expect(firstOf(choose([expiring, kimi], policy, { ...simple, difficulty: 'medium', kind: 'ui' }, NOW))).toBe('opus')
      expect(firstOf(choose([expiring, kimi], policy, { ...simple, difficulty: 'medium', kind: 'docs', risk: 'medium' }, NOW))).toBe('opus')
      expect(firstOf(choose([expiring, kimi], policy, { ...simple, difficulty: 'high', kind: 'docs' }, NOW))).toBe('opus')
    })
    it('keeps the policy order for anything harder, riskier or a review', () => {
      expect(firstOf(choose([expiring, haiku, grid], policy, { ...simple, risk: 'medium' }, NOW))).toBe('opus')
      expect(firstOf(choose([expiring, haiku, grid], policy, { ...simple, difficulty: 'medium' }, NOW))).toBe('opus')
      expect(firstOf(choose([expiring, haiku, grid], policy, { ...simple, kind: 'review' }, NOW))).toBe('opus')
    })
    it('still puts the owner\'s preferred engine first, and stops when the owner opts out', () => {
      const codex = probe({ machineName: 'mac', engine: 'codex', model: 'default', effort: 'default', quality: 3, cost: 2, quota: windows([90, 4 * H], [80, 5 * D]) })
      const prefer = [{ rule: { kind: 'preferEngine', taskKind: null, engine: 'codex' }, text: 'Codex.' } as SwarmRule]
      expect(firstOf(choose([codex, grid], policy, simple, NOW, [], prefer))).toBe('default')
      expect(firstOf(choose([codex, local({ machineName: 'mac', engine: 'codex' })], policy, simple, NOW, [], prefer))).toBe('qwen3')
      expect(firstOf(choose([expiring, grid], policy, simple, NOW, [], [{ rule: { kind: 'noGridFirst' }, text: 'Subscriptions first.' }]))).toBe('opus')
    })
  })

  it('rates a grid model by the policy\'s first named row it matches, else its local quality, else 1', () => {
    const rows = { ...policy, localModels: { quality: 1, enabled: true, models: [{ model: 'kimi k3', quality: 2 }, { model: 'deepseek v4.1', quality: 3 }] } }
    expect(gridQuality(rows, 'moonshotai/kimi-k3')).toBe(2)
    expect(gridQuality(rows, 'ds-1017', 'DeepSeek V4.1 Flash')).toBe(3)
    expect(gridQuality(rows, 'qwen3:4b')).toBe(1)
    expect(gridQuality({ ...policy, localModels: { quality: 2, enabled: true } }, 'moonshotai/kimi-k3')).toBe(2)
    expect(gridQuality(policy, 'moonshotai/kimi-k3')).toBe(1)
  })
  it('never lets a grid model, a model below quality 2 or the reviewed Builder\'s own family review (Ken, 2026-10-29)', () => {
    const codex = { engine: 'codex' }
    expect(reviewRefusals(local({ quality: 2 }), codex)).toEqual(['A review never runs on a model served on the Swarm\'s grid.'])
    expect(reviewRefusals(probe({ model: 'haiku', quality: 1 }), codex)).toEqual(['A review needs a model of quality 2 or more, and Claude haiku is 1.'])
    expect(reviewRefusals(probe({ engine: 'codex', model: 'default', quality: 3 }), codex)).toEqual(['A review runs on another engine than the reviewed Builder\'s, Codex.'])
    // A Builder on a grid model is its own family: Claude reviews it, even though Claude Code drove it.
    expect(reviewRefusals(probe(), { engine: 'claude', gridModel: 'moonshotai/kimi-k3' })).toEqual([])
    expect(reviewRefusals(probe(), { engine: 'claude' })).toEqual(['A review runs on another engine than the reviewed Builder\'s, Claude.'])
    expect(reviewRefusals(probe(), null)).toEqual([])
  })

  it('says why a named model the Swarm has is never offered to Builders, rather than to share it', () => {
    const llama = { model: 'llama3.2:3b', label: 'llama3.2:3b', kind: 'local' as const, holders: [],
      refused: 'llama3.2:3b is too small for a coding agent (about 3B parameters; Builders need 7B or more).' }
    const reason = '"llama3.2:3b" is shared with the Swarm, but Builders are not offered it: llama3.2:3b is too small for a coding agent (about 3B parameters; Builders need 7B or more). Ask a member to run a larger model, or share an API (Your models).'
    expect(choose([probe()], policy, a({ model: 'llama 3.2 3b' }), NOW, [], [], [llama])).toEqual({ error: 'NO_CANDIDATE', excluded: [{ title: 'Named model', reason }] })
    expect(choose([probe()], policy, a({ local: true }), NOW, [], [], [llama])).toEqual({ error: 'NO_CANDIDATE', excluded: [{ title: 'Local models', reason }] })
  })
})
