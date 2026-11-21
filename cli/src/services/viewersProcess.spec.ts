import type { ViewersRuntime, ViewersRuntimeSlot } from './viewers.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentLife, CoreApi, CorePorts } from '../core/api.js'
import type { RegisteredSession } from '../lib/registry.js'
import { runServiceProcess, type CoreConnection, type ServiceProcessOptions } from './process.js'
import { runViewersService, viewersCoreApi } from './viewersProcess.js'

// The real default reaches a real socket and this process's own channel: never in a test.
vi.mock('./process.js', () => ({ runServiceProcess: vi.fn(() => ({ stop: vi.fn() })) }))

const agent = (agentId = 'a1', over: Partial<RegisteredSession> = {}) =>
  ({ agentId, sessionId: `s-${agentId}`, engine: 'claude', dsh: 'acme/blender', cwd: `/work/${agentId}`, ...over }) as RegisteredSession

/** Viewers that start nothing: their forwarding targets are controlled here, and lifecycle events recorded. */
function fakeViewers() {
  const urls = new Map<string, string>()
  const attach = vi.fn((_session: RegisteredSession) => {})
  const detach = vi.fn((_agentId: string) => {})
  const port = {
    forwardingUrl: vi.fn((agentId: string) => urls.get(agentId) ?? null),
    stop: vi.fn(async () => {}),
    stream: vi.fn((_connId: string, _type: string, _payload: Record<string, unknown>) => true),
    surface: vi.fn(async (_connId: string, payload: Record<string, unknown>) => ({ data: 'jpeg', asked: payload })),
    closed: vi.fn((_connId?: string) => {}),
  } satisfies ViewersRuntime
  /** As services/viewers.ts follows agents: each look at one with a harness, and its end. */
  const start = (core: CoreApi, ports: ViewersRuntimeSlot) => {
    core.agents.follow?.((event: AgentLife) => {
      if (event.kind === 'running') attach(event.session)
      else if (event.kind === 'ended') detach(event.agentId)
    })
    ports.viewers = port
  }
  return { port, urls, attach, detach, start }
}

/** What the core tells a service of agents (core/agentLife.ts): a look at one, and its end. */
const running = (session: unknown) => ({ kind: 'agent', event: { kind: 'running', session } })
const ended = (agentId: unknown) => ({ kind: 'agent', event: { kind: 'ended', agentId } })

/** A connection to the core that records what it is told and answers the agents it follows with `listed`. A core from
 *  before agents were followed (`older`) does not know `follow_agents`, and answers `agents` so. */
