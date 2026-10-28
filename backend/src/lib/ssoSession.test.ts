import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'

// Harness sessions an SSO sign-in backs (lib/ssoSession.ts): the CLI and Desktop sign in through SSO once and then
// hold a Harness session, while the backend keeps the person's SSO refresh token and re-checks it hourly.
//
// Redis, the sessions collection and the account service's token endpoint are faked; everything between them —
// the routes, the session code, the encryption, the SSO identity check — is the real code.
const fakes = vi.hoisted(() => {
  const redis = new Map<string, string>()
  const sessions: Array<Record<string, unknown> & { id: string }> = []
  const users = new Map<string, Record<string, unknown>>()
  let failCreate = false
  const field = (s: Record<string, unknown>, k: string, v: unknown): boolean => {
    if (v !== null && typeof v === 'object' && 'isSet' in v) return (k in s && s[k] !== undefined) === (v as { isSet: boolean }).isSet
    if (v === null) return s[k] === null || s[k] === undefined
    return k in s && s[k] === v
  }
  const matches = (s: Record<string, unknown>, w: Record<string, unknown>): boolean => Object.entries(w).every(([k, v]) =>
    k === 'OR' ? (v as Record<string, unknown>[]).some((o) => matches(s, o)) : field(s, k, v))
  const pub = {
    set: vi.fn(async (key: string, value: string, ...args: unknown[]) => {
      if (args.includes('NX') && redis.has(key)) return null
      redis.set(key, value); return 'OK'
    }),
    get: vi.fn(async (key: string) => redis.get(key) ?? null),
    del: vi.fn(async (key: string) => (redis.delete(key) ? 1 : 0)),
    // The lock's compare-and-delete (lib/ssoSession.ts RELEASE_SCRIPT).
    eval: vi.fn(async (_script: string, _n: number, key: string, owner: string) => (redis.get(key) === owner && redis.delete(key) ? 1 : 0)),
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
      if (failCreate) throw new Error('mongo down')
      const row = { id: `s${sessions.length + 1}`, createdAt: new Date(), lastUsedAt: new Date(), ...data }
      sessions.push(row); return row
    }),
    findUnique: vi.fn(async ({ where }: { where: Record<string, unknown> }) => sessions.find((s) => matches(s, where)) ?? null),
    update: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      const row = sessions.find((s) => matches(s, where)); if (!row) throw new Error('no row'); Object.assign(row, data); return row
    }),
    updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      const rows = sessions.filter((s) => matches(s, where)); rows.forEach((r) => Object.assign(r, data)); return { count: rows.length }
    }),
  }
  const machine = { findMany: vi.fn(async () => []), findFirst: vi.fn(async () => null), updateMany: vi.fn(async () => ({ count: 0 })) }
  // The account service's token endpoint: which refresh tokens it still honours, and what it answers.
  const sso = {
    live: new Map<string, string>(), // refresh token → the account's email
    rotate: true,
    down: false,
    calls: 0,
    counter: 0,
    /** While set, the token endpoint holds every answer until it settles: a renewal in flight. */
    gate: null as Promise<void> | null,
  }
  const logLines: string[] = []
  return {
    redis, sessions, users, pub, harnessSession, machine, sso, logLines,
    setFailCreate: (v: boolean) => { failCreate = v },
    get: vi.fn(async (id: string) => users.get(id) ?? null),
  }
})

