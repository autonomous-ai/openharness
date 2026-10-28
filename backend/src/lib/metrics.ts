import type { PrismaClient } from '@prisma/client'
import type { FastifyInstance } from 'fastify'
import http from 'node:http'
import { collectDefaultMetrics, Histogram, Registry } from 'prom-client'
import { logger } from '../utils/logger.js'

/**
 * Prometheus metrics for this process. Node's defaults bring event-loop delay (perf_hooks
 * monitorEventLoopDelay, as nodejs_eventloop_lag_*) and GC pauses (a PerformanceObserver on 'gc', as
 * nodejs_gc_duration_seconds) along with heap, handles and CPU.
 *
 * Labels stay small and bounded: a method, a route PATTERN, a status code, a Prisma model and
 * operation. Never a raw URL, a tab, person or machine id — each would be a new series per value.
 */
export function createMetrics() {
  const registry = new Registry()
  collectDefaultMetrics({ register: registry })
  const httpDuration = new Histogram({
    name: 'http_request_duration_seconds',
    help: 'Control API request duration, by route pattern and status',
    labelNames: ['method', 'route', 'status_code'] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [registry],
  })
  const queryDuration = new Histogram({
    name: 'prisma_query_duration_seconds',
    help: 'Database query duration through Prisma, by model and operation',
    labelNames: ['model', 'operation'] as const,
    buckets: [0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
    registers: [registry],
  })
  return { registry, httpDuration, queryDuration }
}

export type Metrics = ReturnType<typeof createMetrics>

/** This process's metrics, served by startMetricsServer. */
export const metrics = createMetrics()

/** A request that matched no route has no pattern; its URL is whatever a scanner sent, so it is one label. */
const UNMATCHED = 'unmatched'

/** Logged at WARN with its model, operation and duration; never its arguments, which carry user data. */
export const SLOW_QUERY_MS = 100

export interface QueryCall {
  model?: string
  operation: string
  args: unknown
  query: (args: any) => Promise<unknown>
}

interface QueryTimingOptions {
  now?: () => number
  log?: { warn(message: string, context?: Record<string, unknown>): void }
}

/** One Prisma operation, timed whether it succeeds or throws. The `$allOperations` hook of withQueryTiming. */
export async function timeQuery(metrics: Metrics, call: QueryCall, { now = () => performance.now(), log = logger }: QueryTimingOptions = {}): Promise<unknown> {
  const started = now()
  try {
    return await call.query(call.args)
  } finally {
    const durationMs = now() - started
    const model = call.model ?? 'raw'
    metrics.queryDuration.observe({ model, operation: call.operation }, durationMs / 1000)
    if (durationMs > SLOW_QUERY_MS) log.warn('Slow database query', { model, operation: call.operation, durationMs: Math.round(durationMs) })
  }
}

/**
 * The client with every operation timed: model queries, raw commands, and those inside an interactive
 * transaction. Typed as a plain PrismaClient so it still passes wherever one is taken; a query-only
 * extension changes no method. The one exception is `$on`/`$use`, which an extended client no longer has.
 */
export function withQueryTiming(client: PrismaClient, metrics: Metrics): PrismaClient {
  return client.$extends({ query: { $allOperations: (call) => timeQuery(metrics, call) } }) as unknown as PrismaClient
}

export function registerRequestMetrics(app: FastifyInstance, metrics: Metrics): void {
  app.addHook('onResponse', async (request, reply) => {
    metrics.httpDuration.observe(
      { method: request.method, route: request.routeOptions.url ?? UNMATCHED, status_code: String(reply.statusCode) },
      reply.elapsedTime / 1000,
    )
  })
}

/**
 * Where this worker serves /metrics: off unless a port is set; each pm2 worker binds base + its index (as
 * the mesh port does); loopback unless the deploy says otherwise. Never the public control port.
 */
export function metricsAddress({ portBase, host = '127.0.0.1' }: { portBase?: number; host?: string }, workerIndex: number) {
  return portBase === undefined ? undefined : { port: portBase + workerIndex, host }
}

/** A listener of its own for the scraper: GET /metrics, and 404 for everything else. */
export function startMetricsServer(registry: Registry, { port, host }: { port: number; host: string }): http.Server {
  const server = http.createServer((req, res) => {
    if (req.method !== 'GET' || (req.url ?? '').split('?')[0] !== '/metrics') {
      res.writeHead(404).end()
      return
    }
    registry.metrics().then(
      (text) => { res.writeHead(200, { 'Content-Type': registry.contentType }).end(text) },
      (err) => { logger.error('metrics scrape failed', err); res.writeHead(500).end() },
    )
  })
  server.listen(port, host, () => {
    logger.info(`backend metrics listener on ${host}:${(server.address() as { port: number }).port}`)
  })
  return server
}
