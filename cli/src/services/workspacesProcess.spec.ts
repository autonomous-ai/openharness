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
    const port = { nameBranches: vi.fn() } satisfies WorkspacesPort
    const service = { stop: vi.fn() }
    const handle = runWorkspacesService({
      dataDir: '/data', socketPath: '/data/daemon-1.sock', machineId: 'm', token: 't',
      run: (given) => { options = given; return service },
      start: (core: CoreApi, ports: CorePorts) => {
        api = core
        ports.workspaces = port
        // As workspaces' own requests do: the folders in use read first, before anything else.
        return { worktrees_list: () => ({ inUse: core.agents.all().map((session) => session.cwd) }) }
      },
      ...over,
    })
    return { api: api!, options: options!, port, service, handle }
  }
  /** A core that answers every question, and records them. */
  const connection = (answer: (name: string, payload?: Record<string, unknown>) => Promise<Record<string, unknown>> = async () => ({ synced: true })) => {
    const query = vi.fn(answer)
    return { core: { query } satisfies CoreConnection, query }
  }

  it('reaches the core as `workspaces`, through the socket and token it was given, and answers the apps\' requests workspaces declares', () => {
    const { options } = setup()
    expect(options).toMatchObject({ name: 'workspaces', socketPath: '/data/daemon-1.sock', machineId: 'm', token: 't' })
    expect(Object.keys(options.requests)).toEqual(['worktrees_list'])
  })

  it('answers an app\'s request with every agent the core lists as it arrives, and knows them only then', async () => {
    const { api, options } = setup()
    const OWNER = { local: true, owner: true }
    const { core, query } = connection(async () => ({ agents: [agent('live'), agent('stopped', { cwd: null as never })] }))
    options.onConnected!(core)
    expect(await options.requests.worktrees_list!({}, OWNER)).toEqual({ inUse: ['/h/worktrees/repo/live', null] })
    expect(query).toHaveBeenCalledWith('agents')
    expect(() => api.agents.all()).toThrow()
    // Asked again for the next one: never the list from before.
    query.mockImplementationOnce(async () => ({ agents: [agent('new')] }))
    expect(await options.requests.worktrees_list!({}, OWNER)).toEqual({ inUse: ['/h/worktrees/repo/new'] })
  })

  it('acts on none when the core cannot list every agent: not connected, failed, or an entry that is no agent', async () => {
    const { options } = setup()
    const OWNER = { local: true, owner: true }
    const unavailable = { error: 'WORKTREES_UNAVAILABLE' }
    expect(await options.requests.worktrees_list!({}, OWNER)).toEqual(unavailable)
    for (const answer of [async () => ({ error: 'QUERY_FAILED' }), async () => ({ agents: [agent(), { not: 'an agent' }] }), () => Promise.reject(new Error('gone'))]) {
      options.onConnected!(connection(answer).core)
      expect(await options.requests.worktrees_list!({}, OWNER)).toEqual(unavailable)
    }
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

  // #4166: a sweep the core asked for removed clean, week-idle worktrees, the ones their person chose to keep too. One an
  // older core still sends is ignored, and nothing asks the core which folders are in use.
  it('ignores a sweep an older core still sends', async () => {
    const { options, port } = setup()
    const { core, query } = connection()
    options.onConnected!(core)
    options.onEvent!({ kind: 'sweep' })
    await flush()
    expect(query).not.toHaveBeenCalled()
    expect(port.nameBranches).not.toHaveBeenCalled()
  })

  it('stops its connection when stopped', () => {
    const { handle, service } = setup()
    handle.stop()
    expect(service.stop).toHaveBeenCalledOnce()
  })

  it('does not run without workspaces: the master starts it again, or parks it', () => {
    expect(() => setup({ start: () => ({}) })).toThrow('workspaces did not start')
  })

  it('runs on a core API of the agents the core sent, answering what workspaces never ask as nothing', async () => {
    const renamed = vi.fn()
    let inUse: RegisteredSession[] | null = null
    const api = workspacesCoreApi('/data', { live: () => [agent('a1')], inUse: () => inUse }, renamed)
    expect(api.dataDir).toBe('/data')
    expect(api.agents.live()).toEqual([agent('a1')])
    expect(() => api.agents.all()).toThrow('the core has not said which folders are in use')
    inUse = [agent('a1'), agent('stopped')]
    expect(api.agents.all()).toEqual([agent('a1'), agent('stopped')])
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
