import { afterEach, describe, expect, it, vi } from 'vitest'
import { STORE_REQUESTS, type CoreApi } from '../core/api.js'
import { runServiceProcess, type CoreConnection, type ServiceProcessOptions } from './process.js'
import { runStoreService } from './storeProcess.js'
import * as launchModule from './storeLaunch.js'
import { storeLaunchContext } from './storeContext.js'

// The real default reaches a real socket and clones real repositories: never in a test.
vi.mock('./process.js', () => ({ runServiceProcess: vi.fn(() => ({ stop: vi.fn() })) }))
vi.mock('./storeContext.js', () => ({ storeLaunchContext: vi.fn(async () => ({ privateGrid: 'selected' })) }))

const ASKER = { local: true, owner: true }

describe('the Store in its own process', () => {
  afterEach(() => vi.clearAllMocks())

  const setup = () => {
    let options: ServiceProcessOptions | null = null
    let api: CoreApi | null = null
    /** What the core heard, in order: the install's progress, that the index changed, and the answer. */
    const heard: string[] = []
    const answers = {
      dsh_list: vi.fn(async () => { heard.push('listed'); return { dsh: [] } }),
      dsh_install: vi.fn(async () => {
        api!.clients.dshInstallStatus({ id: 'acme/thing', phase: 'clone' })
        heard.push('installed')
        return { ok: true, id: 'acme/thing' }
      }),
      dsh_update: vi.fn(async () => { heard.push('updated'); return { ok: true, id: 'acme/thing' } }),
      dsh_remove: vi.fn(() => { heard.push('removed'); return { ok: true, id: 'acme/thing' } }),
    }
    const service = { stop: vi.fn() }
    const handle = runStoreService({
      dataDir: '/data', socketPath: '/data/daemon-1.sock', machineId: 'm', token: 't',
      prepare: Object.assign(() => true, { ready: () => true, invalidate: () => {} }),
      run: (given) => { options = given; return service },
      start: (core) => { api = core; return answers },
    })
    const query = vi.fn(async (name: string, payload?: Record<string, unknown>) => { heard.push(`told ${name}${payload?.status ? ` ${JSON.stringify(payload.status)}` : ''}`); return {} })
    const connect = () => options!.onConnected!({ query } satisfies CoreConnection)
    return { options: options!, api: api!, heard, query, connect, handle, service }
  }

  it('reaches the core as `store`, answering its four requests, holding no credential', async () => {
    const { options, api, handle, service } = setup()
    handle.stop()
    expect(service.stop).toHaveBeenCalledOnce()
    expect(options).toMatchObject({ name: 'store', socketPath: '/data/daemon-1.sock', machineId: 'm', token: 't' })
    expect(Object.keys(options.requests).sort()).toEqual([...STORE_REQUESTS, 'dshDescribe', 'dshContext', 'dshMaterialize', 'dshLaunch'].sort())
    await expect(api.account.accessToken()).rejects.toThrow('store holds no credential')
  })

  it('tells the core how an install goes, and that what is installed changed before it answers', async () => {
    const { options, heard, connect } = setup()
    connect()
    expect(await options.requests.dsh_install!({ id: 'acme/thing' }, ASKER)).toEqual({ ok: true, id: 'acme/thing' })
    await options.requests.dsh_update!({ id: 'acme/thing' }, ASKER)
    await options.requests.dsh_remove!({ id: 'acme/thing' }, ASKER)
    // A list changes nothing: the core is not told.
    await options.requests.dsh_list!({}, ASKER)
    expect(heard).toEqual([
      'told prepared',
      'told installStatus {"id":"acme/thing","phase":"clone"}', 'installed', 'told installed',
      'updated', 'told installed', 'removed', 'told installed', 'listed',
    ])
  })

  it('answers all the same with no core to tell, or one that cannot hear', async () => {
    const { options, heard, query, connect } = setup()
    expect(await options.requests.dsh_install!({ id: 'acme/thing' }, ASKER)).toEqual({ ok: true, id: 'acme/thing' })
    query.mockRejectedValue(new Error('the core went away'))
    connect()
    expect(await options.requests.dsh_install!({ id: 'acme/thing' }, ASKER)).toEqual({ ok: true, id: 'acme/thing' })
    await Promise.resolve()
    expect(heard).toEqual(['installed', 'installed'])
  })

  it('runs as a real service by default, on the Store\'s own requests', () => {
    runStoreService({ dataDir: '/data', socketPath: '/data/daemon-1.sock', machineId: 'm', token: 't' })
    const options = vi.mocked(runServiceProcess).mock.calls.at(-1)![0]
    expect(options.name).toBe('store')
    expect(Object.keys(options.requests).sort()).toEqual([...STORE_REQUESTS, 'dshDescribe', 'dshContext', 'dshMaterialize', 'dshLaunch'].sort())
  })
})

