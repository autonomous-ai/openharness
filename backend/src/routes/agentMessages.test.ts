import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { Prisma } from '@prisma/client'
const mocks = vi.hoisted(() => ({
  prisma: { desk: { findUnique: vi.fn() }, machine: { findMany: vi.fn() },
    agentMessageTab: { findMany: vi.fn(), upsert: vi.fn(), update: vi.fn() } },
  auth: vi.fn(),
  publish: vi.fn(),
}))
vi.mock('../lib/prisma.js', () => ({ prisma: mocks.prisma }))
vi.mock('../lib/bus.js', () => ({ publishDeskChanged: mocks.publish }))
vi.mock('../lib/ssoAuth.js', async original => ({ ...await original<typeof import('../lib/ssoAuth.js')>(), authenticateAccessToken: mocks.auth }))
import { agentMessagesRoutes } from './agentMessages.js'
import { agentMessageTabId } from '../lib/agentMessages.js'
import { registerAuthMiddleware } from '../middlewares/authMiddleware.js'
import { errorHandler } from '../middlewares/errorHandler.js'

describe('Agent Messages per tab', () => {
  let app: FastifyInstance
  const tab = { id: 'app', name: 'App', panes: [{ machineId: 'shared', agentId: 'observer' }, { machineId: 'm1', agentId: 'lead' }, { machineId: 'm2', agentId: 'api' }] }
  const other = { id: 'notes', name: 'Notes', panes: [{ machineId: 'm1', agentId: 'writer' }] }
  const auth = { authorization: 'Bearer fixture' }
  beforeEach(async () => {
    vi.resetAllMocks()
    mocks.auth.mockResolvedValue({ sub: 'owner', email: 'fixture@example.com', role: 'user', autonomousEnv: 'prod' })
    mocks.prisma.desk.findUnique.mockResolvedValue({ revision: 8, tabs: [tab, other] })
    mocks.prisma.machine.findMany.mockResolvedValue([{ machineId: 'm1', name: 'studio' }, { machineId: 'm2', name: null }])
    mocks.prisma.agentMessageTab.findMany.mockResolvedValue([])
    mocks.prisma.agentMessageTab.upsert.mockImplementation(async ({ create }) => create)
    mocks.publish.mockResolvedValue(0)
    app = Fastify(); app.setErrorHandler(errorHandler); registerAuthMiddleware(app, mocks.auth)
    await app.register(agentMessagesRoutes); await app.ready()
  })
  afterEach(async () => app.close())
  const read = () => app.inject({ method: 'GET', url: '/api/agent-messages', headers: auth })
  const set = (tabId: string, body: unknown, headers: Record<string, string> = auth) =>
    app.inject({ method: 'PATCH', url: `/api/agent-messages/tabs/${tabId}`, headers, payload: body as object })

  it('requires authentication', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/agent-messages' })).statusCode).toBe(401)
    expect((await set('app', { enabled: true }, {})).statusCode).toBe(401)
    expect(mocks.prisma.desk.findUnique).not.toHaveBeenCalled()
    expect(mocks.prisma.agentMessageTab.upsert).not.toHaveBeenCalled()
  })

  it('is off for every tab until a person turns one on, and lists only owned panes', async () => {
    const result = await read()
    expect(result.statusCode).toBe(200)
    expect(result.json().data).toEqual({ revision: 8, machines: [{ machineId: 'm1', name: 'studio' }, { machineId: 'm2', name: null }], tabs: [
      { id: 'app', name: 'App', enabled: false, panes: [{ machineId: 'm1', agentId: 'lead' }, { machineId: 'm2', agentId: 'api' }] },
      { id: 'notes', name: 'Notes', enabled: false, panes: [{ machineId: 'm1', agentId: 'writer' }] },
    ] })
    expect(mocks.prisma.agentMessageTab.findMany).toHaveBeenCalledWith({ where: { userId: 'owner' }, select: { userId: true, tabId: true, enabled: true } })
  })

  it('reads each tab\'s own flag, and never another account\'s record', async () => {
    mocks.prisma.agentMessageTab.findMany.mockResolvedValue([
      { userId: 'owner', tabId: 'app', enabled: true },
      { userId: 'owner', tabId: 'notes', enabled: false },
      { userId: 'someone-else', tabId: 'notes', enabled: true },
    ])
    const tabs = (await read()).json().data.tabs
    expect(tabs.map((t: { id: string; enabled: boolean }) => [t.id, t.enabled])).toEqual([['app', true], ['notes', false]])
  })

  it('answers an empty desk with no tabs', async () => {
    mocks.prisma.desk.findUnique.mockResolvedValue(null)
    expect((await read()).json().data).toEqual({ revision: 0, machines: [{ machineId: 'm1', name: 'studio' }, { machineId: 'm2', name: null }], tabs: [] })
  })

  it('turns one tab on, at its own address, and has the account\'s daemons read again', async () => {
    const result = await set('app', { enabled: true })
    expect(result.statusCode).toBe(200)
    expect(result.json().data).toEqual({ tabId: 'app', enabled: true, revision: 1 })
    expect(mocks.prisma.agentMessageTab.upsert).toHaveBeenCalledWith({ where: { id: agentMessageTabId('owner', 'app') },
      create: { id: agentMessageTabId('owner', 'app'), userId: 'owner', tabId: 'app', enabled: true, revision: 1 },
      update: { enabled: true, revision: { increment: 1 } } })
    expect(mocks.publish).toHaveBeenCalledWith('owner', { revision: 0 })
    expect(agentMessageTabId('owner', 'app')).toMatch(/^[0-9a-f]{24}$/)
    expect(agentMessageTabId('another', 'app')).not.toBe(agentMessageTabId('owner', 'app'))
  })

  it('converges when two first writes race', async () => {
    mocks.prisma.agentMessageTab.upsert.mockRejectedValue(new Prisma.PrismaClientKnownRequestError('duplicate', { code: 'P2002', clientVersion: 'fixture' }))
    mocks.prisma.agentMessageTab.update.mockResolvedValue({ userId: 'owner', tabId: 'app', enabled: false, revision: 4 })
    expect((await set('app', { enabled: false })).json().data).toEqual({ tabId: 'app', enabled: false, revision: 4 })
  })

  it('refuses a malformed body or tab, and a record that is not this tab\'s', async () => {
    expect((await set('app', { enabled: 'yes' })).statusCode).toBe(400)
    expect((await set('app', { enabled: true, extra: 1 })).statusCode).toBe(400)
    expect((await set('bad.tab', { enabled: true })).statusCode).toBe(400)
    expect(mocks.prisma.agentMessageTab.upsert).not.toHaveBeenCalled()
    mocks.prisma.agentMessageTab.upsert.mockResolvedValue({ userId: 'someone-else', tabId: 'app', enabled: true, revision: 1 })
    expect((await set('app', { enabled: true })).statusCode).toBe(500)
    mocks.prisma.agentMessageTab.upsert.mockRejectedValue(new Error('database down'))
    expect((await set('app', { enabled: true })).statusCode).toBe(500)
    expect(mocks.publish).not.toHaveBeenCalled()
  })
})
