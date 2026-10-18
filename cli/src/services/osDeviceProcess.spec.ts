import { afterEach, describe, expect, it, vi } from 'vitest'
import { OS_DEVICE_REQUESTS } from '../core/api.js'
import { runServiceProcess, type ServiceProcessOptions } from './process.js'
import { runOsDeviceService } from './osDeviceProcess.js'

// The real default reaches a real socket: never in a test.
vi.mock('./process.js', () => ({ runServiceProcess: vi.fn(() => ({ stop: vi.fn() })) }))

describe('the Harness OS computer\'s management in its own process', () => {
  afterEach(() => vi.clearAllMocks())

  it('answers with the same handler as in the core\'s process', async () => {
    let options: ServiceProcessOptions | null = null
    const service = { stop: vi.fn() }
    const handle = runOsDeviceService({
      dataDir: '/data', socketPath: '/data/daemon-1.sock', machineId: 'm', token: 't',
      run: (given) => { options = given; return service },
      start: () => ({ os_device: async () => ({ harnessOs: false }) }),
    })
    expect(handle).toBe(service)
    expect(options).toMatchObject({ name: 'osDevice', socketPath: '/data/daemon-1.sock', machineId: 'm', token: 't' })
    expect(await options!.requests.os_device!({ action: 'status' }, { local: true, owner: true })).toEqual({ harnessOs: false })
  })

  it('runs as a real service by default, answering every request the core routes to it', () => {
    runOsDeviceService({ dataDir: '/data', socketPath: '/data/daemon-1.sock', machineId: 'm', token: 't' })
    const options = vi.mocked(runServiceProcess).mock.calls.at(-1)![0]
    expect(options.name).toBe('osDevice')
    expect(Object.keys(options.requests)).toEqual([...OS_DEVICE_REQUESTS])
  })
})
