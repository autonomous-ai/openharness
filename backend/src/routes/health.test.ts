import Fastify from 'fastify'
import { afterEach, expect, it, vi } from 'vitest'
import { createDrain, createReadiness, type DependencyCheck } from '../lib/readiness.js'
import { registerAuthMiddleware } from '../middlewares/authMiddleware.js'
import { healthRoutes } from './health.js'

afterEach(() => vi.unstubAllEnvs())

async function serve(checks: Record<string, DependencyCheck>, drain = createDrain()) {
  const app = Fastify({ logger: false })
  // The real sign-in gate: probes carry no token. It must never be asked to authenticate one.
  registerAuthMiddleware(app, async () => { throw new Error('a probe must not need a sign-in') })
  await app.register(healthRoutes, { readiness: createReadiness(checks, { drain }) })
  return app
}

it.each([
  ['v1.2.72_backend', 'a'.repeat(40), { version: 'v1.2.72_backend', sha: 'a'.repeat(40) }],
  ['', '', null],
  ['PRIVATE_CANARY', 'a'.repeat(40), null],
  ['v1.2.72_backend', 'PRIVATE_CANARY', null],
])('exposes only validated public build coordinates', async (tag, sha, build) => {
  vi.stubEnv('BUILD_TAG', tag); vi.stubEnv('BUILD_SHA', sha)
  const app = await serve({ mongo: async () => 1 })
  try {
    const response = await app.inject('/api/health')
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ success: true, data: { status: 'ok', build } })
    expect(response.body).not.toContain('PRIVATE_CANARY')
  } finally { await app.close() }
})

it('keeps liveness up while dependencies are down and the process drains, so nothing restarts it for that', async () => {
  const mongo = vi.fn(async () => { throw new Error('down') })
  const drain = createDrain()
  const app = await serve({ mongo }, drain)
  try {
    drain.start()
    const response = await app.inject('/api/health')
    expect(response.statusCode).toBe(200)
    expect(response.json().data.status).toBe('ok')
    expect(mongo).not.toHaveBeenCalled()
  } finally { await app.close() }
})

it('is ready without a sign-in when Mongo and Redis answer', async () => {
  const app = await serve({ mongo: async () => 1, redis: async () => 'PONG' })
  try {
    const response = await app.inject('/api/ready')
    expect(response.statusCode).toBe(200)
    expect(response.headers['cache-control']).toBe('no-store')
    expect(response.json()).toEqual({ success: true, data: { status: 'ready', checks: { mongo: 'ok', redis: 'ok' } } })
  } finally { await app.close() }
})

it('answers 503 naming the failed dependency, without its error text', async () => {
  const app = await serve({
    mongo: async () => 1,
    redis: async () => { throw new Error('NOAUTH redis://:PRIVATE_CANARY@10.0.0.9:6379') },
  })
  try {
    const response = await app.inject('/api/ready')
    expect(response.statusCode).toBe(503)
    expect(response.json()).toEqual({ success: false, data: { status: 'not_ready', checks: { mongo: 'ok', redis: 'failed' } } })
    expect(response.body).not.toContain('PRIVATE_CANARY')
  } finally { await app.close() }
})

it('answers 503 draining once shutdown starts, though the dependencies are fine', async () => {
  const drain = createDrain()
  const app = await serve({ mongo: async () => 1, redis: async () => 'PONG' }, drain)
  try {
    expect((await app.inject('/api/ready')).statusCode).toBe(200)
    drain.start()
    const response = await app.inject('/api/ready')
    expect(response.statusCode).toBe(503)
    expect(response.json()).toEqual({ success: false, data: { status: 'draining', checks: {} } })
  } finally { await app.close() }
})
