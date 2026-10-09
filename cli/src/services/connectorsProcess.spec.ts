import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runServiceProcess, type ServiceProcessOptions } from './process.js'
import { runConnectorsService } from './connectorsProcess.js'

// The real default reaches a real socket: never in a test.
vi.mock('./process.js', () => ({ runServiceProcess: vi.fn(() => ({ stop: vi.fn() })) }))

describe('connected services in their own process', () => {
  afterEach(() => vi.clearAllMocks())

  it('answers connectors with the same handler as in the core\'s process', async () => {
    let options: ServiceProcessOptions | null = null
    runConnectorsService({
      dataDir: '/data', socketPath: '/data/daemon-1.sock', machineId: 'm', token: 't',
      run: (given) => { options = given; return { stop: vi.fn() } },
      start: () => ({ connectors: async () => ({ connections: [] }) }),
    })
    expect(options).toMatchObject({ name: 'connectors', socketPath: '/data/daemon-1.sock', machineId: 'm', token: 't' })
    expect(await options!.requests.connectors!({ action: 'list' }, { local: true, owner: true })).toEqual({ connections: [] })
  })

  it('runs as a real service by default', () => {
    // The real start opens the bridge: on a free port, in a throwaway home.
    const home = mkdtempSync(join(tmpdir(), 'connectors-process-'))
    vi.stubEnv('HOME', home)
    vi.stubEnv('HARNESS_CONNECTIONS_PORT', '0')
    vi.stubEnv('PATH', '')
    try {
      runConnectorsService({ dataDir: '/data', socketPath: '/data/daemon-1.sock', machineId: 'm', token: 't' })
      expect(runServiceProcess).toHaveBeenCalledWith(expect.objectContaining({ name: 'connectors', requests: { connectors: expect.any(Function) } }))
    } finally { vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }) }
  })
})
