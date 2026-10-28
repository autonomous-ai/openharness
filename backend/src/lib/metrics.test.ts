import Fastify from 'fastify'
import { describe, expect, it } from 'vitest'
import { createMetrics, registerRequestMetrics } from './metrics.js'

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
