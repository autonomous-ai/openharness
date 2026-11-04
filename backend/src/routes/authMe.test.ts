import { beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'

// The real auth middleware and auth routes, with the user store in memory: a person changes their own account name
// (task #2654), and only their own.
const fakes = vi.hoisted(() => {
  const users = new Map<string, Record<string, unknown>>()
  return {
    users,
    get: vi.fn(async (id: string) => users.get(id) ?? null),
    update: vi.fn(async (id: string, input: { name?: string }) => {
      const row = users.get(id)
      if (!row) throw new Error('not found')
      if (input.name !== undefined) row.name = input.name
      return row
    }),
  }
})

vi.mock('../lib/bus.js', () => ({ pub: {} }))
vi.mock('../lib/prisma.js', () => ({ prisma: {}, machineAlive: {} }))
vi.mock('../services/index.js', () => ({
  userService: { get: fakes.get, update: fakes.update, toPublic: (u: Record<string, unknown>) => ({ ...u }) },
}))

import { authRoutes } from './auth.js'
import { registerAuthMiddleware } from '../middlewares/authMiddleware.js'
import { errorHandler } from '../middlewares/errorHandler.js'
import { SsoAuthError, type AuthUser } from '../lib/ssoAuth.js'

const elvis: AuthUser = { sub: 'u1', email: 'phorom12a@example.com', role: 'user', autonomousEnv: 'prod' }
const team: AuthUser = { ...elvis, harnessSessionId: 's-team', harnessSessionKind: 'team', harnessComputerId: 'c'.repeat(32) }
const phone: AuthUser = { ...elvis, harnessSessionId: 's-phone', harnessSessionKind: 'viewer' }

const authenticate = vi.fn(async (token: string) => {
  if (token === 'elvis') return elvis
  if (token === 'phone') return phone
  if (token === 'team') return team
  throw new SsoAuthError('Invalid', 'INVALID_TOKEN')
})

describe('PATCH /api/auth/me: a person changes their own account name', () => {
  let app: FastifyInstance

  beforeEach(async () => {
    fakes.users.clear()
    fakes.update.mockClear()
    fakes.users.set('u1', { id: 'u1', email: 'phorom12a@example.com', name: 'phorom12a', role: 'user' })
    fakes.users.set('u2', { id: 'u2', email: 'ken@example.com', name: 'Ken', role: 'admin' })
    app = Fastify()
    app.setErrorHandler(errorHandler)
    registerAuthMiddleware(app, authenticate as never)
    await app.register(authRoutes)
    await app.ready()
  })

  const patch = (token: string | null, payload: unknown) => app.inject({
    method: 'PATCH', url: '/api/auth/me', payload: payload as never,
    headers: token ? { authorization: `Bearer ${token}` } : {},
  })
  const me = async (token: string) =>
    (await app.inject({ method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${token}` } })).json().data

  it('saves the name, answers as /api/auth/me does, and /api/auth/me reads it at once', async () => {
    const response = await patch('elvis', { name: '  Elvis ' })
    expect(response.statusCode).toBe(200)
    expect(response.json().data).toEqual({ user: expect.objectContaining({ id: 'u1', name: 'Elvis' }), avatarUrl: null, description: null })
    expect((await me('elvis')).user.name).toBe('Elvis')
  })

  it('changes only the caller\'s own row, whatever the body names', async () => {
    const response = await patch('elvis', { name: 'Elvis', id: 'u2', userId: 'u2', email: 'ken@example.com', role: 'admin' })
    expect(response.statusCode).toBe(200)
    expect(fakes.update).toHaveBeenCalledTimes(1)
    expect(fakes.update).toHaveBeenCalledWith('u1', { name: 'Elvis' })
    expect(fakes.users.get('u2')).toEqual({ id: 'u2', email: 'ken@example.com', name: 'Ken', role: 'admin' })
    expect(fakes.users.get('u1')).toMatchObject({ email: 'phorom12a@example.com', role: 'user' })
  })

  it('refuses a name that is not one, and writes nothing', async () => {
    for (const name of ['   ', '', 'a​b', 'x'.repeat(61), 7, null]) {
      const response = await patch('elvis', { name })
      expect(response.statusCode, JSON.stringify(name)).toBe(400)
      expect(response.json().error).toEqual({ code: 'INVALID_NAME', message: 'Use 1 to 60 characters, with no hidden ones.' })
    }
    expect(await patch('elvis', {})).toHaveProperty('statusCode', 400)
    expect(fakes.update).not.toHaveBeenCalled()
    expect(fakes.users.get('u1')!.name).toBe('phorom12a')
  })

  it('refuses a web address, an email-shaped name or a role\'s name, and writes nothing', async () => {
    const link = await patch('elvis', { name: 'https://ev.il' })
    expect(link.statusCode).toBe(400)
    expect(link.json().error).toEqual({ code: 'INVALID_NAME', message: 'Use a name, not a web address.' })
    const email = await patch('elvis', { name: 'ken15@autonomous.ai' })
    expect(email.statusCode).toBe(400)
    expect(email.json().error).toEqual({ code: 'INVALID_NAME', message: 'Use a name, not an email address.' })
    const role = await patch('elvis', { name: 'Product Manager' })
    expect(role.statusCode).toBe(400)
    expect(role.json().error).toEqual({ code: 'NAME_RESERVED', message: 'Product Manager is a role\'s name. Choose another.' })
    expect(fakes.update).not.toHaveBeenCalled()
  })

  it('needs a sign-in', async () => {
    expect((await patch(null, { name: 'Elvis' })).statusCode).toBe(401)
    expect(fakes.update).not.toHaveBeenCalled()
  })

  it('takes the phone\'s sign-in, which is the same person', async () => {
    expect((await patch('phone', { name: 'Elvis' })).statusCode).toBe(200)
    expect(fakes.users.get('u1')!.name).toBe('Elvis')
  })

  it('refuses a team machine\'s sign-in: it runs other people\'s agents under the owner\'s account', async () => {
    const response = await patch('team', { name: 'Elvis' })
    expect(response.statusCode).toBe(403)
    expect(response.json().error.code).toBe('TEAM_SESSION_LIMITED')
    expect(fakes.update).not.toHaveBeenCalled()
  })
})
