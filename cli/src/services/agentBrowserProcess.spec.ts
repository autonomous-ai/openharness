import type { BrowserRuntime, BrowserRuntimeSlot } from './agentBrowserRuntime.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentView, AgentLife, CoreApi, CorePorts } from '../core/api.js'
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
    const port: BrowserRuntime = {
      stop: vi.fn(),
      stream: vi.fn(() => true), streamInput: vi.fn(), streamClosed: vi.fn(), streamRoute: vi.fn(), streamTransportError: vi.fn(), streamRefused: vi.fn(),
    }
    const requests = { agent_browser_available: vi.fn() }
    const stop = vi.fn()
    const move = vi.fn(async (_from: string, _session: RegisteredSession, _on: boolean) => true)
    let unlegacy!: () => void
    const service = runAgentBrowserService({
      dataDir: '/data', socketPath: '/data/daemon-1.sock', machineId: 'm', token: 't',
      run: (opts) => { options = opts; return { stop } },
      start: (core, ports: BrowserRuntimeSlot, opts) => {
        api = core
        given = opts
        unlegacy = opts!.legacyMoves!(move)
        core.agents.follow!((event) => { heard.push(event) })
        ports.agentBrowser = port
        return requests
      },
    })
    return { options: options!, api: api!, given: given!, port, requests, service, stop, heard, move, unlegacy }
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
    const { options, heard, move } = setup()
    const row = { agentId: 'a1', sessionId: 's1', browser: true } as RegisteredSession
    options.onEvent!({ kind: 'attached', session: row })
    options.onEvent!({ kind: 'stopped', agentId: 'a1' })
    options.onEvent!({ kind: 'deleted', agentId: 'a1' })
    options.onEvent!({ kind: 'moved', from: 'a1', session: { agentId: 'b1' }, on: false })
    options.onEvent!({ kind: 'moved', from: 'a1' })
    options.onEvent!({ kind: 'attached', session: { browser: true } })
    expect(heard).toEqual([
      { kind: 'running', session: row },
      { kind: 'ended', agentId: 'a1' },
      { kind: 'purged', agentId: 'a1', sessionIds: [] },
    ])
    expect(move).toHaveBeenCalledWith('a1', { agentId: 'b1' }, false)
  })

  it('finishes a legacy move before asking that core to move its flag and publishing the destination', async () => {
    const { options, move, heard } = setup()
    let moved!: (value: boolean) => void
    move.mockReturnValue(new Promise(resolve => { moved = resolve }))
    const query = vi.fn(async (name: string) => name === 'move_browser' ? { ok: true } : { agents: [] })
    options.onConnected!({ query })
    const session = { agentId: 'b1', sessionId: 's-b1' }
    options.onEvent!({ kind: 'moved', from: 'a1', session, on: true })
    expect(query.mock.calls.some(([name]) => name === 'move_browser')).toBe(false)
    moved(true)
    await vi.waitFor(() => expect(heard).toContainEqual({ kind: 'running', session: { ...session, browser: true } }))
    expect(query).toHaveBeenCalledWith('move_browser', { from: 'a1', to: 'b1' })
  })

  it.each([false, true])('a legacy move that returns %s while off changes no core flag', async moved => {
    const { options, move } = setup()
    move.mockResolvedValue(moved)
    const query = vi.fn(async (_name: string) => ({ agents: [] }))
    options.onConnected!({ query })
    options.onEvent!({ kind: 'moved', from: 'a1', session: { agentId: 'b1' }, on: false })
    await Promise.resolve()
    expect(query.mock.calls.some(args => args[0] === 'move_browser')).toBe(false)
  })

  it('drops malformed legacy moves and moves after the service unsubscribes', () => {
    const { options, move, unlegacy } = setup()
    const valid = { kind: 'moved', from: 'a1', session: { agentId: 'b1' }, on: true }
    for (const payload of [{ ...valid, from: 2 }, { ...valid, from: '' }, { ...valid, session: null }, { ...valid, on: 'yes' }]) options.onEvent!(payload)
    unlegacy()
    options.onEvent!(valid)
    expect(move).not.toHaveBeenCalled()
  })

  it.each(['missing', 'refused', 'throws', 'times out'] as const)('names a legacy move whose core answer %s without attaching the destination', async kind => {
    vi.useFakeTimers()
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const { options, heard } = setup()
    const query = vi.fn(async (name: string) => {
      if (name !== 'move_browser') return { agents: [] }
      if (kind === 'throws') throw new Error('disconnected')
      if (kind === 'times out') return new Promise<Record<string, unknown>>(() => {})
      return kind === 'refused' ? { error: 'NOT_RUNNING' } : {}
    })
    options.onConnected!({ query })
    options.onEvent!({ kind: 'moved', from: 'a1', session: { agentId: 'b1' }, on: true })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(log).toHaveBeenCalledWith(`agent browser b1: browser_move_failed (${kind === 'refused' ? 'not_running' : 'no_answer'})`)
    expect(heard).toEqual([])
    log.mockRestore()
  })

  it.each(['before connection', 'before move completes', 'before answer'] as const)('a legacy move disconnected %s never restores a stale destination', async when => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const { options, move, heard } = setup()
    let moved!: (value: boolean) => void
    move.mockReturnValue(new Promise(resolve => { moved = resolve }))
    let answer!: (value: Record<string, unknown>) => void
    const reply = new Promise<Record<string, unknown>>(resolve => { answer = resolve })
    const query = vi.fn(async (name: string) => name === 'move_browser' ? reply : { agents: [] })
    if (when !== 'before connection') options.onConnected!({ query })
    options.onEvent!({ kind: 'moved', from: 'a1', session: { agentId: 'b1' }, on: true })
    if (when === 'before move completes') options.onDisconnected!()
    moved(true)
    if (when === 'before answer') {
      await vi.waitFor(() => expect(query).toHaveBeenCalledWith('move_browser', { from: 'a1', to: 'b1' }))
      options.onDisconnected!()
      answer({ ok: true })
    }
    await vi.waitFor(() => expect(log).toHaveBeenCalledWith('agent browser b1: browser_move_failed (no_answer)'))
    expect(heard).toEqual([])
    log.mockRestore()
  })

  it('names a legacy move handler failure without an unhandled rejection', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const { options, move } = setup()
    move.mockRejectedValue(new Error('closing'))
    options.onEvent!({ kind: 'moved', from: 'a1', session: { agentId: 'b1' }, on: true })
    await vi.waitFor(() => expect(log).toHaveBeenCalledWith('agent browser b1: browser_move_failed (no_answer) · Error'))
    log.mockRestore()
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
    expect(query).toHaveBeenCalledWith('follow_agents', { frames: true })
    expect(await given.followed!()).toBe(true)
    expect(heard).toEqual([{ kind: 'running', session: row }])
    // Gone: not caught up until the next connection's answer.
    options.onDisconnected!()
    const again = given.followed!()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(await again).toBe(false)
  })

  it('publishes bounded parts with the followed run and never replays an old lease on reconnect', async () => {
    const { options, api } = setup()
    const row = { agentId: 'a1', sessionId: 's1', frameEpoch: 'run-1' } as AgentView
    api.agents.publishFrame!(row, { browser: { state: 'starting' } })
    const query = vi.fn(async (_query: string, _payload?: Record<string, unknown>) => ({ agents: [] }))
    options.onConnected!({ query })
    expect(query.mock.calls).toEqual([['client_streams', {}], ['follow_agents', { frames: true }]])
    options.onEvent!({ kind: 'agent', event: { kind: 'running', session: row } })
    api.agents.publishFrame!(row, { browser: { state: 'ready' } })
    expect(query).toHaveBeenLastCalledWith('frame_part', { agentId: 'a1', frameEpoch: 'run-1', fields: { browser: { state: 'ready' } } })
    options.onDisconnected!()
    const next = vi.fn(async () => ({ agents: [] }))
    options.onConnected!({ query: next })
    expect(next.mock.calls).toEqual([['client_streams', {}], ['follow_agents', { frames: true }]])
    const resumed = { ...row, frameEpoch: 'run-2' }
    options.onEvent!({ kind: 'agent', event: { kind: 'running', session: resumed } })
    api.agents.publishFrame!(resumed, {})
    expect(next).toHaveBeenLastCalledWith('frame_part', { agentId: 'a1', frameEpoch: 'run-2', fields: {} })
  })

  it('uses the dated Browser state adapter only when an older core rejects frame_part as unknown', async () => {
    const { api, options } = setup()
    const query = vi.fn(async (name: string) => name === 'frame_part' ? { error: 'UNKNOWN_QUERY' } : { agents: [] })
    options.onConnected!({ query })
    const row = { agentId: 'a1', sessionId: 's1' } as AgentView
    options.onEvent!({ kind: 'agent', event: { kind: 'running', session: row } })
    api.agents.publishFrame!(row, { browser: { state: 'ready' } })
    await vi.waitFor(() => expect(query).toHaveBeenCalledWith('browser_state', { agentId: 'a1', state: { state: 'ready' } }))
    api.agents.publishFrame!(row, {})
    await vi.waitFor(() => expect(query).toHaveBeenCalledWith('browser_state', { agentId: 'a1' }))
  })

  const STREAM = '11111111-2222-4333-8444-555555555555'
  const asker = { local: false, owner: true, accountOwner: true }

  it('a viewer\'s frames the core passes on reach the port, with who asked as the core established it', () => {
    const { options, port } = setup()
    options.onEvent!({ kind: 'client_stream', grant: 'g1', connection: 'c1', type: 'agent_browser_open', payload: { requestId: 'r-1', agentId: 'a1' }, asker })
    // An ack and a close are the stream's own: nobody asking comes with them.
    options.onEvent!({ kind: 'client_stream', grant: 'g1', connection: 'c1', type: 'agent_browser_ack', payload: { streamId: STREAM, bytes: 9 }, asker })
    // A frame with no payload is an empty one; who asked that is not one is nobody.
    options.onEvent!({ kind: 'client_stream', grant: 'g1', connection: 'c1', type: 'agent_browser_close' })
    options.onEvent!({ kind: 'client_stream', grant: 'g1', connection: 'c1', type: 'agent_browser_close', payload: 'x', asker: 'owner' })
    expect(vi.mocked(port.stream).mock.calls).toEqual([
      ['c1', 'agent_browser_open', { requestId: 'r-1', agentId: 'a1' }, asker],
      ['c1', 'agent_browser_ack', { streamId: STREAM, bytes: 9 }, asker],
    ])
    // A connection's end, as every service hears it from the core's service links.
    options.onEvent!({ kind: 'client_stream_control', grant: 'g1', payload: { streamId: STREAM, route: 'turn' } })
    options.onEvent!({ kind: 'client_stream_control', grant: 'g1', payload: { streamId: STREAM, route: null } })
    options.onEvent!({ kind: 'client_stream_control', grant: null, payload: { kind: 'transport_error' } })
    options.onEvent!({ kind: 'client_stream_refused', grant: 'g1', streamId: STREAM })
    options.onConnectionClosed!('c1')
    expect(vi.mocked(port.streamClosed).mock.calls).toEqual([['c1']])
    expect(vi.mocked(port.streamRoute).mock.calls).toEqual([[STREAM, 'turn'], [STREAM, null]])
    expect(port.streamTransportError).toHaveBeenCalledOnce()
    expect(vi.mocked(port.streamRefused).mock.calls).toEqual([[STREAM]])
  })

  it('a stream\'s frame that names no connection, no type, no stream or no route is dropped', () => {
    const { options, port } = setup()
    for (const payload of [
      { kind: 'client_stream', grant: 'g1', type: 'agent_browser_open', payload: {}, asker }, { kind: 'client_stream', grant: 'g1', connection: 7, type: 'agent_browser_open', asker },
      { kind: 'client_stream', grant: 'g1', connection: 'c1', payload: {}, asker },
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
    expect(api.clients.streamFrame!('c1', 'agent_browser_close', { streamId: STREAM, reason: 'agent' })).toBe(false)
    const screen = (seq: number, ...bytes: number[]) => encodeTerminalLocal({ kind: TerminalBinaryKind.browser, streamId: STREAM, seq, bytes: Uint8Array.from(bytes), compressed: false })!
    expect(api.clients.streamBytes!(screen(0, 1))).toBe(false)
    const notice = vi.fn()
    const sendBinary = vi.fn((_bytes: Uint8Array) => true)
    options.onConnected!({ query: async () => ({}), notice, sendBinary } satisfies CoreConnection)
    options.onEvent!({ kind: 'client_stream', grant: 'g1', connection: 'c1', type: 'agent_browser_open', payload: { requestId: 'g1' }, asker })
    expect(api.clients.streamFrame!('c1', 'agent_browser_open_result', { requestId: 'g1', streamId: STREAM })).toBe(true)
    expect(notice.mock.calls).toEqual([['client_stream', { grant: 'g1', type: 'agent_browser_open_result', payload: { requestId: 'g1', streamId: STREAM } }]])
    // The service's own frame, a terminal's plain one that names the stream, goes on the link as it is.
    const frame = screen(7, 4, 5)
    expect(api.clients.streamBytes!(frame)).toBe(true)
    expect(sendBinary.mock.calls[0]![0]).toBe(frame)
    // What the link would not take ends the stream (agentBrowser/streams.ts).
    sendBinary.mockReturnValueOnce(false)
    expect(api.clients.streamBytes!(screen(8, 6))).toBe(false)
    expect(sendBinary).toHaveBeenCalledTimes(2)
    // A link that carries no notices or no bytes takes neither.
    options.onDisconnected!()
    options.onConnected!({ query: async () => ({}) } satisfies CoreConnection)
    expect(api.clients.streamFrame!('c1', 'agent_browser_close', { streamId: STREAM })).toBe(false)
    expect(api.clients.streamBytes!(screen(9, 6))).toBe(false)
  })

  // The core that went forgot every stream it held and told their panels so. An exec left piping a still screen sends
  // nothing that would end it, and holds one of its browser's four viewer places.
  it('ends every viewer\'s streams when the core goes, once each', () => {
    const { options, port } = setup()
    options.onConnected!({ query: async () => ({}) } satisfies CoreConnection)
    options.onEvent!({ kind: 'client_stream', grant: 'g1', connection: 'c1', type: 'agent_browser_open', payload: { requestId: 'r-1' }, asker })
    options.onEvent!({ kind: 'client_stream', grant: 'g1', connection: 'c1', type: 'agent_browser_ack', payload: {}, asker })
    options.onEvent!({ kind: 'client_stream', grant: 'g1', connection: 'c2', type: 'agent_browser_open', payload: { requestId: 'r-2' }, asker })
    options.onEvent!({ kind: 'client_stream', grant: 'g1', connection: 'c3', type: 'agent_browser_open', payload: { requestId: 'r-3' }, asker })
    // One whose connection ended already was told so then.
    options.onConnectionClosed!('c3')
    expect(vi.mocked(port.streamClosed).mock.calls).toEqual([['c3']])
    vi.mocked(port.streamClosed).mockClear()
    options.onDisconnected!()
    expect(vi.mocked(port.streamClosed).mock.calls).toEqual([[undefined]])
    options.onDisconnected!()
    expect(port.streamClosed).toHaveBeenCalledTimes(1)
  })

  // Every window and phone that goes is said to every service. The ones that never watched a browser cost nothing, and
  // the process keeps only the connections still open that did: a stream that closed and then its window going left
  // the connection kept for good (review, 2026-11-13).
  it('forwards connection teardown without retaining a separate connection registry', () => {
    const { options, port } = setup()
    options.onConnectionClosed!('phone-1')
    expect(port.streamClosed).toHaveBeenCalledWith('phone-1')
    options.onEvent!({ kind: 'client_stream', grant: 'g1', connection: 'c1', type: 'agent_browser_open', payload: { requestId: 'r-1' }, asker })
    options.onEvent!({ kind: 'client_stream', grant: 'g1', connection: 'c1', type: 'agent_browser_close', payload: { streamId: STREAM } })
    options.onConnectionClosed!('c1')
    options.onConnectionClosed!('c1')
    expect(vi.mocked(port.streamClosed).mock.calls).toEqual([['phone-1'], ['c1'], ['c1']])
    options.onDisconnected!()
    expect(port.streamClosed).toHaveBeenCalledTimes(3)
  })

  it('asks the connected core for every agent here independently of catch-up, and a pane\'s agent, and gets no answer when the core cannot say', async () => {
    const { options, api, given } = setup()
    // Disconnected is unknown, with no catch-up or query to wait on.
    expect(await given.everyAgent!()).toBeNull()
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

  it('a core caught up with that cannot say which agents are here is no answer', async () => {
    const { options, given } = setup()
    options.onConnected!({ query: async (name: string) => { if (name === 'follow_agents') return { agents: [] }; throw new Error('gone') } } as CoreConnection)
    expect(await given.followed!()).toBe(true)
    expect(await given.everyAgent!()).toBeNull()
  })

  it('a core that never answers which agents are here is no answer after 10 s', async () => {
    vi.useFakeTimers()
    const { options, given } = setup()
    options.onConnected!({ query: () => new Promise(() => {}) } as CoreConnection)
    const asked = given.everyAgent!()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(await asked).toBeNull()
  })

  it('settings presence uses actual rows on a new core and only membership on an older core', async () => {
    const { options, given } = setup()
    expect(await given.hasAgent!('live')).toBeNull()
    let old = false
    const query = vi.fn(async (name: string) => name === 'agents' && !old
      ? { agents: [{ agentId: 'live' }, { agentId: 'stopped' }] }
      : name === 'agent_ids' ? { live: ['live'], stopped: ['stopped'] } : { error: 'UNKNOWN_QUERY' })
    options.onConnected!({ query })
    for (const id of ['live', 'stopped']) expect(await given.hasAgent!(id)).toBe(true)
    expect(await given.hasAgent!('absent')).toBe(false)
    expect(query).not.toHaveBeenCalledWith('agent_ids', {})
    old = true
    for (const id of ['live', 'stopped']) expect(await given.hasAgent!(id)).toBe(true)
    expect(await given.hasAgent!('absent')).toBe(false)
    expect(query).toHaveBeenCalledWith('agent_ids', {})
    // An old membership list supplies no Browser flags or deletion authority.
    expect(await given.everyAgent!()).toBeNull()
  })

  it.each(['rejected', 'timeout', 'malformed', 'error', 'invalid row'] as const)('a %s modern presence query remains unknown without trying the old adapter', async failure => {
    vi.useFakeTimers()
    const { options, given } = setup()
    const query = vi.fn(async (name: string): Promise<Record<string, unknown>> => {
      if (name !== 'agents') return {}
      if (failure === 'rejected') throw new Error('lost')
      if (failure === 'timeout') return new Promise(() => {})
      if (failure === 'invalid row') return { agents: [{ agent: 'a1' }] }
      return failure === 'error' ? { error: 'SERVICE_UNAVAILABLE' } : { agents: 'broken' }
    })
    options.onConnected!({ query })
    const waiting = given.hasAgent!('a1')
    await vi.advanceTimersByTimeAsync(10_000)
    expect(await waiting).toBeNull()
    expect(query).not.toHaveBeenCalledWith('agent_ids', {})
  })

  it.each(['rejected', 'timeout', 'missing', 'live not strings', 'stopped not strings'] as const)('a legacy presence answer that is %s remains unknown', async failure => {
    vi.useFakeTimers()
    const { options, given } = setup()
    const query = vi.fn(async (name: string): Promise<Record<string, unknown>> => {
      if (name !== 'agent_ids') return { error: 'UNKNOWN_QUERY' }
      if (failure === 'rejected') throw new Error('lost')
      if (failure === 'timeout') return new Promise(() => {})
      if (failure === 'missing') return { live: [] }
      return { live: failure === 'live not strings' ? [1] : [], stopped: failure === 'stopped not strings' ? [1] : [] }
    })
    options.onConnected!({ query })
    const waiting = given.hasAgent!('a1')
    await vi.advanceTimersByTimeAsync(10_000)
    expect(await waiting).toBeNull()
  })

  it.each(['agents', 'agent_ids', 'migration'] as const)('a stale %s reply after reconnect is unknown even when the connection object is reused', async phase => {
    const { options, given } = setup()
    let answer!: (value: Record<string, unknown>) => void
    const reply = new Promise<Record<string, unknown>>(resolve => { answer = resolve })
    const query = vi.fn(async (name: string) => name === (phase === 'migration' ? 'agents' : phase) ? reply : { error: 'UNKNOWN_QUERY' })
    const connection = { query }
    options.onConnected!(connection)
    const waiting = phase === 'migration' ? given.everyAgent!() : given.hasAgent!('a1')
    await vi.waitFor(() => expect(query).toHaveBeenCalledWith(phase === 'migration' ? 'agents' : phase, {}))
    options.onDisconnected!()
    options.onConnected!(connection)
    answer(phase === 'agent_ids' ? { live: ['a1'], stopped: [] } : { agents: [{ agentId: 'a1', browser: true }] })
    expect(await waiting).toBeNull()
    query.mockImplementation(async () => ({ agents: [{ agentId: 'a1' }] }))
    expect(await given.hasAgent!('a1')).toBe(true)
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
