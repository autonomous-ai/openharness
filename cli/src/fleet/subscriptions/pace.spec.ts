// Originally written by Fred Nix (@nixfred) in github.com/nixfred/openharness (MIT).

/**
 * The pace and banked arithmetic, mirroring Burn Bar's own suites
 * (github.com/nixfred/burnbar tests/test_pace_math.py and tests/test_guidance.cjs) case for case,
 * so the port answers every question the original answers, with the same numbers.
 */
import { describe, expect, it } from 'vitest'
import {
  burndownSeries, clockSpan, guidePick, paceFor, paceLive, recentRatePerHour, SERIES_MAX_POINTS,
  spanWords, windowId, windowMsFor, type Sample,
} from './pace.js'

const HOUR = 3_600_000
const DAY = 86_400_000
const WEEK = 7 * DAY
const MONTH = 30 * DAY
const NOW = 1_789_900_000_000 // 2026-09-20 UTC
const iso = (ms: number): string => new Date(ms).toISOString()
const utc = (y: number, m: number, d: number): number => Date.UTC(y, m - 1, d)

describe('window length (burnbar WindowLengthTests)', () => {
  it('reads the length off the label when the provider states it', () => {
    expect(windowMsFor('Session (5-hour)', NOW, 0)).toBe(5 * HOUR)
    expect(windowMsFor('Weekly (7-day)', NOW, 0)).toBe(7 * DAY)
  })
  it('a month is the calendar month before the reset, not thirty days', () => {
    expect(windowMsFor('Monthly (total)', utc(2027, 3, 1), 0)).toBe(28 * DAY)
    expect(windowMsFor('Monthly (total)', utc(2028, 3, 1), 0)).toBe(29 * DAY)
  })
  it('an unlabelled window is measured from the previous reset', () => {
    expect(windowMsFor('Quota', NOW + DAY, NOW - 2 * DAY)).toBe(3 * DAY)
  })
  it('an unlabelled window with no history is unknown, not a guess', () => {
    expect(windowMsFor('Quota', NOW + DAY, 0)).toBe(0)
  })
})

describe('rate (burnbar RateTests)', () => {
  const rate = (pts: Array<[number, number]>) => recentRatePerHour(pts.map(([t, p]) => [t, p, 1] as Sample))
  it('a straight line is its slope per hour', () => {
    expect(rate([[NOW - 2 * HOUR, 0.1], [NOW - HOUR, 0.2], [NOW, 0.3]])).toBeCloseTo(0.1, 6)
  })
  it('one sample cannot be a rate', () => { expect(rate([[NOW, 0.4]])).toBeNull() })
  it('two ticks seconds apart cannot be a rate', () => { expect(rate([[NOW - 5000, 0.4], [NOW, 0.41]])).toBeNull() })
  it('a percentage that went down is a reset, not a negative burn', () => {
    expect(rate([[NOW - 2 * HOUR, 0.9], [NOW, 0.05]])).toBeNull()
  })
  it('samples older than the rate window are not part of the rate', () => {
    expect(rate([[NOW - 20 * HOUR, 0], [NOW - HOUR, 0.5], [NOW, 0.6]])).toBeCloseTo(0.1, 6)
  })
})

describe('window id (burnbar WindowIdTests)', () => {
  it('the same window stated with jitter is one window', () => {
    const base = NOW + 6 * DAY
    expect(new Set([0, 53, 407, 828, 950].map((ms) => windowId(base + ms))).size).toBe(1)
  })
  it('windows a minute apart stay different', () => {
    expect(windowId(NOW + 6 * DAY)).not.toBe(windowId(NOW + 6 * DAY + 60_000))
  })
})

