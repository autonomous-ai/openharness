import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The real user service over a fake database: these tests count the user reads one signed-in request costs
// (DB optimization roadmap, Phase 2 item 7).
const findUnique = vi.hoisted(() => vi.fn())
const update = vi.hoisted(() => vi.fn())
const updateMany = vi.hoisted(() => vi.fn())
const remove = vi.hoisted(() => vi.fn())

vi.mock('./prisma.js', () => ({
  prisma: { user: { findUnique, update, updateMany, delete: remove } },
}))

import { authenticateAccessToken, clearSsoProfileCache } from './ssoAuth.js'
import { USER_ROW_TTL_MS, userService } from '../services/UserService.js'

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
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-29T03:00:00Z'))
    profileFetch('prod-sub-1', 'owner@example.com')
    findUnique.mockImplementation(async ({ where }: { where: { id?: string; email?: string } }) =>
      (where.email === 'owner@example.com' || where.id === 'u1' ? stored() : null))
    update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => stored(data))
    updateMany.mockResolvedValue({ count: 1 })
    remove.mockResolvedValue({})
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.clearAllMocks()
    clearSsoProfileCache()
    userService.forgetCachedUsers()
  })

  it('reads the user once for one request', async () => {
    await expect(authenticateAccessToken('a.e30.c', 'prod')).resolves.toMatchObject({ sub: 'u1', role: 'user' })
    expect(emailReads()).toBe(1)
  })

  it('reads the user once for two requests that arrive together', async () => {
    await Promise.all([authenticateAccessToken('a.e30.c', 'prod'), authenticateAccessToken('a.e30.c', 'prod')])
    expect(emailReads()).toBe(1)
  })

  it('does not read the user again for a request a few seconds later, and reads it again after that', async () => {
    await authenticateAccessToken('a.e30.c', 'prod')
    vi.setSystemTime(Date.now() + USER_ROW_TTL_MS - 1)
    await authenticateAccessToken('a.e30.c', 'prod')
    expect(emailReads()).toBe(1)

    vi.setSystemTime(Date.now() + 2)
    await authenticateAccessToken('a.e30.c', 'prod')
    expect(emailReads()).toBe(2)
  })

  it('does not keep an account that is not there yet, so its first sign-in finds the row it creates', async () => {
    findUnique.mockResolvedValue(null)
    await expect(userService.findByEmail('new@example.com')).resolves.toBeNull()
    findUnique.mockResolvedValue(stored({ id: 'u-new', email: 'new@example.com' }))
    await expect(userService.findByEmail('new@example.com')).resolves.toMatchObject({ id: 'u-new' })
    expect(emailReads()).toBe(2)
  })

  it('does not keep a failed read', async () => {
    findUnique.mockRejectedValueOnce(new Error('db down'))
    await expect(userService.findByEmail('owner@example.com')).rejects.toThrow('db down')
    await expect(userService.findByEmail('owner@example.com')).resolves.toMatchObject({ id: 'u1' })
  })

  it('serves a role or environment change made on this server at once', async () => {
    await authenticateAccessToken('a.e30.c', 'prod')
    findUnique.mockImplementation(async ({ where }: { where: { id?: string; email?: string } }) =>
      (where.id === 'u1' || where.email === 'owner@example.com' ? stored({ role: 'admin' }) : null))
    await userService.update('u1', { role: 'admin' })

    await expect(authenticateAccessToken('a.e30.c', 'prod')).resolves.toMatchObject({ role: 'admin' })
  })

  it('refuses a request at once after the account moved to the other environment on this server', async () => {
    await authenticateAccessToken('a.e30.c', 'prod')
    findUnique.mockImplementation(async ({ where }: { where: { id?: string; email?: string } }) =>
      (where.id === 'u1' || where.email === 'owner@example.com' ? stored({ autonomousEnv: 'stag' }) : null))
    await userService.update('u1', { autonomousEnv: 'stag' })

    await expect(authenticateAccessToken('a.e30.c', 'prod')).rejects.toMatchObject({ code: 'AUTONOMOUS_ENV_MISMATCH' })
  })

  it('reads the user again after the account is deleted on this server', async () => {
    await authenticateAccessToken('a.e30.c', 'prod')
    await userService.remove('u1')
    findUnique.mockResolvedValue(null)

    await expect(userService.findByEmail('owner@example.com')).resolves.toBeNull()
  })

  it('reads the user again after a Google subject is recorded, so the next request does not check it again', async () => {
    await userService.findByEmail('owner@example.com')
    await userService.recordGoogleSubject('u1', 'g-1', new Date())
    await userService.findByEmail('owner@example.com')
    expect(emailReads()).toBe(2)
  })
})
