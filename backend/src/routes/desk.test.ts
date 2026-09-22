import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
const mocks = vi.hoisted(() => ({
  prisma: { desk: { findUnique: vi.fn(), updateMany: vi.fn(), create: vi.fn() } },
  changed: vi.fn(), auth: vi.fn(),
}))
vi.mock('../lib/prisma.js', () => ({ prisma: mocks.prisma }))
vi.mock('../lib/bus.js', () => ({ publishDeskChanged: mocks.changed }))
vi.mock('../lib/ssoAuth.js', async original => ({ ...await original<typeof import('../lib/ssoAuth.js')>(), authenticateAccessToken: mocks.auth }))
import { deskRoutes } from './desk.js'
import { applyDeskOp, applyDeskOps, deskTabSchema, parseTabs, DESK_MAX_TABS, type DeskLayout, type DeskTab } from '../lib/desk.js'
import { registerAuthMiddleware } from '../middlewares/authMiddleware.js'
import { errorHandler } from '../middlewares/errorHandler.js'

const user = { sub: 'u1', email: 'd@example.com', role: 'user', autonomousEnv: 'prod' as const }
const tab = (id: string, panes: Array<[string, string]> = []): DeskTab =>
  ({ id, name: `Tab ${id}`, panes: panes.map(([machineId, agentId]) => ({ machineId, agentId })) })

describe('desk ops — the merge rule', () => {
  it('creates, renames, moves and closes tabs, and says when nothing moved', () => {
    let r = applyDeskOp([], { op: 'tab.create', id: 'a', name: 'Local' })
    expect(r.changed).toBe(true)
    r = applyDeskOp(r.tabs, { op: 'tab.create', id: 'a', name: 'Local' })     // the same click twice
    expect(r.changed).toBe(false)
    r = applyDeskOp(r.tabs, { op: 'tab.create', id: 'b', name: 'Blender', index: 0 })
    expect(r.tabs.map(t => t.id)).toEqual(['b', 'a'])
    r = applyDeskOp(r.tabs, { op: 'tab.rename', id: 'a', name: 'Home', nameIsCustom: true })
    expect(r.tabs[1]).toMatchObject({ name: 'Home', nameIsCustom: true })
    r = applyDeskOp(r.tabs, { op: 'tab.move', id: 'a', index: 0 })
    expect(r.tabs.map(t => t.id)).toEqual(['a', 'b'])
    r = applyDeskOp(r.tabs, { op: 'tab.close', id: 'b' })
    expect(r.tabs.map(t => t.id)).toEqual(['a'])
    r = applyDeskOp(r.tabs, { op: 'tab.close', id: 'b' })                      // already gone
    expect(r.changed).toBe(false)
  })

  it('adds, moves and removes panes; a pane is one (machine, agent) once per tab', () => {
    let r = applyDeskOps([tab('a')], [
      { op: 'pane.add', tabId: 'a', machineId: 'm1', agentId: 'x' },
      { op: 'pane.add', tabId: 'a', machineId: 'm2', agentId: 'y' },
      { op: 'pane.add', tabId: 'a', machineId: 'm1', agentId: 'x' },            // twice = once
    ])
    expect(r.tabs[0].panes).toEqual([{ machineId: 'm1', agentId: 'x' }, { machineId: 'm2', agentId: 'y' }])
    r = applyDeskOp(r.tabs, { op: 'pane.move', tabId: 'a', machineId: 'm2', agentId: 'y', index: 0 })
    expect(r.tabs[0].panes[0]).toEqual({ machineId: 'm2', agentId: 'y' })
    r = applyDeskOp(r.tabs, { op: 'pane.remove', tabId: 'a', machineId: 'm1', agentId: 'x' })
    expect(r.tabs[0].panes).toHaveLength(1)
    expect(applyDeskOp(r.tabs, { op: 'pane.remove', tabId: 'a', machineId: 'm1', agentId: 'x' }).changed).toBe(false)
  })

  it('drops an op on a tab that is gone — close here, add there, and the add lands on nothing', () => {
    // Window A closed the tab; window B, offline, queued a pane for it. B's replay must not resurrect it.
    const afterClose = applyDeskOp([tab('a'), tab('b')], { op: 'tab.close', id: 'a' }).tabs
    const replayed = applyDeskOps(afterClose, [
      { op: 'pane.add', tabId: 'a', machineId: 'm1', agentId: 'x' },
      { op: 'tab.rename', id: 'a', name: 'Renamed' },
      { op: 'tab.move', id: 'a', index: 0 },
    ])
    expect(replayed.changed).toBe(false)
    expect(replayed.tabs.map(t => t.id)).toEqual(['b'])
  })

  it('carries a tab\'s layout as one value: replaced whole, idempotent, dropped for a tab that is gone', () => {
    const layout: DeskLayout = { presets: { '2': 'rows' }, sizes: { '2:manual': [[0, 0, 0.3, 1], [0.3, 0, 1, 1]] } }
    let r = applyDeskOp([tab('a')], { op: 'tab.layout', id: 'a', layout })
    expect(r.changed).toBe(true)
    expect(r.tabs[0].layout).toEqual(layout)
    expect(applyDeskOp(r.tabs, { op: 'tab.layout', id: 'a', layout }).changed).toBe(false)
    r = applyDeskOp(r.tabs, { op: 'tab.layout', id: 'a', layout: { presets: { '2': 'columns' } } })
    expect(r.tabs[0].layout).toEqual({ presets: { '2': 'columns' } })          // replaced, not merged
    expect(applyDeskOp(r.tabs, { op: 'tab.layout', id: 'gone', layout }).changed).toBe(false)
    expect(deskTabSchema.safeParse({ ...tab('a'), layout }).success).toBe(true)
    expect(deskTabSchema.safeParse({ ...tab('a'), layout: { sizes: { k: [[0, 0, 2, 1], [0, 0, 1, 1]] } } }).success).toBe(false)
  })

  it('seeds a computer\'s own tabs once, by id, and never past the cap', () => {
    const local = [tab('l1', [['m1', 'x']]), tab('l2')]
    let r = applyDeskOp([tab('a')], { op: 'seed', tabs: local })
    expect(r.tabs.map(t => t.id)).toEqual(['a', 'l1', 'l2'])
    expect(applyDeskOp(r.tabs, { op: 'seed', tabs: local }).changed).toBe(false)   // second sign-in: nothing
    const many = Array.from({ length: DESK_MAX_TABS + 5 }, (_, i) => tab(`t${i}`))
    r = applyDeskOp([], { op: 'seed', tabs: many.slice(0, DESK_MAX_TABS) })
    expect(r.tabs).toHaveLength(DESK_MAX_TABS)
    expect(applyDeskOp(r.tabs, { op: 'tab.create', id: 'one-more', name: 'x' }).changed).toBe(false)
  })

  it('reads stored tabs shape by shape and drops what does not parse', () => {
    expect(parseTabs([tab('a'), { id: 'b' }, 'junk', tab('a')])).toEqual([tab('a')])
    expect(parseTabs(null)).toEqual([])
  })
})

