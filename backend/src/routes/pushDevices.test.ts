import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
const m = vi.hoisted(() => ({ auth: vi.fn(), register: vi.fn(), drop: vi.fn() }))
vi.mock('../push/devices.js', () => ({ registerPushDevice: m.register, dropPushDevice: m.drop }))
vi.mock('../lib/prisma.js', () => ({ prisma: { fixture: 'db' } }))
vi.mock('../lib/ssoAuth.js', async original => ({ ...await original<typeof import('../lib/ssoAuth.js')>(), authenticateAccessToken: m.auth }))
import { pushDeviceRoutes } from './pushDevices.js'
import { registerAuthMiddleware } from '../middlewares/authMiddleware.js'
import { errorHandler } from '../middlewares/errorHandler.js'

const user = { sub: 'user-1', email: 'dee@example.com', role: 'user', autonomousEnv: 'prod' as const }
const auth = { authorization: 'Bearer fixture' }
const token = 'ab'.repeat(32)

describe('push device routes (task #2905)', () => {
  let app: FastifyInstance
  beforeEach(async () => {
    vi.resetAllMocks()
    m.auth.mockResolvedValue({ ...user, sub: `user-${Math.random()}` })
    m.drop.mockResolvedValue(true)
    app = Fastify(); app.setErrorHandler(errorHandler); registerAuthMiddleware(app, m.auth)
    await app.register(pushDeviceRoutes); await app.ready()
  })
  afterEach(async () => { await app.close() })
  const post = (url: string, payload: unknown) => app.inject({ method: 'POST', url, headers: auth, payload: payload as never })

  it('needs a sign-in', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/push-devices', payload: { platform: 'ios', token } })).statusCode).toBe(401)
  })

  it('keeps the phone\'s token for the signed-in person', async () => {
    m.auth.mockResolvedValue(user)
    const r = await post('/api/push-devices', { platform: 'ios', token })
    expect(r.statusCode).toBe(200)
    expect(m.register).toHaveBeenCalledWith({ fixture: 'db' }, 'user-1', { platform: 'ios', token }, expect.any(Number))
  })

  it('takes an Android token as Firebase writes it', async () => {
    const fcm = `dGVzdA:APA91b${'x_-'.repeat(50)}`
    expect((await post('/api/push-devices', { platform: 'android', token: fcm })).statusCode).toBe(200)
  })

  it('refuses a team session: a teammate\'s work never gets the person\'s notices', async () => {
    m.auth.mockResolvedValue({ ...user, harnessSessionId: 's', harnessSessionKind: 'team' })
    const r = await post('/api/push-devices', { platform: 'ios', token })
    expect(r.statusCode).toBe(403)
    expect(r.json().error.code).toBe('TEAM_SESSION_LIMITED')
    expect(m.register).not.toHaveBeenCalled()
  })

  it('refuses another platform, a token with other characters, and one too long', async () => {
    for (const payload of [{ platform: 'web', token }, { platform: 'ios', token: 'ab cd' }, { platform: 'ios', token: 'a/b' },
      { platform: 'ios', token: 'a'.repeat(4097) }, { platform: 'ios', token: '' }, { platform: 'ios', token, extra: 1 }]) {
      expect((await post('/api/push-devices', payload)).statusCode, JSON.stringify(payload).slice(0, 60)).toBe(400)
    }
    expect(m.register).not.toHaveBeenCalled()
  })

  it('drops only the caller\'s token, and says whether it was there', async () => {
    m.auth.mockResolvedValue(user)
    const r = await post('/api/push-devices/drop', { platform: 'ios', token })
    expect(r.statusCode).toBe(200)
    expect(r.json().data).toEqual({ dropped: true })
    expect(m.drop).toHaveBeenCalledWith({ fixture: 'db' }, 'user-1', { platform: 'ios', token })
  })

  it('answers 429 past 20 changes a minute', async () => {
    m.auth.mockResolvedValue({ ...user, sub: 'busy' })
    for (let i = 0; i < 20; i++) expect((await post('/api/push-devices', { platform: 'ios', token })).statusCode).toBe(200)
    expect((await post('/api/push-devices/drop', { platform: 'ios', token })).statusCode).toBe(429)
  })
})
