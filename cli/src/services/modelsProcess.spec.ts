import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CoreApi, CorePorts, ModelsPort, ServiceRequests } from '../core/api.js'
import type { GridGlance } from '../lib/gridAnnotation.js'
import type { CoreConnection, ServiceProcessOptions } from './process.js'
import { modelsCoreApi, runModelsService } from './modelsProcess.js'

// The real default reaches a real socket and this process's own channel: never in a test.
vi.mock('./process.js', () => ({ runServiceProcess: vi.fn(() => ({ stop: vi.fn() })) }))
// The real service reads grid and follows its pin: never in a test. Its own spec is services/models.spec.ts.
vi.mock('./models.js', () => ({ startModels: vi.fn((_core: CoreApi, ports: CorePorts) => { ports.models = fakeModels().port; return {} }) }))

const RELAY = 'https://fixture.invalid/g/net-own/relay/v1'
const LAUNCH = { networkId: 'net-own', networkName: 'mine', baseUrl: RELAY, apiKey: 'fixture-key', model: 'Small-Q4' }
const glance = (state: 'awake' | 'asleep'): GridGlance => ({ id: 'net-own', view: { state, models: [{ id: 'Small-Q4' }] }, listed: true, asleep: state === 'asleep' })

/** Models that read no grid: its port, every member a fake, and the apps' requests it answers. */
function fakeModels() {
  const port = {
    ensure: vi.fn(async () => ({ status: 'converged' as const, name: 'mine', detail: 'ok' })),
    annotation: vi.fn(() => null),
    prewarm: vi.fn(),
    launchTarget: vi.fn(async () => LAUNCH),
    moveTarget: vi.fn(async (): Promise<{ target: typeof LAUNCH } | { detail: string }> => ({ target: LAUNCH })),
    moved: vi.fn(),
    privateGridName: vi.fn(async () => 'mine'),
    lists: vi.fn(async () => ({ plain: { gridName: 'mine' }, rowState: { gridName: 'mine', grids: [] } })),
    machines: vi.fn(),
    signedOut: vi.fn(),
  } satisfies ModelsPort
  const requests: ServiceRequests = { grid_models_list: vi.fn(async () => ({ gridName: 'mine' })) }
  return { port, requests }
}

/** A connection to the core that records what it is told, and answers `machines` with `machines`. */
function connection(machines: Record<string, unknown> = {}, kept = true) {
  const query = vi.fn(async (name: string, _payload?: Record<string, unknown>): Promise<Record<string, unknown>> =>
    name === 'machines' ? machines : name === 'glances' ? { kept } : {})
  const told = () => query.mock.calls.filter(([name]) => name === 'glances').map(([, payload]) => payload)
  return { core: { query } satisfies CoreConnection, query, told }
}

const flush = () => new Promise((done) => setTimeout(done, 0))

