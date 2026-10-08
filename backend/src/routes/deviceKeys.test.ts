import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
const m = vi.hoisted(() => ({ auth: vi.fn(), read: vi.fn(), append: vi.fn(), seen: vi.fn(), touch: vi.fn() }))
vi.mock('../lib/deviceKeyLog.js', () => ({ readDeviceKeyLog: m.read, appendDeviceKey: m.append, deviceKeysSeen: m.seen, touchDeviceKey: m.touch }))
vi.mock('../lib/ssoAuth.js', async original => ({ ...await original<typeof import('../lib/ssoAuth.js')>(), authenticateAccessToken: m.auth }))
import { deviceKeyRoutes } from './deviceKeys.js'
import { registerAuthMiddleware } from '../middlewares/authMiddleware.js'
import { errorHandler } from '../middlewares/errorHandler.js'

const user = { sub: 'user-1', email: 'dee@example.com', role: 'user', autonomousEnv: 'prod' as const }
const auth = { authorization: 'Bearer fixture' }
const head = { seq: 3, hash: Buffer.alloc(32, 7).toString('base64') }

describe('device key routes', () => {
  let app: FastifyInstance
  beforeEach(async () => {
    vi.resetAllMocks()
    m.auth.mockResolvedValue(user)
    app = Fastify(); app.setErrorHandler(errorHandler); registerAuthMiddleware(app, m.auth)
    await app.register(deviceKeyRoutes); await app.ready()
  })
  afterEach(async () => { await app.close() })

  it('needs a sign-in', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/device-keys' })).statusCode).toBe(401)
  })

  it('reads the caller log from a head, uncached', async () => {
    m.read.mockResolvedValue({ acct: 'user-1', head, entries: [] })
    const r = await app.inject({ method: 'GET', url: '/api/device-keys?since=2', headers: auth })
    expect(r.statusCode).toBe(200)
    expect(r.headers['cache-control']).toBe('no-store')
    expect(r.json().data).toEqual({ acct: 'user-1', head, entries: [] })
    expect(m.read).toHaveBeenCalledWith('user-1', 2)
    expect(m.touch).not.toHaveBeenCalled()
  })

  it('counts a read as the reading key being in use, and reads the same either way', async () => {
    m.read.mockResolvedValue({ acct: 'user-1', head, entries: [] })
    const self = Buffer.alloc(32, 4).toString('base64')
    const r = await app.inject({ method: 'GET', url: `/api/device-keys?since=2&self=${encodeURIComponent(self)}`, headers: auth })
    expect(r.statusCode).toBe(200)
    expect(r.json().data).toEqual({ acct: 'user-1', head, entries: [] })
    expect(m.touch).toHaveBeenCalledWith('user-1', self)
    expect(m.read).toHaveBeenCalledWith('user-1', 2)
  })

  it('reads the log even when self is not a key', async () => {
    m.read.mockResolvedValue({ acct: 'user-1', head, entries: [] })
    for (const q of ['self=nope', 'self=a&self=b']) {
      const r = await app.inject({ method: 'GET', url: `/api/device-keys?since=0&${q}`, headers: auth })
      expect(r.statusCode).toBe(200)
      expect(r.json().data).toEqual({ acct: 'user-1', head, entries: [] })
    }
  })

  it('appends over the viewer channel, carrying a Harness session', async () => {
    m.auth.mockResolvedValue({ ...user, harnessSessionId: 'sess-9' })
    m.append.mockResolvedValue({ ok: true, head })
    const r = await app.inject({ method: 'POST', url: '/api/device-keys', headers: auth, payload: { entry: { v: 1 } } })
    expect(r.statusCode).toBe(200)
    expect(r.json().data).toEqual({ head })
    expect(m.append).toHaveBeenCalledWith('user-1', { v: 1 }, { kind: 'viewer', harnessSessionId: 'sess-9' })
  })

  it('answers a stale head with 409 and the head to rebuild on', async () => {
    m.append.mockResolvedValue({ ok: false, status: 409, code: 'STALE_HEAD', head })
    const r = await app.inject({ method: 'POST', url: '/api/device-keys', headers: auth, payload: { entry: {} } })
    expect(r.statusCode).toBe(409)
    expect(r.json()).toMatchObject({ success: false, error: { code: 'STALE_HEAD' }, data: { head } })
  })

  it('passes a refusal through with its code', async () => {
    m.append.mockResolvedValue({ ok: false, status: 403, code: 'WRONG_CHANNEL' })
    const r = await app.inject({ method: 'POST', url: '/api/device-keys', headers: auth, payload: { entry: {} } })
    expect(r.statusCode).toBe(403)
    expect(r.json().error.code).toBe('WRONG_CHANNEL')
  })

  it('says when each key was last seen, and fails — never "nothing seen" — when that cannot be read', async () => {
    m.seen.mockResolvedValue({ seen: { k: 5 }, since: 3 })
    const r = await app.inject({ method: 'GET', url: '/api/device-keys/seen', headers: auth })
    expect(r.json().data).toEqual({ seen: { k: 5 }, since: 3 })
    expect(m.seen).toHaveBeenCalledWith('user-1')
    m.seen.mockRejectedValue(new Error('redis down'))
    const down = await app.inject({ method: 'GET', url: '/api/device-keys/seen', headers: auth })
    expect(down.statusCode).toBe(503)
    expect(down.json().error.code).toBe('SEEN_UNAVAILABLE')
  })

  it('limits how often one account appends', async () => {
    m.auth.mockResolvedValue({ ...user, sub: 'user-busy' })
    m.append.mockResolvedValue({ ok: true, head })
    const codes: number[] = []
    for (let i = 0; i < 21; i++) codes.push((await app.inject({ method: 'POST', url: '/api/device-keys', headers: auth, payload: { entry: {} } })).statusCode)
    expect(codes.slice(0, 20).every((c) => c === 200)).toBe(true)
    expect(codes[20]).toBe(429)
  })

  it('refuses a body without an entry', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/device-keys', headers: auth, payload: { other: 1 } })
    expect(r.statusCode).toBe(400)
    expect(m.append).not.toHaveBeenCalled()
  })
})
