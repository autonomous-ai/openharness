import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// The contract the control plane (grid-apis) parses, hand-duplicated there — see the fixture's README
// and ADR 0046. Changing either copy alone fails a test on that side.
const contract = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'gridProfile.contract.json'), 'utf-8')) as {
  status: number
  data: { id: string; email: string; full_name: string; customer_socials: Array<{ source: string; uid: string }> }
}

// In-memory Redis, Prisma and Harness sessions, so the real authentication middleware, the real user
// mirror, the real Harness sessions and the real Google subject fill all run. Only Autonomous is
// stubbed, at `fetch`.
const fakes = vi.hoisted(() => {
  const redis = new Map<string, string>()
  const sessions: Array<Record<string, unknown> & { id: string }> = []
  const users = new Map<string, Record<string, unknown> & { id: string }>()
  const match = <T extends Record<string, unknown>>(rows: Iterable<T>, where: Record<string, unknown>) =>
    [...rows].find((r) => Object.entries(where).every(([k, v]) => r[k] === v)) ?? null
  const set = (key: string, value: string, ...opts: unknown[]) => {
    if (opts.includes('NX') && redis.has(key)) return null
    if (opts.includes('XX') && !redis.has(key)) return null
    redis.set(key, value)
    return 'OK'
  }
  const pub = {
    set: async (key: string, value: string, ...opts: unknown[]) => set(key, value, ...opts),
    get: async (key: string) => redis.get(key) ?? null,
    del: async (key: string) => (redis.delete(key) ? 1 : 0),
    multi: () => {
      const ops: Array<() => unknown> = []
      const chain = {
        get: (key: string) => { ops.push(() => redis.get(key) ?? null); return chain },
        del: (key: string) => { ops.push(() => (redis.delete(key) ? 1 : 0)); return chain },
        set: (key: string, value: string, ...opts: unknown[]) => { ops.push(() => set(key, value, ...opts)); return chain },
        expire: (key: string) => { ops.push(() => (redis.has(key) ? 1 : 0)); return chain },
        exec: async () => ops.map((op) => [null, op()]),
      }
      return chain
    },
  }
  let nextUser = 1
  const user = {
    findUnique: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
      const row = match(users.values(), where)
      return row ? { ...row } : null
    }),
    findMany: vi.fn(async () => [...users.values()].map((r) => ({ ...r }))),
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      if (match(users.values(), { email: data.email }) || match(users.values(), { externalId: data.externalId })) {
        throw new Error('unique constraint')
      }
      const row = { id: `u${nextUser++}`, role: 'user', autonomousEnv: 'prod', ...data }
      users.set(row.id, row)
      return { ...row }
    }),
    update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      const row = users.get(where.id)
      if (!row) throw new Error('record to update not found')
      Object.assign(row, data)
      return { ...row }
    }),
    // MongoDB's reading of the one filter the Google subject write uses: `field: null` matches a null
    // and NOT an absent field; `{ isSet: false }` matches only an absent one; `{ lt }` a smaller date.
    updateMany: vi.fn(async ({ where, data }: { where: { id: string; OR: Array<Record<string, unknown>> }; data: Record<string, unknown> }) => {
      const row = users.get(where.id)
      const holds = (cond: Record<string, unknown>) => Object.entries(cond).every(([key, want]) => {
        const has = key in row! && row![key] !== undefined
        if (want === null) return has && row![key] === null
        const op = want as { isSet?: boolean; lt?: Date }
        if (op.isSet === false) return !has
        if (op.lt) return row![key] instanceof Date && (row![key] as Date) < op.lt
        return row![key] === want
      })
      if (!row || !where.OR.some(holds)) return { count: 0 }
      Object.assign(row, data)
      return { count: 1 }
    }),
  }
  const harnessSession = {
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      const row = { id: `s${sessions.length + 1}`, revokedAt: null, ...data }
      sessions.push(row); return row
    }),
    findUnique: vi.fn(async ({ where }: { where: Record<string, unknown> }) => match(sessions, where)),
    update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      const row = match(sessions, where)!; Object.assign(row, data); return row
    }),
    updateMany: vi.fn(async () => ({ count: 0 })),
  }
  const stampUserCountry = vi.fn(async () => undefined)
  return { redis, sessions, users, pub, user, harnessSession, stampUserCountry }
})

