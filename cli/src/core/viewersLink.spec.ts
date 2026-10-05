import { describe, expect, it, vi } from 'vitest'
import type { RegisteredSession } from '../lib/registry.js'
import { fakeCore } from '../testing/fakeCore.js'
import { createViewersLink } from './viewersLink.js'

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
    expect(core.clients.viewerChanged).toHaveBeenCalledWith('a1')
    expect(core.agents.sync).toHaveBeenCalledWith(agent())
    // An agent without a harness has nothing to say on its frame, whatever was kept under its id.
    expect(port.frameContext(agent({ dsh: undefined }))).toBeNull()
  })

  it('a change that moves no viewer sends the frame without disturbing the viewer panes; no change does nothing', () => {
    const { core, link, port } = setup()
    port.attach(agent())
    link.answer('context', { agentId: 'a1', context: context(), forwardingUrl: null })
    // Its first word moved nothing a viewer pane follows: no viewer yet.
    expect(core.clients.viewerChanged).not.toHaveBeenCalled()
    expect(core.agents.sync).toHaveBeenCalledTimes(1)
    const verdict = { ready: true, summary: 'ok', errors: 0, warnings: 0, artifact: null, phases: [], updatedAt: null }
    link.answer('context', { agentId: 'a1', context: context({ verdict }), forwardingUrl: null })
    expect(port.frameContext(agent())).toMatchObject({ verdict })
    expect(core.clients.viewerChanged).not.toHaveBeenCalled()
    expect(core.agents.sync).toHaveBeenCalledTimes(2)
    expect(link.answer('context', { agentId: 'a1', context: context({ verdict }), forwardingUrl: null })).toEqual({ kept: true })
    expect(core.agents.sync).toHaveBeenCalledTimes(2)
  })

  it('follows a viewer URL that moves even when nothing forwards to it', () => {
    const { core, link, port } = setup()
    port.attach(agent())
    link.answer('context', { agentId: 'a1', context: context({ viewerUrl: 'http://elsewhere.test/' }), forwardingUrl: null })
    expect(core.clients.viewerChanged).toHaveBeenCalledWith('a1')
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

  it('a detach forgets the agent, lets the viewer panes go of a viewer it had, and is held until the process hears it', () => {
    const { core, notify, link, port } = setup()
    port.attach(agent())
    link.answer('context', { agentId: 'a1', context: context({ viewerUrl: 'http://127.0.0.1:7001/' }), forwardingUrl: 'http://127.0.0.1:7001/' })
    vi.mocked(core.clients.viewerChanged).mockClear()
    port.detach('a1')
    expect(core.clients.viewerChanged).toHaveBeenCalledWith('a1')
    expect(notify).toHaveBeenLastCalledWith({ type: 'service_event', payload: { kind: 'detach', agentId: 'a1' } }, { untilDelivered: true })
    expect(port.frameContext(agent())).toBeNull()
    // One with no viewer, or never heard of, has no viewer pane to let go of.
    vi.mocked(core.clients.viewerChanged).mockClear()
    port.attach(agent({ agentId: 'a2' }))
    link.answer('context', { agentId: 'a2', context: null, forwardingUrl: null })
    port.detach('a2')
    port.detach('never')
    expect(core.clients.viewerChanged).not.toHaveBeenCalled()
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
