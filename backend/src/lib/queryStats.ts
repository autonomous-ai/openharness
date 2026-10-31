import { AsyncLocalStorage } from 'node:async_hooks'
import { hostname } from 'node:os'
import { performance } from 'node:perf_hooks'
import type { PrismaClient } from '@prisma/client'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { logger } from '../utils/logger.js'
import { MEASURE_EVERY_MS, MEASURE_FOR_MS, measureWindows } from './measureWindows.js'

/**
 * Which queries this process sends, per kind of work (DB roadmap Phase 1). Atlas logs only operations over 100 ms; the
 * load is in the ~900 fast ones a second. Every minute, `db by shape` logs per model.action, filter shape and route: count,
 * total ms, documents and result bytes (sampled), with the window's top keys, and the count and total time of queries at
 * or over 200 ms (Atlas has no alert on slow operations; a log monitor sums `slowMs`). Each such query also logs
 * `slow query`, at most 20 a minute. Neither log carries a value: a shape keeps a filter's keys and replaces every value
 * with `?`, and a key that is not a plain name (an id, an email) becomes `*`. Routes are patterns, never URLs.
 */

const work = new AsyncLocalStorage<string>()

/** The kind of work running now: an HTTP route pattern or WebSocket frame kind, or `background` for timers and startup. */
export function workKind(): string {
  return work.getStore() ?? 'background'
}

/** Runs fn, and everything it schedules, as `kind`. */
export function runWork<T>(kind: string, fn: () => T): T {
  return work.run(kind, fn)
}

/** Names the work running now and what it goes on to schedule, for code that has no callback to wrap (a frame handler).
 *  undefined clears it. */
export function enterWork(kind: string | undefined): void {
  work.enterWith(kind as string)
}

const httpKind = (request: FastifyRequest) => `http ${request.method} ${request.routeOptions.url ?? 'unrouted'}`

/** Names every request by its route pattern, for the hooks and handler that follow. Register it before any hook that
 *  reads the database (rate limit, sign-in). */
export function registerWorkContext(app: FastifyInstance): void {
  app.addHook('onRequest', (request, _reply, done) => runWork(httpKind(request), done))
}

/* ---------- filter shapes ---------- */

const MAX_DEPTH = 6
const MAX_ITEMS = 5
const MAX_SHAPE = 300
/** Operators whose argument is a value, even when it is an object (`equals` on a Json field, `$literal`). */
const VALUE_OPS = new Set(['equals', 'in', 'notIn', 'has', 'hasSome', 'hasEvery', 'set', 'push', 'path',
  '$eq', '$ne', '$in', '$nin', '$all', '$literal', '$gt', '$gte', '$lt', '$lte'])
const NAME = /^[$A-Za-z_][A-Za-z0-9_$]{0,39}$/
const ID_LIKE = /[0-9a-f]{12,}|\d{5,}/i

const KEY_CHARS = /^[A-Za-z0-9_$.]{1,120}$/

/** A key as a log may show it: `*` for any key with other characters (an email, a space), else each dotted segment that is
 *  a plain name, an id-like one as `*` (`parts.*`). */
function safeKey(key: string): string {
  if (!KEY_CHARS.test(key)) return '*'
  return key.split('.').map(segment => NAME.test(segment) && !ID_LIKE.test(segment) ? segment : '*').join('.')
}

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function shapeOf(value: unknown, depth: number): unknown {
  if (Array.isArray(value)) {
    if (!value.some(item => isPlainObject(item) || Array.isArray(item))) return '?'
    if (depth >= MAX_DEPTH) return '…'
    const items = value.slice(0, MAX_ITEMS).map(item => shapeOf(item, depth + 1))
    return value.length > MAX_ITEMS ? [...items, '…'] : items
  }
  if (!isPlainObject(value)) return '?'
  if (depth >= MAX_DEPTH) return '…'
  const shaped: Record<string, unknown> = {}
  for (const key of Object.keys(value).sort()) {
    const safe = safeKey(key)
    if (safe in shaped) continue
    shaped[safe] = VALUE_OPS.has(key) ? '?' : shapeOf(value[key], depth + 1)
  }
  return shaped
}

/** A pipeline as its stage names, with the keys of each `$match`. */
function pipelineShape(pipeline: unknown[]): unknown {
  return pipeline.slice(0, 10).map(stage => {
    if (!isPlainObject(stage)) return '?'
    const name = Object.keys(stage)[0] ?? '?'
    return name === '$match' ? { $match: shapeOf(stage.$match, 1) } : safeKey(name)
  })
}

