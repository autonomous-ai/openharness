// cli/src/superTabs/route.spec.ts
import { describe, expect, it } from 'vitest'
import { choose, decide, floorFor, jevQuestion, parseAssessment, quotaOf2, rateFor, recordOf, type Assessment, type Policy, type Probe } from './route.js'

const policy: Policy = { version: 1, floor: { low: 1, medium: 2, high: 3 }, quotaReserve: 10, notes: 'Frontend prefers Claude.', models: [
  { engine: 'claude', model: 'opus', effort: 'high', quality: 3, cost: 3, enabled: true },
  { engine: 'codex', model: 'default', effort: 'default', quality: 3, cost: 2, enabled: true },
  { engine: 'claude', model: 'sonnet', effort: 'medium', quality: 2, cost: 2, enabled: true },
  { engine: 'claude', model: 'haiku', effort: 'auto', quality: 1, cost: 1, enabled: false },
] }
const a = (patch: Partial<Assessment> = {}): Assessment => ({ difficulty: 'medium', risk: 'low', why: 'API change.', needs: { tools: [], devices: [] }, ...patch })
const probe = (patch: Partial<Probe> = {}): Probe => ({ kind: 'new', machineId: 'm1', machineName: 'remote-1', engine: 'claude', model: 'sonnet',
  effort: 'medium', quality: 2, cost: 2, quota: { known: true, leftPercent: 50, resetsAt: 1_000 }, activity: 'new', known: true, refusals: [], ...patch })

