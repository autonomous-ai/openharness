import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { Prisma } from '@prisma/client'
import { errorHandler } from '../middlewares/errorHandler.js'
import { SuperTabError } from '../superTabs/model.js'
import { superTabRoutes } from './superTabs.js'

describe('Super Tab route failures', () => {
  let app: FastifyInstance
  let thrown: unknown
  beforeEach(async () => {
    app = Fastify()
    app.setErrorHandler(errorHandler)
    app.addHook('onRequest', async request => { request.user = { sub: 'u1', email: 'u1@example.com', autonomousEnv: 'prod', role: 'user' } as never })
    const store = { hostGrids: async () => { throw thrown } }
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
})
