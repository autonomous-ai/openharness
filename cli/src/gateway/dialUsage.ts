// The dial's day, as the devices count it into their own file (cable/dialUsageFile.ts), merged into the gateway's
// signed-in report: what the file holds over what was already sent, and at each day's close what only the gateway
// knows (outside the app, returns, the period flags, the waits). docs/plans/2026-11-23-dial-usage-counts-design.md.
import { statSync } from 'node:fs'
import { DIAL_DEVICE_METRICS, DIAL_FILE_METRICS, DIAL_FLAG_METRICS, DIAL_USAGE_FILE_MAX_BYTES, DIAL_USAGE_FILE_VERSION,
  DIAL_USAGE_MAX_COUNT, DIAL_WAIT_BUCKETS, type DialFileMetric, type DialUsageMetric } from '../lib/dialUsageContract.js'
import { jsonObject, readState } from '../lib/secureState.js'

type DialCounts = Partial<Record<DialFileMetric, number>>
export interface DialFileRead { series: number; days: Record<string, DialCounts> }
/** `same`: the file's stamp is the last read's, so it was not read again: that read still holds. */
export type DialRead = { state: 'ok'; file: DialFileRead } | { state: 'none' } | { state: 'bad' } | { state: 'same' }
export interface DialStamp { mtimeMs: number; size: number }
/**
 * What the gateway has taken from the devices' file. `sent`: each open day's values as last taken (flags kept across
 * a new series). `closedThrough`: the newest day whose close is done; a day open at a baseline is at or before it,
 * so its close derives nothing. `baseline`: the next merge takes the file as sent.
 */
export interface DialRecord { series: number | null; sent: Record<string, DialCounts>
  closedThrough: string | null; baseline: boolean; usedDays: string[]; usedOutsideDays: string[] }
export interface DialAdd { metric: DialUsageMetric; day: string; value: number }

const DAY = 86_400_000
// Weeks start on Monday, and 28-day periods count from the same Monday (Decision 3).
const PERIOD_START = Date.parse('1970-01-05T00:00:00.000Z')
const DESKTOP_WINDOW_DAYS = 28
const RETURN_LAGS = [1, 7, 28] as const
const fileNames = new Set<string>(DIAL_FILE_METRICS)
const deviceNames = new Set<string>(DIAL_DEVICE_METRICS)
const flagNames = new Set<string>(DIAL_FLAG_METRICS)
// The raw waits each kind of day turns into (Decision 1). An answer on the dial is use, so an unused day has none.
const USED_DAY_WAITS = [
  ...DIAL_WAIT_BUCKETS.flatMap(b => [[`dial_wait_dial_${b}`, `dial_wait_used_day_dial_${b}`],
    [`dial_wait_elsewhere_${b}`, `dial_wait_used_day_elsewhere_${b}`]] as const),
  ['dial_wait_none', 'dial_wait_used_day_none'],
] as const
const UNUSED_DAY_WAITS = [
  ...DIAL_WAIT_BUCKETS.map(b => [`dial_wait_elsewhere_${b}`, `dial_wait_unused_day_elsewhere_${b}`] as const),
  ['dial_wait_none', 'dial_wait_unused_day_none'],
] as const

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const midnight = (day: string): number => Date.parse(`${day}T00:00:00.000Z`)
const shift = (day: string, days: number): string => new Date(midnight(day) + days * DAY).toISOString().slice(0, 10)
const calendarDay = (day: unknown): day is string =>
  typeof day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day) && Number.isFinite(midnight(day)) && shift(day, 0) === day
const period = (day: string, days: number): number => Math.floor((midnight(day) - PERIOD_START) / (days * DAY))
const latest = (day: string | null, other: string): string => day === null || other > day ? other : day

