import { describe, expect, it, vi } from 'vitest'
import { JevUnavailable } from './jev/jevClient.js'
import { createTierDecider, fallbackTier, isTier, type TierInput } from './notifyTier.js'

const base: TierInput = {
  agent: 'lamp', engine: 'codex', recap: 'Shipped the thing.', durationS: 300,
  stats: { testsPassed: 640, testsFailed: 0, commits: 1 }, subagent: false, onScreen: false, failed: false,
}
const answer = (choice: string) => ({ tier: { choice, probabilities: { alert: 0.1, list: 0.2, silent: 0.7, [choice]: 0.9 } } })
const make = (jev: any, extra: object = {}) => {
  const log = vi.fn()
  return { log, decide: createTierDecider({ jev, log, ...extra }) }
}

describe('notifyTier', () => {
  it('reads only the three tiers as one', () => {
    for (const tier of ['alert', 'list', 'silent']) expect(isTier(tier)).toBe(true)
    for (const value of [undefined, null, '', 'ALERT', 'loud', 1, {}]) expect(isTier(value)).toBe(false)
  })

  it('falls back to a list entry for a turn of two minutes or more, silence for a shorter or unknown one', () => {
    expect(fallbackTier(120)).toBe('list')
    expect(fallbackTier(119)).toBe('silent')
    expect(fallbackTier(null)).toBe('silent')
  })

  it('failed → alert by rule, Jev never asked', async () => {
    const jev = vi.fn()
    const { decide } = make(jev)
    const d = await decide({ ...base, failed: true })
    expect(d).toMatchObject({ tier: 'alert', by: 'rule:failed' })
    expect(jev).not.toHaveBeenCalled()
  })

  it('subagent → silent; onScreen → silent; empty recap → silent', async () => {
    const jev = vi.fn()
    const { decide } = make(jev)
    expect(await decide({ ...base, subagent: true })).toMatchObject({ tier: 'silent', by: 'rule:subagent' })
    expect(await decide({ ...base, onScreen: true })).toMatchObject({ tier: 'silent', by: 'rule:onScreen' })
    expect(await decide({ ...base, recap: '  ' })).toMatchObject({ tier: 'silent', by: 'rule:empty' })
    expect(jev).not.toHaveBeenCalled()
  })

  it('otherwise asks Jev once with recap ≤ 600 chars and recent counts; returns its choice', async () => {
    const jev = vi.fn(async () => answer('list'))
    const { decide } = make(jev)
    const d = await decide({ ...base, recap: 'x'.repeat(2000) })
    expect(d).toMatchObject({ tier: 'list', by: 'jev' })
    expect(jev).toHaveBeenCalledTimes(1)
    const [state, questions] = jev.mock.calls[0] as any[]
    expect(state.recap.length).toBeLessThanOrEqual(600)
    expect(state).toMatchObject({
      agent: 'lamp', engine: 'codex', duration_s: 300,
      work: { tests_passed: 640, tests_failed: 0, commits: 1 }, recent: { alerts_30m: 0, lists_30m: 0 },
    })
    expect(Object.keys(questions)).toEqual(['tier'])
    expect(Object.keys(questions.tier.criteria)).toEqual(['alert', 'list', 'silent'])
  })

  it('Jev unavailable / too slow / null answer → fallback by duration', async () => {
    const down = make(vi.fn(async () => { throw new JevUnavailable('NO_KEY', 'no key') }))
    expect(await down.decide(base)).toMatchObject({ tier: 'list', by: 'fallback:NO_KEY' })
    expect(await down.decide({ ...base, durationS: 119 })).toMatchObject({ tier: 'silent' })
    expect(await down.decide({ ...base, durationS: null })).toMatchObject({ tier: 'silent' })
    const slow = make(() => new Promise(() => {}), { budgetMs: 20 })
    expect(await slow.decide(base)).toMatchObject({ tier: 'list', by: 'fallback:timeout' })
    const bad = make(vi.fn(async () => ({})))
    expect(await bad.decide({ ...base, durationS: 10 })).toMatchObject({ tier: 'silent', by: 'fallback:no-answer' })
    // Anything else it throws is not Jev saying why: the rule all the same, said as an error.
    const broken = make(vi.fn(async () => { throw new Error('socket hang up') }))
    expect(await broken.decide(base)).toMatchObject({ tier: 'list', by: 'fallback:error' })
  })

  it('jev null → fallback without calling anything', async () => {
    const { decide } = make(null)
    expect(await decide(base)).toMatchObject({ tier: 'list', by: 'fallback:off' })
  })

  it('logs exactly one line per decision', async () => {
    const { decide, log } = make(vi.fn(async () => answer('alert')))
    await decide(base)
    await decide({ ...base, failed: true })
    expect(log).toHaveBeenCalledTimes(4) // each decision, then the day's count
    expect(log.mock.calls[1][0]).toMatch(/^notify · day \d{4}-\d\d-\d\d · alert 1 · list 0 · silent 0$/)
    expect(log.mock.calls[0][0]).toMatch(/^notify · lamp · alert · jev · .+ · \d+ms$/)
    expect(log.mock.calls[2][0]).toMatch(/^notify · lamp · alert · rule:failed · .+ · \d+ms$/)
  })

  it('recent counts: alerts in a 30 min window, older ones drop out', async () => {
    let t = 0
    const jev = vi.fn(async () => answer('alert'))
    const { decide } = make(jev, { now: () => t })
    for (let i = 0; i < 3; i++) { t = i * 60_000; await decide(base) }
    t = 4 * 60_000
    await decide(base)
    expect((jev.mock.calls[3] as any[])[0].recent.alerts_30m).toBe(3)
    t = 31 * 60_000
    await decide(base)
    expect((jev.mock.calls[4] as any[])[0].recent.alerts_30m).toBe(2)
  })

  it('5 concurrent decisions resolve independently within the budget', async () => {
    const { decide } = make(() => new Promise(() => {}), { budgetMs: 50 })
    const start = Date.now()
    const all = await Promise.all([1, 2, 3, 4, 5].map(() => decide(base)))
    expect(all.every((d) => d.by === 'fallback:timeout')).toBe(true)
    expect(Date.now() - start).toBeLessThan(250)
  })
})
