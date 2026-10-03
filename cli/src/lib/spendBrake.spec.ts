// Originally written by Fred Nix (@nixfred) in github.com/nixfred/openharness (MIT).

import { describe, expect, it } from 'vitest'
import { DEFAULT_CAPS, dayKey, decideSpend, emptyLedger, estimateUsd, parseCaps, priceFor, recordUsage } from './spendBrake.js'

// 2026-09-26T03:30:00Z is 23:30 on the 25th in New York.
const NIGHT = Date.UTC(2026, 8, 26, 3, 30)
const MORNING = Date.UTC(2026, 8, 26, 12, 0)

describe('prices', () => {
  it('matches by family substring with a fallback', () => {
    expect(priceFor('claude-opus-4-1')).toEqual({ input: 15, output: 75 })
    expect(priceFor('qwen2.5-coder:14b-local').input).toBe(0)
    expect(priceFor('mystery-model')).toEqual({ input: 3, output: 15 })
    expect(estimateUsd({ input: 1_000_000, output: 100_000 }, priceFor('sonnet'))).toBeCloseTo(4.5)
  })
})

describe('ledger', () => {
  it('keys days in the given time zone and rolls over at its local midnight', () => {
    const tz = 'America/New_York'
    expect(dayKey(NIGHT, tz)).toBe('2026-09-25')
    expect(dayKey(MORNING, tz)).toBe('2026-09-26')
    let l = recordUsage(emptyLedger(NIGHT, tz), { agentId: 'a', model: 'sonnet', input: 500_000, output: 50_000, now: NIGHT }, undefined, tz)
    expect(l.agents.a?.usd).toBeCloseTo(2.25)
    l = recordUsage(l, { agentId: 'b', model: 'sonnet', input: 100, output: 10, now: MORNING }, undefined, tz)
    expect(l.day).toBe('2026-09-26')
    expect(Object.keys(l.agents)).toEqual(['b'])
  })
})

describe('decideSpend', () => {
  const caps = { ...DEFAULT_CAPS, enabled: true, perAgentUsd: 10, perDayUsd: 20 }
  it('runs, warns at 80 percent, pauses at the cap, naming the tightest cap', () => {
    let l = recordUsage(emptyLedger(MORNING), { agentId: 'a', model: 'sonnet', input: 1_000_000, output: 100_000, now: MORNING }) // $4.50
    expect(decideSpend(caps, l, 'a').action).toBe('run')
    l = recordUsage(l, { agentId: 'a', model: 'sonnet', input: 2_000_000, output: 150_000, now: MORNING }) // $8.25
    expect(decideSpend(caps, l, 'a')).toMatchObject({ action: 'warn', fraction: 0.825 })
    l = recordUsage(l, { agentId: 'a', model: 'sonnet', input: 3_000_000, output: 100_000, now: MORNING }) // $10.50
    const v = decideSpend(caps, l, 'a')
    expect(v.action).toBe('pause')
    expect(v.reason).toBe('paused: agent at $10.50 of $10')
  })
  it('the day cap pauses a cheap agent when others spent the budget', () => {
    let l = recordUsage(emptyLedger(MORNING), { agentId: 'big', model: 'opus', input: 1_000_000, output: 100_000, now: MORNING }) // $22.50
    l = recordUsage(l, { agentId: 'small', model: 'haiku', input: 1000, output: 100, now: MORNING })
    const v = decideSpend(caps, l, 'small')
    expect(v.action).toBe('pause')
    expect(v.reason).toMatch(/machine at \$22\.50 of \$20 today/)
  })
  it('disabled or capless means run', () => {
    const l = emptyLedger(MORNING)
    expect(decideSpend({ ...caps, enabled: false }, l, 'a').action).toBe('run')
    expect(decideSpend({ ...caps, perAgentUsd: null, perDayUsd: null }, l, 'a').reason).toBe('no caps set')
  })
})

describe('parseCaps', () => {
  it('validates shape', () => {
    expect(parseCaps(DEFAULT_CAPS).ok).toBe(true)
    const bad = parseCaps({ version: 1, enabled: true, perAgentUsd: -1, perAgentTokens: null, perDayUsd: 'x', perDayTokens: null, warnAt: 2 })
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.problems).toEqual(['perAgentUsd must be null or a non-negative number', 'perDayUsd must be null or a non-negative number', 'warnAt must be in (0, 1]'])
  })
})
