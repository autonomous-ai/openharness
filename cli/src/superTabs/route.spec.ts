// cli/src/superTabs/route.spec.ts
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { choose, contextSize, decide, floorFor, jevQuestion, parseAssessment, quotaOf2, rateFor, recordOf, repoMatch, scrub, type Assessment, type MemberFrame, type Policy, type Probe, type TaskFolder } from './route.js'

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
      .toMatchObject({ known: true, leftPercent: 30, resetsAt: Date.parse('2026-10-19T12:00:00Z') })
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

const base = { title: 'T', brief: '', checks: [] as string[], messages: [] as Array<{ from: string; text: string }> | null, folder: null as TaskFolder | null,
  attempts: [] as Array<{ agent: string; outcome: string; result?: string }>, recent: [] as Array<{ title: string; via: string; outcome: string | null }> | null }
const ok = (r: ReturnType<typeof choose>) => { if ('error' in r) throw new Error('x'); return r }
const frame = (patch: Partial<MemberFrame> = {}): MemberFrame => ({ title: 'Fix auth', project: 'api', cwd: '/w/api', root: '/w/api', remote: 'github.com/acme/api', branch: 'feat/auth', updatedAt: 1_000_000 - 2 * 3_600_000, ...patch })
const folder = (patch: Partial<TaskFolder> = {}): TaskFolder => ({ cwd: '/w/api', kind: 'git', name: 'api', root: '/w/api', remote: 'github.com/acme/api', ...patch })

