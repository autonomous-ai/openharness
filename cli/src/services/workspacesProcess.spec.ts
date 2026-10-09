import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CoreApi, CorePorts, WorkspacesPort } from '../core/api.js'
import type { RegisteredSession } from '../lib/registry.js'
import { runServiceProcess, type CoreConnection, type ServiceProcessOptions } from './process.js'
import { runWorkspacesService, workspacesCoreApi } from './workspacesProcess.js'

// The real default reaches a real socket and this process's own channel: never in a test.
vi.mock('./process.js', () => ({ runServiceProcess: vi.fn(() => ({ stop: vi.fn() })) }))

const agent = (agentId = 'a1', over: Partial<RegisteredSession> = {}) =>
  ({ agentId, sessionId: `s-${agentId}`, engine: 'claude', cwd: `/h/worktrees/repo/${agentId}`, title: 'Fix the login page', ...over }) as RegisteredSession

const flush = () => new Promise((done) => setTimeout(done, 0))

describe('workspaces in their own process', () => {
  afterEach(() => vi.clearAllMocks())

  const setup = (over: Partial<Parameters<typeof runWorkspacesService>[0]> = {}) => {
    let api: CoreApi | null = null
    let options: ServiceProcessOptions | null = null
    /** What `all()` answered when the service swept, each time. */
    const swept: RegisteredSession[][] = []
    const port = {
      nameBranches: vi.fn(),
      sweepUnused: vi.fn(() => { swept.push(api!.agents.all()) }),
    } satisfies WorkspacesPort
    const service = { stop: vi.fn() }
    const handle = runWorkspacesService({
      dataDir: '/data', socketPath: '/data/daemon-1.sock', machineId: 'm', token: 't',
      run: (given) => { options = given; return service },
      start: (core: CoreApi, ports: CorePorts) => { api = core; ports.workspaces = port },
      ...over,
    })
    return { api: api!, options: options!, port, service, handle, swept }
  }
  /** A core that answers `agents` with `answer`, and records the rest. */
  const connection = (answer: () => Promise<Record<string, unknown>> = async () => ({ agents: [agent()] })) => {
    const query = vi.fn((name: string, _payload?: Record<string, unknown>) => (name === 'agents' ? answer() : Promise.resolve({ synced: true })))
    return { core: { query } satisfies CoreConnection, query }
  }

  it('reaches the core as `workspaces`, through the socket and token it was given, and answers the apps nothing', () => {
    const { options } = setup()
    expect(options).toMatchObject({ name: 'workspaces', socketPath: '/data/daemon-1.sock', machineId: 'm', token: 't' })
    expect(options.requests).toEqual({})
  })

  it('names branches when the core says, with the live agents it sent', () => {
    const { api, options, port } = setup()
    options.onEvent!({ kind: 'nameBranches', agents: [agent('a1'), { not: 'an agent' }, agent('a2')] })
    expect(port.nameBranches).toHaveBeenCalledOnce()
    expect(api.agents.live().map((session) => session.agentId)).toEqual(['a1', 'a2'])
    expect(api.agents.byAgent('a2')).toEqual(agent('a2'))
    // Told without agents, or told something else: nothing to do.
    options.onEvent!({ kind: 'nameBranches' })
    options.onEvent!({ kind: 'touch', sessionId: 's1' })
    expect(port.nameBranches).toHaveBeenCalledOnce()
  })

  it('asks the core to send a renamed agent\'s frame again, once connected; a lost word costs nothing', async () => {
    const { api, options } = setup()
    api.agents.sync(agent('a1'))
    const core = connection()
    options.onConnected!(core.core)
    api.agents.sync(agent('a1'))
    expect(core.query).toHaveBeenCalledWith('branchNamed', { agentId: 'a1' })
    options.onConnected!({ query: vi.fn(async () => { throw new Error('the core went away') }) })
    api.agents.sync(agent('a1'))
    await flush()
  })

  it('sweeps when the core says, with every agent the core names at that moment, and knows them only then', async () => {
    const { api, options, port, swept } = setup()
    const everyone = [agent('a1'), agent('old', { active: false, cwd: null as never })]
    const core = connection(async () => ({ agents: everyone, requestId: 'r1' }))
    options.onConnected!(core.core)
    expect(() => api.agents.all()).toThrow('the core has not said which folders are in use')
    options.onEvent!({ kind: 'sweep' })
    await flush()
    expect(core.query).toHaveBeenCalledWith('agents')
    expect(port.sweepUnused).toHaveBeenCalledOnce()
    // Exactly as the core sent them, the one with no folder too.
    expect(swept).toEqual([everyone])
    expect(() => api.agents.all()).toThrow()
  })

  it('does not sweep when the core cannot name every agent, or names something that is not one', async () => {
    const { options, port } = setup()
    options.onConnected!(connection(async () => ({ error: 'QUERY_FAILED' })).core)
    options.onEvent!({ kind: 'sweep' })
    await flush()
    options.onConnected!(connection(async () => ({ agents: [agent('a1'), null] })).core)
    options.onEvent!({ kind: 'sweep' })
    await flush()
    options.onConnected!(connection(async () => { throw new Error('the core went away') }).core)
    options.onEvent!({ kind: 'sweep' })
    await flush()
    expect(port.sweepUnused).not.toHaveBeenCalled()
  })

  it('asks once for a sweep however often it is told meanwhile, and again for the next', async () => {
    const { options, port } = setup()
    let answer: (value: Record<string, unknown>) => void = () => {}
    const core = connection(() => new Promise((done) => { answer = done }))
    options.onConnected!(core.core)
    options.onEvent!({ kind: 'sweep' })
    options.onEvent!({ kind: 'sweep' })
    expect(core.query).toHaveBeenCalledOnce()
    answer({ agents: [agent()] })
    await flush()
    expect(port.sweepUnused).toHaveBeenCalledOnce()
    options.onEvent!({ kind: 'sweep' })
    expect(core.query).toHaveBeenCalledTimes(2)
  })

  it('cannot sweep before it is connected: only the core it reaches can say what is in use', () => {
    const { options, port } = setup()
    options.onEvent!({ kind: 'sweep' })
    expect(port.sweepUnused).not.toHaveBeenCalled()
  })

  it('survives a sweep that fails, and forgets the agents it was given for it', async () => {
    const { api, options, port } = setup()
    port.sweepUnused.mockImplementationOnce(() => { throw new Error('boom') })
    options.onConnected!(connection().core)
    options.onEvent!({ kind: 'sweep' })
    await flush()
    expect(() => api.agents.all()).toThrow()
    options.onEvent!({ kind: 'sweep' })
    await flush()
    expect(port.sweepUnused).toHaveBeenCalledTimes(2)
  })

  it('stops its connection when stopped', () => {
    const { handle, service } = setup()
    handle.stop()
    expect(service.stop).toHaveBeenCalledOnce()
  })

  it('does not run without workspaces: the master starts it again, or parks it', () => {
    expect(() => setup({ start: () => {} })).toThrow('workspaces did not start')
  })

  it('runs on a core API of the agents the core sent, answering what workspaces never ask as nothing', async () => {
    const renamed = vi.fn()
    let everyone: RegisteredSession[] | null = null
    const api = workspacesCoreApi('/data', { live: () => [agent('a1')], inUse: () => everyone }, renamed)
    expect(api.dataDir).toBe('/data')
    expect(api.agents.live()).toEqual([agent('a1')])
    expect(() => api.agents.all()).toThrow()
    everyone = [agent('a1'), agent('old')]
    expect(api.agents.all()).toEqual(everyone)
    expect(api.agents.byAgent('a1')).toEqual(agent('a1'))
    expect(api.agents.byAgent('old')).toBeUndefined()
    expect(api.agents.resolve('a1')).toEqual(agent('a1'))
    expect(api.agents.displayName(agent())).toBe('')
    expect(api.agents.advertised()).toEqual([])
    expect(api.agents.terminalAvailable('a1')).toBe(false)
    api.agents.sync(agent('a1'))
    expect(renamed).toHaveBeenCalledWith('a1')
    expect(api.transcripts.databaseHistory(agent())).toBeUndefined()
    expect(await api.transcripts.lastTurn('s1')).toBeNull()
    await expect(api.account.mintGridName()).resolves.toBeNull()
    await expect(api.account.accessToken()).rejects.toThrow('workspaces hold no credential')
    await expect(api.account.privateGridName()).resolves.toBeNull()
    expect(api.account.machineName()).toBeNull()
    await expect(api.agents.runtimeModels()).resolves.toEqual([])
    expect(api.agents.runtimeProfile({} as never)).toBeNull()
    api.agents.setRuntime('a1', 'opus')
    await expect(api.agents.fork('a1')).resolves.toEqual({ ok: false, error: 'UNSUPPORTED' })
    api.turns.send('a1', 'text')
    api.turns.stop('a1')
    expect(await api.turns.recent('a1', 3)).toEqual([])
    expect(await api.turns.asks('a1')).toEqual([])
    api.questions.answer('a1', 'q', {})
    await expect(api.questions.answerReviewed({} as never)).resolves.toBe(false)
    api.clients.gridModelsChanged()
    api.clients.viewerChanged('a1')
    expect(api.clients.viewerFrame('c1', 'viewer_data', {})).toBe(false)
    api.clients.gridNamed('grid')
    api.clients.dshInstallStatus({ phase: 'clone' })
    api.clients.windows({ type: 'orchestrator_changed', payload: {} })
    expect(api.clients.observer('observer:x', 'observer_frame', {})).toBe(false)
    api.clients.turnCard({ type: 'commander_event', agentId: 'a', dbSessionId: 's', payload: {} })
    api.clients.turnSummary({ type: 'turn_summary' })
  })

  it('runs as a real service process, with the real workspaces, by default', () => {
    runWorkspacesService({ dataDir: '/data', socketPath: '/data/daemon-1.sock', machineId: 'm', token: 't' })
    expect(runServiceProcess).toHaveBeenCalledWith(expect.objectContaining({ name: 'workspaces', socketPath: '/data/daemon-1.sock' }))
  })
})
