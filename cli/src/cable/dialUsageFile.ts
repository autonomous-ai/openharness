// The dial's usage counts of this computer, by UTC day (docs/plans/2026-11-23-dial-usage-counts-design.md): the
// devices' process counts into it and the gateway reads it at its report tick, so the counts reach the daily report
// with no door into the core. It lives in the daemon's data folder beside dial-notices.json. One writer: the devices'
// process. Fixed names and numbers only, never an id, a name or a path.
import { statSync } from 'node:fs'
import {
  DIAL_FILE_METRICS, DIAL_FLAG_METRICS, DIAL_USAGE_DAYS, DIAL_USAGE_FILE_MAX_BYTES, DIAL_USAGE_FILE_VERSION,
  DIAL_USAGE_MAX_COUNT, type DialFileMetric, type DialUsageSink,
} from '../lib/dialUsageContract.js'
import { errorKind } from '../lib/log.js'
import { atomicWriteFile, readState } from '../lib/secureState.js'

/** Adds that come close together (a turn, its strokes, its voice) are one write, not one a turn of the dial. */
export const DIAL_USAGE_WRITE_MS = 5_000

export interface DialUsageFileDeps {
  file: string
  /** Wall-clock ms: the UTC day a count lands on. */
  now(): number
  /** Runs [run] after [ms]; answers its cancel. */
  after(ms: number, run: () => void): () => void
  signedIn(): boolean
  /** A dial was set up on this computer before this file was. */
  hadDial(): boolean
  log(line: string): void
}

type Counts = Partial<Record<DialFileMetric, number>>
interface Usage {
  version: typeof DIAL_USAGE_FILE_VERSION
  /** When the file was made: a new series tells the gateway its counts are new events, not ones it has sent. */
  series: number
  connectedBefore: boolean
  usedBefore: boolean
  days: Record<string, Counts>
}

/** Why a file is dropped whole: one fixed word, never the path or what the file says. */
type Dropped = 'long' | 'json' | 'version' | 'shape'

const DAY_MS = 86_400_000
const KNOWN = new Set<string>(DIAL_FILE_METRICS)
const FLAGS = new Set<string>(DIAL_FLAG_METRICS)
/** A flag is one computer, so it is never above 1. */
const ceiling = (metric: string): number => FLAGS.has(metric) ? 1 : DIAL_USAGE_MAX_COUNT
const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10)

/** A real UTC day among the last DIAL_USAGE_DAYS, today's included: a later one is another clock's. */
const recent = (day: string, now: number): boolean => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false
  const stamp = Date.parse(`${day}T00:00:00.000Z`)
  const today = Math.floor(now / DAY_MS) * DAY_MS
  // A 2026-11-31 parses as 2026-12-01: only a day that reads back as itself is one.
  return Number.isFinite(stamp) && dayOf(stamp) === day && stamp <= today && stamp > today - DIAL_USAGE_DAYS * DAY_MS
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** The known names of a day at values this build writes; another build's or a person's are left out one by one. */
const knownCounts = (counts: unknown): Counts => {
  const kept: Counts = {}
  if (!isObject(counts)) return kept
  for (const [metric, n] of Object.entries(counts)) {
    if (KNOWN.has(metric) && typeof n === 'number' && Number.isSafeInteger(n) && n > 0 && n <= ceiling(metric)) {
      kept[metric as DialFileMetric] = n
    }
  }
  return kept
}

const parse = (text: string, now: number): Usage | Dropped => {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return 'json'
  }
  if (!isObject(value)) return 'shape'
  if (value.version !== DIAL_USAGE_FILE_VERSION) return 'version'
  const { series, connectedBefore, usedBefore, days } = value
  if (typeof series !== 'number' || !Number.isSafeInteger(series) || series <= 0
    || typeof connectedBefore !== 'boolean' || typeof usedBefore !== 'boolean' || !isObject(days)) return 'shape'
  const kept: Record<string, Counts> = {}
  for (const [day, counts] of Object.entries(days)) {
    if (!recent(day, now)) continue
    const known = knownCounts(counts)
    if (Object.keys(known).length > 0) kept[day] = known
  }
  return { version: DIAL_USAGE_FILE_VERSION, series, connectedBefore, usedBefore, days: kept }
}

