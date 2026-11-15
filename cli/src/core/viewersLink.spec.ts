import { describe, expect, it, vi } from 'vitest'
import type { RegisteredSession } from '../lib/registry.js'
import { fakeCore } from '../testing/fakeCore.js'
import { createAgentLife } from './agentLife.js'
import { VIEWERS_UNAVAILABLE } from './api.js'
import { ON_DEMAND_START_MS } from './serviceLinks.js'
import { createViewersLink, SURFACE_WAIT_MS, VIEWERS_BUFFER_LIMIT } from './viewersLink.js'

const agent = (over: Partial<RegisteredSession> = {}) =>
  ({ agentId: 'a1', sessionId: 's1', engine: 'claude', dsh: 'acme/blender', cwd: '/work/scene', ...over }) as RegisteredSession

const context = (over: Record<string, unknown> = {}) =>
  ({ id: 'acme/blender', name: 'Blender', viewerUrl: null, viewerName: 'Blender Viewer', verdict: null, ...over })

/** What happens to agents, as the core tells whoever follows them (core/agentLife.ts): a look at one, its end. */
const lives = () => createAgentLife({ live: () => [], notify: () => true, hears: {} })

function setup(live: RegisteredSession | null = agent(), terminalAvailable = true) {
  const hub = lives()
  const core = fakeCore({
    agents: {
      byAgent: vi.fn(() => live ?? undefined),
      terminalAvailable: vi.fn(() => terminalAvailable),
      follow: hub.follow,
    },
  })
  const notify = vi.fn(() => true)
  const link = createViewersLink(core, notify)
  const unfollow = link.follow()
  return { core, notify, link, port: link.port, hub, unfollow }
}