describe('models in its own process', () => {
  afterEach(() => vi.clearAllMocks())

  const setup = (over: Partial<Parameters<typeof runModelsService>[0]> = {}) => {
    const models = fakeModels()
    let api: CoreApi | null = null
    let options: ServiceProcessOptions | null = null
    let glances: GridGlance[] = []
    let changed: () => void = () => {}
    const service = { stop: vi.fn() }
    const handle = runModelsService({
      dataDir: '/data', socketPath: '/data/daemon-1.sock', machineId: 'm', token: 't',
      run: (given) => { options = given; return service },
      start: (core: CoreApi, ports: CorePorts) => { api = core; ports.models = models.port; return models.requests },
      glances: () => glances,
      onChanged: (listener) => { changed = listener; return () => {} },
      ...over,
    })
    return { models, api: api!, options: options!, service, handle, setGlances: (next: GridGlance[]) => { glances = next }, changed: () => changed() }
  }

  it('reaches the core as `models`, answering the apps\' requests and the core\'s port calls, and stops with its link', () => {
    const { models, options, handle, service } = setup()
    expect(options).toMatchObject({ name: 'models', socketPath: '/data/daemon-1.sock', machineId: 'm', token: 't' })
    expect(Object.keys(options.requests).sort()).toEqual(['ensure', 'grid_models_list', 'launchTarget', 'lists', 'moveTarget', 'privateGridName'])
    expect(options.requests.grid_models_list).toBe(models.requests.grid_models_list)
    handle.stop()
    expect(service.stop).toHaveBeenCalled()
  })

  it('a start that fills no port is no models at all', () => {
    expect(() => runModelsService({ dataDir: '/data', socketPath: '/s', machineId: 'm', token: 't', run: () => ({ stop: vi.fn() }), start: () => ({}) }))
      .toThrow('models did not start')
  })

  it('answers the core\'s port calls through the port, as the core\'s process would', async () => {
    const { models, options } = setup()
    const asker = { local: true, owner: true }
    expect(await options.requests.ensure!({ ownGrid: true }, asker)).toEqual({ status: 'converged', name: 'mine', detail: 'ok' })
    await options.requests.ensure!({}, asker)
    expect(models.port.ensure.mock.calls).toEqual([[{ ownGrid: true }], [{ ownGrid: false }]])
    expect(await options.requests.launchTarget!({ model: 'Small-Q4', grid: 'mine' }, asker)).toEqual({ target: LAUNCH })
    expect(await options.requests.launchTarget!({ model: 7 }, asker)).toEqual({ target: LAUNCH })
    expect(models.port.launchTarget.mock.calls).toEqual([[{ model: 'Small-Q4', grid: 'mine' }], [{ model: '', grid: '' }]])
    expect(await options.requests.moveTarget!({ gridName: 'team', model: 'Shared' }, asker)).toEqual({ target: LAUNCH })
    models.port.moveTarget.mockResolvedValueOnce({ detail: 'no grid' })
    expect(await options.requests.moveTarget!({}, asker)).toEqual({ detail: 'no grid' })
    expect(models.port.moveTarget.mock.calls).toEqual([[{ gridName: 'team', model: 'Shared' }], [{ gridName: null, model: '' }]])
    expect(await options.requests.privateGridName!({}, asker)).toEqual({ name: 'mine' })
    expect(await options.requests.lists!({}, asker)).toEqual({ plain: { gridName: 'mine' }, rowState: { gridName: 'mine', grids: [] } })
  })

  it('does what the core tells it, and passes over what it cannot read', () => {
    const { models, options } = setup()
    options.onEvent!({ kind: 'prewarm', grid: { baseUrl: RELAY, model: 'Small-Q4' } })
    options.onEvent!({ kind: 'prewarm', grid: { baseUrl: RELAY } })
    options.onEvent!({ kind: 'prewarm', grid: 'nope' })
    expect(models.port.prewarm.mock.calls).toEqual([[{ baseUrl: RELAY, model: 'Small-Q4' }], [{ baseUrl: RELAY, model: null }]])
    options.onEvent!({ kind: 'moved', launch: LAUNCH })
    options.onEvent!({ kind: 'moved', launch: { networkId: 'n' } })
    expect(models.port.moved.mock.calls).toEqual([[LAUNCH]])
    options.onEvent!({ kind: 'machines', body: { data: {} }, computerId: 'here' })
    options.onEvent!({ kind: 'machines', body: 'nope' })
    expect(models.port.machines.mock.calls).toEqual([[{ data: {} }, 'here'], [null, '']])
    options.onEvent!({ kind: 'signedOut' })
    expect(models.port.signedOut).toHaveBeenCalledOnce()
    options.onEvent!({ kind: 'anything' })
  })

  it('tells the core every grid as it connects and on each change, each change once, and again on a new connection', async () => {
    const { options, setGlances, changed } = setup()
    setGlances([glance('awake')])
    // Not connected: nothing to tell.
    changed()
    const first = connection()
    options.onConnected!(first.core)
    await flush()
    expect(first.told()).toEqual([{ glances: [glance('awake')] }])
    changed()
    expect(first.told()).toHaveLength(1)
    setGlances([glance('asleep')])
    changed()
    expect(first.told()).toEqual([{ glances: [glance('awake')] }, { glances: [glance('asleep')] }])
    // A core that restarted has heard nothing.
    const second = connection()
    options.onConnected!(second.core)
    expect(second.told()).toEqual([{ glances: [glance('asleep')] }])
  })

  it('says it again when the core did not keep it; a connection that went says it on the next', async () => {
    const { options, setGlances, changed } = setup()
    setGlances([glance('awake')])
    const refusing = connection({}, false)
    options.onConnected!(refusing.core)
    await flush()
    changed()
    expect(refusing.told()).toHaveLength(2)
    const failing = connection()
    failing.query.mockRejectedValue(new Error('the core went away'))
    options.onConnected!(failing.core)
    await flush()
    changed()
    expect(failing.told()).toHaveLength(1)
    const next = connection()
    options.onConnected!(next.core)
    expect(next.told()).toHaveLength(1)
  })

  it('asks the core for the machine list it read before this process could hear it', async () => {
    const { models, options } = setup()
    options.onConnected!(connection({ body: { data: { machines: [] } }, computerId: 'here' }).core)
    await flush()
    expect(models.port.machines).toHaveBeenCalledExactlyOnceWith({ data: { machines: [] } }, 'here')
    options.onConnected!(connection({ body: 'nope', computerId: 'here' }).core)
    await flush()
    expect(models.port.machines).toHaveBeenLastCalledWith(null, 'here')
    // None read yet, or a connection that went before it answered: nothing.
    options.onConnected!(connection({}).core)
    const gone = connection()
    gone.query.mockRejectedValue(new Error('the core went away'))
    options.onConnected!(gone.core)
    await flush()
    expect(models.port.machines).toHaveBeenCalledTimes(2)
    // An answer for a connection that was replaced meanwhile is not heard.
    let answer!: (value: Record<string, unknown>) => void
    const slow = connection()
    slow.query.mockImplementation(async (name: string) => name === 'machines' ? new Promise((done) => { answer = done }) : { kept: true })
    options.onConnected!(slow.core)
    options.onConnected!(connection().core)
    answer({ body: null, computerId: 'here' })
    await flush()
    expect(models.port.machines).toHaveBeenCalledTimes(2)
  })
})

