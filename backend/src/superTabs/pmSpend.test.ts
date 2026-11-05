import { describe, expect, it } from 'vitest'
import { addSpend, pmDailyShare, SPEND_DAYS, weeklyResetAt } from './pmSpend.js'
import type { ContributedMachine } from './machines.js'

const DAY = 86_400_000
const DAY0 = Date.parse('2026-11-01T00:00:00Z')
const HOUR = 3_600_000
const RESET = '2026-11-08T03:00:00Z'
type Tokens = Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }>
const opus = (input: number, output = 0, cacheRead = 0): Tokens => ({ 'claude-opus-5-5': { input, output, cacheRead, cacheWrite: 0 } })
/** Opus at list prices: $4 a million input, $20 output, $0.20 cache reads. */
const opusCost = (input: number, output = 0, cacheRead = 0) => (input * 4 + output * 20 + cacheRead * 0.2) / 1e6

const pool = (machineId = 'mac', extra: Partial<ContributedMachine> = {}) => ({ machineId, ...extra }) as unknown as ContributedMachine
const reading = (weekly: number, tokens: Record<string, Tokens>, resetsAt: string | number | null = RESET, engine = 'claude') => ({
  quotas: [{ engine, known: true, windows: [{ name: '5-hour', usedPercent: 50, resetsAt: null }, { name: 'weekly', usedPercent: weekly, resetsAt }] }],
  harnessTokens: tokens,
}) as never
const near = (a: number, b: number) => expect(Math.abs(a - b)).toBeLessThan(1e-9)

describe('the daily spend ledger a machine\'s readings keep (#3222)', () => {
  it('adds up what the account\'s week and each session spent between readings, by day and engine', () => {
    const p = pool()
    addSpend(p, reading(40, { pm: opus(1_000_000), worker: opus(0) }), DAY0 + HOUR)
    addSpend(p, reading(43, { pm: opus(2_000_000), worker: opus(1_000_000, 100_000) }), DAY0 + 2 * HOUR)
    addSpend(p, reading(46, { pm: opus(3_000_000), worker: opus(1_000_000, 100_000) }), DAY0 + 20 * HOUR)
    const [day] = p.spendDays!
    expect(p.spendDays).toHaveLength(1)
    expect(day).toMatchObject({ day: DAY0, engine: 'claude', weekly: { seen: 46, used: 6 }, resetsAt: Date.parse(RESET) })
    near(day!.sessions.pm!.spent, opusCost(2_000_000))
    near(day!.sessions.worker!.spent, opusCost(1_000_000, 100_000))
  })

  it('goes on from the day before at midnight, so nothing spent across it is lost', () => {
    const p = pool()
    addSpend(p, reading(50, { pm: opus(1_000_000) }), DAY0 + 23 * HOUR)
    addSpend(p, reading(52, { pm: opus(1_500_000) }), DAY0 + DAY + HOUR)
    expect(p.spendDays!.at(-1)!.weekly.used).toBe(2)
    near(p.spendDays!.at(-1)!.sessions.pm!.spent, opusCost(500_000))
  })

  it('counts a weekly reset and a restarted session from zero, never as a negative spend', () => {
    const p = pool()
    addSpend(p, reading(95, { pm: opus(5_000_000) }), DAY0 + HOUR)
    addSpend(p, reading(2, { pm: opus(1_000_000) }, '2026-11-15T03:00:00Z'), DAY0 + 5 * HOUR)
    expect(p.spendDays![0]!.weekly.used).toBe(2)
    near(p.spendDays![0]!.sessions.pm!.spent, opusCost(1_000_000))
    expect(weeklyResetAt(p, 'claude')).toBe(Date.parse('2026-11-15T03:00:00Z'))
  })

  it('files a session under the engine its models run on, and leaves grid and unpriced models out', () => {
    const p = pool()
    const tokens = (model: string): Tokens => ({ [model]: { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 } })
    const both = (n: number) => ({ quotas: [
      { engine: 'claude', known: true, windows: [{ name: 'weekly', usedPercent: n, resetsAt: RESET }] },
      { engine: 'codex', known: true, windows: [{ name: 'weekly', usedPercent: n, resetsAt: RESET }] }],
    harnessTokens: { c: opus(n * 1_000_000), x: tokens('gpt-6-astra'), g: tokens('moonshotai/kimi-k3'), u: tokens('some-new-model') } }) as never
    addSpend(p, both(1), DAY0)
    addSpend(p, both(2), DAY0 + HOUR)
    expect(p.spendDays!.map(d => [d.engine, Object.keys(d.sessions).sort()])).toEqual([['claude', ['c']], ['codex', ['x']]])
  })

  it('keeps no more than SPEND_DAYS days', () => {
    const p = pool()
    for (let d = 0; d <= SPEND_DAYS + 3; d++) addSpend(p, reading(10 + d, {}), DAY0 + d * DAY)
    expect(p.spendDays!.length).toBe(SPEND_DAYS)
    expect(p.spendDays!.at(-1)!.day).toBe(DAY0 + (SPEND_DAYS + 3) * DAY)
  })

  it('reads a reset given in seconds, in milliseconds or as a date, and none', () => {
    for (const resetsAt of [Date.parse(RESET) / 1000, Date.parse(RESET), RESET]) {
      const p = pool()
      addSpend(p, reading(10, {}, resetsAt), DAY0)
      expect(weeklyResetAt(p, 'claude')).toBe(Date.parse(RESET))
    }
    const none = pool()
    addSpend(none, reading(10, {}, null), DAY0)
    expect(weeklyResetAt(none, 'claude')).toBeNull()
  })
})