const load = (file: string, now: number): Usage | Dropped | 'missing' | 'unreadable' => {
  // Its size before its bytes: a file much larger than ours is not ours, and reading it whole would cost the start.
  try {
    if (statSync(file).size > DIAL_USAGE_FILE_MAX_BYTES) return 'long'
  } catch { /* not there, or not to be looked at: the read says which */ }
  // The text as it is: what cannot be parsed is this reader's to drop, in its own word, and the next write replaces it.
  const read = readState(file, 'cache', (text) => text)
  return read.state === 'ok' ? parse(read.value, now) : read.state
}

const textOf = (usage: Usage): string => `${JSON.stringify(usage)}\n`

export class DialUsageFile implements DialUsageSink {
  private readonly usage: Usage
  private cancel: (() => void) | undefined
  private closed = false
  /** The file could not be read (EACCES, EMFILE): it may hold days the gateway has not sent, so this run writes
   *  nothing over it. */
  private readonly unread: boolean

  /** Reads the file once. Nothing in it may stop the devices' process from starting, so this never throws. */
  constructor(private readonly deps: DialUsageFileDeps) {
    const loaded = load(deps.file, deps.now())
    this.unread = loaded === 'unreadable'
    if (typeof loaded === 'object') {
      this.usage = loaded
      return
    }
    if (loaded !== 'missing' && loaded !== 'unreadable') deps.log(`[device] usage · dropped · ${loaded}`)
    // A computer that had a dial before this file existed spends no first connection or first use on it.
    const before = deps.hadDial()
    this.usage = { version: DIAL_USAGE_FILE_VERSION, series: deps.now(), connectedBefore: before, usedBefore: before, days: {} }
  }

  add(metric: DialFileMetric, n = 1): boolean {
    if (!this.counting()) return false
    const counts = this.usage.days[dayOf(this.deps.now())] ??= {}
    const was = counts[metric] ?? 0
    const next = Math.min(was + n, ceiling(metric))
    // A flag set again, or a count at its cap: nothing to write.
    if (next === was) return false
    counts[metric] = next
    this.changed()
    return true
  }

  firstEver(mark: 'connected' | 'used'): boolean {
    const field = mark === 'connected' ? 'connectedBefore' : 'usedBefore'
    if (!this.counting() || this.usage[field]) return false
    this.usage[field] = true
    this.changed()
    return true
  }

  /** The devices' process stops: what waits is written now, and nothing after, so the stop's own endings (its
   *  detach) count nothing, and no first use is spent that the file would not keep. */
  close(): void {
    const waiting = this.cancel
    this.cancel = undefined
    this.closed = true
    if (!waiting) return
    waiting()
    this.write()
  }

  /** Signed out, nothing is counted (signed-in computers only, by the spec). */
  private counting(): boolean {
    return !this.closed && this.deps.signedIn()
  }

  private changed(): void {
    if (this.cancel || this.unread) return
    this.cancel = this.deps.after(DIAL_USAGE_WRITE_MS, () => {
      this.cancel = undefined
      this.write()
    })
  }

  private write(): void {
    const { days } = this.usage
    const now = this.deps.now()
    for (const day of Object.keys(days)) if (!recent(day, now)) delete days[day]
    let text = textOf(this.usage)
    // The oldest days go first: the gateway has most likely sent them by now.
    for (const day of Object.keys(days).sort()) {
      if (Buffer.byteLength(text) <= DIAL_USAGE_FILE_MAX_BYTES) break
      delete days[day]
      text = textOf(this.usage)
    }
    try {
      atomicWriteFile(this.deps.file, text, 'cache')
    } catch (error) {
      // Its kind, never the message, which names the path. Memory stays the truth; the next change tries again.
      this.deps.log(`[device] usage · not saved · ${errorKind(error)}`)
    }
  }
}
