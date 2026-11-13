import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { Prisma } from '@prisma/client'
import { errorHandler } from './errorHandler.js'
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

  it('answers a genuine duplicate key as 409 in its own words, not 500', async () => {
    thrown = prismaError('P2002', 'Unique constraint failed on the constraint: `harness_shares_machineId_agentId_recipientEmail_key`')
    const res = await app.inject({ method: 'GET', url: '/fails' })
    expect(res.statusCode).toBe(409)
    expect(res.headers['retry-after']).toBeUndefined()
    expect(res.json().error).toEqual({ code: 'DUPLICATE', message: 'This already exists, so nothing new was saved.' })
  })

  // In the cluster the log line is JSON whose own `message` is the event's (utils/logger.ts): a context field of that name was
  // dropped, so prod's duplicate-key lines never said which index (2026-10-28).
  it('logs the database\'s own words, naming the index, under a field the log line keeps', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    for (const [code, message] of [['P2002', 'Unique constraint failed on the constraint: `_id_`'], ['P2028', 'Transaction already closed']]) {
      thrown = prismaError(code!, message!)
      await app.inject({ method: 'GET', url: '/fails' })
      const context = warn.mock.calls.at(-1)![1] as Record<string, unknown>
      expect(context).toMatchObject({ path: '/fails', method: 'GET', error: message })
      expect(context).not.toHaveProperty('message')
    }
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
