import Fastify from 'fastify'
import { expect, it } from 'vitest'
import { createRouteLatency, registerRouteLatency } from './routeLatency.js'

type Logged = { message: string; context: Record<string, unknown> }
type Route = { n: number; p50: number; p95: number; max: number }

function latency(options: Parameters<typeof createRouteLatency>[0] = {}) {
  const logs: Logged[] = []
  const l = createRouteLatency({ pod: 'pod-1', log: (message, context) => logs.push({ message, context }), ...options })
  return { l, logs, routes: (i = 0) => logs[i]!.context.routes as Record<string, Route> }
}

it('logs each route p50 and p95 for the window, then starts a new one', () => {
  const { l, logs, routes } = latency()
  for (let ms = 1; ms <= 100; ms++) l.record('GET /api/items/:id', ms)
  l.record('POST /api/items', 7)
  l.flush()
  expect(logs[0]!.message).toBe('route latency')
  expect(logs[0]!.context).toMatchObject({ pod: 'pod-1', requests: 101 })
  expect(routes()).toEqual({ 'GET /api/items/:id': { n: 100, p50: 50, p95: 95, max: 100 }, 'POST /api/items': { n: 1, p50: 7, p95: 7, max: 7 } })
  l.flush()
  expect(logs[1]!.context).toMatchObject({ requests: 0, routes: {} })
})

it('keeps a bounded sample per route but counts every request', () => {
  const { l, routes } = latency({ maxSamples: 10, random: () => 0.99 })
  for (let i = 0; i < 1000; i++) l.record('GET /api/x', i < 10 ? 3 : 900)
  l.flush()
  // A random draw of 0.99 never replaces one of the first 10 samples: the percentiles come from them, the max from all.
  expect(routes()['GET /api/x']).toEqual({ n: 1000, p50: 3, p95: 3, max: 900 })
})

it('keeps a bounded number of routes and counts the rest under other', () => {
  const { l, routes } = latency({ maxRoutes: 2 })
  for (const route of ['GET /a', 'GET /b', 'GET /c', 'GET /d']) l.record(route, 1)
  l.flush()
  expect(routes()).toEqual({ 'GET /a': { n: 1, p50: 1, p95: 1, max: 1 }, other: { n: 3, p50: 1, p95: 1, max: 1 } })
})

it('lists the routes that took the most time first, up to top', () => {
  const { l, routes } = latency({ top: 2 })
  l.record('GET /rare-slow', 500)
  for (let i = 0; i < 100; i++) l.record('GET /often-fast', 10)
  l.record('GET /rare-fast', 1)
  l.flush()
  expect(Object.keys(routes())).toEqual(['GET /often-fast', 'GET /rare-slow'])
})

it('names each request by its route pattern, never its URL', async () => {
  const app = Fastify()
  const logs: Logged[] = []
  const l = registerRouteLatency(app, { pod: 'pod-1', log: (message, context) => logs.push({ message, context }) })
  app.get('/api/items/:id', async () => ({ ok: true }))
  for (const id of ['alice-secret-1', 'bob-2']) await app.inject({ method: 'GET', url: `/api/items/${id}?token=hunter2` })
  await app.inject({ method: 'GET', url: '/nowhere' })
  l.flush()
  const routes = logs[0]!.context.routes as Record<string, Route>
  expect(Object.keys(routes).sort()).toEqual(['GET /api/items/:id', 'GET unrouted'])
  expect(routes['GET /api/items/:id']!.n).toBe(2)
  expect(routes['GET /api/items/:id']!.p95).toBeGreaterThanOrEqual(0)
  expect(JSON.stringify(logs)).not.toMatch(/alice|bob|hunter2|nowhere/)
  await app.close()
})

it('counts each route by kind of client, from its user agent and whether it reads as an agent, never the agent itself', async () => {
  const app = Fastify()
  const logs: Logged[] = []
  const l = registerRouteLatency(app, { pod: 'pod-1', log: (message, context) => logs.push({ message, context }) })
  app.get('/api/items', async () => ({ ok: true }))
  const as = (ua: string, url = '/api/items') => app.inject({ method: 'GET', url, headers: { 'user-agent': ua } })
  await as('Mozilla/5.0 (Macintosh) Chrome/130')
  await as('Dart/3.5 (dart:io)')
  await as('Dart/3.5 (dart:io)')
  await as('node')
  await as('undici', '/api/items?asAgentId=agent-secret-7')
  await as('curl/8.4')
  l.flush()
  expect((logs[0]!.context.routes as Record<string, { clients: Record<string, number> }>)['GET /api/items']!.clients)
    .toEqual({ web: 1, app: 2, cli: 1, agent: 1, other: 1 })
  expect(JSON.stringify(logs)).not.toMatch(/agent-secret|curl|Chrome/)
  await app.close()
})