/** Known names with whole values in (0, DIAL_USAGE_MAX_COUNT], a flag only at 1; the rest dropped one by one, unsaid. */
function cleanCounts(raw: Record<string, unknown>): DialCounts {
  const counts: DialCounts = {}
  for (const [name, value] of Object.entries(raw)) {
    if (fileNames.has(name) && typeof value === 'number' && Number.isSafeInteger(value) && value > 0
        && value <= DIAL_USAGE_MAX_COUNT && (value === 1 || !flagNames.has(name))) counts[name as DialFileMetric] = value
  }
  return counts
}

/**
 * The devices' file, when its stamp changed since [last]. Only the dial's names reach the result and nothing of what
 * is dropped is logged. `bad`: past its bound, of another version or shape, or not readable; a stamp comes back only
 * for what was judged, so a read that failed is tried again at the next tick.
 */
export function readDialFile(file: string, validDay: (day: string) => boolean, last?: DialStamp): { read: DialRead; stamp?: DialStamp } {
  let stamp: DialStamp
  try {
    const stat = statSync(file, { throwIfNoEntry: false })
    if (!stat) return { read: { state: 'none' } }
    stamp = { mtimeMs: stat.mtimeMs, size: stat.size }
  } catch {
    return { read: { state: 'bad' } }
  }
  if (last?.mtimeMs === stamp.mtimeMs && last.size === stamp.size) return { read: { state: 'same' }, stamp }
  if (stamp.size > DIAL_USAGE_FILE_MAX_BYTES) return { read: { state: 'bad' }, stamp }
  // Bytes that are no JSON object are set aside as any cache file's (and then read as missing).
  const read = readState(file, 'cache', jsonObject)
  if (read.state !== 'ok') return { read: { state: 'bad' } }
  const { version, series, days } = read.value
  if (version !== DIAL_USAGE_FILE_VERSION || !Number.isSafeInteger(series) || !isRecord(days)) return { read: { state: 'bad' }, stamp }
  const kept: Record<string, DialCounts> = {}
  for (const [day, counts] of Object.entries(days)) if (validDay(day) && isRecord(counts)) kept[day] = cleanCounts(counts)
  return { read: { state: 'ok', file: { series: series as number, days: kept } }, stamp }
}

/** [baseline]: the first merge takes the file as sent, so nothing it held before is reported. */
export function freshDialRecord(baseline: boolean): DialRecord {
  return { series: null, sent: {}, closedThrough: null, baseline, usedDays: [], usedOutsideDays: [] }
}

/** A record read back from the gateway's queue file: each field rebuilt, anything else dropped. */
export function cleanDialRecord(value: unknown, validDay: (day: string) => boolean): DialRecord {
  // A queue file from before the dial's counts has no record: the devices' file came with them, so none of it was sent.
  if (!isRecord(value)) return freshDialRecord(false)
  const sent: Record<string, DialCounts> = {}
  if (isRecord(value.sent)) for (const [day, counts] of Object.entries(value.sent)) if (validDay(day) && isRecord(counts)) sent[day] = cleanCounts(counts)
  const days = (list: unknown): string[] => Array.isArray(list)
    ? [...new Set(list.filter((day): day is string => typeof day === 'string' && validDay(day)))].sort() : []
  return { series: Number.isSafeInteger(value.series) ? value.series as number : null, sent,
    // Kept past the window and ahead of the clock: forgetting it would reopen, and send again, every day it closed.
    closedThrough: calendarDay(value.closedThrough) ? value.closedThrough : null,
    baseline: value.baseline === true, usedDays: days(value.usedDays), usedOutsideDays: days(value.usedOutsideDays) }
}

/**
 * Merges [file] into [record]: each device name adds what the file holds over what was sent, then each day before
 * [closeBefore] closes, oldest first, with what only the gateway derives. Never counts twice across a restart of
 * either side: a new series (the file made again) keeps the flags sent and forgets the event counts sent, and a
 * closed day's later changes add nothing.
 */