describe('burndown series (burnbar BurndownSeriesTests)', () => {
  it('is normalised and ends on the present', () => {
    const resets = windowId(NOW + 3 * DAY)
    const start = resets - WEEK
    const s = burndownSeries([[start + DAY, 0.1, resets], [start + 2 * DAY, 0.25, resets]], resets, WEEK, 0.4, NOW)
    expect(s).toHaveLength(3)
    expect(s[0]![0]).toBeCloseTo(1 / 7, 3)
    expect(s[0]![1]).toBeCloseTo(0.1, 5)
    expect(s[2]![0]).toBeCloseTo((NOW - start) / WEEK, 3)
    expect(s[2]![1]).toBeCloseTo(0.4, 5)
    for (const [x, y] of s) { expect(x).toBeGreaterThanOrEqual(0); expect(x).toBeLessThanOrEqual(1); expect(y).toBeLessThanOrEqual(1) }
  })
  it('never lets another window leak into this line', () => {
    const resets = windowId(NOW + 3 * DAY)
    const s = burndownSeries([[NOW - DAY, 0.9, resets - WEEK], [NOW - HOUR, 0.2, resets]], resets, WEEK, 0.22, NOW)
    expect(s.map((p) => Math.round(p[1] * 100) / 100)).toEqual([0.2, 0.22])
  })
  it('thins a long window rather than shipping it whole', () => {
    const resets = windowId(NOW + DAY)
    const start = resets - WEEK
    const pts: Sample[] = Array.from({ length: 1499 }, (_, i) => [start + (i + 1) * 300_000, (i + 1) / 2000, resets])
    const s = burndownSeries(pts, resets, WEEK, 0.76, NOW)
    expect(s.length).toBeLessThanOrEqual(SERIES_MAX_POINTS)
    expect(s[s.length - 1]![1]).toBeCloseTo(0.76, 5)
  })
  it('no samples is still a point the card can draw', () => {
    const s = burndownSeries([], windowId(NOW + 3 * DAY), WEEK, 0.05, NOW)
    expect(s).toHaveLength(1)
    expect(s[0]![1]).toBeCloseTo(0.05, 5)
  })
})

describe('pace (burnbar PaceTests and ReviewFixTests)', () => {
  const row = (pct: number, resets: number, label = 'Weekly (7-day)') => ({ label, percent: pct, resetsAt: iso(resets) })
  it('on pace is one', () => {
    const p = paceFor(row(0.5, NOW + 3.5 * DAY), [], true, NOW)
    expect(p.ratio).toBeCloseTo(1, 3)
    expect(p.elapsed).toBeCloseTo(0.5, 3)
  })
  it('a blown window has no allowance and recovers only at the reset', () => {
    const resets = windowId(NOW + 6 * DAY)
    const p = paceFor(row(1, resets), [], true, NOW)
    expect(p.ratio).toBeGreaterThan(1)
    expect(p.allowancePerHour).toBe(0)
    expect(p.backOnPaceAt).toBe(resets)
  })
  it('half spent early comes back on pace midway through the window', () => {
    const resets = windowId(NOW + 6 * DAY)
    expect(paceFor(row(0.5, resets), [], true, NOW).backOnPaceAt).toBe(resets - 3.5 * DAY)
  })
  it('the first moments of a window hold the ratio rather than divide by zero', () => {
    const p = paceFor(row(0.01, NOW + 7 * DAY - 60_000), [], true, NOW)
    expect(p.ratio).toBe(-1)
    expect(p.elapsed).toBeGreaterThanOrEqual(0)
  })
  it('a window already past its reset carries no pace', () => {
    const p = paceFor(row(0.4, NOW - HOUR), [], true, NOW)
    expect(p.windowMs).toBe(0)
    expect(p.ratio).toBe(-1)
  })
  it('a missing percentage carries no pace', () => {
    const p = paceFor(row(-1, NOW + DAY), [], true, NOW)
    expect(p.ratio).toBe(-1)
    expect(p.allowancePerHour).toBe(-1)
  })
  it('a snapshot row gets a ratio but never a rate', () => {
    const p = paceFor(row(0.3, NOW + 3.5 * DAY), [[NOW - 2 * HOUR, 0.1, 1], [NOW, 0.3, 1]], false, NOW)
    expect(p.ratio).toBeGreaterThan(0)
    expect(p.ratePerHour).toBe(-1)
    expect(p.projected).toBe(-1)
  })
  it('at this rate projects past the reset and names the dry moment', () => {
    const resets = windowId(NOW + 10 * HOUR)
    const pts: Sample[] = [[NOW - 2 * HOUR, 0.2, resets], [NOW - HOUR, 0.3, resets], [NOW, 0.4, resets]]
    const p = paceFor(row(0.4, resets), pts, true, NOW)
    expect(p.ratePerHour).toBeCloseTo(0.1, 6)
    expect(p.projected).toBeCloseTo(1.4, 2)
    expect((p.dryAt - NOW) / HOUR).toBeCloseTo(6, 3)
  })
  it('a rate that still lands inside the window names no dry moment', () => {
    const resets = windowId(NOW + 10 * HOUR)
    const p = paceFor(row(0.12, resets), [[NOW - 2 * HOUR, 0.1, resets], [NOW, 0.12, resets]], true, NOW)
    expect(p.projected).toBeLessThan(1)
    expect(p.dryAt).toBe(0)
  })
  it('an on-pace sub is not told to stop in a day', () => {
    const resets = windowId(NOW + 3.5 * DAY)
    const even = 1 / 7 / 24
    const p = paceFor(row(0.5, resets), [[NOW - 2 * HOUR, 0.5 - 2 * even, resets], [NOW, 0.5, resets]], true, NOW)
    expect(p.stopInMs).toBe(-1)
  })
  it('a fast burn still gets its stop time', () => {
    const resets = windowId(NOW + 3.5 * DAY)
    const p = paceFor(row(0.3, resets), [[NOW - 2 * HOUR, 0.2, resets], [NOW, 0.3, resets]], true, NOW)
    expect(p.stopInMs).toBeGreaterThan(0)
    expect(p.stopInMs).toBeLessThan(24 * HOUR)
  })
  it('a five-hour window has no daily ceiling', () => {
    expect(paceFor(row(0.5, NOW + HOUR, 'Session (5-hour)'), [], true, NOW).todayCeiling).toBe(-1)
  })
})

