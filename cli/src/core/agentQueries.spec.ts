import { describe, expect, it } from 'vitest'
import type { RegisteredSession } from '../lib/registry.js'
import { fakeCore } from '../testing/fakeCore.js'
import { answerAgentQuery } from './agentQueries.js'

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
})
