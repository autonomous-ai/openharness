import type { FastifyInstance } from 'fastify'
import { collectDefaultMetrics, Histogram, Registry } from 'prom-client'

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
  return { registry, httpDuration }
}

export type Metrics = ReturnType<typeof createMetrics>

/** A request that matched no route has no pattern; its URL is whatever a scanner sent, so it is one label. */
const UNMATCHED = 'unmatched'

export function registerRequestMetrics(app: FastifyInstance, metrics: Metrics): void {
  app.addHook('onResponse', async (request, reply) => {
    metrics.httpDuration.observe(
      { method: request.method, route: request.routeOptions.url ?? UNMATCHED, status_code: String(reply.statusCode) },
      reply.elapsedTime / 1000,
    )
  })
}