vi.mock('../lib/bus.js', () => ({ pub: fakes.pub }))
vi.mock('../lib/prisma.js', () => ({ prisma: { user: fakes.user, harnessSession: fakes.harnessSession } }))
vi.mock('../lib/clientGeo.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/clientGeo.js')>()),
  stampUserCountry: fakes.stampUserCountry,
}))

import { clearSsoProfileCache } from '../lib/ssoAuth.js'
import { answerQrSignIn, claimQrSignIn, redeemHandoff, startHandoff, startQrSignIn } from '../lib/harnessSession.js'
import {
  FILL_RETRY_AFTER_MS, GOOGLE_SUBJECT_RECHECK_MS, recordLiveProfile, resetGoogleSubjectFill,
} from '../lib/googleSubject.js'
import { GRID_PROFILE_LIVE_READS_PER_MINUTE, resetGridProfileLimits } from '../lib/gridProfile.js'
import { userService } from '../services/UserService.js'
import { registerAuthMiddleware } from '../middlewares/authMiddleware.js'
import { errorHandler } from '../middlewares/errorHandler.js'
import { gridRoutes } from './grid.js'

const IDENTITY_URL = 'https://apiv2.autonomous.ai/api/v1/me/identity'
const PROFILE_URL = 'https://apiv2.autonomous.ai/api/v1/me/profile'

// The contract's known account, and the person's live Google OAuth token, which Autonomous puts in
// the profile body and which must never leave it.
const CUSTOMER_ID = contract.data.id
const EMAIL = contract.data.email
const FULL_NAME = contract.data.full_name
const GOOGLE_SUB = contract.data.customer_socials[0].uid
const GOOGLE_OAUTH_TOKEN = 'ya29.live-google-oauth-token-never-copied'

