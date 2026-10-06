import { describe, expect, it } from 'vitest'
import type { RegisteredSession } from '../lib/registry.js'
import { agentsIn, isSession, processCoreApi } from './processCoreApi.js'

const agent = (agentId: string, over: Partial<RegisteredSession> = {}) => ({ agentId, sessionId: `s-${agentId}`, engine: 'claude', cwd: `/work/${agentId}`, ...over }) as RegisteredSession

describe('the core API a light service runs on in its own process', () => {
  it('answers the agents from what the core last said, by agent id or session id', () => {
    const live = [agent('a1'), agent('a2')]
    const api = processCoreApi('/data', 'projects', { live: () => live, advertised: () => [live[1]] })
    expect(api.dataDir).toBe('/data')
    expect(api.agents.live()).toEqual(live)
    expect(api.agents.all()).toEqual(live)
    expect(api.agents.advertised()).toEqual([live[1]])
    expect(api.agents.byAgent('a2')).toEqual(live[1])
    expect(api.agents.resolve('s-a1')).toEqual(live[0])
    expect(api.agents.resolve('nobody')).toBeUndefined()
  })

  it('answers agents it was never told of as none, and what these services never ask as nothing', async () => {
    const api = processCoreApi('/data', 'usage')
    expect(api.agents.live()).toEqual([])
    expect(api.agents.advertised()).toEqual([])
    expect(api.agents.byAgent('a1')).toBeUndefined()
    expect(api.agents.displayName(agent('a1'))).toBe('')
    expect(api.agents.terminalAvailable('a1')).toBe(false)
    // Only the core launches a terminal (#893): a service in its own process is refused.
    await expect(api.terminals.open({ argv: ['/bin/sh'] } as never)).resolves.toEqual({ ok: false, error: 'SERVICE_UNAVAILABLE' })
    api.agents.sync(agent('a1'))
    await expect(api.agents.runtimeModels()).resolves.toEqual([])
    expect(api.agents.runtimeProfile(agent('a1'))).toBeNull()
    api.agents.setRuntime('a1', 'opus')
    await expect(api.agents.fork('a1')).resolves.toEqual({ ok: false, error: 'UNSUPPORTED' })
    api.turns.send('a1', 'text')
    api.turns.stop('a1')
    expect(api.turns.recent('a1', 3)).toEqual([])
    expect(api.turns.asks('a1')).toEqual([])
    api.questions.answer('a1', 'q', {})
    await expect(api.questions.answerReviewed({} as never)).resolves.toBe(false)
    expect(api.transcripts.databaseHistory(agent('a1'))).toBeUndefined()
    expect(api.external.sessions.list()).toEqual([])
    await expect(api.external.sessions.scan()).resolves.toEqual([])
    expect(api.external.open.known().size).toBe(0)
    await expect(api.external.open.fresh()).resolves.toEqual(new Map())
    await expect(api.account.mintGridName()).resolves.toBeNull()
    // A service holds no credential, and says which one asked.
    await expect(api.account.accessToken()).rejects.toThrow('usage holds no credential')
    await expect(api.account.privateGridName()).resolves.toBeNull()
    expect(api.account.machineName()).toBeNull()
    api.clients.viewerChanged('a1')
    api.clients.gridNamed('grid')
    api.clients.gridModelsChanged()
    api.clients.dshInstallStatus({ phase: 'clone' })
  })

  it('reads the agents out of the core\'s answer, and nothing out of anything else', () => {
    expect(agentsIn({ agents: [agent('a1'), { agentId: 7 }, null, 'a2'] })).toEqual([agent('a1')])
    expect(agentsIn({ error: 'QUERY_FAILED' })).toBeNull()
    expect(agentsIn(null)).toBeNull()
    expect(agentsIn(undefined)).toBeNull()
    expect(isSession(agent('a1'))).toBe(true)
    expect(isSession({ sessionId: 's' })).toBe(false)
  })
})
