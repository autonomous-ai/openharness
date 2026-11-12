import { describe, expect, it, vi } from 'vitest'
import type { RegisteredSession } from '../lib/registry.js'
import { fakeCore } from '../testing/fakeCore.js'
import { createAgentCleanupLink } from './agentCleanupLink.js'

const row = (agentId: string, over: Partial<RegisteredSession> = {}) => ({ agentId, sessionId: `s-${agentId}`, ...over }) as RegisteredSession

function setup() {
  const kid = row('kid', { startedBy: 'agent' })
  const mine = row('mine')
  const sessions = [kid, mine]
  const resolve = vi.fn((id: string) => sessions.find((s) => s.agentId === id || s.sessionId === id))
  const closeStarted = vi.fn(async () => ({ closed: true as const }))
  const lastActivity = vi.fn(async () => 42)
  const core = fakeCore({ agents: { resolve, closeStarted, lastActivity, live: vi.fn(() => sessions) } })
  const notify = vi.fn(() => true)
  return { link: createAgentCleanupLink(core, notify), notify, closeStarted, lastActivity, core }
}

describe('the agent cleanup in its own process, as the core sees it', () => {
  it('tells it every stop, held until it hears it', () => {
    const { link, notify } = setup()
    link.port.closed('lead')
    expect(notify).toHaveBeenCalledWith({ type: 'service_event', payload: { kind: 'closed', agentId: 'lead' } }, { untilDelivered: true })
  })

  it('tells it once that the person typed into a harness another agent started, by its agent id, and nothing of the rest', () => {
    const { link, notify } = setup()
    link.port.typed('s-kid')
    link.port.typed('kid')
    // Every keystroke into the person's own harness, or one it does not know, costs a lookup and no frame.
    link.port.typed('mine')
    link.port.typed('nobody')
    expect(notify.mock.calls).toEqual([[{ type: 'service_event', payload: { kind: 'typed', agentId: 'kid' } }, { untilDelivered: true }]])
    expect(link.port.stop()).toBeUndefined()
  })

  it('answers when a harness last moved, and closes what the core lets it, as it was asked', async () => {
    const { link, closeStarted, lastActivity } = setup()
    expect(await link.answer('lastActivity', { agentId: 'kid' })).toEqual({ at: 42 })
    expect(lastActivity).toHaveBeenCalledWith('kid')
    expect(await link.answer('closeStarted', { agentId: 'kid', mode: 'now' })).toEqual({ closed: true })
    expect(await link.answer('closeStarted', { agentId: 'kid', mode: 'idle' })).toEqual({ closed: true })
    expect(closeStarted.mock.calls).toEqual([['kid', 'now'], ['kid', 'idle']])
    // Asked wrongly, nothing is closed.
    expect(await link.answer('closeStarted', { agentId: 'kid', mode: 'inspect' })).toEqual({ error: 'INVALID_REQUEST' })
    expect(await link.answer('closeStarted', { mode: 'now' })).toEqual({ error: 'INVALID_REQUEST' })
    expect(await link.answer('lastActivity', { agentId: 7 })).toEqual({ error: 'INVALID_REQUEST' })
    expect(closeStarted).toHaveBeenCalledTimes(2)
    // The live agents, as any light service asks for them.
    expect(await link.answer('live', {})).toEqual({ agents: [row('kid', { startedBy: 'agent' }), row('mine')] })
  })

  it('closes nothing, and knows no time, in a core that cannot', async () => {
    const link = createAgentCleanupLink(fakeCore(), () => true)
    expect(await link.answer('closeStarted', { agentId: 'kid', mode: 'now' })).toEqual({ error: 'UNSUPPORTED' })
    expect(await link.answer('lastActivity', { agentId: 'kid' })).toEqual({ at: null })
  })
})
