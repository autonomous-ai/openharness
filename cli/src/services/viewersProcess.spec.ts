import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CoreApi, CorePorts, ViewersPort } from '../core/api.js'
import type { AgentDshContext } from '../lib/agentFrame.js'
import type { RegisteredSession } from '../lib/registry.js'
import { runServiceProcess, type CoreConnection, type ServiceProcessOptions } from './process.js'
import { runViewersService, viewersCoreApi } from './viewersProcess.js'

// The real default reaches a real socket and this process's own channel: never in a test.
vi.mock('./process.js', () => ({ runServiceProcess: vi.fn(() => ({ stop: vi.fn() })) }))

const agent = (agentId = 'a1', over: Partial<RegisteredSession> = {}) =>
  ({ agentId, sessionId: `s-${agentId}`, engine: 'claude', dsh: 'acme/blender', cwd: `/work/${agentId}`, ...over }) as RegisteredSession

/** Viewers that start nothing: what each agent's frame says is whatever the test sets. */
function fakeViewers() {
  const contexts = new Map<string, AgentDshContext>()
  const urls = new Map<string, string>()
  const port = {
    attach: vi.fn(),
    detach: vi.fn(),
    frameContext: vi.fn((session: RegisteredSession) => contexts.get(session.agentId) ?? null),
    forwardingUrl: vi.fn((agentId: string) => urls.get(agentId) ?? null),
    stop: vi.fn(async () => {}),
    stream: vi.fn((_connId: string, _type: string, _payload: Record<string, unknown>) => true),
    surface: vi.fn(async (_connId: string, payload: Record<string, unknown>) => ({ data: 'jpeg', asked: payload })),
    closed: vi.fn((_connId?: string) => {}),
  } satisfies ViewersPort
  return { port, contexts, urls }
}

/** A connection to the core that records what it is told and answers `agents` with `listed`. */
function connection(listed: unknown = { agents: [] }) {
  const query = vi.fn(async (name: string, _payload?: Record<string, unknown>) => (name === 'agents' ? listed : { kept: true }) as Record<string, unknown>)
  const told = () => query.mock.calls.filter(([name]) => name === 'context').map(([, payload]) => payload)
  return { core: { query } satisfies CoreConnection, query, told }
}

const flush = () => new Promise((done) => setTimeout(done, 0))