const NOW2 = 1_800_000_000_000
const win = (used: number, gone: number, span = WEEK) => paceLive(used, NOW2 + span * (1 - gone), span, NOW2)

describe('banked and come-back (burnbar test_guidance.cjs)', () => {
  it('ahead: banked is elapsed minus used, in plan share and in time', () => {
    const w = win(0.02, 0.51)!
    expect(w.banked).toBeCloseTo(0.49, 9)
    expect(w.bankedSigned).toBeCloseTo(0.49, 9)
    expect(w.bankedMs).toBeCloseTo(0.49 * WEEK, 0)
    expect(w.behind).toBe(0)
    expect(w.comeBackAt).toBe(0)
    expect(w.room).toBeCloseTo(0.98 / 0.49, 9)
  })
  it('behind: no banked figure, a negative signed bank, and a moment to come back', () => {
    const w = win(0.09, 0.05)!
    expect(w.banked).toBe(0)
    expect(w.bankedSigned).toBeCloseTo(-0.04, 9)
    expect(w.behind).toBeCloseTo(0.04, 9)
    expect(w.comeBackMs).toBeCloseTo(0.04 * WEEK, 0)
    expect(w.comeBackAt).toBeGreaterThan(NOW2)
    expect(w.comeBackAt).toBeLessThan(w.resetsMs)
  })
  it('time off brings a sub back, and the promised come-back moment is when it flips', () => {
    const reset = NOW2 + 5 * DAY
    const before = paceLive(0.3, reset, WEEK, NOW2)!
    const later = paceLive(0.3, reset, WEEK, NOW2 + 2 * DAY)!
    expect(before.behind).toBeGreaterThan(0)
    expect(later.banked).toBeGreaterThan(0.25)
    expect(paceLive(0.3, reset, WEEK, before.comeBackAt + 1000)!.behind).toBe(0)
  })
  it('spent out comes back at the reset, never before', () => {
    const w = win(1, 0.13)!
    expect(w.spent).toBe(true)
    expect(w.comeBackAt).toBe(w.resetsMs)
    expect(w.room).toBe(0)
  })
  it('spent while ahead of the clock still comes back at the reset', () => {
    const w = win(0.996, 0.999)!
    expect(w.spent).toBe(true)
    expect(w.banked).toBe(0)
    expect(w.comeBackAt).toBe(w.resetsMs)
    expect(win(0.997, 0.997)!.comeBackAt).toBe(win(0.997, 0.997)!.resetsMs)
  })
  it('inside 5% of an even spend is on pace, not over', () => {
    expect(win(0.5, 0.48)!.over).toBe(false)
    expect(win(0.09, 0.05)!.over).toBe(true)
    expect(win(0.004, 0.001)!.over).toBe(false)
  })
  it('claims nothing about a window that cannot be read', () => {
    for (const [p, r, s] of [[-1, NOW2 + DAY, WEEK], [NaN, NOW2 + DAY, WEEK], [0.5, 0, WEEK], [0.5, NOW2 + DAY, 0], [0.5, NOW2 - 1, WEEK]])
      expect(paceLive(p!, r!, s!, NOW2)).toBeNull()
  })
})

const row = (id: string, used: number, gone: number, opts: { span?: number; fresh?: boolean; blocked?: boolean; minBank?: number } = {}) =>
  ({ id, live: win(used, gone, opts.span ?? WEEK), fresh: opts.fresh ?? true, blocked: opts.blocked ?? false, minBank: opts.minBank })