function connection(listed: unknown = { agents: [] }, older = false) {
  const query = vi.fn(async (name: string, _payload?: Record<string, unknown>) => (
    name === 'follow_agents' ? (older ? { error: 'UNKNOWN_QUERY' } : listed) : name === 'agents' ? listed : { kept: true }) as Record<string, unknown>)
  const told = () => query.mock.calls.filter(([name]) => name === 'viewer_target').map(([, payload]) => payload)
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
      start: (core: CoreApi, ports: ViewersRuntimeSlot) => { api = core; viewers.start(core, ports) },
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

  it('publishes frame fields separately from the forwarding target, with the current lifecycle lease', () => {
    const { api, options } = setup()
    const core = connection()
    options.onConnected!(core.core)
    const row = { ...agent(), frameEpoch: 'core:1' }
    options.onEvent!(running(row))
    const fields = { dsh: 'acme/blender', dshName: 'Blender', viewerUrl: null, viewerName: null, verdict: null }
    api.agents.publishFrame!(row, fields)
    expect(core.query).toHaveBeenCalledWith('frame_part', { agentId: 'a1', frameEpoch: 'core:1', fields })
    expect(core.query).toHaveBeenCalledWith('viewer_target', { agentId: 'a1', forwardingUrl: null })
  })

  it('an older core receives the complete dated context adapter only after UNKNOWN_QUERY', async () => {
    const { api, options, viewers } = setup()
    const query = vi.fn(async (name: string) => name === 'frame_part' || name === 'viewer_target' ? { error: 'UNKNOWN_QUERY' } : { agents: [] })
    options.onConnected!({ query })
    const row = agent()
    options.onEvent!(running(row))
    viewers.urls.set('a1', 'http://127.0.0.1:7000')
    api.agents.publishFrame!(row, { dsh: 'renamed', dshName: 'Name', viewerUrl: null, viewerName: null, verdict: null })
    await vi.waitFor(() => expect(query).toHaveBeenCalledWith('context', {
      agentId: 'a1', context: { id: 'renamed', name: 'Name', viewerUrl: null, viewerName: null, verdict: null }, forwardingUrl: 'http://127.0.0.1:7000',
    }))
    const other = agent('a2')
    options.onEvent!(running(other))
    api.agents.publishFrame!(other, {})
    await vi.waitFor(() => expect(query).toHaveBeenCalledWith('context', { agentId: 'a2', context: null, forwardingUrl: null }))
  })

  it('serves a client\'s viewer stream through the core: its frames in, its answers out to that connection', async () => {
    const { viewers, api, options } = setup()
    // Not connected: an answer has nowhere to go, and the stream ends rather than waiting.
    expect(api.clients.streamFrame('c1', 'viewer_response', { streamId: 's1' })).toBe(false)
    const notice = vi.fn()
    options.onConnected!({ ...connection().core, notice })
    options.onEvent!({ kind: 'client_stream', grant: 's1', asker: { local: true, owner: true }, connection: 'c1', type: 'viewer_request', payload: { streamId: 's1', path: '/' } })
    expect(viewers.port.stream).toHaveBeenCalledWith('c1', 'viewer_request', { streamId: 's1', path: '/' })
    options.onEvent!({ kind: 'client_stream', grant: 's1', asker: { local: true, owner: true }, connection: 'c1', type: 'viewer_end', payload: {} })
    expect(viewers.port.stream).toHaveBeenLastCalledWith('c1', 'viewer_end', {})
    expect(api.clients.streamFrame('c1', 'viewer_response', { streamId: 's1', status: 200 })).toBe(true)
    expect(notice).toHaveBeenCalledWith('client_stream', { grant: 's1', type: 'viewer_response', payload: { streamId: 's1', status: 200 } })
    // A rendered frame, for the connection the core says asked; the connection is not the surface's to read.
    await expect(options.requests.surface({ connId: 'c1', surfaceId: 'v', op: 'frame' }, { local: true, owner: true }))
      .resolves.toEqual({ data: 'jpeg', asked: { surfaceId: 'v', op: 'frame' } })
    expect(viewers.port.surface).toHaveBeenCalledWith('c1', { surfaceId: 'v', op: 'frame' })
    // A connection gone, then every one: the link went down.
    options.onEvent!({ kind: 'client_stream_closed', connection: 'c1' })
    options.onEvent!({ kind: 'client_stream_closed' })
    expect(viewers.port.closed.mock.calls).toEqual([['c1'], [undefined]])
    // What is not a stream's frame is not passed on.
    options.onEvent!({ kind: 'client_stream', grant: 's1', asker: { local: true, owner: true }, connection: 7, type: 'viewer_data' })
    options.onEvent!({ kind: 'client_stream', grant: 's1', asker: { local: true, owner: true }, connection: 'c1' })
    expect(viewers.port.stream).toHaveBeenCalledTimes(2)
  })

  it('ends every stream and surface when the core goes: their connections were that core\'s', () => {
    const { viewers, api, options } = setup()
    const notice = vi.fn()
    options.onConnected!({ ...connection().core, notice })
    options.onDisconnected!()
    expect(viewers.port.closed).toHaveBeenCalledWith(undefined)
    expect(api.clients.streamFrame('c1', 'viewer_data', { streamId: 's1' })).toBe(false)
    expect(notice).not.toHaveBeenCalled()
  })

  it('cannot answer a stream over a connection with no way to say it', () => {
    const { api, options } = setup()
    options.onConnected!(connection().core)
    expect(api.clients.streamFrame('c1', 'viewer_data', { streamId: 's1' })).toBe(false)
  })

  it('attaches what the core attaches, reports its forwarding target, and detaches what it detaches', async () => {
    const { viewers, api, options } = setup()
    const core = connection()
    options.onConnected!(core.core)
    await flush()
    options.onEvent!(running(agent()))
    expect(viewers.attach).toHaveBeenCalledWith(agent())
    expect(api.agents.byAgent('a1')).toEqual(agent())
    expect(api.agents.resolve('a1')).toEqual(agent())
    expect(core.told()).toEqual([{ agentId: 'a1', forwardingUrl: null }])
    options.onEvent!(ended('a1'))
    expect(viewers.detach).toHaveBeenCalledWith('a1')
    expect(api.agents.byAgent('a1')).toBeUndefined()
    // What a stopping viewer says after its detach is not the core's to hear.
    api.clients.viewerChanged('a1')
    expect(core.told()).toHaveLength(1)
  })

  it('tells the core each change once, where the service would move the viewer panes or push a frame', async () => {
    const { viewers, api, options } = setup()
    const core = connection()
    options.onConnected!(core.core)
    options.onEvent!(running(agent()))
    // A viewer came up: its URL, and where the windows' pane forwards.
    viewers.urls.set('a1', 'http://127.0.0.1:7001/')
    api.clients.viewerChanged('a1')
    api.agents.sync(agent())
    expect(core.told()).toEqual([
      { agentId: 'a1', forwardingUrl: null },
      { agentId: 'a1', forwardingUrl: 'http://127.0.0.1:7001/' },
    ])
    // A repeated sync does not send an unchanged forwarding target.
    api.agents.sync(agent())
    expect(core.told()).toHaveLength(2)
    // Said again on every attach, changed or not: a core that restarted keeps nothing until it attaches.
    options.onEvent!(running(agent()))
    expect(core.told()).toHaveLength(3)
  })

  it('says nothing before it is connected, then everything the core lists once it has caught up', async () => {
    const { viewers, options } = setup()
    options.onEvent!(running(agent()))
    expect(viewers.attach).toHaveBeenCalledOnce()
    const core = connection({ agents: [agent()] })
    options.onConnected!(core.core)
    expect(core.told()).toEqual([])
    await flush()
    expect(core.told()).toEqual([{ agentId: 'a1', forwardingUrl: null }])
  })

  it('catches up with the core\'s agents on every connection: attaches what is missing, detaches what is gone', async () => {
    const { viewers, api, options } = setup()
    options.onEvent!(running(agent('gone')))
    options.onEvent!(running(agent('kept')))
    const core = connection({ agents: [agent('kept'), agent('new'), { not: 'an agent' }, null] })
    options.onConnected!(core.core)
    await flush()
    expect(viewers.attach).toHaveBeenCalledWith(agent('new'))
    expect(viewers.detach).toHaveBeenCalledWith('gone')
    expect(viewers.detach).toHaveBeenCalledTimes(1)
    expect((await api.agents.all()).map((session) => session.agentId).sort()).toEqual(['kept', 'new'])
    expect(api.agents.live()).toHaveLength(2)
  })

  it('asks to follow the agents with a harness at every look at them, as it connects', async () => {
    const { options } = setup()
    const core = connection()
    options.onConnected!(core.core)
    await flush()
    expect(core.query).toHaveBeenCalledWith('follow_agents', { each: true, having: ['dsh'], frames: true })
    expect(core.query).not.toHaveBeenCalledWith('agents')
  })

  // A core from before agents were followed (2026-11-15), under a master of this build: it says each look and end as
  // `attach` and `detach`, and answers the agents with a harness as it was always asked. Delete on or after 2026-12-18.
  it('under a core from before agents were followed, catches up from `agents` and hears its attach and detach', async () => {
    const { viewers, api, options } = setup()
    const core = connection({ agents: [agent('kept')] }, true)
    options.onConnected!(core.core)
    await flush()
    expect(core.query).toHaveBeenCalledWith('agents')
    expect(viewers.attach).toHaveBeenCalledWith(agent('kept'))
    options.onEvent!({ kind: 'attach', session: agent('new') })
    options.onEvent!({ kind: 'detach', agentId: 'kept' })
    expect(viewers.attach).toHaveBeenCalledWith(agent('new'))
    expect(viewers.detach).toHaveBeenCalledWith('kept')
    expect((await api.agents.all()).map((session) => session.agentId)).toEqual(['new'])
  })

  it('leaves an agent heard of since it asked: news newer than the core\'s answer', async () => {
    const { viewers, api, options } = setup()
    options.onEvent!(running(agent('a1')))
    let answer: (value: Record<string, unknown>) => void = () => {}
    const query = vi.fn((name: string) => (name === 'follow_agents' ? new Promise<Record<string, unknown>>((done) => { answer = done }) : Promise.resolve({ kept: true })))
    options.onConnected!({ query })
    // While the question is out: a new agent attached, an old one detached.
    options.onEvent!(running(agent('a4')))
    options.onEvent!(ended('a1'))
    answer({ agents: [agent('a1')] })
    await flush()
    expect((await api.agents.all()).map((session) => session.agentId)).toEqual(['a4'])
    // Attached once, before the question: the answer naming it did not bring it back.
    expect(viewers.attach.mock.calls.filter(([session]) => session.agentId === 'a1')).toHaveLength(1)
  })

  it('ignores an older connection\'s answer, an answer that names no agents, and a core that cannot answer', async () => {
    const { viewers, options } = setup()
    let answer: (value: Record<string, unknown>) => void = () => {}
    const older = vi.fn((name: string) => (name === 'follow_agents' ? new Promise<Record<string, unknown>>((done) => { answer = done }) : Promise.resolve({})))
    options.onConnected!({ query: older })
    options.onConnected!(connection({ error: 'UNKNOWN_QUERY' }).core)
    answer({ agents: [agent('late')] })
    await flush()
    options.onConnected!({ query: vi.fn(async () => { throw new Error('the core went away') }) })
    await flush()
    expect(viewers.attach).not.toHaveBeenCalled()
  })

  it('a word lost with its connection is said again on the next one', async () => {
    const { viewers, options } = setup()
    const lost = vi.fn(async (name: string) => {
      if (name === 'viewer_target') throw new Error('the core went away')
      return { agents: [agent()] }
    })
    options.onConnected!({ query: lost })
    options.onEvent!(running(agent()))
    await flush()
    const core = connection({ agents: [agent()] })
    options.onConnected!(core.core)
    await flush()
    expect(core.told()).toEqual([{ agentId: 'a1', forwardingUrl: null }])
  })

  it('hands what it hears of agents to the service\'s follower, the latest; an earlier one\'s end changes nothing', () => {
    const { options, api } = setup()
    const first = vi.fn()
    const latest = vi.fn()
    const unfollowFirst = api.agents.follow!(first)
    const unfollowLatest = api.agents.follow!(latest)
    unfollowFirst()
    options.onEvent!(running(agent('a1')))
    expect(latest).toHaveBeenCalledWith({ kind: 'running', session: agent('a1') })
    expect(first).not.toHaveBeenCalled()
    unfollowLatest()
    options.onEvent!(running(agent('a2')))
    expect(latest).toHaveBeenCalledTimes(1)
  })

  it('ignores what it is told that it does not act on', () => {
    const { viewers, options } = setup()
    options.onEvent!({ kind: 'touch', sessionId: 's1' })
    options.onEvent!({ kind: 'agent' })
    options.onEvent!(running(undefined))
    options.onEvent!(running({ dsh: 'acme/blender' }))
    options.onEvent!(ended(7))
    // What else agents do is not the viewers' business.
    options.onEvent!({ kind: 'agent', event: { kind: 'stopped', agentId: 'a1' } })
    options.onEvent!({ kind: 'attach' })
    options.onEvent!({ kind: 'detach', agentId: 7 })
    expect(viewers.attach).not.toHaveBeenCalled()
    expect(viewers.detach).not.toHaveBeenCalled()
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
    const api = viewersCoreApi('/data', sessions, tell, () => false, () => () => {})
    expect(api.dataDir).toBe('/data')
    expect(await api.agents.all()).toEqual([agent()])
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
    expect(api.clients.streamFrame('c1', 'viewer_data', {})).toBe(false)
    api.clients.turnCard({ type: 'commander_event', agentId: 'a', dbSessionId: 's', payload: {} })
    api.clients.turnSummary({ type: 'turn_summary' })
  })

  it('runs as a real service by default: its viewers, on its own link to the core', async () => {
    const handle = runViewersService({ dataDir: '/data', socketPath: '/data/daemon-1.sock', machineId: 'm', token: 't' })
    expect(runServiceProcess).toHaveBeenCalledWith(expect.objectContaining({ name: 'viewers', socketPath: '/data/daemon-1.sock' }))
    await handle.stop()
  })
})
