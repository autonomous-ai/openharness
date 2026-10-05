import { describe, expect, it, vi } from 'vitest'
import { projectDisplayName, type RegisteredSession } from '../lib/registry.js'
import { createCoreApi, emptyPorts, TEAMS_FALLBACKS, type CoreApiDeps } from './api.js'

const row = (agentId: string) => ({ agentId, sessionId: `s-${agentId}`, engine: 'claude', cwd: '/work/app' }) as RegisteredSession

describe('the core API services stand on', () => {
  it('lists every agent, live then stopped, and names them as the apps do', () => {
    const deps: CoreApiDeps = {
      dataDir: '/data',
      registry: {
        list: vi.fn(() => [row('live')]),
        byAgent: vi.fn((agentId: string) => (agentId === 'live' ? row('live') : undefined)),
        advertised: vi.fn(() => [row('live')]),
        terminalAvailable: vi.fn((agentId: string) => agentId === 'live'),
      } as unknown as CoreApiDeps['registry'],
      stoppedAgents: { list: vi.fn(() => [row('stopped')]) } as unknown as CoreApiDeps['stoppedAgents'],
      databaseHistory: vi.fn(),
      externalSessions: { list: vi.fn(), scan: vi.fn() } as unknown as CoreApiDeps['externalSessions'],
      openSessions: { known: vi.fn(), fresh: vi.fn() } as unknown as CoreApiDeps['openSessions'],
      syncSession: vi.fn(),
      viewerChanged: vi.fn(),
      gridNamed: vi.fn(),
      mintGridName: vi.fn(async () => 'grid-1'),
      accessToken: vi.fn(async () => 'token'),
    }
    const core = createCoreApi(deps)
    expect(core.dataDir).toBe('/data')
    expect(core.agents.all().map((s) => s.agentId)).toEqual(['live', 'stopped'])
    expect(core.agents.live().map((s) => s.agentId)).toEqual(['live'])
    expect(core.agents.displayName).toBe(projectDisplayName)
    expect(core.transcripts.databaseHistory).toBe(deps.databaseHistory)
    expect(core.external.sessions).toBe(deps.externalSessions)
    expect(core.external.open).toBe(deps.openSessions)
    expect(core.agents.byAgent('live')?.agentId).toBe('live')
    expect(core.agents.byAgent('gone')).toBeUndefined()
    expect(core.agents.terminalAvailable('live')).toBe(true)
    expect(core.agents.sync).toBe(deps.syncSession)
    expect(core.clients.viewerChanged).toBe(deps.viewerChanged)
    expect(core.agents.advertised().map((s) => s.agentId)).toEqual(['live'])
    expect(core.clients.gridNamed).toBe(deps.gridNamed)
    expect(core.account.mintGridName).toBe(deps.mintGridName)
    expect(core.account.accessToken).toBe(deps.accessToken)
  })

  it('falls back, when the teams fail, to an undo that has nothing to undo', () => {
    const undo = TEAMS_FALLBACKS.prepare as () => void
    expect(undo()).toBeUndefined()
  })

  it('starts with every port empty: a service fills its own when it starts', () => {
    expect(emptyPorts()).toEqual({ search: null, viewers: null, models: null, workspaces: null, teams: null })
    expect(emptyPorts()).not.toBe(emptyPorts())
  })
})
