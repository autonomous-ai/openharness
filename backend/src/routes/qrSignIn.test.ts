import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
    // The quota scripts: INCR every key, arming its expiry (ms) on first use; the counts in KEYS order.
    eval: vi.fn(async (_script: string, n: number, ...args: unknown[]) => {
      const keys = args.slice(0, n) as string[]
      return keys.map((key, i) => {
        const next = Number(redis.get(key) ?? 0) + 1
        redis.set(key, String(next))
        if (next === 1) ttls.set(key, Math.ceil(Number(args[n + i]) / 1000))
        return next
      })
    }),
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
import { redeemHandoff, startHandoff, BOX_TICKET_TTL_SEC, QR_SIGN_IN_MAX_LIFE_SEC, SPOKEN_CODE_MISSES_PER_HOUR } from '../lib/harnessSession.js'
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

  // A device with no screen (lampOS's lamp, #1410) cannot show a QR: it says a short code aloud and the
  // person types it into Harness on their phone. The same QR sign-in underneath, with the same
  // "Sign in as <email>?" on the device, so a stranger who hears the code still cannot use it.
  describe('a spoken code', () => {
    // Each start from its own address: the start limit is per address and per process, across tests.
    let device = 0
    // And each test in a minute of its own: the phone half's 20/min is per account and per process too.
    let minute = 0
    beforeEach(() => { vi.spyOn(Date, 'now').mockReturnValue(Date.UTC(2030, 0, 1) + ++minute * 61_000) })
    afterEach(() => { vi.restoreAllMocks() })
    const startSpoken = async () =>
      (await post('/api/auth/qr/start', { label: 'Lamp', kind: 'computer', computerId: COMPUTER_ID, spokenCode: true }, { 'cf-connecting-ip': `10.0.0.${++device}` })).json().data as { code: string; pollToken: string; spokenCode: string }

    it('signs a device in with eight digits typed on the phone, spaced however the person likes', async () => {
      const { pollToken, spokenCode } = await startSpoken()
      expect(spokenCode).toMatch(/^\d{8}$/)
      const typed = `${spokenCode.slice(0, 4)} ${spokenCode.slice(4)}`
      expect((await post('/api/auth/qr/lookup', { code: typed }, asPhone())).json().data).toMatchObject({ label: 'Lamp', kind: 'computer', status: 'pending' })
      expect((await post('/api/auth/qr/approve', { code: typed }, asPhone())).statusCode).toBe(200)
      expect((await post('/api/auth/qr/poll', { pollToken })).json().data).toEqual({ status: 'approved', email: 'dee@example.com' })
      expect((await post('/api/auth/qr/claim', { pollToken })).json().data).toMatchObject({ email: 'dee@example.com', kind: 'computer' })
    })

    it('is made only when the device asks, so a QR sign-in gains no guessable handle', async () => {
      const plain = await start()
      expect(plain).not.toHaveProperty('spokenCode')
      expect([...fakes.redis.keys()].filter((k) => k.startsWith('hnauth:qrspoken:'))).toEqual([])
    })

    it('lives and dies with its sign-in', async () => {
      const { code, pollToken, spokenCode } = await startSpoken()
      const key = `hnauth:qrspoken:${spokenCode}`
      expect(fakes.ttls.get(key)).toBe(120)
      expect((await post('/api/auth/qr/extend', { pollToken })).statusCode).toBe(200)
      expect(fakes.ttls.get(key)).toBe(120)
      expect((await post('/api/auth/qr/approve', { code: spokenCode }, asPhone())).statusCode).toBe(200)
      expect(fakes.ttls.get(key)).toBeGreaterThan(QR_SIGN_IN_MAX_LIFE_SEC - 5)
      expect((await post('/api/auth/qr/deny', { code }, asPhone())).statusCode).toBe(409)
      expect((await post('/api/auth/qr/claim', { pollToken })).statusCode).toBe(200)
      expect(fakes.redis.has(key)).toBe(false)
    })

    it('is gone once the device takes it back', async () => {
      const { pollToken, spokenCode } = await startSpoken()
      await post('/api/auth/qr/cancel', { pollToken })
      expect((await post('/api/auth/qr/approve', { code: spokenCode }, asPhone())).statusCode).toBe(404)
    })

    it('lets an account miss only a few spoken codes an hour, whichever replica it reaches', async () => {
      const { spokenCode } = await startSpoken()
      const wrong = spokenCode === '00000000' ? '00000001' : '00000000'
      for (let i = 0; i < SPOKEN_CODE_MISSES_PER_HOUR; i++) {
        expect((await post('/api/auth/qr/lookup', { code: wrong }, asPhone())).statusCode).toBe(404)
      }
      // Out of guesses: even the right code waits, so a hit cannot follow a run of misses.
      expect((await post('/api/auth/qr/approve', { code: spokenCode }, asPhone())).statusCode).toBe(429)
      expect((await post('/api/auth/qr/lookup', { code: spokenCode }, asPhone())).statusCode).toBe(429)
      // Counted in Redis, so every replica sees the same misses.
      expect([...fakes.redis.keys()].some((k) => k.startsWith('hnauth:spokenmiss:'))).toBe(true)
    })

    it('a deny by spoken code reaches the device', async () => {
      const { pollToken, spokenCode } = await startSpoken()
      expect((await post('/api/auth/qr/deny', { code: spokenCode }, asPhone())).statusCode).toBe(200)
      expect((await post('/api/auth/qr/poll', { pollToken })).json().data).toEqual({ status: 'denied' })
    })

    it('is only for a device signing itself in, never an app', async () => {
      const r = await post('/api/auth/qr/start', { label: 'x', kind: 'viewer', spokenCode: true }, { 'cf-connecting-ip': '10.9.9.9' })
      expect(r.statusCode).toBe(400)
    })

    it('a code that matches nothing, or is not eight digits, is not found', async () => {
      await startSpoken()
      for (const code of ['00000000', '1234567', '123456789', 'abcd efgh']) {
        expect((await post('/api/auth/qr/lookup', { code }, asPhone())).statusCode).toBe(404)
      }
    })
  })

  describe('a box ticket', () => {
    const ticket = async () => (await post('/api/auth/box/ticket', {}, asPhone())).json().data as { ticket: string; expiresIn: number }

    it('signs a headless box in as a computer, once, with nothing to scan or confirm', async () => {
      const t = await ticket()
      expect(t.expiresIn).toBe(BOX_TICKET_TTL_SEC)
      const keys = [...fakes.redis.keys()].filter((k) => k.startsWith('hnauth:qr'))
      expect(keys).toHaveLength(3)   // the record, its poll key, and the answer lock
      for (const k of keys) expect(fakes.ttls.get(k)).toBe(BOX_TICKET_TTL_SEC)
      expect((await post('/api/auth/qr/poll', { pollToken: t.ticket })).json().data).toEqual({ status: 'approved', email: 'dee@example.com' })
      const claimed = (await post('/api/auth/qr/claim', { pollToken: t.ticket })).json().data
      expect(claimed).toMatchObject({ email: 'dee@example.com', kind: 'computer' })
      expect(fakes.sessions.at(-1)).toMatchObject({ kind: 'computer', label: 'Harness', userId: USER })
      await expect(authenticateAccessToken(claimed.token, 'prod', { allowHarnessSession: 'computer' })).resolves.toMatchObject({ sub: USER, harnessSessionKind: 'computer' })
      const again = await post('/api/auth/qr/claim', { pollToken: t.ticket })
      expect(again.statusCode).toBe(401)
      expect(again.json().error.code).toBe('QR_INVALID')
    })

    it('needs a sign-in and takes no body', async () => {
      expect((await post('/api/auth/box/ticket', {})).statusCode).toBe(401)
      expect((await post('/api/auth/box/ticket', { label: 'x' }, asPhone())).statusCode).toBe(400)
    })

    it('is a wall for a loop', async () => {
      const codes: number[] = []
      for (let i = 0; i < 11; i++) codes.push((await post('/api/auth/box/ticket', {}, asPhone())).statusCode)
      expect(codes.at(-1)).toBe(429)
    })
  })
})
