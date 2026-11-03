import { afterEach, describe, expect, it, vi } from 'vitest'
import { MACHINE_ADDON_REQUESTS } from '../core/api.js'
import { runServiceProcess, type ServiceProcessOptions } from './process.js'
import { runMachineAddonsService } from './machineAddonsProcess.js'
import { answerExperimentQuery, answerMachineAddonsQuery } from '../core/experimentQueries.js'
import { fakeCore } from '../testing/fakeCore.js'

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
  // The core's own answers, in core/main.ts's order: the machine add-ons' door before the experiments' check.
  const core = fakeCore({ daemon: { machineId: () => 'm_account' } as never })
  const query = vi.fn(async (name: string, payload: Record<string, unknown> = {}) =>
    answerMachineAddonsQuery(core, 'machineAddons', name) ?? await answerExperimentQuery(core, new Set(['orchestrator']), 'machineAddons', name, payload) ?? {})
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

  it('keeps no machine id from a core that went before it answered, and asks the next core again', async () => {
    const t = setup()
    const ask = t.wire().requests.machine_addon!
    let answer!: (address: unknown) => void
    const gone = vi.fn(() => new Promise((resolve) => { answer = resolve }))
    t.wire().onConnected!({ query: gone } as never)
    t.wire().onDisconnected!()
    // The core that went answers late, with an address that would otherwise be taken.
    answer({ command: 'harness', port: 1, machineId: 'm_stale' })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(await ask(PUBLISH, LOCAL)).toMatchObject({ error: { code: 'UNAVAILABLE' } })
    // A core whose answer fails leaves the id unknown, never a stuck read: a request
    // in flight shares the read, and the next asks again.
    const failing = vi.fn(async () => { throw new Error('query failed') })
    t.wire().onConnected!({ query: failing } as never)
    expect(await ask(PUBLISH, LOCAL)).toMatchObject({ error: { code: 'UNAVAILABLE' } })
    expect(failing).toHaveBeenCalledTimes(1)
    expect(await ask(PUBLISH, LOCAL)).toMatchObject({ error: { code: 'UNAVAILABLE' } })
    expect(failing).toHaveBeenCalledTimes(2)
    t.wire().onConnected!({ query: t.query } as never)
    expect(await ask(PUBLISH, LOCAL)).toMatchObject({ result: { topics: 1 } })
    expect(await ask({ op: 'state' }, LOCAL)).toMatchObject({ result: { devices: [{ deviceId: 'm_account' }] } })
  })

  it('runs as a real service by default, answering every request the core routes to it', () => {
    runMachineAddonsService({ dataDir: '/data', socketPath: '/data/daemon-1.sock', machineId: 'm', token: 't' })
    const options = vi.mocked(runServiceProcess).mock.calls.at(-1)![0]
    expect(options.name).toBe('machineAddons')
    expect(Object.keys(options.requests)).toEqual([...MACHINE_ADDON_REQUESTS])
  })
})
