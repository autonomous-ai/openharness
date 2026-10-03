import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { randomUUID } from 'node:crypto'
const m = vi.hoisted(() => ({
  prisma: { harnessLink: { findFirst: vi.fn(), findUnique: vi.fn(), upsert: vi.fn(), updateMany: vi.fn() },
    harnessShare: { findFirst: vi.fn() }, machine: { findFirst: vi.fn() } },
  auth: vi.fn(), presence: vi.fn(), changed: vi.fn(),
}))
vi.mock('../lib/prisma.js', () => ({ prisma: m.prisma, machineAlive: { OR: [{ deletedAt: null }, { deletedAt: { isSet: false } }] } }))
vi.mock('../lib/bus.js', () => ({ getAgentPresenceMany: m.presence, publishShareChanged: m.changed }))
vi.mock('../lib/ssoAuth.js', async original => ({ ...await original<typeof import('../lib/ssoAuth.js')>(), authenticateAccessToken: m.auth }))
import { harnessLinkRoutes, recipientLink } from './harnessLinks.js'
import { registerAuthMiddleware } from '../middlewares/authMiddleware.js'
import { errorHandler } from '../middlewares/errorHandler.js'

const owner = { sub: 'owner', email: 'owner@example.com', role: 'user', autonomousEnv: 'prod' as const }
const ken = { ...owner, sub: 'ken', email: ' Ken@Example.com ' }
const id = randomUUID()
const input = { machineId: 'm1', agentId: 'agent-1', name: 'Shared work', engine: 'codex',
  ownerPublicKey: Buffer.alloc(32, 1).toString('base64'), visibility: 'public' }
