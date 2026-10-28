import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
const mocks = vi.hoisted(() => ({
  prisma: {
    $transaction: vi.fn(),
    machine: { findFirst: vi.fn() },
    machineShare: { findUnique: vi.fn(), upsert: vi.fn(), deleteMany: vi.fn() },
    machineShareAdd: { findMany: vi.fn(), upsert: vi.fn(), deleteMany: vi.fn() },
    user: { findMany: vi.fn() },
  },
  listChanged: vi.fn(), shareChanged: vi.fn(), sharedWith: vi.fn(), members: vi.fn(), auth: vi.fn(),
}))
vi.mock('../lib/prisma.js', () => ({ prisma: mocks.prisma, machineAlive: { OR: [{ deletedAt: null }, { deletedAt: { isSet: false } }] } }))
vi.mock('../lib/bus.js', () => ({ publishDeviceMachineListChanged: mocks.listChanged, publishMachineShareChanged: mocks.shareChanged }))
vi.mock('../lib/machineAccess.js', async original => ({ ...await original<typeof import('../lib/machineAccess.js')>(),
  machinesSharedWith: mocks.sharedWith, shareMembers: mocks.members }))
vi.mock('../lib/ssoAuth.js', async original => ({ ...await original<typeof import('../lib/ssoAuth.js')>(), authenticateAccessToken: mocks.auth }))
import { machineShareRoutes, SHARE_EMAILS_MAX } from './machineShares.js'
import { registerAuthMiddleware } from '../middlewares/authMiddleware.js'
import { errorHandler } from '../middlewares/errorHandler.js'

const M1 = 'ab'.repeat(16)
const dee = { sub: 'dee', email: 'Dee@Acme.io', role: 'user', autonomousEnv: 'prod' as const }
const kim = { sub: 'kim', email: 'kim@acme.io', role: 'user', autonomousEnv: 'prod' as const }
const machine = { machineId: M1, userId: 'dee', autonomousEnv: 'prod', billingStatus: 'not_required' }
const row = (patch: Record<string, unknown> = {}) => ({ id: 's1', machineId: M1, ownerId: 'dee', autonomousEnv: 'prod',
  emails: ['ann@gmail.com'], domain: 'acme.io', createdAt: new Date(), updatedAt: new Date(), ...patch })
const members = [{ email: 'ann@gmail.com', name: 'Ann', via: 'email', machines: [] }]