describe('desk routes', () => {
  let app: FastifyInstance
  beforeEach(async () => {
    vi.resetAllMocks()
    mocks.auth.mockResolvedValue(user)
    mocks.changed.mockResolvedValue(1)
    app = Fastify(); app.setErrorHandler(errorHandler); registerAuthMiddleware(app, mocks.auth)
    await app.register(deskRoutes); await app.ready()
  })
  afterEach(async () => { await app.close() })
  const auth = { authorization: 'Bearer fixture' }
  const post = (ops: unknown) => app.inject({ method: 'POST', url: '/api/desk/ops', headers: auth, payload: { ops } as any })

  it('answers an empty desk for a user who has none', async () => {
    mocks.prisma.desk.findUnique.mockResolvedValue(null)
    const res = await app.inject({ method: 'GET', url: '/api/desk', headers: auth })
    expect(res.json()).toEqual({ success: true, data: { revision: 0, tabs: [] } })
  })

  it('creates the row on the first write and tells every adapter of the user', async () => {
    mocks.prisma.desk.findUnique.mockResolvedValue(null)
    mocks.prisma.desk.updateMany.mockResolvedValue({ count: 0 })
    mocks.prisma.desk.create.mockResolvedValue({})
    const res = await post([{ op: 'tab.create', id: 'a', name: 'Local' }])
    expect(res.json().data).toEqual({ revision: 1, tabs: [{ id: 'a', name: 'Local', panes: [] }] })
    expect(mocks.prisma.desk.create).toHaveBeenCalledWith({ data: { userId: 'u1', revision: 1, tabs: [{ id: 'a', name: 'Local', panes: [] }] } })
    expect(mocks.changed).toHaveBeenCalledWith('u1', { revision: 1 })
  })

  it('bumps the revision with a compare-and-set, and replays on a lost race', async () => {
    // First read sees revision 3; the update finds 4 (another window wrote); the re-read sees 4.
    mocks.prisma.desk.findUnique
      .mockResolvedValueOnce({ revision: 3, tabs: [tab('a')] })
      .mockResolvedValueOnce({ revision: 4, tabs: [tab('a'), tab('b')] })
    mocks.prisma.desk.updateMany
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 1 })
    const res = await post([{ op: 'pane.add', tabId: 'a', machineId: 'm1', agentId: 'x' }])
    expect(res.json().data).toEqual({ revision: 5, tabs: [tab('a', [['m1', 'x']]), tab('b')] })
    expect(mocks.prisma.desk.updateMany).toHaveBeenLastCalledWith({
      where: { userId: 'u1', revision: 4 },
      data: { revision: 5, tabs: [tab('a', [['m1', 'x']]), tab('b')] },
    })
    expect(mocks.prisma.desk.create).not.toHaveBeenCalled()
  })

  it('writes nothing, and says where the desk is, when the ops change nothing', async () => {
    mocks.prisma.desk.findUnique.mockResolvedValue({ revision: 7, tabs: [tab('a')] })
    const res = await post([{ op: 'tab.close', id: 'gone' }])
    expect(res.json().data).toEqual({ revision: 7, tabs: [tab('a')] })
    expect(mocks.prisma.desk.updateMany).not.toHaveBeenCalled()
    expect(mocks.changed).not.toHaveBeenCalled()
  })

  it('refuses a malformed op and a tab name longer than the strip can show', async () => {
    mocks.prisma.desk.findUnique.mockResolvedValue(null)
    expect((await post([{ op: 'tab.explode', id: 'a' }])).statusCode).toBe(400)
    expect((await post([{ op: 'tab.create', id: 'a', name: 'x'.repeat(81) }])).statusCode).toBe(400)
    expect((await post([])).statusCode).toBe(400)
  })

  it('gives up after five lost races rather than spinning', async () => {
    mocks.prisma.desk.findUnique.mockResolvedValue({ revision: 2, tabs: [] })
    mocks.prisma.desk.updateMany.mockResolvedValue({ count: 0 })
    const res = await post([{ op: 'tab.create', id: 'a', name: 'Local' }])
    expect(res.statusCode).toBe(409)
    expect(res.json().error.code).toBe('DESK_BUSY')
    expect(mocks.prisma.desk.updateMany).toHaveBeenCalledTimes(5)
  })
})