describe('Jev context and verdict', () => {
  const choice = () => { const r = choose([probe({ kind: 'member', agentId: 'a1', name: 'Multiply', activity: 'idle' }), probe({ machineName: 'mac' })], policy, a()); if ('error' in r) throw new Error('x'); return r }
  it('builds at most four string keys within the hosted limits, with no email', () => {
    const q = jevQuestion({ ...base, title: 'Build', brief: 'b'.repeat(5000), checks: ['Tests pass', 'Docs updated'], attempts: [{ agent: 'Builder', outcome: 'stopped' }] }, a(), policy, choice())
    expect(Object.keys(q.state)).toEqual(['task', 'lead', 'policy', 'history'])
    expect(Object.values(q.state).every(v => typeof v === 'string')).toBe(true)
    expect(Object.values(q.state).join('').length).toBeLessThanOrEqual(17_000)
    expect(q.state.task.length).toBeLessThan(5000)
    expect(q.state.history).toContain('Builder: stopped')
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
    const q = jevQuestion({ ...base, title: 'T' }, a({ needs: { tools: ['git', 'node'], devices: ['cam'] } }), { ...policy, notes: '' }, r)
    expect(q.state.lead).toContain('tools: git, node; devices: cam')
    expect(q.state.policy).toContain('no candidate meets it')
    expect(q.state.policy).toContain('Notes: none')
    expect(q.state.history).toContain('No earlier attempts in this group.')
  })
  it('ends the Lead\'s reason with exactly one period, whatever the Lead ended it with', () => {
    const r = ok(choose([probe({ quality: 3 })], policy, a()))
    const lead = (why: string) => jevQuestion({ ...base, title: 'T' }, a({ why }), policy, r).state.lead
    for (const why of ['Add one function', 'Add one function.', 'Add one function...']) expect(lead(why)).toContain('Why: Add one function. Task folder')
    // A question or an exclamation is already a full stop.
    expect(lead('Is it safe?')).toContain('Why: Is it safe? Task folder')
    expect(lead('Do it now!')).toContain('Why: Do it now! Task folder')
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

// Every fake secret is built here from pieces, so that no source line holds a whole key shape (GitHub push protection
// refuses those, even in a test).
const fake = (...parts: string[]) => parts.join('')
const AWS_ID = fake('AKIA', 'IOSFODNN7', 'EXAMPLE')
const AWS_SECRET = fake('wJalrXUtnFEMI/', 'K7MDENG/', 'bPxRfiCYEXAMPLEKEY')
// Random-looking 40-character base64 keys that keep a `/` inside (a leading one is not a key shape): the same twelve every run.
const slashedKeys = Array.from({ length: 400 }, (_, i) => createHash('sha256').update(String(i)).digest('base64').slice(0, 40))
  .filter(key => key.slice(1, -1).includes('/')).slice(0, 12)

describe('scrub', () => {
  it('replaces emails and each token shape, and leaves ordinary text alone', () => {
    const text = [
      'mail minh.doanh+x@example.com now', fake('key sk-', 'proj-', 'abcdefghijklmnop1234'), fake('gh ghp', '_abcdefghijklmnopqrstuvwx'), fake('slack xox', 'b-1234567890-abcdef'),
      fake('aws AKIA', 'ABCDEFGHIJKLMNOP'), fake('auth Bear', 'er eyJ', 'hbGciOi.abc-def_ghi'), `hex ${'a1'.repeat(16)}`, `b64 ${'Zm9vYmFy0'.repeat(5)}==`, 'plain words and /usr/bin/node stay',
    ].join('\n')
    const out = scrub(text)
    expect(out).not.toMatch(/@|sk-|ghp_|xoxb|AKIA|Bearer|a1a1a1|Zm9v/)
    expect(out.match(/\[email\]/g)).toHaveLength(1)
    expect(out.match(/\[secret\]/g)!.length).toBeGreaterThanOrEqual(7)
    expect(out).toContain('plain words and /usr/bin/node stay')
    expect(scrub('commit abc1234 at v1.2.3')).toBe('commit abc1234 at v1.2.3')
  })
  it('keeps paths, URLs, branch names, UUIDs and file names, and still catches real keys', () => {
    for (const keep of [
      'docs/superpowers/specs/2026-10-19-super-tab-routing-v1-design.md', 'https://github.com/autonomous-ai/openharness/pull/1424',
      '0xken15/feat/super-tab-jev-context-v2', '/Users/nqhieu84/harnesses/worktrees/openharness/routing-v1', '3f2b8c1e-9a4d-4e57-8b1a-6c0d2e9f7a31',
      'feature/Add-OAuth2-Flow-For-Mobile-Clients-2026-10',
    ]) expect(scrub(`see ${keep} now`)).toBe(`see ${keep} now`)
    // A key is judged on its own, even inside a path or after an equals sign.
    for (const key of [
      fake('sk-', 'proj-', 'AbCdEf0123456789abcdefGH'), fake('ghp', '_AbCdEf0123456789abcdefghijklmn'), AWS_ID, fake('xox', 'b-123456789012-abcdefABCDEF'),
      fake('eyJ', 'hbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.', 'eyJ', 'zdWIiOiIxMjM0NTY3ODkwIn0.', 'dBjftJeZ4CVPmB92K27', 'uhbUJU1p1rwW1gFWFOEjXk'),
      fake('wJalrXUtnFEMIK7MDENG', 'bPxRfiCYEXAMPLEKEY12='),
      fake('Zm9vYmFyQmF6UXV4', 'MTIzNDU2Nzg5MEFiQ2RF', 'ZkdoSWpLbE1u'), fake('Ab3_dEf-9GhI1jKl_', 'MnO5pQr-StU7vWx_YzA2bCd4'), fake('e3b0c44298fc1c14', '9afbf4c8996fb924', '27ae41e4'),
    ]) {
      expect(scrub(`k ${key} z`)).toBe('k [secret] z')
      expect(scrub(`path/${key}/end`)).toContain('[secret]')
    }
    // Standard base64 keys keep their `/`: AWS's documented example secret key, and a fixed sample of random 40-character keys.
    expect(scrub(`secret ${AWS_SECRET} here`)).toBe('secret [secret] here')
    expect(scrub(`AWS_SECRET_ACCESS_KEY=${AWS_SECRET}`)).toBe('AWS_SECRET_ACCESS_KEY=[secret]')
    expect(slashedKeys).toHaveLength(12)
    for (const key of slashedKeys) {
      expect(scrub(`k ${key} z`)).toBe('k [secret] z')
      expect(scrub(`"${key}"`)).toBe('"[secret]"')
    }
    // A relative path of plain words is not a key, even with a digit and a capital in it.
    expect(scrub('see src/superTabs/RouteCommand/specHelpers/Util2/fixtures now')).toBe('see src/superTabs/RouteCommand/specHelpers/Util2/fixtures now')
    // Bearer needs a token-like value, and its spelling.
    expect(scrub('Bearer is a word, and bearer token too')).toBe('Bearer is a word, and bearer token too')
    expect(scrub(fake('Authorization: Bear', 'er abcdefghij', '0123456789klmn'))).toBe('Authorization: [secret]')
  })
})

describe('the context Jev is given', () => {
  const now = 1_000_000
  const members = (patch: Partial<Probe> = {}) => ok(choose([
    probe({ kind: 'member', agentId: 'a1', name: 'Multiply', activity: 'idle', frame: frame(), repo: 'same', earlier: [{ group: 'API', outcome: 'done' }], ...patch }),
    probe({ machineName: 'mac', load: { agents: 3, freeMemoryBytes: 6.5e9, hasFolder: true } }),
  ], policy, a(), now))
  const ask = (patch: Record<string, unknown> = {}, choice = members()) => jevQuestion({ ...base, ...patch }, a({ needs: { tools: [], devices: [], cwd: '/w/api' } }), policy, choice)

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
  it('names the task folder and its repository in the Lead\'s assessment', () => {
    expect(ask({ folder: folder() }).state.lead).toContain('Task folder: api (git repository api)')
    expect(ask({ folder: folder({ cwd: '/w/notes', kind: 'none', name: null, root: null }) }).state.lead).toContain('Task folder: notes (not a git repository)')
    expect(ask({ folder: folder({ kind: 'unknown', name: null }) }).state.lead).toContain('Task folder: api (repository unknown)')
    expect(ask({ folder: folder({ cwd: '/', name: null }) }).state.lead).toContain('Task folder: / (git repository )')
    expect(ask({ folder: folder({ kind: 'missing', name: null, root: null, remote: null }) }).state.lead).toContain('Task folder: api (not on the Lead\'s machine)')
    expect(ask({ folder: null }).state.lead).toContain('Task folder: not stated')
    expect(ask({ folder: folder() }).state.lead).not.toContain('/w/')
  })
  it('gives the last messages as a role-tagged transcript, newest last, and marks missing or empty ones', () => {
    const messages = Array.from({ length: 4 }, (_, i) => ({ from: i % 2 ? 'Lead' : 'person', text: `m${i}` }))
    expect(ask({ messages }).state.task).toContain('Recent messages:\nperson: m0\nLead: m1\nperson: m2\nLead: m3')
    expect(ask({ messages: [] }).state.task).toContain('Recent messages: none')
    expect(ask({ messages: null }).state.task).toContain('Recent messages: unknown')
    expect(ask({ messages: [], noneInLatest: true }).state.task).toContain('Recent messages: none in the latest 100 messages')
    expect(ask({ messages: [{ from: 'Multiply', text: 'x' }] }).state.task).toContain('Multiply: x')
  })
  it('tells the policy: the cost scale and why the floor is what it is', () => {
    const policyText = (assessment: Assessment, p = policy) => { const c = ok(choose([probe({ quality: 3 })], p, assessment, now)); return jevQuestion(base, assessment, p, c).state.policy }
    expect(policyText(a({ difficulty: 'high', risk: 'low' }))).toContain('Quality floor: 3 (difficulty high needs quality 3).')
    expect(policyText(a({ difficulty: 'medium', risk: 'high' }))).toContain('Quality floor: 3 (difficulty medium needs quality 2, plus 1 for high risk).')
    expect(policyText(a({ difficulty: 'high', risk: 'high' }))).toContain('Quality floor: 3 (difficulty high needs quality 3, plus 1 for high risk, at most 3).')
    expect(policyText(a())).toContain('Cost is relative: cost 3 is about 3 times cost 1.')
  })
  it('lists all attempts in the group with their outcome and a cut result, and the last routing decisions', () => {
    const q = ask({ attempts: [{ agent: 'Multiply', outcome: 'stopped', result: 'r'.repeat(300) }, { agent: 'New agent (claude opus)', outcome: 'done' }],
      recent: [{ title: 'Multiply · Claude sonnet medium · remote-1', via: 'jev', outcome: 'stopped' }, { title: 'New agent · Codex', via: 'order', outcome: null }] })
    expect(q.state.history).toContain(`- Multiply: stopped — ${'r'.repeat(199)}…`)
    expect(q.state.history).toContain('- New agent (claude opus): done')
    expect(q.state.history).toContain('- Multiply · Claude sonnet medium · remote-1 (jev): stopped')
    expect(q.state.history).toContain('- New agent · Codex (order): open')
    expect(ask({ recent: [{ title: 'Pick', outcome: 'done' }] }).state.history).toContain('- Pick: done')
    expect(ask({ recent: null }).state.history).toContain('Recent routing in this Super Tab: unknown')
    expect(ask({ recent: [] }).state.history).toContain('Recent routing in this Super Tab: none')
  })
  it('keeps the newest of too many messages and attempts, with a mark for what was dropped', () => {
    const words = (i: number) => `msg${i} ${'lorem ipsum '.repeat(40)}`.slice(0, 500).padEnd(500, '.')
    const messages = Array.from({ length: 10 }, (_, i) => ({ from: 'person', text: words(i) }))
    const task = ask({ messages }).state.task
    const part = task.slice(task.indexOf('Recent messages:'))
    expect(part.length).toBeLessThanOrEqual('Recent messages:\n'.length + 3500)
    expect(part).toContain('…\n')
    expect(part.endsWith(words(9))).toBe(true)
    expect(part).not.toContain('msg0')
    const attempts = Array.from({ length: 60 }, (_, i) => ({ agent: `Agent${i}`, outcome: 'stopped', result: 'x'.repeat(200) }))
    const history = ask({ attempts }).state.history
    expect(history).toContain('Agent59')
    expect(history).not.toContain('Agent0:')
    expect(history).toMatch(/…/)
  })
  it('scrubs emails and secrets everywhere, so no @ or token reaches Jev', () => {
    const dirty = fake('ping a@b.co with sk-', 'abcdefghijklmnopqrstu and Bear', 'er abcdef.ghijklmnop.qrstuvwxyz and ghp', '_abcdefghijklmnopqrstuvw')
    const choice = ok(choose([probe({ kind: 'member', agentId: 'a1', name: 'Multiply', frame: frame({ title: dirty, branch: 'x@y.io' }), repo: 'same', earlier: [{ group: dirty, outcome: 'done' }] }),
      probe({ machineName: 'mac' })], policy, a(), now))
    const q = jevQuestion({ ...base, title: dirty, brief: dirty, checks: [dirty], messages: [{ from: 'person', text: dirty }],
      attempts: [{ agent: 'Multiply', outcome: 'stopped', result: dirty }], recent: [{ title: dirty, via: 'jev', outcome: null }] },
    a({ why: dirty, needs: { tools: [], devices: [], cwd: '/w/a@b.co' } }), { ...policy, notes: dirty }, choice)
    const all = JSON.stringify(q)
    expect(all).not.toMatch(/@|sk-abc|ghp_|Bearer/)
    expect(all).toContain('[email]')
    expect(all).toContain('[secret]')
  })
  it('stays within every hosted limit and its own budget at the worst case', () => {
    const long = (c: string, n: number) => c.repeat(n)
    const probes = Array.from({ length: 12 }, (_, i) => probe({ kind: 'member', agentId: `a${i}`, name: long('N', 80), machineName: long('M', 80), model: long('o', 200), activity: 'idle',
      frame: frame({ title: long('T', 300), project: long('P', 300), branch: long('Q', 300) }), repo: 'same',
      earlier: Array.from({ length: 9 }, () => ({ group: long('G', 90), outcome: 'stopped' })),
      quota: { known: true, leftPercent: 50, resetsAt: now + 1e9, windows: [{ name: '5-hour', leftPercent: 50, resetsAt: now + 3_600_000 }, { name: 'weekly', leftPercent: 70, resetsAt: now + 5 * 86_400_000 }] } }))
    const choice = ok(choose(probes, { ...policy, notes: long('n', 3000) }, a(), now))
    const q = jevQuestion({ title: long('t', 500), brief: long('k', 9000), checks: Array.from({ length: 30 }, () => long('q', 200)),
      messages: Array.from({ length: 10 }, () => ({ from: long('X', 90), text: long('m', 2000) })), folder: folder({ cwd: `/${long('z', 300)}`, name: long('r', 300) }),
      attempts: Array.from({ length: 40 }, () => ({ agent: long('Y', 90), outcome: 'stopped', result: long('x', 900) })),
      recent: Array.from({ length: 5 }, () => ({ title: long('R', 200), via: 'jev', outcome: 'stopped' })) },
    a({ why: long('w', 300), needs: { tools: Array.from({ length: 20 }, () => long('t', 80)), devices: Array.from({ length: 20 }, () => long('/z', 40)), cwd: `/${long('z', 300)}` } }),
    { ...policy, notes: long('n', 3000) }, choice)
    expect(Object.keys(q.state)).toEqual(['task', 'lead', 'policy', 'history'])
    const limit = { task: 7000, lead: 1000, policy: 1000, history: 6000 } as const
    for (const key of Object.keys(limit) as Array<keyof typeof limit>) {
      expect(q.state[key].length).toBeLessThanOrEqual(limit[key])
      // Whole messages and attempts are kept or dropped, so a part may end up to one line short of its budget.
      expect(q.state[key].length).toBeGreaterThan(limit[key] - 700)
    }
    expect(Object.values(q.state).reduce((sum, v) => sum + v.length, 0)).toBeLessThanOrEqual(15_000)
    const labels = Object.values(q.questions.who.criteria)
    expect(labels).toHaveLength(12)
    expect(labels.every(l => l.length <= 640)).toBe(true)
    expect(labels.some(l => l.endsWith('…'))).toBe(true)
    expect(q.questions.who.instructions.length).toBeLessThanOrEqual(1500)
    expect(contextSize(q)).toBe(Object.values(q.state).reduce((sum, v) => sum + v.length, 0) + labels.reduce((sum, l) => sum + l.length, 0) + q.questions.who.instructions.length)
    // The parts that matter stay: the end of the messages and the task's own budgets.
    expect(q.state.task).toContain('Brief: ' + long('k', 100))
    expect(q.state.task).toContain('Recent messages:')
  })
  it('records the size of the context and what was missing, only when given', () => {
    const c = members(), v = decide(c, undefined, 'BUSY')
    expect(recordOf(c, v, a(), policy, { chars: 5000, missing: ['messages'] })).toMatchObject({ context: { chars: 5000, missing: ['messages'] } })
    expect(recordOf(c, v, a(), policy)).not.toHaveProperty('context')
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
