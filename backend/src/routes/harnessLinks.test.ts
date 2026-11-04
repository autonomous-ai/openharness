import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { randomUUID } from 'node:crypto'
const m = vi.hoisted(() => ({
  prisma: { harnessLink: { findFirst: vi.fn(), findUnique: vi.fn(), findMany: vi.fn(), upsert: vi.fn(), updateMany: vi.fn() },
    harnessShare: { findFirst: vi.fn(), findMany: vi.fn() }, machine: { findFirst: vi.fn() } },
  auth: vi.fn(), presence: vi.fn(), changed: vi.fn(), confidential: vi.fn(),
}))
vi.mock('../lib/prisma.js', () => ({ prisma: m.prisma, machineAlive: { OR: [{ deletedAt: null }, { deletedAt: { isSet: false } }] } }))
vi.mock('../lib/bus.js', () => ({ getAgentPresenceMany: m.presence, publishShareChanged: m.changed }))
vi.mock('../superTabs/confidential.js', () => ({ confidentialSessions: m.confidential }))
vi.mock('../lib/ssoAuth.js', async original => ({ ...await original<typeof import('../lib/ssoAuth.js')>(), authenticateAccessToken: m.auth }))
import { harnessLinkRoutes, recipientLink, tellSessionViewers } from './harnessLinks.js'
import { stableId } from '../superTabs/model.js'
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
    m.confidential.mockResolvedValue(new Set())
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
  it('opens a link to a confidential session for its machine\'s owner alone, public or private, invited or not', async () => {
    // A Lead, or an agent in a private chat, in some Swarm (superTabs/confidential.ts): its screen holds people's private chats.
    m.confidential.mockImplementation(async (_db: unknown, ids: string[]) => new Set(ids))
    expect((await get()).statusCode).toBe(401)
    expect(m.confidential).toHaveBeenCalledWith(m.prisma, [stableId('m1', 'agent-1')])
    m.auth.mockResolvedValue(ken)
    m.prisma.harnessShare.findFirst.mockResolvedValue({ id: 'invitation' })
    for (const visibility of ['public', 'private']) {
      m.prisma.harnessLink.findFirst.mockResolvedValue({ ...link, visibility })
      expect((await get(auth)).statusCode).toBe(403)
    }
    m.auth.mockResolvedValue(owner)
    expect((await get(auth)).statusCode).toBe(200)
  })
  it('tells every share and link of a session that turned confidential to check again, and never fails for it', async () => {
    m.prisma.harnessLink.findMany.mockResolvedValue([{ id: 'link-1' }])
    m.prisma.harnessShare.findMany.mockResolvedValue([{ id: 'share-1' }, { id: 'share-2' }])
    await tellSessionViewers([{ machineId: 'm1', harnessId: 'agent-1', machineOwnerId: 'owner' }])
    const where = { machineId: 'm1', agentId: 'agent-1', ownerId: 'owner', revokedAt: null }
    expect(m.prisma.harnessLink.findMany).toHaveBeenCalledWith({ where, select: { id: true } })
    expect(m.prisma.harnessShare.findMany).toHaveBeenCalledWith({ where, select: { id: true } })
    expect(m.changed.mock.calls).toEqual([['link-1'], ['share-1'], ['share-2']])
    m.prisma.harnessLink.findMany.mockRejectedValue(new Error('db down'))
    await expect(tellSessionViewers([{ machineId: 'm1', harnessId: 'agent-1', machineOwnerId: 'owner' }])).resolves.toBeUndefined()
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