/** What a query filtered on, keys only, as a short string: equal for queries that differ only in their values. */
export function filterShape(action: string, args: unknown): string {
  if (!isPlainObject(args)) return ''
  let shape: unknown
  if (action === '$runCommandRaw') {
    if (Array.isArray(args.pipeline)) shape = pipelineShape(args.pipeline)
    else if ('filter' in args) shape = shapeOf(args.filter, 0)
    else if ('query' in args) shape = shapeOf(args.query, 0)
    else {
      const first = Array.isArray(args.updates) ? args.updates[0] : Array.isArray(args.deletes) ? args.deletes[0] : undefined
      if (isPlainObject(first)) shape = shapeOf(first.q, 0)
    }
  } else if (action === 'aggregateRaw' && Array.isArray(args.pipeline)) shape = pipelineShape(args.pipeline)
  else if (action === 'findRaw') shape = shapeOf(args.filter, 0)
  else if ('where' in args) shape = shapeOf(args.where, 0)
  if (shape === undefined) return ''
  const text = JSON.stringify(shape)
  return text.length > MAX_SHAPE ? `${text.slice(0, MAX_SHAPE)}…` : text
}

/** `Model.action`; a raw command by its collection and command name (`SwarmGroup.$runCommandRaw aggregate`). */
function opName(model: string | undefined, action: string, args: unknown): string {
  if (model) return `${model}.${action}`
  if (action === '$runCommandRaw' && isPlainObject(args)) {
    const command = Object.keys(args)[0] ?? '?'
    const collection = typeof args[command] === 'string' ? safeKey(args[command] as string) : '-'
    return `${collection}.$runCommandRaw ${safeKey(command)}`
  }
  return action
}

/** Documents a result holds: a list's length, one for a document, a raw cursor reply's first batch. */
function docsOf(result: unknown): number {
  if (Array.isArray(result)) return result.length
  if (isPlainObject(result)) {
    const cursor = result.cursor
    if (isPlainObject(cursor) && Array.isArray(cursor.firstBatch)) return cursor.firstBatch.length
    return 1
  }
  return 0
}

/** How much of a result one measurement reads at most. */
const BYTE_BUDGET = 256 * 1024

/**
 * A result's size as JSON characters, close to what it cost to send and unpack, without serializing it: the exact JSON
 * length for ordinary results (strings count without escapes). It reads at most `budget` characters' worth: a list
 * past it is scaled up from the documents counted so far, and one document past it gives the budget (`capped`), so a
 * multi-MB page never stalls the process.
 */
export function estimateBytes(result: unknown, budget = BYTE_BUDGET): { bytes: number; capped: boolean } {
  let used = 0, over = false
  const add = (n: number) => { used += n; if (used > budget) over = true }
  const walk = (value: unknown, inList: boolean): void => {
    if (over) return
    if (value === null) return add(4)
    switch (typeof value) {
      case 'string': return add(value.length + 2)
      case 'number': return add(Number.isFinite(value) ? String(value).length : 4)
      case 'boolean': return add(value ? 4 : 5)
      case 'bigint': return add(String(value).length)
      case 'object': break
      default: return inList ? add(4) : undefined
    }
    if (ArrayBuffer.isView(value)) return add(value.byteLength * 4)
    const toJSON = (value as { toJSON?: unknown }).toJSON
    if (typeof toJSON === 'function') return walk(toJSON.call(value), inList)
    if (Array.isArray(value)) {
      add(2 + Math.max(0, value.length - 1))
      for (let i = 0; i < value.length && !over; i++) walk(value[i], true)
      return
    }
    add(2)
    let first = true
    for (const key of Object.keys(value)) {
      const item = (value as Record<string, unknown>)[key]
      if (item === undefined || typeof item === 'function' || typeof item === 'symbol') continue
      add(key.length + 3 + (first ? 0 : 1))
      first = false
      walk(item, false)
      if (over) return
    }
  }
  if (!Array.isArray(result) || !result.length) {
    walk(result, false)
    return { bytes: used, capped: over }
  }
  const brackets = 2 + result.length - 1
  add(brackets)
  let counted = 0, countedBytes = 0
  for (; counted < result.length; counted++) {
    walk(result[counted], true)
    if (over) break
    countedBytes = used - brackets
  }
  if (!over) return { bytes: used, capped: false }
  return { bytes: counted ? Math.round(brackets + countedBytes / counted * result.length) : used, capped: true }
}

/* ---------- per-minute totals ---------- */

