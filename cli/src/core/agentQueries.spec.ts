import { describe, expect, it, vi } from 'vitest'
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

  it('hands on one of Hachi\'s daemon counters, and refuses any other name', () => {
    const count = vi.fn()
    const core = fakeCore({ count })
    expect(answerAgentQuery(core, 'count', { metric: 'hachi_wake_done' })).toEqual({ ok: true })
    expect(count).toHaveBeenCalledWith('hachi_wake_done')
    // The App's, the launch twins and the person's days are counted where they happen, never by a service.
    for (const metric of ['ui_desktop_hachi_switch_on', 'launch_hachi_started_claude', 'hachi_person_turn_days', 'create_requests', 'PRIVATE_CANARY', 7]) {
      expect(answerAgentQuery(core, 'count', { metric })).toEqual({ error: 'INVALID_REQUEST' })
    }
    expect(answerAgentQuery(core, 'count')).toEqual({ error: 'INVALID_REQUEST' })
    expect(count).toHaveBeenCalledTimes(1)
    // A core that offers no counter takes it and counts nothing.
    expect(answerAgentQuery(fakeCore(), 'count', { metric: 'hachi_turns_person' })).toEqual({ ok: true })
  })

  // Hachi 5a (OPENHARNES-15): the goals in the edge host tell the windows a goal closed; the core decides whose it is
  // (createCoreApi `clients.hachiGoalDone`), and is handed the goal's three fields alone.
  it('hands on a goal Hachi closed, for the windows, with its three fields alone', () => {
    const hachiGoalDone = vi.fn()
    const core = fakeCore({ clients: { hachiGoalDone } })
    expect(answerAgentQuery(core, 'hachi_goal_done', { agentId: 'hachi', goalId: 'g1', title: 'flaky login test', extra: 1 })).toEqual({ ok: true })
    expect(hachiGoalDone).toHaveBeenCalledWith({ agentId: 'hachi', goalId: 'g1', title: 'flaky login test' })
    // A core that offers no way to the windows takes it and tells nobody.
    expect(answerAgentQuery(fakeCore(), 'hachi_goal_done', { agentId: 'hachi', goalId: 'g1', title: 't' })).toEqual({ ok: true })
  })

  // A Swarm attempt's end read an agent's usage fresh, for the backend's costs, which went with backend S8 (#3908).
  it('answers no fresh usage read', async () => {
    const core = fakeCore({ agents: { all: () => [...live, ...stopped], live: () => live } })
    core.usageFresh = vi.fn(async () => ({ totalTokens: 9, updatedAt: '2026-10-29T00:00:00Z' }))
    expect(await answerAgentQuery(core, 'agentUsageFresh', { agentId: 'a1' })).toEqual({ error: 'UNKNOWN_QUERY' })
    expect(core.usageFresh).not.toHaveBeenCalled()
  })
})