describe('the core API models runs on in its own process', () => {
  const asking = (answers: Record<string, Record<string, unknown> | Error>) => {
    const ask = vi.fn(async (query: string, _payload?: Record<string, unknown>) => {
      const answer = answers[query]
      if (answer instanceof Error) throw answer
      return answer ?? {}
    })
    return { ask, api: modelsCoreApi('/data', ask) }
  }

  it('asks the core for the account\'s grid, and keeps this machine\'s name from the same answer', async () => {
    const { ask, api } = asking({ account: { gridName: 'mine', machineName: 'Studio' } })
    expect(api.dataDir).toBe('/data')
    expect(api.account.machineName()).toBeNull()
    expect(await api.account.privateGridName()).toBe('mine')
    expect(api.account.machineName()).toBe('Studio')
    expect(ask).toHaveBeenCalledWith('account')
    expect(await asking({ account: {} }).api.account.privateGridName()).toBeNull()
    // Unanswered (the core went away): no name, and models works one out.
    const gone = asking({ account: new Error('not connected to the core') })
    expect(await gone.api.account.privateGridName()).toBeNull()
    expect(gone.api.account.machineName()).toBeNull()
  })

  it('asks for a minted name and the token each time, and says when there is none', async () => {
    const { api } = asking({ mintGridName: { name: 'minted-1a2b' }, accessToken: { token: 'fixture-token' } })
    expect(await api.account.mintGridName()).toBe('minted-1a2b')
    expect(await api.account.accessToken()).toBe('fixture-token')
    expect(await asking({ mintGridName: {} }).api.account.mintGridName()).toBeNull()
    await expect(asking({ mintGridName: { error: 'QUERY_FAILED' } }).api.account.mintGridName()).rejects.toThrow('QUERY_FAILED')
    await expect(asking({ accessToken: { error: 'QUERY_FAILED' } }).api.account.accessToken()).rejects.toThrow('signed out')
  })

  it('asks for an agent\'s Model/Effort choices, and fails as the core\'s own would when it gets none', async () => {
    const models = [{ id: 'runtime-v1:a1:codex:o3@high', displayName: 'o3 / High' }]
    const { ask, api } = asking({ runtimeModels: { models } })
    expect(await api.agents.runtimeModels('a1')).toEqual(models)
    expect(await api.agents.runtimeModels()).toEqual(models)
    expect(ask.mock.calls).toEqual([['runtimeModels', { agentId: 'a1' }], ['runtimeModels', {}]])
    await expect(asking({ runtimeModels: { error: 'QUERY_FAILED' } }).api.agents.runtimeModels()).rejects.toThrow('QUERY_FAILED')
    await expect(asking({}).api.agents.runtimeModels()).rejects.toThrow('no answer')
  })

  it('tells the core the two pushes to the windows, a lost one lost quietly', async () => {
    const { ask, api } = asking({ gridNamed: new Error('the core went away') })
    api.clients.gridNamed('mine')
    api.clients.gridModelsChanged()
    await flush()
    expect(ask.mock.calls).toEqual([['gridNamed', { name: 'mine' }], ['gridModelsChanged', {}]])
  })

  it('has no agents of its own and drives none: what models never asks answers as nothing', async () => {
    const { ask, api } = asking({})
    expect([api.agents.all(), api.agents.live(), api.agents.advertised(), api.agents.displayName({} as never)]).toEqual([[], [], [], ''])
    expect([api.agents.byAgent('a1'), api.agents.resolve('a1'), api.agents.terminalAvailable('a1'), api.agents.runtimeProfile({} as never)]).toEqual([undefined, undefined, false, null])
    api.agents.sync({} as never)
    api.agents.setRuntime('a1')
    expect(await api.agents.fork('a1')).toEqual({ ok: false, error: 'UNSUPPORTED' })
    api.turns.send('a1', 'x')
    api.turns.stop('a1')
    expect(await Promise.all([api.turns.recent('a1', 1), api.turns.asks('a1')])).toEqual([[], []])
    api.questions.answer('a1', 'r', {})
    expect(await api.questions.answerReviewed({} as never)).toBe(false)
    expect(api.transcripts.databaseHistory({} as never)).toBeUndefined()
    expect(api.external.sessions.list()).toEqual([])
    expect(await api.external.sessions.scan()).toEqual([])
    expect(api.external.open.known()).toEqual(new Map())
    expect(await api.external.open.fresh()).toEqual(new Map())
    api.clients.viewerChanged('a1')
    api.clients.dshInstallStatus({})
    api.clients.windows({ type: 'orchestrator_changed', payload: {} })
    expect(api.clients.observer('observer:x', 'observer_frame', {})).toBe(false)
    expect(ask).not.toHaveBeenCalled()
  })
})

