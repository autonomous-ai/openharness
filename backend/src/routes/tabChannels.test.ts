import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { Prisma } from '@prisma/client'
const mocks = vi.hoisted(() => ({
  prisma: { desk: { findUnique: vi.fn() }, machine: { findMany: vi.fn() }, tabChannel: { findUnique: vi.fn(), create: vi.fn() },
    tabChannelSettings: { findUnique: vi.fn(), upsert: vi.fn(), update: vi.fn() } },
  auth: vi.fn(),
  publish: vi.fn(),
}))
vi.mock('../lib/prisma.js', () => ({ prisma: mocks.prisma }))
vi.mock('../lib/bus.js', () => ({ publishDeskChanged: mocks.publish }))
vi.mock('../lib/ssoAuth.js', async original => ({ ...await original<typeof import('../lib/ssoAuth.js')>(), authenticateAccessToken: mocks.auth }))
import { tabChannelRoutes } from './tabChannels.js'
import { tabChannelId } from '../lib/tabChannels.js'
import { registerAuthMiddleware } from '../middlewares/authMiddleware.js'
import { errorHandler } from '../middlewares/errorHandler.js'

describe('isolated tab-channel routing', () => {
  let app: FastifyInstance
  const tab = { id: 'device', name: 'Device', panes: [{ machineId: 'shared', agentId: 'observer' }, { machineId: 'm1', agentId: 'mobile' }, { machineId: 'm2', agentId: 'firmware' }] }
  beforeEach(async () => {
    vi.resetAllMocks()
    mocks.auth.mockResolvedValue({ sub: 'owner', email: 'fixture@example.com', role: 'user', autonomousEnv: 'prod' })
    mocks.prisma.tabChannelSettings.findUnique.mockResolvedValue({ userId: 'owner', enabled: true, revision: 1 })
    mocks.prisma.tabChannelSettings.upsert.mockImplementation(async ({ create }) => create)
    mocks.publish.mockResolvedValue(0)
    mocks.prisma.desk.findUnique.mockResolvedValue({ revision: 8, tabs: [tab] })
    mocks.prisma.machine.findMany.mockResolvedValue([{ machineId: 'm1' }, { machineId: 'm2' }])
    mocks.prisma.tabChannel.findUnique.mockResolvedValue(null)
    mocks.prisma.tabChannel.create.mockImplementation(async ({ data }) => data)
    app = Fastify(); app.setErrorHandler(errorHandler); registerAuthMiddleware(app, mocks.auth)
    await app.register(tabChannelRoutes); await app.ready()
  })
  afterEach(async () => app.close())
  const read = () => app.inject({ method: 'GET', url: '/api/tab-channels', headers: { authorization: 'Bearer fixture' } })

  it('requires authentication', async () => {
    const result = await app.inject({ method: 'GET', url: '/api/tab-channels' })
    expect(result.statusCode).toBe(401)
    expect(mocks.prisma.desk.findUnique).not.toHaveBeenCalled()
  })
  it('claims one owned host, excludes observation panes and preserves the existing desk format', async () => {
    const before = structuredClone(tab)
    const result = await read()
    expect(result.statusCode).toBe(200)
    expect(result.json().data).toEqual({ enabled: true, settingsRevision: 1, revision: 8, tabs: [{ ...tab, panes: tab.panes.slice(1), channelHost: 'm1' }] })
    expect(mocks.prisma.machine.findMany).toHaveBeenCalledWith({ where: { userId: 'owner' }, select: { machineId: true } })
    expect(mocks.prisma.tabChannel.create).toHaveBeenCalledWith({ data: { id: tabChannelId('owner', 'device'), userId: 'owner', tabId: 'device', hostMachineId: 'm1' } })
    expect(tab).toEqual(before)
    expect(tab).not.toHaveProperty('channelHost')
  })
  it('retains the original ledger host after its agent leaves', async () => {
    mocks.prisma.tabChannel.findUnique.mockResolvedValue({ userId: 'owner', tabId: 'device', hostMachineId: 'm1' })
    mocks.prisma.desk.findUnique.mockResolvedValue({ revision: 9, tabs: [{ ...tab, panes: [tab.panes[2]] }] })
    expect((await read()).json().data.tabs[0].channelHost).toBe('m1')
    expect(mocks.prisma.tabChannel.create).not.toHaveBeenCalled()
  })
  it('uses the winner of a concurrent claim without replacing its host', async () => {
    mocks.prisma.tabChannel.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({ userId: 'owner', tabId: 'device', hostMachineId: 'm2' })
    mocks.prisma.tabChannel.create.mockRejectedValue(new Prisma.PrismaClientKnownRequestError('duplicate', { code: 'P2002', clientVersion: 'fixture' }))
    expect((await read()).json().data.tabs[0].channelHost).toBe('m2')
    expect(tabChannelId('another-user', 'device')).not.toBe(tabChannelId('owner', 'device'))
  })
  it('does not create a channel host for empty tabs or tabs containing only shared views', async () => {
    mocks.prisma.machine.findMany.mockResolvedValue([])
    expect((await read()).json().data.tabs[0]).toEqual({ ...tab, panes: [] })
    expect(mocks.prisma.tabChannel.create).not.toHaveBeenCalled()
  })
  it('defaults off without creating settings, reading tabs or registering hosts', async () => {
    mocks.prisma.tabChannelSettings.findUnique.mockResolvedValue(null)
    expect((await read()).json().data).toEqual({ enabled: false, settingsRevision: 0, revision: 0, tabs: [] })
    const settings = await app.inject({ method: 'GET', url: '/api/tab-channels/settings', headers: { authorization: 'Bearer fixture' } })
    expect(settings.json().data).toEqual({ enabled: false, revision: 0 })
    expect(mocks.prisma.tabChannelSettings.upsert).not.toHaveBeenCalled()
    expect(mocks.prisma.desk.findUnique).not.toHaveBeenCalled()
    expect(mocks.prisma.tabChannel.create).not.toHaveBeenCalled()
  })
  it('saves only an explicit authenticated boolean and invalidates the account daemons', async () => {
    const request = (body: unknown, auth = true) => app.inject({ method: 'PATCH', url: '/api/tab-channels/settings',
      headers: auth ? { authorization: 'Bearer fixture' } : {}, payload: body as object })
    expect((await request({ enabled: true }, false)).statusCode).toBe(401)
    expect((await request({ enabled: 'true' })).statusCode).toBe(400)
    expect(mocks.prisma.tabChannelSettings.upsert).not.toHaveBeenCalled()
    expect((await request({ enabled: true })).json().data).toEqual({ enabled: true, revision: 1 })
    expect(mocks.prisma.tabChannelSettings.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: tabChannelId('owner', 'settings') }, create: expect.objectContaining({ userId: 'owner', enabled: true }),
    }))
    expect(mocks.publish).toHaveBeenCalledWith('owner', { revision: 0 })
    expect((await request({ enabled: false })).json().data.enabled).toBe(false)
  })
})
