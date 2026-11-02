import { describe, expect, it, vi } from 'vitest'
import { createTierDecider, fallbackTier, isTier, type TierInput } from './notifyTier.js'

const base: TierInput = {
  agent: 'lamp', engine: 'codex', recap: 'Shipped the thing.', durationS: 300,
  stats: { testsPassed: 640, testsFailed: 0, commits: 1 }, subagent: false, onScreen: false, failed: false, swarm: false,
}
const make = (extra: object = {}) => {
  const log = vi.fn()
  return { log, decide: createTierDecider({ log, ...extra }) }
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

  it("a harness agent's finished turn alerts", async () => {
    const { decide } = make()
    expect(await decide(base)).toMatchObject({ tier: 'alert', by: 'rule:turn' })
  })

  it("a Swarm agent's finished turn is silent", async () => {
    const { decide } = make()
    expect(await decide({ ...base, swarm: true })).toMatchObject({ tier: 'silent', by: 'rule:swarm' })
  })

  it('the fixed rules come first', async () => {
    const { decide } = make()
    expect(await decide({ ...base, failed: true, swarm: true })).toMatchObject({ tier: 'alert', by: 'rule:failed' })
    expect(await decide({ ...base, subagent: true })).toMatchObject({ tier: 'silent', by: 'rule:subagent' })
    expect(await decide({ ...base, onScreen: true })).toMatchObject({ tier: 'silent', by: 'rule:onScreen' })
    expect(await decide({ ...base, recap: '  ' })).toMatchObject({ tier: 'silent', by: 'rule:empty' })
  })

  it('takes no Jev', async () => {
    const log = vi.fn()
    expect(await createTierDecider({ log })(base)).toMatchObject({ tier: 'alert' })
    expect('tierState' in (await import('./notifyTier.js'))).toBe(false)
  })

  it('logs each decision, then the day\'s count', async () => {
    const { decide, log } = make()
    await decide(base)
    await decide({ ...base, failed: true })
    expect(log).toHaveBeenCalledTimes(4)
    expect(log.mock.calls[1][0]).toMatch(/^notify · day \d{4}-\d\d-\d\d · alert 1 · list 0 · silent 0$/)
    expect(log.mock.calls[0][0]).toMatch(/^notify · lamp · alert · rule:turn · turn · \d+ms$/)
    expect(log.mock.calls[2][0]).toMatch(/^notify · lamp · alert · rule:failed · .+ · \d+ms$/)
  })
})
