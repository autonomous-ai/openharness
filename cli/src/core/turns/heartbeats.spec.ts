import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RegisteredSession } from '../../lib/registry.js'
import type { ActivityFrame } from '../../lib/turnActivity.js'
import { createHeartbeats, type HeartbeatDeps } from './heartbeats.js'

function setup(over: Partial<HeartbeatDeps> = {}) {
  let active = true
  let turnOpen = true
  let deviceBusy = false
  let activity: ActivityFrame | undefined
  const deps: HeartbeatDeps = {
    bySession: (sessionId) => sessionId === 's1' ? ({ agentId: 'a1', sessionId: 's1', active } as RegisteredSession) : undefined,
    sessionTurnOpen: () => turnOpen,
    agentIdFor: () => 'a1',
    runtimeActivity: { forget: vi.fn() },
    turnActivity: { check: vi.fn(async () => {}), snapshot: vi.fn(() => activity), forget: vi.fn() },
    mirror: { heartbeat: vi.fn(() => deviceBusy) },
    clients: { send: vi.fn() },
    ...over,
  }
  return {
    deps,
    beats: createHeartbeats(deps),
    set: (next: { active?: boolean; turnOpen?: boolean; deviceBusy?: boolean; activity?: ActivityFrame }) => {
      if (next.active !== undefined) active = next.active
      if (next.turnOpen !== undefined) turnOpen = next.turnOpen
      if (next.deviceBusy !== undefined) deviceBusy = next.deviceBusy
      if ('activity' in next) activity = next.activity
    },
  }
}

const sentTypes = (deps: HeartbeatDeps) => vi.mocked(deps.clients.send).mock.calls.map(([frame]) => (frame as { type: string }).type)

