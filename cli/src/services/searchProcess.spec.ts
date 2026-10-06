import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runServiceProcess, type CoreConnection, type ServiceProcessOptions } from './process.js'
import { runSearchService, searchCoreApi } from './searchProcess.js'

// The real defaults would reach this machine's own conversations and a real socket: never in a test.
vi.mock('../lib/sessionSearch/externals/index.js', () => ({ externalProviders: () => [] }))
vi.mock('./process.js', () => ({ runServiceProcess: vi.fn(() => ({ stop: vi.fn() })) }))

const SESSION = '0b0c1d2e-3f40-4a5b-8c6d-7e8f90a1b2c3'

const ASKER = { local: false, owner: true }

describe('search in its own process', () => {
  const dirs: string[] = []
  const services: Array<{ stop(): void }> = []
  afterEach(() => {
    for (const service of services.splice(0)) service.stop()
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  const setup = (over: Partial<Parameters<typeof runSearchService>[0]> = {}) => {
    const dataDir = mkdtempSync(join(tmpdir(), 'search-process-'))
    dirs.push(dataDir)
    let options: ServiceProcessOptions | null = null
    const stop = vi.fn()
    const service = runSearchService({
      dataDir, socketPath: '/data/daemon-1.sock', machineId: 'm', token: 't', providers: [],
      run: (given) => { options = given; return { stop } },
      ...over,
    })
    services.push(service)
    return { dataDir, options: options!, stop, service }
  }
  /** A Claude Code conversation on disk, and its agent as the core describes it. */
  const conversation = (dataDir: string, words: string) => {
    const folder = join(dataDir, 'claude')
    mkdirSync(folder, { recursive: true })
    const transcriptPath = join(folder, `${SESSION}.jsonl`)
    const at = new Date().toISOString()
    writeFileSync(transcriptPath, [
      { type: 'user', uuid: 'u1', timestamp: at, sessionId: SESSION, message: { role: 'user', content: words } },
      { type: 'assistant', uuid: 'a1', timestamp: at, sessionId: SESSION, message: { role: 'assistant', content: [{ type: 'text', text: `about ${words}` }] } },
    ].map((line) => JSON.stringify(line)).join('\n') + '\n')
    return {
      schemaVersion: 2, active: true, agentId: 'agent-1', sessionId: SESSION, engine: 'claude', transcriptPath, cwd: dataDir,
      title: 'a chat', registeredAt: 1, boundAt: 1, lastTranscriptAt: Date.now(), lastHookAt: 0, runtimes: [], displayName: 'My agent',
    }
  }
  const core = (agents: unknown[]): CoreConnection => ({ query: vi.fn(async () => ({ agents })) })

  it('indexes what the core\'s agents said once told of a turn, finds it, and forgets it when purged', async () => {
    const { dataDir, options } = setup()
    const agent = conversation(dataDir, 'a zebrafish named Ines')
    // Told of a turn before it is connected: indexed once it knows the agents.
    options.onEvent!({ kind: 'touch', sessionId: SESSION })
    options.onConnected!(core([agent]))
    options.onEvent!({ kind: 'touch', sessionId: SESSION })
    await vi.waitFor(async () => {
      expect(JSON.stringify(await options.requests.session_search({ query: 'zebrafish' }, ASKER))).toContain(SESSION)
    }, { timeout: 15_000, interval: 250 })
    const tail = await options.requests.session_tail({ sessionId: SESSION, beforeTurn: 5, maxChars: 2_000 }, ASKER)
    expect(tail.error).toBeUndefined()
    // Something it is told that it does not act on changes nothing.
    options.onEvent!({ kind: 'renamed', sessionId: SESSION })
    expect(JSON.stringify(await options.requests.session_search({ query: 'zebrafish' }, ASKER))).toContain(SESSION)
    options.onEvent!({ kind: 'deleteHistory', sessionId: SESSION })
    expect(JSON.stringify(await options.requests.session_search({ query: 'zebrafish', limit: 5 }, ASKER))).not.toContain(SESSION)
  })

  it('answers what it cannot serve the way the core does', async () => {
    const { options } = setup()
    expect(await options.requests.session_tail({}, ASKER)).toEqual({ error: 'BAD_SESSION' })
    expect(await options.requests.session_tail({ sessionId: 'never-indexed' }, ASKER)).toEqual({ error: 'NOT_INDEXED', sessionId: 'never-indexed' })
    expect((await options.requests.session_search({ query: 7, limit: 'x', from: Number.NaN }, ASKER)).error).toBeUndefined()
    // An event naming no session is nothing to act on.
    options.onEvent!({ kind: 'touch' })
  })

  it('keeps the agents it knew when the core cannot answer for them', async () => {
    const { dataDir, options } = setup()
    const agent = conversation(dataDir, 'a heron')
    options.onConnected!(core([agent]))
    options.onConnected!({ query: vi.fn(async () => { throw new Error('the core went away') }) })
    options.onConnected!({ query: vi.fn(async () => ({ error: 'UNKNOWN_QUERY' })) })
    options.onEvent!({ kind: 'touch', sessionId: SESSION })
    await vi.waitFor(async () => {
      expect(JSON.stringify(await options.requests.session_search({ query: 'heron' }, ASKER))).toContain(SESSION)
    }, { timeout: 15_000, interval: 250 })
  })

  it('without an index (no node:sqlite) says search is off, as the core would', async () => {
    const { options } = setup({ start: () => {} })
    const off = { error: 'SERVICE_UNAVAILABLE', service: 'search', retryable: false }
    expect(await options.requests.session_search({ query: 'anything' }, ASKER)).toEqual(off)
    expect(await options.requests.session_tail({ sessionId: SESSION }, ASKER)).toEqual(off)
    options.onEvent!({ kind: 'touch', sessionId: SESSION })
  })

  it('stops its process and its index together', () => {
    const { stop, service } = setup()
    service.stop()
    expect(stop).toHaveBeenCalledOnce()
    const unindexed = setup({ start: () => {} })
    unindexed.service.stop()
    expect(unindexed.stop).toHaveBeenCalledOnce()
  })

  it('runs on a core API of the agents the core last named, answering what search never asks as nothing', async () => {
    const live = { agentId: 'live', active: true, displayName: 'Live one' }
    const stopped = { agentId: 'stopped', active: false }
    const api = searchCoreApi('/data', () => [live, stopped] as never, [])
    expect(api.dataDir).toBe('/data')
    expect(api.agents.all()).toEqual([live, stopped])
    expect(api.agents.live()).toEqual([live])
    expect(api.agents.byAgent('stopped')).toBe(stopped)
    expect(api.agents.resolve('stopped')).toBe(stopped)
    expect(api.agents.displayName(live as never)).toBe('Live one')
    expect(api.agents.displayName(stopped as never)).toBe('')
    expect(api.agents.advertised()).toEqual([])
    expect(api.agents.terminalAvailable('live')).toBe(false)
    api.agents.sync(live as never)
    await expect(api.agents.runtimeModels('live')).resolves.toEqual([])
    expect(api.agents.runtimeProfile(live as never)).toBeNull()
    api.agents.setRuntime('live', 'opus')
    await expect(api.agents.fork('live')).resolves.toEqual({ ok: false, error: 'UNSUPPORTED' })
    api.turns.send('live', 'text')
    api.turns.stop('live')
    expect(await api.turns.recent('live', 3)).toEqual([])
    expect(await api.turns.asks('live')).toEqual([])
    api.questions.answer('live', 'q', {})
    await expect(api.questions.answerReviewed({} as never)).resolves.toBe(false)
    expect(api.transcripts.databaseHistory({ engine: 'claude' } as never)).toBeUndefined()
    expect(api.external.sessions.list()).toEqual([])
    await expect(api.account.mintGridName()).resolves.toBeNull()
    await expect(api.account.accessToken()).rejects.toThrow('search holds no credential')
    await expect(api.account.privateGridName()).resolves.toBeNull()
    expect(api.account.machineName()).toBeNull()
    api.clients.viewerChanged('live')
    api.clients.gridNamed('grid')
    api.clients.gridModelsChanged()
    api.clients.dshInstallStatus({ phase: 'clone' })
    api.clients.windows({ type: 'orchestrator_changed', payload: {} })
    expect(api.clients.observer('observer:x', 'observer_frame', {})).toBe(false)
  })

  it('runs as a real service process, over the conversations this machine has, by default', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'search-process-'))
    dirs.push(dataDir)
    const service = runSearchService({ dataDir, socketPath: '/data/daemon-1.sock', machineId: 'm', token: 't' })
    services.push(service)
    expect(runServiceProcess).toHaveBeenCalledWith(expect.objectContaining({ name: 'search', socketPath: '/data/daemon-1.sock' }))
  })

  it('reaches the core as `search`, through the socket and token it was given', () => {
    const { options } = setup()
    expect(options).toMatchObject({ name: 'search', socketPath: '/data/daemon-1.sock', machineId: 'm', token: 't' })
    expect(Object.keys(options.requests).sort()).toEqual(['session_search', 'session_tail'])
  })
})
