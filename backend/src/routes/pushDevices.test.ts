import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
const m = vi.hoisted(() => ({ auth: vi.fn(), register: vi.fn(), drop: vi.fn() }))
vi.mock('../push/devices.js', () => ({ registerPushDevice: m.register, dropPushDevice: m.drop }))
vi.mock('../lib/prisma.js', () => ({ prisma: { fixture: 'db' } }))
vi.mock('../lib/ssoAuth.js', async original => ({ ...await original<typeof import('../lib/ssoAuth.js')>(), authenticateAccessToken: m.auth }))
import { pushDeviceRoutes } from './pushDevices.js'
import { goneRoutes } from './gone.js'
import { registerAuthMiddleware } from '../middlewares/authMiddleware.js'
import { errorHandler } from '../middlewares/errorHandler.js'

const user = { sub: 'user-1', email: 'dee@example.com', role: 'user', autonomousEnv: 'prod' as const }
const auth = { authorization: 'Bearer fixture' }
const token = 'ab'.repeat(32)

describe('retired Swarm push and legacy token cleanup', () => {
  let app: FastifyInstance
  beforeEach(async () => {
    vi.resetAllMocks()
    m.auth.mockResolvedValue({ ...user, sub: `user-${Math.random()}` })
    m.drop.mockResolvedValue(true)
    app = Fastify(); app.setErrorHandler(errorHandler); registerAuthMiddleware(app, m.auth)
    await app.register(goneRoutes); await app.register(pushDeviceRoutes); await app.ready()
  })
  afterEach(async () => { await app.close() })
  const post = (url: string, payload: unknown) => app.inject({ method: 'POST', url, headers: auth, payload: payload as never })

  it('needs a sign-in', async () => {
    for (const url of ['/api/push-devices', '/api/push-devices/drop']) {
      expect((await app.inject({ method: 'POST', url, payload: { platform: 'ios', token } })).statusCode).toBe(401)
    }
  })

  it('refuses new Swarm push registrations without storing a token', async () => {
    const res = await post('/api/push-devices', { platform: 'ios', token })
    expect(res.statusCode).toBe(410)
    expect(res.json()).toEqual({ success: false, error: { code: 'SWARMS_REMOVED', message: 'Swarms were removed from Harness.' } })
    expect(m.register).not.toHaveBeenCalled()
    expect(m.drop).not.toHaveBeenCalled()
  })

  it('refuses new Swarm push registration before parsing its body', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/push-devices',
      headers: { ...auth, 'content-type': 'application/json' }, payload: '{' })
    expect(res.statusCode).toBe(410)
    expect(res.json().error.code).toBe('SWARMS_REMOVED')
    expect(m.register).not.toHaveBeenCalled()
  })

  it('unregisters an Android token as Firebase wrote it', async () => {
    const fcm = `dGVzdA:APA91b${'x_-'.repeat(50)}`
    expect((await post('/api/push-devices/drop', { platform: 'android', token: fcm })).statusCode).toBe(200)
    expect(m.drop).toHaveBeenCalledWith({ fixture: 'db' }, expect.any(String), { platform: 'android', token: fcm })
  })

  it('refuses another platform, a token with other characters, and one too long', async () => {
    for (const payload of [{ platform: 'web', token }, { platform: 'ios', token: 'ab cd' }, { platform: 'ios', token: 'a/b' },
      { platform: 'ios', token: 'a'.repeat(4097) }, { platform: 'ios', token: '' }, { platform: 'ios', token, extra: 1 }]) {
      expect((await post('/api/push-devices/drop', payload)).statusCode, JSON.stringify(payload).slice(0, 60)).toBe(400)
    }
    expect(m.register).not.toHaveBeenCalled()
    expect(m.drop).not.toHaveBeenCalled()
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
    for (let i = 0; i < 20; i++) expect((await post('/api/push-devices/drop', { platform: 'ios', token })).statusCode).toBe(200)
    expect((await post('/api/push-devices/drop', { platform: 'ios', token })).statusCode).toBe(429)
  })

  it('preserves the older client\'s duplicate-unregister response', async () => {
    m.drop.mockResolvedValue(false)
    const res = await post('/api/push-devices/drop', { platform: 'ios', token })
    expect(res.statusCode).toBe(200)
    expect(res.json().data).toEqual({ dropped: false })
  })

  it('does not turn unrelated methods or paths into removed-feature routes', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/push-devices', headers: auth })).statusCode).toBe(404)
    expect((await post('/api/push-devices/other', { platform: 'ios', token })).statusCode).toBe(404)
  })
})
