import { afterEach, describe, expect, it, vi } from 'vitest'

const findByEmail = vi.hoisted(() => vi.fn())
const findByExternal = vi.hoisted(() => vi.fn())
const upsertFromSso = vi.hoisted(() => vi.fn())

vi.mock('../services/UserService.js', () => ({
  userService: { findByEmail, findByExternal, upsertFromSso },
  normalizeUserEmail: (email: string) => email.trim().toLowerCase(),
  isProvisionalUserEmail: (email: string) => email.endsWith('@pending.harness.invalid'),
}))

import { authenticateAccessToken, clearSsoProfileCache, fetchSsoProfile, SsoAuthError } from './ssoAuth.js'

function response(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('SSO profile authentication', () => {
  it('sends the SSO access token and required locale header', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response(200, {
      status: 1,
      data: { id: 'external-1', email: 'USER@example.com' },
    }))

    await expect(fetchSsoProfile('access.token.value', fetchMock)).resolves.toEqual({
      id: 'external-1',
      email: 'USER@example.com',
    })
    expect(fetchMock).toHaveBeenCalledOnce()
    const [, init] = fetchMock.mock.calls[0]
    expect(init?.headers).toMatchObject({
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Location: 'en-US',
      Authorization: 'Bearer access.token.value',
    })
  })

  it('classifies 401 as an invalid token', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response(401, { message: 'Invalid or expired JWT' }))
    await expect(fetchSsoProfile('expired', fetchMock)).rejects.toMatchObject({ code: 'INVALID_TOKEN' } satisfies Partial<SsoAuthError>)
  })

  it('classifies network and malformed-profile failures as service unavailable', async () => {
    const network = vi.fn<typeof fetch>().mockRejectedValue(new Error('offline'))
    await expect(fetchSsoProfile('token', network)).rejects.toMatchObject({ code: 'AUTH_SERVICE_UNAVAILABLE' } satisfies Partial<SsoAuthError>)

    const malformed = vi.fn<typeof fetch>().mockResolvedValue(response(200, { status: -1, message: 'missing location' }))
    await expect(fetchSsoProfile('token', malformed)).rejects.toMatchObject({ code: 'AUTH_SERVICE_UNAVAILABLE' } satisfies Partial<SsoAuthError>)
  })
})

describe('which endpoint proves a token', () => {
  afterEach(() => clearSsoProfileCache())
  const ok = () => response(200, { status: 1, data: { id: 'external-1', email: 'user@example.com' } })
  const calledUrls = (mock: ReturnType<typeof vi.fn<typeof fetch>>) => mock.mock.calls.map(([url]) => String(url))

  it('asks the identity endpoint, which costs the storefront no customer or cart read', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => ok())

    await expect(fetchSsoProfile('token', fetchMock)).resolves.toEqual({ id: 'external-1', email: 'user@example.com' })

    expect(calledUrls(fetchMock)).toEqual(['https://apiv2.autonomous.ai/api/v1/me/identity'])
  })

  it('falls back to the profile endpoint while the identity endpoint is not deployed', async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response(404, { message: 'page not found' }))
      .mockResolvedValueOnce(ok())

    await expect(fetchSsoProfile('token', fetchMock)).resolves.toEqual({ id: 'external-1', email: 'user@example.com' })

    expect(calledUrls(fetchMock)).toEqual([
      'https://apiv2.autonomous.ai/api/v1/me/identity',
      'https://apiv2.autonomous.ai/api/v1/me/profile',
    ])
  })

  it('falls back when the identity endpoint is failing, so the new route is not a new way to be down', async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response(502, { message: 'bad gateway' }))
      .mockResolvedValueOnce(ok())

    await expect(fetchSsoProfile('token', fetchMock)).resolves.toEqual({ id: 'external-1', email: 'user@example.com' })

    expect(calledUrls(fetchMock)).toEqual([
      'https://apiv2.autonomous.ai/api/v1/me/identity',
      'https://apiv2.autonomous.ai/api/v1/me/profile',
    ])
  })

  it('falls back when the identity endpoint cannot be reached', async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockRejectedValueOnce(new Error('timeout'))
      .mockResolvedValueOnce(ok())

    await expect(fetchSsoProfile('token', fetchMock)).resolves.toEqual({ id: 'external-1', email: 'user@example.com' })

    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('remembers that the identity endpoint is not deployed instead of asking it before every validation', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (url) =>
      String(url).endsWith('/me/identity') ? response(404, { message: 'page not found' }) : ok())

    await fetchSsoProfile('token-1', fetchMock)
    await fetchSsoProfile('token-2', fetchMock)

    expect(calledUrls(fetchMock)).toEqual([
      'https://apiv2.autonomous.ai/api/v1/me/identity',
      'https://apiv2.autonomous.ai/api/v1/me/profile',
      'https://apiv2.autonomous.ai/api/v1/me/profile',
    ])
  })

  it('does not let one failing answer stop it asking the identity endpoint next time', async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response(502, { message: 'bad gateway' }))
      .mockImplementation(async () => ok())

    await fetchSsoProfile('token-1', fetchMock)
    await fetchSsoProfile('token-2', fetchMock)

    expect(calledUrls(fetchMock)[2]).toBe('https://apiv2.autonomous.ai/api/v1/me/identity')
  })

  it('takes the identity endpoint at its word when it rejects the token', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => response(401, { message: 'Invalid or expired JWT' }))

    await expect(fetchSsoProfile('expired', fetchMock)).rejects.toMatchObject({ code: 'INVALID_TOKEN' })

    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('asks the staging identity endpoint for a staging sign-in', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => ok())

    await fetchSsoProfile('token', 'stag', fetchMock)

    expect(calledUrls(fetchMock)).toEqual(['https://apiv2.staging.autonomousdev.xyz/api/v1/me/identity'])
  })
})

