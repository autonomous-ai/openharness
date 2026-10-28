import { afterEach, describe, expect, it, vi } from 'vitest'

/** The Fastify app as production runs it: NODE_ENV=production, so the shared logger writes JSON. */
async function productionApp() {
  vi.stubEnv('NODE_ENV', 'production')
  vi.resetModules()
  const { default: Fastify } = await import('fastify')
  const { errorHandler } = await import('./errorHandler.js')
  const app = Fastify()
  app.setErrorHandler(errorHandler)
  app.get('/api/things/:id', async () => { throw new TypeError("Cannot read properties of undefined (reading 'id')") })
  await app.ready()
  return app
}

describe('error handler in production', () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks() })

  it('logs an unhandled error with its stack, and still hides the detail from the caller', async () => {
    const lines: string[] = []
    vi.spyOn(console, 'error').mockImplementation((line: unknown) => { lines.push(String(line)) })
    const app = await productionApp()
    const res = await app.inject({ method: 'GET', url: '/api/things/t1' })
    await app.close()

    expect(res.statusCode).toBe(500)
    expect(res.json()).toMatchObject({ success: false, error: { code: 'INTERNAL_ERROR', message: 'An internal server error occurred' } })
    expect(lines).toHaveLength(1)
    const entry = JSON.parse(lines[0])
    expect(entry).toMatchObject({ status: 'error', message: 'Unhandled error', error: "Cannot read properties of undefined (reading 'id')", name: 'TypeError' })
    expect(entry.stack).toMatch(/^TypeError: Cannot read properties of undefined/)
    expect(entry.stack).toContain('errorHandler.test.ts')
  })
})