describe('models in its own process, before it is ever connected', () => {
  it('asks the core nothing it cannot reach: a question before the first connection is refused', async () => {
    let start: CoreApi | null = null
    runModelsService({
      dataDir: '/data', socketPath: '/s', machineId: 'm', token: 't',
      run: () => ({ stop: vi.fn() }),
      start: (core, ports) => { start = core; ports.models = fakeModels().port; return {} },
      glances: () => [], onChanged: () => () => {},
    })
    await expect(start!.account.accessToken()).rejects.toThrow('not connected to the core')
  })

  it('runs the service, the pictures and the process link it was built with when a test does not swap them', async () => {
    const { runServiceProcess } = await import('./process.js')
    const { startModels } = await import('./models.js')
    runModelsService({ dataDir: '/data', socketPath: '/s', machineId: 'm', token: 't' })
    expect(startModels).toHaveBeenCalled()
    expect(runServiceProcess).toHaveBeenCalled()
  })

  it('asks the core what models needs over the connection it has', async () => {
    let start: CoreApi | null = null
    let options: ServiceProcessOptions | null = null
    runModelsService({
      dataDir: '/data', socketPath: '/s', machineId: 'm', token: 't',
      run: (given) => { options = given; return { stop: vi.fn() } },
      start: (core, ports) => { start = core; ports.models = fakeModels().port; return {} },
      glances: () => [], onChanged: () => () => {},
    })
    const core = connection()
    options!.onConnected!(core.core)
    await start!.account.privateGridName()
    expect(core.query).toHaveBeenCalledWith('account', {})
  })
})
