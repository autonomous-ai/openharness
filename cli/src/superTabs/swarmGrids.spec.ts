import { describe, expect, it, vi } from 'vitest'
import { fakeCore } from '../testing/fakeCore.js'
import { GRID_POLL_MS, SwarmGrids } from './swarmGrids.js'
import { SuperTabHostError } from './host.js'

const GRID = 'swarm-0123456789ab'
type Row = Record<string, unknown>

function fixture(rows: Row[], answer: (payload: Row) => Promise<unknown> = async () => ({ ready: true, added: [], removed: [] })) {
  let now = 1_000
  const core = fakeCore({ dataDir: '/isolated-grid-fixture' })
  const backend = vi.fn(async (_core: unknown, method: string, _path: string, _body?: unknown): Promise<unknown> => method === 'GET' ? rows : { revision: 1 })
  const request = vi.fn(async (_type: string, payload: Row, _timeout?: number) => answer(payload))
  const close = vi.fn(), open = vi.fn(async () => ({ request, close }))
  let id = 0
  const grids = new SwarmGrids(core, 'host', { backend, open, now: () => now, newId: () => `id${++id}` } as never)
  const posts = () => backend.mock.calls.filter(c => c[1] === 'POST').map(c => [c[2], c[3]])
  return { grids, backend, request, open, close, posts, later: () => { now += GRID_POLL_MS } }
}
const row = (patch: Row = {}): Row => ({ tabId: 'tab1', grid: GRID, enabled: true, ready: false, members: ['b@example.com', 'a@example.com', 7], ...patch })