export function mergeDial(record: DialRecord, file: DialFileRead, at: { closeBefore: string; desktopDays: readonly string[];
  validDay: (day: string) => boolean }): { record: DialRecord; adds: DialAdd[] } {
  const adds: DialAdd[] = []
  const usedDays = record.usedDays.filter(at.validDay), usedOutsideDays = record.usedOutsideDays.filter(at.validDay)
  let closedThrough = latest(record.closedThrough, shift(at.closeBefore, -1))
  if (record.baseline) {
    // Sharing turned on again, or another account: what the file holds is taken as sent, and the days still open
    // close without a derivation, so nothing from before reaches a report, not even as a twin or a period flag.
    const sent: Record<string, DialCounts> = {}
    for (const [day, counts] of Object.entries(file.days)) if (day >= at.closeBefore) {
      sent[day] = { ...counts }
      closedThrough = latest(closedThrough, day)
    }
    return { record: { series: file.series, sent, closedThrough, baseline: false, usedDays, usedOutsideDays }, adds }
  }
  const newSeries = file.series !== record.series
  const sent: Record<string, DialCounts> = {}
  for (const [day, counts] of Object.entries(record.sent)) if (at.validDay(day)) {
    sent[day] = newSeries ? Object.fromEntries(Object.entries(counts).filter(([name]) => flagNames.has(name))) : { ...counts }
  }
  for (const day of Object.keys(file.days).sort()) {
    if (!sent[day]) {
      if (record.closedThrough !== null && day <= record.closedThrough) continue
      sent[day] = {}
    }
    const taken = sent[day]
    for (const [name, value] of Object.entries(file.days[day]) as [DialFileMetric, number][]) {
      const before = taken[name] ?? 0
      if (value > before && deviceNames.has(name)) adds.push({ metric: name as DialUsageMetric, day, value: value - before })
      // The most ever taken: a count that went down and up again adds only past it.
      taken[name] = Math.max(before, value)
    }
  }
  const add = (metric: DialUsageMetric, day: string, value = 1): void => { adds.push({ metric, day, value }) }
  for (const day of Object.keys(sent).sort()) {
    if (day >= at.closeBefore) break
    const counts = sent[day]
    delete sent[day]
    if (record.closedThrough !== null && day <= record.closedThrough) continue
    const used = counts.dial_used_installation_days === 1
    const outside = !at.desktopDays.some(desktop => desktop >= shift(day, 1 - DESKTOP_WINDOW_DAYS) && desktop <= day)
    if (outside) {
      if (counts.dial_connected_installation_days === 1) add('dial_connected_outside_app_installation_days', day)
      if (used) add('dial_used_outside_app_installation_days', day)
      if (counts.dial_first_use_installations === 1) add('dial_first_use_outside_app_installations', day)
    }
    if (used) {
      // Returns go to the earlier day's cohort, as the working-day returns of productUsage.ts do.
      for (const lag of RETURN_LAGS) {
        const cohort = shift(day, -lag)
        if (usedDays.includes(cohort)) add(`dial_d${lag}_returning_installations`, cohort)
        if (usedOutsideDays.includes(cohort)) add(`dial_d${lag}_returning_outside_app_installations`, cohort)
      }
      const first = (days: string[], length: number): boolean => !days.some(other => period(other, length) === period(day, length))
      if (first(usedDays, 7)) add('dial_used_week_installations', day)
      if (first(usedDays, 28)) add('dial_used_28d_installations', day)
      if (outside && first(usedOutsideDays, 7)) add('dial_used_outside_app_week_installations', day)
      if (outside && first(usedOutsideDays, 28)) add('dial_used_outside_app_28d_installations', day)
      usedDays.push(day)
      if (outside) usedOutsideDays.push(day)
    }
    let waited = false
    for (const [raw, derived] of used ? USED_DAY_WAITS : UNUSED_DAY_WAITS) {
      const value = counts[raw]
      if (value) { add(derived, day, value); waited = true }
    }
    if (waited) add(used ? 'dial_wait_used_day_installation_days' : 'dial_wait_unused_day_installation_days', day)
  }
  return { record: { series: file.series, sent, closedThrough, baseline: false, usedDays, usedOutsideDays }, adds }
}
