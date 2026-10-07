import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CoreApi, CorePorts, MonitorPort } from '../core/api.js'
import type { RegisteredSession } from '../lib/registry.js'
import { runMonitorService } from './monitorProcess.js'
import { runServiceProcess, type CoreConnection, type ServiceProcessOptions } from './process.js'

// The real default reaches a real socket and runs `ps`: never in a test.
vi.mock('./process.js', () => ({ runServiceProcess: vi.fn(() => ({ stop: vi.fn() })) }))

const agent = (agentId: string) => ({ agentId, sessionId: `s-${agentId}`, engine: 'claude', cwd: `/work/${agentId}` }) as RegisteredSession
const ASKER = { local: true, owner: true }

describe('the machine monitor in its own process', () => {
  afterEach(() => vi.clearAllMocks())

  const setup = () => {
    let options: ServiceProcessOptions | null = null
    let api: CoreApi | null = null
    /** The agents each sample read. */
    const sampled: string[][] = []
    const snapshot = { agents: [], sampledAt: null, shared: [] }
    const port = {
      resources: vi.fn(async () => { sampled.push(api!.agents.advertised().map((session) => session.agentId)); return snapshot }),
      storage: vi.fn(async (agents: readonly { agentId: string }[]) => new Map(agents.map((session) => [session.agentId, { workspaceBytes: 1 }]))),
    } as unknown as MonitorPort
    runMonitorService({
      dataDir: '/data', socketPath: '/data/daemon-1.sock', machineId: 'm', token: 't',
      run: (given) => { options = given; return { stop: vi.fn() } },
      start: (core: CoreApi, ports: CorePorts) => {
        api = core
        ports.monitor = port
        return { machine_resources: async (payload) => ({ harnesses: payload.harnesses === true, read: sampled.length }) }
      },
    })
    return { options: options!, port, sampled, snapshot }
  }

  it('answers the Monitor and the core\'s port from one set of readers, on the agents advertised as each sample starts', async () => {
    const { options, port, sampled, snapshot } = setup()
    expect(options).toMatchObject({ name: 'monitor', socketPath: '/data/daemon-1.sock', machineId: 'm', token: 't' })
    let advertised: Record<string, unknown> = { agents: [agent('a1')] }
    const query = vi.fn(async (_name: string) => advertised)
    options.onConnected!({ query } satisfies CoreConnection)
    // The machine's own totals read no agent: the core is not asked.
    expect(await options.requests.machine_resources!({}, ASKER)).toEqual({ harnesses: false, read: 0 })
    expect(query).not.toHaveBeenCalled()
    expect(await options.requests.machine_resources!({ harnesses: true }, ASKER)).toEqual({ harnesses: true, read: 0 })
    expect(query).toHaveBeenLastCalledWith('advertised')
    expect(await options.requests.resources!({}, ASKER)).toEqual({ snapshot })
    // A core that cannot say leaves the agents it said last.
    advertised = { error: 'UNKNOWN_QUERY' }
    await options.requests.resources!({}, ASKER)
    query.mockRejectedValueOnce(new Error('the core went away'))
    await options.requests.resources!({}, ASKER)
    expect(sampled).toEqual([['a1'], ['a1'], ['a1']])
    // What the core asks the workspaces and transcripts of, and to forget: its agents, as it sent them.
    expect(await options.requests.storage!({ agents: [agent('a2'), { nope: true }], invalidate: true }, ASKER)).toEqual({ entries: [['a2', { workspaceBytes: 1 }]] })
    expect(port.storage).toHaveBeenLastCalledWith([agent('a2')], true)
    expect(await options.requests.storage!({}, ASKER)).toEqual({ entries: [] })
    expect(port.storage).toHaveBeenLastCalledWith([], false)
  })

  it('does not run without its readers: the master starts it again, or parks it', () => {
    expect(() => runMonitorService({ dataDir: '/data', socketPath: '/s', machineId: 'm', token: 't', run: vi.fn(), start: () => ({}) })).toThrow('the monitor did not start')
  })

  it('runs as a real service by default, answering the Monitor and the port\'s two members', () => {
    runMonitorService({ dataDir: '/data', socketPath: '/data/daemon-1.sock', machineId: 'm', token: 't' })
    const options = vi.mocked(runServiceProcess).mock.calls.at(-1)![0]
    expect(options.name).toBe('monitor')
    expect(Object.keys(options.requests).sort()).toEqual(['machine_resources', 'resources', 'storage'])
  })
})