describe('sharing a machine', () => {
  let app: FastifyInstance
  const auth = { authorization: 'Bearer fixture' }
  beforeEach(async () => {
    vi.resetAllMocks()
    mocks.prisma.$transaction.mockImplementation(async work => work(mocks.prisma))
    mocks.auth.mockResolvedValue(dee)
    mocks.prisma.machine.findFirst.mockResolvedValue(machine)
    mocks.prisma.machineShare.findUnique.mockResolvedValue(null)
    mocks.prisma.machineShare.upsert.mockImplementation(async ({ create }: { create: Record<string, unknown> }) => row(create))
    mocks.prisma.machineShareAdd.findMany.mockResolvedValue([])
    mocks.prisma.machineShareAdd.deleteMany.mockResolvedValue({ count: 0 })
    mocks.prisma.user.findMany.mockResolvedValue([])
    mocks.shareChanged.mockResolvedValue(1)
    mocks.listChanged.mockResolvedValue(1)
    mocks.members.mockResolvedValue(members)
    app = Fastify(); app.setErrorHandler(errorHandler); registerAuthMiddleware(app, mocks.auth)
    await app.register(machineShareRoutes); await app.ready()
  })
  afterEach(async () => { await app.close() })
  const put = (payload: unknown, machineId = M1) =>
    app.inject({ method: 'PUT', url: `/api/machines/${machineId}/share`, headers: auth, payload: payload as any })

  it('requires a sign-in on every endpoint', async () => {
    for (const [method, url] of [['GET', `/api/machines/${M1}/share`], ['PUT', `/api/machines/${M1}/share`], ['GET', '/api/machine-shares'],
      ['POST', `/api/machine-shares/${M1}/add`], ['DELETE', `/api/machine-shares/${M1}/add`]] as const) {
      expect((await app.inject({ method, url })).statusCode).toBe(401)
    }
  })

  it('reads the owner’s policy: off by default, with the domain it may offer', async () => {
    let res = await app.inject({ method: 'GET', url: `/api/machines/${M1}/share`, headers: auth })
    expect(res.json().data).toEqual({ emails: [], sameDomain: false, domain: 'acme.io', members: [] })
    expect(mocks.prisma.machine.findFirst).toHaveBeenCalledWith({ where: expect.objectContaining({ machineId: M1, userId: 'dee', autonomousEnv: 'prod' }) })
    mocks.prisma.machineShare.findUnique.mockResolvedValueOnce(row())
    res = await app.inject({ method: 'GET', url: `/api/machines/${M1}/share`, headers: auth })
    expect(res.json().data).toEqual({ emails: ['ann@gmail.com'], sameDomain: true, domain: 'acme.io', members })
    // A row another owner wrote is not this one's policy.
    mocks.prisma.machineShare.findUnique.mockResolvedValueOnce(row({ ownerId: 'someone' }))
    res = await app.inject({ method: 'GET', url: `/api/machines/${M1}/share`, headers: auth })
    expect(res.json().data.emails).toEqual([])
  })

  it('offers no domain at a public one', async () => {
    mocks.auth.mockResolvedValue({ ...dee, email: 'dee@gmail.com' })
    const res = await app.inject({ method: 'GET', url: `/api/machines/${M1}/share`, headers: auth })
    expect(res.json().data.domain).toBeNull()
  })

  it('answers 404 for a machine the caller does not own, read or written', async () => {
    mocks.prisma.machine.findFirst.mockResolvedValue(null)
    expect((await app.inject({ method: 'GET', url: `/api/machines/${M1}/share`, headers: auth })).statusCode).toBe(404)
    expect((await put({ emails: [], sameDomain: false })).statusCode).toBe(404)
    expect(mocks.prisma.machineShare.upsert).not.toHaveBeenCalled()
  })

  it('writes normalized addresses (never the owner’s own) and the owner’s domain, and tells everyone affected', async () => {
    mocks.prisma.machineShare.findUnique.mockResolvedValueOnce(row({ emails: ['old@acme.io'], domain: null }))
    mocks.prisma.user.findMany.mockResolvedValue([{ id: 'ann' }, { id: 'kim' }, { id: 'dee' }])
    mocks.prisma.machineShareAdd.findMany.mockImplementation(async (args: { select?: unknown }) => args.select ? [{ userId: 'lee' }] : [])
    const res = await put({ emails: [' Ann@Gmail.com ', 'ann@gmail.com', 'DEE@acme.io', 'ghost@x.invalid'], sameDomain: true })
    expect(res.statusCode).toBe(200)
    expect(mocks.prisma.machineShare.upsert).toHaveBeenCalledWith({ where: { machineId: M1 },
      create: { machineId: M1, ownerId: 'dee', autonomousEnv: 'prod', emails: ['ann@gmail.com'], domain: 'acme.io', grantVersions: expect.any(Object) },
      update: { ownerId: 'dee', autonomousEnv: 'prod', emails: ['ann@gmail.com'], domain: 'acme.io', grantVersions: expect.any(Object) } })
    expect(res.json().data).toEqual({ emails: ['ann@gmail.com'], sameDomain: true, domain: 'acme.io', members })
    expect(mocks.shareChanged).toHaveBeenCalledWith(M1)
    expect(mocks.prisma.user.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { OR: [
      { email: { in: ['old@acme.io', 'ann@gmail.com'] } }, { email: { endsWith: '@acme.io' } }] } }))
    expect(mocks.listChanged.mock.calls.map(c => c[0]).sort()).toEqual(['ann', 'kim', 'lee'])
  })

  it('retries a concurrent policy update before choosing versions for the resulting grants', async () => {
    mocks.prisma.$transaction.mockRejectedValueOnce({ code: 'P2034' })
    const res = await put({ emails: ['ann@gmail.com'], sameDomain: false })
    expect(res.statusCode).toBe(200)
    expect(mocks.prisma.$transaction).toHaveBeenCalledTimes(2)
    expect(mocks.prisma.machineShare.upsert).toHaveBeenCalledOnce()
  })

  it('refuses everyone at a public domain', async () => {
    mocks.auth.mockResolvedValue({ ...dee, email: 'dee@gmail.com' })
    const res = await put({ emails: [], sameDomain: true })
    expect(res.statusCode).toBe(400)
    expect(res.json().error.code).toBe('PUBLIC_DOMAIN')
    expect(mocks.prisma.machineShare.upsert).not.toHaveBeenCalled()
  })

  it('stops sharing when no one is left: the policy and every add go', async () => {
    mocks.prisma.machineShare.findUnique.mockResolvedValueOnce(row())
    const res = await put({ emails: [], sameDomain: false })
    expect(res.json().data).toEqual({ emails: [], sameDomain: false, domain: 'acme.io', members: [] })
    expect(mocks.prisma.machineShare.deleteMany).toHaveBeenCalledWith({ where: { machineId: M1 } })
    expect(mocks.prisma.machineShareAdd.deleteMany).toHaveBeenCalledWith({ where: { machineId: M1 } })
    expect(mocks.prisma.machineShare.upsert).not.toHaveBeenCalled()
    expect(mocks.shareChanged).toHaveBeenCalledWith(M1)
  })

  it('tells no one when nothing was ever shared, and a failure to tell does not fail the write', async () => {
    await put({ emails: [], sameDomain: false })
    expect(mocks.prisma.user.findMany).not.toHaveBeenCalled()
    mocks.prisma.user.findMany.mockRejectedValueOnce(new Error('db down'))
    mocks.shareChanged.mockRejectedValueOnce(new Error('redis down'))
    expect((await put({ emails: ['ann@gmail.com'], sameDomain: false })).statusCode).toBe(200)
  })

  it('validates the policy', async () => {
    for (const body of [{ emails: ['nope'], sameDomain: false }, { emails: [], sameDomain: 'yes' }, { emails: [] },
      { emails: [], sameDomain: false, canControl: true }, { emails: Array.from({ length: SHARE_EMAILS_MAX + 1 }, (_, i) => `p${i}@acme.io`), sameDomain: false }]) {
      expect((await put(body)).statusCode).toBe(400)
    }
    expect((await put({ emails: [], sameDomain: false }, '../m1')).statusCode).toBeGreaterThanOrEqual(400)
  })

  it('lists the machines shared with the caller', async () => {
    mocks.sharedWith.mockResolvedValue([{ machineId: 'm9' }])
    const res = await app.inject({ method: 'GET', url: '/api/machine-shares', headers: auth })
    expect(res.json().data).toEqual({ machines: [{ machineId: 'm9' }] })
    expect(mocks.sharedWith).toHaveBeenCalledWith(dee)
  })

  describe('adding a machine shared with your domain', () => {
    const add = (method: 'POST' | 'DELETE' = 'POST') => app.inject({ method, url: `/api/machine-shares/${M1}/add`, headers: auth })
    beforeEach(() => { mocks.auth.mockResolvedValue(kim) })

    it('adds a domain share and tells the owner’s daemon and the caller', async () => {
      mocks.prisma.machineShare.findUnique.mockResolvedValue(row({ emails: [] }))
      expect((await add()).json().data).toEqual({ added: true })
      expect(mocks.prisma.machineShareAdd.upsert).toHaveBeenCalledWith({ where: { machineId_userId: { machineId: M1, userId: 'kim' } },
        create: { machineId: M1, userId: 'kim' }, update: {} })
      expect(mocks.listChanged.mock.calls.map(c => c[0])).toEqual(['dee', 'kim'])
    })

    it('answers added when a racing identical add stored it first', async () => {
      mocks.prisma.machineShare.findUnique.mockResolvedValue(row({ emails: [] }))
      mocks.prisma.machineShareAdd.upsert.mockRejectedValueOnce(Object.assign(new Error('Unique constraint failed'), { code: 'P2002' })).mockResolvedValueOnce({})
      const res = await add()
      expect(res.statusCode).toBe(200)
      expect(res.json().data).toEqual({ added: true })
      expect(mocks.prisma.machineShareAdd.upsert).toHaveBeenCalledTimes(2)
    })

    it('needs no add for a named address', async () => {
      mocks.prisma.machineShare.findUnique.mockResolvedValue(row({ emails: ['kim@acme.io'], domain: null }))
      expect((await add()).statusCode).toBe(200)
      expect(mocks.prisma.machineShareAdd.upsert).not.toHaveBeenCalled()
    })

    it('refuses a machine not shared with the caller, their own, another environment’s, or one gone', async () => {
      for (const share of [null, row({ emails: [], domain: 'other.io' }), row({ ownerId: 'kim' }), row({ autonomousEnv: 'stag' })]) {
        mocks.prisma.machineShare.findUnique.mockResolvedValueOnce(share)
        const res = await add()
        expect(res.statusCode).toBe(404)
        expect(res.json().error.code).toBe('NOT_SHARED')
      }
      mocks.prisma.machineShare.findUnique.mockResolvedValueOnce(row())
      mocks.prisma.machine.findFirst.mockResolvedValueOnce(null)
      expect((await add()).statusCode).toBe(404)
      expect(mocks.prisma.machineShareAdd.upsert).not.toHaveBeenCalled()
    })

    it('takes it back out, ending a live session and telling both', async () => {
      mocks.prisma.machineShareAdd.deleteMany.mockResolvedValueOnce({ count: 1 })
      mocks.prisma.machineShare.findUnique.mockResolvedValueOnce(row())
      expect((await add('DELETE')).json().data).toEqual({ removed: true })
      expect(mocks.prisma.machineShareAdd.deleteMany).toHaveBeenCalledWith({ where: { machineId: M1, userId: 'kim' } })
      expect(mocks.shareChanged).toHaveBeenCalledWith(M1)
      expect(mocks.listChanged.mock.calls.map(c => c[0])).toEqual(['dee', 'kim'])
    })

    it('says so when there was nothing to remove; a share gone since tells only the caller', async () => {
      expect((await add('DELETE')).json().data).toEqual({ removed: false })
      expect(mocks.listChanged).not.toHaveBeenCalled()
      mocks.prisma.machineShareAdd.deleteMany.mockResolvedValueOnce({ count: 1 })
      mocks.prisma.machineShare.findUnique.mockResolvedValueOnce(null)
      mocks.shareChanged.mockRejectedValueOnce(new Error('redis down'))
      expect((await add('DELETE')).statusCode).toBe(200)
      expect(mocks.listChanged.mock.calls.map(c => c[0])).toEqual(['kim'])
    })
  })
})
