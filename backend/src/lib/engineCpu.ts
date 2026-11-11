import { readdirSync, readFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { performance } from 'node:perf_hooks'
import { logger } from '../utils/logger.js'
import { parseThreadStat, threadBucket } from './cpuStats.js'
import { docsOf, opName, workKind } from './queryStats.js'

/**
 * Which queries the Prisma engine spends its CPU on (task #3041). On 11-05 the engine's threads took 45% of a pod's CPU
 * (`cpu by thread`, lib/cpuStats.ts), as much as all our JS on the main thread, and nothing said which queries.
 *
 * Prisma's `query` events cannot say it: for MongoDB their `duration` is the database call, not the engine's own work
 * (building the query, BSON to values, values to the JSON string the client parses), and the `query` log level formats
 * every query, so it would cost what it measures. Instead: Linux keeps each thread's time on CPU in ns
 * (`/proc/self/task/<tid>/schedstat`). While a query runs alone in the process, the engine threads' CPU between its start
 * and its end is its own. The query hook (lib/queryStats.ts withQueryStats) calls `start` and `end` for every query; a
 * query that starts with none in flight, at most once per `gapMs`, is read before and after, and kept only if no other
 * query started before it ended. Each key's mean is scaled by how often it ran in the minute.
 *
 * `prisma by query`, every minute: per op (model.action, a raw command by collection) and route, the count, the samples,
 * the estimated engine ms and µs per query, and the documents; `byOp` sums each op across routes; `engineMs` sums the
 * estimates, to read beside `cpu by thread`'s `prismaEngineMs`; `costMs` is the sampler's own time. Raw commands run in
 * the same engine and are measured the same way. Like `db by shape`, it names no value: routes are patterns.
 */

export type EngineClock = 'schedstat' | 'stat'

/** The Prisma engine threads' CPU so far, in ns, from `schedstat` where the kernel has it, else `stat`'s 10 ms ticks (each
 *  sample is coarse, the mean over many is not). [names] caches each thread's name by tid. Throws when [root] cannot be
 *  listed (not Linux, or /proc not mounted); a thread that exits while it is read is skipped. */
export function readEngineCpu(root = '/proc/self/task', pid = process.pid, names = new Map<number, string>()): { ns: number; clock: EngineClock } {
  let ns = 0, clock: EngineClock = 'schedstat'
  for (const entry of readdirSync(root)) {
    const tid = Number(entry)
    if (tid === pid) continue
    let name = names.get(tid)
    if (name === undefined) {
      try { name = readFileSync(`${root}/${entry}/comm`, 'utf8').trim() } catch { continue }
      names.set(tid, name)
    }
    if (threadBucket(name, tid, pid) !== 'prismaEngine') continue
    try {
      ns += Number(readFileSync(`${root}/${entry}/schedstat`, 'utf8').split(' ', 1)[0]) || 0
    } catch {
      try { ns += parseThreadStat(readFileSync(`${root}/${entry}/stat`, 'utf8')).cpuMs * 1e6; clock = 'stat' } catch { continue }
    }
  }
  return { ns, clock }
}

/** What `start` opened: the engine CPU before the query, and the start count it must still match at its end. */
export type EngineSample = { ns: number; seq: number }

export type EngineCpu = {
  /** Every query calls it as it starts. Answers the sample it opened, if it opened one. */
  start(): EngineSample | undefined
  /** Every query calls it once as it ends, failed ones too, with what its start answered. */
  end(sample: EngineSample | undefined, model: string | undefined, action: string, args: unknown, result: unknown): void
  /** Logs the window so far and starts a new one. */
  flush(): void
}

export type EngineCpuOptions = {
  pod?: string
  /** Least time between two samples' starts: bounds the sampler's cost at any query rate. */
  gapMs?: number
  /** How many keys the line lists, by engine ms. */
  top?: number
  /** Keys one window keeps; queries past them count under `other`. */
  maxKeys?: number
  now?: () => number
  read?: () => { ns: number; clock: EngineClock }
  log?: (message: string, context: Record<string, unknown>) => void
  warn?: (message: string, context: Record<string, unknown>) => void
}

type Entry = { op: string; route: string; n: number; docs: number; sampled: number; sampledNs: number }

const OTHER = 'other'

export function createEngineCpu({ pod = `${hostname()}:${process.pid}`, gapMs = 100, top = 25, maxKeys = 1000, now = () => performance.now(),
  read, log = (m, c) => logger.info(m, c), warn = (m, c) => logger.warn(m, c) }: EngineCpuOptions = {}): EngineCpu {
  const names = new Map<number, string>()
  const reader = read ?? (() => readEngineCpu(undefined, undefined, names))
  let entries = new Map<string, Entry>()
  let inFlight = 0, starts = 0, lastSample = -Infinity, queries = 0, sampled = 0, discarded = 0, costMs = 0, started = now()
  let clock: EngineClock | undefined, unavailable: string | undefined, warned = false

  /** The engine CPU now, timed into the sampler's own cost; undefined when it cannot be read. */
  const timed = (): number | undefined => {
    const t = performance.now()
    try {
      const reading = reader()
      clock = reading.clock
      unavailable = undefined
      return reading.ns
    } catch (error) {
      unavailable = error instanceof Error ? error.message : String(error)
      return undefined
    } finally {
      costMs += performance.now() - t
    }
  }

  const entryFor = (op: string, route: string): Entry => {
    let key = `${op}\0${route}`
    let entry = entries.get(key)
    if (entry) return entry
    if (entries.size >= maxKeys - 1) { key = OTHER; entry = entries.get(OTHER) }
    if (!entry) {
      entry = key === OTHER ? { op: OTHER, route: '', n: 0, docs: 0, sampled: 0, sampledNs: 0 } : { op, route, n: 0, docs: 0, sampled: 0, sampledNs: 0 }
      entries.set(key, entry)
    }
    return entry
  }

  return {
    start() {
      const alone = inFlight === 0
      inFlight++
      starts++
      if (!alone) return undefined
      const at = now()
      if (at - lastSample < gapMs) return undefined
      lastSample = at
      const ns = timed()
      return ns === undefined ? undefined : { ns, seq: starts }
    },

    end(sample, model, action, args, result) {
      inFlight = Math.max(0, inFlight - 1)
      try {
        queries++
        const entry = entryFor(opName(model, action, args), workKind())
        const docs = docsOf(result)
        entry.n++
        entry.docs += docs
        if (!sample) return
        // Another query started while this one ran: the engine's CPU since is not this query's alone.
        if (starts !== sample.seq) { discarded++; return }
        const ns = timed()
        if (ns === undefined) return
        entry.sampled++
        entry.sampledNs += Math.max(0, ns - sample.ns)
        sampled++
      } catch (error) {
        if (warned) return
        warned = true
        warn('prisma by query failed', { error: error instanceof Error ? error.message : String(error) })
      }
    },

    flush() {
      const rows = [...entries.values()].map(e => {
        const mean = e.sampled ? e.sampledNs / e.sampled : 0
        return { op: e.op, route: e.route, n: e.n, sampled: e.sampled, engineMs: Math.round(mean * e.n / 1e6), usPerQuery: Math.round(mean / 1e3), docs: e.docs }
      })
      const byOp = new Map<string, number>()
      for (const r of rows) byOp.set(r.op, (byOp.get(r.op) ?? 0) + r.engineMs)
      const context: Record<string, unknown> = { pod, windowMs: Math.round(now() - started) }
      if (unavailable !== undefined) Object.assign(context, { threads: 'unavailable', reason: unavailable })
      else Object.assign(context, { clock: clock ?? 'none' })
      Object.assign(context, {
        queries, sampled, discarded, engineMs: rows.reduce((total, r) => total + r.engineMs, 0),
        costMs: Math.round(costMs * 10) / 10, keys: rows.length,
        top: rows.filter(r => r.engineMs > 0).sort((a, b) => b.engineMs - a.engineMs || b.n - a.n).slice(0, top),
        byOp: Object.fromEntries([...byOp].filter(([, ms]) => ms > 0).sort((a, b) => b[1] - a[1]).slice(0, 15)),
      })
      log('prisma by query', context)
      entries = new Map(); queries = 0; sampled = 0; discarded = 0; costMs = 0; started = now()
      // A tid can be reused by a new thread: names are read again each window.
      names.clear()
    },
  }
}

let active: EngineCpu | undefined

/** This process's sampler, once started; the query hook (lib/prisma.ts) reads it on every query. */
export function activeEngineCpu(): EngineCpu | undefined {
  return active
}

/** Starts this process's `prisma by query` line, every [everyMs]. Returns a stop that logs the last partial window. */
export function startEngineCpu(options: EngineCpuOptions & { everyMs?: number } = {}): () => void {
  const engine = createEngineCpu(options)
  active = engine
  const timer = setInterval(() => engine.flush(), options.everyMs ?? 60_000)
  timer.unref()
  return () => {
    clearInterval(timer)
    if (active === engine) active = undefined
    engine.flush()
  }
}
