import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CoreApi } from '../core/api.js'
import { runServiceProcess, type ServiceProcessOptions } from './process.js'
import { runUsageService } from './usageProcess.js'

// The real default reaches a real socket: never in a test.
vi.mock('./process.js', () => ({ runServiceProcess: vi.fn(() => ({ stop: vi.fn() })) }))

describe('account usage in its own process', () => {
  afterEach(() => vi.clearAllMocks())

  it('answers usage_read with the same handler as in the core\'s process, holding no credential', async () => {
    let options: ServiceProcessOptions | null = null
    let api: CoreApi | null = null
    const service = { stop: vi.fn() }
    const handle = runUsageService({
      dataDir: '/data', socketPath: '/data/daemon-1.sock', machineId: 'm', token: 't',
      run: (given) => { options = given; return service },
      start: (core) => { api = core; return { usage_read: async () => ({ providers: [] }) } },
    })
    handle.stop()
    expect(service.stop).toHaveBeenCalledOnce()
    expect(options).toMatchObject({ name: 'usage', socketPath: '/data/daemon-1.sock', machineId: 'm', token: 't' })
    expect(await options!.requests.usage_read!({}, { local: true, owner: true })).toEqual({ providers: [] })
    expect(await options!.requests.agentUsage!({}, { local: true, owner: true })).toEqual({ error: 'INVALID_USAGE_TARGET' })
    await expect(api!.account.accessToken()).rejects.toThrow('usage holds no credential')
  })

  it('runs as a real service by default', () => {
    runUsageService({ dataDir: '/data', socketPath: '/data/daemon-1.sock', machineId: 'm', token: 't' })
    expect(runServiceProcess).toHaveBeenCalledWith(expect.objectContaining({ name: 'usage', requests: { usage_read: expect.any(Function), agentUsage: expect.any(Function) } }))
  })
})
