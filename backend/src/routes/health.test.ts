import Fastify from 'fastify'
import { afterEach, expect, it, vi } from 'vitest'
import { healthRoutes } from './health.js'

afterEach(() => vi.unstubAllEnvs())
it.each([
  ['v1.2.72_backend', 'a'.repeat(40), { version: 'v1.2.72_backend', sha: 'a'.repeat(40) }],
  ['', '', null],
  ['PRIVATE_CANARY', 'a'.repeat(40), null],
  ['v1.2.72_backend', 'PRIVATE_CANARY', null],
])('exposes only validated public build coordinates', async (tag, sha, build) => {
  vi.stubEnv('BUILD_TAG', tag); vi.stubEnv('BUILD_SHA', sha)
  const app = Fastify({ logger: false })
  try {
    await app.register(healthRoutes)
    const response = await app.inject('/api/health')
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ success: true, data: { status: 'ok', build } })
    expect(response.body).not.toContain('PRIVATE_CANARY')
  } finally { await app.close() }
})
