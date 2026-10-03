import { beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'

// In-memory stand-ins for Redis and the sessions collection, so the real handoff, refresh and
// authentication code runs end to end — only the stores are fake.
const fakes = vi.hoisted(() => {
  const redis = new Map<string, string>()
  const ttls = new Map<string, number>()
  let failRedis = false
  const sessions: Array<Record<string, unknown> & { id: string }> = []
  const users = new Map<string, Record<string, unknown>>()
  const pick = (where: Record<string, unknown>) =>
    sessions.find((s) => Object.entries(where).every(([k, v]) => s[k] === v)) ?? null
  const pub = {
    set: vi.fn(async (key: string, value: string, _ex: string, ttl: number) => {
      if (failRedis) throw new Error('redis down')
      redis.set(key, value); ttls.set(key, ttl); return 'OK'
    }),
    get: vi.fn(async (key: string) => {
      if (failRedis) throw new Error('redis down')
      return redis.get(key) ?? null
    }),
    // GET then DEL, in one transaction — how a redeem spends a code.
    multi: vi.fn(() => {
      const ops: Array<() => unknown> = []
      const chain = {
        get: (key: string) => { ops.push(() => redis.get(key) ?? null); return chain },
        del: (key: string) => { ops.push(() => (redis.delete(key) ? 1 : 0)); return chain },
        exec: async () => ops.map((op) => [null, op()]),
      }
      return chain
    }),
  }
  const harnessSession = {
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      // Like MongoDB: a new row has no `revokedAt` at all, and `revokedAt: null` does not match that.
      const row = { id: `s${sessions.length + 1}`, createdAt: new Date(), lastUsedAt: new Date(), ...data }
      sessions.push(row); return row
    }),
    findUnique: vi.fn(async ({ where }: { where: Record<string, unknown> }) => pick(where)),
    update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      const row = pick(where)!; Object.assign(row, data); return row
    }),
    updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      const field = (s: Record<string, unknown>, k: string, v: unknown): boolean =>
        v !== null && typeof v === 'object' && 'isSet' in v ? (k in s) === (v as { isSet: boolean }).isSet : k in s && s[k] === v
      const matches = (s: Record<string, unknown>, w: Record<string, unknown>): boolean => Object.entries(w).every(([k, v]) =>
        k === 'OR' ? (v as Record<string, unknown>[]).some((o) => matches(s, o)) : field(s, k, v))
      const rows = sessions.filter((s) => matches(s, where))
      rows.forEach((r) => Object.assign(r, data)); return { count: rows.length }
    }),
  }
  return {
    redis, ttls, sessions, users, pub, harnessSession,
    setFailRedis: (v: boolean) => { failRedis = v },
    get: vi.fn(async (id: string) => users.get(id) ?? null),
    findByEmail: vi.fn(),
  }
})

vi.mock('./bus.js', () => ({ pub: fakes.pub }))
vi.mock('./prisma.js', () => ({ prisma: { harnessSession: fakes.harnessSession } }))
vi.mock('../services/UserService.js', () => ({
  userService: { get: fakes.get, findByEmail: fakes.findByEmail },
  normalizeUserEmail: (email: string) => email.trim().toLowerCase(),
  isProvisionalUserEmail: () => false,
}))
vi.mock('../services/index.js', () => ({ userService: { get: fakes.get, toPublic: (u: unknown) => u } }))

import { authenticateAccessToken, SsoAuthError } from './ssoAuth.js'
import { HANDOFF_TTL_SEC, redeemHandoff, startHandoff } from './harnessSession.js'
import { authRoutes } from '../routes/auth.js'
import { registerAuthMiddleware } from '../middlewares/authMiddleware.js'
import { errorHandler } from '../middlewares/errorHandler.js'

const USER = { id: 'u1', email: 'dee@example.com', role: 'user', autonomousEnv: 'prod' }

beforeEach(() => {
  fakes.redis.clear(); fakes.ttls.clear(); fakes.sessions.length = 0; fakes.users.clear()
  fakes.users.set(USER.id, USER)
  fakes.setFailRedis(false)
  vi.clearAllMocks()
})