describe('the viewers in their own process', () => {
  afterEach(() => vi.clearAllMocks())

  const setup = (over: Partial<Parameters<typeof runViewersService>[0]> = {}) => {
    const viewers = fakeViewers()
    let api: CoreApi | null = null
    let options: ServiceProcessOptions | null = null
    const service = { stop: vi.fn() }
    const handle = runViewersService({
      dataDir: '/data', socketPath: '/data/daemon-1.sock', machineId: 'm', token: 't',
      run: (given) => { options = given; return service },
      start: (core: CoreApi, ports: CorePorts) => { api = core; ports.viewers = viewers.port },
      ...over,
    })
    return { viewers, api: api!, options: options!, service, handle }
  }

  it('reaches the core as `viewers`, through the socket and token it was given, and answers the apps nothing', () => {
    const { options } = setup()
    expect(options).toMatchObject({ name: 'viewers', socketPath: '/data/daemon-1.sock', machineId: 'm', token: 't' })
    // Only the core's own question, which no client's request is routed as (core/viewersLink.ts).
    expect(Object.keys(options.requests)).toEqual(['surface'])
  })

  it('serves a client\'s viewer stream through the core: its frames in, its answers out to that connection', async () => {
    const { viewers, api, options } = setup()
    // Not connected: an answer has nowhere to go, and the stream ends rather than waiting.
    expect(api.clients.viewerFrame('c1', 'viewer_response', { streamId: 's1' })).toBe(false)
    const notice = vi.fn()
    options.onConnected!({ ...connection().core, notice })
    options.onEvent!({ kind: 'stream', connId: 'c1', type: 'viewer_request', frame: { streamId: 's1', path: '/' } })
    expect(viewers.port.stream).toHaveBeenCalledWith('c1', 'viewer_request', { streamId: 's1', path: '/' })
    options.onEvent!({ kind: 'stream', connId: 'c1', type: 'viewer_end' })
    expect(viewers.port.stream).toHaveBeenLastCalledWith('c1', 'viewer_end', {})
    expect(api.clients.viewerFrame('c1', 'viewer_response', { streamId: 's1', status: 200 })).toBe(true)
    expect(notice).toHaveBeenCalledWith('viewer', { connId: 'c1', type: 'viewer_response', payload: { streamId: 's1', status: 200 } })
    // A rendered frame, for the connection the core says asked; the connection is not the surface's to read.
    await expect(options.requests.surface({ connId: 'c1', surfaceId: 'v', op: 'frame' }, { local: true, owner: true }))
      .resolves.toEqual({ data: 'jpeg', asked: { surfaceId: 'v', op: 'frame' } })
    expect(viewers.port.surface).toHaveBeenCalledWith('c1', { surfaceId: 'v', op: 'frame' })
    // A connection gone, then every one: the link went down.
    options.onEvent!({ kind: 'closed', connId: 'c1' })
    options.onEvent!({ kind: 'closed' })
    expect(viewers.port.closed.mock.calls).toEqual([['c1'], [undefined]])
    // What is not a stream's frame is not passed on.
    options.onEvent!({ kind: 'stream', connId: 7, type: 'viewer_data' })
    options.onEvent!({ kind: 'stream', connId: 'c1' })
    expect(viewers.port.stream).toHaveBeenCalledTimes(2)
  })

  it('ends every stream and surface when the core goes: their connections were that core\'s', () => {
    const { viewers, api, options } = setup()
    const notice = vi.fn()
    options.onConnected!({ ...connection().core, notice })
    options.onDisconnected!()
    expect(viewers.port.closed).toHaveBeenCalledWith()
    expect(api.clients.viewerFrame('c1', 'viewer_data', { streamId: 's1' })).toBe(false)
    expect(notice).not.toHaveBeenCalled()
  })

  it('cannot answer a stream over a connection with no way to say it', () => {
    const { api, options } = setup()
    options.onConnected!(connection().core)
    expect(api.clients.viewerFrame('c1', 'viewer_data', { streamId: 's1' })).toBe(false)
  })

  it('attaches what the core attaches, tells the core what the agent\'s frame says, and detaches what it detaches', async () => {
    const { viewers, api, options } = setup()
    const core = connection()
    options.onConnected!(core.core)
    await flush()
    viewers.contexts.set('a1', { id: 'acme/blender', name: 'Blender', viewerUrl: null, viewerName: 'Blender Viewer', verdict: null })
    options.onEvent!({ kind: 'attach', session: agent() })
    expect(viewers.port.attach).toHaveBeenCalledWith(agent())
    expect(api.agents.byAgent('a1')).toEqual(agent())
    expect(api.agents.resolve('a1')).toEqual(agent())
    expect(core.told()).toEqual([{ agentId: 'a1', context: viewers.contexts.get('a1'), forwardingUrl: null }])
    options.onEvent!({ kind: 'detach', agentId: 'a1' })
    expect(viewers.port.detach).toHaveBeenCalledWith('a1')
    expect(api.agents.byAgent('a1')).toBeUndefined()
    // What a stopping viewer says after its detach is not the core's to hear.
    api.clients.viewerChanged('a1')
    expect(core.told()).toHaveLength(1)
  })

  it('tells the core each change once, where the service would move the viewer panes or push a frame', async () => {
    const { viewers, api, options } = setup()
    const core = connection()
    options.onConnected!(core.core)
    options.onEvent!({ kind: 'attach', session: agent() })
    // A viewer came up: its URL, and where the windows' pane forwards.
    viewers.contexts.set('a1', { id: 'acme/blender', name: 'Blender', viewerUrl: 'http://127.0.0.1:7001/', verdict: null })
    viewers.urls.set('a1', 'http://127.0.0.1:7001/')
    api.clients.viewerChanged('a1')
    api.agents.sync(agent())
    expect(core.told()).toEqual([
      { agentId: 'a1', context: null, forwardingUrl: null },
      { agentId: 'a1', context: viewers.contexts.get('a1'), forwardingUrl: 'http://127.0.0.1:7001/' },
    ])
    // A verdict: the frame changes, and the core hears it.
    viewers.contexts.set('a1', { ...viewers.contexts.get('a1')!, verdict: { ready: true, summary: null, errors: 0, warnings: 0, artifact: null, phases: [], updatedAt: null } })
    api.agents.sync(agent())
    expect(core.told()).toHaveLength(3)
    // Said again on every attach, changed or not: a core that restarted keeps nothing until it attaches.
    options.onEvent!({ kind: 'attach', session: agent() })
    expect(core.told()).toHaveLength(4)
  })

  it('says nothing before it is connected, then everything the core lists once it has caught up', async () => {
    const { viewers, options } = setup()
    viewers.contexts.set('a1', { id: 'acme/blender', name: 'Blender', viewerUrl: null, verdict: null })
    options.onEvent!({ kind: 'attach', session: agent() })
    expect(viewers.port.attach).toHaveBeenCalledOnce()
    const core = connection({ agents: [agent()] })
    options.onConnected!(core.core)
    expect(core.told()).toEqual([])
    await flush()
    expect(core.told()).toEqual([{ agentId: 'a1', context: viewers.contexts.get('a1'), forwardingUrl: null }])
  })

  it('catches up with the core\'s agents on every connection: attaches what is missing, detaches what is gone', async () => {
    const { viewers, api, options } = setup()
    options.onEvent!({ kind: 'attach', session: agent('gone') })
    options.onEvent!({ kind: 'attach', session: agent('kept') })
    const core = connection({ agents: [agent('kept'), agent('new'), { not: 'an agent' }, null] })
    options.onConnected!(core.core)
    await flush()
    expect(viewers.port.attach).toHaveBeenCalledWith(agent('new'))
    expect(viewers.port.detach).toHaveBeenCalledWith('gone')
    expect(viewers.port.detach).toHaveBeenCalledTimes(1)
    expect(api.agents.all().map((session) => session.agentId).sort()).toEqual(['kept', 'new'])
    expect(api.agents.live()).toHaveLength(2)
  })

  it('leaves an agent heard of since it asked: news newer than the core\'s answer', async () => {
    const { viewers, api, options } = setup()
    options.onEvent!({ kind: 'attach', session: agent('a1') })
    let answer: (value: Record<string, unknown>) => void = () => {}
    const query = vi.fn((name: string) => (name === 'agents' ? new Promise<Record<string, unknown>>((done) => { answer = done }) : Promise.resolve({ kept: true })))
    options.onConnected!({ query })
    // While the question is out: a new agent attached, an old one detached.
    options.onEvent!({ kind: 'attach', session: agent('a4') })
    options.onEvent!({ kind: 'detach', agentId: 'a1' })
    answer({ agents: [agent('a1')] })
    await flush()
    expect(api.agents.all().map((session) => session.agentId)).toEqual(['a4'])
    // Attached once, before the question: the answer naming it did not bring it back.
    expect(viewers.port.attach.mock.calls.filter(([session]) => session.agentId === 'a1')).toHaveLength(1)
  })

  it('ignores an older connection\'s answer, an answer that names no agents, and a core that cannot answer', async () => {
    const { viewers, options } = setup()
    let answer: (value: Record<string, unknown>) => void = () => {}
    const older = vi.fn((name: string) => (name === 'agents' ? new Promise<Record<string, unknown>>((done) => { answer = done }) : Promise.resolve({})))
    options.onConnected!({ query: older })
    options.onConnected!(connection({ error: 'UNKNOWN_QUERY' }).core)
    answer({ agents: [agent('late')] })
    await flush()
    options.onConnected!({ query: vi.fn(async () => { throw new Error('the core went away') }) })
    await flush()
    expect(viewers.port.attach).not.toHaveBeenCalled()
  })

  it('a word lost with its connection is said again on the next one', async () => {
    const { viewers, options } = setup()
    const lost = vi.fn(async (name: string) => {
      if (name === 'context') throw new Error('the core went away')
      return { agents: [agent()] }
    })
    viewers.contexts.set('a1', { id: 'acme/blender', name: 'Blender', viewerUrl: 'http://127.0.0.1:7001/', verdict: null })
    options.onConnected!({ query: lost })
    options.onEvent!({ kind: 'attach', session: agent() })
    await flush()
    const core = connection({ agents: [agent()] })
    options.onConnected!(core.core)
    await flush()
    expect(core.told()).toEqual([{ agentId: 'a1', context: viewers.contexts.get('a1'), forwardingUrl: null }])
  })

  it('ignores what it is told that it does not act on', () => {
    const { viewers, options } = setup()
    options.onEvent!({ kind: 'touch', sessionId: 's1' })
    options.onEvent!({ kind: 'attach' })
    options.onEvent!({ kind: 'attach', session: { dsh: 'acme/blender' } })
    options.onEvent!({ kind: 'detach', agentId: 7 })
    expect(viewers.port.attach).not.toHaveBeenCalled()
    expect(viewers.port.detach).not.toHaveBeenCalled()
  })

  it('stops its viewer servers when its process stops it, and only once, however often asked', async () => {
    const { viewers, service, handle } = setup()
    const first = handle.stop()
    const second = handle.stop()
    await Promise.all([first, second])
    expect(service.stop).toHaveBeenCalledOnce()
    expect(viewers.port.stop).toHaveBeenCalledOnce()
  })

  it('says so when its viewers fail to stop: its process goes all the same (services/process.ts)', async () => {
    const viewers = fakeViewers()
    viewers.port.stop.mockRejectedValue(new Error('a watch would not close'))
    const { handle } = setup({ start: (_core, ports) => { ports.viewers = viewers.port } })
    await expect(handle.stop()).rejects.toThrow('a watch would not close')
  })

  it('does not run without viewers: the master starts it again, or parks it', () => {
    expect(() => setup({ start: () => {} })).toThrow('the viewers did not start')
  })

  it('runs on a core API of the agents the core attached, answering what the viewers never ask as nothing', async () => {
    const sessions = new Map([['a1', agent()]])
    const tell = vi.fn()
    const api = viewersCoreApi('/data', sessions, tell)
    expect(api.dataDir).toBe('/data')
    expect(api.agents.all()).toEqual([agent()])
    expect(api.agents.live()).toEqual([agent()])
    expect(api.agents.byAgent('a1')).toEqual(agent())
    expect(api.agents.displayName(agent())).toBe('')
    expect(api.agents.advertised()).toEqual([])
    // The core judges the terminal when it hears: here every change is worth telling.
    expect(api.agents.terminalAvailable('a1')).toBe(true)
    api.agents.sync(agent())
    api.clients.viewerChanged('a1')
    expect(tell.mock.calls).toEqual([['a1'], ['a1']])
    expect(api.transcripts.databaseHistory(agent())).toBeUndefined()
    expect(await api.transcripts.lastTurn('s1')).toBeNull()
    await expect(api.account.mintGridName()).resolves.toBeNull()
    await expect(api.account.accessToken()).rejects.toThrow('the viewers hold no credential')
    await expect(api.account.privateGridName()).resolves.toBeNull()
    expect(api.account.machineName()).toBeNull()
    await expect(api.agents.runtimeModels()).resolves.toEqual([])
    expect(api.agents.runtimeProfile(agent())).toBeNull()
    api.agents.setRuntime('a1', 'opus')
    await expect(api.agents.fork('a1')).resolves.toEqual({ ok: false, error: 'UNSUPPORTED' })
    api.turns.send('a1', 'text')
    api.turns.stop('a1')
    expect(await api.turns.recent('a1', 3)).toEqual([])
    expect(await api.turns.asks('a1')).toEqual([])
    api.questions.answer('a1', 'q', {})
    await expect(api.questions.answerReviewed({} as never)).resolves.toBe(false)
    api.clients.gridNamed('grid')
    api.clients.gridModelsChanged()
    api.clients.dshInstallStatus({ phase: 'clone' })
    api.clients.windows({ type: 'orchestrator_changed', payload: {} })
    expect(api.clients.observer('observer:x', 'observer_frame', {})).toBe(false)
    // Built on its own, it reaches no client.
    expect(api.clients.viewerFrame('c1', 'viewer_data', {})).toBe(false)
    api.clients.turnCard({ type: 'commander_event', agentId: 'a', dbSessionId: 's', payload: {} })
    api.clients.turnSummary({ type: 'turn_summary' })
  })

  it('runs as a real service by default: its viewers, on its own link to the core', async () => {
    const handle = runViewersService({ dataDir: '/data', socketPath: '/data/daemon-1.sock', machineId: 'm', token: 't' })
    expect(runServiceProcess).toHaveBeenCalledWith(expect.objectContaining({ name: 'viewers', socketPath: '/data/daemon-1.sock' }))
    await handle.stop()
  })
})