describe('the Store launch port on its process wire', () => {
  const request = { dsh: 'test/draw', workspace: '/workspace', engine: 'claude', key: 'agent', account: {} }
  const setup = () => {
    const launch = { stop: vi.fn(), dshContext: vi.fn(async () => ({ ok: true as const, account: { privateGrid: null } })), dshDescribe: vi.fn(async () => ({ ok: true as const, id: 'test/draw', name: 'Draw', permissionMode: null, refusal: null })), dshMaterialize: vi.fn(async () => ({ ok: true as const, created: [], kept: [], warnings: [] })),
      dshLaunch: vi.fn(async () => ({ ok: true as const, launch: { env: {}, args: [] } })) }
    runStoreService({ dataDir: '/data', socketPath: '/socket', machineId: 'm', token: 't', start: () => ({}), launch,
      prepare: Object.assign(() => true, { ready: () => true, invalidate: () => {} }) })
    return { launch, requests: vi.mocked(runServiceProcess).mock.calls.at(-1)![0].requests }
  }
  it('checks context, private grid and fork identity, and strips unrelated data', async () => {
    const { launch, requests } = setup()
    expect(await requests.dshDescribe!({ dsh: request.dsh, engine: 'claude', manifest: {} }, ASKER)).toMatchObject({ ok: true, id: request.dsh })
    expect(launch.dshDescribe).toHaveBeenCalledWith({ dsh: request.dsh, engine: 'claude' })
    expect(await requests.dshContext!({ dsh: request.dsh, engine: 'claude', privateGrid: 'untrusted' }, ASKER)).toEqual({ ok: true, account: { privateGrid: null } })
    expect(launch.dshContext).toHaveBeenCalledWith({ dsh: request.dsh, engine: 'claude' })
    for (const payload of [{}, { dsh: 'invalid', engine: 'claude' }, { dsh: request.dsh, engine: 'unknown' }]) {
      expect(await requests.dshDescribe!(payload, ASKER)).toMatchObject({ error: 'INVALID_DSH' })
      expect(await requests.dshContext!(payload, ASKER)).toMatchObject({ error: 'INVALID_DSH' })
    }
    for (const account of [{}, { privateGrid: null }, { privateGrid: '' }, { privateGrid: 'private' }]) {
      expect(await requests.dshMaterialize!({ ...request, account, secret: 'not forwarded' }, ASKER)).toMatchObject({ ok: true })
      expect(launch.dshMaterialize).toHaveBeenLastCalledWith({ dsh: request.dsh, workspace: request.workspace, key: request.key, engine: request.engine, account })
    }
    for (const forkOf of [undefined, { agentId: 'source', dshRuntime: null }, { agentId: 'source', dshRuntime: 'runtime' }]) {
      expect(await requests.dshLaunch!({ ...request, forkOf }, ASKER)).toMatchObject({ ok: true })
      expect(launch.dshLaunch).toHaveBeenLastCalledWith({ ...request, ...(forkOf ? { forkOf } : {}) })
    }
  })
  it('reports readiness only after partial startup has recovered on a real description request', async () => {
    let ready = false
    const { launch } = setup()
    const facts = { ok: true as const, id: request.dsh, name: 'Draw', permissionMode: null, refusal: null }
    launch.dshDescribe.mockImplementation(async () => { ready = true; return facts })
    runStoreService({ dataDir: '/data', socketPath: '/socket', machineId: 'm', token: 't', start: () => ({}), launch,
      prepare: Object.assign(() => ready, { ready: () => ready, invalidate: () => {} }) })
    const options = vi.mocked(runServiceProcess).mock.calls.at(-1)![0]
    const query = vi.fn(async () => ({}))
    options.onConnected!({ query })
    expect(query).not.toHaveBeenCalled()
    expect(await options.requests.dshDescribe!(request, ASKER)).toEqual(facts)
    expect(query).toHaveBeenCalledWith('prepared')
    query.mockRejectedValueOnce(Error('core left'))
    expect(await options.requests.dshDescribe!(request, ASKER)).toEqual(facts)
    await Promise.resolve()
  })
  it('keeps a package unavailable without announcing readiness while bundled preparation is incomplete', async () => {
    const { launch } = setup()
    const unavailable = { ok: false as const, error: 'DSH_UNAVAILABLE', unavailable: 'store' as const, detail: 'Bundled preparation is incomplete' }
    launch.dshDescribe.mockResolvedValueOnce(unavailable as never)
    runStoreService({ dataDir: '/data', socketPath: '/socket', machineId: 'm', token: 't', start: () => ({}), launch,
      prepare: Object.assign(() => false, { ready: () => false, invalidate: () => {} }) })
    const options = vi.mocked(runServiceProcess).mock.calls.at(-1)![0]
    const query = vi.fn(async () => ({}))
    options.onConnected!({ query })
    expect(await options.requests.dshDescribe!(request, ASKER)).toEqual(unavailable)
    expect(query).not.toHaveBeenCalled()
  })
  it('rejects malformed requests before package work starts', async () => {
    const { launch, requests } = setup()
    const bad = [{ dsh: '' }, { dsh: 1 }, { workspace: null }, { engine: 'terminal' }, { engine: 'unknown' },
      { account: null }, { account: [] }, { account: { privateGrid: 42 } }]
    for (const over of bad) {
      expect(await requests.dshMaterialize!({ ...request, ...over }, ASKER)).toMatchObject({ error: 'INVALID_DSH' })
      expect(await requests.dshLaunch!({ ...request, ...over }, ASKER)).toMatchObject({ error: 'INVALID_DSH' })
    }
    for (const over of [{ key: '' }, { forkOf: null }, { forkOf: [] }, { forkOf: { agentId: '' } },
      { forkOf: { agentId: 'source' } }, { forkOf: { agentId: 'source', dshRuntime: 3 } }]) {
      expect(await requests.dshLaunch!({ ...request, ...over }, ASKER)).toMatchObject({ error: 'INVALID_DSH' })
    }
    expect(launch.dshMaterialize).not.toHaveBeenCalled()
    expect(launch.dshLaunch).not.toHaveBeenCalled()
  })
  it('notifies held launches after a completed preparation and tolerates the core going away', async () => {
    const { launch, requests } = setup()
    const options = vi.mocked(runServiceProcess).mock.calls.at(-1)![0]
    const query = vi.fn(async () => ({}))
    options.onConnected!({ query })
    query.mockClear()
    await requests.dshMaterialize!(request, ASKER)
    await requests.dshLaunch!(request, ASKER)
    expect(query.mock.calls).toEqual([['prepared'], ['prepared']])
    query.mockRejectedValue(new Error('core gone'))
    await requests.dshMaterialize!(request, ASKER)
    await requests.dshLaunch!(request, ASKER)
    launch.dshMaterialize.mockResolvedValueOnce({ ok: false, error: 'DSH_UNAVAILABLE', unavailable: 'store', detail: 'unconfirmed' } as never)
    launch.dshLaunch.mockResolvedValueOnce({ ok: false, error: 'DSH_UNAVAILABLE', unavailable: 'store', detail: 'unconfirmed' } as never)
    await requests.dshMaterialize!(request, ASKER)
    await requests.dshLaunch!(request, ASKER)
    expect(query).toHaveBeenCalledTimes(4)
    query.mockResolvedValue({})
    launch.dshMaterialize.mockResolvedValueOnce({ ok: false, error: 'DSH_MATERIALIZE_FAILED', detail: 'init failed' } as never)
    launch.dshLaunch.mockResolvedValueOnce({ ok: false, error: 'DSH_RUNTIME_FAILED', detail: 'runtime failed' } as never)
    await requests.dshMaterialize!(request, ASKER)
    await requests.dshLaunch!(request, ASKER)
    expect(query).toHaveBeenCalledTimes(6)
  })

})

