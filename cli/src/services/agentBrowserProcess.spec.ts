import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentBrowserPort, AgentLife, CoreApi, CorePorts } from '../core/api.js'
import type { RegisteredSession } from '../lib/registry.js'
import type { AgentBrowserOptions } from './agentBrowser.js'
import { agentBrowserCoreApi, runAgentBrowserService } from './agentBrowserProcess.js'
import { encodeTerminalLocal, TerminalBinaryKind } from '../lib/terminalBinary.js'
import { runServiceProcess, type CoreConnection, type ServiceProcessOptions } from './process.js'
import { turnsLink } from './turnsLink.js'

// The real default reaches a real socket: never in a test.
vi.mock('./process.js', () => ({ runServiceProcess: vi.fn(() => ({ stop: vi.fn() })) }))

afterEach(() => { vi.clearAllMocks(); vi.useRealTimers() })

describe('the agent browser in its own process', () => {
  const setup = () => {
    let options: ServiceProcessOptions | null = null
    let api: CoreApi | null = null
    let given: AgentBrowserOptions | undefined
    /** What the service heard of agents, as it follows them (services/followLink.ts). */
    const heard: AgentLife[] = []
    const port: AgentBrowserPort = {
      frameContext: vi.fn(), stop: vi.fn(),
      stream: vi.fn(() => true), streamInput: vi.fn(), streamClosed: vi.fn(), streamRoute: vi.fn(), streamTransportError: vi.fn(), streamRefused: vi.fn(),
    }
    const requests = { agent_browser_available: vi.fn() }
    const stop = vi.fn()
    const service = runAgentBrowserService({
      dataDir: '/data', socketPath: '/data/daemon-1.sock', machineId: 'm', token: 't',
      run: (opts) => { options = opts; return { stop } },
      start: (core, ports: Pick<CorePorts, 'agentBrowser'>, opts) => {
        api = core
        given = opts
        core.agents.follow!((event) => { heard.push(event) })
        ports.agentBrowser = port
        return requests
      },
    })
    return { options: options!, api: api!, given: given!, port, requests, service, stop, heard }
  }

  it('answers its requests and hears what the core tells it of agents, and nothing else', () => {
    const { options, requests, heard } = setup()
    expect(options).toMatchObject({ name: 'agentBrowser', socketPath: '/data/daemon-1.sock', machineId: 'm', token: 't', requests })
    const row = { agentId: 'a1', sessionId: 's1' } as RegisteredSession
    const told = (event: Record<string, unknown>) => options.onEvent!({ kind: 'agent', event })
    told({ kind: 'running', session: row })
    told({ kind: 'running', session: { browser: true } })
    told({ kind: 'ended', agentId: 'a1' })
    told({ kind: 'purged', agentId: 'a2', sessionIds: ['s2'] })
    told({ kind: 'taken', from: 'a1', to: 'b1' })
    options.onEvent!({ kind: 'other', agentId: 'x' })
    expect(heard).toEqual([
      { kind: 'running', session: row },
      { kind: 'ended', agentId: 'a1' },
      { kind: 'purged', agentId: 'a2', sessionIds: ['s2'] },
      { kind: 'taken', from: 'a1', to: 'b1' },
    ])
  })

  // Until 2026-11-15 the core told this process `attached`, `stopped`, `deleted` and `moved`, and kept whose Browser was
  // on. A core from before still does (a newer master after a rollback): heard as what happens to agents now. Delete on
  // or after 2026-12-18.
  it('hears what a core from before tells of agents as what happens to them now, and drops what is not one', () => {
    const { options, heard } = setup()
    const row = { agentId: 'a1', sessionId: 's1', browser: true } as RegisteredSession
    options.onEvent!({ kind: 'attached', session: row })
    options.onEvent!({ kind: 'stopped', agentId: 'a1' })
    options.onEvent!({ kind: 'deleted', agentId: 'a1' })
    options.onEvent!({ kind: 'moved', from: 'a1', session: { agentId: 'b1' }, on: true })
    options.onEvent!({ kind: 'moved', from: 'a1' })
    options.onEvent!({ kind: 'attached', session: { browser: true } })
    expect(heard).toEqual([
      { kind: 'running', session: row },
      { kind: 'ended', agentId: 'a1' },
      { kind: 'purged', agentId: 'a1', sessionIds: [] },
      { kind: 'taken', from: 'a1', to: 'b1' },
    ])
  })

  it('asks to follow every agent each time it connects, and is caught up once the core answers, waiting 10 s at most', async () => {
    vi.useFakeTimers()
    const { options, given, heard } = setup()
    const waiting = given.followed!()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(await waiting).toBe(false)
    const row = { agentId: 'a1', sessionId: 's1' } as RegisteredSession
    const query = vi.fn(async (name: string, _payload?: Record<string, unknown>) => (name === 'follow_agents' ? { agents: [row] } : {}))
    options.onConnected!({ query } satisfies CoreConnection)
    expect(query).toHaveBeenCalledWith('follow_agents', {})
    expect(await given.followed!()).toBe(true)
    expect(heard).toEqual([{ kind: 'running', session: row }])
    // Gone: not caught up until the next connection's answer.
    options.onDisconnected!()
    const again = given.followed!()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(await again).toBe(false)
  })

  it('tells the core each browser\'s state, and all of them again at every connection', async () => {
    const { options, given } = setup()
    // No core yet: kept until there is one.
    given.told!('a1', { state: 'starting' })
    const query = vi.fn(async (_query: string, _payload?: Record<string, unknown>) => ({}))
    options.onConnected!({ query } satisfies CoreConnection)
    // First that it takes viewers' streams, said to each core it connects to; then what it follows of agents.
    expect(query.mock.calls).toEqual([['streams', {}], ['browser_state', { agentId: 'a1', state: { state: 'starting' } }], ['follow_agents', {}]])
    given.told!('a1', { state: 'ready' })
    given.told!('a2', { state: 'setup', step: 'building' })
    given.told!('a2', undefined)
    expect(query.mock.calls.slice(3)).toEqual([
      ['browser_state', { agentId: 'a1', state: { state: 'ready' } }],
      ['browser_state', { agentId: 'a2', state: { state: 'setup', step: 'building' } }],
      ['browser_state', { agentId: 'a2' }],
    ])
    options.onDisconnected!()
    const next = vi.fn(async () => { throw new Error('gone') })
    options.onConnected!({ query: next } as CoreConnection)
    expect(next.mock.calls).toEqual([['streams', {}], ['browser_state', { agentId: 'a1', state: { state: 'ready' } }], ['follow_agents', {}]])
    given.told!('a3', { state: 'starting' })
    await Promise.resolve()
  })

  // The exec into a ready browser is this process's own, to start for a viewer: the core is told the state and no
  // command line (until the audit of 2026-11-12 the core was told the exec, and started it).
  it('a ready browser\'s state carries no command', () => {
    const { options, given } = setup()
    const query = vi.fn(async (_query: string, _payload?: Record<string, unknown>) => ({}))
    options.onConnected!({ query } satisfies CoreConnection)
    given.told!('a9', { state: 'ready' })
    expect(query.mock.calls.slice(2)).toEqual([['browser_state', { agentId: 'a9', state: { state: 'ready' } }]])
  })

  const STREAM = '11111111-2222-4333-8444-555555555555'
  const asker = { local: false, owner: true, accountOwner: true }

  it('a viewer\'s frames the core passes on reach the port, with who asked as the core established it', () => {
    const { options, port } = setup()
    options.onEvent!({ kind: 'stream', connId: 'c1', type: 'agent_browser_open', payload: { requestId: 'r-1', agentId: 'a1' }, asker })
    // An ack and a close are the stream's own: nobody asking comes with them.
    options.onEvent!({ kind: 'stream', connId: 'c1', type: 'agent_browser_ack', payload: { streamId: STREAM, bytes: 9 } })
    // A frame with no payload is an empty one; who asked that is not one is nobody.
    options.onEvent!({ kind: 'stream', connId: 'c1', type: 'agent_browser_close' })
    options.onEvent!({ kind: 'stream', connId: 'c1', type: 'agent_browser_close', payload: 'x', asker: 'owner' })
    expect(vi.mocked(port.stream).mock.calls).toEqual([
      ['c1', 'agent_browser_open', { requestId: 'r-1', agentId: 'a1' }, asker],
      ['c1', 'agent_browser_ack', { streamId: STREAM, bytes: 9 }, undefined],
      ['c1', 'agent_browser_close', {}, undefined],
      ['c1', 'agent_browser_close', {}, undefined],
    ])
    // A connection's end, as every service hears it from the core's service links.
    options.onConnectionClosed!('c1')
    options.onEvent!({ kind: 'stream_route', streamId: STREAM, route: 'turn' })
    options.onEvent!({ kind: 'stream_route', streamId: STREAM, route: null })
    options.onEvent!({ kind: 'stream_transport_error' })
    options.onEvent!({ kind: 'stream_refused', streamId: STREAM })
    expect(vi.mocked(port.streamClosed).mock.calls).toEqual([['c1']])
    expect(vi.mocked(port.streamRoute).mock.calls).toEqual([[STREAM, 'turn'], [STREAM, null]])
    expect(port.streamTransportError).toHaveBeenCalledOnce()
    expect(vi.mocked(port.streamRefused).mock.calls).toEqual([[STREAM]])
  })

  it('a stream\'s frame that names no connection, no type, no stream or no route is dropped', () => {
    const { options, port } = setup()
    for (const payload of [
      { kind: 'stream', type: 'agent_browser_open', payload: {}, asker }, { kind: 'stream', connId: 7, type: 'agent_browser_open', asker },
      { kind: 'stream', connId: 'c1', payload: {}, asker },
      // The core says a connection's end as it says it to every service, never as a stream's event.
      { kind: 'stream_closed', connId: 'c1' },
      { kind: 'stream_route', route: 'direct' }, { kind: 'stream_route', streamId: STREAM, route: 'carrier-pigeon' }, { kind: 'stream_route', streamId: STREAM },
      { kind: 'stream_refused' }, { kind: 'stream_refused', streamId: 7, agentId: 'a1' },
    ]) options.onEvent!(payload)
    for (const member of ['stream', 'streamClosed', 'streamRoute', 'streamRefused'] as const) expect(port[member], member).not.toHaveBeenCalled()
  })

  it('a viewer\'s bytes reach its stream, and nothing else on the link\'s binary side does', () => {
    const { options, port } = setup()
    const frame = (kind: TerminalBinaryKind, ...bytes: number[]) => encodeTerminalLocal({ kind, streamId: STREAM, seq: 0, bytes: Uint8Array.from(bytes), compressed: false })!
    options.onBinary!(frame(TerminalBinaryKind.browser, 1, 2))
    expect(vi.mocked(port.streamInput).mock.calls).toEqual([[STREAM, Uint8Array.of(1, 2)]])
    // A terminal's keys are never a browser's; and what is no frame is dropped.
    options.onBinary!(frame(TerminalBinaryKind.input, 3))
    options.onBinary!(Uint8Array.of(9, 9, 9))
    expect(port.streamInput).toHaveBeenCalledOnce()
  })

  it('a stream\'s answers go to the core as notices and the screen\'s bytes as binary frames, and neither while no core can take them', () => {
    const { options, api } = setup()
    // No core yet.
    expect(api.clients.browserFrame!('c1', 'agent_browser_close', { streamId: STREAM, reason: 'agent' })).toBe(false)
    const screen = (seq: number, ...bytes: number[]) => encodeTerminalLocal({ kind: TerminalBinaryKind.browser, streamId: STREAM, seq, bytes: Uint8Array.from(bytes), compressed: false })!
    expect(api.clients.browserBytes!(screen(0, 1))).toBe(false)
    const notice = vi.fn()
    const sendBinary = vi.fn((_bytes: Uint8Array) => true)
    options.onConnected!({ query: async () => ({}), notice, sendBinary } satisfies CoreConnection)
    expect(api.clients.browserFrame!('c1', 'agent_browser_open_result', { requestId: 'r-1', streamId: STREAM })).toBe(true)
    expect(notice.mock.calls).toEqual([['stream_frame', { connId: 'c1', type: 'agent_browser_open_result', payload: { requestId: 'r-1', streamId: STREAM } }]])
    // The service's own frame, a terminal's plain one that names the stream, goes on the link as it is.
    const frame = screen(7, 4, 5)
    expect(api.clients.browserBytes!(frame)).toBe(true)
    expect(sendBinary.mock.calls[0]![0]).toBe(frame)
    // What the link would not take ends the stream (agentBrowser/streams.ts).
    sendBinary.mockReturnValueOnce(false)
    expect(api.clients.browserBytes!(screen(8, 6))).toBe(false)
    expect(sendBinary).toHaveBeenCalledTimes(2)
    // A link that carries no notices or no bytes takes neither.
    options.onDisconnected!()
    options.onConnected!({ query: async () => ({}) } satisfies CoreConnection)
    expect(api.clients.browserFrame!('c1', 'agent_browser_close', { streamId: STREAM })).toBe(false)
    expect(api.clients.browserBytes!(screen(9, 6))).toBe(false)
  })

  // The core that went forgot every stream it held and told their panels so. An exec left piping a still screen sends
  // nothing that would end it, and holds one of its browser's four viewer places.
  it('ends every viewer\'s streams when the core goes, once each', () => {
    const { options, port } = setup()
    options.onConnected!({ query: async () => ({}) } satisfies CoreConnection)
    options.onEvent!({ kind: 'stream', connId: 'c1', type: 'agent_browser_open', payload: { requestId: 'r-1' }, asker })
    options.onEvent!({ kind: 'stream', connId: 'c1', type: 'agent_browser_ack', payload: {}, asker })
    options.onEvent!({ kind: 'stream', connId: 'c2', type: 'agent_browser_open', payload: { requestId: 'r-2' }, asker })
    options.onEvent!({ kind: 'stream', connId: 'c3', type: 'agent_browser_open', payload: { requestId: 'r-3' }, asker })
    // One whose connection ended already was told so then.
    options.onConnectionClosed!('c3')
    expect(vi.mocked(port.streamClosed).mock.calls).toEqual([['c3']])
    vi.mocked(port.streamClosed).mockClear()
    options.onDisconnected!()
    expect(vi.mocked(port.streamClosed).mock.calls).toEqual([['c1'], ['c2']])
    options.onDisconnected!()
    expect(port.streamClosed).toHaveBeenCalledTimes(2)
  })

  // Every window and phone that goes is said to every service. The ones that never watched a browser cost nothing, and
  // the process keeps only the connections still open that did: a stream that closed and then its window going left
  // the connection kept for good (review, 2026-11-13).
  it('keeps no connection that ended, whether or not it watched, and tells the service only of one that did', () => {
    const { options, port } = setup()
    options.onConnectionClosed!('phone-1')
    expect(port.streamClosed).not.toHaveBeenCalled()
    options.onEvent!({ kind: 'stream', connId: 'c1', type: 'agent_browser_open', payload: { requestId: 'r-1' }, asker })
    options.onEvent!({ kind: 'stream', connId: 'c1', type: 'agent_browser_close', payload: { streamId: STREAM } })
    options.onConnectionClosed!('c1')
    options.onConnectionClosed!('c1')
    expect(vi.mocked(port.streamClosed).mock.calls).toEqual([['c1']])
    options.onDisconnected!()
    expect(port.streamClosed).toHaveBeenCalledOnce()
  })

  it('asks the core for every agent here once caught up with it, and a pane\'s agent, and gets no answer when the core cannot say', async () => {
    vi.useFakeTimers()
    const { options, api, given } = setup()
    // Not connected: no answer, after the wait for the catch-up.
    const early = given.everyAgent!()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(await early).toBeNull()
    vi.useRealTimers()
    expect(await api.agents.ofPane!('%7', [4242])).toBeNull()
    const row = { agentId: 'a1', sessionId: 's1' } as RegisteredSession
    let answer: Record<string, unknown> = { agents: [row, 7] }
    const query = vi.fn(async (_query: string, _payload?: Record<string, unknown>) => answer)
    options.onConnected!({ query } satisfies CoreConnection)
    expect(await given.everyAgent!()).toEqual([row])
    expect(query).toHaveBeenLastCalledWith('agents', {})
    answer = { error: 'UNKNOWN_QUERY' }
    expect(await given.everyAgent!()).toBeNull()
    // The command's parents go with its pane: the core holds the pane's own process to them.
    answer = { agentId: 'a1', guest: false }
    expect(await api.agents.ofPane!('%7', [4242, 1])).toEqual({ agentId: 'a1', guest: false })
    expect(query).toHaveBeenLastCalledWith('agent_of_pane', { pane: '%7', ancestors: [4242, 1] })
    answer = { agentId: 'kim', guest: true }
    expect(await api.agents.ofPane!('%8', [4343])).toEqual({ agentId: 'kim', guest: true })
    // An older relay's `agent_browser_state` names its pane alone.
    answer = { agentId: 'a1', guest: false }
    expect(await api.agents.ofPane!('%7')).toEqual({ agentId: 'a1', guest: false })
    expect(query).toHaveBeenLastCalledWith('agent_of_pane', { pane: '%7' })
    // No agent, or an answer that does not say whose it is: none.
    for (const shape of [{ agentId: null }, { agentId: 'a1' }, { agentId: 'a1', guest: 'no' }, { error: 'UNKNOWN_QUERY' }]) {
      answer = shape
      expect(await api.agents.ofPane!('%7', [4242]), JSON.stringify(shape)).toBeNull()
    }
  })

  // A command waits on this: a core that does not answer is no agent, never a command left hanging.
  it('a core that never answers a pane\'s agent is no agent after 10 s', async () => {
    vi.useFakeTimers()
    const { options, api } = setup()
    options.onConnected!({ query: () => new Promise(() => {}) } as CoreConnection)
    const asked = api.agents.ofPane!('%7', [4242])
    await vi.advanceTimersByTimeAsync(10_000)
    expect(await asked).toBeNull()
  })

  it('a core that never answers which agents are here is no answer after 10 s', async () => {
    vi.useFakeTimers()
    const { options, given } = setup()
    options.onConnected!({ query: () => new Promise(() => {}) } as CoreConnection)
    const asked = given.everyAgent!()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(await asked).toBeNull()
  })

  // The ready and stop lines (agentBrowser/notices.ts): typed by the core, which tells this process what became of each.
  it('delivers its lines through the core and hears what became of them', async () => {
    const { options, api, heard: agents } = setup()
    const query = vi.fn(async (_query: string, _payload?: Record<string, unknown>) => ({}))
    options.onConnected!({ query } satisfies CoreConnection)
    const heard = vi.fn()
    api.turns.onDelivery(heard)
    api.turns.deliver('a1', 'Your browser is ready', 'agent-browser:a1:ready:1')
    const [name, payload] = query.mock.calls.at(-1)!
    expect(name).toBe('deliver')
    expect(payload).toMatchObject({ agentId: 'a1', text: 'Your browser is ready' })
    expect(String(payload!.deliveryId)).toMatch(/^agent-browser:a1:ready:/)
    const event = { deliveryId: 'agent-browser:a1:ready:1', sessionId: 'a1', state: 'delivered' }
    options.onEvent!({ kind: 'delivery', event })
    expect(heard).toHaveBeenCalledWith(event)
    expect(agents).toEqual([])
  })

  // A line asked of no core was never written, so it is not counted as perhaps written (`unknown`): its next try types
  // it. One the core was asked and never confirmed may have been, and stays `unknown`.
  it('a line with no core to ask is refused, and one the link lost is unknown', async () => {
    const { options, api } = setup()
    const heard = vi.fn()
    api.turns.onDelivery(heard)
    api.turns.deliver('a1', 'Your browser is ready', 'agent-browser:a1:ready:1')
    await vi.waitFor(() => expect(heard).toHaveBeenCalledTimes(1))
    expect(heard).toHaveBeenLastCalledWith(expect.objectContaining({ deliveryId: 'agent-browser:a1:ready:1', sessionId: 'a1', state: 'rejected' }))
    options.onConnected!({ query: vi.fn(async () => { throw new Error('not connected to the core') }) } as CoreConnection)
    api.turns.deliver('a1', 'Your browser is ready', 'agent-browser:a1:ready:2')
    await vi.waitFor(() => expect(heard).toHaveBeenCalledTimes(2))
    expect(heard).toHaveBeenLastCalledWith(expect.objectContaining({ deliveryId: 'agent-browser:a1:ready:2', state: 'unknown' }))
  })

  it('counts through the core, and loses a count it cannot hand over', async () => {
    const { options, api } = setup()
    api.count!('agent_browser_enabled')
    const query = vi.fn(async () => { throw new Error('gone') })
    options.onConnected!({ query } as CoreConnection)
    api.count!('agent_browser_start_ok')
    expect(query).toHaveBeenCalledWith('count', { metric: 'agent_browser_start_ok' })
    await Promise.resolve()
  })

  it('stops the browsers\' watch with the process', () => {
    const { port, service, stop } = setup()
    service.stop()
    expect(port.stop).toHaveBeenCalled()
    expect(stop).toHaveBeenCalled()
  })

  it('with nothing handed in, starts the real service on the real link', () => {
    const service = runAgentBrowserService({ dataDir: '/data', socketPath: '/s', machineId: 'm', token: 't' })
    expect(vi.mocked(runServiceProcess)).toHaveBeenCalledWith(expect.objectContaining({ name: 'agentBrowser' }))
    service.stop()
  })

  it('is the light services\' core API besides', () => {
    const ask = async () => ({})
    const api = agentBrowserCoreApi('/data', ask, turnsLink(ask), { frame: () => false, bytes: () => false })
    expect(api.dataDir).toBe('/data')
    expect(api.agents.live()).toEqual([])
  })
})
