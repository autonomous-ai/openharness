import { afterEach, describe, expect, it, vi } from 'vitest'
import { MACHINE_ADDON_REQUESTS } from '../core/api.js'
import { runServiceProcess, type ServiceProcessOptions } from './process.js'
import { runMachineAddonsService } from './machineAddonsProcess.js'

// The real default reaches a real socket: never in a test.
vi.mock('./process.js', () => ({ runServiceProcess: vi.fn(() => ({ stop: vi.fn() })) }))

const LOCAL = { local: true, owner: true }
const PUBLISH = { op: 'publish', input: { values: [{ topic: 'voice/state', value: {} }] } }
const PROPOSE = { op: 'propose', input: { addon: 'a', idempotencyKey: 'k', act: 'say', holdsMs: 5000, note: 'hi' } }

function setup() {
  let wire!: ServiceProcessOptions
  // The real processCoreApi: only the process's socket is swapped, and the core it connects is a query.
  runMachineAddonsService({ dataDir: '/not-a-real-data-dir', socketPath: '/not-a-real-socket', machineId: 'computer-id', token: 't',
    run: (given) => { wire = given; return { stop: vi.fn() } } })
  const query = vi.fn(async (name: string) => name === 'daemon' ? { command: 'harness', port: 14001, machineId: 'm_account' } : {})
  return { wire: () => wire, query }
}

describe('the add-ons of a device that is this machine, in their own process', () => {
  afterEach(() => vi.clearAllMocks())

  it('names the device by the account\'s machine id the core says, never the computer id it is started with', async () => {
    const t = setup()
    expect(t.wire()).toMatchObject({ name: 'machineAddons', machineId: 'computer-id' })
    const ask = t.wire().requests.machine_addon!
    t.wire().onConnected!({ query: t.query } as never)
    await ask(PUBLISH, LOCAL)
    expect(t.query).toHaveBeenCalledWith('daemon', {})
    expect(await ask({ op: 'state' }, LOCAL)).toMatchObject({ result: { devices: [{ deviceId: 'm_account' }] } })
    expect(await ask(PROPOSE, LOCAL)).toMatchObject({ result: { proposal: { deviceId: 'm_account', from: { machineId: 'm_account' } } } })
  })

  it('refuses, never runs as no machine, until the core has said this machine\'s id; a request asks for it', async () => {
    const t = setup()
    const ask = t.wire().requests.machine_addon!
    expect(await ask(PUBLISH, LOCAL)).toMatchObject({ error: { code: 'UNAVAILABLE' } })
    const late = vi.fn(async () => ({}))
    t.wire().onConnected!({ query: late } as never)
    expect(await ask({ op: 'state' }, LOCAL)).toMatchObject({ error: { code: 'UNAVAILABLE' } })
    t.wire().onConnected!({ query: t.query } as never)
    expect(await ask(PUBLISH, LOCAL)).toMatchObject({ result: { topics: 1 } })
  })

  it('runs as a real service by default, answering every request the core routes to it', () => {
    runMachineAddonsService({ dataDir: '/data', socketPath: '/data/daemon-1.sock', machineId: 'm', token: 't' })
    const options = vi.mocked(runServiceProcess).mock.calls.at(-1)![0]
    expect(options.name).toBe('machineAddons')
    expect(Object.keys(options.requests)).toEqual([...MACHINE_ADDON_REQUESTS])
  })
})
