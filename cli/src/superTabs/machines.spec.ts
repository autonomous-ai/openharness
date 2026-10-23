import { describe, expect, it, vi } from 'vitest'
import { fakeCore } from '../testing/fakeCore.js'
import { ContributedMachines } from './machines.js'
import { SuperTabHostError } from './host.js'
import { startAgent } from './start.js'

function fixture(env: NodeJS.ProcessEnv = {}) {
  let now = 1000
  const core = fakeCore({ dataDir: '/isolated-pool-fixture', agents: {
    byAgent: vi.fn(id => id === 'running' ? { agentId: id } as never : undefined),
    stopped: vi.fn(async id => id === 'stopped'),
  } })
  const pool = { tabId: 'tab', machine: { machineId: 'host', generation: 'grant', cwd: '/repo', engines: ['codex'], paused: false },
    harnessIds: ['running', 'stopped'], starts: [{ id: 'start', dispatched: false }], paused: false }
  const backend = vi.fn(async (_core: unknown, method: string, path: string, _body?: unknown): Promise<unknown> => path.endsWith('/pools') ? [pool] : { revision: 1 })
  const request = vi.fn(async (_type: string): Promise<Record<string, unknown>> => ({ providers: [{ provider: 'codex', outcome: 'answered', httpStatus: 200,
    body: { account_email: 'private@example.com', secret: 'private-token', rate_limit: { primary_window: { used_percent: 25, reset_at: 1234567890 } } } }] }))
  const close = vi.fn(), open = vi.fn(async () => ({ machineId: 'host', request, close }))
  const capabilities = vi.fn(async (_input: { cwd: string; tools: string[]; devices: string[] }) => ({ ok: true, resources: { cpuPercent: 20, memoryTotalBytes: 1000, memoryUsedBytes: 200, projectDiskFreeBytes: 1000 }, tools: { git: true } }))
  const start = vi.fn(async () => ({ ok: true }))
  const prepare = vi.fn(async () => {})
  const log = vi.fn()
  const machine = new ContributedMachines(core, 'host', { backend, open, capabilities, start, prepare, log, env, now: () => now } as never)
  return { machine, pool, core, backend, open, request, close, capabilities, start, prepare, log, advance: () => { now += 16000 }, step: (ms: number) => { now += ms } }
}