vi.mock('./bus.js', () => ({ pub: fakes.pub, publishDown: vi.fn(async () => 1) }))
vi.mock('./deviceKeyLog.js', () => ({ activeMachineKeys: vi.fn(async () => []) }))
vi.mock('./googleSubject.js', () => ({ scheduleGoogleSubjectFill: vi.fn() }))
vi.mock('./prisma.js', () => ({
  prisma: { harnessSession: fakes.harnessSession, machine: fakes.machine, $transaction: vi.fn(async (body: (tx: unknown) => unknown) =>
    body({ harnessSession: fakes.harnessSession, machine: fakes.machine })) },
  machineAlive: { OR: [{ deletedAt: null }, { deletedAt: { isSet: false } }] },
}))
const userService = vi.hoisted(() => ({
  get: (id: string) => fakes.get(id),
  findByEmail: vi.fn(async (email: string) => [...fakes.users.values()].find((u) => u.email === email) ?? null),
  findByExternal: vi.fn(async () => null),
  upsertFromSso: vi.fn(async ({ email }: { email: string }) => [...fakes.users.values()].find((u) => u.email === email)),
  recordSignInAttribution: vi.fn(async () => undefined),
  toPublic: (u: unknown) => u,
}))
vi.mock('../services/UserService.js', () => ({
  userService,
  normalizeUserEmail: (email: string) => email.trim().toLowerCase(),
  isProvisionalUserEmail: () => false,
}))
vi.mock('../services/index.js', () => ({ userService }))
// Every log line, as text, so no test can miss a token written into one.
vi.mock('../utils/logger.js', () => {
  const line = (level: string) => (message: string, ...rest: unknown[]) => {
    fakes.logLines.push(`${level} ${message} ${rest.map((r) => (r instanceof Error ? `${r.message} ${r.stack}` : JSON.stringify(r))).join(' ')}`)
  }
  return { logger: { debug: line('debug'), info: line('info'), warn: line('warn'), error: line('error') } }
})
// The account service's token endpoint (lib/sso.ts requestTokens), as the fake above decides.
vi.mock('./sso.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./sso.js')>()
  const grant = (email: string) => {
    fakes.sso.counter++
    const access = `sso-access-${fakes.sso.counter}`
    accessEmails.set(access, email)
    return { access_token: access, expires_in: 3600 }
  }
  const accessEmails = new Map<string, string>()
  ;(globalThis as { __ssoAccessEmails?: Map<string, string> }).__ssoAccessEmails = accessEmails
  return {
    ...actual,
    consumeTx: vi.fn(async (tx: string) => (tx === 'tx-1'
      ? { verifier: 'v', state: 'st', next: '/', redirectUri: 'http://127.0.0.1:1/cb', webOrigin: 'http://127.0.0.1:1', autonomousEnv: 'prod', clientId: 'harness-cli' }
      : null)),
    exchangeCode: vi.fn(async (code: string) => {
      if (code !== 'code-dee') throw new actual.SsoTokenError('bad code', 'INVALID_GRANT')
      const refresh = `sso-refresh-${fakes.sso.counter + 1}`
      fakes.sso.live.set(refresh, 'dee@example.com')
      return { ...grant('dee@example.com'), refresh_token: refresh }
    }),
    refreshAccessToken: vi.fn(async (refreshToken: string) => {
      fakes.sso.calls++
      if (fakes.sso.gate) await fakes.sso.gate
      if (fakes.sso.down) throw new actual.SsoTokenError('SSO token service unavailable', 'TOKEN_SERVICE_UNAVAILABLE')
      const email = fakes.sso.live.get(refreshToken)
      if (!email) throw new actual.SsoTokenError('SSO token endpoint returned 400', 'INVALID_GRANT')
      const tokens: Record<string, unknown> = grant(email)
      if (fakes.sso.rotate) {
        fakes.sso.live.delete(refreshToken)
        const next = `sso-refresh-${fakes.sso.counter}-r`
        fakes.sso.live.set(next, email)
        tokens.refresh_token = next
      }
      return tokens
    }),
  }
})

import { clearSsoProfileCache, authenticateAccessToken, SsoAuthError } from './ssoAuth.js'
import { refreshHarnessSession, revokeHarnessSession } from './harnessSession.js'
import { decryptMachineCredential } from './machineCredential.js'
import { SSO_OUTAGE_GRACE_MS, SSO_RECHECK_MS, ensureHarnessSessionExpiry, ssoAccessTokenFor } from './ssoSession.js'
import { authRoutes } from '../routes/auth.js'
import { registerAuthMiddleware } from '../middlewares/authMiddleware.js'
import { errorHandler } from '../middlewares/errorHandler.js'

const USER = { id: 'u1', email: 'dee@example.com', role: 'user', autonomousEnv: 'prod', externalId: 'ext-dee' }
const HOUR = 60 * 60_000

// The profile service answers for the SSO access tokens the fake token endpoint issued.
function stubProfileService(): void {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    const auth = String((init?.headers as Record<string, string>)?.Authorization ?? '')
    const email = (globalThis as { __ssoAccessEmails?: Map<string, string> }).__ssoAccessEmails!.get(auth.replace(/^Bearer /, ''))
    if (!email) return new Response('{}', { status: 401 })
    return new Response(JSON.stringify({ status: 1, data: { id: 'ext-dee', email } }), { status: 200 })
  })
}

let app: FastifyInstance

