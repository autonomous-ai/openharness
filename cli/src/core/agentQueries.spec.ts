import { describe, expect, it, vi } from 'vitest'
import type { RegisteredSession } from '../lib/registry.js'
import { fakeCore } from '../testing/fakeCore.js'
import { snapshotFixture } from '../testing/sessionSnapshot.js'
import { answerAgentQuery, answerSessionRead } from './agentQueries.js'
import { usageTarget } from '../lib/agentUsageWire.js'

const agent = (agentId: string, over: Partial<RegisteredSession> = {}) => ({ agentId, sessionId: `s-${agentId}`, engine: 'claude', cwd: `/work/${agentId}`, ...over }) as RegisteredSession

describe('what a service in its own process may ask the core of the agents', () => {
  const live = [agent('a1'), agent('a2')]
  const stopped = [agent('a3', { active: false })]
  const core = fakeCore({ agents: { all: async () => [...live, ...stopped], live: () => live, advertised: () => [live[0]], displayName: (session: RegisteredSession) => `name of ${session.agentId}` } })

  it('every agent, live then stopped, with the name the apps show for it', async () => {
    expect(await answerAgentQuery(core, 'agents')).toEqual({ agents: [...live, ...stopped].map((session) => ({ ...session, displayName: `name of ${session.agentId}` })) })
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
    const core = fakeCore({ agents: { all: async () => [saved] } })
    expect(await answerAgentQuery(core, 'agentUsage')).toEqual({ error: 'STALE_USAGE_TARGET' })
    expect(await answerAgentQuery(core, 'agentUsage', { target: { ...target, cwd: '/different' } })).toEqual({ error: 'STALE_USAGE_TARGET' })
    expect(await answerAgentQuery(core, 'agentUsage', { target })).toEqual({ target, value: null })
    core.usage = async () => ({ totalTokens: 4, updatedAt: '2026-10-01T00:00:00Z' })
    expect(await answerAgentQuery(core, 'agentUsage', { target })).toMatchObject({ value: { totalTokens: 4 } })
  })

  it('forwards one bounded observation with authenticated provenance, never a payload-selected source', () => {
    const report = vi.fn(), count = vi.fn(), core = fakeCore({ count })
    const origin = { service: 'agentBrowser', report }
    expect(answerAgentQuery(core, 'count', { metric: 'agent_browser_failed_podman_old', service: 'hachi', private: 'CANARY' }, origin)).toEqual({ ok: true })
    expect(report).toHaveBeenCalledExactlyOnceWith({ kind: 'service', service: 'agentBrowser', metric: 'agent_browser_failed_podman_old' })
    expect(count).not.toHaveBeenCalled()
    // Admission belongs to the recorder; acknowledgement does not promise a stored counter.
    expect(answerAgentQuery(core, 'count', { metric: 'unrecognized_counter' }, origin)).toEqual({ ok: true })
    for (const metric of ['', 'x'.repeat(129), 'PRIVATE_CANARY', 'a-b', 'a\n', 7, null]) {
      expect(answerAgentQuery(core, 'count', { metric }, origin)).toEqual({ error: 'INVALID_REQUEST' })
    }
    expect(answerAgentQuery(core, 'count', {}, origin)).toEqual({ error: 'INVALID_REQUEST' })
    expect(report).toHaveBeenCalledTimes(2)
    // No reporting owner: work remains available and no inline counter is invoked instead.
    expect(answerAgentQuery(core, 'count', { metric: 'hachi_turns_person' })).toEqual({ ok: true })
    expect(count).not.toHaveBeenCalled()
  })

  // `harness browser` in an agent's pane names it so (core/api.ts `ofPane`), held to the command's parents' pids.
  it('the live agent of a pane and whether it is a guest\'s, held to the parents it was given', async () => {
    const ofPane = vi.fn(async (pane: string, _ancestors?: number[]) => (pane === '%7' ? { agentId: 'a1', guest: false } : pane === '%8' ? { agentId: 'kim', guest: true } : null))
    const core = fakeCore({ agents: { ofPane } })
    expect(await answerAgentQuery(core, 'agent_of_pane', { pane: '%7', ancestors: [4242, 1] })).toEqual({ agentId: 'a1', guest: false })
    expect(await answerAgentQuery(core, 'agent_of_pane', { pane: '%8', ancestors: [4343] })).toEqual({ agentId: 'kim', guest: true })
    expect(await answerAgentQuery(core, 'agent_of_pane', { pane: '%9', ancestors: [4242] })).toEqual({ agentId: null })
    // An older relay's `agent_browser_state` names its pane alone.
    expect(await answerAgentQuery(core, 'agent_of_pane', { pane: '%7' })).toEqual({ agentId: 'a1', guest: false })
    for (const payload of [{}, { pane: 7 }, { pane: '%7', ancestors: 4242 }, { pane: '%7', ancestors: [4242, '1'] }, { pane: '%7', ancestors: [-1] }, { pane: '%7', ancestors: [1.5] }]) {
      expect(await answerAgentQuery(core, 'agent_of_pane', payload), JSON.stringify(payload)).toEqual({ error: 'INVALID_REQUEST' })
    }
    expect(ofPane.mock.calls).toEqual([['%7', [4242, 1]], ['%8', [4343]], ['%9', [4242]], ['%7', undefined]])
    // A core that cannot say names none.
    expect(await answerAgentQuery(fakeCore(), 'agent_of_pane', { pane: '%7' })).toEqual({ agentId: null })
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

  // An attempt's end once read an agent's usage fresh, for the backend's costs, which went with backend S8 (#3908).
  it('answers no fresh usage read', async () => {
    const core = fakeCore({ agents: { all: async () => [...live, ...stopped], live: () => live } })
    core.usageFresh = vi.fn(async () => ({ totalTokens: 9, updatedAt: '2026-10-29T00:00:00Z' }))
    expect(await answerAgentQuery(core, 'agentUsageFresh', { agentId: 'a1' })).toEqual({ error: 'UNKNOWN_QUERY' })
    expect(core.usageFresh).not.toHaveBeenCalled()
  })
})


describe('shared session read admission', () => {
  it('serves only its two declared readers and checks exact connection at every event and after await', async () => {
    const core = fakeCore(), current = vi.fn(() => true), controller = new AbortController()
    const receive = vi.fn((_record, settled) => { settled(true); return true })
    for (const service of ['devices', 'wifi']) {
      await answerSessionRead(core, service, 'session_snapshot', receive, controller.signal, { current })
    }
    expect(receive.mock.calls.map(([record]) => record.type)).toEqual(['begin', 'end', 'begin', 'end'])
    for (const service of ['messages', 'gateway', 'unknown', '__proto__']) {
      await expect(answerSessionRead(core, service, 'session_snapshot', receive, controller.signal, { current })).rejects.toThrow('READ_NOT_DECLARED')
    }
    await expect(answerSessionRead(core, 'devices', 'view', receive, controller.signal, { current })).rejects.toThrow('READ_NOT_DECLARED')
    await expect(answerSessionRead(core, 'devices', 'session_snapshot', receive, controller.signal, {})).rejects.toThrow('SESSION_READ_UNAVAILABLE')
    current.mockReturnValue(false)
    await expect(answerSessionRead(core, 'devices', 'session_snapshot', receive, controller.signal, { current })).rejects.toThrow('SESSION_READ_UNAVAILABLE')
    current.mockReturnValue(true)
    let release!: () => void
    vi.mocked(core.agents.readSessions).mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    const old = answerSessionRead(core, 'wifi', 'session_snapshot', receive, controller.signal, { current })
    current.mockReturnValue(false); release()
    await expect(old).rejects.toThrow('SESSION_READ_UNAVAILABLE')
    current.mockReturnValue(true)
    vi.mocked(core.agents.readSessions).mockImplementationOnce(async send => {
      current.mockReturnValue(false)
      const settled = vi.fn()
      expect(send({ type: 'end', payload: { count: 0 } }, settled)).toBe(false)
      expect(settled).toHaveBeenCalledWith(false)
    })
    await expect(answerSessionRead(core, 'wifi', 'session_snapshot', receive, controller.signal, { current })).rejects.toThrow('SESSION_READ_UNAVAILABLE')
  })
})
