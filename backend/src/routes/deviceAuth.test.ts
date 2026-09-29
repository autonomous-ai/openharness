import { beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'

// A machine signs in by a phone approving its QR. Redis, the machine store and the session mint are
// in-memory stand-ins; the routes and lib/deviceAuth.ts run for real.
const fakes = vi.hoisted(() => {
  const redis = new Map<string, string>()
  let allow = true
  const pub = {
    set: vi.fn(async (key: string, value: string, ..._rest: unknown[]) => {
      if (_rest.includes('NX') && redis.has(key)) return null
      redis.set(key, value); return 'OK'
    }),
    get: vi.fn(async (key: string) => redis.get(key) ?? null),
    exists: vi.fn(async (key: string) => (redis.has(key) ? 1 : 0)),
    ttl: vi.fn(async (key: string) => (redis.has(key) ? 100 : -2)),
    del: vi.fn(async (...keys: string[]) => keys.filter((k) => redis.delete(k)).length),
  }
  const machine = { machineId: 'm'.repeat(32), userId: 'u1', name: 'box-2', hostname: 'box-2', apiKey: 'k', computerId: 'c'.repeat(32) }
  return {
    redis, pub, machine,
    setAllow: (v: boolean) => { allow = v },
    consumeRateLimit: vi.fn(async () => allow),
    resolveOrCreate: vi.fn(async () => ({ machine, created: true })),
    createDaemonSession: vi.fn(async (p: Record<string, unknown>) => ({
      token: 'hna_token', refreshToken: 'hnr_refresh', expiresIn: 3600, autonomousEnv: 'prod', bound: p,
    })),
    createViewerSession: vi.fn(async () => ({
      token: 'hna_viewer', refreshToken: 'hnr_viewer', expiresIn: 3600, autonomousEnv: 'prod',
    })),
  }
})

vi.mock('../lib/bus.js', () => ({ pub: fakes.pub, consumeRateLimit: fakes.consumeRateLimit }))
vi.mock('../lib/prisma.js', () => ({
  prisma: { machine: { findMany: vi.fn(async () => [fakes.machine]), findFirst: vi.fn(), update: vi.fn() } },
  machineAlive: {},
}))
vi.mock('../services/MachineService.js', () => ({ machineService: { resolveOrCreateForComputer: fakes.resolveOrCreate } }))
vi.mock('../services/UserService.js', () => ({ userService: { get: vi.fn(async () => ({ id: 'u1', autonomousEnv: 'prod' })) } }))
vi.mock('../lib/harnessSession.js', () => ({
  createDaemonSession: fakes.createDaemonSession, createViewerSession: fakes.createViewerSession,
}))

import { deviceAuthRoutes } from './deviceAuth.js'
import { registerAuthMiddleware } from '../middlewares/authMiddleware.js'
import { errorHandler } from '../middlewares/errorHandler.js'

const COMPUTER = 'c'.repeat(32)
const phone = { authorization: 'Bearer phone' }

let app: FastifyInstance
beforeEach(async () => {
  fakes.redis.clear(); fakes.setAllow(true); vi.clearAllMocks()
  app = Fastify()
  app.setErrorHandler(errorHandler)
  registerAuthMiddleware(app, async (token) => {
    if (token !== 'phone') throw Object.assign(new Error('no'), { code: 'INVALID_TOKEN' })
    return { sub: 'u1', email: 'dee@x.ai', role: 'user', autonomousEnv: 'prod' }
  })
  await app.register(deviceAuthRoutes)
  await app.ready()
})

async function start(): Promise<{ userCode: string; deviceCode: string }> {
  const res = await app.inject({
    method: 'POST', url: '/api/device-auth/start',
    headers: { 'cf-ipcountry': 'VN' },
    payload: { computerId: COMPUTER, label: 'box-2', fingerprint: '5f80·61c4·6142·adcf' },
  })
  expect(res.statusCode).toBe(200)
  return res.json().data
}

describe('machine sign-in approved from a phone', () => {
  it('start → lookup → approve → poll hands the machine a daemon session for its own computer, once', async () => {
    const { userCode, deviceCode } = await start()
    expect(userCode).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)

    const pending = await app.inject({ method: 'POST', url: '/api/device-auth/poll', payload: { deviceCode } })
    expect(pending.json().data).toEqual({ status: 'pending' })

    const lookup = await app.inject({ method: 'GET', url: `/api/device-auth/lookup?userCode=${userCode}`, headers: phone })
    expect(lookup.json().data).toMatchObject({
      label: 'box-2', computerId: COMPUTER, fingerprint: '5F8061C46142ADCF', country: 'VN',
      existingMachine: { machineId: fakes.machine.machineId, name: 'box-2' },
    })

    const approved = await app.inject({ method: 'POST', url: '/api/device-auth/approve', headers: phone, payload: { userCode } })
    expect(approved.statusCode).toBe(200)
    expect(approved.json().data).toMatchObject({ machineId: fakes.machine.machineId })
    expect(fakes.createDaemonSession).toHaveBeenCalledWith({
      userId: 'u1', machineId: fakes.machine.machineId, computerId: COMPUTER, label: 'box-2',
    })

    const polled = await app.inject({ method: 'POST', url: '/api/device-auth/poll', payload: { deviceCode } })
    expect(polled.json().data).toEqual({
      status: 'approved', kind: 'machine', machineId: fakes.machine.machineId,
      token: 'hna_token', refreshToken: 'hnr_refresh', expiresIn: 3600, autonomousEnv: 'prod',
    })
    // Handed over exactly once.
    const again = await app.inject({ method: 'POST', url: '/api/device-auth/poll', payload: { deviceCode } })
    expect(again.json().data).toEqual({ status: 'expired' })
  })

  it('a code is approved once; a second approval is refused', async () => {
    const { userCode } = await start()
    expect((await app.inject({ method: 'POST', url: '/api/device-auth/approve', headers: phone, payload: { userCode } })).statusCode).toBe(200)
    expect((await app.inject({ method: 'POST', url: '/api/device-auth/approve', headers: phone, payload: { userCode } })).statusCode).toBe(410)
    expect(fakes.createDaemonSession).toHaveBeenCalledTimes(1)
  })

  it('"Not me" denies a waiting request, but cannot take back an approved one', async () => {
    const first = await start()
    await app.inject({ method: 'POST', url: '/api/device-auth/deny', headers: phone, payload: { userCode: first.userCode } })
    const denied = await app.inject({ method: 'POST', url: '/api/device-auth/poll', payload: { deviceCode: first.deviceCode } })
    expect(denied.json().data.status).toBe('denied')

    const second = await start()
    await app.inject({ method: 'POST', url: '/api/device-auth/approve', headers: phone, payload: { userCode: second.userCode } })
    const late = await app.inject({ method: 'POST', url: '/api/device-auth/deny', headers: phone, payload: { userCode: second.userCode } })
    expect(late.statusCode).toBe(410)
    const polled = await app.inject({ method: 'POST', url: '/api/device-auth/poll', payload: { deviceCode: second.deviceCode } })
    expect(polled.json().data.status).toBe('approved')
  })

  it('lookup, approve and deny need a signed-in phone; start and poll do not', async () => {
    const { userCode } = await start()
    expect((await app.inject({ method: 'GET', url: `/api/device-auth/lookup?userCode=${userCode}` })).statusCode).toBe(401)
    expect((await app.inject({ method: 'POST', url: '/api/device-auth/approve', payload: { userCode } })).statusCode).toBe(401)
  })

  it('rate limits start per address and approve per account', async () => {
    fakes.setAllow(false)
    const res = await app.inject({ method: 'POST', url: '/api/device-auth/start', payload: { computerId: COMPUTER, label: 'x' } })
    expect(res.statusCode).toBe(429)
    const ok = await app.inject({ method: 'POST', url: '/api/device-auth/approve', headers: phone, payload: { userCode: 'X' } })
    expect(ok.statusCode).toBe(429)
  })

  it('a browser (kind viewer) gets a viewer session and the phone\'s sealed roster, once', async () => {
    const pub = 'A'.repeat(43) + '='
    const started = await app.inject({
      method: 'POST', url: '/api/device-auth/start',
      payload: { kind: 'viewer', label: 'Chrome on macOS', fingerprint: 'ab12·cd34·ef56·7890', pub },
    })
    expect(started.statusCode).toBe(200)
    const { userCode, deviceCode } = started.json().data

    const lookup = await app.inject({ method: 'GET', url: `/api/device-auth/lookup?userCode=${userCode}`, headers: phone })
    expect(lookup.json().data).toMatchObject({ kind: 'viewer', pub, label: 'Chrome on macOS', existingMachine: null })

    const approved = await app.inject({
      method: 'POST', url: '/api/device-auth/approve', headers: phone,
      payload: { userCode, sealedRoster: 'c2VhbGVk' },
    })
    expect(approved.statusCode).toBe(200)
    expect(fakes.createViewerSession).toHaveBeenCalledWith({ userId: 'u1', label: 'Chrome on macOS' })
    expect(fakes.createDaemonSession).not.toHaveBeenCalled()
    expect(fakes.resolveOrCreate).not.toHaveBeenCalled()

    const polled = await app.inject({ method: 'POST', url: '/api/device-auth/poll', payload: { deviceCode } })
    expect(polled.json().data).toEqual({
      status: 'approved', kind: 'viewer', sealedRoster: 'c2VhbGVk',
      token: 'hna_viewer', refreshToken: 'hnr_viewer', expiresIn: 3600, autonomousEnv: 'prod',
    })
    const again = await app.inject({ method: 'POST', url: '/api/device-auth/poll', payload: { deviceCode } })
    expect(again.json().data).toEqual({ status: 'expired' })
  })

  it('a machine hands over its key, and gets the phone\'s sealed roster with its daemon session', async () => {
    const pub = 'B'.repeat(43) + '='
    const started = await app.inject({
      method: 'POST', url: '/api/device-auth/start',
      payload: { computerId: COMPUTER, label: 'box-2', fingerprint: '5f80·61c4', pub },
    })
    const { userCode, deviceCode } = started.json().data
    const lookup = await app.inject({ method: 'GET', url: `/api/device-auth/lookup?userCode=${userCode}`, headers: phone })
    expect(lookup.json().data).toMatchObject({ kind: 'machine', pub })
    const approved = await app.inject({
      method: 'POST', url: '/api/device-auth/approve', headers: phone,
      payload: { userCode, sealedRoster: 'cm9zdGVy' },
    })
    expect(approved.json().data).toMatchObject({ machineId: fakes.machine.machineId })
    const polled = await app.inject({ method: 'POST', url: '/api/device-auth/poll', payload: { deviceCode } })
    expect(polled.json().data).toMatchObject({ status: 'approved', kind: 'machine', sealedRoster: 'cm9zdGVy', token: 'hna_token' })
  })

  it('a malformed roster is refused, and the code can be approved again', async () => {
    const started = await app.inject({ method: 'POST', url: '/api/device-auth/start', payload: { kind: 'viewer', label: 'x' } })
    const { userCode } = started.json().data
    const res = await app.inject({
      method: 'POST', url: '/api/device-auth/approve', headers: phone,
      payload: { userCode, sealedRoster: '<not base64>' },
    })
    expect(res.statusCode).toBe(400)
    expect(fakes.createViewerSession).not.toHaveBeenCalled()
    const retry = await app.inject({ method: 'POST', url: '/api/device-auth/approve', headers: phone, payload: { userCode } })
    expect(retry.statusCode).toBe(200)
  })

  it('a machine request still needs its computer id', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/device-auth/start', payload: { label: 'x' } })
    expect(res.statusCode).toBe(400)
  })
})
