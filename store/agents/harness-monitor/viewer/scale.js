/**
 * The hps's geometry, and the units it reads back — the only arithmetic in the pane, kept in a module
 * of its own so it can be tested without a browser (test/scale.test.mjs) and so the dragged rules, the
 * chips and the axis ticks cannot disagree about where a moment in time sits on the track.
 *
 * The scale is logarithmic and anchored at both ends: one minute at the right edge, thirty days at the
 * left. Linear time would put every idle harness in the last eighth of the track and leave the useful
 * part — the hours between "working on it" and "gone quiet" — invisible.
 */

export const FLOOR = 60_000            // one minute: the right edge
export const CEIL = 30 * 86_400_000    // thirty days: the left edge
const SPAN = Math.log(CEIL / FLOOR)

export const UNITS = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }

/** Thresholds a person would actually type, and the only values a dragged rule can land on. */
export const PAUSE_STEPS = ['15m', '30m', '1h', '2h', '4h', '6h', '8h', '12h', '1d', '2d', '3d', '7d']
export const HIDE_STEPS = ['1d', '2d', '3d', '5d', '7d', '10d', '14d', '21d', '30d']

export function parseDuration(value) {
  const match = /^(\d+(?:\.\d+)?)\s*([smhdw])$/.exec(String(value ?? '').trim())
  return match ? Number(match[1]) * UNITS[match[2]] : Number(value) || 0
}

/** Same rule as the CLI's column: one unit, never two. `humanIdle` in lib/policy.mjs is its twin, and
 *  test/scale.test.mjs asserts they agree — a fleet that reads `3d` in the pane and `2d` in the terminal
 *  has two different answers to the only question it is asked. */
export function humanIdle(ms) {
  const n = Math.max(0, Math.floor(Number(ms) || 0))
  if (n < 45_000) return 'now'
  if (n < UNITS.h) return `${Math.round(n / UNITS.m)}m`
  if (n < UNITS.d) return `${Math.round(n / UNITS.h)}h`
  if (n < 7 * UNITS.d) return `${Math.floor(n / UNITS.d)}d`
  const weeks = Math.floor(n / UNITS.w)
  return weeks > 9 ? '9w+' : `${weeks}w`
}

/** Bytes, in the width a column can afford: `1.2G`, `340M`, `—`. */
export function bytes(value) {
  const n = Number(value) || 0
  if (!n) return '—'
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)}G`
  return `${Math.round(n / 1024 ** 2)}M`
}

/** Idle → a fraction of the track. 1 is now (right edge), 0 is a month ago (left edge). */
export function xOf(idleMs) {
  const clamped = Math.min(CEIL, Math.max(FLOOR, Number(idleMs) || 0))
  return Math.min(1, Math.max(0, 1 - Math.log(clamped / FLOOR) / SPAN))
}

/** The inverse, for a rule the pointer is dragging. */
export function idleOfX(x) {
  return FLOOR * Math.exp((1 - Math.min(1, Math.max(0, Number(x) || 0))) * SPAN)
}

/** The nearest step, measured in log time so 30m→1h feels the same distance as 7d→14d. */
export function snap(idleMs, steps) {
  let best = steps[0]
  let distance = Infinity
  for (const step of steps) {
    const gap = Math.abs(Math.log(parseDuration(step)) - Math.log(Math.max(1, idleMs)))
    if (gap < distance) { distance = gap; best = step }
  }
  return best
}