describe('which sub next (burnbar guidePick)', () => {
  it('one subscription is never suggested', () => {
    const g = guidePick([row('kimi', 0.05, 0.6, { span: MONTH })], '')
    expect(g.count).toBe(1)
    expect(g.pick).toBe('')
  })
  it('with two, the one with room is the right one', () => {
    const g = guidePick([row('claude', 0.09, 0.05), row('grok', 0.02, 0.51)], '')
    expect(g.pick).toBe('grok')
    expect(g.rest.map((r) => r.id)).toEqual(['claude'])
  })
  it('with four, a week and a month are ranked on the same scale', () => {
    const g = guidePick([row('claude', 0.09, 0.05), row('codex', 1, 0.13), row('grok', 0.02, 0.51), row('kimi', 0.05, 0.16, { span: MONTH })], '')
    expect(g.pick).toBe('grok')
    expect(g.next).toBe('kimi')
    expect(g.ahead).toBe(2)
    expect(g.rest.map((r) => r.id)).toEqual(['claude', 'codex'])
  })
  it('use it or lose it: a close reset with budget unspent wins, and says so', () => {
    const g = guidePick([row('grok', 0.02, 0.51), row('codex', 0.6, 0.95)], '')
    expect(g.pick).toBe('codex')
    expect(g.urgent).toBe(true)
  })
  it('urgent is about the calendar', () => {
    const fourDays = 1 - (4 * DAY) / MONTH
    const g = guidePick([row('kimi', 0.3, fourDays, { span: MONTH }), row('claude', 0.9, 0.5)], '')
    expect(g.pick).toBe('kimi')
    expect(g.urgent).toBe(false)
    const twoDays = 1 - (2 * DAY) / MONTH
    expect(guidePick([row('kimi', 0.3, twoDays, { span: MONTH }), row('claude', 0.9, 0.5)], '').urgent).toBe(true)
    expect(guidePick([row('grok', 0.93, 0.97), row('claude', 0.9, 0.5)], '').urgent).toBe(false)
  })
  it('a snapshot has to be further ahead before it is suggested', () => {
    const snap = (bank: number, min: number) => row('grok', 0.5 - bank, 0.5, { minBank: min })
    expect(guidePick([snap(0.06, 0.1), row('claude', 0.9, 0.5)], '').pick).toBe('')
    expect(guidePick([snap(0.12, 0.1), row('claude', 0.9, 0.5)], '').pick).toBe('grok')
  })
  it('the sub being suggested keeps the job down to half the threshold', () => {
    const thin = row('kimi', 0.485, 0.5, { span: MONTH })
    expect(guidePick([thin, row('claude', 0.9, 0.5)], '').pick).toBe('')
    expect(guidePick([thin, row('claude', 0.9, 0.5)], 'kimi').pick).toBe('kimi')
  })
  it('is never a sub that is stale, blocked, spent or unreadable', () => {
    expect(guidePick([row('claude', 0.5, 0.5), row('grok', 0.02, 0.6, { fresh: false })], '').pick).toBe('')
    expect(guidePick([row('claude', 0.1, 0.6, { blocked: true }), row('codex', 0.7, 0.5)], '').pick).toBe('')
    expect(guidePick([{ id: 'claude', live: null, fresh: true, blocked: false }, row('kimi', 0.05, 0.4, { span: MONTH })], '').pick).toBe('kimi')
  })
  it('everyone behind: no suggestion, and the first one back is named', () => {
    const g = guidePick([row('claude', 0.3, 0.1), row('codex', 0.2, 0.15)], '')
    expect(g.pick).toBe('')
    expect(g.rest[0]!.id).toBe('codex')
  })
  it('a hair of banked budget is not advice', () => {
    expect(guidePick([row('claude', 0.49, 0.5), row('codex', 0.3, 0.31)], '').pick).toBe('')
  })
  it('does not flap between two near-equal subs', () => {
    const a = row('grok', 0.2, 0.6)
    const b = row('kimi', 0.19, 0.6, { span: MONTH })
    expect(guidePick([a, b], '').pick).toBe('kimi')
    expect(guidePick([a, b], 'grok').pick).toBe('grok')
    expect(guidePick([a, row('kimi', 0.02, 0.6, { span: MONTH })], 'grok').pick).toBe('kimi')
  })
})

describe('spans', () => {
  it('clocks run, spans read like advice', () => {
    expect(clockSpan(3 * DAY + 9 * HOUR + 12 * 60e3 + 45e3)).toBe('3d 09:12:45')
    expect(clockSpan(7 * HOUR + 13 * 60e3 + 22e3)).toBe('7:13:22')
    expect(clockSpan(-5)).toBe('0:00')
    expect(spanWords(3 * DAY + 10 * HOUR + 22 * 60e3)).toBe('3d 10h')
    expect(spanWords(6 * HOUR + 40 * 60e3)).toBe('6h 40m')
    expect(spanWords(2 * DAY)).toBe('2d')
    expect(spanWords(20e3)).toBe('under a minute')
  })
})
