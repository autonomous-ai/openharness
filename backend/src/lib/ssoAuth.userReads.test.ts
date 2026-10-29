import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The real user service over a fake database: these tests count the user reads one signed-in request costs
// (DB optimization roadmap, Phase 2 item 7).
// Nothing is reused across requests: another server may have changed the account in between (demoted an admin,
// deleted it, moved it to the other environment), and that must apply on the very next request.
const findUnique = vi.hoisted(() => vi.fn())
const update = vi.hoisted(() => vi.fn())
const create = vi.hoisted(() => vi.fn())

vi.mock('./prisma.js', () => ({
  prisma: { user: { findUnique, update, create } },
}))

import { authenticateAccessToken, clearSsoProfileCache } from './ssoAuth.js'

function profileFetch(id: string, email: string): void {
  vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockImplementation(async () => new Response(
    JSON.stringify({ status: 1, data: { id, email } }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  )))
}

const stored = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'u1',
  email: 'owner@example.com',
  externalId: 'prod-sub-1',
  stagExternalId: null,
  name: null,
  role: 'user',
  autonomousEnv: 'prod',
  googleSub: null,
  // Checked just now, so no Google-subject fill runs and every read counted is the sign-in's own.
  googleSubCheckedAt: new Date(),
  ...over,
})

/** User reads by email: the sign-in's identity lookups. */
const emailReads = (): number => findUnique.mock.calls.filter(([args]) => 'email' in (args as { where: object }).where).length

describe('user reads per signed-in request', () => {
  /** What the database holds for the account right now; a test changes it as another server would. */
  let row: Record<string, unknown> | null

  beforeEach(() => {
    profileFetch('prod-sub-1', 'owner@example.com')
    row = stored()
    findUnique.mockImplementation(async ({ where }: { where: { id?: string; email?: string } }) =>
      (row && (where.email === row.email || where.id === row.id) ? row : null))
    update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ ...row, ...data }))
    create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'u-new', ...data }))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
    clearSsoProfileCache()
  })

  it('reads the user once for one request', async () => {
    await expect(authenticateAccessToken('a.e30.c', 'prod')).resolves.toMatchObject({ sub: 'u1', role: 'user' })
    expect(emailReads()).toBe(1)
  })

  it('reads the user once for a request that updates the account', async () => {
    profileFetch('prod-sub-2', 'owner@example.com')
    await expect(authenticateAccessToken('a.e30.c', 'prod')).resolves.toMatchObject({ sub: 'u1' })
    expect(update).toHaveBeenCalledOnce()
    expect(emailReads()).toBe(1)
  })

  it('reads the user again for the next request', async () => {
    await authenticateAccessToken('a.e30.c', 'prod')
    await authenticateAccessToken('a.e30.c', 'prod')
    expect(emailReads()).toBe(2)
  })

  it('serves an admin demoted on another server as a user on the next request', async () => {
    row = stored({ role: 'admin' })
    await expect(authenticateAccessToken('a.e30.c', 'prod')).resolves.toMatchObject({ role: 'admin' })
    row = stored({ role: 'user' })
    await expect(authenticateAccessToken('a.e30.c', 'prod')).resolves.toMatchObject({ role: 'user' })
  })

  it('refuses the next request after another server moved the account to the other environment', async () => {
    await authenticateAccessToken('a.e30.c', 'prod')
    row = stored({ autonomousEnv: 'stag' })
    await expect(authenticateAccessToken('a.e30.c', 'prod')).rejects.toMatchObject({ code: 'AUTONOMOUS_ENV_MISMATCH' })
  })

  it('never serves an account another server deleted', async () => {
    await authenticateAccessToken('a.e30.c', 'prod')
    row = null
    await expect(authenticateAccessToken('a.e30.c', 'prod')).resolves.not.toMatchObject({ sub: 'u1' })
  })
})
