import { beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'

// In-memory Redis and sessions, so the real QR sign-in, session and authentication code runs.
const fakes = vi.hoisted(() => {
  const redis = new Map<string, string>()
  const ttls = new Map<string, number>()
  const sessions: Array<Record<string, unknown> & { id: string }> = []
  const users = new Map<string, Record<string, unknown>>()
  const pick = (where: Record<string, unknown>) =>
    sessions.find((s) => Object.entries(where).every(([k, v]) => s[k] === v)) ?? null
  const set = (key: string, value: string, ...opts: unknown[]) => {
    if (opts.includes('NX') && redis.has(key)) return null
    if (opts.includes('XX') && !redis.has(key)) return null
    redis.set(key, value)
    const ex = opts.indexOf('EX')
    if (ex >= 0) ttls.set(key, opts[ex + 1] as number)
    else if (!opts.includes('KEEPTTL')) ttls.delete(key)
    return 'OK'
  }
  const pub = {
    set: vi.fn(async (key: string, value: string, ...opts: unknown[]) => set(key, value, ...opts)),
    get: vi.fn(async (key: string) => redis.get(key) ?? null),
    del: vi.fn(async (key: string) => (redis.delete(key) ? 1 : 0)),
    multi: vi.fn(() => {
      const ops: Array<() => unknown> = []
      const chain = {
        get: (key: string) => { ops.push(() => redis.get(key) ?? null); return chain },
        del: (key: string) => { ops.push(() => (redis.delete(key) ? 1 : 0)); return chain },
        set: (key: string, value: string, ...opts: unknown[]) => { ops.push(() => set(key, value, ...opts)); return chain },
        expire: (key: string, sec: number) => { ops.push(() => (redis.has(key) ? (ttls.set(key, sec), 1) : 0)); return chain },
        exec: async () => ops.map((op) => [null, op()]),
      }
      return chain
    }),
  }
  const harnessSession = {
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      const row = { id: `s${sessions.length + 1}`, revokedAt: null, ...data }
      sessions.push(row); return row
    }),
    findUnique: vi.fn(async ({ where }: { where: Record<string, unknown> }) => pick(where)),
    update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      const row = pick(where)!; Object.assign(row, data); return row
    }),
    updateMany: vi.fn(async () => ({ count: 0 })),
  }
  return { redis, ttls, sessions, users, pub, harnessSession, get: vi.fn(async (id: string) => users.get(id) ?? null) }
})

vi.mock('../lib/bus.js', () => ({ pub: fakes.pub }))
vi.mock('../lib/prisma.js', () => ({ prisma: { harnessSession: fakes.harnessSession } }))
vi.mock('../services/UserService.js', () => ({
  userService: { get: fakes.get, findByEmail: vi.fn() },
  normalizeUserEmail: (email: string) => email.trim().toLowerCase(),
  isProvisionalUserEmail: () => false,
}))
vi.mock('../services/index.js', () => ({ userService: { get: fakes.get, toPublic: (u: unknown) => u } }))

import { authenticateAccessToken, SsoAuthError } from '../lib/ssoAuth.js'
import { redeemHandoff, startHandoff, QR_SIGN_IN_MAX_LIFE_SEC } from '../lib/harnessSession.js'
import { qrSignInRoutes } from './qrSignIn.js'
import { authRoutes } from './auth.js'
import { registerAuthMiddleware } from '../middlewares/authMiddleware.js'
import { errorHandler } from '../middlewares/errorHandler.js'

const USER = 'u1'
const COMPUTER_ID = '45fd3b2c-6ac9-4bde-be9d-ef1d31beb937'

