import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CoreApi, CorePorts, PreparedFolder, WorkspacesPort, WorktreeAnswer } from '../core/api.js'
import type { WorkspaceInspection, WorktreeReview } from '../lib/worktreeDeletion.js'
import type { RegisteredSession } from '../lib/registry.js'
import { runServiceProcess, type CoreConnection, type ServiceProcessOptions } from './process.js'
import { runWorkspacesService, workspacesCoreApi } from './workspacesProcess.js'

// The real default reaches a real socket and this process's own channel: never in a test.
vi.mock('./process.js', () => ({ runServiceProcess: vi.fn(() => ({ stop: vi.fn() })) }))

const agent = (agentId = 'a1', over: Partial<RegisteredSession> = {}) =>
  ({ agentId, sessionId: `s-${agentId}`, engine: 'claude', cwd: `/h/worktrees/repo/${agentId}`, title: 'Fix the login page', ...over }) as RegisteredSession

const flush = () => new Promise((done) => setTimeout(done, 0))
const OWNER = { local: true, owner: true, connection: 'core', requestId: 'r1' } as never
const CLOSED = new AbortController().signal

describe('workspaces in their own process', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks() })

  const setup = (over: Partial<Parameters<typeof runWorkspacesService>[0]> = {}) => {
    let api: CoreApi | null = null
    let options: ServiceProcessOptions | null = null
    const port = {
      nameBranches: vi.fn(), ready: vi.fn(() => true),
      prepareFolder: vi.fn(async (): Promise<PreparedFolder> => ({ ok: true, cwd: '/h/harnesses/repo' })),
      describeWorkspace: vi.fn(async (): Promise<WorkspaceInspection | null> => null),
      reviewWorktree: vi.fn(async (): Promise<WorktreeAnswer> => ({ ok: false, reason: 'No separate worktree. This folder is not a Git worktree.' })),
      removeWorktree: vi.fn(async () => ({ ok: true as const })),
    } satisfies WorkspacesPort
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

  it('reaches the core as `workspaces`, through the socket and token it was given, and answers the apps\' requests workspaces declares and the core\'s own', () => {
    const { options } = setup()
    expect(options).toMatchObject({ name: 'workspaces', socketPath: '/data/daemon-1.sock', machineId: 'm', token: 't' })
    // The apps' (core/api.ts WORKSPACES_REQUESTS), then the port's own members, which the core asks as itself
    // (core/workspacesLink.ts): no app request names them.
    expect(Object.keys(options.requests)).toEqual(['worktrees_list', 'prepareFolder', 'describeWorkspace', 'reviewWorktree', 'removeWorktree'])
  })

  it('says it makes folders each time it connects, so a core of this build asks it for them; a word lost is said', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { options } = setup()
    const { core, query } = connection()
    options.onConnected!(core)
    expect(query.mock.calls).toEqual([['folders']])
    options.onConnected!({ query: vi.fn(async () => { throw new Error('the core went away') }) })
    options.onConnected!({ query: vi.fn(async () => { throw 'closed' }) })
    await flush()
    expect(warn.mock.calls).toEqual([['[workspaces] could not tell the core this process makes folders · the core went away'],
      ['[workspaces] could not tell the core this process makes folders · closed']])
    warn.mockRestore()
  })

  it('makes the folder the core asks for, from a project it checks first', async () => {
    const { options, port } = setup()
    const ask = (payload: Record<string, unknown>) => options.requests.prepareFolder!(payload, OWNER, CLOSED)
    const project = { source: 'worktree', gitSource: '/h/code/repo', branchRef: 'refs/heads/main', branchName: 'fix-login', existingBranch: true }
    expect(await ask({ project, cloneFallback: true })).toEqual({ ok: true, cwd: '/h/harnesses/repo' })
    expect(port.prepareFolder).toHaveBeenLastCalledWith(project, { cloneFallback: true })
    await ask({ project: { source: 'remote', repositoryUrl: 'https://github.com/acme/app.git', name: 'app' }, cloneFallback: 'yes' })
    expect(port.prepareFolder).toHaveBeenLastCalledWith({ source: 'remote', repositoryUrl: 'https://github.com/acme/app.git', name: 'app' }, { cloneFallback: false })
    for (const bad of [undefined, { source: 'new' }, { source: 'branch', gitSource: 7 }]) {
      expect(await ask({ project: bad, cloneFallback: true })).toEqual({ ok: false, error: 'INVALID_PROJECT_SOURCE', detail: 'Choose a project.' })
    }
    expect(port.prepareFolder).toHaveBeenCalledTimes(2)
  })

  it('reads, reviews and removes a harness\'s worktree for the core, for the harness and the folders it was sent', async () => {
    const { options, port } = setup()
    const ask = (type: string, payload: Record<string, unknown>) => options.requests[type]!(payload, OWNER, CLOSED)
    const target = { cwd: '/h/harnesses/worktrees/repo/a1', transcriptPath: '/h/.claude/projects/x/s1.jsonl', codexHome: null, hermesHome: 7 }
    const read = { cwd: target.cwd, transcriptPath: target.transcriptPath }
    const others = ['/h/code/repo', '/h/code/other']
    expect(await ask('describeWorkspace', { target, others })).toEqual({ workspace: null })
    expect(port.describeWorkspace).toHaveBeenLastCalledWith(read, others)
    expect(await ask('reviewWorktree', { target: { cwd: null }, others: [] })).toEqual({ ok: false, reason: 'No separate worktree. This folder is not a Git worktree.' })
    expect(port.reviewWorktree).toHaveBeenLastCalledWith({ cwd: null }, [])
    const review = { path: target.cwd } as WorktreeReview
    expect(await ask('removeWorktree', { review, target, others, discardChanges: true })).toEqual({ ok: true })
    expect(port.removeWorktree).toHaveBeenLastCalledWith(review, read, others, true)
    await ask('removeWorktree', { review, target, others: [], discardChanges: 'yes' })
    expect(port.removeWorktree).toHaveBeenLastCalledWith(review, read, [], false)
    // A harness, a review or the other harnesses' folders it cannot read whole is refused in words, and nothing of git
    // runs for it: a list cut short could leave out the harness whose files a removal would take.
    const refused = { ok: false, reason: 'The request to review this worktree was malformed.' }
    for (const bad of [{ target: undefined, others }, { target: 'a1', others }, { target: { cwd: 7 }, others }, { target: { transcriptPath: '/t' }, others },
      { target }, { target, others: 'all' }, { target, others: ['/h/code/repo', 7] }, { target, others: Array(10_001).fill('/h/code/repo') }]) {
      expect(await ask('describeWorkspace', bad)).toEqual({ workspace: null })
      expect(await ask('reviewWorktree', bad)).toEqual(refused)
      expect(await ask('removeWorktree', { review, ...bad })).toEqual(refused)
    }
    expect(await ask('removeWorktree', { review: 'r', target, others })).toEqual(refused)
    expect(await ask('removeWorktree', { target, others })).toEqual(refused)
    expect(port.describeWorkspace).toHaveBeenCalledOnce()
    expect(port.reviewWorktree).toHaveBeenCalledOnce()
    expect(port.removeWorktree).toHaveBeenCalledTimes(2)
  })

  it('answers an app\'s request with every agent the core lists as it arrives, and knows them only then', async () => {
    const { api, options } = setup()
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
    // A core that fails every question fails the word that this process makes folders too, which is said.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { options } = setup()
    const unavailable = { error: 'WORKTREES_UNAVAILABLE' }
    expect(await options.requests.worktrees_list!({}, OWNER)).toEqual(unavailable)
    for (const answer of [async () => ({ error: 'QUERY_FAILED' }), async () => ({ agents: [agent(), { not: 'an agent' }] }), () => Promise.reject(new Error('gone'))]) {
      options.onConnected!(connection(answer).core)
      expect(await options.requests.worktrees_list!({}, OWNER)).toEqual(unavailable)
    }
    await flush()
    expect(warn).toHaveBeenCalledWith('[workspaces] could not tell the core this process makes folders · gone')
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
    vi.spyOn(console, 'warn').mockImplementation(() => {})
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
    expect(query.mock.calls).toEqual([['folders']])
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
