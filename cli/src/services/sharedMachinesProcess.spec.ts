import { afterEach, describe, expect, it, vi } from 'vitest'
import { runServiceProcess, type ServiceProcessOptions } from './process.js'
import { runSharedMachinesService } from './sharedMachinesProcess.js'
import type { SharedMachinesDeps } from './sharedMachines.js'
import type { CoreApi } from '../core/api.js'

// The real default reaches a real socket: never in a test.
vi.mock('./process.js', () => ({ runServiceProcess: vi.fn(() => ({ stop: vi.fn() })) }))

describe('shared machines in their own process', () => {
  afterEach(() => vi.clearAllMocks())

  it('answers shared_machines with the same handler as in the core\'s process', async () => {
    let options: ServiceProcessOptions | null = null
    runSharedMachinesService({
      dataDir: '/data', socketPath: '/data/daemon-1.sock', machineId: 'm', token: 't',
      run: (given) => { options = given; return { stop: vi.fn() } },
      start: () => ({ shared_machines: async () => ({ emails: [] }) }),
    })
    expect(options).toMatchObject({ name: 'sharedMachines', socketPath: '/data/daemon-1.sock', machineId: 'm', token: 't' })
    expect(await options!.requests.shared_machines!({ action: 'get' }, { local: true, owner: true })).toEqual({ emails: [] })
  })

  it('asks the core for the sharing and the trust stores, and hears the notices that change them', async () => {
    let options: ServiceProcessOptions | null = null
    let given: { api: CoreApi, overrides: Partial<SharedMachinesDeps> } | null = null
    runSharedMachinesService({
      dataDir: '/data', socketPath: '/data/daemon-1.sock', machineId: 'm', token: 't',
      run: (o) => { options = o; return { stop: vi.fn() } },
      start: (api, overrides = {}) => { given = { api, overrides }; return { shared_machines: async () => ({}) } },
    })
    const port = given!.overrides.port!
    // No core yet: it reads as unreachable.
    expect(await port.shared()).toMatchObject({ failed: { code: expect.stringContaining('not connected') } })
    const query = vi.fn(async (_query: string, payload: Record<string, unknown>) =>
      payload.op === 'shared' ? { status: 200, body: { success: true, data: { machines: [] } } } : {})
    options!.onConnected!({ query } as never)
    expect(await port.shared()).toEqual([])
    expect(query).toHaveBeenCalledWith('shared_machines', { op: 'shared' })

    const heard = vi.fn()
    const stop = given!.api.account.onNotice(heard)
    await options!.onEvent!({ kind: 'notice', notice: { type: 'machines_changed', reason: 'updated' } })
    await options!.onEvent!({ kind: 'notice' })
    await options!.onEvent!({ kind: 'something_else', notice: { type: 'desk_changed', revision: 1 } })
    expect(heard).toHaveBeenCalledTimes(1)
    expect(heard).toHaveBeenCalledWith({ type: 'machines_changed', reason: 'updated' })
    stop()
    await options!.onEvent!({ kind: 'notice', notice: { type: 'machines_changed', reason: 'updated' } })
    expect(heard).toHaveBeenCalledTimes(1)

    options!.onDisconnected!()
    expect(await port.shared()).toMatchObject({ failed: expect.any(Object) })
  })

  it('runs as a real service by default', () => {
    const stopTimers = vi.useFakeTimers()
    runSharedMachinesService({ dataDir: '/nonexistent', socketPath: '/data/daemon-1.sock', machineId: 'm', token: 't' })
    expect(runServiceProcess).toHaveBeenCalledWith(expect.objectContaining({ name: 'sharedMachines' }))
    const requests = vi.mocked(runServiceProcess).mock.calls[0][0].requests
    expect(Object.keys(requests)).toEqual(['shared_machines'])
    stopTimers.useRealTimers()
  })
})
