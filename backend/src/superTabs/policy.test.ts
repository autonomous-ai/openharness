import { describe, expect, it } from 'vitest'
import { MAX_RULES_BYTES, projectRulesSchema, rulesDiff, rulesEqual, SEED_RULES, type ProjectRules } from './policy.js'

const copy = (): ProjectRules => structuredClone(SEED_RULES)
const refused = (value: unknown) => projectRulesSchema.safeParse(value).success === false

describe('the project rules record', () => {
  // Task #3393 (anh Dee's Swarm redesign, 11-05): the numbers the project runs on today, in project data, not constants.
  it('seeds today\'s numbers', () => {
    expect(projectRulesSchema.parse(SEED_RULES)).toEqual(SEED_RULES)
    expect(SEED_RULES.releaseWindow).toEqual({ start: '09:00', end: '18:00', timeZone: 'Asia/Ho_Chi_Minh' })
    expect(SEED_RULES.releasePace).toEqual({ backendEveryMinutes: 120, appsAfterVisibleBatch: true })
    expect(SEED_RULES.reviews.defaultReads).toBe(1)
    expect(SEED_RULES.reviews.rows).toEqual(['Sign-in', 'Tokens', 'Encryption', 'Access', 'Buddy guard', 'Device links', 'Deletion']
      .map(area => ({ area, reads: 2 })))
    expect(SEED_RULES.reviews.test).toBe('Where the change runs')
    expect(SEED_RULES.mergeTrain).toEqual({ enabled: true, everyMinutes: 30 })
    expect(SEED_RULES).toMatchObject({ caps: [], paths: [], crew: [], lanes: [] })
  })

  it('holds caps, paths, the crew and lanes', () => {
    const rules = { ...copy(), caps: [{ name: 'Agents on the phone Mac', value: 4 }], paths: [{ name: 'Plans', path: 'docs/plans/' }],
      crew: [{ role: 'Engineer', names: ['Ledger'] }], lanes: [{ name: 'Backend', owns: ['backend/'] }] }
    expect(projectRulesSchema.parse(rules)).toEqual(rules)
  })

  it('refuses bad values', () => {
    expect(refused({ ...copy(), extra: 1 })).toBe(true)
    expect(refused({ ...copy(), releaseWindow: { ...SEED_RULES.releaseWindow, start: '25:00' } })).toBe(true)
    expect(refused({ ...copy(), releaseWindow: { ...SEED_RULES.releaseWindow, start: '18:00', end: '09:00' } })).toBe(true)
    expect(refused({ ...copy(), releaseWindow: { ...SEED_RULES.releaseWindow, timeZone: 'Mars/Base' } })).toBe(true)
    expect(refused({ ...copy(), releasePace: { ...SEED_RULES.releasePace, backendEveryMinutes: 0 } })).toBe(true)
    expect(refused({ ...copy(), releasePace: { ...SEED_RULES.releasePace, backendEveryMinutes: 1.5 } })).toBe(true)
    expect(refused({ ...copy(), reviews: { ...SEED_RULES.reviews, defaultReads: 0 } })).toBe(true)
    expect(refused({ ...copy(), reviews: { ...SEED_RULES.reviews, rows: [{ area: '', reads: 2 }] } })).toBe(true)
    expect(refused({ ...copy(), reviews: { ...SEED_RULES.reviews, rows: [{ area: 'Tokens', reads: 2 }, { area: 'tokens', reads: 1 }] } })).toBe(true)
    expect(refused({ ...copy(), mergeTrain: { enabled: 'yes', everyMinutes: 30 } })).toBe(true)
    expect(refused({ ...copy(), caps: Array.from({ length: 51 }, (_, i) => ({ name: `Cap ${i}`, value: i })) })).toBe(true)
    expect(refused({ ...copy(), caps: [{ name: 'Agents', value: -1 }] })).toBe(true)
    expect(refused({ ...copy(), paths: [{ name: 'Plans', path: 'docs/\nplans/' }] })).toBe(true)
    const { mergeTrain: _gone, ...missing } = copy()
    expect(refused(missing)).toBe(true)
    // At most 8 KB as stored: within every list's own limits, still too big together.
    const big = { ...copy(), crew: Array.from({ length: 50 }, (_, i) => ({ role: `Role ${i}`, names: Array.from({ length: 5 }, (_, j) => `${'n'.repeat(60)}${j}`) })) }
    expect(Buffer.byteLength(JSON.stringify(big))).toBeGreaterThan(MAX_RULES_BYTES)
    expect(refused(big)).toBe(true)
  })

  it('lists what changed, by path, and nothing for an equal record', () => {
    const after = copy()
    after.releaseWindow.start = '10:00'
    after.reviews.rows = [...after.reviews.rows, { area: 'Payments', reads: 2 }]
    after.mergeTrain.enabled = false
    expect(rulesDiff(SEED_RULES, after)).toEqual([
      { path: 'releaseWindow.start', before: '09:00', after: '10:00' },
      { path: 'reviews.rows', before: SEED_RULES.reviews.rows, after: after.reviews.rows },
      { path: 'mergeTrain.enabled', before: true, after: false },
    ])
    expect(rulesDiff(SEED_RULES, copy())).toEqual([])
    expect(rulesEqual(SEED_RULES, copy())).toBe(true)
    expect(rulesEqual(SEED_RULES, after)).toBe(false)
  })
})
