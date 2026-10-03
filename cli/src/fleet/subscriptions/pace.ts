// Originally written by Fred Nix (@nixfred) in github.com/nixfred/openharness (MIT).

/**
 * Budget pace for a subscription window: am I over, how much have I banked, when can I come back,
 * and which subscription should I reach for next.
 *
 * Ported from Burn Bar (https://github.com/nixfred/burnbar, MIT): `bin/burnbar-collect` (pace_for,
 * window_ms_for, recent_rate_per_hour, burndown_series, window_id) and `BarWidget.qml` (paceLive,
 * guidePick, spanWords, clockSpan). The arithmetic is kept identical so the two agree to the number;
 * Burn Bar itself is not required, called or read.
 *
 * On budget means EVEN PACE across the window: a tenth of the way in, a tenth of the plan is a fair
 * spend. With used fraction p, window length L and time left r:
 *
 *   elapsed        e = (L - r) / L
 *   pace ratio     R = p / e                  1.0 is exactly on pace, above it is over
 *   banked         e - p (signed)             positive = unspent share an even pace allowed by now,
 *                                             negative = how far ahead of the clock the spend is
 *   allowance      (1 - p) / r                what may still burn per hour and make it to the reset
 *   forecast       p + rate * r               above 1.0 the window runs dry early
 *   come back at   reset - L * (1 - p)        the moment the even-pace line catches up, if you stop now
 *   room           (1 - p) / (1 - e)          same scale for a week and a month; ranks the next sub
 *
 * Unknowns are -1 (a figure that cannot be measured) or 0 (a moment that does not apply), never an
 * invented number. Every percentage is the provider's own.
 */

export const HOUR_MS = 3_600_000
export const DAY_MS = 86_400_000
export const RATE_WINDOW_MS = 120 * 60_000
export const RATE_MIN_SPAN_MS = 10 * 60_000
export const DAILY_MIN_WINDOW_MS = 36 * HOUR_MS
export const SERIES_MAX_POINTS = 48

/** [timestampMs, usedFraction, windowId] */
export type Sample = [number, number, number]

export interface LimitRow {
  label: string
  /** 0..1, or -1 when unknown. */
  percent: number
  /** ISO time, or '' when unknown. */
  resetsAt: string
  /** Start of the window when the provider states it (Grok does). */
  startsAt?: string
}

export interface Pace {
  windowMs: number
  resetsMs: number
  elapsed: number
  ratio: number
  allowancePerHour: number
  ratePerHour: number
  projected: number
  dryAt: number
  backOnPaceAt: number
  todayCeiling: number
  stopInMs: number
  stopAtMs: number
  series: Array<[number, number]>
}

export function parseIsoMs(raw: unknown): number {
  const s = String(raw ?? '').trim()
  if (!s) return 0
  const ms = Date.parse(s)
  return Number.isFinite(ms) ? ms : 0
}

/** 0..1 or -1. A boolean is never a percentage. */
export function normPercent(value: unknown): number {
  if (typeof value === 'boolean' || value === null || value === undefined || value === '') return -1
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0 || n > 1) return -1
  return n
}

/** Which window instance this is, to the minute: providers restate the same reset with ms jitter. */
export function windowId(resetsMs: number): number {
  return Math.floor(resetsMs / 60_000) * 60_000
}

/** How long a window is: from the label when stated, else the distance from the previous reset. */
export function windowMsFor(label: string, resetsMs: number, prevResetsMs: number): number {
  const text = String(label || '').toLowerCase()
  const m = /(\d+)\s*-\s*(hour|day)/.exec(text)
  if (m) return Number(m[1]) * (m[2] === 'hour' ? HOUR_MS : DAY_MS)
  if (text.includes('week')) return 7 * DAY_MS
  if (text.includes('month')) {
    if (resetsMs) {
      // Step back one calendar month from the reset so a February window is February long.
      const end = new Date(resetsMs)
      let y = end.getUTCFullYear()
      let mo = end.getUTCMonth() - 1
      if (mo < 0) { mo = 11; y -= 1 }
      const daysIn = new Date(Date.UTC(y, mo + 1, 0)).getUTCDate()
      const day = Math.min(end.getUTCDate(), daysIn)
      const start = Date.UTC(y, mo, day, end.getUTCHours(), end.getUTCMinutes(), end.getUTCSeconds(), end.getUTCMilliseconds())
      return Math.max(DAY_MS, resetsMs - start)
    }
    return 30 * DAY_MS
  }
  if (text.includes('session')) return 5 * HOUR_MS
  if (text.includes('daily') || text.includes('day')) return DAY_MS
  if (prevResetsMs && resetsMs > prevResetsMs) return resetsMs - prevResetsMs
  return 0
}