type Entry = { op: string; shape: string; route: string; n: number; ms: number; docs: number; errors: number; maxMs: number
  sampled: number; sampledBytes: number }

export type QueryStatsOptions = {
  /** This pod and process, on every line. */
  pod?: string
  /** Logs a query at or over this as `slow query`. */
  slowMs?: number
  slowPerWindow?: number
  /** Keys one window keeps, the overflow key included; queries past it count under `other`. */
  maxKeys?: number
  /** Measures every Nth result of a key to count its bytes, and scales up. */
  sampleEvery?: number
  /** Characters one measurement reads at most (estimateBytes). */
  byteBudget?: number
  /** How many keys of each ranking a window's line lists. */
  top?: { bytes: number; count: number; ms: number }
  log?: (message: string, context: Record<string, unknown>) => void
  warn?: (message: string, context: Record<string, unknown>) => void
}

export type QueryStats = {
  record(model: string | undefined, action: string, args: unknown, ms: number, result: unknown, failed?: boolean): void
  /** Inside a measured window (lib/measureWindows.ts) every query is counted; outside, only a slow one is warned about. */
  measure(on: boolean): void
  /** Logs the window so far and starts a new one. */
  flush(): void
}

const OTHER = 'other'

export function createQueryStats({ pod = `${hostname()}:${process.pid}`, slowMs = 200, slowPerWindow = 20, maxKeys = 1000, sampleEvery = 8, byteBudget = BYTE_BUDGET,
  top = { bytes: 20, count: 10, ms: 10 }, log = (m, c) => logger.info(m, c), warn = (m, c) => logger.warn(m, c) }: QueryStatsOptions = {}): QueryStats {
  let entries = new Map<string, Entry>()
  let overflowQueries = 0, slowLogged = 0, slowSuppressed = 0, slowQueries = 0, slowTotalMs = 0, bytesCapped = 0, started = performance.now()
  let measuring = true

  const record: QueryStats['record'] = (model, action, args, ms, result, failed = false) => {
    // Shaping every query was ~4.6% of prod's CPU; between windows only a slow one pays for its shape.
    if (!measuring && ms < slowMs) return
    const op = opName(model, action, args), shape = filterShape(action, args), route = workKind()
    if (!measuring) {
      slowQueries++
      slowTotalMs += ms
      if (slowLogged >= slowPerWindow) { slowSuppressed++; return }
      slowLogged++
      warn('slow query', { pod, op, shape, route, ms: Math.round(ms), docs: failed ? 0 : docsOf(result), bytes: 0, error: failed })
      return
    }
    let key = `${op}\0${shape}\0${route}`
    let entry = entries.get(key)
    if (!entry) {
      if (entries.size >= maxKeys - 1) {
        overflowQueries++
        key = OTHER
        entry = entries.get(OTHER)
      }
      if (!entry) {
        entry = key === OTHER ? { op: OTHER, shape: '', route: '', n: 0, ms: 0, docs: 0, errors: 0, maxMs: 0, sampled: 0, sampledBytes: 0 }
          : { op, shape, route, n: 0, ms: 0, docs: 0, errors: 0, maxMs: 0, sampled: 0, sampledBytes: 0 }
        entries.set(key, entry)
      }
    }
    entry.n++
    entry.ms += ms
    if (ms > entry.maxMs) entry.maxMs = ms
    const docs = failed ? 0 : docsOf(result)
    entry.docs += docs
    if (failed) entry.errors++
    const slow = ms >= slowMs
    let bytes: number | undefined
    if (!failed && (slow || (entry.n - 1) % sampleEvery === 0)) {
      const estimate = estimateBytes(result, byteBudget)
      bytes = estimate.bytes
      if (estimate.capped) bytesCapped++
      entry.sampled++
      entry.sampledBytes += bytes
    }
    if (!slow) return
    slowQueries++
    slowTotalMs += ms
    if (slowLogged >= slowPerWindow) { slowSuppressed++; return }
    slowLogged++
    warn('slow query', { pod, op, shape, route, ms: Math.round(ms), docs, bytes: bytes ?? 0, error: failed })
  }

  const flush = () => {
    const rows = [...entries.values()].map(e => ({ op: e.op, shape: e.shape, route: e.route, n: e.n, ms: Math.round(e.ms), docs: e.docs,
      bytes: e.sampled ? Math.round(e.sampledBytes * e.n / e.sampled) : 0, errors: e.errors, maxMs: Math.round(e.maxMs) }))
    const ranked = (by: (r: typeof rows[number]) => number, n: number) => [...rows].sort((a, b) => by(b) - by(a)).slice(0, n)
    const picked = new Set([...ranked(r => r.bytes, top.bytes), ...ranked(r => r.n, top.count), ...ranked(r => r.ms, top.ms)])
    const sum = (by: (r: typeof rows[number]) => number) => rows.reduce((total, r) => total + by(r), 0)
    // Every query of each route, small ones too: the top lists drop a cheap shape however often it runs (an empty poll's
    // read, 2026-10-31), so a route's own count would read short.
    const routes = new Map<string, { n: number; ms: number; docs: number; bytes: number; ops: Record<string, number> }>()
    for (const r of rows) {
      let total = routes.get(r.route)
      if (!total) routes.set(r.route, total = { n: 0, ms: 0, docs: 0, bytes: 0, ops: {} })
      total.n += r.n; total.ms += r.ms; total.docs += r.docs; total.bytes += r.bytes; total.ops[r.op] = (total.ops[r.op] ?? 0) + r.n
    }
    const byRoute = Object.fromEntries([...routes].sort((a, b) => b[1].ms - a[1].ms).slice(0, 40).map(([route, t]) =>
      [route, { ...t, ops: Object.fromEntries(Object.entries(t.ops).sort((a, b) => b[1] - a[1]).slice(0, 12)) }]))
    log('db by shape', { pod, windowMs: Math.round(performance.now() - started), queries: sum(r => r.n), ms: sum(r => r.ms), docs: sum(r => r.docs),
      bytes: sum(r => r.bytes), errors: sum(r => r.errors), keys: rows.length, overflowQueries, bytesCapped, slowQueries, slowMs: Math.round(slowTotalMs), slowSuppressed,
      top: [...picked].sort((a, b) => b.bytes - a.bytes || b.n - a.n), routes: byRoute })
    entries = new Map(); overflowQueries = 0; slowLogged = 0; slowSuppressed = 0; slowQueries = 0; slowTotalMs = 0; bytesCapped = 0; started = performance.now()
  }

  const reset = () => {
    entries = new Map(); overflowQueries = 0; slowLogged = 0; slowSuppressed = 0; slowQueries = 0; slowTotalMs = 0; bytesCapped = 0; started = performance.now()
  }
  // Opening a window starts it afresh: what was warned about between windows was logged as it happened.
  return { record, flush, measure: on => { if (on && !measuring) reset(); measuring = on } }
}