describe('a PM\'s daily share of its account\'s week (#3222)', () => {
  /** Day d: the account used `used` points of its week; the PM spent `pm` dollars and others `others`. */
  const day = (d: number, used: number, pm: number, others: number) => ({ day: DAY0 + d * DAY, engine: 'claude', weekly: { seen: 50, used },
    resetsAt: Date.parse(RESET), sessions: { pm: { seen: 0, spent: pm }, w: { seen: 0, spent: others } } })

  it('is each day\'s used share split by the PM\'s part of the day\'s price-weighted cost, averaged over complete days', () => {
    const p = pool('mac', { spendDays: [day(0, 10, 1, 1), day(1, 12, 3, 1), day(2, 6, 1, 2), day(3, 99, 1, 0)] as never })
    // Day 3 is today: not complete, not counted. Days 0-2: 10 × 1/2 = 5, 12 × 3/4 = 9, 6 × 1/3 = 2.
    expect(pmDailyShare([p], 'claude', 'pm', DAY0 + 3 * DAY + HOUR)).toEqual({ share: (5 + 9 + 2) / 3, days: 3 })
  })

  it('counts the Mac and its Harness Team account together: one subscription', () => {
    const mac = pool('mac', { spendDays: [0, 1, 2].map(d => day(d, 10, 1, 0)) as never })
    const team = pool('mac-team', { hostMachineId: 'mac', spendDays: [0, 1, 2].map(d => ({ day: DAY0 + d * DAY, engine: 'claude',
      weekly: { seen: 50, used: 10 }, resetsAt: Date.parse(RESET), sessions: { t: { seen: 0, spent: 3 } } })) as never })
    // Each day: 10 points, the PM 1 of the Mac's and the Team account's 4 dollars.
    expect(pmDailyShare([mac, team], 'claude', 'pm', DAY0 + 3 * DAY)).toEqual({ share: 2.5, days: 3 })
  })

  it('is unknown with fewer than 3 measured days: a day nobody spent on, or one the PM did not run, measures nothing', () => {
    const idle = { ...day(1, 0, 0, 0), sessions: {} }
    const p = pool('mac', { spendDays: [day(0, 10, 1, 1), idle, day(2, 10, 1, 1)] as never })
    expect(pmDailyShare([p], 'claude', 'pm', DAY0 + 3 * DAY)).toBeNull()
    expect(pmDailyShare([p], 'claude', 'someone-else', DAY0 + 3 * DAY)).toBeNull()
  })

  it('looks back 7 complete days at most', () => {
    const p = pool('mac', { spendDays: [day(0, 70, 1, 0), ...[1, 2, 3, 4, 5, 6, 7].map(d => day(d, 7, 1, 0))] as never })
    expect(pmDailyShare([p], 'claude', 'pm', DAY0 + 8 * DAY)).toEqual({ share: 7, days: 7 })
  })
})
