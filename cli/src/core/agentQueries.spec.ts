import { describe, expect, it } from 'vitest'
import type { RegisteredSession } from '../lib/registry.js'
import { fakeCore } from '../testing/fakeCore.js'
import { answerAgentQuery } from './agentQueries.js'
import { usageTarget } from '../lib/agentUsageWire.js'

const agent = (agentId: string, over: Partial<RegisteredSession> = {}) => ({ agentId, sessionId: `s-${agentId}`, engine: 'claude', cwd: `/work/${agentId}`, ...over }) as RegisteredSession

describe('what a service in its own process may ask the core of the agents', () => {
  const live = [agent('a1'), agent('a2')]
  const stopped = [agent('a3', { active: false })]
  const core = fakeCore({ agents: { all: () => [...live, ...stopped], live: () => live, advertised: () => [live[0]], displayName: (session: RegisteredSession) => `name of ${session.agentId}` } })

  it('every agent, live then stopped, with the name the apps show for it', () => {
    expect(answerAgentQuery(core, 'agents')).toEqual({ agents: [...live, ...stopped].map((session) => ({ ...session, displayName: `name of ${session.agentId}` })) })
  })

  it('the live agents, and those the apps are shown', () => {
    expect(answerAgentQuery(core, 'live')).toEqual({ agents: live })
    expect(answerAgentQuery(core, 'advertised')).toEqual({ agents: [live[0]] })
  })

  it('nothing else', () => {
    expect(answerAgentQuery(core, 'credentials')).toEqual({ error: 'UNKNOWN_QUERY' })
  })

  it('returns usage only for the exact live or stopped read target', async () => {
    const saved = agent('a', { transcriptPath: '/fixture/session', registeredAt: 1 })
    const target = usageTarget(saved)
    const core = fakeCore({ agents: { all: () => [saved] } })
    expect(await answerAgentQuery(core, 'agentUsage')).toEqual({ error: 'STALE_USAGE_TARGET' })
    expect(await answerAgentQuery(core, 'agentUsage', { target: { ...target, cwd: '/different' } })).toEqual({ error: 'STALE_USAGE_TARGET' })
    expect(await answerAgentQuery(core, 'agentUsage', { target })).toEqual({ target, value: null })
    core.usage = async () => ({ totalTokens: 4, updatedAt: '2026-10-01T00:00:00Z' })
    expect(await answerAgentQuery(core, 'agentUsage', { target })).toMatchObject({ value: { totalTokens: 4 } })
  })
})
