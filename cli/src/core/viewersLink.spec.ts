import { describe, expect, it, vi } from 'vitest'
import type { RegisteredSession } from '../lib/registry.js'
import { fakeCore } from '../testing/fakeCore.js'
import { createAgentLife } from './agentLife.js'
import { VIEWERS_UNAVAILABLE } from './api.js'
import { createViewersLink, SURFACE_WAIT_MS } from './viewersLink.js'

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
  const link = createViewersLink(core)
  const unfollow = link.follow()
  return { core, notify, link, port: link.port, hub, unfollow }
}

describe('the viewers in their own process, as the core keeps them', () => {
  it('tells the process nothing of agents itself: it follows them as every service does (core/agentLife.ts)', () => {
    const { notify, hub } = setup()
    hub.running(agent())
    hub.running(agent({ agentId: 'plain', dsh: undefined }))
    // What else agents do is not the viewers' business.
    hub.stopped('a1')
    hub.purged('a1', ['s1'])
    hub.ended('a1')
    expect(notify).not.toHaveBeenCalled()
  })

  it('keeps nothing once it stops following, and follows nothing in a core that lends no following', () => {
    const { link, hub, unfollow } = setup()
    unfollow()
    hub.running(agent())
    expect(link.answer('viewer_target', { agentId: 'a1', context: context(), forwardingUrl: null })).toEqual({ kept: false })
    const bare = createViewersLink(fakeCore())
    expect(() => bare.follow()()).not.toThrow()
  })

  it('answers a frame with the fallbacks until the process has said anything of the agent', () => {
    const { port, hub } = setup()
    hub.running(agent())
    expect(port.forwardingUrl('a1')).toBeNull()
  })

  it('keeps the forwarding target separately from frame publication', () => {
    const { core, link, port, hub } = setup()
    hub.running(agent())
    const said = context({ viewerUrl: 'http://127.0.0.1:7001/' })
    expect(link.answer('viewer_target', { agentId: 'a1', context: said, forwardingUrl: 'http://127.0.0.1:7001/', requestId: 'q1', query: 'viewer_target' })).toEqual({ kept: true })
    expect(port.forwardingUrl('a1')).toBe('http://127.0.0.1:7001/')
    expect(core.agents.sync).not.toHaveBeenCalled()
    // An agent without a harness has nothing to say on its frame, whatever was kept under its id.
  })

  it('a legacy context never publishes a frame without its lifecycle lease', () => {
    const { core, link, port, hub } = setup()
    hub.running(agent())
    link.answer('viewer_target', { agentId: 'a1', context: context(), forwardingUrl: null })
    expect(core.agents.sync).not.toHaveBeenCalled()
    const verdict = { ready: true, summary: 'ok', errors: 0, warnings: 0, artifact: null, phases: [], updatedAt: null }
    link.answer('viewer_target', { agentId: 'a1', context: context({ verdict }), forwardingUrl: null })
    expect(core.agents.sync).not.toHaveBeenCalled()
    expect(link.answer('viewer_target', { agentId: 'a1', context: context({ verdict }), forwardingUrl: null })).toEqual({ kept: true })
    expect(core.agents.sync).not.toHaveBeenCalled()
  })

  it('waits for the terminal before sending a frame, which would otherwise read as "agent gone"', () => {
    const detached = setup(agent(), false)
    detached.hub.running(agent())
    detached.link.answer('viewer_target', { agentId: 'a1', context: context({ viewerUrl: 'http://127.0.0.1:7001/' }), forwardingUrl: 'http://127.0.0.1:7001/' })
    expect(detached.core.agents.sync).not.toHaveBeenCalled()
    const gone = setup(null)
    gone.hub.running(agent())
    gone.link.answer('viewer_target', { agentId: 'a1', context: context(), forwardingUrl: null })
    expect(gone.core.agents.sync).not.toHaveBeenCalled()
  })

  it('keeps nothing of an agent it never attached, or detached since: a word said before the detach is older than it', () => {
    const { core, link, port, hub } = setup()
    expect(link.answer('viewer_target', { agentId: 'a1', context: context(), forwardingUrl: null })).toEqual({ kept: false })
    hub.running(agent())
    hub.ended('a1')
    expect(link.answer('viewer_target', { agentId: 'a1', context: context({ viewerUrl: 'http://127.0.0.1:7001/' }), forwardingUrl: 'http://127.0.0.1:7001/' })).toEqual({ kept: false })
    expect(port.forwardingUrl('a1')).toBeNull()
    expect(core.agents.sync).not.toHaveBeenCalled()
    // Nor of one it cannot name.
    expect(link.answer('viewer_target', { agentId: 7, context: context() })).toEqual({ kept: false })
  })

  it('reads what does not look like a context or a URL as none', () => {
    const { link, port, hub } = setup()
    hub.running(agent())
    link.answer('viewer_target', { agentId: 'a1', context: 'not a context', forwardingUrl: 9 })
    expect(port.forwardingUrl('a1')).toBeNull()
  })

  it('an end forgets the agent, and holds nothing for the process: its catch-up as it connects finds the end', () => {
    const { notify, link, port, hub } = setup()
    hub.running(agent())
    link.answer('viewer_target', { agentId: 'a1', context: context({ viewerUrl: 'http://127.0.0.1:7001/' }), forwardingUrl: 'http://127.0.0.1:7001/' })
    hub.ended('a1')
    expect(notify).not.toHaveBeenCalled()
    expect(port.forwardingUrl('a1')).toBeNull()
  })

  it('answers from what it last knew while the process cannot hear anything', () => {
    const { link, notify, port, hub } = setup()
    hub.running(agent())
    link.answer('viewer_target', { agentId: 'a1', context: context({ viewerUrl: 'http://127.0.0.1:7001/' }), forwardingUrl: 'http://127.0.0.1:7001/' })
    notify.mockReturnValue(false)
    hub.running(agent())
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

describe('rendered viewer surfaces', () => {
  it('asks the process with the owning connection and a bounded deadline', async () => {
    const call = vi.fn(async () => ({ data: 'jpeg' }))
    const link = createViewersLink(fakeCore(), { call })
    await expect(link.port.surface('c1', { surfaceId: 'v' })).resolves.toEqual({ data: 'jpeg' })
    expect(call).toHaveBeenCalledWith('surface', { surfaceId: 'v', connId: 'c1' }, SURFACE_WAIT_MS)
  })
  it('answers unavailable with no process', async () => {
    await expect(createViewersLink(fakeCore()).port.surface('c1', {})).resolves.toEqual(VIEWERS_UNAVAILABLE)
  })
})