describe('Store context follows the physical core connection', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks() })
  const address = { command: 'harness', port: 18473, machineId: 'm' }
  const request = { dsh: 'test/draw', engine: 'claude' }
  function setup() {
    const original = launchModule.storeLaunchPort
    vi.spyOn(launchModule, 'storeLaunchPort').mockImplementation((_lookup, run, prepare, context) =>
      original(() => ({ id: 'test/draw' }) as never, run, prepare, context))
    const service = { stop: vi.fn() }
    const handle = runStoreService({ dataDir: '/data', socketPath: '/socket', machineId: 'm', token: 't',
      start: () => ({}), prepare: Object.assign(() => true, { ready: () => false, invalidate: () => {} }),
      run: options => { vi.mocked(runServiceProcess)(options); return service } })
    return { handle, service, options: vi.mocked(runServiceProcess).mock.calls.at(-1)![0] }
  }
  it('uses the address from this connection and aborts its context on replacement, disconnect and stop', async () => {
    const run = setup(), query = vi.fn(async () => address)
    await expect(run.options.requests.dshContext!(request, ASKER)).rejects.toThrow('connection unavailable')
    run.options.onConnected!({ query })
    expect(await run.options.requests.dshContext!(request, ASKER)).toEqual({ ok: true, account: { privateGrid: 'selected' } })
    const first = vi.mocked(storeLaunchContext).mock.calls.at(-1)!
    expect(first[0]).toEqual({ dataDir: '/data', port: 18473, machineId: 'm' })
    query.mockResolvedValueOnce({ gridName: 'backend' } as never)
    expect(await first[5]!()).toBe('backend')
    expect(query).toHaveBeenLastCalledWith('account')
    expect(first[1]).toBe(false); expect(first[2]()).toBe(true); expect(first[3].aborted).toBe(false)
    run.options.onConnected!({ query })
    expect(first[2]()).toBe(false); expect(first[3].aborted).toBe(true)
    await run.options.requests.dshContext!(request, ASKER)
    const second = vi.mocked(storeLaunchContext).mock.calls.at(-1)!
    run.options.onDisconnected!()
    expect(second[2]()).toBe(false); expect(second[3].aborted).toBe(true)
    run.options.onConnected!({ query }); await run.options.requests.dshContext!(request, ASKER)
    const third = vi.mocked(storeLaunchContext).mock.calls.at(-1)!
    run.handle.stop(); expect(third[2]()).toBe(false); expect(third[3].aborted).toBe(true)
    expect(run.service.stop).toHaveBeenCalledOnce()
  })
  it.each(['invalid', 'machine', 'replaced', 'disconnected', 'stopped'] as const)('refuses %s address before opening a context socket', async reason => {
    const run = setup()
    let answer!: (value: Record<string, unknown>) => void
    const query = vi.fn(() => new Promise<Record<string, unknown>>(resolve => { answer = resolve }))
    run.options.onConnected!({ query })
    const pending = run.options.requests.dshContext!(request, ASKER)
    const rejected = expect(pending).rejects.toThrow('connection changed')
    if (reason === 'replaced') run.options.onConnected!({ query: async () => address })
    if (reason === 'disconnected') run.options.onDisconnected!()
    if (reason === 'stopped') run.handle.stop()
    answer(reason === 'invalid' ? {} : { ...address, machineId: reason === 'machine' ? 'other' : 'm' })
    await rejected; expect(storeLaunchContext).not.toHaveBeenCalled()
    run.handle.stop()
  })
})