/** An Autonomous access token: a JWT-shaped string whose payload names the person. */
function autonomousToken(name = FULL_NAME, nonce = 'n1'): string {
  const payload = Buffer.from(JSON.stringify({ name, nonce })).toString('base64url')
  return `eyJhbGciOiJSUzI1NiJ9.${payload}.signature`
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

type ProfileAnswer = () => Response | Promise<Response>

const googleProfile = (sub: string | null = GOOGLE_SUB): ProfileAnswer => () => json(200, {
  status: 1,
  message: 'ok',
  data: {
    id: CUSTOMER_ID,
    email: EMAIL,
    full_name: FULL_NAME,
    phone: '+84 000 000 000',
    address: '1 Private Street',
    customer_socials: sub
      ? [
        { source: 'apple', uid: 'apple-uid-1', token: 'apple-token-never-copied' },
        { source: 'google', uid: sub, full_name: FULL_NAME, token: GOOGLE_OAUTH_TOKEN },
      ]
      : [{ source: 'apple', uid: 'apple-uid-1', token: 'apple-token-never-copied' }],
  },
})

/** Autonomous, stubbed per URL. The identity URL proves a token; the profile URL is the full read. */
function stubAutonomous(profile: ProfileAnswer, identity: ProfileAnswer = () => json(200, { status: 1, data: { id: CUSTOMER_ID, email: EMAIL } })) {
  const fetchMock = vi.fn<typeof fetch>(async (url) => {
    const u = String(url)
    if (u === IDENTITY_URL) return identity()
    if (u === PROFILE_URL) return profile()
    throw new Error(`unexpected fetch ${u}`)
  })
  vi.stubGlobal('fetch', fetchMock)
  return {
    fetchMock,
    profileReads: () => fetchMock.mock.calls.filter(([url]) => String(url) === PROFILE_URL).length,
  }
}

function seedUser(fields: Record<string, unknown> = {}): string {
  const row = { id: 'known', email: EMAIL, externalId: CUSTOMER_ID, name: FULL_NAME, role: 'user', autonomousEnv: 'prod', ...fields }
  fakes.users.set(row.id, row as never)
  return row.id
}

async function computerToken(userId: string): Promise<string> {
  const { code, pollToken } = await startQrSignIn({ label: 'MacBook Pro', kind: 'computer' }, {})
  const user = fakes.users.get(userId)!
  await answerQrSignIn(code, { approve: true, userId, email: String(user.email) })
  return (await claimQrSignIn(pollToken))!.token
}

async function phoneToken(userId: string): Promise<string> {
  const { code } = await startHandoff(userId)
  return (await redeemHandoff(code, 'phone'))!.token
}

/** Wait for the fire-and-forget fill to land (or to give up) without sleeping a fixed time. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 20))

describe('GET /api/grid/profile — who holds a Harness sign-in token, in the Autonomous profile shape', () => {
  let app: FastifyInstance
  let logs: string[]

  beforeEach(async () => {
    fakes.redis.clear()
    fakes.sessions.length = 0
    fakes.users.clear()
    fakes.stampUserCountry.mockClear()
    clearSsoProfileCache()
    resetGoogleSubjectFill()
    resetGridProfileLimits()
    logs = []
    for (const level of ['log', 'warn', 'error', 'debug', 'info'] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { logs.push(args.map(String).join(' ')) })
    }
    app = Fastify()
    app.setErrorHandler(errorHandler)
    registerAuthMiddleware(app)
    await app.register(gridRoutes)
    // "Any route": the fill rides on authentication, not on a particular handler.
    app.get('/api/anything', async () => ({ ok: true }))
    await app.ready()
  })

  afterEach(async () => {
    await app.close()
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  const get = (url: string, token: string, headers: Record<string, string> = {}) =>
    app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}`, ...headers } })

  const leaked = (text: string) =>
    [GOOGLE_OAUTH_TOKEN, 'apple-token-never-copied', '1 Private Street', '+84 000 000 000'].filter((secret) => text.includes(secret))

  describe('the fill, observed across two requests', () => {
    it('learns the Google subject from an Autonomous request, then answers a computer sign-in from it', async () => {
      seedUser()
      stubAutonomous(googleProfile())

      expect((await get('/api/anything', autonomousToken())).statusCode).toBe(200)
      await settle()

      const res = await get('/api/grid/profile', await computerToken('known'))
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual(contract)
    })

    it('answers the same contract for an Autonomous token, read live', async () => {
      seedUser()
      stubAutonomous(googleProfile())

      const res = await get('/api/grid/profile', autonomousToken())

      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual(contract)
    })

    it('records "none" for an account with no Google identity, and answers an empty list', async () => {
      seedUser()
      stubAutonomous(googleProfile(null))

      await get('/api/anything', autonomousToken())
      await settle()

      const res = await get('/api/grid/profile', await computerToken('known'))
      expect(res.statusCode).toBe(200)
      expect(res.json().data.customer_socials).toEqual([])
    })

    it('fills a user row written before the new fields existed (absent, not null)', async () => {
      seedUser() // no googleSub, no googleSubCheckedAt at all
      const autonomous = stubAutonomous(googleProfile())

      await get('/api/anything', autonomousToken())
      await settle()

      expect(autonomous.profileReads()).toBe(1)
      expect(fakes.users.get('known')).toMatchObject({ googleSub: GOOGLE_SUB })
      expect(fakes.users.get('known')!.googleSubCheckedAt).toBeInstanceOf(Date)
    })

    it('fills a row whose fields are null', async () => {
      seedUser({ googleSub: null, googleSubCheckedAt: null })
      const autonomous = stubAutonomous(googleProfile())

      await get('/api/anything', autonomousToken())
      await settle()

      expect(autonomous.profileReads()).toBe(1)
    })

    it('reads once for concurrent requests of one account', async () => {
      seedUser()
      const autonomous = stubAutonomous(googleProfile())

      await Promise.all(['n1', 'n2', 'n3', 'n4', 'n5'].map((n) => get('/api/anything', autonomousToken('x', n))))
      await settle()

      expect(autonomous.profileReads()).toBe(1)
    })

    it('reads the profile at most once in 7 days outside the profile route', async () => {
      seedUser()
      const autonomous = stubAutonomous(googleProfile())

      await get('/api/anything', autonomousToken('x', 'n1'))
      await settle()
      await get('/api/anything', autonomousToken('x', 'n2'))
      await get('/api/anything', autonomousToken('x', 'n3'))
      await settle()

      expect(autonomous.profileReads()).toBe(1)
    })

    it('rechecks once the last check is older than 7 days, and overwrites to "none"', async () => {
      seedUser({ googleSub: GOOGLE_SUB, googleSubCheckedAt: new Date(Date.now() - GOOGLE_SUBJECT_RECHECK_MS - 60_000) })
      const autonomous = stubAutonomous(googleProfile(null))

      await get('/api/anything', autonomousToken())
      await settle()

      expect(autonomous.profileReads()).toBe(1)
      expect(fakes.users.get('known')!.googleSub).toBeNull()
      expect((fakes.users.get('known')!.googleSubCheckedAt as Date).getTime()).toBeGreaterThan(Date.now() - 60_000)
    })

    it('does not recheck a row checked less than 7 days ago', async () => {
      seedUser({ googleSub: GOOGLE_SUB, googleSubCheckedAt: new Date(Date.now() - GOOGLE_SUBJECT_RECHECK_MS + 60_000) })
      const autonomous = stubAutonomous(googleProfile())

      await get('/api/anything', autonomousToken())
      await settle()

      expect(autonomous.profileReads()).toBe(0)
    })

    it('never makes the request wait for the fill', async () => {
      // Its own account: the hung read stays in flight past this test (in production the read's own
      // timeout ends it), and an account with a fill in flight is not filled twice.
      seedUser({ id: 'hung', email: 'hung@example.com', externalId: 'hung-customer' })
      stubAutonomous(
        () => new Promise<Response>(() => { /* Autonomous never answers the full read */ }),
        () => json(200, { status: 1, data: { id: 'hung-customer', email: 'hung@example.com' } }),
      )

      const res = await get('/api/anything', autonomousToken())

      expect(res.statusCode).toBe(200)
    })

    it('never fails the request, and leaves the account unchecked so a later request retries', async () => {
      vi.useFakeTimers({ toFake: ['Date'] })
      seedUser()
      const autonomous = stubAutonomous(() => json(502, { message: 'bad gateway' }))

      expect((await get('/api/anything', autonomousToken('x', 'n1'))).statusCode).toBe(200)
      await settle()
      expect(fakes.users.get('known')!.googleSubCheckedAt).toBeUndefined()

      // Not on every request: a read that keeps failing would be a storefront read per request.
      expect((await get('/api/anything', autonomousToken('x', 'n2'))).statusCode).toBe(200)
      await settle()
      expect(autonomous.profileReads()).toBe(1)

      vi.setSystemTime(Date.now() + FILL_RETRY_AFTER_MS + 1)
      expect((await get('/api/anything', autonomousToken('x', 'n3'))).statusCode).toBe(200)
      await settle()
      expect(autonomous.profileReads()).toBe(2)
    })

    it('counts only production-plane reads', async () => {
      seedUser({ autonomousEnv: 'stag', stagExternalId: 'stag-1' })
      const fetchMock = vi.fn<typeof fetch>(async (url) =>
        String(url).includes('staging')
          ? json(200, { status: 1, data: { id: 'stag-1', email: EMAIL, customer_socials: [{ source: 'google', uid: 'stag-google' }] } })
          : json(500, {}))
      vi.stubGlobal('fetch', fetchMock)

      expect((await get('/api/anything', autonomousToken(), { 'x-autonomous-env': 'stag' })).statusCode).toBe(200)
      await settle()

      expect(fetchMock.mock.calls.map(([u]) => String(u)).filter((u) => u.endsWith('/me/profile'))).toEqual([])
      expect(fakes.users.get('known')!.googleSubCheckedAt).toBeUndefined()
    })
  })

  describe('an Autonomous token', () => {
    it('is read live — a token Autonomous now rejects is refused even while the auth cache accepts it', async () => {
      seedUser({ googleSub: GOOGLE_SUB, googleSubCheckedAt: new Date() })
      // The identity endpoint (what authentication asks, and caches) still says yes; the live profile
      // read says the token is gone.
      stubAutonomous(() => json(401, { message: 'Invalid or expired JWT' }))

      const token = autonomousToken()
      expect((await get('/api/anything', token)).statusCode).toBe(200) // primes the auth cache
      const res = await get('/api/grid/profile', token)

      expect(res.statusCode).toBe(401)
    })

    it('answers 503 when Autonomous fails or cannot be reached', async () => {
      seedUser({ googleSub: GOOGLE_SUB, googleSubCheckedAt: new Date() })
      stubAutonomous(() => json(503, {}))
      expect((await get('/api/grid/profile', autonomousToken('x', 'n1'))).statusCode).toBe(503)

      stubAutonomous(() => { throw new TypeError('fetch failed') })
      expect((await get('/api/grid/profile', autonomousToken('x', 'n2'))).statusCode).toBe(503)

      stubAutonomous(() => json(200, { status: 1, data: { id: CUSTOMER_ID, email: EMAIL, customer_socials: [{ source: 'google', uid: '' }] } }))
      expect((await get('/api/grid/profile', autonomousToken('x', 'n3'))).statusCode).toBe(503)
    })

    it('records what it read', async () => {
      seedUser({ googleSub: null, googleSubCheckedAt: null })
      stubAutonomous(googleProfile())

      const res = await get('/api/grid/profile', autonomousToken())

      expect(res.json().data.id).toBe(CUSTOMER_ID)
      expect(fakes.users.get('known')).toMatchObject({ googleSub: GOOGLE_SUB })
    })

    it('takes the customer id from the live profile, not from the row', async () => {
      seedUser({ googleSub: GOOGLE_SUB, googleSubCheckedAt: new Date() })
      // Authentication (the identity endpoint) mirrors one id onto the row; the live profile says another.
      stubAutonomous(googleProfile(), () => json(200, { status: 1, data: { id: 'identity-id', email: EMAIL } }))

      const res = await get('/api/grid/profile', autonomousToken())

      expect(fakes.users.get('known')!.externalId).toBe('identity-id')
      expect(res.json().data.id).toBe(CUSTOMER_ID)
    })

    it('is one read and no fill: the route records its own live read', async () => {
      seedUser({ googleSub: 'stale-sub', googleSubCheckedAt: new Date(Date.now() - GOOGLE_SUBJECT_RECHECK_MS - 60_000) })
      const autonomous = stubAutonomous(googleProfile())

      await get('/api/grid/profile', autonomousToken())
      await settle()

      expect(autonomous.profileReads()).toBe(1)
      expect(logs.filter((l) => l.includes('stored and live'))).toHaveLength(1)
    })

    it('refuses a 21-digit Google subject that arrived as a JSON number rather than store it rounded', async () => {
      seedUser({ googleSub: null, googleSubCheckedAt: null })
      stubAutonomous(() => new Response(
        `{"status":1,"data":{"id":"${CUSTOMER_ID}","email":"${EMAIL}","customer_socials":[{"source":"google","uid":104857600000000000042}]}}`,
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ))

      expect((await get('/api/grid/profile', autonomousToken())).statusCode).toBe(503)
      expect(fakes.users.get('known')!.googleSubCheckedAt).toBeNull()
    })

    it('refuses a staging-plane sign-in with 403', async () => {
      seedUser({ autonomousEnv: 'stag', stagExternalId: 'stag-1' })
      vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => json(200, { status: 1, data: { id: 'stag-1', email: EMAIL } })))

      const res = await get('/api/grid/profile', autonomousToken(), { 'x-autonomous-env': 'stag' })

      expect(res.statusCode).toBe(403)
    })
  })

  describe('a computer sign-in', () => {
    it('is refused with 409 when the account was never checked — and nothing else on this route is a 409', async () => {
      seedUser()
      vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => { throw new Error('a computer sign-in asks nobody') }))

      const res = await get('/api/grid/profile', await computerToken('known'))

      expect(res.statusCode).toBe(409)
      expect(JSON.stringify(res.json())).not.toContain(EMAIL)
    })

    it('answers the stored values for an account checked and found to have no Google identity', async () => {
      seedUser({ googleSub: null, googleSubCheckedAt: new Date() })

      const res = await get('/api/grid/profile', await computerToken('known'))

      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ status: 1, data: { id: CUSTOMER_ID, email: EMAIL, full_name: FULL_NAME, customer_socials: [] } })
    })

    it('refuses an account on the staging plane with 403', async () => {
      seedUser({ autonomousEnv: 'stag', googleSub: GOOGLE_SUB, googleSubCheckedAt: new Date() })
      expect((await get('/api/grid/profile', await computerToken('known'))).statusCode).toBe(403)
    })

    it('refuses a provisional customer id with 403', async () => {
      seedUser({ externalId: 'local-prod-0b5c', googleSub: null, googleSubCheckedAt: new Date() })
      expect((await get('/api/grid/profile', await computerToken('known'))).statusCode).toBe(403)

      fakes.users.clear()
      seedUser({ email: `device-${CUSTOMER_ID}@pending.harness.invalid`, googleSub: null, googleSubCheckedAt: new Date() })
      expect((await get('/api/grid/profile', await computerToken('known'))).statusCode).toBe(403)
    })

    it('takes no parameter naming an account', async () => {
      seedUser({ googleSub: GOOGLE_SUB, googleSubCheckedAt: new Date() })
      fakes.users.set('other', { id: 'other', email: 'other@example.com', externalId: 'other-customer', role: 'user', autonomousEnv: 'prod', googleSub: '999', googleSubCheckedAt: new Date() })

      const res = await get('/api/grid/profile?email=other@example.com&id=other&userId=other', await computerToken('known'))

      expect(res.json()).toEqual(contract)
    })
  })

  it('refuses a phone sign-in with 403', async () => {
    seedUser({ googleSub: GOOGLE_SUB, googleSubCheckedAt: new Date() })
    expect((await get('/api/grid/profile', await phoneToken('known'))).statusCode).toBe(403)
  })

  it('does not stamp the user country — the caller is the control plane, not the person', async () => {
    seedUser({ googleSub: GOOGLE_SUB, googleSubCheckedAt: new Date() })
    stubAutonomous(googleProfile())

    await get('/api/grid/profile', autonomousToken('x', 'n1'), { 'cf-ipcountry': 'US' })
    await get('/api/grid/profile', await computerToken('known'), { 'cf-ipcountry': 'US' })
    expect(fakes.stampUserCountry).not.toHaveBeenCalled()

    await get('/api/anything', autonomousToken('x', 'n2'), { 'cf-ipcountry': 'VN' })
    expect(fakes.stampUserCountry).toHaveBeenCalledWith('known', 'VN')
  })

  it('never copies a social token, nor logs any part of the profile body', async () => {
    seedUser({ googleSub: 'stale-sub', googleSubCheckedAt: new Date(Date.now() - GOOGLE_SUBJECT_RECHECK_MS - 1) })
    stubAutonomous(googleProfile())

    const live = await get('/api/grid/profile', autonomousToken('x', 'n1'))
    await get('/api/anything', autonomousToken('x', 'n2'))
    await settle()
    const stored = await get('/api/grid/profile', await computerToken('known'))

    expect(leaked(live.body)).toEqual([])
    expect(leaked(stored.body)).toEqual([])
    const all = logs.join('\n')
    expect(leaked(all)).toEqual([])
    for (const value of [GOOGLE_SUB, 'stale-sub', EMAIL, CUSTOMER_ID, FULL_NAME]) expect(all).not.toContain(value)
  })

  describe('a stored Google subject is always the row\'s own customer\'s', () => {
    it('forgets it when the row takes a new production subject, so a computer sign-in is "not yet known"', async () => {
      seedUser({ googleSub: GOOGLE_SUB, googleSubCheckedAt: new Date() })
      // Another Autonomous customer reaching the same email; its own profile read fails, so nothing
      // fresher replaces what is forgotten.
      stubAutonomous(() => json(502, {}), () => json(200, { status: 1, data: { id: 'another-customer', email: EMAIL } }))

      await get('/api/anything', autonomousToken())
      await settle()

      expect(fakes.users.get('known')).toMatchObject({ externalId: 'another-customer', googleSub: null, googleSubCheckedAt: null })
      expect((await get('/api/grid/profile', await computerToken('known'))).statusCode).toBe(409)
    })

    it('does not record a live read of another customer than the row, and says so by field name', async () => {
      seedUser({ googleSub: GOOGLE_SUB, googleSubCheckedAt: new Date(Date.now() - GOOGLE_SUBJECT_RECHECK_MS - 1) })
      stubAutonomous(() => json(200, { status: 1, data: { id: 'another-customer', email: EMAIL, customer_socials: [{ source: 'google', uid: '7' }] } }))

      await get('/api/anything', autonomousToken())
      await settle()

      expect(fakes.users.get('known')!.googleSub).toBe(GOOGLE_SUB)
      const lines = logs.filter((l) => l.includes('another customer'))
      expect(lines).toHaveLength(1)
      expect(lines[0]).toContain('customer_id')
      expect(lines[0]).not.toContain('another-customer')
    })

    it('never lets a slower read replace a fresher one', async () => {
      const fresh = new Date()
      seedUser({ googleSub: GOOGLE_SUB, googleSubCheckedAt: fresh })
      const stored = { ...fakes.users.get('known')! } as never

      await recordLiveProfile(stored, { customerId: CUSTOMER_ID, email: EMAIL, fullName: FULL_NAME, googleSub: null }, new Date(fresh.getTime() - 1000))

      expect(fakes.users.get('known')).toMatchObject({ googleSub: GOOGLE_SUB, googleSubCheckedAt: fresh })
    })
  })

  it(`allows ${GRID_PROFILE_LIVE_READS_PER_MINUTE} live reads a minute per account, then 429 — never 409`, async () => {
    seedUser({ googleSub: GOOGLE_SUB, googleSubCheckedAt: new Date() })
    const autonomous = stubAutonomous(googleProfile())
    const token = autonomousToken()

    for (let i = 0; i < GRID_PROFILE_LIVE_READS_PER_MINUTE; i++) expect((await get('/api/grid/profile', token)).statusCode).toBe(200)
    expect((await get('/api/grid/profile', token)).statusCode).toBe(429)
    expect(autonomous.profileReads()).toBe(GRID_PROFILE_LIVE_READS_PER_MINUTE)
    // A computer sign-in reads nothing upstream and is not counted.
    expect((await get('/api/grid/profile', await computerToken('known'))).statusCode).toBe(200)
  })

  it('tells every cache in between not to keep the answer', async () => {
    seedUser({ googleSub: GOOGLE_SUB, googleSubCheckedAt: new Date() })
    const res = await get('/api/grid/profile', await computerToken('known'))
    expect(res.headers['cache-control']).toBe('no-store')
    expect((await get('/api/grid/profile', await phoneToken('known'))).headers['cache-control']).toBe('no-store')
  })

  describe('the stored-versus-live check', () => {
    it('logs one line naming the fields that disagree, never a value', async () => {
      seedUser({ googleSub: 'stale-sub', googleSubCheckedAt: new Date(Date.now() - 60_000) })
      stubAutonomous(googleProfile())

      await get('/api/grid/profile', autonomousToken())

      const lines = logs.filter((l) => l.includes('stored and live'))
      expect(lines).toHaveLength(1)
      expect(lines[0]).toContain('google_sub')
      expect(lines[0]).not.toContain('stale-sub')
      expect(lines[0]).not.toContain(GOOGLE_SUB)
      expect(fakes.users.get('known')!.googleSub).toBe(GOOGLE_SUB)
    })

    it('logs one line from the fill as well, and overwrites to "none"', async () => {
      seedUser({ googleSub: GOOGLE_SUB, googleSubCheckedAt: new Date(Date.now() - GOOGLE_SUBJECT_RECHECK_MS - 1) })
      stubAutonomous(googleProfile(null))

      await get('/api/anything', autonomousToken())
      await settle()

      expect(logs.filter((l) => l.includes('stored and live'))).toHaveLength(1)
      expect(fakes.users.get('known')!.googleSub).toBeNull()
    })

    it('logs nothing when they agree, nor on the first check', async () => {
      seedUser()
      stubAutonomous(googleProfile())

      await get('/api/anything', autonomousToken('x', 'n1'))
      await settle()
      await get('/api/grid/profile', autonomousToken('x', 'n2'))

      expect(logs.filter((l) => l.includes('stored and live'))).toEqual([])
    })
  })
})

describe('the user shape every user-describing response is built from', () => {
  it('leaves out the Google subject and when it was checked', () => {
    const row = {
      id: 'u1', email: EMAIL, externalId: CUSTOMER_ID, passwordHash: 'h', googleSub: GOOGLE_SUB, googleSubCheckedAt: new Date(),
    } as unknown as Parameters<typeof userService.toPublic>[0]
    const shown = userService.toPublic(row) as Record<string, unknown>
    expect(shown).not.toHaveProperty('googleSub')
    expect(shown).not.toHaveProperty('googleSubCheckedAt')
    expect(shown).not.toHaveProperty('passwordHash')
    expect(shown).toMatchObject({ id: 'u1', email: EMAIL })
  })
})
