import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  set: vi.fn(),
  eval: vi.fn(),
}))

vi.mock('./bus.js', () => ({ pub: state }))

import { consumeTx, createTx, exchangeCode, refreshAccessToken, SsoTokenError, type SsoTx } from './sso.js'

const tx: SsoTx = {
  verifier: 'verifier',
  state: 'state',
  next: '/machine/1',
  redirectUri: 'http://localhost:3000/auth/callback',
  webOrigin: 'http://localhost:3000',
  autonomousEnv: 'stag',
}

describe('SSO PKCE transaction store', () => {
  beforeEach(() => {
    state.set.mockReset()
    state.eval.mockReset()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('stores an opaque one-time id in Redis for ten minutes', async () => {
    state.set.mockResolvedValue('OK')
    const id = await createTx(tx)

    expect(id).toMatch(/^[A-Za-z0-9_-]{40,}$/)
    expect(state.set).toHaveBeenCalledWith(
      `sso:tx:${id}`,
      JSON.stringify(tx),
      'EX',
      600,
      'NX',
    )
  })

  it('atomically consumes and validates a transaction', async () => {
    state.eval.mockResolvedValue(JSON.stringify(tx))
    await expect(consumeTx('opaque-id')).resolves.toEqual(tx)
    expect(state.eval).toHaveBeenCalledWith(expect.stringContaining("redis.call('del'"), 1, 'sso:tx:opaque-id')
  })

  it('rejects missing or malformed transactions', async () => {
    state.eval.mockResolvedValueOnce(null).mockResolvedValueOnce('{bad json')
    await expect(consumeTx('missing')).resolves.toBeNull()
    await expect(consumeTx('malformed')).resolves.toBeNull()
  })

  it('exchanges a refresh token with the selected environment client', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      access_token: 'new-access',
      refresh_token: 'rotated-refresh',
      expires_in: 3600,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(refreshAccessToken('old-refresh', 'stag')).resolves.toMatchObject({
      access_token: 'new-access',
      refresh_token: 'rotated-refresh',
      expires_in: 3600,
    })
    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toContain('auth.staging.autonomousdev.xyz/oauth2/token')
    const body = init?.body as URLSearchParams
    expect(body.get('grant_type')).toBe('refresh_token')
    expect(body.get('refresh_token')).toBe('old-refresh')
    expect(body.get('client_id')).toBeTruthy()
  })

  it('exchanges and refreshes as the client the sign-in named, and as the configured one when it named none', async () => {
    // A token belongs to the client it was issued to: auth-service refuses a code or a refresh
    // token presented under another.
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => new Response(
      JSON.stringify({ access_token: 'access' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ))
    vi.stubGlobal('fetch', fetchMock)
    const sentClient = (call: number) => (fetchMock.mock.calls[call]![1]?.body as URLSearchParams).get('client_id')

    await exchangeCode('code', 'verifier', 'http://127.0.0.1:5000/callback', 'prod', 'harness-desktop')
    await refreshAccessToken('refresh', 'prod', 'harness-desktop')
    expect(sentClient(0)).toBe('harness-desktop')
    expect(sentClient(1)).toBe('harness-desktop')

    await exchangeCode('code', 'verifier', 'http://127.0.0.1:5000/callback', 'prod')
    await refreshAccessToken('refresh', 'prod')
    expect(sentClient(2)).toBe(sentClient(3))
    expect(sentClient(2)).not.toBe('harness-desktop')
  })

  it('keeps the named client with the transaction, and refuses one that is not ours', async () => {
    state.eval.mockResolvedValueOnce(JSON.stringify({ ...tx, clientId: 'harness-web' }))
    await expect(consumeTx('named')).resolves.toMatchObject({ clientId: 'harness-web' })
    state.eval.mockResolvedValueOnce(JSON.stringify({ ...tx, clientId: 'someone-else' }))
    await expect(consumeTx('foreign')).resolves.toBeNull()
  })

  it('distinguishes invalid refresh tokens from token-service outages', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(
      JSON.stringify({ error: 'invalid_grant' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    )).mockRejectedValueOnce(new Error('offline')))

    await expect(refreshAccessToken('expired', 'prod')).rejects.toMatchObject({
      code: 'INVALID_GRANT',
    } satisfies Partial<SsoTokenError>)
    await expect(refreshAccessToken('valid', 'prod')).rejects.toMatchObject({
      code: 'TOKEN_SERVICE_UNAVAILABLE',
    } satisfies Partial<SsoTokenError>)
  })
})
