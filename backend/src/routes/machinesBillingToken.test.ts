import { beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'

// Billing and machine deletion forward the caller's SSO access token to the account service (lib/autonomousBff.ts).
// A Harness session an SSO sign-in backs (lib/ssoSession.ts) forwards the one the backend keeps for it; any other
// Harness session is told to sign in with Google or Apple, as before. ssoSession's own behaviour is tested in
// lib/ssoSession.test.ts: here only its answer is set.
const m = vi.hoisted(() => ({
  beginCheckout: vi.fn(async () => ({ redirectUrl: 'https://pay.example/x' })),
  destroy: vi.fn(async () => undefined),
  ssoAccessTokenFor: vi.fn(async (): Promise<string | null> => null),
}))
vi.mock('../services/index.js', () => ({
  machineService: { destroy: m.destroy },
  machineBillingService: { beginCheckout: m.beginCheckout },
  userService: { get: vi.fn() },
}))
vi.mock('../lib/prisma.js', () => ({ prisma: {}, machineAlive: {} }))
vi.mock('../lib/machineAccess.js', () => ({ machinesSharedWith: vi.fn(async () => []) }))
vi.mock('../lib/ssoSession.js', () => ({ ssoAccessTokenFor: m.ssoAccessTokenFor }))
// The machine routes reach the Redis bus (lib/bus.ts), which opens its clients as it is imported. With no Redis, their
// connection errors were logged after this short file had finished, and the worker closed with those logs on their way
// ("Closing rpc while onUserConsoleLog was pending", CI on #2434). Nothing here publishes, so no client is opened.
vi.mock('../lib/bus.js', () => ({}))

import { machineRoutes } from './machines.js'
import { errorHandler } from '../middlewares/errorHandler.js'
import { SsoAuthError, type AuthUser } from '../lib/ssoAuth.js'
import { HARNESS_ACCESS_PREFIX, newHarnessToken } from '../lib/harnessTokenFormat.js'

const MACHINE = 'a'.repeat(32)
const SSO_USER: AuthUser = { sub: 'u1', email: 'dee@example.com', role: 'user', autonomousEnv: 'prod' }
const HARNESS_USER: AuthUser = { ...SSO_USER, harnessSessionId: 'sess-1', harnessSessionKind: 'computer' }

let app: FastifyInstance
let caller: AuthUser

beforeEach(async () => {
  vi.clearAllMocks()
  app = Fastify()
  app.setErrorHandler(errorHandler)
  // What the authentication middleware leaves on the request.
  app.addHook('preHandler', async (req) => { req.user = caller })
  await app.register(machineRoutes)
  await app.ready()
})

const checkout = (token: string) =>
  app.inject({ method: 'POST', url: `/api/machines/${MACHINE}/checkout`, headers: { authorization: `Bearer ${token}` } })

describe('the SSO token billing forwards', () => {
  it('is the caller’s own for an SSO sign-in', async () => {
    caller = SSO_USER
    expect((await checkout('sso-access')).statusCode).toBe(200)
    expect(m.beginCheckout).toHaveBeenCalledWith(MACHINE, 'u1', 'dee@example.com', 'sso-access', expect.any(String), 'prod')
    expect(m.ssoAccessTokenFor).not.toHaveBeenCalled()
  })

  it('is the one kept for a Harness session an SSO sign-in backs', async () => {
    caller = HARNESS_USER
    m.ssoAccessTokenFor.mockResolvedValueOnce('kept-sso-access')
    expect((await checkout(newHarnessToken(HARNESS_ACCESS_PREFIX))).statusCode).toBe(200)
    expect(m.ssoAccessTokenFor).toHaveBeenCalledWith('sess-1', 'u1')
    expect(m.beginCheckout).toHaveBeenCalledWith(MACHINE, 'u1', 'dee@example.com', 'kept-sso-access', expect.any(String), 'prod')
  })

  it('is none for a session nothing backs: sign in with Google or Apple, as before', async () => {
    caller = HARNESS_USER
    const res = await checkout(newHarnessToken(HARNESS_ACCESS_PREFIX))
    expect(res.statusCode).toBe(403)
    expect(res.json().error.code).toBe('NEEDS_AUTONOMOUS_SIGN_IN')
    expect(m.beginCheckout).not.toHaveBeenCalled()
  })

  it('is unavailable, not a sign-in prompt, when SSO cannot give one now', async () => {
    caller = HARNESS_USER
    m.ssoAccessTokenFor.mockRejectedValueOnce(new SsoAuthError('The sign-in service is unavailable; retrying', 'AUTH_SERVICE_UNAVAILABLE'))
    const res = await checkout(newHarnessToken(HARNESS_ACCESS_PREFIX))
    expect(res.statusCode).toBe(503)
    expect(res.json().error.code).toBe('AUTH_SERVICE_UNAVAILABLE')
  })

  it('reaches machine deletion the same way', async () => {
    caller = HARNESS_USER
    m.ssoAccessTokenFor.mockResolvedValueOnce('kept-sso-access')
    const res = await app.inject({ method: 'DELETE', url: `/api/machines/${MACHINE}`,
      headers: { authorization: `Bearer ${newHarnessToken(HARNESS_ACCESS_PREFIX)}` } })
    expect(res.statusCode).toBe(200)
    expect(m.destroy).toHaveBeenCalledWith(MACHINE, HARNESS_USER, 'kept-sso-access')
  })
})