describe('the viewers in their own process, as the core keeps them', () => {
  it('tells the process nothing of agents itself: it follows them as every service does (core/agentLife.ts)', () => {
    const { notify, hub } = setup()
    hub.running(agent())
    hub.running(agent({ agentId: 'plain', dsh: undefined }))
    hub.ended('a1')
    expect(notify).not.toHaveBeenCalled()
  })

  it('keeps nothing once it stops following, and follows nothing in a core that lends no following', () => {
    const { link, hub, unfollow } = setup()
    unfollow()
    hub.running(agent())
    expect(link.answer('context', { agentId: 'a1', context: context(), forwardingUrl: null })).toEqual({ kept: false })
    const bare = createViewersLink(fakeCore(), vi.fn(() => true))
    expect(() => bare.follow()()).not.toThrow()
  })

  it('answers a frame with the fallbacks until the process has said anything of the agent', () => {
    const { port, hub } = setup()
    hub.running(agent())
    expect(port.frameContext(agent())).toBeNull()
    expect(port.forwardingUrl('a1')).toBeNull()
  })

  it('keeps what the process says of an attached agent, follows its viewer and sends its frame again', () => {
    const { core, link, port, hub } = setup()
    hub.running(agent())
    const said = context({ viewerUrl: 'http://127.0.0.1:7001/' })
    expect(link.answer('context', { agentId: 'a1', context: said, forwardingUrl: 'http://127.0.0.1:7001/', requestId: 'q1', query: 'context' })).toEqual({ kept: true })
    expect(port.frameContext(agent())).toEqual(said)
    expect(port.forwardingUrl('a1')).toBe('http://127.0.0.1:7001/')
    expect(core.agents.sync).toHaveBeenCalledWith(agent())
    // An agent without a harness has nothing to say on its frame, whatever was kept under its id.
    expect(port.frameContext(agent({ dsh: undefined }))).toBeNull()
  })

  it('a change sends the frame again; no change does nothing', () => {
    const { core, link, port, hub } = setup()
    hub.running(agent())
    link.answer('context', { agentId: 'a1', context: context(), forwardingUrl: null })
    expect(core.agents.sync).toHaveBeenCalledTimes(1)
    const verdict = { ready: true, summary: 'ok', errors: 0, warnings: 0, artifact: null, phases: [], updatedAt: null }
    link.answer('context', { agentId: 'a1', context: context({ verdict }), forwardingUrl: null })
    expect(port.frameContext(agent())).toMatchObject({ verdict })
    expect(core.agents.sync).toHaveBeenCalledTimes(2)
    expect(link.answer('context', { agentId: 'a1', context: context({ verdict }), forwardingUrl: null })).toEqual({ kept: true })
    expect(core.agents.sync).toHaveBeenCalledTimes(2)
  })

  it('waits for the terminal before sending a frame, which would otherwise read as "agent gone"', () => {
    const detached = setup(agent(), false)
    detached.hub.running(agent())
    detached.link.answer('context', { agentId: 'a1', context: context({ viewerUrl: 'http://127.0.0.1:7001/' }), forwardingUrl: 'http://127.0.0.1:7001/' })
    expect(detached.port.frameContext(agent())).toMatchObject({ viewerUrl: 'http://127.0.0.1:7001/' })
    expect(detached.core.agents.sync).not.toHaveBeenCalled()
    const gone = setup(null)
    gone.hub.running(agent())
    gone.link.answer('context', { agentId: 'a1', context: context(), forwardingUrl: null })
    expect(gone.core.agents.sync).not.toHaveBeenCalled()
  })

  it('keeps nothing of an agent it never attached, or detached since: a word said before the detach is older than it', () => {
    const { core, link, port, hub } = setup()
    expect(link.answer('context', { agentId: 'a1', context: context(), forwardingUrl: null })).toEqual({ kept: false })
    hub.running(agent())
    hub.ended('a1')
    expect(link.answer('context', { agentId: 'a1', context: context({ viewerUrl: 'http://127.0.0.1:7001/' }), forwardingUrl: 'http://127.0.0.1:7001/' })).toEqual({ kept: false })
    expect(port.frameContext(agent())).toBeNull()
    expect(port.forwardingUrl('a1')).toBeNull()
    expect(core.agents.sync).not.toHaveBeenCalled()
    // Nor of one it cannot name.
    expect(link.answer('context', { agentId: 7, context: context() })).toEqual({ kept: false })
  })

  it('reads what does not look like a context or a URL as none', () => {
    const { link, port, hub } = setup()
    hub.running(agent())
    link.answer('context', { agentId: 'a1', context: 'not a context', forwardingUrl: 9 })
    expect(port.frameContext(agent())).toBeNull()
    expect(port.forwardingUrl('a1')).toBeNull()
  })

  it('an end forgets the agent, and holds nothing for the process: its catch-up as it connects finds the end', () => {
    const { notify, link, port, hub } = setup()
    hub.running(agent())
    link.answer('context', { agentId: 'a1', context: context({ viewerUrl: 'http://127.0.0.1:7001/' }), forwardingUrl: 'http://127.0.0.1:7001/' })
    hub.ended('a1')
    expect(notify).not.toHaveBeenCalled()
    expect(port.frameContext(agent())).toBeNull()
    expect(port.forwardingUrl('a1')).toBeNull()
  })

  it('answers from what it last knew while the process cannot hear anything', () => {
    const { link, notify, port, hub } = setup()
    hub.running(agent())
    link.answer('context', { agentId: 'a1', context: context({ viewerUrl: 'http://127.0.0.1:7001/' }), forwardingUrl: 'http://127.0.0.1:7001/' })
    notify.mockReturnValue(false)
    hub.running(agent())
    expect(port.frameContext(agent())).toMatchObject({ viewerUrl: 'http://127.0.0.1:7001/' })
    expect(port.forwardingUrl('a1')).toBe('http://127.0.0.1:7001/')
  })

  it('refuses a question it does not know: which agents have a harness the process asks as it follows them', () => {
    const { link, hub } = setup()
    expect(link.answer('agents', {})).toEqual({ error: 'UNKNOWN_QUERY' })
    expect(link.answer('session_search', {})).toEqual({ error: 'UNKNOWN_QUERY' })
  })

  it('stops nothing in the core: the viewers are the process\'s', async () => {
    const { notify, port, hub } = setup()
    await expect(port.stop()).resolves.toBeUndefined()
    expect(notify).not.toHaveBeenCalled()
  })
})

