import { hostname } from 'node:os'
import { performance } from 'node:perf_hooks'
import { logger } from '../utils/logger.js'

/**
 * The last hour of this process, in one line a minute (task #2957). A pod's logs keep only its last ~3 minutes (Ken's
 * scan, 2026-11-04: 424 lines for 3 pods over an hour), so the per-minute lines (`route latency`, `db by shape`,
 * `cpu by kind`) cannot be summed over an hour from outside. `last hour` sums the last 60 one-minute buckets of the same
 * events the Prometheus counters count (lib/metrics.ts): the newest line of each pod is in any log tail, and it alone
 * gives the hour's requests, CPU and DB bytes per route. Keys are route patterns and kinds of work, never ids; each map
 * keeps at most `maxKeys`, past that `other`.
 */

type Totals = { n: number; errors: number; ms: number; dbQueries: number; dbBytes: number; busyMs: number }
type Minute = { startedAt: number; cpuMs: number; requests: Map<string, Totals>; work: Map<string, Totals>; busy: boolean }

export type DbWindow = ReadonlyMap<string, { n: number; ms: number; bytes: number }>
export type BusyWindow = ReadonlyMap<string, number>

export type LastHourOptions = {
  pod?: string
  /** Minutes the line sums. */
  minutes?: number
  /** Routes the line lists by time; half as many more by DB bytes and by busy time. */
  top?: number
  /** Names one map keeps, `other` included. */
  maxKeys?: number
  now?: () => number
  /** This process's user + system CPU so far, in ms. */
  cpuMs?: () => number
  log?: (message: string, context: Record<string, unknown>) => void
}

export type LastHour = {
  /** One HTTP response: its `METHOD /pattern`, its time, and whether it failed (5xx). */
  request(route: string, ms: number, failed: boolean): void
  /** A minute of `db by shape`: every kind of work's queries, time and result bytes. */
  db(work: DbWindow): void
  /** A minute of `cpu by kind` (CPU_SELF_PROFILE=1): every kind of work's busy ms. */
  busy(work: BusyWindow): void
  /** Closes this minute and logs the last hour. */
  roll(): void
}

const OTHER = 'other'
const HTTP = 'http '
const empty = (): Totals => ({ n: 0, errors: 0, ms: 0, dbQueries: 0, dbBytes: 0, busyMs: 0 })
const per = (total: number, n: number) => n ? Math.round(total / n * 10) / 10 : 0

function slot(map: Map<string, Totals>, key: string, maxKeys: number): Totals {
  let totals = map.get(key)
  if (totals) return totals
  if (map.size >= maxKeys - 1) key = OTHER
  totals = map.get(key)
  if (!totals) map.set(key, totals = empty())
  return totals
}

function add(into: Totals, from: Totals): void {
  into.n += from.n; into.errors += from.errors; into.ms += from.ms
  into.dbQueries += from.dbQueries; into.dbBytes += from.dbBytes; into.busyMs += from.busyMs
}

/** The first `n` keys of `rows` by `by`, largest first, skipping zeros. */
const ranked = (rows: Array<[string, Totals]>, by: (t: Totals) => number, n: number) =>
  rows.filter(([, t]) => by(t) > 0).sort((a, b) => by(b[1]) - by(a[1])).slice(0, n).map(([key]) => key)

const processCpuMs = () => { const used = process.cpuUsage(); return (used.user + used.system) / 1000 }