/* ---------- the process's own stats, fed by the Prisma hook ---------- */

let active: QueryStats | undefined

/** Starts this process's log: one measured window of `reportMs` (a minute) every `everyMs` (ten), logged as it closes,
 *  the first at once (lib/measureWindows.ts). Between windows only slow queries are warned about. Returns a stop that logs
 *  an open window. Until started, the hook only times queries. */
export function startQueryStats(options: QueryStatsOptions & { reportMs?: number; everyMs?: number } = {}): () => void {
  const stats = createQueryStats(options)
  active = stats
  const stop = measureWindows({ everyMs: options.everyMs ?? MEASURE_EVERY_MS, forMs: options.reportMs ?? MEASURE_FOR_MS,
    open: () => stats.measure(true), close: () => { stats.flush(); stats.measure(false) } })
  return () => {
    stop()
    if (active === stats) active = undefined
  }
}

/** The client with one query hook that times every operation, model calls and raw commands alike, for `db by shape`.
 *  Query extensions keep the client's types, so it is still a PrismaClient to its callers. A failure of the stats never
 *  reaches the query: it is warned about once per client, and the query's own result or error goes back unchanged. */
export function withQueryStats(client: PrismaClient, stats: () => QueryStats | undefined = () => active,
  warn: (message: string, context: Record<string, unknown>) => void = (m, c) => logger.warn(m, c)): PrismaClient {
  let warned = false
  const note = (model: string | undefined, operation: string, args: unknown, ms: number, result: unknown, failed: boolean) => {
    try {
      stats()?.record(model, operation, args, ms, result, failed)
    } catch (error) {
      if (warned) return
      warned = true
      warn('query stats failed', { error: error instanceof Error ? error.message : String(error) })
    }
  }
  return client.$extends({
    query: {
      async $allOperations({ model, operation, args, query }) {
        const started = performance.now()
        let result: unknown
        try {
          result = await query(args)
        } catch (error) {
          note(model, operation, args, performance.now() - started, undefined, true)
          throw error
        }
        note(model, operation, args, performance.now() - started, result, false)
        return result
      },
    },
  }) as unknown as PrismaClient
}
