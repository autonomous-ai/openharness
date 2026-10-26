import { afterEach, describe, expect, it, vi } from 'vitest'
import { MACHINE_ADDON_REQUESTS } from '../core/api.js'
import type { processCoreApi } from './processCoreApi.js'
import { runServiceProcess, type ServiceProcessOptions } from './process.js'
import { runMachineAddonsService } from './machineAddonsProcess.js'

// The real default reaches a real socket: never in a test.
vi.mock('./process.js', () => ({ runServiceProcess: vi.fn(() => ({ stop: vi.fn() })) }))

const LOCAL = { local: true, owner: true }

describe('the add-ons of a device that is this machine, in their own process', () => {
  afterEach(() => vi.clearAllMocks())

  it('names the device by the account\'s machine id, as the core says it, never the computer id it is started with', async () => {
    let options: ServiceProcessOptions | null = null
    const core = (() => ({ daemon: { command: 'harness', port: 1, autonomousEnv: 'prod', machineId: () => 'm_account' } })) as unknown as typeof processCoreApi
    runMachineAddonsService({ dataDir: '/data', socketPath: '/data/daemon-1.sock', machineId: 'computer-id', token: 't', core,
      run: (given) => { options = given; return { stop: vi.fn() } } })
    expect(options).toMatchObject({ name: 'machineAddons', machineId: 'computer-id' })
    const ask = options!.requests.machine_addon!
    await ask({ op: 'publish', input: { values: [{ topic: 'voice/state', value: {} }] } }, LOCAL)
    expect(await ask({ op: 'state' }, LOCAL)).toMatchObject({ result: { devices: [{ deviceId: 'm_account' }] } })
    expect(await ask({ op: 'propose', input: { addon: 'a', idempotencyKey: 'k', act: 'say', holdsMs: 5000, note: 'hi' } }, LOCAL))
      .toMatchObject({ result: { proposal: { deviceId: 'm_account', from: { machineId: 'm_account' } } } })
  })

  it('runs as a real service by default, answering every request the core routes to it', () => {
    runMachineAddonsService({ dataDir: '/data', socketPath: '/data/daemon-1.sock', machineId: 'm', token: 't' })
    const options = vi.mocked(runServiceProcess).mock.calls.at(-1)![0]
    expect(options.name).toBe('machineAddons')
    expect(Object.keys(options.requests)).toEqual([...MACHINE_ADDON_REQUESTS])
  })
})
