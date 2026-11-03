import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Stability 3.5: a slow or down SSO must not hold every request for its full timeout.
vi.mock('../config/env.js', () => ({
  env: {
    SSO_PROFILE_URL: 'http://127.0.0.1:4010/profile',
    SSO_IDENTITY_URL: 'http://127.0.0.1:4010/identity',
    SSO_PROFILE_TIMEOUT_MS: 50,
    SSO_PROFILE_CACHE_TTL_MS: 60_000,
    SSO_PROFILE_STALE_GRACE_MS: 600_000,
  },
}))
const upsertFromSso = vi.hoisted(() => vi.fn())
vi.mock('../services/UserService.js', () => ({
  userService: { findByEmail: vi.fn(async () => null), findByExternal: vi.fn(async () => null), upsertFromSso },
  normalizeUserEmail: (email: string) => email.trim().toLowerCase(),
  isProvisionalUserEmail: () => false,
}))
vi.mock('./googleSubject.js', () => ({ scheduleGoogleSubjectFill: () => {} }))

import { authenticateAccessToken, clearSsoProfileCache, fetchSsoProfile, resetSsoBreakers } from './ssoAuth.js'

const ok = () => new Response(JSON.stringify({ status: 1, data: { id: 'external-1', email: 'user@example.com' } }),
  { status: 200, headers: { 'Content-Type': 'application/json' } })
const rejected = () => new Response(JSON.stringify({ message: 'Invalid or expired JWT' }), { status: 401 })
/** An SSO that never answers: the call ends only when its signal aborts. */
const silent: typeof fetch = (_url, init) => new Promise((_, reject) => {
  init?.signal?.addEventListener('abort', () => reject(init.signal!.reason))
})

beforeEach(() => {
  upsertFromSso.mockImplementation(async ({ email }: { email: string }) => ({ id: 'user-1', email, role: 'user' }))
})
afterEach(() => {
  clearSsoProfileCache()
  resetSsoBreakers()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('a slow SSO', () => {
  it('costs one timeout in all, not one per endpoint', async () => {
    const fetchMock = vi.fn<typeof fetch>(silent)
    const started = Date.now()

    await expect(fetchSsoProfile('token', fetchMock)).rejects.toMatchObject({ code: 'AUTH_SERVICE_UNAVAILABLE' })

    expect(fetchMock).toHaveBeenCalledOnce()
    expect(Date.now() - started).toBeLessThan(1_000)
  })

  it('answers at once once it is known to be down, without asking it again', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => { throw new Error('connect ECONNREFUSED') })
    vi.stubGlobal('fetch', fetchMock)
    for (let i = 0; i < 5; i++) {
      await expect(authenticateAccessToken(`token-${i}`)).rejects.toMatchObject({ code: 'AUTH_SERVICE_UNAVAILABLE' })
    }
    const asked = fetchMock.mock.calls.length

    await expect(authenticateAccessToken('token-next')).rejects.toMatchObject({ code: 'AUTH_SERVICE_UNAVAILABLE' })

    expect(fetchMock.mock.calls.length).toBe(asked)
  })

  it('is not taken for down when it rejects tokens', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => rejected())
    vi.stubGlobal('fetch', fetchMock)
    for (let i = 0; i < 10; i++) await expect(authenticateAccessToken(`bad-${i}`)).rejects.toMatchObject({ code: 'INVALID_TOKEN' })
    fetchMock.mockImplementation(async () => ok())

    await expect(authenticateAccessToken('good')).resolves.toMatchObject({ sub: 'user-1' })
  })

  it('does not sign out someone it validated a few minutes ago', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(1_000_000_000)
    const fetchMock = vi.fn<typeof fetch>(async () => ok())
    vi.stubGlobal('fetch', fetchMock)
    await authenticateAccessToken('working-token')
    vi.setSystemTime(1_000_000_000 + 5 * 60_000)
    fetchMock.mockImplementation(async () => { throw new Error('connect ECONNREFUSED') })

    await expect(authenticateAccessToken('working-token')).resolves.toMatchObject({ sub: 'user-1', email: 'user@example.com' })
    await expect(authenticateAccessToken('never-seen')).rejects.toMatchObject({ code: 'AUTH_SERVICE_UNAVAILABLE' })
  })
})
