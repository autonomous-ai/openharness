import Fastify from 'fastify'
import { describe, expect, it, vi } from 'vitest'
import type { AddressInfo } from 'node:net'
import { createMetrics, metricsAddress, registerRequestMetrics, startMetricsServer, timeQuery } from './metrics.js'

async function appWithMetrics() {
  const metrics = createMetrics()
  const app = Fastify()
  registerRequestMetrics(app, metrics)
  app.get('/api/things/:id', async () => ({ ok: true }))
  app.get('/api/broken', async () => { throw new Error('boom') })
  await app.ready()
  return { app, metrics }
}

/** The `_count` sample lines of the request histogram, which name every label set seen. */
async function requestCounts(metrics: ReturnType<typeof createMetrics>) {
  return (await metrics.registry.metrics()).split('\n').filter(line => line.startsWith('http_request_duration_seconds_count'))
}

describe('request latency', () => {
  it('records the route pattern and status, never the id or query from the URL', async () => {
    const { app, metrics } = await appWithMetrics()
    await app.inject({ method: 'GET', url: '/api/things/6a730145e13f6277cdf98c1a?token=secret-value' })
    await app.inject({ method: 'GET', url: '/api/things/other' })
    expect(await requestCounts(metrics)).toEqual([
      'http_request_duration_seconds_count{method="GET",route="/api/things/:id",status_code="200"} 2',
    ])
    const text = await metrics.registry.metrics()
    expect(text).not.toContain('6a730145e13f6277cdf98c1a')
    expect(text).not.toContain('secret-value')
    await app.close()
  })

  it('records a URL that matches no route as "unmatched", so scanners cannot grow the label set', async () => {
    const { app, metrics } = await appWithMetrics()
    await app.inject({ method: 'GET', url: '/wp-admin/install.php' })
    expect(await requestCounts(metrics)).toEqual([
      'http_request_duration_seconds_count{method="GET",route="unmatched",status_code="404"} 1',
    ])
    await app.close()
  })

  it('records a route that throws as a 500', async () => {
    const { app, metrics } = await appWithMetrics()
    await app.inject({ method: 'GET', url: '/api/broken' })
    expect(await requestCounts(metrics)).toEqual([
      'http_request_duration_seconds_count{method="GET",route="/api/broken",status_code="500"} 1',
    ])
    await app.close()
  })
})

describe('process metrics', () => {
  it('reports event-loop delay and GC pauses', async () => {
    const { registry } = createMetrics()
    const text = await registry.metrics()
    expect(text).toContain('nodejs_eventloop_lag_p99_seconds')
    expect(text).toContain('# TYPE nodejs_gc_duration_seconds histogram')
  })
})

