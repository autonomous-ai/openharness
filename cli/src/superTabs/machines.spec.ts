import { describe, expect, it, vi } from 'vitest'
import { fakeCore } from '../testing/fakeCore.js'
import { ContributedMachines } from './machines.js'
import { startAgent } from './start.js'

function fixture() {
  let now = 1000
  const core = fakeCore({ dataDir: '/isolated-pool-fixture', agents: {
    byAgent: vi.fn(id => id === 'running' ? { agentId: id } as never : undefined),
    stopped: vi.fn(async id => id === 'stopped'),
  } })
  const pool = { tabId: 'tab', machine: { machineId: 'host', generation: 'grant', cwd: '/repo', engines: ['codex'], paused: false },
    harnessIds: ['running', 'stopped'], starts: [{ id: 'start', dispatched: false }], paused: false }
  const backend = vi.fn(async (_core: unknown, method: string, path: string, _body?: unknown): Promise<unknown> => path.endsWith('/pools') ? [pool] : { revision: 1 })
  const request = vi.fn(async () => ({ providers: [{ provider: 'codex', outcome: 'answered', httpStatus: 200,
    body: { account_email: 'private@example.com', secret: 'private-token', rate_limit: { primary_window: { used_percent: 25, reset_at: 1234567890 } } } }] }))
  const close = vi.fn(), open = vi.fn(async () => ({ machineId: 'host', request, close }))
  const capabilities = vi.fn(async () => ({ ok: true, resources: { cpuPercent: 20, memoryTotalBytes: 1000, memoryUsedBytes: 200, projectDiskFreeBytes: 1000 }, tools: { git: true } }))
  const start = vi.fn(async () => ({ ok: true }))
  const machine = new ContributedMachines(core, 'host', { backend, open, capabilities, start, now: () => now } as never)
  return { machine, pool, core, backend, open, close, capabilities, start, advance: () => { now += 16000 } }
}

describe('contributed machine executor', () => {
  it('publishes only scoped measurements and executes through the owner start endpoint', async () => {
    const f = fixture()
    await f.machine.tick()
    expect(f.open).toHaveBeenCalledOnce()
    expect(f.capabilities).toHaveBeenCalledWith({ cwd: '/repo', tools: ['git'], devices: [] })
    const body = f.backend.mock.calls.find(c => c[1] === 'POST')![3]
    expect(body).toMatchObject({ generation: 'grant', runningHarnessIds: ['running'], stoppedHarnessIds: ['stopped'], quotas: [{ engine: 'codex', known: true }] })
    expect(JSON.stringify(body)).not.toMatch(/private@example|private-token|account_email/)
    const [input, scoped, where] = (f.start.mock.calls as unknown[][])[0]!
    expect(input).toEqual({ tabId: 'tab', startId: 'start', hostDispatch: true })
    expect(where).toMatchObject({ machineId: 'host', dataDir: '/isolated-pool-fixture' })
    await (scoped as (p: unknown) => Promise<unknown>)({ action: 'startStatus' })
    expect(f.backend).toHaveBeenLastCalledWith(f.core, 'GET', '/api/super-tabs/hosts/host/starts/tab/start', undefined)
    expect(f.close).toHaveBeenCalledOnce()
    await f.machine.tick()
    expect(f.open).toHaveBeenCalledOnce()
    f.machine.stop(); f.advance(); await f.machine.tick()
    expect(f.open).toHaveBeenCalledOnce()
  })

  it('does not connect to a daemon without an explicit contribution', async () => {
    const f = fixture()
    f.backend.mockResolvedValue([{ tabId: 'tab', agent: { id: 'existing-agent' } }])
    await f.machine.tick()
    expect(f.open).not.toHaveBeenCalled()
  })

  it('pause blocks new work but still reconciles an already dispatched receipt', async () => {
    const f = fixture(); f.pool.machine.paused = true
    await f.machine.tick()
    expect(f.start).not.toHaveBeenCalled()
    f.pool.starts[0]!.dispatched = true
    f.advance(); await f.machine.tick()
    expect(f.start).toHaveBeenCalledOnce()
  })

  it('a lead queues a contributed start without connecting to that computer', async () => {
    const open = vi.fn()
    const scoped = vi.fn(async () => ({ ok: true, value: { creationId: 'creation', poolGeneration: 'grant', request: { machineId: 'host' } } }))
    const reply = await startAgent({ startId: 'start' }, scoped, { port: 14001, machineId: 'lead', dataDir: '/fixture' }, open)
    expect(reply).toMatchObject({ ok: true, queued: true, startId: 'start', machineId: 'host' })
    expect(open).not.toHaveBeenCalled()
  })
})