beforeEach(async () => {
  vi.useRealTimers()
  fakes.redis.clear(); fakes.sessions.length = 0; fakes.users.clear(); fakes.logLines.length = 0
  fakes.users.set(USER.id, USER)
  fakes.sso.live.clear(); fakes.sso.rotate = true; fakes.sso.down = false; fakes.sso.calls = 0; fakes.sso.counter = 0; fakes.sso.gate = null
  fakes.setFailCreate(false)
  clearSsoProfileCache()
  vi.clearAllMocks()
  stubProfileService()
  app = Fastify()
  app.setErrorHandler(errorHandler)
  registerAuthMiddleware(app, authenticateAccessToken)
  await app.register(authRoutes)
  await app.ready()
})

afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  await app.close()
})

const ASK_COMPUTER = { kind: 'computer', label: 'Dee’s Mac' }

/** Sign in through SSO as today's CLI does, asking (or not) for a Harness session. */
async function signIn(harnessSession?: unknown) {
  const res = await app.inject({ method: 'POST', url: '/api/auth/exchange', payload: {
    code: 'code-dee', state: 'st', tx: 'tx-1', ...(harnessSession ? { harnessSession } : {}),
  } })
  return { status: res.statusCode, data: res.json().data as Record<string, unknown> }
}

async function refresh(refreshToken: unknown, extra: Record<string, unknown> = {}) {
  const res = await app.inject({ method: 'POST', url: '/api/auth/refresh', payload: { refreshToken, autonomousEnv: 'prod', ...extra } })
  return { status: res.statusCode, body: res.json() as { data?: Record<string, unknown>; error?: { code?: string; message?: string } } }
}