describe('database query timing', () => {
  /** A clock that reads `start` when the query begins and `start + tookMs` when it settles. */
  const clock = (tookMs: number) => { const reads = [1_000, 1_000 + tookMs]; return () => reads.shift()! }
  const sink = () => {
    const lines: { message: string; context?: Record<string, unknown> }[] = []
    return { lines, warn: (message: string, context?: Record<string, unknown>) => { lines.push({ message, context }) } }
  }
  const findByEmail = { model: 'User', operation: 'findFirst', args: { where: { email: 'person@example.com' } } }

  async function queryCounts(metrics: ReturnType<typeof createMetrics>) {
    return (await metrics.registry.metrics()).split('\n').filter(line => line.startsWith('prisma_query_duration_seconds_count'))
  }

  it('logs a query over 100 ms with its model, operation and duration, and nothing from its arguments', async () => {
    const metrics = createMetrics()
    const log = sink()
    const result = await timeQuery(metrics, { ...findByEmail, query: async () => ({ id: 'u1' }) }, { now: clock(150), log })
    expect(result).toEqual({ id: 'u1' })
    expect(log.lines).toEqual([{ message: 'Slow database query', context: { model: 'User', operation: 'findFirst', durationMs: 150 } }])
    expect(JSON.stringify(log.lines)).not.toContain('person@example.com')
    expect(await queryCounts(metrics)).toEqual(['prisma_query_duration_seconds_count{model="User",operation="findFirst"} 1'])
  })

  it('does not log a query of 100 ms or less, but still times it', async () => {
    const metrics = createMetrics()
    const log = sink()
    await timeQuery(metrics, { ...findByEmail, query: async () => null }, { now: clock(100), log })
    expect(log.lines).toEqual([])
    expect(await queryCounts(metrics)).toEqual(['prisma_query_duration_seconds_count{model="User",operation="findFirst"} 1'])
  })

  it('times a failed query and passes its error on unchanged', async () => {
    const metrics = createMetrics()
    const log = sink()
    const failure = new Error('write conflict')
    await expect(timeQuery(metrics, { ...findByEmail, query: async () => { throw failure } }, { now: clock(250), log })).rejects.toBe(failure)
    expect(log.lines).toEqual([{ message: 'Slow database query', context: { model: 'User', operation: 'findFirst', durationMs: 250 } }])
    expect(await queryCounts(metrics)).toEqual(['prisma_query_duration_seconds_count{model="User",operation="findFirst"} 1'])
  })

  it('labels a raw command, which has no model, as "raw"', async () => {
    const metrics = createMetrics()
    await timeQuery(metrics, { operation: '$runCommandRaw', args: { ping: 1 }, query: async () => ({ ok: 1 }) }, { now: clock(3), log: sink() })
    expect(await queryCounts(metrics)).toEqual(['prisma_query_duration_seconds_count{model="raw",operation="$runCommandRaw"} 1'])
  })
})

describe('metrics listener', () => {
  it('is off unless a port is set, and gives each pm2 worker its own port on loopback by default', () => {
    expect(metricsAddress({}, 0)).toBeUndefined()
    expect(metricsAddress({ portBase: 9464 }, 0)).toEqual({ port: 9464, host: '127.0.0.1' })
    expect(metricsAddress({ portBase: 9464 }, 3)).toEqual({ port: 9467, host: '127.0.0.1' })
    expect(metricsAddress({ portBase: 9464, host: '0.0.0.0' }, 0)).toEqual({ port: 9464, host: '0.0.0.0' })
  })

  it('serves the registry at GET /metrics and nothing else', async () => {
    const metrics = createMetrics()
    const server = startMetricsServer(metrics.registry, { port: 0, host: '127.0.0.1' })
    await new Promise(resolve => server.once('listening', resolve))
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    try {
      const scrape = await fetch(`${base}/metrics`)
      expect(scrape.status).toBe(200)
      expect(scrape.headers.get('content-type')).toBe('text/plain; version=0.0.4; charset=utf-8')
      expect(await scrape.text()).toContain('# TYPE http_request_duration_seconds histogram')
      expect((await fetch(`${base}/api/health`)).status).toBe(404)
      expect((await fetch(`${base}/metrics`, { method: 'POST' })).status).toBe(404)
    } finally {
      await new Promise(resolve => server.close(resolve))
    }
  })

  it('logs a port already in use instead of crashing the API', async () => {
    const metrics = createMetrics()
    const first = startMetricsServer(metrics.registry, { port: 0, host: '127.0.0.1' })
    await new Promise(resolve => first.once('listening', resolve))
    const lines: string[] = []
    vi.spyOn(console, 'error').mockImplementation((line: unknown) => { lines.push(String(line)) })
    const second = startMetricsServer(metrics.registry, { port: (first.address() as AddressInfo).port, host: '127.0.0.1' })
    await new Promise(resolve => setTimeout(resolve, 50))
    vi.restoreAllMocks()
    expect(second.listening).toBe(false)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('metrics listener failed')
    expect(lines[0]).toContain('EADDRINUSE')
    await new Promise(resolve => first.close(resolve))
  })
})
