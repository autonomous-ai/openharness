import { describe, expect, it, vi } from 'vitest'
import { runServiceProcess, type CoreConnection, type ServiceProcessOptions } from './process.js'
import type { startHomeBridge } from './homeBridge.js'
import { runHomeBridgeService } from './homeBridgeProcess.js'

// The real default reaches a real socket: never in a test.
vi.mock('./process.js', () => ({ runServiceProcess: vi.fn(() => ({ stop: vi.fn() })) }))

describe('the home bridge in its own process', () => {
  it('starts the service with the process\'s data folder and socket, serves the old paths at each connection, and stops with its process', () => {
    let options: ServiceProcessOptions | null = null
    const stopProcess = vi.fn()
    const stopBridge = vi.fn()
    const connected = vi.fn()
    let given: Parameters<typeof startHomeBridge> | null = null
    const service = runHomeBridgeService({ dataDir: '/data', socketPath: '/data/daemon-18473.sock', machineId: 'm', token: 't',
      run: (o) => { options = o; return { stop: stopProcess } },
      start: (...args) => { given = args; return { stop: stopBridge, connected } } })
    expect(options!).toMatchObject({ name: 'homeBridge', socketPath: '/data/daemon-18473.sock', machineId: 'm', token: 't', requests: {} })
    const [core, deps] = given!
    expect(core.dataDir).toBe('/data')
    expect(deps).toEqual({ socket: '/data/daemon-18473.sock' })
    // A core that started again made its socket again: each connection serves the old paths once more.
    const link = { query: vi.fn() } satisfies CoreConnection
    options!.onConnected!(link)
    options!.onConnected!(link)
    expect(connected).toHaveBeenCalledTimes(2)
    service.stop()
    expect(stopBridge).toHaveBeenCalledOnce()
    expect(stopProcess).toHaveBeenCalledOnce()
  })

  it('runs as a real service by default', () => {
    const service = runHomeBridgeService({ dataDir: '/nowhere-home-bridge', socketPath: '/nowhere-home-bridge/daemon.sock', machineId: 'm', token: 't' })
    expect(vi.mocked(runServiceProcess).mock.calls.at(-1)![0].name).toBe('homeBridge')
    service.stop()
  })
})