async function me(token: unknown) {
  return (await app.inject({ method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${String(token)}` } })).statusCode
}

describe('signing in: SSO once, then a Harness session', () => {
  it('trades the SSO sign-in for a Harness computer session and keeps the SSO refresh token on the server, encrypted', async () => {
    const { status, data } = await signIn(ASK_COMPUTER)
    expect(status).toBe(200)
    expect(data.token).toMatch(/^hna_/)
    expect(data.refreshToken).toMatch(/^hnr_/)
    expect(data).toMatchObject({ kind: 'computer', expiresIn: 3600, autonomousEnv: 'prod', harnessSession: true })
    // The SSO tokens never reach the client.
    expect(JSON.stringify(data)).not.toMatch(/sso-/)

    const [row] = fakes.sessions
    expect(row).toMatchObject({ userId: USER.id, kind: 'computer', label: 'Dee’s Mac', ssoEnv: 'prod', ssoClientId: 'harness-cli' })
    // Naming no computer: this session is never "the computer's own sign-in" (routes/auth.ts isThisComputer).
    expect(row.computerId).toBeUndefined()
    expect(String(row.ssoRefresh)).not.toContain('sso-refresh')
    expect(decryptMachineCredential(String(row.ssoRefresh))).toBe('sso-refresh-1')
    expect(row.ssoCheckedAt).toBeInstanceOf(Date)

    // The Harness tokens work, and refresh without asking SSO.
    expect(await me(data.token)).toBe(200)
    const renewed = await refresh(data.refreshToken)
    expect(renewed.status).toBe(200)
    expect(renewed.body.data!.token).toMatch(/^hna_/)
    expect(fakes.sso.calls).toBe(0)
  })

  it('answers a sign-in that asks for nothing exactly as before: the SSO tokens', async () => {
    const { status, data } = await signIn()
    expect(status).toBe(200)
    expect(data).toMatchObject({ token: 'sso-access-1', refreshToken: 'sso-refresh-1' })
    expect(data.harnessSession).toBeUndefined()
    expect(fakes.sessions).toHaveLength(0)
  })

  it('a Desktop with no CLI asks for a viewer session, which may not connect as a machine', async () => {
    const { data } = await signIn({ kind: 'viewer', label: 'Desktop' })
    expect(data.kind).toBe('viewer')
    await expect(authenticateAccessToken(String(data.token), 'prod', { allowHarnessSession: 'computer' }))
      .rejects.toMatchObject({ code: 'INVALID_TOKEN' })
  })

  it('refuses to make anything else, and never a team session', async () => {
    for (const ask of [{ kind: 'team', label: 'x' }, { kind: 'computer', label: 7 }, 'computer']) {
      const res = await app.inject({ method: 'POST', url: '/api/auth/exchange', payload: { code: 'code-dee', state: 'st', tx: 'tx-1', harnessSession: ask } })
      expect(res.statusCode).toBe(400)
    }
    expect(fakes.sessions).toHaveLength(0)
  })

  it('still signs in with the SSO tokens when the session cannot be made', async () => {
    fakes.setFailCreate(true)
    const { status, data } = await signIn(ASK_COMPUTER)
    expect(status).toBe(200)
    expect(data).toMatchObject({ token: 'sso-access-1', refreshToken: 'sso-refresh-1' })
    expect(fakes.logLines.join('\n')).toMatch(/harness session not made/)
  })
})

describe('moving a signed-in CLI over, silently', () => {
  it('a session from before the upgrade stays signed in: its next renewal turns it into a Harness session', async () => {
    // Today's CLI: signed in through SSO, holding SSO tokens.
    const before = await signIn()
    expect(await me(before.data.token)).toBe(200)

    // The upgraded CLI renews as it always does, asking for a Harness session.
    const moved = await refresh(before.data.refreshToken, { harnessSession: ASK_COMPUTER })
    expect(moved.status).toBe(200)
    expect(moved.body.data!.token).toMatch(/^hna_/)
    expect(moved.body.data!.refreshToken).toMatch(/^hnr_/)
    expect(moved.body.data!.harnessSession).toBe(true)
    // The server holds the SSO refresh token the renewal rotated to; the client never sees it.
    expect(decryptMachineCredential(String(fakes.sessions[0]!.ssoRefresh))).toBe('sso-refresh-2-r')
    expect(JSON.stringify(moved.body)).not.toMatch(/sso-/)

    expect(await me(moved.body.data!.token)).toBe(200)
    const again = await refresh(moved.body.data!.refreshToken)
    expect(again.status).toBe(200)
  })

  it('an old CLI that asks for nothing renews its SSO tokens exactly as before', async () => {
    const before = await signIn()
    const renewed = await refresh(before.data.refreshToken)
    expect(renewed.status).toBe(200)
    expect(renewed.body.data).toMatchObject({ token: 'sso-access-2', refreshToken: 'sso-refresh-2-r' })
    expect(fakes.sessions).toHaveLength(0)
  })

  it('when the session cannot be made, hands back the renewed SSO tokens rather than losing the rotated one', async () => {
    const before = await signIn()
    fakes.setFailCreate(true)
    const renewed = await refresh(before.data.refreshToken, { harnessSession: ASK_COMPUTER })
    expect(renewed.status).toBe(200)
    expect(renewed.body.data).toMatchObject({ token: 'sso-access-2', refreshToken: 'sso-refresh-2-r' })
    // And that SSO sign-in still works.
    expect(await me(renewed.body.data!.token)).toBe(200)
  })
})

describe('the hourly SSO re-check', () => {
  async function harnessSignIn() {
    const { data } = await signIn(ASK_COMPUTER)
    return { token: String(data.token), refreshToken: String(data.refreshToken) }
  }

  it('asks SSO at most once an hour, saving the refresh token it rotates to', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const { refreshToken } = await harnessSignIn()
    vi.setSystemTime(Date.now() + SSO_RECHECK_MS - 60_000)
    expect((await refresh(refreshToken)).status).toBe(200)
    expect(fakes.sso.calls).toBe(0)

    vi.setSystemTime(Date.now() + 2 * 60_000)
    expect((await refresh(refreshToken)).status).toBe(200)
    expect(fakes.sso.calls).toBe(1)
    const row = fakes.sessions[0]!
    expect(decryptMachineCredential(String(row.ssoRefresh))).toBe('sso-refresh-2-r')
    expect((row.ssoCheckedAt as Date).getTime()).toBe(Date.now())
    expect(row.ssoRenewingAt ?? null).toBeNull()
  })

  it('keeps the refresh token when SSO does not rotate it', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    fakes.sso.rotate = false
    const { refreshToken } = await harnessSignIn()
    vi.setSystemTime(Date.now() + SSO_RECHECK_MS + 1)
    expect((await refresh(refreshToken)).status).toBe(200)
    expect(decryptMachineCredential(String(fakes.sessions[0]!.ssoRefresh))).toBe('sso-refresh-1')
  })

  it('signing out of SSO (or a disabled account) ends the session within two hours, access token included', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const start = Date.now()
    const { refreshToken } = await harnessSignIn()
    // The last access token issued before the next check.
    vi.setSystemTime(start + SSO_RECHECK_MS - 1)
    const last = String((await refresh(refreshToken)).body.data!.token)
    // The person signs out of Autonomous, or the account is disabled: its refresh tokens stop working.
    fakes.sso.live.clear()

    vi.setSystemTime(start + SSO_RECHECK_MS + 1)
    const refused = await refresh(refreshToken)
    expect(refused.status).toBe(401)
    expect(refused.body.error?.code).toBe('REFRESH_TOKEN_INVALID')
    // At once, not when that access token runs out.
    expect(await me(last)).toBe(401)
    // The stored SSO tokens are gone with it.
    const row = fakes.sessions[0]!
    expect(row.revokedAt).toBeInstanceOf(Date)
    expect(row.ssoRefresh ?? null).toBeNull()
    expect(row.ssoAccess ?? null).toBeNull()
    expect(Date.now() - start).toBeLessThan(2 * HOUR)
  })

  it('SSO being down keeps people signed in, for seven days from the last good check', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const start = Date.now()
    const { refreshToken } = await harnessSignIn()
    fakes.sso.down = true

    for (const at of [SSO_RECHECK_MS + 1, 3 * 24 * HOUR, SSO_OUTAGE_GRACE_MS - 60_000]) {
      vi.setSystemTime(start + at)
      const renewed = await refresh(refreshToken)
      expect(renewed.status).toBe(200)
      expect(await me(renewed.body.data!.token)).toBe(200)
    }
    expect(fakes.sessions[0]!.revokedAt ?? null).toBeNull()

    // Past the grace: unavailable and retrying — never a sign-in prompt, and the session is kept.
    vi.setSystemTime(start + SSO_OUTAGE_GRACE_MS + 1)
    const late = await refresh(refreshToken)
    expect(late.status).toBe(503)
    expect(late.body.error?.code).toBe('AUTH_SERVICE_UNAVAILABLE')
    expect(late.body.error?.message).toMatch(/unavailable.*retrying/i)
    expect(fakes.sessions[0]!.revokedAt ?? null).toBeNull()

    // SSO back: the next renewal checks and carries on.
    fakes.sso.down = false
    const back = await refresh(refreshToken)
    expect(back.status).toBe(200)
  })

  it('a refusal after a renewal that never finished is not a sign-out', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const start = Date.now()
    const { refreshToken } = await harnessSignIn()
    // A renewal that reached SSO and was lost before its rotated token was saved (a pod died, Mongo failed): the
    // token the session holds is spent, and SSO refuses it — through no doing of the person.
    fakes.sessions[0]!.ssoRenewingAt = new Date(start)
    fakes.sso.live.clear()

    vi.setSystemTime(start + SSO_RECHECK_MS + 1)
    const renewed = await refresh(refreshToken)
    expect(renewed.status).toBe(200)
    expect(fakes.sessions[0]!.revokedAt ?? null).toBeNull()
    // Counted as unavailable: the grace still runs from the last good check.
    vi.setSystemTime(start + SSO_OUTAGE_GRACE_MS + 1)
    expect((await refresh(refreshToken)).status).toBe(503)
  })

  it('a renewal that fails leaves its mark, so a later refusal is not read as a sign-out', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const start = Date.now()
    const { refreshToken } = await harnessSignIn()
    fakes.sso.down = true
    vi.setSystemTime(start + SSO_RECHECK_MS + 1)
    expect((await refresh(refreshToken)).status).toBe(200)
    expect(fakes.sessions[0]!.ssoRenewingAt).toBeInstanceOf(Date)

    // The failed call may have rotated the token before it failed: a refusal now is ambiguous.
    fakes.sso.down = false
    fakes.sso.live.clear()
    vi.setSystemTime(start + 2 * SSO_RECHECK_MS + 2)
    expect((await refresh(refreshToken)).status).toBe(200)
    expect(fakes.sessions[0]!.revokedAt ?? null).toBeNull()
  })

  it('two renewals at once ask SSO once: the second neither waits nor burns the token', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const { refreshToken } = await harnessSignIn()
    vi.setSystemTime(Date.now() + SSO_RECHECK_MS + 1)
    let open!: () => void
    fakes.sso.gate = new Promise<void>((resolve) => { open = resolve })
    const first = refresh(refreshToken)
    await vi.waitFor(() => expect(fakes.sso.calls).toBe(1))
    // The first is still waiting on SSO: the second goes on without asking, on the grace.
    const second = await refresh(refreshToken)
    expect(second.status).toBe(200)
    expect(fakes.sso.calls).toBe(1)
    open()
    expect((await first).status).toBe(200)
    expect(fakes.sso.calls).toBe(1)
    expect(decryptMachineCredential(String(fakes.sessions[0]!.ssoRefresh))).toBe('sso-refresh-2-r')
    // The lock is released once the renewal is saved.
    expect([...fakes.redis.keys()].some((k) => k.startsWith('hnauth:ssorenew:'))).toBe(false)
  })

  it('an SSO answer for another account is not this session: counted as unavailable, not as a sign-out', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const { refreshToken } = await harnessSignIn()
    fakes.users.set('u2', { id: 'u2', email: 'someone-else@example.com', role: 'user', autonomousEnv: 'prod' })
    for (const [token] of fakes.sso.live) fakes.sso.live.set(token, 'someone-else@example.com')
    vi.setSystemTime(Date.now() + SSO_RECHECK_MS + 1)
    expect((await refresh(refreshToken)).status).toBe(200)
    const row = fakes.sessions[0]!
    expect(row.revokedAt ?? null).toBeNull()
    // Nothing of the other account's sign-in is kept on this person's session.
    expect(decryptMachineCredential(String(row.ssoRefresh))).toBe('sso-refresh-1')
    expect(row.ssoRenewingAt).toBeInstanceOf(Date)
  })

  it('a renewal SSO answers but whose identity cannot be read keeps the rotated token, without counting as a check', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const start = Date.now()
    const { refreshToken } = await harnessSignIn()
    // The token endpoint answers; the profile service does not.
    vi.mocked(globalThis.fetch).mockImplementation(async () => new Response('', { status: 502 }))
    vi.setSystemTime(start + SSO_RECHECK_MS + 1)
    expect((await refresh(refreshToken)).status).toBe(200)
    const row = fakes.sessions[0]!
    expect(decryptMachineCredential(String(row.ssoRefresh))).toBe('sso-refresh-2-r')
    expect(row.ssoRenewingAt ?? null).toBeNull()
    expect((row.ssoCheckedAt as Date).getTime()).toBe(start)
  })

  it('a session from the phone QR is never re-checked: it has no SSO sign-in behind it', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const { data } = await signIn(ASK_COMPUTER)
    delete fakes.sessions[0]!.ssoRefresh
    vi.setSystemTime(Date.now() + 30 * 24 * HOUR)
    expect(await refreshHarnessSession(String(data.refreshToken))).toMatchObject({ expiresIn: 3600 })
    expect(fakes.sso.calls).toBe(0)
  })
})

describe('signing out', () => {
  it('ends the session and deletes the stored SSO tokens', async () => {
    const { data } = await signIn(ASK_COMPUTER)
    const res = await app.inject({ method: 'POST', url: '/api/auth/revoke', payload: { refreshToken: data.refreshToken } })
    expect(res.statusCode).toBe(200)
    expect(await me(data.token)).toBe(401)
    expect((await refresh(data.refreshToken)).status).toBe(401)
    const row = fakes.sessions[0]!
    expect(row.ssoRefresh ?? null).toBeNull()
    expect(row.ssoAccess ?? null).toBeNull()
  })

  it('removing the device ends it the same way', async () => {
    const { data } = await signIn(ASK_COMPUTER)
    const { revokeHarnessSessionById } = await import('./harnessSession.js')
    await revokeHarnessSessionById(fakes.sessions[0]!.id, USER.id)
    expect(await me(data.token)).toBe(401)
    expect(fakes.sessions[0]!.ssoRefresh ?? null).toBeNull()
  })

  it('a session naming no computer cannot turn one into a team machine without its machine key', async () => {
    const { data } = await signIn(ASK_COMPUTER)
    const res = await app.inject({ method: 'POST', url: '/api/auth/handoff', headers: { authorization: `Bearer ${String(data.token)}` },
      payload: { kind: 'team', computerId: 'a1b2c3d4e5f60718' } })
    expect(res.statusCode).toBe(403)
    expect(res.json().error.code).toBe('HANDOFF_NOT_ALLOWED')
  })
})

describe('billing, which still needs an SSO access token', () => {
  it('is given the stored one while it lasts, and a renewed one after', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    await signIn(ASK_COMPUTER)
    const id = fakes.sessions[0]!.id
    expect(await ssoAccessTokenFor(id, USER.id)).toBe('sso-access-1')
    expect(fakes.sso.calls).toBe(0)
    vi.setSystemTime(Date.now() + 2 * HOUR)
    expect(await ssoAccessTokenFor(id, USER.id)).toBe('sso-access-2')
    expect(fakes.sso.calls).toBe(1)
    expect(decryptMachineCredential(String(fakes.sessions[0]!.ssoRefresh))).toBe('sso-refresh-2-r')
  })

  it('is given nothing for another account’s session, an ended one, or a QR sign-in', async () => {
    const { data } = await signIn(ASK_COMPUTER)
    const id = fakes.sessions[0]!.id
    expect(await ssoAccessTokenFor(id, 'someone-else')).toBeNull()
    await revokeHarnessSession(String(data.refreshToken))
    expect(await ssoAccessTokenFor(id, USER.id)).toBeNull()
    expect(await ssoAccessTokenFor('nope', USER.id)).toBeNull()
  })

  it('says unavailable, not signed out, when SSO cannot renew it', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    await signIn(ASK_COMPUTER)
    fakes.sso.down = true
    vi.setSystemTime(Date.now() + 2 * HOUR)
    await expect(ssoAccessTokenFor(fakes.sessions[0]!.id, USER.id)).rejects.toBeInstanceOf(SsoAuthError)
    expect(fakes.sessions[0]!.revokedAt ?? null).toBeNull()
  })
})

describe('old sessions', () => {
  it('an ended session expires at once, so the expiry index deletes it 30 days on, like one that ran out idle', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const { data } = await signIn(ASK_COMPUTER)
    expect((fakes.sessions[0]!.expiresAt as Date).getTime()).toBeGreaterThan(Date.now() + 89 * 24 * HOUR)
    await revokeHarnessSession(String(data.refreshToken))
    expect((fakes.sessions[0]!.expiresAt as Date).getTime()).toBe(Date.now())

    // MongoDB's own expiry: a row goes 30 days after its `expiresAt`.
    const runCommandRaw = vi.fn(async () => ({ ok: 1 }))
    await ensureHarnessSessionExpiry({ $runCommandRaw: runCommandRaw } as never)
    expect(runCommandRaw).toHaveBeenCalledWith({ createIndexes: 'harness_sessions', indexes: [
      { key: { expiresAt: 1 }, name: 'harness_session_expiry', expireAfterSeconds: 30 * 24 * 60 * 60 },
    ] })
  })
})

describe('no token is ever logged', () => {
  it('across sign-in, move-over, renewal, outage, refusal and sign-out', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const seen: string[] = []
    const keep = (data: Record<string, unknown> | undefined) => {
      for (const v of [data?.token, data?.refreshToken]) if (typeof v === 'string') seen.push(v)
    }
    const a = await signIn(ASK_COMPUTER); keep(a.data)
    const b = await signIn(); keep(b.data)
    const moved = await refresh(b.data.refreshToken, { harnessSession: ASK_COMPUTER }); keep(moved.body.data)
    vi.setSystemTime(Date.now() + SSO_RECHECK_MS + 1)
    keep((await refresh(a.data.refreshToken)).body.data)
    fakes.sso.down = true
    vi.setSystemTime(Date.now() + SSO_RECHECK_MS + 1)
    keep((await refresh(moved.body.data!.refreshToken)).body.data)
    fakes.sso.down = false
    fakes.sso.live.clear()
    vi.setSystemTime(Date.now() + SSO_RECHECK_MS + 1)
    await refresh(a.data.refreshToken)
    await app.inject({ method: 'POST', url: '/api/auth/revoke', payload: { refreshToken: moved.body.data!.refreshToken } })
    fakes.setFailCreate(true)
    keep((await signIn(ASK_COMPUTER)).data)

    // Every SSO token the fake service issued, and every Harness token handed out.
    for (let i = 1; i <= fakes.sso.counter; i++) seen.push(`sso-access-${i}`, `sso-refresh-${i}`)
    for (const row of fakes.sessions) if (typeof row.ssoRefresh === 'string') seen.push(row.ssoRefresh)
    expect(seen.filter((t) => t.startsWith('hna_')).length).toBeGreaterThan(2)
    expect(fakes.logLines.length).toBeGreaterThan(0)
    const logs = fakes.logLines.join('\n')
    for (const token of seen) expect(logs).not.toContain(token)
  })
})