describe('a viewer served to a client over its connection, through the viewers\' process', () => {
  const streaming = (buffered = 0) => {
    const core = fakeCore()
    const notify = vi.fn(() => true)
    const call = vi.fn(async (_type: string, payload: Record<string, unknown>) => ({ data: 'jpeg', asked: payload }))
    const link = createViewersLink(core, notify, { call, buffered: () => buffered })
    return { core, notify, call, link, port: link.port }
  }

  it('tells the process each frame of a client\'s stream as it comes, never held for a process that is down', () => {
    const { notify, port } = streaming()
    expect(port.stream('c1', 'viewer_request', { streamId: 's1' })).toBe(true)
    expect(notify).toHaveBeenCalledWith({ type: 'service_event', payload: { kind: 'stream', connId: 'c1', type: 'viewer_request', frame: { streamId: 's1' } } })
    notify.mockReturnValue(false)
    expect(port.stream('c1', 'viewer_data', { streamId: 's1' })).toBe(false)
    expect(notify).toHaveBeenCalledTimes(2)
  })

  it('refuses a stream\'s frame while the process is not reading, rather than keep it', () => {
    const { notify, port } = streaming(VIEWERS_BUFFER_LIMIT + 1)
    expect(port.stream('c1', 'viewer_request', { streamId: 's1' })).toBe(false)
    expect(notify).not.toHaveBeenCalled()
  })

  it('asks the process for a client\'s rendered frame, with the connection it came over, waiting no longer than a client does', async () => {
    const { call, port } = streaming()
    await expect(port.surface('c1', { surfaceId: 'v' })).resolves.toEqual({ data: 'jpeg', asked: { surfaceId: 'v', connId: 'c1' } })
    expect(call).toHaveBeenCalledWith('surface', { surfaceId: 'v', connId: 'c1' }, SURFACE_WAIT_MS)
  })

  it('without a link to the process, a surface is answered unavailable and a stream is not taken', async () => {
    const link = createViewersLink(fakeCore(), vi.fn(() => false))
    await expect(link.port.surface('c1', {})).resolves.toEqual(VIEWERS_UNAVAILABLE)
    expect(link.port.stream('c1', 'viewer_request', { streamId: 's1' })).toBe(false)
  })

  it('tells the process a connection went, or every one did', () => {
    const { notify, port } = streaming()
    port.closed('c1')
    port.closed()
    expect(notify.mock.calls).toEqual([
      [{ type: 'service_event', payload: { kind: 'closed', connId: 'c1' } }],
      [{ type: 'service_event', payload: { kind: 'closed' } }],
    ])
  })

  it('hands what a stream answers to its connection, and ends the stream in the process when it cannot', () => {
    const { core, notify, link } = streaming()
    vi.mocked(core.clients.viewerFrame).mockReturnValue(true)
    link.notice({ kind: 'viewer', connId: 'c1', type: 'viewer_response', payload: { streamId: 's1', status: 200 } })
    expect(core.clients.viewerFrame).toHaveBeenCalledWith('c1', 'viewer_response', { streamId: 's1', status: 200 })
    expect(notify).not.toHaveBeenCalled()
    vi.mocked(core.clients.viewerFrame).mockReturnValue(false)
    link.notice({ kind: 'viewer', connId: 'c1', type: 'viewer_data', payload: { streamId: 's1', data: 'AA==' } })
    expect(notify).toHaveBeenCalledWith({ type: 'service_event', payload: {
      kind: 'stream', connId: 'c1', type: 'viewer_close', frame: { streamId: 's1', error: 'Viewer connection closed' },
    } })
    // A close that could not be delivered, or a frame of no stream, needs nothing more.
    link.notice({ kind: 'viewer', connId: 'c1', type: 'viewer_close', payload: { streamId: 's1' } })
    link.notice({ kind: 'viewer', connId: 'c1', type: 'viewer_data' })
    expect(notify).toHaveBeenCalledTimes(1)
    expect(core.clients.viewerFrame).toHaveBeenLastCalledWith('c1', 'viewer_data', {})
  })

  it('ignores a notice that is not a stream\'s frame for a connection', () => {
    const { core, link } = streaming()
    link.notice({ kind: 'other', connId: 'c1', type: 'viewer_data' })
    link.notice({ kind: 'viewer', connId: 7, type: 'viewer_data' })
    link.notice({ kind: 'viewer', connId: 'c1' })
    expect(core.clients.viewerFrame).not.toHaveBeenCalled()
  })
})