describe('the owner\'s Swarm grids', () => {
  it('are not asked for by a daemon that runs team work only', async () => {
    const f = fixture([row()])
    const team = new SwarmGrids(fakeCore({ dataDir: '/isolated-grid-fixture' }), 'host', { backend: f.backend, open: f.open, now: () => 1_000,
      newId: () => 'id', team: () => true } as never)
    await team.tick()
    expect(f.backend).not.toHaveBeenCalled()
    expect(f.open).not.toHaveBeenCalled()
  })

  it('brings a turned-on Swarm\'s grid to its people and tells the Swarm, then leaves it alone until something changes', async () => {
    const f = fixture([row()])
    await f.grids.tick()
    expect(f.backend).toHaveBeenCalledWith(expect.anything(), 'GET', '/api/super-tabs/grids')
    expect(f.request).toHaveBeenCalledWith('grid_swarm_sync', { grid: GRID, members: ['a@example.com', 'b@example.com'] }, 180_000)
    expect(f.posts()).toEqual([['/api/super-tabs/tab1/commands', { operationId: 'grid-id1', command: { type: 'localModels.status', grid: GRID, ready: true } }]])
    expect(f.close).toHaveBeenCalledOnce()
    // Within the minute nothing is read; after it, a ready grid with the same people is not asked again.
    await f.grids.tick()
    expect(f.backend).toHaveBeenCalledTimes(2)
    f.backend.mockImplementation((async (_c: unknown, method: string) => method === 'GET' ? [row({ ready: true })] : {}) as never)
    f.later(); await f.grids.tick()
    expect(f.request).toHaveBeenCalledOnce()
    expect(f.open).toHaveBeenCalledOnce()
    // A new person is.
    f.backend.mockImplementation((async (_c: unknown, method: string) => method === 'GET' ? [row({ ready: true, members: ['c@example.com'] })] : {}) as never)
    f.later(); await f.grids.tick()
    expect(f.request).toHaveBeenLastCalledWith('grid_swarm_sync', { grid: GRID, members: ['c@example.com'] }, 180_000)
  })
  it('reports a failure in grid\'s words, and tries again a minute later', async () => {
    const f = fixture([row({ members: undefined })], async () => ({ ready: false, error: 'x'.repeat(600) }))
    await f.grids.tick()
    expect(f.request).toHaveBeenCalledWith('grid_swarm_sync', { grid: GRID, members: [] }, 180_000)
    expect(f.posts()[0]![1]).toMatchObject({ command: { ready: false, error: 'x'.repeat(500) } })
    f.request.mockRejectedValueOnce(new Error('daemon gone'))
    f.later(); await f.grids.tick()
    expect(f.posts()[1]![1]).toMatchObject({ command: { ready: false, error: 'daemon gone' } })
    f.request.mockRejectedValueOnce('odd')
    f.later(); await f.grids.tick()
    expect(f.posts()[2]![1]).toMatchObject({ command: { ready: false, error: 'The grid could not be reached.' } })
    f.request.mockResolvedValueOnce(null)
    f.later(); await f.grids.tick()
    expect(f.posts()[3]![1]).toMatchObject({ command: { ready: false } })
    expect(f.posts()[3]![1]).not.toHaveProperty('command.error')
  })
  it('opens nothing when no Swarm has the add-on on, and forgets a Swarm that turned it off', async () => {
    const f = fixture([row({ enabled: false }), row({ tabId: '../x' }), row({ grid: 7 }), 'junk' as unknown as Row])
    await f.grids.tick()
    expect(f.open).not.toHaveBeenCalled()
    f.backend.mockImplementation((async (_c: unknown, method: string) => method === 'GET' ? [row({ ready: true })] : {}) as never)
    f.later(); await f.grids.tick()
    expect(f.request).toHaveBeenCalledOnce()
    // Off, then on again: asked afresh, though nothing else changed.
    f.backend.mockImplementation((async (_c: unknown, method: string) => method === 'GET' ? { not: 'a list' } : {}) as never)
    f.later(); await f.grids.tick()
    f.backend.mockImplementation((async (_c: unknown, method: string) => method === 'GET' ? [row({ ready: true })] : {}) as never)
    f.later(); await f.grids.tick()
    expect(f.request).toHaveBeenCalledTimes(2)
  })
  it('leaves a grid another of the owner\'s computers keeps ready alone, when this one cannot set grid up', async () => {
    const failed = { ready: false, error: 'Grid could not be set up on this computer. Try again.' }
    const f = fixture([row({ ready: true })], async () => failed)
    await f.grids.tick()
    expect(f.request).toHaveBeenCalledOnce()
    expect(f.posts()).toEqual([])
    // Not asked again each minute while the other computer keeps it ready.
    f.later(); await f.grids.tick()
    expect(f.request).toHaveBeenCalledOnce()
    // Once the Swarm shows it failed (the other computer could not either), this one tries and says so.
    f.backend.mockImplementation((async (_c: unknown, method: string) => method === 'GET' ? [row({ ready: false })] : {}) as never)
    f.later(); await f.grids.tick()
    expect(f.posts()).toEqual([['/api/super-tabs/tab1/commands', { operationId: 'grid-id1', command: { type: 'localModels.status', grid: GRID, ...failed } }]])
  })
  it('still reports a failure on a grid it kept ready itself', async () => {
    const f = fixture([row()])
    await f.grids.tick()
    f.request.mockResolvedValueOnce({ ready: false, error: 'grid is down' })
    f.backend.mockImplementation((async (_c: unknown, method: string) => method === 'GET' ? [row({ ready: true, members: ['c@example.com'] })] : {}) as never)
    f.later(); await f.grids.tick()
    expect(f.posts()[1]![1]).toMatchObject({ command: { ready: false, error: 'grid is down' } })
  })
  it('does not ask grid again about a refusal only the person can change, until the Swarm\'s people change', async () => {
    const f = fixture([row()], async () => ({ ready: false, error: 'Free plan allows one network', final: true }))
    await f.grids.tick()
    f.backend.mockImplementation((async (_c: unknown, method: string) => method === 'GET' ? [row({ ready: false })] : {}) as never)
    f.later(); await f.grids.tick()
    expect(f.request).toHaveBeenCalledOnce()
    // Off and on again within the minute: the Swarm no longer shows the refusal, so grid is asked again.
    f.backend.mockImplementation((async (_c: unknown, method: string) => method === 'GET' ? [row({ ready: undefined })] : {}) as never)
    f.later(); await f.grids.tick()
    expect(f.request).toHaveBeenCalledTimes(2)
    f.backend.mockImplementation((async (_c: unknown, method: string) => method === 'GET' ? [row({ ready: false })] : {}) as never)
    f.later(); await f.grids.tick()
    expect(f.request).toHaveBeenCalledTimes(2)
    f.backend.mockImplementation((async (_c: unknown, method: string) => method === 'GET' ? [row({ ready: false, members: ['c@example.com'] })] : {}) as never)
    f.later(); await f.grids.tick()
    expect(f.request).toHaveBeenCalledTimes(3)
  })
  it('reads a backend before the add-on as having no grids, and lets any other failure through', async () => {
    const f = fixture([])
    f.backend.mockRejectedValueOnce(new SuperTabHostError('NOT_FOUND', 'This Super Tab is unavailable.', 404))
    await f.grids.tick()
    expect(f.open).not.toHaveBeenCalled()
    f.backend.mockRejectedValueOnce(new SuperTabHostError('BACKEND_UNAVAILABLE', 'down'))
    f.later()
    await expect(f.grids.tick()).rejects.toThrow('down')
  })
  it('runs one pass at a time', async () => {
    let release!: () => void
    const f = fixture([row()], () => new Promise(done => { release = () => done({ ready: true }) }))
    const first = f.grids.tick()
    await vi.waitFor(() => expect(f.request).toHaveBeenCalledOnce())
    f.later()
    const second = f.grids.tick()
    expect(second).toBe(first)
    release(); await first
    expect(f.request).toHaveBeenCalledOnce()
  })
})