describe('turn heartbeats', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

  it('checks an open turn every 5 s and tells the app what the agent is doing', async () => {
    const { deps, beats, set } = setup()
    set({ activity: { state: 'working' } as ActivityFrame })
    beats.startHeartbeat('s1')
    expect(beats.heartbeats.has('s1')).toBe(true)
    await vi.advanceTimersByTimeAsync(4_999)
    expect(deps.turnActivity.check).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(deps.turnActivity.check).toHaveBeenCalledWith('s1')
    expect(sentTypes(deps)).toEqual(['turn_heartbeat'])
    set({ activity: { state: 'idle' } as ActivityFrame })
    await vi.advanceTimersByTimeAsync(5_000)
    expect(sentTypes(deps)).toEqual(['turn_heartbeat', 'agent_activity'])
    set({ activity: undefined })
    await vi.advanceTimersByTimeAsync(5_000)
    expect(sentTypes(deps)).toHaveLength(2)
    beats.stopHeartbeat('s1')
  })

  it('sends only turn_heartbeat, with its activity, while working', async () => {
    const { deps, beats, set } = setup()
    set({ activity: { state: 'working', epoch: 'e', revision: 1, validForMs: 30_000 } })
    beats.startHeartbeat('s1')
    await vi.advanceTimersByTimeAsync(15_000)
    expect(sentTypes(deps)).toEqual(['turn_heartbeat', 'turn_heartbeat', 'turn_heartbeat'])
    expect(vi.mocked(deps.clients.send).mock.calls[0]![0]).toMatchObject({ payload: { activity: { state: 'working' } } })
    beats.stopHeartbeat('s1')
  })

  it('sends an idle activity once while it waits, however often a probe renews it, and again when it changes or restarts', async () => {
    const { deps, beats, set } = setup()
    // Every probe of an idle open turn moves the revision (TurnActivity.check): nothing new for the apps.
    let revision = 1
    vi.mocked(deps.turnActivity.snapshot).mockImplementation(() => ({ state: 'idle', epoch: 'e', revision: ++revision, validForMs: 0 }))
    beats.startHeartbeat('s1')
    await vi.advanceTimersByTimeAsync(600_000)
    expect(sentTypes(deps)).toEqual(['agent_activity'])
    vi.mocked(deps.turnActivity.snapshot).mockImplementation(() => ({ state: 'working', epoch: 'e', revision: ++revision, validForMs: 30_000 }))
    await vi.advanceTimersByTimeAsync(5_000)
    vi.mocked(deps.turnActivity.snapshot).mockImplementation(() => ({ state: 'idle', epoch: 'e', revision: ++revision, validForMs: 0 }))
    await vi.advanceTimersByTimeAsync(10_000)
    expect(sentTypes(deps)).toEqual(['agent_activity', 'turn_heartbeat', 'agent_activity'])
    vi.mocked(deps.turnActivity.snapshot).mockImplementation(() => ({ state: 'unknown', epoch: 'e', revision: ++revision, validForMs: 0 }))
    await vi.advanceTimersByTimeAsync(5_000)
    // A daemon restart starts a new epoch: the apps hear it.
    vi.mocked(deps.turnActivity.snapshot).mockImplementation(() => ({ state: 'unknown', epoch: 'e2', revision: 1, validForMs: 0 }))
    await vi.advanceTimersByTimeAsync(5_000)
    expect(sentTypes(deps).slice(3)).toEqual(['agent_activity', 'agent_activity'])
    beats.stopHeartbeat('s1')
    beats.startHeartbeat('s1')
    await vi.advanceTimersByTimeAsync(5_000)
    expect(sentTypes(deps)).toHaveLength(6)
    expect(sentTypes(deps).at(-1)).toBe('agent_activity')
    beats.stopHeartbeat('s1')
  })

  it('keeps beating for the dial after the turn closes, and stops once neither needs it', async () => {
    const { deps, beats, set } = setup()
    beats.startHeartbeat('s1')
    set({ turnOpen: false, deviceBusy: true })
    await vi.advanceTimersByTimeAsync(5_000)
    expect(deps.turnActivity.check).not.toHaveBeenCalled()
    expect(beats.heartbeats.has('s1')).toBe(true)
    set({ deviceBusy: false })
    await vi.advanceTimersByTimeAsync(5_000)
    expect(beats.heartbeats.has('s1')).toBe(false)
    expect(deps.runtimeActivity.forget).toHaveBeenCalledWith('s1')
  })

  it('stops for a session that is no longer active, and forgets its activity', async () => {
    const { deps, beats, set } = setup()
    beats.startHeartbeat('s1')
    set({ active: false })
    await vi.advanceTimersByTimeAsync(5_000)
    expect(beats.heartbeats.has('s1')).toBe(false)
    expect(deps.turnActivity.forget).toHaveBeenCalledWith('s1')
    expect(deps.mirror.heartbeat).not.toHaveBeenCalled()
  })

  it('says nothing when the heartbeat was stopped while the check ran', async () => {
    const run = setup()
    vi.mocked(run.deps.turnActivity.check).mockImplementation(async () => { run.beats.stopHeartbeat('s1') })
    run.set({ activity: { state: 'working' } as ActivityFrame })
    run.beats.startHeartbeat('s1')
    await vi.advanceTimersByTimeAsync(5_000)
    expect(run.deps.clients.send).not.toHaveBeenCalled()
    expect(run.deps.mirror.heartbeat).not.toHaveBeenCalled()
  })

  it('reports a probe that fails, and starting again replaces the running heartbeat', async () => {
    const { deps, beats } = setup()
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(deps.turnActivity.check).mockRejectedValueOnce(new Error('pane gone'))
    beats.startHeartbeat('s1')
    beats.startHeartbeat('s1')
    await vi.advanceTimersByTimeAsync(5_000)
    expect(deps.turnActivity.check).toHaveBeenCalledTimes(1)
    expect(error).toHaveBeenCalledWith('[activity] probe failed:', 'Error: pane gone')
    beats.stopHeartbeat('s1')
    beats.stopHeartbeat('never-started')
  })
})
