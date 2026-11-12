import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runServiceProcess, type ServiceProcessOptions } from './process.js'
import { runConnectorsService } from './connectorsProcess.js'
import type { ConnectorsDeps } from './connectors.js'
import type { ConnectorsPort, CoreApi, CorePorts } from '../core/api.js'

// The real default reaches a real socket: never in a test.
vi.mock('./process.js', () => ({ runServiceProcess: vi.fn(() => ({ stop: vi.fn() })) }))

/** A start that fills its port as the real one does, with [port]. */
const startWith = (port: ConnectorsPort) => (_api: CoreApi, ports: CorePorts) => {
  ports.connectors = port
  return { connectors: async () => ({ connections: [] }) }
}

describe('connected services in their own process', () => {
  afterEach(() => vi.clearAllMocks())

  it('answers connectors with the same handler as in the core\'s process', async () => {
    let options: ServiceProcessOptions | null = null
    runConnectorsService({
      dataDir: '/data', socketPath: '/data/daemon-1.sock', machineId: 'm', token: 't',
      run: (given) => { options = given; return { stop: vi.fn() } },
      start: startWith({ syncProfileHome: async () => [] }),
    })
    expect(options).toMatchObject({ name: 'connectors', socketPath: '/data/daemon-1.sock', machineId: 'm', token: 't' })
    expect(await options!.requests.connectors!({ action: 'list' }, { local: true, owner: true })).toEqual({ connections: [] })
  })

  it('answers the core\'s ask for a profile home\'s connections from its port, and nothing for a malformed one', async () => {
    let options: ServiceProcessOptions | null = null
    const syncProfileHome = vi.fn<ConnectorsPort['syncProfileHome']>(async () => ['gmail'])
    runConnectorsService({
      dataDir: '/data', socketPath: '/data/daemon-1.sock', machineId: 'm', token: 't',
      run: (given) => { options = given; return { stop: vi.fn() } },
      start: startWith({ syncProfileHome }),
    })
    const ask = options!.requests.syncProfileHome!
    const core = { local: true, owner: true }
    expect(await ask({ engine: 'codex', folder: '/profiles/codex-work' }, core)).toEqual({ names: ['gmail'] })
    expect(syncProfileHome).toHaveBeenCalledWith('codex', '/profiles/codex-work')
    expect(await ask({ engine: 'opencode', folder: '/profiles/codex-work' }, core)).toEqual({ names: [] })
    expect(await ask({ engine: 'claude', folder: 7 }, core)).toEqual({ names: [] })
    expect(syncProfileHome).toHaveBeenCalledTimes(1)
  })

  it('does not start when connected services leave their port empty', () => {
    expect(() => runConnectorsService({
      dataDir: '/data', socketPath: '/data/daemon-1.sock', machineId: 'm', token: 't',
      run: () => ({ stop: vi.fn() }), start: () => ({ connectors: async () => ({}) }),
    })).toThrow('connected services did not start')
  })

  it('asks the core for the account\'s sealed connections, and hears the notices that change them', async () => {
    let options: ServiceProcessOptions | null = null
    let given: { api: CoreApi, overrides: Partial<ConnectorsDeps> } | null = null
    runConnectorsService({
      dataDir: '/data', socketPath: '/data/daemon-1.sock', machineId: 'm', token: 't',
      run: (o) => { options = o; return { stop: vi.fn() } },
      start: (api, ports, overrides = {}) => { given = { api, overrides }; return startWith({ syncProfileHome: async () => [] })(api, ports) },
    })
    const port = given!.overrides.vaultPort!
    // No core yet: the backend reads as unreachable.
    expect(await port.read()).toBeNull()
    const query = vi.fn(async (_query: string, payload: Record<string, unknown>) =>
      payload.op === 'read' ? { status: 200, body: { success: true, data: { revision: 2, envelope: null } } } : {})
    options!.onConnected!({ query } as never)
    expect(await port.read()).toEqual({ revision: 2, envelope: null })
    expect(query).toHaveBeenCalledWith('connector_vault', { op: 'read' })

    const heard = vi.fn()
    const stop = given!.api.account.onNotice(heard)
    await options!.onEvent!({ kind: 'notice', notice: { type: 'connectors_changed', revision: 3 } })
    await options!.onEvent!({ kind: 'notice' })
    await options!.onEvent!({ kind: 'something_else', notice: { type: 'desk_changed', revision: 1 } })
    expect(heard).toHaveBeenCalledTimes(1)
    expect(heard).toHaveBeenCalledWith({ type: 'connectors_changed', revision: 3 })
    stop()
    await options!.onEvent!({ kind: 'notice', notice: { type: 'connectors_changed', revision: 4 } })
    expect(heard).toHaveBeenCalledTimes(1)

    options!.onDisconnected!()
    expect(await port.read()).toBeNull()
  })

  it('runs as a real service by default', () => {
    // The real start opens the bridge: on a free port, in a throwaway home.
    const home = mkdtempSync(join(tmpdir(), 'connectors-process-'))
    vi.stubEnv('HOME', home)
    vi.stubEnv('HARNESS_CONNECTIONS_PORT', '0')
    vi.stubEnv('PATH', '')
    try {
      runConnectorsService({ dataDir: '/data', socketPath: '/data/daemon-1.sock', machineId: 'm', token: 't' })
      expect(runServiceProcess).toHaveBeenCalledWith(expect.objectContaining({ name: 'connectors', requests: { connectors: expect.any(Function), syncProfileHome: expect.any(Function) } }))
    } finally { vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }) }
  })
})