describe('assessment and floor', () => {
  it('parses a Lead assessment and explains what is wrong', () => {
    expect(parseAssessment({ difficulty: 'high', risk: 'low', why: ' Schema. ', needs: { tools: ['git'] } }))
      .toEqual({ difficulty: 'high', risk: 'low', why: 'Schema.', needs: { tools: ['git'], devices: [] } })
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
      .toEqual({ known: true, leftPercent: 30, resetsAt: Date.parse('2026-10-19T12:00:00Z') })
    expect(quotaOf2({ known: true, windows: [{ usedPercent: 10, resetsAt: 1_800_000_000 }] }).resetsAt).toBe(1_800_000_000_000)
    expect(quotaOf2({ known: true, windows: [{ usedPercent: 10, resetsAt: 1_800_000_000_000 }] }).resetsAt).toBe(1_800_000_000_000)
    expect(quotaOf2({ known: true, windows: [{ usedPercent: 10, resetsAt: 'soon' }] }).resetsAt).toBeNull()
    expect(quotaOf2({ known: false, windows: [] })).toEqual({ known: false, leftPercent: null, resetsAt: null })
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
  it('shows only floor-meeting candidates, ordered by cost, quota, reset and member first', () => {
    const r = choose([
      probe({ model: 'opus', effort: 'high', quality: 3, cost: 3 }),
      probe({ machineId: 'm2', machineName: 'mac', quota: { known: true, leftPercent: 80, resetsAt: 5_000 } }),
      probe({ quota: { known: true, leftPercent: 80, resetsAt: 2_000 } }),
      probe({ kind: 'member', agentId: 'a1', name: 'Multiply', quota: { known: true, leftPercent: 80, resetsAt: 2_000 }, activity: 'idle' }),
      probe({ model: 'haiku', effort: 'auto', quality: 1, cost: 1 }),
      probe(),
    ], policy, a())
    if ('error' in r) throw new Error('unexpected')
    expect(r.belowFloor).toBe(false)
    expect(r.shown.map(s => s.title)).toEqual([
      'Multiply · Claude sonnet medium · remote-1',
      'New agent · Claude sonnet medium · remote-1',
      'New agent · Claude sonnet medium · mac',
      'New agent · Claude sonnet medium · remote-1',
      'New agent · Claude opus high · remote-1',
    ])
    expect(r.shown.map(s => s.id)).toEqual(['c0', 'c1', 'c2', 'c3', 'c4'])
  })
  it('marks belowFloor when nobody meets it, keeps the quota reserve, and prefers known candidates', () => {
    const r = choose([probe({ quality: 1 }), probe({ quality: 1, quota: { known: true, leftPercent: 5, resetsAt: null } })], policy, a({ difficulty: 'high' }))
    if ('error' in r) throw new Error('unexpected')
    expect(r.belowFloor).toBe(true)
    expect(r.shown).toHaveLength(1)
    const onlyReserve = choose([probe({ quota: { known: true, leftPercent: 5, resetsAt: null } })], policy, a())
    if ('error' in onlyReserve) throw new Error('unexpected')
    expect(onlyReserve.shown).toHaveLength(1)
    const unknown = choose([probe({ known: false, quota: { known: false, leftPercent: null, resetsAt: null } }), probe()], policy, a())
    if ('error' in unknown) throw new Error('unexpected')
    expect(unknown.shown.map(s => s.known)).toEqual([true])
  })
  it('shows at most 12 candidates', () => {
    const r = choose(Array.from({ length: 20 }, (_, i) => probe({ machineId: `m${i}`, machineName: `box-${String(i).padStart(2, '0')}` })), policy, a())
    if ('error' in r) throw new Error('unexpected')
    expect(r.shown).toHaveLength(12)
  })
})

describe('Jev context and verdict', () => {
  const choice = () => { const r = choose([probe({ kind: 'member', agentId: 'a1', name: 'Multiply', activity: 'idle' }), probe({ machineName: 'mac' })], policy, a()); if ('error' in r) throw new Error('x'); return r }
  it('builds at most four string keys within the hosted limits, with no email', () => {
    const q = jevQuestion({ title: 'Build', brief: 'b'.repeat(5000), checks: ['Tests pass', 'Docs updated'], history: ['Builder: stopped'] }, a(), policy, choice())
    expect(Object.keys(q.state)).toEqual(['task', 'lead', 'policy', 'history'])
    expect(Object.values(q.state).every(v => typeof v === 'string')).toBe(true)
    expect(Object.values(q.state).join('').length).toBeLessThanOrEqual(17_000)
    expect(q.state.task.length).toBeLessThan(5000)
    expect(q.state.policy).toContain('Frontend prefers Claude.')
    expect(Object.keys(q.questions.who.criteria)).toEqual(['c0', 'c1'])
    expect(Object.values(q.questions.who.criteria).every(v => v.length <= 640)).toBe(true)
    expect(q.questions.who.instructions.length).toBeLessThanOrEqual(1500)
    expect(JSON.stringify(q)).not.toMatch(/@/)
  })
  it('takes a sure Jev pick, falls back to order when unsure or unavailable, and skips Jev for one candidate', () => {
    const c = choice()
    expect(decide(c, { choice: 'c1', probabilities: { c0: 0.2, c1: 0.8 } }, null)).toMatchObject({ via: 'jev', p: 0.8, pick: { id: 'c1' } })
    expect(decide(c, { choice: 'c1', probabilities: { c0: 0.45, c1: 0.55 } }, null)).toMatchObject({ via: 'order', fallback: 'unsure', pick: { id: 'c0' }, why: expect.stringContaining('Jev unsure') })
    expect(decide(c, undefined, 'BUSY')).toMatchObject({ via: 'order', fallback: 'unavailable', pick: { id: 'c0' }, why: expect.stringContaining('Jev unavailable') })
    const one = choose([probe()], policy, a()); if ('error' in one) throw new Error('x')
    expect(decide(one, undefined, null)).toMatchObject({ via: 'only', p: null })
  })
  it('broken Jev answers fall back to order', () => {
    const c = choice()
    expect(decide(c, { choice: 'c9', probabilities: { c0: 0.1, c9: 0.9 } }, null).via).toBe('order')
    expect(decide(c, { choice: 'c1', probabilities: { c1: 0.9 } }, null).via).toBe('order')
  })
  it('produces a record the backend schema accepts', () => {
    const c = choice(), v = decide(c, { choice: 'c1', probabilities: { c0: 0.2, c1: 0.8 } }, null)
    expect(recordOf(c, v, a(), policy)).toEqual({ assessment: { difficulty: 'medium', risk: 'low', why: 'API change.' },
      candidates: c.shown.map(s => ({ id: s.id, kind: s.kind, ...(s.agentId ? { agentId: s.agentId } : {}), machineId: s.machineId,
        engine: s.engine, model: s.model, effort: s.effort, quality: s.quality, cost: s.cost, title: s.title, label: s.label })),
      excluded: [], floor: 2, notes: true, pick: 'c1', via: 'jev', p: 0.8, belowFloor: false, why: v.why })
    // The policy order says which fallback decided; the other routes carry none.
    const order = decide(c, undefined, 'BUSY')
    expect(recordOf(c, order, a(), policy)).toMatchObject({ via: 'order', fallback: 'unavailable', why: order.why })
  })
})

describe('edges', () => {
  const unknownQuota = { known: false, leftPercent: null, resetsAt: null }
  const ok = (r: ReturnType<typeof choose>) => { if ('error' in r) throw new Error('x'); return r }
  it('rejects a bad risk or a missing why and ignores malformed needs', () => {
    expect(parseAssessment({ difficulty: 'low', risk: 'urgent', why: 'x' })).toContain('risk')
    expect(parseAssessment({ difficulty: 'low', risk: 'low', why: 7 })).toContain('why')
    expect(parseAssessment({ difficulty: 'low', risk: 'low', why: 'x', needs: null }))
      .toEqual({ difficulty: 'low', risk: 'low', why: 'x', needs: { tools: [], devices: [] } })
    expect(parseAssessment({ difficulty: 'low', risk: 'low', why: 'x', needs: { tools: 'git', devices: [1], cwd: 5 } })).toContain('absolute')
    expect(parseAssessment({ difficulty: 'low', risk: 'low', why: 'x', needs: { devices: ['cam'], cwd: '/work' } }))
      .toEqual({ difficulty: 'low', risk: 'low', why: 'x', needs: { tools: [], devices: ['cam'], cwd: '/work' } })
  })
  it('keeps the tightest window whatever its order and drops an unusable reset', () => {
    expect(quotaOf2({ known: true, windows: [{ usedPercent: 70, resetsAt: 1_800_000_000 }, { usedPercent: 20, resetsAt: null }] }))
      .toEqual({ known: true, leftPercent: 30, resetsAt: 1_800_000_000_000 })
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
    expect(r.shown.map(s => s.title)).toEqual(['New agent · Claude sonnet medium · mac', 'Member · Claude sonnet medium · remote-1'])
    expect(r.shown[1].label).toContain('Member ·')
    expect(r.shown[1].label).toContain('quota unknown')
    expect(r.shown[0].label).toContain('quota 40% left')
    expect(ok(choose([probe({ known: false, quota: unknownQuota })], policy, a())).shown[0].label).toContain('quota unknown')
    expect(ok(choose([probe({ quota: { known: true, leftPercent: 50, resetsAt: 0 } })], policy, a())).shown[0].label).toContain('resets in 1m')
  })
  it('tells Jev how far away a reset is, because Jev does not know the time', () => {
    const label = (resetsAt: number) => ok(choose([probe({ quota: { known: true, leftPercent: 50, resetsAt } })], policy, a(), 1_000_000)).shown[0].label
    expect(label(1_000_000 + 30 * 60_000)).toContain('quota 50% left, resets in 30m')
    expect(label(1_000_000 + 2 * 3_600_000)).toContain('resets in 2h')
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
  it('tells Jev about tools, devices, an empty history, a missed floor and absent notes', () => {
    const r = ok(choose([probe({ quality: 1 })], policy, a({ difficulty: 'high' })))
    const q = jevQuestion({ title: 'T', brief: '', checks: [], history: [] }, a({ needs: { tools: ['git', 'node'], devices: ['cam'] } }), { ...policy, notes: '' }, r)
    expect(q.state.lead).toContain('tools: git, node; devices: cam')
    expect(q.state.policy).toContain('no candidate meets it')
    expect(q.state.policy).toContain('Notes: none')
    expect(q.state.history).toBe('No earlier attempts.')
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
      decide(r, undefined, long), a(), { ...policy, notes: '' }) as { candidates: Array<Record<string, string>>; excluded: Array<{ reason: string }>; why: string; notes: boolean; p: number | null }
    expect(rec.candidates.every(c => /^c\d{1,2}$/.test(c.id) && c.title.length <= 160 && c.label.length <= 640 && /^[A-Za-z0-9_-]+$/.test(c.machineId))).toBe(true)
    expect(rec.excluded).toHaveLength(200)
    expect(rec.excluded.every(e => e.reason.length <= 500)).toBe(true)
    expect(rec.why.length).toBeLessThanOrEqual(300)
    expect(rec.notes).toBe(false)
    expect(rec.p).toBeNull()
  })
})
