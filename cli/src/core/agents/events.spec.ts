import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentFrame } from '../../lib/agentFrame.js'
import type { RegisteredSession } from '../../lib/registry.js'
import { createAgentEvents, type AgentEventDeps, type AnnounceSink } from './events.js'

const agent = (over: Partial<RegisteredSession> = {}): RegisteredSession =>
  ({ agentId: 'a1', sessionId: 's1', engine: 'claude', cwd: '/work/app', ...over }) as RegisteredSession

function sink() {
  const app: Array<{ type: string; payload: Record<string, unknown> }> = []
  const dial: Array<{ type: string; payload: Record<string, unknown> }> = []
  const published: string[] = []
  let publishFails = false
  const socket: AnnounceSink = {
    send: (frame) => { app.push(frame) },
    sendCommander: (frame) => { dial.push(frame) },
    publishStoppedAgent: async (s) => {
      published.push(s.agentId)
      if (publishFails) throw new Error('socket closed')
    },
  }
  return { socket, app, dial, published, failPublish: () => { publishFails = true } }
}

/** Lets the async sync (project → send) finish. */
const settle = () => new Promise((done) => setTimeout(done, 0))

function events(over: Partial<AgentEventDeps> = {}, socket?: AnnounceSink) {
  const live = new Map<string, RegisteredSession>([['a1', agent()]])
  return createAgentEvents({
    sink: () => socket,
    terminalAvailable: () => true,
    resolve: (target) => live.get(target),
    stopped: () => null,
    project: async (s) => ({ id: s.agentId }) as unknown as AgentFrame,
    ...over,
  })
}

describe('agent events', () => {
  afterEach(() => vi.restoreAllMocks())

  it('announces an agent to the app and the dial: its frame, then its name', async () => {
    const out = sink()
    events({}, out.socket).announceSession(agent())
    await settle()
    expect(out.app.map((frame) => frame.type)).toEqual(['agent_renamed', 'agent_synced'])
    expect(out.dial.map((frame) => frame.type)).toEqual(['agent_renamed', 'agent_synced'])
    expect(out.app[0].payload).toEqual({ agentId: 'a1', name: expect.any(String), engine: 'claude' })
    expect(out.app[1].payload).toEqual({ agent: { id: 'a1' } })
  })

  it('keeps a plain terminal, and anything told so, off the dial', async () => {
    const out = sink()
    const announce = events({}, out.socket)
    announce.announceRename(agent({ engine: 'terminal' }))
    announce.announceSession(agent(), { device: false })
    await settle()
    expect(out.app.map((frame) => frame.type)).toEqual(['agent_renamed', 'agent_renamed', 'agent_synced'])
    expect(out.dial).toEqual([])
  })

  it('drops frames while there is no socket yet', async () => {
    const announce = events()
    expect(() => announce.announceSession(agent())).not.toThrow()
    await settle()
  })

  it('says so when a frame cannot be built, and carries on', async () => {
    const out = sink()
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const announce = events({ project: async () => { throw new Error('no transcript') } }, out.socket)
    announce.syncSession(agent())
    await settle()
    events({ project: async () => { throw 'gone' } }, out.socket).syncSession(agent())
    await settle()
    expect(error.mock.calls).toEqual([
      ['[cli] announceSession failed:', 'no transcript'],
      ['[cli] announceSession failed:', 'gone'],
    ])
    expect(out.app).toEqual([])
  })

  it('refreshes a live agent on the app alone when its token usage moves', async () => {
    const out = sink()
    events({}, out.socket).onTokenUsageChanged({ agentId: 'a1', sessionId: 's1', engine: 'claude' })
    await settle()
    expect(out.app.map((frame) => frame.type)).toEqual(['agent_synced'])
    expect(out.dial).toEqual([])
  })

  it('leaves a live agent whose pane is not available yet alone', async () => {
    const out = sink()
    events({ terminalAvailable: () => false }, out.socket).onTokenUsageChanged({ agentId: 'a1', sessionId: 's1', engine: 'claude' })
    await settle()
    expect(out.app).toEqual([])
  })

  it('republishes a stopped agent whose usage moved, and nothing for anyone else', async () => {
    const out = sink()
    const saved = agent({ agentId: 'a2', sessionId: 's2' })
    const announce = events({ stopped: (agentId) => agentId === 'a2' ? saved : null }, out.socket)
    announce.onTokenUsageChanged({ agentId: 'a2', sessionId: 's2', engine: 'claude' })
    // Another session of the same agent, or an engine it no longer runs: not this record.
    announce.onTokenUsageChanged({ agentId: 'a2', sessionId: 'older', engine: 'claude' })
    announce.onTokenUsageChanged({ agentId: 'a2', sessionId: 's2', engine: 'codex' })
    // The live agent's earlier session: not live, and not archived either.
    announce.onTokenUsageChanged({ agentId: 'a1', sessionId: 'older', engine: 'claude' })
    await settle()
    expect(out.published).toEqual(['a2'])
    expect(out.app).toEqual([])
  })

  it('shrugs off a stopped record that is being removed, or a publish that fails', async () => {
    const out = sink()
    events({ stopped: () => { throw new Error('archive moved') } }, out.socket)
      .onTokenUsageChanged({ agentId: 'a2', sessionId: 's2', engine: 'claude' })
    out.failPublish()
    const saved = agent({ agentId: 'a2', sessionId: 's2' })
    events({ stopped: () => saved }, out.socket).onTokenUsageChanged({ agentId: 'a2', sessionId: 's2', engine: 'claude' })
    events({ stopped: () => saved }).onTokenUsageChanged({ agentId: 'a2', sessionId: 's2', engine: 'claude' })
    await settle()
    expect(out.published).toEqual(['a2'])
  })
})
