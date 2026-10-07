import { describe, expect, it, vi } from 'vitest'
import type { RegisteredSession } from '../lib/registry.js'
import { fakeCore } from '../testing/fakeCore.js'
import { VIEWERS_UNAVAILABLE } from './api.js'
import { createViewersLink, SURFACE_WAIT_MS, VIEWERS_BUFFER_LIMIT } from './viewersLink.js'

const agent = (over: Partial<RegisteredSession> = {}) =>
  ({ agentId: 'a1', sessionId: 's1', engine: 'claude', dsh: 'acme/blender', cwd: '/work/scene', ...over }) as RegisteredSession

const context = (over: Record<string, unknown> = {}) =>
  ({ id: 'acme/blender', name: 'Blender', viewerUrl: null, viewerName: 'Blender Viewer', verdict: null, ...over })

function setup(live: RegisteredSession | null = agent(), terminalAvailable = true) {
  const core = fakeCore({
    agents: {
      byAgent: vi.fn(() => live ?? undefined),
      terminalAvailable: vi.fn(() => terminalAvailable),
      live: vi.fn(() => [agent(), agent({ agentId: 'plain', dsh: undefined }), agent({ agentId: 'a2', dsh: 'acme/kicad' })]),
    },
  })
  const notify = vi.fn(() => true)
  const link = createViewersLink(core, notify)
  return { core, notify, link, port: link.port }
}

describe('the viewers in their own process, as the core keeps them', () => {
  it('tells the process of each agent with a harness it attaches, and of no other', () => {
    const { notify, port } = setup()
    port.attach(agent())
    port.attach(agent({ agentId: 'plain', dsh: undefined }))
    // Not held while the process is down: it asks for every agent each time it connects.
    expect(notify.mock.calls).toEqual([[{ type: 'service_event', payload: { kind: 'attach', session: agent() } }]])
  })

  it('answers a frame with the fallbacks until the process has said anything of the agent', () => {
    const { port } = setup()
    port.attach(agent())
    expect(port.frameContext(agent())).toBeNull()
    expect(port.forwardingUrl('a1')).toBeNull()
  })

  it('keeps what the process says of an attached agent, follows its viewer and sends its frame again', () => {
    const { core, link, port } = setup()
    port.attach(agent())
    const said = context({ viewerUrl: 'http://127.0.0.1:7001/' })
    expect(link.answer('context', { agentId: 'a1', context: said, forwardingUrl: 'http://127.0.0.1:7001/', requestId: 'q1', query: 'context' })).toEqual({ kept: true })
    expect(port.frameContext(agent())).toEqual(said)
    expect(port.forwardingUrl('a1')).toBe('http://127.0.0.1:7001/')
    expect(core.agents.sync).toHaveBeenCalledWith(agent())
    // An agent without a harness has nothing to say on its frame, whatever was kept under its id.
    expect(port.frameContext(agent({ dsh: undefined }))).toBeNull()
  })

  it('a change sends the frame again; no change does nothing', () => {
    const { core, link, port } = setup()
    port.attach(agent())
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
    detached.port.attach(agent())
    detached.link.answer('context', { agentId: 'a1', context: context({ viewerUrl: 'http://127.0.0.1:7001/' }), forwardingUrl: 'http://127.0.0.1:7001/' })
    expect(detached.port.frameContext(agent())).toMatchObject({ viewerUrl: 'http://127.0.0.1:7001/' })
    expect(detached.core.agents.sync).not.toHaveBeenCalled()
    const gone = setup(null)
    gone.port.attach(agent())
    gone.link.answer('context', { agentId: 'a1', context: context(), forwardingUrl: null })
    expect(gone.core.agents.sync).not.toHaveBeenCalled()
  })

  it('keeps nothing of an agent it never attached, or detached since: a word said before the detach is older than it', () => {
    const { core, link, port } = setup()
    expect(link.answer('context', { agentId: 'a1', context: context(), forwardingUrl: null })).toEqual({ kept: false })
    port.attach(agent())
    port.detach('a1')
    expect(link.answer('context', { agentId: 'a1', context: context({ viewerUrl: 'http://127.0.0.1:7001/' }), forwardingUrl: 'http://127.0.0.1:7001/' })).toEqual({ kept: false })
    expect(port.frameContext(agent())).toBeNull()
    expect(port.forwardingUrl('a1')).toBeNull()
    expect(core.agents.sync).not.toHaveBeenCalled()
    // Nor of one it cannot name.
    expect(link.answer('context', { agentId: 7, context: context() })).toEqual({ kept: false })
  })

  it('reads what does not look like a context or a URL as none', () => {
    const { link, port } = setup()
    port.attach(agent())
    link.answer('context', { agentId: 'a1', context: 'not a context', forwardingUrl: 9 })
    expect(port.frameContext(agent())).toBeNull()
    expect(port.forwardingUrl('a1')).toBeNull()
  })

  it('a detach forgets the agent, and is held until the process hears it', () => {
    const { notify, link, port } = setup()
    port.attach(agent())
    link.answer('context', { agentId: 'a1', context: context({ viewerUrl: 'http://127.0.0.1:7001/' }), forwardingUrl: 'http://127.0.0.1:7001/' })
    port.detach('a1')
    expect(notify).toHaveBeenLastCalledWith({ type: 'service_event', payload: { kind: 'detach', agentId: 'a1' } }, { untilDelivered: true })
    expect(port.frameContext(agent())).toBeNull()
    expect(port.forwardingUrl('a1')).toBeNull()
  })

  it('answers from what it last knew while the process cannot hear anything', () => {
    const { link, notify, port } = setup()
    port.attach(agent())
    link.answer('context', { agentId: 'a1', context: context({ viewerUrl: 'http://127.0.0.1:7001/' }), forwardingUrl: 'http://127.0.0.1:7001/' })
    notify.mockReturnValue(false)
    port.attach(agent())
    expect(port.frameContext(agent())).toMatchObject({ viewerUrl: 'http://127.0.0.1:7001/' })
    expect(port.forwardingUrl('a1')).toBe('http://127.0.0.1:7001/')
  })

  it('names the agents with a harness when the process asks, and refuses a question it does not know', () => {
    const { link } = setup()
    expect(link.answer('agents', {})).toEqual({ agents: [agent(), agent({ agentId: 'a2', dsh: 'acme/kicad' })] })
    expect(link.answer('session_search', {})).toEqual({ error: 'UNKNOWN_QUERY' })
  })

  it('stops nothing in the core: the viewers are the process\'s', async () => {
    const { notify, port } = setup()
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