describe('contributed machine executor', () => {
  it('reports only installed supported engines for a legacy OpenCode contribution', async () => {
    const f = fixture()
    f.pool.machine.engines = ['opencode']
    const usage = f.request.getMockImplementation()!
    f.request.mockImplementation(async type => type === 'engines_probe'
      ? { engines: [{ engine: 'claude', installed: true, signedIn: false }, { engine: 'codex', installed: false }] }
      : usage(type))
    await f.machine.tick()
    const body = f.backend.mock.calls.find(c => c[1] === 'POST')![3]
    expect(body).toMatchObject({ quotas: [{ engine: 'claude' }] })
    expect(f.request).toHaveBeenCalledWith('engines_probe', { engines: ['claude', 'codex'] }, 20_000)
  })
  const signedOut = { providers: [{ provider: 'codex', account: null, outcome: 'signedOut' }] }
  it('reports an engine run on an API key as metered: known, with no windows', async () => {
    const f = fixture({ OPENAI_API_KEY: 'sk-or-private' })
    f.request.mockImplementation(async () => signedOut)
    await f.machine.tick()
    const body = f.backend.mock.calls.find(c => c[1] === 'POST')![3]
    expect(body).toMatchObject({ quotas: [{ engine: 'codex', known: true, windows: [] }] })
    expect(JSON.stringify(body)).not.toContain('sk-or-private')
  })
  it('keeps an unreadable subscription unknown, and a readable one by its windows even beside an API key', async () => {
    const unknown = fixture()
    unknown.request.mockImplementation(async () => signedOut)
    await unknown.machine.tick()
    expect(unknown.backend.mock.calls.find(c => c[1] === 'POST')![3]).toMatchObject({ quotas: [{ engine: 'codex', known: false, windows: [] }] })
    const read = fixture({ OPENAI_API_KEY: 'sk-or-private' })
    await read.machine.tick()
    const quota = (read.backend.mock.calls.find(c => c[1] === 'POST')![3] as { quotas: Array<{ windows: unknown[] }> }).quotas[0]!
    expect(quota.windows).toHaveLength(1)
  })
  it('prepares a swarm project before dispatch and durably rejects an unsafe checkout', async () => {
    const f = fixture()
    Object.assign(f.pool.machine, { scope: 'swarm' })
    await f.machine.tick()
    expect(f.prepare).toHaveBeenCalledWith(f.core, f.pool, f.pool.starts[0])
    expect(f.prepare.mock.invocationCallOrder[0]).toBeLessThan(f.start.mock.invocationCallOrder[0]!)
    f.prepare.mockRejectedValueOnce(new Error('Project checkout unavailable'))
    f.advance()
    await f.machine.tick()
    expect(f.start).toHaveBeenCalledTimes(1)
    expect(f.backend.mock.calls.some(c => JSON.stringify(c[3] ?? {}).includes('Project checkout unavailable'))).toBe(true)
    f.pool.starts[0]!.dispatched = true
    f.advance()
    await f.machine.tick()
    expect(f.prepare).toHaveBeenCalledTimes(2)
    expect(f.start).toHaveBeenCalledTimes(2)
  })
  it('publishes only scoped measurements and executes through the owner start endpoint', async () => {
    const f = fixture()
    await f.machine.tick()
    expect(f.open).toHaveBeenCalledOnce()
    expect(f.capabilities).toHaveBeenCalledWith({ cwd: '/repo', tools: ['git', 'node', 'npm', 'flutter', 'gh', 'cargo', 'python3'], devices: [] })
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
  it('probes common tools plus pending-start requirements and publishes failures without calling them missing', async () => {
    const f = fixture()
    Object.assign(f.pool.starts[0]!, { request: { requirements: { tools: ['docker'] } } })
    f.capabilities.mockResolvedValueOnce({ ok: true, resources: { cpuPercent: 20, memoryTotalBytes: 1000, memoryUsedBytes: 200, projectDiskFreeBytes: 1000 },
      tools: { git: true, node: true, docker: false }, toolProbeErrors: { flutter: 'interactive shell timed out' } } as never)
    await f.machine.tick()
    expect(f.capabilities).toHaveBeenCalledWith({ cwd: '/repo',
      tools: ['git', 'node', 'npm', 'flutter', 'gh', 'cargo', 'python3', 'docker'], devices: [] })
    const body = f.backend.mock.calls.find(c => c[1] === 'POST')![3]
    expect(body).toMatchObject({ tools: { git: true, node: true, docker: false }, toolProbeErrors: { flutter: 'interactive shell timed out' } })
  })
  it('reuses tool readings across tabs and heartbeat passes without another shell probe', async () => {
    const f = fixture()
    const original = f.backend.getMockImplementation()!
    f.backend.mockImplementation(async (core, method, path, body) => path.endsWith('/pools')
      ? [f.pool, { ...f.pool, tabId: 'second-tab' }]
      : original(core, method, path, body))
    await f.machine.tick()
    expect(f.capabilities.mock.calls.map(([input]) => input.tools)).toEqual([
      ['git', 'node', 'npm', 'flutter', 'gh', 'cargo', 'python3'], []])
    const observations = f.backend.mock.calls.filter(c => c[1] === 'POST' && String(c[2]).includes('/machines/'))
    expect(observations[1]?.[3]).toMatchObject({ tools: { git: true }, toolProbeErrors: { node: 'The tool probe did not complete.' } })
    f.advance()
    await f.machine.tick()
    expect(f.capabilities.mock.calls.slice(2).map(([input]) => input.tools)).toEqual([[], []])
  })
  it('probes a newly queued tool immediately and retries an unverified tool after its short cache window', async () => {
    const f = fixture()
    f.capabilities.mockResolvedValueOnce({ ok: true, resources: { cpuPercent: 20, memoryTotalBytes: 1000, memoryUsedBytes: 200, projectDiskFreeBytes: 1000 },
      tools: { git: true, node: true, npm: true, gh: true, cargo: true, python3: true },
      toolProbeErrors: { flutter: 'interactive shell timed out' } } as never)
    await f.machine.tick()
    Object.assign(f.pool.starts[0]!, { request: { requirements: { tools: ['docker'] } } })
    f.capabilities.mockResolvedValueOnce({ ok: true, resources: { cpuPercent: 20, memoryTotalBytes: 1000, memoryUsedBytes: 200, projectDiskFreeBytes: 1000 },
      tools: { docker: true } } as never)
    f.advance()
    await f.machine.tick()
    expect(f.capabilities.mock.lastCall?.[0]).toMatchObject({ tools: ['docker'] })
    f.step(61_000)
    await f.machine.tick()
    expect(f.capabilities.mock.lastCall?.[0]).toMatchObject({ tools: ['flutter'] })
  })
  it('retries a probe-failure observation without its new field for an older backend', async () => {
    const f = fixture()
    f.capabilities.mockResolvedValueOnce({ ok: true, resources: { cpuPercent: 20, memoryTotalBytes: 1000, memoryUsedBytes: 200, projectDiskFreeBytes: 1000 },
      tools: { git: true }, toolProbeErrors: { flutter: 'interactive shell timed out' } } as never)
    const original = f.backend.getMockImplementation()!
    f.backend.mockImplementation(async (core, method, path, body) => {
      if (method === 'POST' && (body as Record<string, unknown>)?.toolProbeErrors) throw new SuperTabHostError('VALIDATION_ERROR', 'Unrecognized key: toolProbeErrors', 400)
      return original(core, method, path, body)
    })
    await f.machine.tick()
    const posts = f.backend.mock.calls.filter(c => c[1] === 'POST')
    expect(posts).toHaveLength(2)
    expect(posts[0]![3]).toHaveProperty('toolProbeErrors')
    expect(posts[1]![3]).not.toHaveProperty('toolProbeErrors')
  })

  it('binds stopped native proof to the current slot reservation generation', async () => {
    const f = fixture()
    Object.assign(f.pool, { reservations: [{ harnessId: 'stopped', generation: 'new-contribution' }] })
    await f.machine.tick()
    const body = f.backend.mock.calls.find(c => c[1] === 'POST')![3]
    expect(body).toMatchObject({ stoppedReservations: [{ harnessId: 'stopped', generation: 'new-contribution' }] })
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

  // DESKTOP-0TFH0OJ, 2026-10-23: CLI 0.4.57 refused every Claude start there as not signed in (Claude ran on an API key
  // set in its settings), and the pass dropped the refusal: two starts stayed "Queued" for hours with nothing in the log.
  it('logs why a waiting start was not started, once per reason', async () => {
    const f = fixture()
    f.start.mockResolvedValue({ error: 'CAPACITY_UNAVAILABLE', startId: 'start', reasons: ['The selected agent engine is not signed in on this machine.'] } as never)
    await f.machine.tick()
    f.advance(); await f.machine.tick()
    expect(f.start).toHaveBeenCalledTimes(2)
    expect(f.log.mock.calls).toEqual([['Swarm start start is waiting: The selected agent engine is not signed in on this machine.']])
    f.start.mockRejectedValue(new Error('Could not reach the Harness backend.'))
    f.advance(); await f.machine.tick()
    f.start.mockResolvedValue({ ok: true, harnessId: 'harness' } as never)
    f.advance(); await f.machine.tick()
    f.start.mockResolvedValue({ error: 'START_PENDING', startId: 'start', detail: 'Waiting for the launched engine.' } as never)
    f.advance(); await f.machine.tick()
    expect(f.log.mock.calls.slice(1)).toEqual([['Swarm start start is waiting: Could not reach the Harness backend.'],
      ['Swarm start start is waiting: Waiting for the launched engine.']])
  })

  it('a lead queues a contributed start without connecting to that computer', async () => {
    const open = vi.fn()
    const scoped = vi.fn(async () => ({ ok: true, value: { creationId: 'creation', poolGeneration: 'grant', request: { machineId: 'host', engine: 'claude' } } }))
    const reply = await startAgent({ startId: 'start' }, scoped, { port: 14001, machineId: 'lead', dataDir: '/fixture' }, open)
    expect(reply).toMatchObject({ ok: true, queued: true, startId: 'start', machineId: 'host' })
    expect(open).not.toHaveBeenCalled()
  })

  describe('how soon a change is seen', () => {
    const posts = (f: ReturnType<typeof fixture>) => f.backend.mock.calls.filter(c => c[1] === 'POST' && String(c[2]).includes('/machines/'))
    const reads = (f: ReturnType<typeof fixture>) => f.backend.mock.calls.filter(c => c[1] === 'GET' && String(c[2]).endsWith('/pools'))
    const lastBody = (f: ReturnType<typeof fixture>) => posts(f).at(-1)![3] as { runningHarnessIds: string[]; stoppedHarnessIds: string[] }
    /** The next host tick, `ms` later. */
    const after = async (f: ReturnType<typeof fixture>, ms: number) => { f.step(ms); await f.machine.tick() }
    const quiet = (f: ReturnType<typeof fixture>) => { f.pool.starts.length = 0 }

    it('publishes at once when a harness starts or stops running', async () => {
      const f = fixture(); quiet(f)
      await f.machine.tick()
      expect(posts(f)).toHaveLength(1)
      expect(lastBody(f)).toMatchObject({ runningHarnessIds: ['running'], stoppedHarnessIds: ['stopped'] })

      // A harness comes up on this machine: the next look says so, long before a beat has passed.
      f.pool.harnessIds.push('newcomer')
      vi.mocked(f.core.agents.byAgent).mockImplementation(id => ['running', 'newcomer'].includes(id) ? { agentId: id } as never : undefined)
      await after(f, 5_000)
      expect(posts(f)).toHaveLength(2)
      expect(lastBody(f).runningHarnessIds).toEqual(['running', 'newcomer'])

      // And one stops.
      vi.mocked(f.core.agents.stopped!).mockImplementation(async id => id === 'stopped' || id === 'running')
      await after(f, 5_000)
      expect(posts(f)).toHaveLength(3)
      expect(lastBody(f)).toMatchObject({ runningHarnessIds: ['newcomer'], stoppedHarnessIds: ['running', 'stopped'] })
    })

    it('publishes at once when new work is paused or allowed again', async () => {
      const f = fixture(); quiet(f)
      await f.machine.tick()
      // Paused on the machine's own grant, then allowed; paused for the whole tab, then allowed.
      for (const change of [() => { f.pool.machine.paused = true }, () => { f.pool.machine.paused = false },
        () => { f.pool.paused = true }, () => { f.pool.paused = false }]) {
        const before = posts(f).length
        change()
        await after(f, 5_000)
        expect(posts(f)).toHaveLength(before + 1)
      }
    })

    it('publishes at once when a start is waiting, and picks it up in the same look', async () => {
      const f = fixture(); quiet(f)
      await f.machine.tick()
      expect(f.start).not.toHaveBeenCalled()
      f.pool.starts.push({ id: 'second', dispatched: false })
      await after(f, 5_000)
      expect(posts(f)).toHaveLength(2)
      expect(f.start).toHaveBeenCalledOnce()
      expect((f.start.mock.calls as unknown[][])[0]![0]).toEqual({ tabId: 'tab', startId: 'second', hostDispatch: true })
      // Settled: that too is a change, and is sent.
      f.pool.starts.length = 0
      await after(f, 5_000)
      expect(posts(f)).toHaveLength(3)
    })

    it('picks a waiting start up within five seconds, not fifteen', async () => {
      const f = fixture(); quiet(f)
      await f.machine.tick()
      f.pool.starts.push({ id: 'late', dispatched: false })
      await after(f, 4_000)
      expect(f.start).not.toHaveBeenCalled()
      await after(f, 1_000)
      expect(f.start).toHaveBeenCalledOnce()
    })

    it('keeps the fifteen second heartbeat when nothing changes, and reads the machine only to send it', async () => {
      const f = fixture(); quiet(f)
      await f.machine.tick()
      for (const ms of [5_000, 5_000]) await after(f, ms)
      expect(reads(f)).toHaveLength(3)
      expect(posts(f)).toHaveLength(1)
      expect(f.capabilities).toHaveBeenCalledOnce()
      expect(f.open).toHaveBeenCalledOnce()
      await after(f, 5_000)
      expect(posts(f)).toHaveLength(2)
      expect(f.capabilities).toHaveBeenCalledTimes(2)
      // The beat counts from the last send.
      await after(f, 10_000)
      expect(posts(f)).toHaveLength(2)
      await after(f, 5_000)
      expect(posts(f)).toHaveLength(3)
    })

    it('looks no more often than every five seconds', async () => {
      const f = fixture(); quiet(f)
      await f.machine.tick()
      for (const ms of [1_000, 1_000, 1_000, 1_000]) await after(f, ms)
      expect(reads(f)).toHaveLength(1)
      await after(f, 1_000)
      expect(reads(f)).toHaveLength(2)
    })

    it('never has more than one look in flight', async () => {
      const f = fixture(); quiet(f)
      let release!: (rows: unknown) => void
      f.backend.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
      const first = f.machine.tick()
      // The host ticks every second whatever is in flight; none of those starts another look.
      for (const ms of [1_000, 5_000, 10_000, 20_000]) { f.step(ms); void f.machine.tick() }
      await Promise.resolve()
      expect(reads(f)).toHaveLength(1)
      release([f.pool])
      await first
      expect(reads(f)).toHaveLength(1)
      expect(posts(f)).toHaveLength(1)
      await after(f, 5_000)
      expect(reads(f)).toHaveLength(2)
    })

    it('waits a whole beat after a look that failed, and after a send that failed', async () => {
      const f = fixture(); quiet(f)
      f.backend.mockRejectedValueOnce(new Error('backend unreachable'))
      await expect(f.machine.tick()).rejects.toThrow('backend unreachable')
      await after(f, 5_000); await after(f, 5_000)
      expect(reads(f)).toHaveLength(1)
      await after(f, 5_000)
      expect(reads(f)).toHaveLength(2)

      f.backend.mockImplementation(async (_core, method, path) => path.endsWith('/pools') ? [f.pool] : method === 'POST' ? Promise.reject(new Error('refused')) : { revision: 1 })
      await after(f, 15_000)
      expect(posts(f)).toHaveLength(2)
      await after(f, 5_000); await after(f, 5_000)
      expect(posts(f)).toHaveLength(2)
      await after(f, 5_000)
      expect(posts(f)).toHaveLength(3)
    })

    it('does not reach the daemon in a look with nothing to send', async () => {
      const f = fixture(); quiet(f)
      await f.machine.tick()
      f.open.mockClear(); f.close.mockClear()
      await after(f, 5_000)
      expect(f.open).not.toHaveBeenCalled()
      expect(f.close).not.toHaveBeenCalled()
    })

    it('sends again once a contribution comes back after it was withdrawn', async () => {
      const f = fixture(); quiet(f)
      await f.machine.tick()
      const pools = f.backend.getMockImplementation()!
      f.backend.mockImplementation(async (core, method, path, body) => path.endsWith('/pools') ? [] : pools(core, method, path, body))
      await after(f, 5_000)
      f.backend.mockImplementation(pools)
      await after(f, 5_000)
      expect(posts(f)).toHaveLength(2)
    })
  })
})
