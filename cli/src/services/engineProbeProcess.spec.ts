import { afterEach, describe, expect, it, vi } from 'vitest'
import { ENGINE_PROBE_REQUESTS } from '../core/api.js'
import { runEngineProbeService } from './engineProbeProcess.js'
import { runServiceProcess, type ServiceProcessOptions } from './process.js'

// The real default reaches a real socket: never in a test.
vi.mock('./process.js', () => ({ runServiceProcess: vi.fn(() => ({ stop: vi.fn() })) }))

describe('the engine probe in its own process', () => {
  afterEach(() => vi.clearAllMocks())

  it('answers the probe from this process, with the asker the core named', async () => {
    let options: ServiceProcessOptions | null = null
    runEngineProbeService({
      dataDir: '/data', socketPath: '/data/daemon-1.sock', machineId: 'm', token: 't',
      run: (given) => { options = given; return { stop: vi.fn() } },
      start: (core) => ({ engines_probe: (payload, asker) => ({ dataDir: core.dataDir, engines: payload.engines, guest: asker.guest ?? null }) }),
    })
    expect(options).toMatchObject({ name: 'engineProbe', socketPath: '/data/daemon-1.sock', machineId: 'm', token: 't' })
    expect(await options!.requests.engines_probe!({ engines: ['claude'] }, { local: false, owner: false, guest: 'kim@acme.io' }))
      .toEqual({ dataDir: '/data', engines: ['claude'], guest: 'kim@acme.io' })
  })

  it('runs as a real service by default, answering every request the core routes to it', () => {
    runEngineProbeService({ dataDir: '/data', socketPath: '/data/daemon-1.sock', machineId: 'm', token: 't' })
    const options = vi.mocked(runServiceProcess).mock.calls.at(-1)![0]
    expect(options.name).toBe('engineProbe')
    expect(Object.keys(options.requests)).toEqual([...ENGINE_PROBE_REQUESTS])
  })
})
