import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CoreApi, CorePorts, OrchestratorPort, OrchestratorRole } from '../core/api.js'
import type { RegisteredSession } from '../lib/registry.js'
import { runOrchestratorService } from './orchestratorProcess.js'
import { type CoreConnection, type ServiceProcessOptions } from './process.js'

// The real default reaches a real socket: never in a test.
vi.mock('./process.js', () => ({ runServiceProcess: vi.fn(() => ({ stop: vi.fn() })) }))

const agent = (agentId: string) => ({ agentId, sessionId: `s-${agentId}`, engine: 'claude', cwd: `/work/${agentId}`, displayName: agentId }) as unknown as RegisteredSession
const OWNER = { local: true, owner: true }
const flush = () => new Promise((settle) => setTimeout(settle, 0))

describe('the orchestrator in its own process', () => {
  afterEach(() => vi.clearAllMocks())

  const setup = (roles: Record<string, OrchestratorRole> = {}) => {
    let options: ServiceProcessOptions | null = null
    let api: CoreApi | null = null
    const port = {
      roleOf: vi.fn((agentId: string) => roles[agentId] ?? null),
      frame: vi.fn(),
      stop: vi.fn(),
    } satisfies OrchestratorPort
    const stop = vi.fn()
    const service = runOrchestratorService({
      dataDir: '/data', socketPath: '/data/daemon-1.sock', machineId: 'm', token: 't',
      run: (given) => { options = given; return { stop } },
      start: (core: CoreApi, ports: CorePorts) => {
        api = core
        ports.orchestrator = port
        return { orchestrator: async (payload) => ({ asked: payload.action, agents: core.agents.live().map((session) => session.agentId), command: core.daemon.command }) }
      },
    })
    return { options: options!, api: () => api!, port, service, stop }
  }
  /** A core that answers as told, and records what it was asked. */
  const coreSaying = (answers: Record<string, unknown>) => {
    const asked: Array<[string, Record<string, unknown> | undefined]> = []
    const query = vi.fn(async (name: string, payload?: Record<string, unknown>) => {
      asked.push([name, payload])
      const answer = answers[name]
      if (answer instanceof Error) throw answer
      return (answer ?? {}) as Record<string, unknown>
    })
    return { query, asked }
  }

  it('answers its request on the agents the core shows as it starts, and how the daemon is run, asked once', async () => {
    const { options } = setup()
    expect(options).toMatchObject({ name: 'orchestrator', socketPath: '/data/daemon-1.sock', machineId: 'm', token: 't' })
    const core = coreSaying({ shown: { agents: [agent('a1')] }, daemon: { command: `'node' 'cli.js'`, port: 18473, machineId: 'm' } })
    options.onConnected!({ query: core.query } satisfies CoreConnection)
    expect(await options.requests.orchestrator!({ action: 'list' }, OWNER)).toEqual({ asked: 'list', agents: ['a1'], command: `'node' 'cli.js'` })
    await options.requests.orchestrator!({ action: 'list' }, OWNER)
    expect(core.asked.filter(([name]) => name === 'daemon')).toHaveLength(1)
    expect(core.asked.filter(([name]) => name === 'shown').length).toBeGreaterThanOrEqual(2)
  })

  it('starts the orchestrator again under the machine a new core serves as, its projects read again from disk', async () => {
    const { options, port } = setup()
    options.onConnected!({ query: coreSaying({ daemon: { command: 'x', port: 1, machineId: 'computer' } }).query })
    await options.requests.orchestrator!({ action: 'list' }, OWNER)
    // A new core, the same machine: the same orchestrator.
    options.onConnected!({ query: coreSaying({ daemon: { command: 'x', port: 1, machineId: 'computer' } }).query })
    await options.requests.orchestrator!({ action: 'list' }, OWNER)
    expect(port.stop).not.toHaveBeenCalled()
    // Signed in since: the account's machine.
    options.onConnected!({ query: coreSaying({ daemon: { command: 'x', port: 1, machineId: 'account-machine' } }).query })
    expect(await options.requests.orchestrator!({ action: 'list' }, OWNER)).toMatchObject({ asked: 'list' })
    expect(port.stop).toHaveBeenCalledOnce()
  })

  it('keeps the agents and the daemon it knew when the core cannot say, and acts on nothing before it connects', async () => {
    const { options, api } = setup()
    expect(await options.requests.orchestrator!({ action: 'list' }, OWNER)).toEqual({ asked: 'list', agents: [], command: 'harness' })
    const core = coreSaying({ shown: { agents: [agent('a1')] }, daemon: { command: 'x', port: 1, machineId: 'm' } })
    options.onConnected!({ query: core.query })
    await options.requests.orchestrator!({ action: 'list' }, OWNER)
    const failing = coreSaying({ shown: new Error('gone'), daemon: new Error('gone') })
    options.onConnected!({ query: failing.query })
    expect(await options.requests.orchestrator!({ action: 'list' }, OWNER)).toEqual({ asked: 'list', agents: ['a1'], command: 'x' })
    options.onDisconnected!()
    expect(await api().agents.create({ engine: 'claude', cwd: '/w', dsh: null, prompt: 'p', name: 'n', bypassPermission: false }))
      .toEqual({ ok: false, error: 'SERVICE_UNAVAILABLE' })
  })

  it('tells the core each live agent\'s role as it connects and whenever a project changes, once at a time', async () => {
    const { options, api, port } = setup({ a1: { role: 'director', busy: true }, a2: { role: 'worker' } })
    const core = coreSaying({ shown: { agents: [agent('a1'), agent('a2'), agent('a3')] } })
    options.onConnected!({ query: core.query })
    // Two changes while a report is on its way: one more report, not two.
    api().clients.windows({ type: 'orchestrator_changed', payload: { id: 'p', revision: 1 } })
    api().clients.windows({ type: 'orchestrator_changed', payload: { id: 'p', revision: 2 } })
    await flush()
    await flush()
    const reports = core.asked.filter(([name]) => name === 'roles')
    expect(reports).toHaveLength(2)
    expect(reports[0][1]).toEqual({ roles: { a1: { role: 'director', busy: true }, a2: { role: 'worker' } } })
    // The windows were told each change, as in the core's process.
    expect(core.asked.filter(([name]) => name === 'windows').map(([, payload]) => payload)).toEqual([
      { frame: { type: 'orchestrator_changed', payload: { id: 'p', revision: 1 } } },
      { frame: { type: 'orchestrator_changed', payload: { id: 'p', revision: 2 } } },
    ])
    expect(port.roleOf).toHaveBeenCalledWith('a3')
  })

  it('says why when it cannot read a role, and reports again on the next change', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { options, port } = setup()
      port.roleOf.mockImplementationOnce(() => { throw new Error('not a folder') }).mockImplementationOnce(() => { throw 'odd' })
      const core = coreSaying({ shown: { agents: [agent('a1')] }, roles: new Error('the core went away') })
      options.onConnected!({ query: core.query })
      await flush()
      options.onConnected!({ query: core.query })
      await flush()
      options.onConnected!({ query: core.query })
      await flush()
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('not a folder'))
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('odd'))
      expect(core.asked.filter(([name]) => name === 'roles')).toHaveLength(1)
    } finally {
      warn.mockRestore()
    }
  })

  it('hands its Directors\' frames and its deliveries\' progress to the service, and stops it with the process', async () => {
    const { options, api, port, service, stop } = setup()
    const heard = vi.fn()
    api().turns.onDelivery(heard)
    options.onEvent!({ kind: 'delivery', event: { deliveryId: 'd1', sessionId: 'a1', state: 'started' } })
    options.onEvent!({ kind: 'frame', frame: { type: 'turn_started', agentId: 'a1' } })
    options.onEvent!({ kind: 'frame' })
    options.onEvent!({ kind: 'nothing' })
    expect(heard).toHaveBeenCalledWith({ deliveryId: 'd1', sessionId: 'a1', state: 'started' })
    expect(port.frame.mock.calls).toEqual([[{ type: 'turn_started', agentId: 'a1' }]])
    service.stop()
    expect(port.stop).toHaveBeenCalledOnce()
    expect(stop).toHaveBeenCalledOnce()
  })

  it('starts the real service and runs the real process when given neither', async () => {
    const { runServiceProcess } = await import('./process.js')
    runOrchestratorService({ dataDir: '/data', socketPath: '/s', machineId: 'm', token: 't' })
    expect(runServiceProcess).toHaveBeenCalledOnce()
    expect(vi.mocked(runServiceProcess).mock.calls[0][0].requests.orchestrator).toBeTypeOf('function')
  })
})
