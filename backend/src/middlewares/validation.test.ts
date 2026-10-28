import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { errorHandler } from './errorHandler.js'
import { validateBody } from './validation.js'
import { operationSchema } from '../superTabs/commands.js'
import { logger } from '../utils/logger.js'

// Prod logs 2026-10-28: a host's start report was refused with 400 VALIDATION_ERROR every few minutes, and the log said only
// "Invalid input", so nobody could tell which field. The log names the fields; their values may be a person's words.
describe('a body refused by its schema', () => {
  let app: FastifyInstance
  beforeEach(async () => {
    app = Fastify()
    app.setErrorHandler(errorHandler)
    app.post('/api/super-tabs/hosts/m1/starts/tab-1/start-1', { preHandler: validateBody(operationSchema) }, async () => ({}))
    await app.ready()
  })
  afterEach(async () => { await app.close(); vi.restoreAllMocks() })

  const refused = async (payload: unknown) => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const res = await app.inject({ method: 'POST', url: '/api/super-tabs/hosts/m1/starts/tab-1/start-1', payload: payload as object })
    // Hosts fall back to an older form of a command on exactly this answer (cli superTabs/start.ts), so it stays.
    expect(res.statusCode).toBe(400)
    expect(res.json().error.code).toBe('VALIDATION_ERROR')
    const logged = warn.mock.calls.find(([message]) => message === 'Application error')![1] as Record<string, unknown>
    return { logged, text: JSON.stringify(warn.mock.calls) }
  }

  it('logs the names of the missing fields', async () => {
    expect((await refused({})).logged).toMatchObject({ code: 'VALIDATION_ERROR', fields: ['operationId', 'command'] })
  })

  it('logs nested and unknown field names, never their values', async () => {
    const { logged, text } = await refused({ operationId: 'op-1', command: { type: 'agent.started', startId: 'start-1', harnessId: 'h-1',
      configuration: { engine: 'claude', model: null, effort: null, contextWindow: 0, engineVersion: null }, token: 'SECRET-VALUE' } })
    expect(logged.fields).toEqual(['command.configuration.contextWindow', 'command.token'])
    expect(text).not.toContain('SECRET-VALUE')
  })

  it('names the command type when no command has it', async () => {
    expect((await refused({ operationId: 'op-1', command: { type: 'agent.unknown' } })).logged.fields).toEqual(['command.type'])
  })
})