describe('sign a computer in by scanning its QR', () => {
  let app: FastifyInstance
  let phone: string

  beforeEach(async () => {
    fakes.redis.clear()
    fakes.ttls.clear()
    fakes.sessions.length = 0
    fakes.users.set(USER, { id: USER, email: 'dee@example.com', role: 'user', autonomousEnv: 'prod' })
    // The phone: itself signed in by an earlier QR (a Harness viewer session).
    const { code } = await startHandoff(USER)
    phone = (await redeemHandoff(code, 'phone'))!.token
    app = Fastify()
    app.setErrorHandler(errorHandler)
    registerAuthMiddleware(app)
    await app.register(authRoutes)
    await app.register(qrSignInRoutes)
    await app.ready()
  })

  const post = (url: string, payload: unknown, headers: Record<string, string> = {}) =>
    app.inject({ method: 'POST', url, payload: payload as never, headers })
  const asPhone = (ip = '1.2.3.4') => ({ authorization: `Bearer ${phone}`, 'cf-connecting-ip': ip })
  const start = async (ip = '1.2.3.4') =>
    (await post('/api/auth/qr/start', { label: 'MacBook Pro', kind: 'computer', computerId: COMPUTER_ID }, { 'cf-connecting-ip': ip, 'cf-ipcountry': 'VN' })).json().data as { code: string; pollToken: string }

  it('signs the computer in only after the phone approves and the computer claims', async () => {
    const { code, pollToken } = await start()
    expect((await post('/api/auth/qr/poll', { pollToken })).json().data).toEqual({ status: 'pending' })
    const look = (await post('/api/auth/qr/lookup', { code }, asPhone())).json().data
    expect(look).toMatchObject({ label: 'MacBook Pro', kind: 'computer', country: 'VN', ipHint: '1.2.3.x', sameNetwork: true })
    expect((await post('/api/auth/qr/approve', { code }, asPhone())).statusCode).toBe(200)
    // Approved names the account, and nothing more: no session exists yet.
    expect((await post('/api/auth/qr/poll', { pollToken })).json().data).toEqual({ status: 'approved', email: 'dee@example.com' })
    expect(fakes.sessions).toHaveLength(1)
    const claimed = (await post('/api/auth/qr/claim', { pollToken })).json().data
    expect(claimed).toMatchObject({ email: 'dee@example.com', kind: 'computer', autonomousEnv: 'prod' })
    expect(fakes.sessions.at(-1)).toMatchObject({ kind: 'computer', label: 'MacBook Pro', userId: USER })
    // Once only.
    expect((await post('/api/auth/qr/claim', { pollToken })).statusCode).toBe(401)
    // The computer's session may connect as a machine; the phone's may not.
    await expect(authenticateAccessToken(claimed.token, 'prod', { allowHarnessSession: 'computer' })).resolves.toMatchObject({ sub: USER, harnessSessionKind: 'computer' })
    await expect(authenticateAccessToken(phone, 'prod', { allowHarnessSession: 'computer' })).rejects.toBeInstanceOf(SsoAuthError)
  })

  it('tells the phone when the computer is on another network, without its full address', async () => {
    const { code } = await start('9.8.7.6')
    const look = (await post('/api/auth/qr/lookup', { code }, asPhone('1.2.3.4'))).json().data
    expect(look).toMatchObject({ sameNetwork: false, ipHint: '9.8.7.x' })
  })

  it('a denial reaches the computer, and nothing can be claimed', async () => {
    const { code, pollToken } = await start()
    await post('/api/auth/qr/deny', { code }, asPhone())
    expect((await post('/api/auth/qr/poll', { pollToken })).json().data).toEqual({ status: 'denied' })
    expect((await post('/api/auth/qr/claim', { pollToken })).statusCode).toBe(401)
  })

  it('takes the first answer only', async () => {
    const { code } = await start()
    expect((await post('/api/auth/qr/approve', { code }, asPhone())).statusCode).toBe(200)
    expect((await post('/api/auth/qr/deny', { code }, asPhone())).statusCode).toBe(409)
  })

  it('the computer can take its QR back', async () => {
    const { code, pollToken } = await start()
    await post('/api/auth/qr/cancel', { pollToken })
    expect((await post('/api/auth/qr/poll', { pollToken })).json().data).toEqual({ status: 'expired' })
    expect((await post('/api/auth/qr/approve', { code }, asPhone())).statusCode).toBe(404)
  })

  it('a computer must say which computer it is', async () => {
    const r = await post('/api/auth/qr/start', { label: 'x', kind: 'computer' })
    expect(r.statusCode).toBe(400)
  })

  it('keeps one code alive, but not forever', async () => {
    const { pollToken } = await start()
    expect((await post('/api/auth/qr/extend', { pollToken })).json().data.expiresIn).toBeGreaterThan(0)
    const now = Date.now()
    const spy = vi.spyOn(Date, 'now').mockReturnValue(now + (QR_SIGN_IN_MAX_LIFE_SEC + 1) * 1000)
    expect((await post('/api/auth/qr/extend', { pollToken })).statusCode).toBe(410)
    spy.mockRestore()
  })

  it('once approved, waits out its whole life for the computer to say yes', async () => {
    const { code, pollToken } = await start()
    const keys = [...fakes.redis.keys()].filter((k) => k.startsWith('hnauth:qr'))
    expect(keys.map((k) => fakes.ttls.get(k))).toEqual([120, 120])
    expect((await post('/api/auth/qr/approve', { code }, asPhone())).statusCode).toBe(200)
    // The person at the computer may be slower than two minutes: it now lives to the end of its life,
    // and an extend the computer had in flight does not cut that short again.
    for (const k of keys) expect(fakes.ttls.get(k)).toBeGreaterThan(QR_SIGN_IN_MAX_LIFE_SEC - 5)
    expect((await post('/api/auth/qr/extend', { pollToken })).json().data.expiresIn).toBeGreaterThan(QR_SIGN_IN_MAX_LIFE_SEC - 5)
    for (const k of keys) expect(fakes.ttls.get(k)).toBeGreaterThan(QR_SIGN_IN_MAX_LIFE_SEC - 5)
    expect((await post('/api/auth/qr/claim', { pollToken })).statusCode).toBe(200)
  })

  it('the phone half needs a sign-in; the computer half does not', async () => {
    const { code } = await start()
    expect((await post('/api/auth/qr/lookup', { code })).statusCode).toBe(401)
  })

  it('a computer signed in by QR may add a phone; a phone signed in by QR may not', async () => {
    const { code, pollToken } = await start()
    await post('/api/auth/qr/approve', { code }, asPhone())
    const computer = (await post('/api/auth/qr/claim', { pollToken })).json().data.token
    expect((await post('/api/auth/handoff', {}, { authorization: `Bearer ${computer}` })).statusCode).toBe(200)
    expect((await post('/api/auth/handoff', {}, { authorization: `Bearer ${phone}` })).statusCode).toBe(403)
  })
})
