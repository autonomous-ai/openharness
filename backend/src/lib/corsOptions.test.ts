import { afterEach, describe, expect, it } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import cors from '@fastify/cors'
import { CORS_OPTIONS } from './corsOptions.js'

// The web signs every Swarm call with an Authorization header, so a browser asks first (a preflight) before each one
// unless it may keep the answer (docs/specs/2026-10-30-web-swarm-direct.md, Scale).
describe('CORS', () => {
  let app: FastifyInstance
  afterEach(async () => { await app?.close() })

  it('lets a browser keep a preflight\'s answer for ten minutes, and still reflects only the asking origin', async () => {
    app = Fastify()
    await app.register(cors, CORS_OPTIONS)
    app.post('/api/super-tabs/:tabId/commands', async () => ({ ok: true }))
    await app.ready()
    const res = await app.inject({ method: 'OPTIONS', url: '/api/super-tabs/tab-1/commands', headers: {
      origin: 'https://harness.example', 'access-control-request-method': 'POST',
      'access-control-request-headers': 'authorization,content-type,x-autonomous-env' } })
    expect(res.statusCode).toBe(204)
    expect(res.headers['access-control-max-age']).toBe('600')
    expect(res.headers['access-control-allow-origin']).toBe('https://harness.example')
    expect(res.headers['access-control-allow-headers']).toBe('authorization,content-type,x-autonomous-env')
  })
})
