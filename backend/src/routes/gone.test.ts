import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { registerAuthMiddleware } from '../middlewares/authMiddleware.js'
import { errorHandler } from '../middlewares/errorHandler.js'
import { goneRoutes } from './gone.js'

const signedIn = { sub: 'ken', email: 'ken@example.com', role: 'user', autonomousEnv: 'prod' as const }
const auth = { authorization: 'Bearer fixture' }

// Swarms are gone (anh Dee, 2026-11-14), while CLI and Desktop builds of the last 30 days still call them, some every second.
describe('a Swarm route an older client still calls', () => {
  let app: FastifyInstance
  const authenticate = vi.fn(async () => signedIn)
  beforeAll(async () => {
    app = Fastify()
    app.setErrorHandler(errorHandler)
    registerAuthMiddleware(app, authenticate as never)
    await app.register(goneRoutes)
    await app.ready()
  })
  afterAll(async () => { await app.close() })

  it('answers 410 with its code, whatever the method and however deep the path', async () => {
    for (const [method, url] of [['GET', '/api/super-tabs'], ['GET', '/api/super-tabs/list?after=x'], ['POST', '/api/super-tabs/6a73/commands'],
      ['GET', '/api/super-tabs/hosts/m1/changes?cursor=1'], ['PUT', '/api/super-tabs/6a73/sharing'], ['PATCH', '/api/super-tabs/6a73/groups/g1'],
      ['DELETE', '/api/super-tabs/6a73/machines/m1']] as const) {
      const res = await app.inject({ method, url, headers: auth, payload: method === 'GET' || method === 'DELETE' ? undefined : { operationId: 'op' } })
      expect(res.statusCode, `${method} ${url}`).toBe(410)
      expect(res.json()).toEqual({ success: false, error: { code: 'SWARMS_REMOVED', message: 'Swarms were removed from Harness.' } })
    }
  })

  it('answers before reading the body: a file upload is not parsed, and gets the same 410', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/super-tabs/6a73/attachments?asAgentId=a', headers: { ...auth,
      'content-type': 'multipart/form-data; boundary=x' }, payload: '--x\r\nContent-Disposition: form-data; name="file"; filename="a.txt"\r\n\r\nhi\r\n--x--\r\n' })
    expect(res.statusCode).toBe(410)
  })

  it('still takes a sign-in first, as every route does, and leaves other paths alone', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/super-tabs/list' })).statusCode).toBe(401)
    expect((await app.inject({ method: 'GET', url: '/api/super-tabsx', headers: auth })).statusCode).toBe(404)
  })
})
