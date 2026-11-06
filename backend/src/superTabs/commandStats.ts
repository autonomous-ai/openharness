import { hostname } from 'node:os'
import { logger } from '../utils/logger.js'

/**
 * How long each kind of Swarm command takes (task #3661): Ken's scan put POST commands p95 at 683 ms on v1.4.20 (11-05: 374),
 * and `route latency` (lib/routeLatency.ts) times the route as one, so no log said which commands were slow. Every minute,
 * `commands by type` logs per command type the count, p50, p95 and max in ms of the store's whole command (its reads outside
 * the write included), how many retried their write (a conflict with another writer), and how many were refused, the type
 * that took the most time first. Nothing is kept but types and numbers: no id, text or email. In memory, per pod, cleared
 * each minute, as `message reach latency` (messageReachStats.ts).
 */

/** What a command's run says besides its time: its write's attempts (1 when it never retried), and whether it was refused. */
export interface CommandFacts { attempts: number; refused?: boolean }

interface Row { n: number; max: number; total: number; retried: number; refused: number; samples: number[] }
interface Window { rows: Map<string, Row>; maxSamples: number; maxTypes: number; random: () => number }

/** A command type as the schema names them (commands.ts): anything else is counted as `other`, never logged as sent. */
const TYPE = /^[a-z][A-Za-z]{0,39}(\.[a-z][A-Za-z]{0,39}){0,2}$/

let current: Window | undefined

export function recordCommand(type: string, ms: number, facts: CommandFacts): void {
  const window = current
  if (!window) return
  let key = TYPE.test(type) ? type : 'other'
  if (!window.rows.has(key) && window.rows.size >= window.maxTypes) key = 'other'
  let row = window.rows.get(key)
  if (!row) window.rows.set(key, row = { n: 0, max: 0, total: 0, retried: 0, refused: 0, samples: [] })
  const value = Math.max(0, ms)
  row.n++
  row.total += value
  if (facts.attempts > 1) row.retried++
  if (facts.refused) row.refused++
  if (value > row.max) row.max = value
  if (row.samples.length < window.maxSamples) row.samples.push(value)
  else {
    const slot = Math.floor(window.random() * row.n)
    if (slot < window.maxSamples) row.samples[slot] = value
  }
}

/** Nearest-rank percentile of sorted values. */
const percentile = (sorted: number[], p: number) => sorted[Math.max(0, Math.ceil(p / 100 * sorted.length) - 1)] ?? 0

/** Logs each window, every `everyMs`, until stopped; stopping logs what is left. `top`: the most types one line lists. */
export function startCommandStats({ everyMs = 60_000, pod = `${hostname()}:${process.pid}`, maxSamples = 2000, maxTypes = 150, top = 40,
  random = Math.random, log = (m, c) => logger.info(m, c) }: { everyMs?: number; pod?: string; maxSamples?: number; maxTypes?: number; top?: number
  random?: () => number; log?: (message: string, context: Record<string, unknown>) => void } = {}): () => void {
  const window: Window = { rows: new Map(), maxSamples, maxTypes, random }
  current = window
  let since = Date.now()
  const flush = () => {
    const now = Date.now()
    if (window.rows.size) {
      const rows = [...window.rows].sort(([, a], [, b]) => b.total - a.total).slice(0, top).map(([type, { n, max, retried, refused, samples }]) => {
        const sorted = samples.sort((a, b) => a - b)
        return [type, { n, p50: Math.round(percentile(sorted, 50)), p95: Math.round(percentile(sorted, 95)), max: Math.round(max),
          ...retried ? { retried } : {}, ...refused ? { refused } : {} }] as const
      })
      log('commands by type', { pod, windowMs: now - since, commands: Object.fromEntries(rows) })
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