describe('scan to sign in — the handoff', () => {
  it('signs the phone in as the account that minted the code, and never asks the account service', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const { code, expiresIn } = await startHandoff(USER.id)
    expect(code).toMatch(/^hnh_[A-Za-z0-9_-]{43}$/)
    expect(expiresIn).toBe(HANDOFF_TTL_SEC)
    // Only the hash is kept, and it dies on its own.
    expect([...fakes.redis.keys()].some((k) => k.includes(code))).toBe(false)
    expect([...fakes.ttls.values()]).toEqual([HANDOFF_TTL_SEC])

    const tokens = await redeemHandoff(code, "Dee's iPhone")
    expect(tokens).toMatchObject({ expiresIn: 3600, autonomousEnv: 'prod' })
    expect(tokens!.token).toMatch(/^hna_/)
    expect(tokens!.refreshToken).toMatch(/^hnr_/)
    expect(fakes.sessions[0]).toMatchObject({ userId: USER.id, label: "Dee's iPhone" })
    expect(fakes.sessions[0].refreshHash).not.toBe(tokens!.refreshToken)

    await expect(authenticateAccessToken(tokens!.token)).resolves.toEqual({
      sub: USER.id, email: USER.email, role: 'user', autonomousEnv: 'prod', harnessSessionId: 's1', harnessSessionKind: 'viewer',
    })
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(fakes.findByEmail).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })

  it('works once: a second phone scanning the same QR gets nothing', async () => {
    const { code } = await startHandoff(USER.id)
    expect(await redeemHandoff(code, 'first')).not.toBeNull()
    expect(await redeemHandoff(code, 'second')).toBeNull()
    expect(fakes.sessions).toHaveLength(1)
  })

  it('refuses a code it never issued, or one that is not shaped like one', async () => {
    expect(await redeemHandoff(`hnh_${'A'.repeat(43)}`, 'x')).toBeNull()
    expect(await redeemHandoff('hnh_short', 'x')).toBeNull()
    expect(fakes.pub.multi).toHaveBeenCalledTimes(1) // the malformed one never reached Redis
  })

  it('a phone session is a viewer: machine connections refuse it', async () => {
    const { code } = await startHandoff(USER.id)
    const { token } = (await redeemHandoff(code, 'phone'))!
    await expect(authenticateAccessToken(token, 'prod', { allowHarnessSession: false }))
      .rejects.toMatchObject({ code: 'INVALID_TOKEN' })
  })

  it('an outage is not a bad token: Redis down answers AUTH_SERVICE_UNAVAILABLE, not a sign-out', async () => {
    const { code } = await startHandoff(USER.id)
    const { token } = (await redeemHandoff(code, 'phone'))!
    fakes.setFailRedis(true)
    const err = await authenticateAccessToken(token).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(SsoAuthError)
    expect(err).toMatchObject({ code: 'AUTH_SERVICE_UNAVAILABLE' })
  })

  it('an access token nobody issued is simply invalid', async () => {
    await expect(authenticateAccessToken(`hna_${'B'.repeat(43)}`)).rejects.toMatchObject({ code: 'INVALID_TOKEN' })
  })
})

describe('scan to sign in — the routes', () => {
  let app: FastifyInstance
  const signedIn = { sub: USER.id, email: USER.email, role: 'user', autonomousEnv: 'prod' as const }

  async function build(authenticate: typeof authenticateAccessToken): Promise<FastifyInstance> {
    const server = Fastify()
    server.setErrorHandler(errorHandler)
    registerAuthMiddleware(server, authenticate)
    await server.register(authRoutes)
    await server.ready()
    return server
  }

  beforeEach(async () => {
    // The computer's Autonomous token is faked; a Harness token goes through the real check.
    app = await build(async (token, env, opts) =>
      token === 'sso-token' ? signedIn : authenticateAccessToken(token, env, opts))
  })

  it('the computer mints a code, the phone redeems it, refreshes, and signs out', async () => {
    const minted = await app.inject({ method: 'POST', url: '/api/auth/handoff', headers: { authorization: 'Bearer sso-token' } })
    expect(minted.statusCode).toBe(200)
    const { code } = minted.json().data

    // No bearer: the code is the credential.
    const redeemed = await app.inject({ method: 'POST', url: '/api/auth/handoff/redeem', payload: { code, label: "Dee's iPhone" } })
    expect(redeemed.statusCode).toBe(200)
    const { token, refreshToken } = redeemed.json().data

    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${token}` } })
    expect(me.statusCode).toBe(200)
    expect(me.json().data.user.email).toBe(USER.email)

    const refreshed = await app.inject({ method: 'POST', url: '/api/auth/refresh', payload: { refreshToken } })
    expect(refreshed.statusCode).toBe(200)
    const renewed = refreshed.json().data
    expect(renewed.token).toMatch(/^hna_/)
    expect(renewed.token).not.toBe(token)
    expect(renewed.refreshToken).toBeUndefined() // not rotated: the phone keeps the one it has

    expect((await app.inject({ method: 'POST', url: '/api/auth/revoke', payload: { refreshToken } })).statusCode).toBe(200)
    // Signed out at once: the refresh token and BOTH access tokens it was ever given.
    const again = await app.inject({ method: 'POST', url: '/api/auth/refresh', payload: { refreshToken } })
    expect(again.statusCode).toBe(401)
    expect(again.json().error.code).toBe('REFRESH_TOKEN_INVALID')
    for (const t of [token, renewed.token]) {
      const res = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${t}` } })
      expect(res.statusCode).toBe(401)
    }
  })

  it('minting needs a signed-in computer', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/handoff' })
    expect(res.statusCode).toBe(401)
  })

  it('a phone signed in by a scan cannot mint codes of its own', async () => {
    const { code } = await startHandoff(USER.id)
    const { token } = (await redeemHandoff(code, 'phone'))!
    const res = await app.inject({ method: 'POST', url: '/api/auth/handoff', headers: { authorization: `Bearer ${token}` } })
    expect(res.statusCode).toBe(403)
    expect(res.json().error.code).toBe('HANDOFF_NOT_ALLOWED')
  })

  it('a spent or unknown code is one answer, 401', async () => {
    const { code } = await startHandoff(USER.id)
    await app.inject({ method: 'POST', url: '/api/auth/handoff/redeem', payload: { code } })
    for (const c of [code, 'nonsense', '']) {
      const res = await app.inject({ method: 'POST', url: '/api/auth/handoff/redeem', payload: { code: c } })
      expect(res.statusCode).toBe(401)
      expect(res.json().error.code).toBe('HANDOFF_INVALID')
    }
  })
})