/** Least-squares slope over the last two hours, as fraction per hour; null when it cannot carry one. */
export function recentRatePerHour(points: Sample[]): number | null {
  if (points.length < 2) return null
  const floor = points[points.length - 1]![0] - RATE_WINDOW_MS
  const pts = points.filter(([t]) => t >= floor).map(([t, p]) => [t, p] as const)
  if (pts.length < 2 || pts[pts.length - 1]![0] - pts[0]![0] < RATE_MIN_SPAN_MS) return null
  for (let i = 1; i < pts.length; i++) if (pts[i]![1] < pts[i - 1]![1] - 1e-9) return null
  const n = pts.length
  const mt = pts.reduce((a, [t]) => a + t, 0) / n
  const mp = pts.reduce((a, [, p]) => a + p, 0) / n
  const denom = pts.reduce((a, [t]) => a + (t - mt) ** 2, 0)
  if (denom <= 0) return null
  const slope = pts.reduce((a, [t, p]) => a + (t - mt) * (p - mp), 0) / denom
  return Math.max(0, slope * HOUR_MS)
}

const r5 = (n: number): number => Math.round(n * 1e5) / 1e5

/** This window's samples as [x, y] in 0..1, thinned, always ending on the present. */
export function burndownSeries(points: Sample[], resets: number, window: number, pctNow: number, now: number): Array<[number, number]> {
  const start = resets - window
  let mine = points.filter(([t, , r]) => r === resets && t >= start && t <= now)
  if (mine.length > SERIES_MAX_POINTS - 1) {
    const step = mine.length / (SERIES_MAX_POINTS - 1)
    mine = Array.from({ length: SERIES_MAX_POINTS - 1 }, (_, i) => mine[Math.floor(i * step)]!)
  }
  const out: Array<[number, number]> = mine.map(([t, p]) => [r5((t - start) / window), r5(p)])
  out.push([r5(Math.min(1, Math.max(0, (now - start) / window))), r5(pctNow)])
  return out
}

/** The collector-side pace block for one limit row (Burn Bar's pace_for). */
export function paceFor(row: LimitRow, points: Sample[], live: boolean, now: number): Pace {
  const out: Pace = {
    windowMs: 0, resetsMs: 0, elapsed: -1, ratio: -1, allowancePerHour: -1, ratePerHour: -1, projected: -1,
    dryAt: 0, backOnPaceAt: 0, todayCeiling: -1, stopInMs: -1, stopAtMs: 0, series: [],
  }
  const pct = row.percent
  const resets = windowId(parseIsoMs(row.resetsAt))
  if (typeof pct !== 'number' || !(pct >= 0) || !resets) return out
  let prev = 0
  for (const [, , r] of points) if (r && r < resets) prev = Math.max(prev, r)
  const starts = parseIsoMs(row.startsAt)
  let window = starts && starts < resets ? resets - starts : windowMsFor(row.label, resets, prev)
  const leftMs = resets - now
  if (window <= 0 || leftMs <= 0) return out
  window = Math.max(window, 1)
  out.windowMs = window
  out.resetsMs = resets
  out.series = burndownSeries(points, resets, window, pct, now)
  const elapsed = Math.min(1, Math.max(0, (window - leftMs) / window))
  out.elapsed = elapsed
  const hoursLeft = leftMs / HOUR_MS
  out.allowancePerHour = Math.max(0, (1 - pct) / hoursLeft)
  // Hold the ratio until the window is one percent old: any spend divides by ~0 before that.
  if (elapsed >= 0.01) out.ratio = pct / elapsed
  const rate = live ? recentRatePerHour(points.filter((p) => p[2] === resets)) : null
  if (rate !== null) {
    out.ratePerHour = rate
    out.projected = pct + rate * hoursLeft
    if (rate > 0 && out.projected > 1) out.dryAt = Math.trunc(now + ((1 - pct) / rate) * HOUR_MS)
  }
  if (out.ratio > 1) out.backOnPaceAt = Math.trunc(resets - window * (1 - pct))
  if (window >= DAILY_MIN_WINDOW_MS && hoursLeft > 0) {
    const ceiling = Math.max(0, (1 - pct) * Math.min(1, 24 / hoursLeft))
    out.todayCeiling = ceiling
    // Only a stop that lands inside the day (and the window) is advice; an on-pace sub lasts ~24h.
    if (rate !== null && rate > 0.0005) {
      const hours = ceiling / rate
      if (hours < 24 && hours * HOUR_MS < leftMs) {
        out.stopInMs = Math.trunc(hours * HOUR_MS)
        out.stopAtMs = Math.trunc(now + hours * HOUR_MS)
      }
    }
  }
  return out
}

export interface LivePace {
  used: number
  elapsed: number
  leftMs: number
  windowMs: number
  resetsMs: number
  /** Share of the plan an even pace would have used by now and did not; 0 when not ahead. */
  banked: number
  /** elapsed - used: positive when banked, negative when over pace. */
  bankedSigned: number
  bankedMs: number
  behind: number
  over: boolean
  comeBackAt: number
  comeBackMs: number
  room: number
  spent: boolean
}