export function createLastHour({ pod = `${hostname()}:${process.pid}`, minutes = 60, top = 40, maxKeys = 300, now = () => performance.now(),
  cpuMs = processCpuMs, log = (m, c) => logger.info(m, c) }: LastHourOptions = {}): LastHour {
  const ring: Minute[] = []
  const fresh = (): Minute => ({ startedAt: now(), cpuMs: 0, requests: new Map(), work: new Map(), busy: false })
  let current = fresh(), cpuBefore = cpuMs()

  const line = (): Record<string, unknown> => {
    const requests = new Map<string, Totals>(), work = new Map<string, Totals>()
    let cpu = 0, busy = false
    for (const minute of ring) {
      cpu += minute.cpuMs
      busy ||= minute.busy
      for (const [key, t] of minute.requests) add(slot(requests, key, maxKeys), t)
      for (const [key, t] of minute.work) add(slot(work, key, maxKeys), t)
    }
    // A route's DB and busy time are those of its `http` work.
    for (const [key, t] of requests) {
      const own = work.get(HTTP + key)
      if (!own) continue
      t.dbQueries += own.dbQueries; t.dbBytes += own.dbBytes; t.busyMs += own.busyMs
      work.delete(HTTP + key)
    }
    const all = empty()
    for (const t of requests.values()) add(all, t)
    const httpDbBytes = all.dbBytes
    for (const t of work.values()) { all.dbQueries += t.dbQueries; all.dbBytes += t.dbBytes; all.busyMs += t.busyMs }

    const routeRows = [...requests], workRows = [...work], half = Math.max(1, Math.floor(top / 2))
    const shown = new Set([...ranked(routeRows, t => t.ms, top), ...ranked(routeRows, t => t.dbBytes, half), ...(busy ? ranked(routeRows, t => t.busyMs, half) : [])])
    const shownWork = new Set([...ranked(workRows, t => t.dbBytes, half), ...(busy ? ranked(workRows, t => t.busyMs, half) : [])])
    const busyOf = (t: Totals, perRequest: boolean) => busy ? { busyMs: Math.round(t.busyMs), ...(perRequest ? { busyMsPerRequest: per(t.busyMs, t.n) } : {}) } : {}
    return {
      pod, windowMs: ring.length ? Math.round(now() - ring[0]!.startedAt) : 0, minutes: ring.length,
      requests: all.n, errors: all.errors, cpuMs: Math.round(cpu), cpuMsPerRequest: per(cpu, all.n),
      dbQueries: all.dbQueries, dbBytes: Math.round(all.dbBytes), dbBytesPerRequest: Math.round(per(httpDbBytes, all.n)), ...busyOf(all, false),
      routeCount: requests.size,
      routes: Object.fromEntries([...shown].map(key => {
        const t = requests.get(key)!
        return [key, { n: t.n, perMinute: per(t.n, ring.length), errors: t.errors, ms: Math.round(t.ms), dbQueries: t.dbQueries, dbBytes: Math.round(t.dbBytes),
          dbBytesPerRequest: Math.round(per(t.dbBytes, t.n)), ...busyOf(t, true) }]
      })),
      work: Object.fromEntries([...shownWork].map(key => {
        const t = work.get(key)!
        return [key, { dbQueries: t.dbQueries, dbBytes: Math.round(t.dbBytes), ...busyOf(t, false) }]
      })),
    }
  }

  return {
    request(route, ms, failed) {
      const t = slot(current.requests, route, maxKeys)
      t.n++; t.ms += ms
      if (failed) t.errors++
    },
    db(window) {
      for (const [key, w] of window) { const t = slot(current.work, key, maxKeys); t.dbQueries += w.n; t.dbBytes += w.bytes }
    },
    busy(window) {
      current.busy = true
      for (const [key, ms] of window) slot(current.work, key, maxKeys).busyMs += ms
    },
    roll() {
      const cpuNow = cpuMs()
      current.cpuMs = cpuNow - cpuBefore
      cpuBefore = cpuNow
      ring.push(current)
      if (ring.length > minutes) ring.shift()
      current = fresh()
      log('last hour', line())
    },
  }
}

/** Rolls the hour every minute. Returns its stop. */
export function startLastHour(hour: LastHour, everyMs = 60_000): () => void {
  const timer = setInterval(() => hour.roll(), everyMs)
  timer.unref()
  return () => clearInterval(timer)
}
