import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { correlateAgentEvent } from '../../lib/agentEvent.js'
import type { RegisteredSession } from '../../lib/registry.js'
import { TurnActivity, WORK_EVIDENCE_MS, type ActivityFrame } from '../../lib/turnActivity.js'
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
    turns: { beat: vi.fn() },
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
const sentStates = (deps: HeartbeatDeps) => vi.mocked(deps.clients.send).mock.calls.map(([frame]) => {
  const { type, payload } = frame as { type: string; payload: { activity?: ActivityFrame } }
  return [type, payload.activity?.state]
})

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

  // A turn whose Stop never came ends at a beat (core/turns/turnHooks.ts, R6): the turn it closes is not checked.
  it('each beat of an active session tells the turn hooks first', async () => {
    const run = setup()
    vi.mocked(run.deps.turns.beat).mockImplementation(() => run.set({ turnOpen: false }))
    run.beats.startHeartbeat('s1')
    await vi.advanceTimersByTimeAsync(5_000)
    expect(run.deps.turns.beat).toHaveBeenCalledExactlyOnceWith('s1')
    expect(run.deps.turnActivity.check).not.toHaveBeenCalled()
    expect(run.beats.heartbeats.has('s1')).toBe(false)
    run.beats.startHeartbeat('s1')
    run.set({ active: false })
    await vi.advanceTimersByTimeAsync(5_000)
    expect(run.deps.turns.beat).toHaveBeenCalledOnce()
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
    expect(error).toHaveBeenCalledWith('[activity] probe failed:', 'Error')
    beats.stopHeartbeat('s1')
    beats.stopHeartbeat('never-started')
  })

  // A claim with no turn open (a paste, a pane read as busy, late output after a cancel) had no beat: its end went to no
  // one, and `wait` and `watch` slept to their 60 s backstop.
  it('a claim with no turn open sends two frames at most: working at once, nothing for its renewals, its end within a beat', async () => {
    const run = setup({ turnActivity: new TurnActivity({ now: () => Date.now(), runtime: () => ({ key: 'k', turnOpen: false }),
      probe: async () => 'unknown', drain: async () => {}, claimed: (sessionId) => run.beats.watchClaim(sessionId) }) })
    run.set({ turnOpen: false })
    const activity = run.deps.turnActivity as TurnActivity
    activity.observe('s1', 'turn_started')
    expect(sentTypes(run.deps)).toEqual(['agent_activity'])
    expect(vi.mocked(run.deps.clients.send).mock.calls[0]![0]).toMatchObject({ type: 'agent_activity', payload: { activity: { state: 'working' } } })
    for (let i = 0; i < 5; i++) { await vi.advanceTimersByTimeAsync(5_000); activity.observe('s1', 'text_delta') }
    expect(sentTypes(run.deps)).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(WORK_EVIDENCE_MS - 1)
    expect(sentTypes(run.deps)).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(sentTypes(run.deps)).toEqual(['agent_activity', 'agent_activity'])
    expect(vi.mocked(run.deps.clients.send).mock.calls[1]![0]).toMatchObject({ payload: { activity: { state: 'idle' } } })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(sentTypes(run.deps)).toHaveLength(2)
    expect(run.beats.heartbeats.has('s1')).toBe(false)
    expect(run.deps.turns.beat).not.toHaveBeenCalled()
    expect(run.deps.mirror.heartbeat).not.toHaveBeenCalled()
    expect(run.deps.runtimeActivity.forget).not.toHaveBeenCalled()
  })

  it('a claim watched already starts no second watch and sends nothing', async () => {
    const { deps, beats, set } = setup()
    set({ turnOpen: false, activity: { state: 'working', epoch: 'e', revision: 1, validForMs: 30_000 } })
    beats.watchClaim('s1')
    beats.watchClaim('s1')
    expect(sentTypes(deps)).toEqual(['agent_activity'])
    await vi.advanceTimersByTimeAsync(5_000)
    expect(sentTypes(deps)).toHaveLength(1)
    set({ activity: { state: 'idle', epoch: 'e', revision: 2, validForMs: 0 } })
    await vi.advanceTimersByTimeAsync(5_000)
    expect(sentTypes(deps)).toEqual(['agent_activity', 'agent_activity'])
    expect(beats.heartbeats.has('s1')).toBe(false)
  })

  // A closed turn's heartbeat beats on to its next beat, and longer while the dial's card is busy. A `tell` pasted after
  // `wait` returned claims work inside that time: it was told nothing, the beat sent it as a turn_heartbeat, then stopped
  // and forgot the runtime's reading, and the claim's end went to no one (`wait` and `watch` slept to their backstop).
  it.each([['its next beat', false], ['the dial\'s card', true]])(
    'a claim while a closed turn\'s heartbeat beats on for %s is two agent_activity frames: at once, and its end within a beat',
    async (_, deviceBusy) => {
      const run = setup({ turnActivity: new TurnActivity({ now: () => Date.now(), probe: async () => 'unknown', drain: async () => {},
        runtime: (sessionId) => ({ key: 'k', turnOpen: run.deps.sessionTurnOpen(sessionId) }),
        claimed: (sessionId) => run.beats.watchClaim(sessionId) }) })
      const activity = run.deps.turnActivity as TurnActivity
      run.set({ deviceBusy })
      activity.observe('s1', 'turn_started')
      run.beats.startHeartbeat('s1')
      vi.mocked(run.deps.runtimeActivity.forget).mockClear()
      await vi.advanceTimersByTimeAsync(6_000)
      run.set({ turnOpen: false })
      activity.observe('s1', 'turn_ended')
      await vi.advanceTimersByTimeAsync(1_000)
      // The paste's mark (core/input.ts): working, with no turn open.
      activity.observe('s1', 'turn_started')
      await vi.advanceTimersByTimeAsync(0)
      expect(sentStates(run.deps)).toEqual([['turn_heartbeat', 'working'], ['agent_activity', 'working']])
      await vi.advanceTimersByTimeAsync(WORK_EVIDENCE_MS - 1)
      expect(sentStates(run.deps)).toHaveLength(2)
      await vi.advanceTimersByTimeAsync(5_000)
      expect(sentStates(run.deps)).toEqual([['turn_heartbeat', 'working'], ['agent_activity', 'working'], ['agent_activity', 'idle']])
      expect(run.deps.runtimeActivity.forget).not.toHaveBeenCalled()
      run.set({ deviceBusy: false })
      await vi.advanceTimersByTimeAsync(5_000)
      expect(run.beats.heartbeats.has('s1')).toBe(false)
      expect(sentStates(run.deps)).toHaveLength(3)
    })

  it('a turn\'s heartbeat replaces a claim watch, with no second frame for one beat', async () => {
    const { deps, beats, set } = setup()
    set({ turnOpen: false, activity: { state: 'working', epoch: 'e', revision: 1, validForMs: 30_000 } })
    beats.watchClaim('s1')
    set({ turnOpen: true })
    beats.startHeartbeat('s1')
    expect(sentTypes(deps)).toEqual(['agent_activity'])
    await vi.advanceTimersByTimeAsync(5_000)
    expect(sentTypes(deps)).toEqual(['agent_activity', 'turn_heartbeat'])
    expect(deps.turnActivity.check).toHaveBeenCalledOnce()
    beats.stopHeartbeat('s1')
  })

  it('a claim watch ends, telling nothing and forgetting nothing, once its row is not active or a turn opens', async () => {
    const { deps, beats, set } = setup()
    set({ turnOpen: false, activity: { state: 'working', epoch: 'e', revision: 1, validForMs: 30_000 } })
    beats.watchClaim('s1')
    set({ active: false })
    await vi.advanceTimersByTimeAsync(5_000)
    expect(beats.heartbeats.has('s1')).toBe(false)
    set({ active: true })
    beats.watchClaim('s1')
    set({ turnOpen: true })
    await vi.advanceTimersByTimeAsync(5_000)
    expect(beats.heartbeats.has('s1')).toBe(false)
    expect(sentTypes(deps)).toEqual(['agent_activity', 'agent_activity'])
    expect(deps.runtimeActivity.forget).not.toHaveBeenCalled()
    expect(deps.turnActivity.forget).not.toHaveBeenCalled()
    expect(deps.turnActivity.check).not.toHaveBeenCalled()
  })

  // A cancel stops the turn's beat while its check reads the pane; the aborted tool's output then claims work, watched.
  // The stopped beat went on as if it were the watch: a turn_heartbeat, and a stop that ended the watch and its end's frame.
  it('a beat whose heartbeat was stopped while its check ran leaves the claim watch started meanwhile', async () => {
    const run = setup()
    vi.mocked(run.deps.turnActivity.check).mockImplementation(async () => {
      run.beats.stopHeartbeat('s1')
      run.set({ turnOpen: false })
      run.beats.watchClaim('s1')
    })
    run.set({ activity: { state: 'working', epoch: 'e', revision: 1, validForMs: 30_000 } })
    run.beats.startHeartbeat('s1')
    await vi.advanceTimersByTimeAsync(5_000)
    expect(sentTypes(run.deps)).toEqual(['agent_activity'])
    expect(run.deps.mirror.heartbeat).not.toHaveBeenCalled()
    expect(run.beats.heartbeats.has('s1')).toBe(true)
    run.set({ activity: { state: 'idle', epoch: 'e', revision: 2, validForMs: 0 } })
    await vi.advanceTimersByTimeAsync(5_000)
    expect(sentTypes(run.deps)).toEqual(['agent_activity', 'agent_activity'])
  })

  // A cancel and a wait on the person (core/turns/cancel.ts, core/turns/turnHooks.ts): told now, with or without a beat.
  it('tells every window the activity as it reads now, and nothing for an agent the lease no longer knows', () => {
    const { deps, beats, set } = setup()
    const activity = { state: 'idle' } as ActivityFrame
    set({ activity })
    beats.tell('s1')
    expect(deps.clients.send).toHaveBeenCalledExactlyOnceWith(correlateAgentEvent({ type: 'agent_activity', payload: { activity } }, 's1', 'a1'))
    set({ activity: undefined })
    beats.tell('s1')
    expect(deps.clients.send).toHaveBeenCalledOnce()
  })
})
