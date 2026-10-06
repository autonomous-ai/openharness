import { describe, expect, it, vi } from 'vitest'
import { projectDisplayName, type RegisteredSession } from '../lib/registry.js'
import { createCoreApi, emptyPorts, FLEET_FALLBACKS, LANE_OFF, MONITOR_OFF, resolveAgent, TEAMS_FALLBACKS, type CoreApiDeps } from './api.js'
import { FAIL } from './serviceHost.js'

const row = (agentId: string) => ({ agentId, sessionId: `s-${agentId}`, engine: 'claude', cwd: '/work/app' }) as RegisteredSession

describe('the core API services stand on', () => {
  it('gives a service with no lane of the core\'s nothing to seal with, and never its frame back in the clear', async () => {
    await expect(LANE_OFF.hello('m', 'pub')).rejects.toThrow(/no E2EE identity/)
    expect(await LANE_OFF.welcome('m', {})).toBe(false)
    await expect(LANE_OFF.rekey('m', {})).resolves.toBeUndefined()
    expect(await LANE_OFF.seal('m', { type: 'message', payload: { text: 'hello' } })).toEqual({ lost: true })
    expect(await LANE_OFF.open('m', { type: 'message' })).toEqual({ lost: true })
    expect(LANE_OFF.drop('m')).toBeUndefined()
  })

  it('resolves an agent in a service\'s own copy as the registry does: by agent id, then session id', () => {
    const agents = [{ ...row('a'), sessionId: '' }, row('b')]
    expect(resolveAgent(agents, 'b')?.agentId).toBe('b')
    expect(resolveAgent(agents, 's-b')?.agentId).toBe('b')
    expect(resolveAgent(agents, '')).toBeUndefined()
    expect(resolveAgent(agents, 'nobody')).toBeUndefined()
  })

  it('lists every agent, live then stopped, and names them as the apps do', async () => {
    const deps: CoreApiDeps = {
      dataDir: '/data',
      registry: {
        list: vi.fn(() => [row('live')]),
        byAgent: vi.fn((agentId: string) => (agentId === 'live' ? row('live') : undefined)),
        resolve: vi.fn((id: string) => (id === 'live' || id === 's-live' ? row('live') : undefined)),
        advertised: vi.fn(() => [row('live')]),
        terminalAvailable: vi.fn((agentId: string) => agentId === 'live'),
      } as unknown as CoreApiDeps['registry'],
      stoppedAgents: { list: vi.fn(() => [row('stopped')]) } as unknown as CoreApiDeps['stoppedAgents'],
      databaseHistory: vi.fn(),
      externalSessions: { list: vi.fn(), scan: vi.fn() } as unknown as CoreApiDeps['externalSessions'],
      openSessions: { known: vi.fn(), fresh: vi.fn() } as unknown as CoreApiDeps['openSessions'],
      syncSession: vi.fn(),
      runtimeModels: vi.fn(async () => []),
      viewerChanged: vi.fn(),
      gridNamed: vi.fn(),
      gridModelsChanged: vi.fn(),
      dshInstallStatus: vi.fn(),
      mintGridName: vi.fn(async () => 'grid-1'),
      accessToken: vi.fn(async () => 'token'),
      lane: LANE_OFF,
      privateGridName: vi.fn(async () => 'grid-1'),
      machineName: vi.fn(() => 'Studio'),
      runtimeProfile: vi.fn(() => null),
      setRuntime: vi.fn(),
      fork: vi.fn(async () => ({ ok: true as const, agentId: 'fork' })),
      turns: { send: vi.fn(), stop: vi.fn(), recent: vi.fn(() => []), asks: vi.fn(() => []) },
      questions: { answer: vi.fn(), answerReviewed: vi.fn(async () => true) },
    }
    const core = createCoreApi(deps)
    expect(core.dataDir).toBe('/data')
    expect(await core.terminals.open({ argv: ['/bin/zsh'], cwd: '/work' })).toEqual({ ok: false, error: 'SERVICE_UNAVAILABLE' })
    const terminals = { open: vi.fn(async () => ({ ok: true as const, agentId: 'shell' })) }
    expect(createCoreApi({ ...deps, terminals }).terminals).toBe(terminals)
    expect(core.agents.all().map((s) => s.agentId)).toEqual(['live', 'stopped'])
    expect(core.agents.live().map((s) => s.agentId)).toEqual(['live'])
    expect(core.agents.displayName).toBe(projectDisplayName)
    expect(core.transcripts.databaseHistory).toBe(deps.databaseHistory)
    expect(core.external.sessions).toBe(deps.externalSessions)
    expect(core.external.open).toBe(deps.openSessions)
    expect(core.agents.byAgent('live')?.agentId).toBe('live')
    expect(core.agents.byAgent('gone')).toBeUndefined()
    expect(core.agents.resolve('s-live')?.agentId).toBe('live')
    expect(core.agents.resolve('gone')).toBeUndefined()
    expect(core.agents.terminalAvailable('live')).toBe(true)
    expect(core.agents.sync).toBe(deps.syncSession)
    expect(core.agents.runtimeModels).toBe(deps.runtimeModels)
    expect(core.clients.viewerChanged).toBe(deps.viewerChanged)
    expect(core.clients.dshInstallStatus).toBe(deps.dshInstallStatus)
    expect(core.agents.advertised().map((s) => s.agentId)).toEqual(['live'])
    expect(core.clients.gridNamed).toBe(deps.gridNamed)
    expect(core.clients.gridModelsChanged).toBe(deps.gridModelsChanged)
    expect(core.account.mintGridName).toBe(deps.mintGridName)
    expect(core.account.accessToken).toBe(deps.accessToken)
    expect(core.account.lane).toBe(deps.lane)
    expect(core.account.privateGridName).toBe(deps.privateGridName)
    expect(core.account.machineName).toBe(deps.machineName)
    // What a device or another machine asks of an agent here: the core's own handlers, as they are.
    expect(core.agents.runtimeProfile).toBe(deps.runtimeProfile)
    expect(core.agents.setRuntime).toBe(deps.setRuntime)
    expect(core.agents.fork).toBe(deps.fork)
    expect(core.turns).toBe(deps.turns)
    expect(core.questions).toBe(deps.questions)
  })

  it('answers ⌘K, when the fleet fails, with no agent picked and nothing sent, saying why', () => {
    expect(FLEET_FALLBACKS.routeSend).toEqual({ ok: false, machine: '', reason: 'the fleet service is unavailable' })
    expect(FLEET_FALLBACKS.stop).toBeUndefined()
    // No cards, and nothing to stop hearing.
    expect((FLEET_FALLBACKS.onEvent as () => void)()).toBeUndefined()
  })

  it('fails the dial\'s routing, when the fleet fails, rather than making an answer up', () => {
    // The dial routes this computer by itself then (cable/cableHost.ts): a made-up answer read as the
    // fleet's would send a turn nowhere and say it went.
    for (const member of ['agentTotal', 'describe', 'machineOf', 'knows', 'isLocalAgent', 'sendTurn', 'hasLane', 'release'] as const) {
      expect(FLEET_FALLBACKS[member], member).toBe(FAIL)
    }
  })

  it('falls back, when the teams fail, to an undo that has nothing to undo', () => {
    const undo = TEAMS_FALLBACKS.prepare as () => void
    expect(undo()).toBeUndefined()
  })

  it('starts with every port empty: a service fills its own when it starts', () => {
    expect(emptyPorts()).toEqual({ search: null, viewers: null, models: null, workspaces: null, teams: null, fleet: null, monitor: null })
    expect(emptyPorts()).not.toBe(emptyPorts())
  })

  it('answers the monitor\'s fallbacks while it is off: no readings, nothing measured to forget', async () => {
    await expect(MONITOR_OFF.resources()).rejects.toThrow('the monitor service is unavailable')
    expect(await MONITOR_OFF.storage([], true)).toEqual(new Map())
  })
})