describe('authenticated user resolution', () => {
  afterEach(() => {
    vi.clearAllMocks()
    vi.unstubAllGlobals()
    clearSsoProfileCache()
  })

  function profileFetch(id: string, email: string): void {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(response(200, {
      status: 1,
      data: { id, email },
    })))
  }

  it('uses normalized email as identity and saves the staging subject separately', async () => {
    profileFetch('stag-sub-1', ' Owner@Example.COM ')
    const existing = {
      id: 'u1',
      email: 'owner@example.com',
      externalId: 'prod-sub-1',
      stagExternalId: null,
      role: 'user',
      autonomousEnv: 'stag',
    }
    findByEmail.mockResolvedValue(existing)
    upsertFromSso.mockResolvedValue({ ...existing, stagExternalId: 'stag-sub-1' })

    await expect(authenticateAccessToken('a.e30.c', 'stag')).resolves.toEqual({
      sub: 'u1',
      email: 'owner@example.com',
      role: 'user',
      autonomousEnv: 'stag',
    })
    expect(upsertFromSso).toHaveBeenCalledWith(expect.objectContaining({
      externalId: 'stag-sub-1',
      email: 'owner@example.com',
      autonomousEnv: 'stag',
    }))
    expect(findByExternal).not.toHaveBeenCalled()
  })

  it('claims a prod provisional row by User.externalId', async () => {
    profileFetch('prod-sub-1', 'owner@example.com')
    findByEmail.mockResolvedValue(null)
    findByExternal.mockResolvedValue({
      id: 'pending',
      email: 'device-prod-sub-1@pending.harness.invalid',
      externalId: 'prod-sub-1',
      role: 'user',
      autonomousEnv: 'prod',
    })
    upsertFromSso.mockResolvedValue({
      id: 'pending',
      email: 'owner@example.com',
      role: 'user',
    })

    await expect(authenticateAccessToken('a.e30.c', 'prod')).resolves.toMatchObject({ sub: 'pending' })
    expect(upsertFromSso).toHaveBeenCalledOnce()
  })

  it('keeps unknown staging emails closed', async () => {
    profileFetch('stag-sub-new', 'new@example.com')
    findByEmail.mockResolvedValue(null)

    await expect(authenticateAccessToken('a.e30.c', 'stag')).rejects.toMatchObject({
      code: 'AUTONOMOUS_ENV_NOT_ALLOWED',
      requiredEnv: 'prod',
    })
    expect(upsertFromSso).not.toHaveBeenCalled()
  })

  it('rejects the wrong environment without mutating identity fields', async () => {
    profileFetch('prod-sub-1', 'owner@example.com')
    findByEmail.mockResolvedValue({
      id: 'u1',
      email: 'owner@example.com',
      externalId: 'local-prod-u1',
      role: 'user',
      autonomousEnv: 'stag',
    })

    await expect(authenticateAccessToken('a.e30.c', 'prod')).rejects.toMatchObject({
      code: 'AUTONOMOUS_ENV_MISMATCH',
      requiredEnv: 'stag',
    })
    expect(upsertFromSso).not.toHaveBeenCalled()
  })

  it('asks the profile service once for a token used on back-to-back requests', async () => {
    profileFetch('prod-sub-1', 'owner@example.com')
    const existing = { id: 'u1', email: 'owner@example.com', externalId: 'prod-sub-1', role: 'user', autonomousEnv: 'prod' }
    findByEmail.mockResolvedValue(existing)
    upsertFromSso.mockResolvedValue(existing)

    await expect(authenticateAccessToken('a.e30.c', 'prod')).resolves.toMatchObject({ sub: 'u1' })
    await expect(authenticateAccessToken('a.e30.c', 'prod')).resolves.toMatchObject({ sub: 'u1' })

    expect(fetch).toHaveBeenCalledOnce()
  })

  it('asks the profile service again for a token it rejected', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockImplementation(async () => response(401, { message: 'Invalid or expired JWT' })))

    await expect(authenticateAccessToken('a.e30.c', 'prod')).rejects.toMatchObject({ code: 'INVALID_TOKEN' })
    await expect(authenticateAccessToken('a.e30.c', 'prod')).rejects.toMatchObject({ code: 'INVALID_TOKEN' })

    expect(fetch).toHaveBeenCalledTimes(2)
  })
})
