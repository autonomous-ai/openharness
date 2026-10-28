import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { Prisma } from '@prisma/client'
import { errorHandler } from './errorHandler.js'
import { SuperTabError } from '../superTabs/model.js'
import { logger } from '../utils/logger.js'

const prismaError = (code: string, message: string) => new Prisma.PrismaClientKnownRequestError(message, { code, clientVersion: 'test' })

describe('the shared error handler', () => {
  let app: FastifyInstance
  let thrown: unknown
  beforeEach(async () => {
    app = Fastify()
    app.setErrorHandler(errorHandler)
    app.get('/fails', async () => { throw thrown })
    await app.ready()
  })
  afterEach(async () => { await app.close(); vi.restoreAllMocks() })

  it('answers a busy Swarm thrown outside the Super Tab routes as 503 with Retry-After, not 500', async () => {
    // The harness-shares list checks each share through the Swarm store (2026-10-28 prod: ten 500s).
    thrown = new SuperTabError('SWARM_BUSY', 'This Swarm is busy. Try again in a moment.', 503)
    const res = await app.inject({ method: 'GET', url: '/fails' })
    expect(res.statusCode).toBe(503)
    expect(res.headers['retry-after']).toBe('2')
    expect(res.json()).toEqual({ success: false, error: { code: 'SWARM_BUSY', message: 'This Swarm is busy. Try again in a moment.' } })
  })

  it('answers any other Swarm refusal with its own status', async () => {
    thrown = new SuperTabError('FORBIDDEN', 'Not yours.', 403)
    const res = await app.inject({ method: 'GET', url: '/fails' })
    expect(res.statusCode).toBe(403)
    expect(res.headers['retry-after']).toBeUndefined()
    expect(res.json().error.code).toBe('FORBIDDEN')
  })

  it('answers an expired or unstartable database transaction as a retryable 503', async () => {
    for (const message of ['Transaction API error: Transaction already closed: A query cannot be executed on an expired transaction. The timeout for this transaction was 15000 ms, however 15412 ms passed since the start of the transaction.',
      'Transaction API error: Unable to start a transaction in the given time.']) {
      thrown = prismaError('P2028', message)
      const res = await app.inject({ method: 'GET', url: '/fails' })
      expect(res.statusCode).toBe(503)
      expect(res.headers['retry-after']).toBe('2')
      // The database's own wording stays in the log.
      expect(res.json().error).toEqual({ code: 'BUSY', message: 'The server is busy. Try again in a moment.' })
    }
  })

  it('answers a duplicate key as 409, not 500', async () => {
    thrown = prismaError('P2002', 'Unique constraint failed on the constraint: `SwarmGroup_pkey`')
    const res = await app.inject({ method: 'GET', url: '/fails' })
    expect(res.statusCode).toBe(409)
    expect(res.headers['retry-after']).toBeUndefined()
    expect(res.json().error).toEqual({ code: 'CONFLICT', message: 'This was changed at the same moment by another request. Read it again.' })
  })

  it('keeps anything else a 500 and logs its stack', async () => {
    const error = vi.spyOn(logger, 'error').mockImplementation(() => {})
    thrown = new TypeError("Cannot read properties of null (reading 'sendDown')")
    const res = await app.inject({ method: 'GET', url: '/fails' })
    expect(res.statusCode).toBe(500)
    expect(res.json().error.code).toBe('INTERNAL_ERROR')
    expect(error).toHaveBeenCalledTimes(1)
    const context = error.mock.calls[0]![2] as Record<string, unknown>
    expect(context.trace).toEqual(expect.stringContaining('TypeError: Cannot read properties of null'))
    expect(context.trace).toEqual(expect.stringContaining('errorHandler.test.ts'))
  })
})
