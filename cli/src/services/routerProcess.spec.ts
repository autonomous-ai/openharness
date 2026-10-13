import { afterEach, describe, expect, it, vi } from 'vitest'
import { runServiceProcess, type ServiceProcessOptions } from './process.js'
import { runRouterService } from './routerProcess.js'
import type { CoreApi } from '../core/api.js'

// The real default reaches a real socket: never in a test. The real router it starts by default builds Jev's
// client, and asks it nothing until a request comes.
vi.mock('./process.js', () => ({ runServiceProcess: vi.fn(() => ({ stop: vi.fn() })) }))

describe('the router in its own process', () => {
  afterEach(() => vi.clearAllMocks())

  it('answers with the same handlers as in the core\'s process', async () => {
    let options: ServiceProcessOptions | null = null
    const service = { stop: vi.fn() }
    const start = vi.fn(() => ({ route_decide: async () => ({ decided: 'session', id: 'a1', via: 'jev' }) }))
    const handle = runRouterService({
      dataDir: '/data', socketPath: '/data/daemon-1.sock', machineId: 'm', token: 't',
      run: (given) => { options = given; return service },
      start,
    })
    expect(handle).toBe(service)
    expect(options).toMatchObject({ name: 'router', socketPath: '/data/daemon-1.sock', machineId: 'm', token: 't' })
    // Its core is the process's own view of the core, in the data folder it was given.
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ dataDir: '/data' }))
    expect(await options!.requests.route_decide!({ text: 'go' }, { local: true, owner: true })).toEqual({ decided: 'session', id: 'a1', via: 'jev' })
  })

  it("asks the core to sign Harness's backend calls, while it is connected", async () => {
    let options: ServiceProcessOptions | null = null
    let core: CoreApi | null = null
    runRouterService({
      dataDir: '/data', socketPath: '/data/daemon-1.sock', machineId: 'm', token: 't',
      run: (given) => { options = given; return { stop: vi.fn() } },
      start: (given) => { core = given; return {} },
    })
    // Not connected yet: an answer, never a throw.
    expect(await core!.account.backend('POST', '/api/route/jev', { state: {} })).toEqual({ status: 503, body: { error: 'SERVICE_UNAVAILABLE' } })
    const query = vi.fn(async () => ({ status: 200, body: { success: true } }))
    options!.onConnected!({ query } as never)
    expect(await core!.account.backend('POST', '/api/route/jev', { state: {} })).toEqual({ status: 200, body: { success: true } })
    expect(query).toHaveBeenCalledWith('backend', { method: 'POST', path: '/api/route/jev', body: { state: {} } })
    options!.onDisconnected!()
    expect((await core!.account.backend('POST', '/api/route/jev')).status).toBe(503)
  })

  it('runs as a real service by default', () => {
    runRouterService({ dataDir: '/data', socketPath: '/data/daemon-1.sock', machineId: 'm', token: 't' })
    expect(runServiceProcess).toHaveBeenCalledWith(expect.objectContaining({
      name: 'router', requests: { route_decide: expect.any(Function) },
    }))
  })
})
