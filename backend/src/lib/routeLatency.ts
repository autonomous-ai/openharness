import { hostname } from 'node:os'
import { performance } from 'node:perf_hooks'
import type { FastifyInstance } from 'fastify'
import { logger } from '../utils/logger.js'

/**
 * Per-route latency (DB roadmap Phase 1): every minute, `route latency` logs each HTTP route's request count, p50, p95 and
 * max in ms, routes that took the most time first. Same cadence as `cpu by kind` (lib/selfProfile.ts), but always on. A
 * route is its pattern (`GET /api/items/:id`), never its URL. Each route keeps a bounded random sample (reservoir) for its
 * percentiles; its count and max cover every request.
 */

type Window = { n: number; max: number; samples: number[] }

export type RouteLatencyOptions = {
  pod?: string
  /** Samples one route keeps per window. */
  maxSamples?: number
  /** Routes one window keeps, `other` included. */
  maxRoutes?: number
  /** Routes one line lists. */
  top?: number
  random?: () => number
  log?: (message: string, context: Record<string, unknown>) => void
}

export type RouteLatency = { record(route: string, ms: number): void; flush(): void }

const OTHER = 'other'

/** Nearest-rank percentile of sorted values. */
const percentile = (sorted: number[], p: number) => sorted[Math.max(0, Math.ceil(p / 100 * sorted.length) - 1)] ?? 0
const round = (ms: number) => Math.round(ms * 10) / 10

export function createRouteLatency({ pod = `${hostname()}:${process.pid}`, maxSamples = 2000, maxRoutes = 200, top = 40, random = Math.random,
  log = (m, c) => logger.info(m, c) }: RouteLatencyOptions = {}): RouteLatency {
  let routes = new Map<string, Window>(), started = performance.now()

  const record = (route: string, ms: number) => {
    let window = routes.get(route)
    if (!window) {
      const key = routes.size >= maxRoutes - 1 ? OTHER : route
      window = routes.get(key)
      if (!window) routes.set(key, window = { n: 0, max: 0, samples: [] })
    }
    window.n++
    if (ms > window.max) window.max = ms
    if (window.samples.length < maxSamples) window.samples.push(ms)
    else {
      const slot = Math.floor(random() * window.n)
      if (slot < maxSamples) window.samples[slot] = ms
    }
  }

  const flush = () => {
    const rows = [...routes].map(([route, w]) => {
      const sorted = w.samples.sort((a, b) => a - b)
      const mean = sorted.reduce((total, ms) => total + ms, 0) / (sorted.length || 1)
      return { route, totalMs: mean * w.n, stats: { n: w.n, p50: round(percentile(sorted, 50)), p95: round(percentile(sorted, 95)), max: round(w.max) } }
    }).sort((a, b) => b.totalMs - a.totalMs).slice(0, top)
    log('route latency', { pod, windowMs: Math.round(performance.now() - started), requests: [...routes.values()].reduce((total, w) => total + w.n, 0),
      routes: Object.fromEntries(rows.map(r => [r.route, r.stats])) })
    routes = new Map(); started = performance.now()
  }

  return { record, flush }
}

/** Records every response's time under its route pattern. Returns the recorder, for a flush on shutdown. */
export function registerRouteLatency(app: FastifyInstance, options: RouteLatencyOptions = {}): RouteLatency {
  const latency = createRouteLatency(options)
  app.addHook('onResponse', (request, reply, done) => {
    latency.record(`${request.method} ${request.routeOptions.url ?? 'unrouted'}`, reply.elapsedTime)
    done()
  })
  return latency
}

/** Starts the per-minute line on a recorder. Returns a stop that logs the last partial window. */
export function startRouteLatency(latency: RouteLatency, reportMs = 60_000): () => void {
  const timer = setInterval(() => latency.flush(), reportMs)
  timer.unref()
  return () => { clearInterval(timer); latency.flush() }
}