const link = { ...input, id, ownerId: owner.sub, autonomousEnv: 'prod', revokedAt: null }
const machine = { machineId: 'm1', userId: owner.sub, billingStatus: 'not_required' }
const auth = { authorization: 'Bearer fixture' }
describe('public/private browser links', () => {
  let app: FastifyInstance
  beforeEach(async () => {
    vi.resetAllMocks()
    m.auth.mockResolvedValue(owner)
    m.prisma.harnessLink.findFirst.mockResolvedValue(link)
    m.prisma.harnessLink.updateMany.mockResolvedValue({ count: 1 })
    m.prisma.machine.findFirst.mockResolvedValue(machine)
    m.presence.mockResolvedValue(new Map([['m1', true]]))
    app = Fastify(); app.setErrorHandler(errorHandler); registerAuthMiddleware(app, m.auth)
    await app.register(harnessLinkRoutes); await app.ready()
  })
  afterEach(async () => { await app.close() })
  const get = (headers = {}) => app.inject({ method: 'GET', url: `/api/shared-agents/${id}`, headers })
  const put = (payload: unknown = input) => app.inject({ method: 'PUT', url: `/api/harness-links/${id}`, headers: auth, payload: payload as any })
  it('allows only anonymous discovery, returns minimal public metadata, and forbids caching', async () => {
    const response = await get()
    expect(response.statusCode).toBe(200)
    expect(response.headers['cache-control']).toBe('no-store')
    expect(response.json().data).toEqual({ ...input, id, online: true, canComment: false })
    expect(m.auth).not.toHaveBeenCalled()
    expect((await get(auth)).json().data.canComment).toBe(true)
    for (const method of ['PUT', 'DELETE', 'POST'] as const) {
      expect((await app.inject({ method, url: `/api/harness-links/${id}` })).statusCode).toBe(401)
      expect((await app.inject({ method, url: `/api/shared-agents/${id}` })).statusCode).toBe(401)
    }
    m.presence.mockResolvedValue(new Map())
    expect((await get()).json().data.online).toBe(false)
    expect((await get({ 'x-autonomous-env': 'invalid' })).statusCode).toBe(400)
  })
  it('private links reveal nothing to guests or strangers and reuse only exact active email grants', async () => {
    m.prisma.harnessLink.findFirst.mockResolvedValue({ ...link, visibility: 'private' })
    expect((await get()).statusCode).toBe(401)
    m.auth.mockResolvedValue(ken)
    const denied = await get(auth)
    expect(denied.statusCode).toBe(403)
    expect(denied.json()).not.toHaveProperty('data')
    m.prisma.harnessShare.findFirst.mockResolvedValue({ id: 'invitation' })
    expect((await get(auth)).statusCode).toBe(200)
    expect(m.prisma.harnessShare.findFirst).toHaveBeenLastCalledWith({ where: {
      machineId: 'm1', agentId: 'agent-1', ownerId: 'owner', autonomousEnv: 'prod',
      recipientEmail: 'ken@example.com', revokedAt: null, expiresAt: { gt: expect.any(Date) },
    } })
    m.auth.mockResolvedValue(owner)
    expect((await get(auth)).statusCode).toBe(200)
    m.prisma.harnessShare.findFirst.mockResolvedValue(null)
    expect(await recipientLink(id, ken, 'prod')).toBeNull()
  })
  it('fails closed across deletion, revocation, environments and billing', async () => {
    m.prisma.harnessLink.findFirst.mockResolvedValue(null)
    expect(await recipientLink(id, null, 'prod')).toBeNull()
    expect(m.prisma.harnessLink.findFirst).toHaveBeenCalledWith({ where: { id, autonomousEnv: 'prod', revokedAt: null } })
    m.prisma.harnessLink.findFirst.mockResolvedValue(link)
    expect(await recipientLink(id, { ...ken, autonomousEnv: 'stag' }, 'prod')).toBeNull()
    m.prisma.machine.findFirst.mockResolvedValue(null)
    expect(await recipientLink(id, null, 'prod')).toBeNull()
    m.prisma.machine.findFirst.mockResolvedValue({ ...machine, billingStatus: 'suspended' })
    expect(await recipientLink(id, null, 'prod')).toBeNull()
  })
  it('binds metadata to the signed-in owner and notifies observers of visibility changes', async () => {
    expect((await put()).statusCode).toBe(200)
    expect(m.prisma.harnessLink.upsert).toHaveBeenCalledWith({ where: { id },
      create: { ...link }, update: { ...input, ownerId: owner.sub, autonomousEnv: 'prod', revokedAt: null } })
    m.prisma.harnessLink.findUnique.mockResolvedValue(link)
    expect((await put({ ...input, visibility: 'private' })).statusCode).toBe(200)
    expect(m.changed).toHaveBeenCalledWith(id)
    expect(m.prisma.machine.findFirst).toHaveBeenCalledWith({ where: expect.objectContaining({
      machineId: 'm1', userId: 'owner', autonomousEnv: 'prod', OR: expect.any(Array),
    }) })
  })
  it('rejects other owners, repurposed IDs, suspended/deleted machines, and invalid policy', async () => {
    for (const patch of [{ ownerId: 'stranger' }, { machineId: 'other' }, { agentId: 'other' }, { autonomousEnv: 'stag' }]) {
      m.prisma.harnessLink.findUnique.mockResolvedValue({ ...link, ...patch })
      expect((await put()).statusCode).toBe(403)
    }
    m.prisma.machine.findFirst.mockResolvedValue(null)
    expect((await put()).statusCode).toBe(403)
    m.prisma.machine.findFirst.mockResolvedValue({ ...machine, billingStatus: 'suspended' })
    expect((await put()).statusCode).toBe(403)
    for (const patch of [{ visibility: 'off' }, { ownerPublicKey: 'bad' }, { ownerId: 'spoof' }, { agentId: '' }]) {
      expect((await put({ ...input, ...patch })).statusCode).toBe(400)
    }
    expect(m.prisma.harnessLink.upsert).not.toHaveBeenCalled()
  })
  it('revokes only owner-scoped links; retries cannot revoke someone else’s link', async () => {
    const request = { method: 'DELETE' as const, url: `/api/harness-links/${id}`, headers: auth }
    expect((await app.inject(request)).json().data).toEqual({ removed: true })
    expect(m.prisma.harnessLink.updateMany).toHaveBeenCalledWith({ where: { id, ownerId: 'owner', autonomousEnv: 'prod' }, data: { revokedAt: expect.any(Date) } })
    expect(m.changed).toHaveBeenCalledWith(id)
    m.prisma.harnessLink.updateMany.mockResolvedValue({ count: 0 })
    expect((await app.inject(request)).statusCode).toBe(404)
  })
})