describe('the viewers\' process on demand (core/viewersWake.ts)', () => {
  const onDemand = (connected = true) => {
    const hub = lives()
    const core = fakeCore({ agents: { follow: hub.follow } })
    vi.mocked(core.clients.viewerFrame).mockReturnValue(true)
    const notify = vi.fn(() => connected)
    const wake = vi.fn()
    const timers: Array<{ run: () => void; ms: number; cleared: boolean }> = []
    const link = createViewersLink(core, notify, { call: vi.fn(async () => ({})), buffered: () => 0 }, {
      wake,
      startWaitMs: 5_000,
      setTimer: (run, ms) => { const timer = { run, ms, cleared: false }; timers.push(timer); return timer },
      clearTimer: (timer) => { (timer as { cleared: boolean }).cleared = true },
    })
    link.follow()
    return { core, notify, wake, timers, link, port: link.port, hub }
  }
  const stream = (connId: string, type: string, streamId = 's1') =>
    ({ type: 'service_event', payload: { kind: 'stream', connId, type, frame: { streamId } } })

  it('asks for the process for an agent with a harness, and not for one without', () => {
    const { wake, hub } = onDemand()
    hub.running(agent({ agentId: 'plain', dsh: undefined }))
    expect(wake).not.toHaveBeenCalled()
    hub.running(agent())
    expect(wake).toHaveBeenCalledWith('a harness here')
  })

  it('holds a stream that comes before the process ever connected, asks for it once, and tells it every frame in order once it connects', () => {
    const { core, notify, wake, timers, link, port } = onDemand()
    expect(port.stream('c1', 'viewer_request', { streamId: 's1' })).toBe(true)
    expect(port.stream('c2', 'viewer_request', { streamId: 's2' })).toBe(true)
    expect(port.stream('c1', 'viewer_data', { streamId: 's1' })).toBe(true)
    expect(wake.mock.calls).toEqual([['a viewer stream']])
    expect(timers).toHaveLength(1)
    expect(timers[0].ms).toBe(5_000)
    expect(notify).not.toHaveBeenCalled()
    link.connected()
    expect(timers[0].cleared).toBe(true)
    expect(notify.mock.calls).toEqual([[stream('c1', 'viewer_request')], [stream('c2', 'viewer_request', 's2')], [stream('c1', 'viewer_data')]])
    expect(core.clients.viewerFrame).not.toHaveBeenCalled()
    // Connected once, a frame is told as it comes, and refused at once while the process is down again.
    notify.mockReturnValue(false)
    expect(port.stream('c1', 'viewer_data', { streamId: 's1' })).toBe(false)
    expect(timers).toHaveLength(1)
  })

  it('refuses what it held, and every stream after it at once, when the process does not connect within a start\'s wait', () => {
    const { core, notify, wake, timers, link, port } = onDemand(false)
    port.stream('c1', 'viewer_request', { streamId: 's1' })
    port.stream('c1', 'viewer_close', { streamId: 's1' })
    port.stream('c1', 'viewer_data', {})
    timers[0].run()
    // Only the stream's own frames that need an answer are answered: a close and a frame of no stream need none.
    expect(core.clients.viewerFrame).toHaveBeenCalledTimes(1)
    expect(core.clients.viewerFrame).toHaveBeenCalledWith('c1', 'viewer_close', { streamId: 's1', error: 'Viewer is no longer available' })
    expect(port.stream('c1', 'viewer_request', { streamId: 's2' })).toBe(false)
    expect(notify).toHaveBeenCalledTimes(1)
    expect(wake).toHaveBeenCalledTimes(1)
    // It came at last: streams go to it again.
    notify.mockReturnValue(true)
    link.connected()
    expect(port.stream('c1', 'viewer_request', { streamId: 's3' })).toBe(true)
    expect(notify).toHaveBeenLastCalledWith(stream('c1', 'viewer_request', 's3'))
  })

  it('refuses a held frame the process does not take as it connects', () => {
    const { core, notify, link, port } = onDemand(false)
    port.stream('c1', 'viewer_request', { streamId: 's1' })
    link.connected()
    expect(notify).toHaveBeenCalledWith(stream('c1', 'viewer_request'))
    expect(core.clients.viewerFrame).toHaveBeenCalledWith('c1', 'viewer_close', { streamId: 's1', error: 'Viewer is no longer available' })
  })

  it('holds no more than a hung process\'s socket may keep: past it, a frame is refused', () => {
    const { port } = onDemand()
    const chunk = 'A'.repeat(VIEWERS_BUFFER_LIMIT / 2)
    expect(port.stream('c1', 'viewer_data', { streamId: 's1', data: chunk })).toBe(true)
    expect(port.stream('c1', 'viewer_data', { streamId: 's1', data: chunk })).toBe(false)
    expect(port.stream('c1', 'viewer_close', { streamId: 's1' })).toBe(true)
  })

  it('drops what it held for a connection that closed, or for every one', () => {
    const { notify, link, port } = onDemand()
    port.stream('c1', 'viewer_request', { streamId: 's1' })
    port.stream('c2', 'viewer_request', { streamId: 's2' })
    port.closed('c1')
    link.connected()
    expect(notify.mock.calls).toEqual([
      [{ type: 'service_event', payload: { kind: 'closed', connId: 'c1' } }],
      [stream('c2', 'viewer_request', 's2')],
    ])
    const again = onDemand()
    again.port.stream('c1', 'viewer_request', { streamId: 's1' })
    again.port.closed()
    again.link.connected()
    expect(again.notify.mock.calls).toEqual([[{ type: 'service_event', payload: { kind: 'closed' } }]])
  })

  it('waits a start\'s wait by default, on the real clock', () => {
    vi.useFakeTimers()
    try {
      const core = fakeCore()
      const link = createViewersLink(core, vi.fn(() => false), undefined, { wake: vi.fn() })
      link.port.stream('c1', 'viewer_request', { streamId: 's1' })
      vi.advanceTimersByTime(ON_DEMAND_START_MS - 1)
      expect(core.clients.viewerFrame).not.toHaveBeenCalled()
      vi.advanceTimersByTime(1)
      expect(core.clients.viewerFrame).toHaveBeenCalledWith('c1', 'viewer_close', { streamId: 's1', error: 'Viewer is no longer available' })
      // Connected, the default clock's timer is cleared too.
      link.port.stream('c1', 'viewer_request', { streamId: 's2' })
      const other = createViewersLink(core, vi.fn(() => true), undefined, { wake: vi.fn() })
      other.port.stream('c1', 'viewer_request', { streamId: 's3' })
      other.connected()
      vi.advanceTimersByTime(ON_DEMAND_START_MS)
      expect(core.clients.viewerFrame).toHaveBeenCalledTimes(1)
    } finally { vi.useRealTimers() }
  })
})
