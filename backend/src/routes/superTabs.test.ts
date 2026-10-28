import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { Prisma } from '@prisma/client'
import { errorHandler } from '../middlewares/errorHandler.js'
import { SuperTabError } from '../superTabs/model.js'
import { HOT_BODY_LIMIT, superTabRoutes } from './superTabs.js'

describe('Super Tab route failures', () => {
  let app: FastifyInstance
  let thrown: unknown
  beforeEach(async () => {
    app = Fastify()
    app.setErrorHandler(errorHandler)
    app.addHook('onRequest', async request => { request.user = { sub: 'u1', email: 'u1@example.com', autonomousEnv: 'prod', role: 'user' } as never })
    const store = { hostGrids: async () => { throw thrown }, native: { append: async () => { throw thrown } } }
    await app.register(superTabRoutes, { store: store as never, github: null, reads: {} as never, hosts: {} as never })
    await app.ready()
  })
  afterEach(async () => { await app.close() })

  it('answers a busy Swarm with Retry-After', async () => {
    thrown = new SuperTabError('SWARM_BUSY', 'This Swarm is busy. Try again in a moment.', 503)
    const res = await app.inject({ method: 'GET', url: '/api/super-tabs/grids' })
    expect(res.statusCode).toBe(503)
    expect(res.headers['retry-after']).toBe('2')
    expect(res.json().error.code).toBe('SWARM_BUSY')
  })

  it('answers a refusal with its own status and no Retry-After', async () => {
    thrown = new SuperTabError('FORBIDDEN', 'Not yours.', 403)
    const res = await app.inject({ method: 'GET', url: '/api/super-tabs/grids' })
    expect(res.statusCode).toBe(403)
    expect(res.headers['retry-after']).toBeUndefined()
  })

  it('answers an expired transaction as a retryable 503, not 500', async () => {
    thrown = new Prisma.PrismaClientKnownRequestError('Transaction API error: Transaction already closed', { code: 'P2028', clientVersion: 'test' })
    const res = await app.inject({ method: 'GET', url: '/api/super-tabs/grids' })
    expect(res.statusCode).toBe(503)
    expect(res.headers['retry-after']).toBe('2')
  })

  it('answers a terminal recording\'s duplicate key as busy, so the host keeps recording and retries', async () => {
    // The host stops a recording for good on a 409 (cli superTabs/native.ts); a duplicate that outlived every retry is
    // not the recording's fault.
    thrown = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: 'test' })
    const res = await app.inject({ method: 'POST', url: '/api/super-tabs/tab-1/native/ctx-1', payload: { turnId: 'turn-1', kind: 'prompt', previousEventId: null, text: 'hi', truncated: false, interrupted: false } })
    expect(res.statusCode).toBe(503)
    expect(res.headers['retry-after']).toBe('2')
    expect(res.json().error.code).toBe('SWARM_BUSY')
  })
})

describe('Super Tab body limits (roadmap 2.8)', () => {
  let app: FastifyInstance
  let reached: string[]
  beforeEach(async () => {
    reached = []
    app = Fastify()
    app.setErrorHandler(errorHandler)
    app.addHook('onRequest', async request => { request.user = { sub: 'u1', email: 'u1@example.com', autonomousEnv: 'prod', role: 'user' } as never })
    const handled = (name: string) => async () => { reached.push(name); return {} }
    const store = { native: { append: handled('native'), open: handled('open') }, delivery: handled('delivery'), stopped: handled('stopped') }
    await app.register(superTabRoutes, { store: store as never, github: null, reads: {} as never, hosts: { changes: handled('changes') } as never })
    await app.ready()
  })
  afterEach(async () => { await app.close() })

  const id = (n: number, size = 160) => `${String(n).padStart(6, '0')}${'a'.repeat(size - 6)}`
  /** Free text at its longest in characters, each the widest a person types: three UTF-8 bytes ('ệ'). */
  const text = (length: number) => 'ệ'.repeat(length)
  /** The largest body each hot route accepts, from its schema's limits. */
  const largest = {
    changes: { url: '/api/super-tabs/hosts/m1/changes', name: 'changes',
      body: { cursor: 'c'.repeat(512), full: false, held: Object.fromEntries(Array.from({ length: 500 }, (_, n) => [id(n), 'e'.repeat(64)])) } },
    native: { url: '/api/super-tabs/tab-1/native/ctx-1', name: 'native',
      body: { turnId: id(3), kind: 'answer', previousEventId: id(4), text: text(16_000), truncated: false, interrupted: false } },
    delivery: { url: '/api/super-tabs/tab-1/agents/agent-1/deliveries/delivery-1', name: 'delivery',
      body: { type: 'ack', claimId: id(4), receipt: text(2000), uncertain: false } },
    stopped: { url: '/api/super-tabs/tab-1/stopped', name: 'stopped', body: { assignmentId: id(2), receipt: text(2000) } },
  }
  const post = (url: string, payload: string) => app.inject({ method: 'POST', url, payload, headers: { 'content-type': 'application/json' } })

  for (const [route, { url, name, body }] of Object.entries(largest)) {
    it(`takes the largest valid ${route} body and refuses one past the limit`, async () => {
      const json = JSON.stringify(body)
      expect((await post(url, json)).statusCode).toBe(200)
      expect(reached).toEqual([name])
      const over = await post(url, `${json}${' '.repeat(HOT_BODY_LIMIT + 1 - Buffer.byteLength(json))}`)
      expect(over.statusCode).toBe(413)
      expect(reached).toEqual([name])
    })
  }

  it('keeps the limit within the largest valid hot body with room for growth: under twice it', () => {
    const sizes = Object.values(largest).map(r => Buffer.byteLength(JSON.stringify(r.body)))
    expect(Math.max(...sizes)).toBeLessThan(HOT_BODY_LIMIT)
    expect(HOT_BODY_LIMIT).toBeLessThan(2 * Math.max(...sizes))
  })
})
