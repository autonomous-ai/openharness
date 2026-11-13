import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { z } from 'zod'
import { errorHandler } from './errorHandler.js'
import { validateBody } from './validation.js'
import { logger } from '../utils/logger.js'

/** A body as strict as the routes' own: an id, and one of a few kinds of change with nested, strict parts. */
const schema = z.object({
  operationId: z.string().min(1),
  change: z.discriminatedUnion('type', [
    z.object({ type: z.literal('agent.renamed'), agentId: z.string().min(1),
      configuration: z.object({ engine: z.string(), model: z.string().nullable(), contextWindow: z.number().int().positive().nullable() }).strict() }).strict(),
    z.object({ type: z.literal('agent.removed'), agentId: z.string().min(1) }).strict(),
  ]),
}).strict()

// Prod logs 2026-10-28: a report was refused with 400 VALIDATION_ERROR every few minutes, and the log said only "Invalid input",
// so nobody could tell which field. The log names the fields; their values may be a person's words.
describe('a body refused by its schema', () => {
  let app: FastifyInstance
  beforeEach(async () => {
    app = Fastify()
    app.setErrorHandler(errorHandler)
    app.post('/api/things', { preHandler: validateBody(schema) }, async () => ({}))
    await app.ready()
  })
  afterEach(async () => { await app.close(); vi.restoreAllMocks() })

  const refused = async (payload: unknown) => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const res = await app.inject({ method: 'POST', url: '/api/things', payload: payload as object })
    expect(res.statusCode).toBe(400)
    expect(res.json().error.code).toBe('VALIDATION_ERROR')
    const logged = warn.mock.calls.find(([message]) => message === 'Application error')![1] as Record<string, unknown>
    return { logged, text: JSON.stringify(warn.mock.calls) }
  }

  it('logs the names of the missing fields', async () => {
    expect((await refused({})).logged).toMatchObject({ code: 'VALIDATION_ERROR', fields: ['operationId', 'change'] })
  })

  it('logs nested and unknown field names, never their values', async () => {
    const { logged, text } = await refused({ operationId: 'op-1', change: { type: 'agent.renamed', agentId: 'a-1',
      configuration: { engine: 'claude', model: null, contextWindow: 0 }, token: 'SECRET-VALUE' } })
    expect(logged.fields).toEqual(['change.configuration.contextWindow', 'change.token'])
    expect(text).not.toContain('SECRET-VALUE')
  })

  it('names the kind of change when none has it', async () => {
    expect((await refused({ operationId: 'op-1', change: { type: 'agent.unknown' } })).logged.fields).toEqual(['change.type'])
  })
})
