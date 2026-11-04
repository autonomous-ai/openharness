import { hostname } from 'node:os'
import { logger } from '../utils/logger.js'

/**
 * How fast a message reaches its reader (task #2840, Watch Production): Ken's guard on the load work had no measurement in
 * any production log. Every minute, `message reach latency` logs per reader kind and way the count, p50, p95 and max in ms,
 * per pod, in the style of `route latency` (lib/routeLatency.ts) and `messages by reader` (messageReadStats.ts):
 * - `delivery`: an agent's host acknowledged it typed the message (store.ts delivery), from the delivery's creation, which
 *   is written with its message;
 * - `read`: a person's read of new messages returned it (store.ts messages, `after`), from the message's creation.
 * Nothing is kept but kinds and numbers: no id, text or email. In memory, per pod, cleared each minute.
 */

export interface MessageReachKey {
  reader: 'person' | 'agent' | 'buddy'
  via: 'read' | 'delivery'
}

/** Older than this when it reached its reader, a message was waiting on a reader that was away (an app closed, a machine
 *  asleep), not on the Swarm: it is counted as `late`, outside the percentiles, so a catch-up cannot set the p95. */
export const LATE_MS = 10 * 60_000

interface Row { key: MessageReachKey; n: number; late: number; max: number; samples: number[] }
interface Window { rows: Map<string, Row>; maxSamples: number; random: () => number }

let current: Window | undefined

export function recordMessageReach(key: MessageReachKey, ms: number): void {
  const window = current
  if (!window) return
  const id = `${key.reader}|${key.via}`
  let row = window.rows.get(id)
  if (!row) window.rows.set(id, row = { key: { reader: key.reader, via: key.via }, n: 0, late: 0, max: 0, samples: [] })
  if (ms > LATE_MS) { row.late++; return }
  const value = Math.max(0, ms)
  row.n++
  if (value > row.max) row.max = value
  if (row.samples.length < window.maxSamples) row.samples.push(value)
  else {
    const slot = Math.floor(window.random() * row.n)
    if (slot < window.maxSamples) row.samples[slot] = value
  }
}

/** Nearest-rank percentile of sorted values. */
const percentile = (sorted: number[], p: number) => sorted[Math.max(0, Math.ceil(p / 100 * sorted.length) - 1)] ?? 0
const round = (ms: number) => Math.round(ms)

/** Logs each window, every `everyMs`, until stopped; stopping logs what is left. */
export function startMessageReachStats({ everyMs = 60_000, pod = `${hostname()}:${process.pid}`, maxSamples = 2000, random = Math.random,
  log = (m, c) => logger.info(m, c) }: { everyMs?: number; pod?: string; maxSamples?: number; random?: () => number
  log?: (message: string, context: Record<string, unknown>) => void } = {}): () => void {
  const window: Window = { rows: new Map(), maxSamples, random }
  current = window
  let since = Date.now()
  const flush = () => {
    const now = Date.now()
    if (window.rows.size) {
      const rows = [...window.rows.values()].map(({ key, n, late, max, samples }) => {
        const sorted = samples.sort((a, b) => a - b)
        return { ...key, n, ...n ? { p50: round(percentile(sorted, 50)), p95: round(percentile(sorted, 95)), max: round(max) } : {}, ...late ? { late } : {} }
      })
      log('message reach latency', { pod, windowMs: now - since, rows })
    }
    window.rows.clear()
    since = now
  }
  const timer = setInterval(flush, everyMs)
  timer.unref()
  return () => {
    clearInterval(timer)
    if (current === window) current = undefined
    flush()
  }
}
