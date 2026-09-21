import { describe, expect, it, vi } from 'vitest'

// A deployment (or a test rig) that points the profile URL somewhere of its own turns the identity
// endpoint off with SSO_IDENTITY_URL='' — otherwise its tokens would be proved against the default host.
vi.mock('../config/env.js', () => ({
  env: {
    SSO_PROFILE_URL: 'http://127.0.0.1:4010/profile',
    SSO_IDENTITY_URL: '',
    SSO_PROFILE_TIMEOUT_MS: 1000,
    SSO_PROFILE_CACHE_TTL_MS: 0,
  },
}))
vi.mock('../services/UserService.js', () => ({
  userService: {},
  normalizeUserEmail: (email: string) => email,
  isProvisionalUserEmail: () => false,
}))

import { fetchSsoProfile } from './ssoAuth.js'

describe('identity endpoint turned off', () => {
  it('asks only the profile URL', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => new Response(
      JSON.stringify({ status: 1, data: { id: 'external-1', email: 'user@example.com' } }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ))

    await expect(fetchSsoProfile('token', fetchMock)).resolves.toEqual({ id: 'external-1', email: 'user@example.com' })

    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual(['http://127.0.0.1:4010/profile'])
  })
})