/** Where one window stands right now (Burn Bar's paceLive). Null when the window cannot be read. */
export function paceLive(percent: number, resetsMs: number, windowMs: number, nowMs: number): LivePace | null {
  const p0 = Number(percent), reset = Number(resetsMs), span = Number(windowMs), now = Number(nowMs)
  if (!(p0 >= 0) || !(reset > 0) || !(span > 0) || !(now > 0) || now >= reset) return null
  const p = Math.min(1, p0)
  const left = reset - now
  const e = Math.max(0, Math.min(1, 1 - left / span))
  const out: LivePace = {
    used: p, elapsed: e, leftMs: left, windowMs: span, resetsMs: reset, banked: 0, bankedSigned: e - p, bankedMs: 0,
    behind: 0, over: false, comeBackAt: 0, comeBackMs: 0, room: 0, spent: p >= 0.995,
  }
  if (out.spent) {
    // Decided first: a plan can be spent while still ahead of the clock; it only comes back at the reset.
    out.behind = Math.max(0, p - e)
    out.over = true
    out.comeBackAt = reset
    out.comeBackMs = left
  } else if (e > p) {
    out.banked = e - p
    out.bankedMs = out.banked * span
  } else if (p > e) {
    out.behind = p - e
    // Over means more than 5% past an even spend and by at least a whole percent of the plan.
    out.over = out.behind > 0.01 && (e <= 0 || p / e > 1.05)
    out.comeBackAt = Math.min(reset, reset - span * (1 - p))
    out.comeBackMs = Math.max(0, out.comeBackAt - now)
  }
  out.room = e < 1 ? (1 - p) / (1 - e) : 0
  return out
}

export interface GuideRow { id: string; live: LivePace | null; fresh: boolean; blocked: boolean; minBank?: number }
export interface Guide {
  count: number
  pick: string
  next: string
  urgent: boolean
  room: number
  ahead: number
  rest: Array<{ id: string; comeBackAt: number; spent: boolean; behind: number }>
}

/**
 * Which subscription to reach for next (Burn Bar's guidePick). Only a sub that is ahead is ever
 * suggested; the most room wins, which becomes earliest-deadline-first as a reset nears with budget
 * unspent. One sub alone is never suggested. The previous pick sticks until another is clearly better.
 */
export function guidePick(rows: GuideRow[], previousId: string): Guide {
  const MIN_BANK = 0.02, STICK = 1.15
  const LOSE_IT_MS = 72 * HOUR_MS, LOSE_IT_SHARE = 0.15, LOSE_IT_LEFT = 0.1
  const out: Guide = { count: 0, pick: '', next: '', urgent: false, room: 0, rest: [], ahead: 0 }
  const ok: GuideRow[] = []
  for (const r of rows) {
    if (!r || !r.id) continue
    out.count++
    if (!r.live || !r.fresh) continue
    if (r.live.over || r.live.spent) out.rest.push({ id: r.id, comeBackAt: r.live.comeBackAt, spent: r.live.spent, behind: r.live.behind })
    let need = r.minBank && r.minBank > 0 ? r.minBank : MIN_BANK
    if (r.id === previousId) need *= 0.5
    if (r.live.spent || r.blocked || !(r.live.banked >= need)) continue
    ok.push(r)
  }
  out.ahead = ok.length
  out.rest.sort((a, b) => a.comeBackAt - b.comeBackAt)
  if (out.count < 2 || ok.length === 0) return out
  ok.sort((a, b) => {
    if (b.live!.room !== a.live!.room) return b.live!.room - a.live!.room
    if (b.live!.banked !== a.live!.banked) return b.live!.banked - a.live!.banked
    return a.live!.leftMs - b.live!.leftMs
  })
  if (previousId && previousId !== ok[0]!.id) {
    const i = ok.findIndex((r, idx) => idx > 0 && r.id === previousId)
    if (i > 0 && ok[0]!.live!.room < ok[i]!.live!.room * STICK) ok.unshift(ok.splice(i, 1)[0]!)
  }
  const top = ok[0]!.live!
  out.pick = ok[0]!.id
  out.room = top.room
  out.urgent = top.leftMs <= Math.min(LOSE_IT_MS, top.windowMs * LOSE_IT_SHARE) && 1 - top.used >= LOSE_IT_LEFT
  out.next = ok.length > 1 ? ok[1]!.id : ''
  return out
}

/** "3d 09:12:45", "7:13:22", "13:05". */
export function clockSpan(ms: number): string {
  const total = Math.max(0, Math.floor(Number(ms) / 1000))
  if (!(total >= 0)) return '0:00'
  const d = Math.floor(total / 86400), h = Math.floor((total % 86400) / 3600), m = Math.floor((total % 3600) / 60), s = total % 60
  const two = (n: number) => (n < 10 ? '0' : '') + n
  if (d > 0) return `${d}d ${two(h)}:${two(m)}:${two(s)}`
  if (h > 0) return `${h}:${two(m)}:${two(s)}`
  return `${m}:${two(s)}`
}

/** "3d 10h", "6h 40m", "45m": two units at most. */
export function spanWords(ms: number): string {
  const mins = Math.max(0, Math.round(Number(ms) / 60000))
  if (!(mins >= 1)) return 'under a minute'
  const d = Math.floor(mins / 1440), h = Math.floor((mins % 1440) / 60), m = mins % 60
  if (d > 0) return h > 0 ? `${d}d ${h}h` : `${d}d`
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`
  return `${m}m`
}
