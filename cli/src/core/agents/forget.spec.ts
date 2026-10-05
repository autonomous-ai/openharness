import { afterEach, describe, expect, it, vi } from 'vitest'
import { removeCursorPendingTasks } from '../../engines/cursor/pendingTasks.js'
import type { RegisteredSession } from '../../lib/registry.js'
import { createForgetSession, type ForgetDeps } from './forget.js'

vi.mock('../../engines/cursor/pendingTasks.js', () => ({ removeCursorPendingTasks: vi.fn(async () => {}) }))

function setup() {
  const agents = new Map<string, RegisteredSession>([
    ['a1', { agentId: 'a1', sessionId: 's1', engine: 'claude' } as RegisteredSession],
    ['s1', { agentId: 'a1', sessionId: 's1', engine: 'claude' } as RegisteredSession],
    ['fresh', { agentId: 'fresh', sessionId: '', engine: 'claude' } as RegisteredSession],
  ])
  const deps: ForgetDeps = {
    registry: { resolve: vi.fn((id: string) => agents.get(id)), unbindSession: vi.fn(() => true), removeAgent: vi.fn(() => true), remove: vi.fn(() => true) },
    stoppedAgents: { save: vi.fn() },
    syncRecapPool: vi.fn(),
    normalizers: { forget: vi.fn() },
    turnStartedAt: new Map([['s1', 1], ['other', 2]]),
    neverFoldedHistory: new Set(['s1', 'other']),
    replayedFirstTurn: new Set(['s1', 'other']),
    clearAgyIdleWatch: vi.fn(),
    cursorDiscovery: { remove: vi.fn() },
    cursorSubagents: { forget: vi.fn() },
    runtimeProfiles: { forget: vi.fn() },
    watcher: { removeSession: vi.fn(async () => {}) },
    stopHeartbeat: vi.fn(),
    teams: { forget: vi.fn() },
    input: { forget: vi.fn() },
    deviceInput: { forget: vi.fn() },
    detachDsh: vi.fn(),
    mirror: { forget: vi.fn() },
    clients: { send: vi.fn(), sendCommander: vi.fn() },
    dataDir: '/data',
  }
  return { deps, forgetSession: createForgetSession(deps) }
}

/** Every per-session store the session must be gone from. */
function expectLetGo(deps: ForgetDeps, sessionId: string, agentId: string) {
  expect(deps.syncRecapPool).toHaveBeenCalled()
  expect(deps.normalizers.forget).toHaveBeenCalledWith(sessionId)
  expect(deps.turnStartedAt.has(sessionId)).toBe(false)
  expect(deps.neverFoldedHistory.has(sessionId)).toBe(false)
  expect(deps.replayedFirstTurn.has(sessionId)).toBe(false)
  expect(deps.turnStartedAt.has('other')).toBe(true)
  expect(deps.clearAgyIdleWatch).toHaveBeenCalledWith(sessionId)
  expect(deps.cursorDiscovery.remove).toHaveBeenCalledWith(sessionId)
  expect(deps.cursorSubagents.forget).toHaveBeenCalledWith(sessionId)
  expect(removeCursorPendingTasks).toHaveBeenCalledWith('/data', sessionId)
  expect(deps.runtimeProfiles.forget).toHaveBeenCalledWith(sessionId)
  expect(deps.watcher.removeSession).toHaveBeenCalledWith(sessionId)
  expect(deps.stopHeartbeat).toHaveBeenCalledWith(sessionId)
  expect(deps.teams.forget).toHaveBeenCalledWith(agentId)
  expect(deps.input.forget).toHaveBeenCalledWith(agentId)
  expect(deps.deviceInput.forget).toHaveBeenCalledWith(agentId)
  expect(deps.mirror.forget).toHaveBeenCalledWith(sessionId)
}

describe('forgetting a session', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.mocked(removeCursorPendingTasks).mockClear() })

  it('releases a session and keeps its agent: everything per-session goes, the agent and its tiles stay', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const { deps, forgetSession } = setup()
    forgetSession('a1', { keepAgent: true })
    expect(deps.registry.unbindSession).toHaveBeenCalledWith('s1')
    expect(deps.registry.removeAgent).not.toHaveBeenCalled()
    expect(deps.stoppedAgents.save).not.toHaveBeenCalled()
    expect(deps.detachDsh).not.toHaveBeenCalled()
    expectLetGo(deps, 's1', 'a1')
    expect(deps.clients.send).not.toHaveBeenCalled()
    expect(deps.clients.sendCommander).not.toHaveBeenCalled()
    expect(String(log.mock.calls[0][0])).toContain('released session')
  })

  it('removes an agent everywhere, archived as stopped, and tells the app and the dial', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const { deps, forgetSession } = setup()
    forgetSession('s1')
    expect(deps.stoppedAgents.save).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'a1' }))
    expect(deps.registry.removeAgent).toHaveBeenCalledWith('a1')
    expect(deps.detachDsh).toHaveBeenCalledWith('a1')
    expectLetGo(deps, 's1', 'a1')
    expect(deps.clients.send).toHaveBeenCalledWith({ type: 'agent_deleted', payload: { agentId: 'a1', retained: true } })
    expect(deps.clients.sendCommander).toHaveBeenCalledWith({ type: 'agent_deleted', payload: { agentId: 'a1' } })
    expect(String(log.mock.calls[0][0])).toContain('forgotten')
  })

  it('removes a session the registry no longer knows, announced by the agent id the caller names', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const named = setup()
    named.forgetSession('s9', { agentId: 'a9' })
    expect(named.deps.registry.remove).toHaveBeenCalledWith('s9')
    expect(named.deps.stoppedAgents.save).not.toHaveBeenCalled()
    expect(named.deps.detachDsh).toHaveBeenCalledWith('a9')
    expect(named.deps.clients.send).toHaveBeenCalledWith({ type: 'agent_deleted', payload: { agentId: 'a9', retained: false } })
    expect(named.deps.input.forget).toHaveBeenCalledWith('s9')
    // With no agent id at all, the session id is all there is to announce.
    const bare = setup()
    bare.forgetSession('s9')
    expect(bare.deps.clients.sendCommander).toHaveBeenCalledWith({ type: 'agent_deleted', payload: { agentId: 's9' } })
  })

  it('forgets an agent that has no session yet under the id it was asked by', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const { deps, forgetSession } = setup()
    forgetSession('fresh')
    expect(deps.registry.removeAgent).toHaveBeenCalledWith('fresh')
    expect(deps.normalizers.forget).toHaveBeenCalledWith('fresh')
  })
})
