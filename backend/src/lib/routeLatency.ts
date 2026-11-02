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

type Window = { n: number; max: number; samples: number[]; clients: Record<string, number> }

/** Who sent a request, from what every client sends anyway (2026-10-31: who reads Swarm messages so often was unknown):
 *  the web build's browser, the Desktop and phone apps' Dart client, the CLI daemon's Node client, and a read as an agent
 *  (`asAgentId`), which only the CLI sends. Never the user agent itself, nor the agent. */
export type ClientKind = 'web' | 'app' | 'cli' | 'agent' | 'other'
export function clientKind(userAgent: string | undefined, asAgent: boolean): ClientKind {
  if (asAgent) return 'agent'
  if (!userAgent) return 'other'
  if (/^Mozilla\//.test(userAgent)) return 'web'
  if (/^Dart\//.test(userAgent)) return 'app'
  if (/^(node|undici)\b/.test(userAgent)) return 'cli'
  return 'other'
}

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

export type RouteLatency = { record(route: string, ms: number, client?: ClientKind): void; flush(): void }

const OTHER = 'other'

/** Nearest-rank percentile of sorted values. */
const percentile = (sorted: number[], p: number) => sorted[Math.max(0, Math.ceil(p / 100 * sorted.length) - 1)] ?? 0
const round = (ms: number) => Math.round(ms * 10) / 10

export function createRouteLatency({ pod = `${hostname()}:${process.pid}`, maxSamples = 2000, maxRoutes = 200, top = 40, random = Math.random,
  log = (m, c) => logger.info(m, c) }: RouteLatencyOptions = {}): RouteLatency {
  let routes = new Map<string, Window>(), started = performance.now()

  const record = (route: string, ms: number, client?: ClientKind) => {
    let window = routes.get(route)
    if (!window) {
      const key = routes.size >= maxRoutes - 1 ? OTHER : route
      window = routes.get(key)
      if (!window) routes.set(key, window = { n: 0, max: 0, samples: [], clients: {} })
    }
    window.n++
    if (client) window.clients[client] = (window.clients[client] ?? 0) + 1
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
      return { route, totalMs: mean * w.n, stats: { n: w.n, p50: round(percentile(sorted, 50)), p95: round(percentile(sorted, 95)), max: round(w.max),
        ...(Object.keys(w.clients).length ? { clients: w.clients } : {}) } }
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
    const asAgent = typeof (request.query as Record<string, unknown> | undefined)?.asAgentId === 'string'
    latency.record(`${request.method} ${request.routeOptions.url ?? 'unrouted'}`, reply.elapsedTime, clientKind(request.headers['user-agent'], asAgent))
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
