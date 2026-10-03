import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { Prisma } from '@prisma/client'
const mocks = vi.hoisted(() => ({
  prisma: { experimentalSettings: { findUnique: vi.fn(), upsert: vi.fn(), update: vi.fn() }, zoo: { findUnique: vi.fn() } },
  auth: vi.fn(), deskChanged: vi.fn(), zooChanged: vi.fn(),
}))
vi.mock('../lib/prisma.js', () => ({ prisma: mocks.prisma }))
vi.mock('../lib/bus.js', () => ({ publishDeskChanged: mocks.deskChanged, publishZooChanged: mocks.zooChanged }))
vi.mock('../lib/ssoAuth.js', async original => ({ ...await original<typeof import('../lib/ssoAuth.js')>(), authenticateAccessToken: mocks.auth }))
import { experimentalSettingsRoutes } from './experimentalSettings.js'
import { experimentalSettingsId } from '../lib/experimentalSettings.js'
import { zooRoutes } from './zoo.js'
import { emptyZoo } from '../lib/zoo.js'
import { DAEMONS_DARK, DAEMONS_EVERYONE, type DaemonsSwitch } from '../lib/daemonsSwitch.js'
import { registerAuthMiddleware } from '../middlewares/authMiddleware.js'
import { errorHandler } from '../middlewares/errorHandler.js'

type Row = { id: string; userId: string; focusBarCreature: boolean; shareButton: boolean; devicesTab?: boolean; revision: number }
describe('account experiments and retained collections', () => {
  let app: FastifyInstance
  let rows: Map<string, Row>
  const auth = { authorization: 'Bearer fixture' }
  async function makeApp(daemons: DaemonsSwitch = DAEMONS_EVERYONE) {
    const server = Fastify(); server.setErrorHandler(errorHandler); registerAuthMiddleware(server, mocks.auth)
    await server.register(experimentalSettingsRoutes, { daemons })
    await server.register(zooRoutes, { daemons, requireAccountOptIn: true }); await server.ready()
    return server
  }
  beforeEach(async () => {
    vi.resetAllMocks(); rows = new Map()
    mocks.auth.mockResolvedValue({ sub: 'owner', email: 'fixture@example.com', role: 'user', autonomousEnv: 'prod' })
    mocks.deskChanged.mockResolvedValue(0); mocks.zooChanged.mockResolvedValue(0)
    mocks.prisma.experimentalSettings.findUnique.mockImplementation(async ({ where }) => rows.get(where.id) ?? null)
    mocks.prisma.experimentalSettings.update.mockImplementation(async ({ where, data }) => {
      const row = { ...rows.get(where.id)! }
      for (const key of ['focusBarCreature', 'shareButton', 'devicesTab'] as const) if (key in data) row[key] = data[key]
      row.revision++; rows.set(row.id, row); return row
    })
    mocks.prisma.experimentalSettings.upsert.mockImplementation(async ({ where, create, update }) => {
      if (rows.has(where.id)) return mocks.prisma.experimentalSettings.update({ where, data: update })
      rows.set(where.id, create); return create
    })
    mocks.prisma.zoo.findUnique.mockResolvedValue(null)
    app = await makeApp()
  })
  afterEach(async () => app.close())
  const read = () => app.inject({ method: 'GET', url: '/api/experimental-settings', headers: auth })
  const write = (feature: string, enabled: boolean, accountId = 'owner') => app.inject({
    method: 'PATCH', url: '/api/experimental-settings', headers: auth, payload: { accountId, feature, enabled },
  })
  const zoo = () => app.inject({ method: 'GET', url: '/api/zoo', headers: auth })

  it('requires authentication and defaults off without writing or reading the collection', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/experimental-settings' })).statusCode).toBe(401)
    expect(mocks.prisma.experimentalSettings.findUnique).not.toHaveBeenCalled()
    expect((await read()).json().data).toEqual({ accountId: 'owner', revision: 0,
      features: { focus_bar_creature: false, share_button: false, devices_tab: false }, available: { focus_bar_creature: true, share_button: true, devices_tab: true } })
    expect(rows.size).toBe(0)
    expect((await zoo()).statusCode).toBe(404)
    expect(mocks.prisma.zoo.findUnique).not.toHaveBeenCalled()
  })
  it('shares choices between clients without losing concurrent changes to different switches', async () => {
    expect((await Promise.all([write('focus_bar_creature', true), write('share_button', true)])).map(r => r.statusCode)).toEqual([200, 200])
    expect((await read()).json().data).toMatchObject({ revision: 2, features: { focus_bar_creature: true, share_button: true } })
    expect((await write('share_button', false)).json().data.features).toEqual({ focus_bar_creature: true, share_button: false, devices_tab: false })
    expect(mocks.deskChanged).toHaveBeenCalledWith('owner', { revision: 0 })
    expect(mocks.zooChanged).toHaveBeenCalledExactlyOnceWith('owner', { revision: 0 })
  })
  it('keeps Devices off for existing accounts and changes only the requested flag', async () => {
    const id = experimentalSettingsId('owner')
    rows.set(id, { id, userId: 'owner', focusBarCreature: false, shareButton: true, revision: 8 })
    expect((await read()).json().data.features.devices_tab).toBe(false)
    expect((await write('devices_tab', true)).json().data.features).toEqual({
      focus_bar_creature: false, share_button: true, devices_tab: true,
    })
    expect((await write('devices_tab', false)).json().data.features.devices_tab).toBe(false)
    mocks.auth.mockResolvedValue({ sub: 'second', role: 'user' })
    expect((await read()).json().data.features.devices_tab).toBe(false)
  })
  it('rejects malformed writes and requests created before an account switch', async () => {
    expect((await write('focus_bar_creature', true, 'another-account')).statusCode).toBe(409)
    expect((await write('unknown', true)).statusCode).toBe(400)
    expect((await app.inject({ method: 'PATCH', url: '/api/experimental-settings', headers: auth,
      payload: { accountId: 'owner', feature: 'share_button', enabled: 'true' } })).statusCode).toBe(400)
    expect(rows.size).toBe(0); expect(mocks.deskChanged).not.toHaveBeenCalled()
  })
  it('isolates accounts and resumes the same collection after off/on', async () => {
    const collection = { ...emptyZoo(), habits: ['turn', 'split'], eggs: [{ id: 'saved-egg', kind: 'first', grantedAt: '2026-09-28T00:00:00.000Z' }] }
    mocks.prisma.zoo.findUnique.mockImplementation(async ({ where }) => where.userId === 'owner' ? { revision: 7, state: collection } : null)
    await write('focus_bar_creature', true)
    expect((await zoo()).json().data).toEqual({ revision: 7, zoo: collection })
    await write('focus_bar_creature', false); expect((await zoo()).statusCode).toBe(404)
    await write('focus_bar_creature', true)
    expect((await zoo()).json().data).toEqual({ revision: 7, zoo: collection })
    mocks.auth.mockResolvedValue({ sub: 'second', email: 'second@example.com', role: 'user', autonomousEnv: 'prod' })
    expect((await read()).json().data.features.focus_bar_creature).toBe(false)
    expect((await zoo()).statusCode).toBe(404)
    await write('focus_bar_creature', true, 'second')
    expect((await zoo()).json().data.zoo).toEqual(emptyZoo())
  })
  it('retries a concurrent first write without replacing the other switch', async () => {
    const id = experimentalSettingsId('owner')
    rows.set(id, { id, userId: 'owner', focusBarCreature: true, shareButton: false, revision: 1 })
    mocks.prisma.experimentalSettings.upsert.mockRejectedValueOnce(new Prisma.PrismaClientKnownRequestError('duplicate', { code: 'P2002', clientVersion: 'fixture' }))
    expect((await write('share_button', true)).json().data).toMatchObject({ revision: 2, features: { focus_bar_creature: true, share_button: true } })
  })
  it('respects the operator off switch without changing account choices', async () => {
    await app.close(); app = await makeApp(DAEMONS_DARK)
    expect((await read()).json().data.available.focus_bar_creature).toBe(false)
    expect((await write('focus_bar_creature', true)).statusCode).toBe(503)
    expect(rows.size).toBe(0)
    expect((await write('share_button', true)).statusCode).toBe(200)
    expect((await zoo()).statusCode).toBe(404)
  })
})
