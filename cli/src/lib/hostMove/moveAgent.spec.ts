import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RegisteredSession } from '../registry.js'
import type { TerminalBackend } from '../terminalBackend.js'
import type { ProcessIdentity, TerminalInventoryResult, TerminalRuntimeRef } from '../terminalTypes.js'
import { terminalRouteKey } from '../terminalRuntime.js'
import { MoveGate } from './gate.js'
import { MOVE_MARKER_ENV, moveAgent, moveCreateRequest, removeOrphanMovePanes, type MoveAgentDeps, type MoveOutcome } from './moveAgent.js'

const OLD: TerminalRuntimeRef = { backend: 'ptyhost', instance: 'p2', paneId: '%1' }
const NEW: TerminalRuntimeRef = { backend: 'ptyhost', instance: 'p2-1.2.3', paneId: '%7' }
const ID: ProcessIdentity = { pid: 42, executable: 'claude', startMarker: 'Mon Oct 20 10:00:00 2026' }
const LAUNCH = { argv: ['claude', '--resume', 's1'] }

function session(): RegisteredSession {
  return { agentId: 'a1', sessionId: 's1', engine: 'claude', cwd: '/w', runtimes: [OLD], tmuxPane: '%1' } as unknown as RegisteredSession
}

const never = <T>() => new Promise<T>(() => { /* never settles */ })
const after = <T>(ms: number, value: T) => new Promise<T>((resolve) => setTimeout(() => resolve(value), ms))

/** Fakes for every step, recording the order of what changes anything, and a row that the swap switches. */
function harness(overrides: Partial<MoveAgentDeps> = {}) {
  const events: string[] = []
  const row = { runtime: OLD }
  const gate = new MoveGate()
  const hold = gate.hold.bind(gate)
  const release = gate.release.bind(gate)
  let heldAt: number | null = null
  let releasedAt: number | null = null
  gate.hold = (agentId) => { events.push('hold'); heldAt = Date.now(); hold(agentId) }
  gate.release = async (agentId) => { events.push('release'); releasedAt = Date.now(); await release(agentId) }
  // The reconciler's route holds, owner-scoped as `holdRoute(key, null)` is: a release lets go only of its own hold.
  const routes = new Map<string, symbol>()
  const holdRoute = vi.fn((key: string) => {
    const owner = Symbol('hold')
    routes.set(key, owner)
    return () => { if (routes.get(key) === owner) routes.delete(key) }
  })
  const deps: MoveAgentDeps = {
    capture: vi.fn(async () => { events.push('capture'); return 'line one\nline two\n' }),
    buildLaunch: vi.fn(async () => { events.push('buildLaunch'); return LAUNCH }),
    createSeeded: vi.fn(async () => { events.push('create'); return { ok: true as const, runtime: NEW } }),
    stopEngine: vi.fn(async () => { events.push('stop'); return 'terminated' as const }),
    prepareResume: vi.fn(async () => { events.push('prepare') }),
    respawn: vi.fn(async () => { events.push('respawn'); return { ok: true } }),
    probeProcess: vi.fn(async () => ID),
    swap: vi.fn((_agentId: string, runtime: TerminalRuntimeRef) => { events.push('swap'); row.runtime = runtime }),
    retarget: vi.fn(async (_agentId: string, to: TerminalRuntimeRef) => {
      events.push(row.runtime === to ? 'retarget(row names it)' : 'retarget(row names the old pane)')
    }),
    releaseHold: vi.fn(async (runtime: TerminalRuntimeRef) => { events.push(`releaseHold ${runtime.paneId}`) }),
    killPane: vi.fn(async (runtime: TerminalRuntimeRef) => { events.push(`kill ${runtime.paneId}`); return true }),
    relaunchOld: vi.fn(async () => { events.push('relaunchOld'); return true }),
    gate,
    holdRoute,
    current: () => true,
    eligible: () => true,
    log: vi.fn(),
    ...overrides,
  }
  return { deps, events, row, gate, holdRoute, routes, heldMs: () => heldAt === null || releasedAt === null ? null : releasedAt - heldAt }
}

let movedMs = 0
/** Runs the move to its end on the fake clock: the probe polls, and every bound is a timer. Sets `movedMs`. */
async function run(deps: MoveAgentDeps, row: RegisteredSession = session()): Promise<MoveOutcome> {
  const started = Date.now()
  const moved = moveAgent(row, deps).finally(() => { movedMs = Date.now() - started })
  await vi.advanceTimersByTimeAsync(300_000)
  return moved
}

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('moveAgent', () => {
  it('moves an idle conversation agent and keeps its id', async () => {
    const h = harness()
    const outcome = await run(h.deps)
    expect(outcome).toEqual({ moved: true, resumed: true })
    expect(h.events).toEqual(['capture', 'buildLaunch', 'create', 'hold', 'stop', 'prepare', 'respawn', 'swap', 'retarget(row names it)', 'releaseHold %7', 'kill %1', 'release'])
    // The same agent id throughout: the row is switched to the new pane, never replaced.
    expect(h.deps.swap).toHaveBeenCalledWith('a1', NEW, ID)
    // Built while the old engine runs: without the writes a launch prepares, which wait for its stop.
    expect(h.deps.buildLaunch).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'a1' }), expect.objectContaining({ resumeSessionId: 's1', prepare: false }))
    // The new pane is seeded with the old one's scrollback, as the host's terminal expects it.
    expect(h.deps.createSeeded).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'a1' }), 'line one\r\nline two')
    expect(h.deps.respawn).toHaveBeenCalledWith(NEW, LAUNCH)
    expect(h.deps.relaunchOld).not.toHaveBeenCalled()
    expect(h.gate.holding('a1')).toBe(false)
    // Both routes, the new one from its create and the old one from the hold: the reconciler sees neither pane come
    // or go on its own. Both are let go at the end.
    expect(h.holdRoute.mock.calls.map(([key]) => key)).toEqual([terminalRouteKey(NEW), terminalRouteKey(OLD)])
    expect(h.routes.size).toBe(0)
  })

  it('delivers input typed during the move to the new pane, after the swap', async () => {
    const h = harness()
    const delivered: string[] = []
    h.deps.stopEngine = vi.fn(async () => {
      // Typed once the old engine is stopping: queued, not lost, and delivered where the row then points.
      h.gate.enqueue('a1', async () => { delivered.push(h.row.runtime.paneId) })
      return 'terminated' as const
    })
    expect(await run(h.deps)).toEqual({ moved: true, resumed: true })
    expect(delivered).toEqual(['%7'])
  })

  it('capture_failure_changes_nothing', async () => {
    for (const capture of [async () => null, async () => { throw new Error('no snapshot') }]) {
      const h = harness({ capture: vi.fn(capture) })
      const outcome = await run(h.deps)
      expect(outcome).toMatchObject({ moved: false, fellBack: false })
      expect(h.deps.createSeeded).not.toHaveBeenCalled()
      expect(h.deps.stopEngine).not.toHaveBeenCalled()
      expect(h.deps.killPane).not.toHaveBeenCalled()
      expect(h.events).not.toContain('hold')
      expect(h.holdRoute).not.toHaveBeenCalled()
    }
  })

  it('a refused create changes nothing', async () => {
    const h = harness({ createSeeded: vi.fn(async () => ({ ok: false as const, reason: 'this host cannot seed a pane' })) })
    const outcome = await run(h.deps)
    expect(outcome).toEqual({ moved: false, reason: expect.stringContaining('this host cannot seed a pane'), fellBack: false })
    expect(h.deps.stopEngine).not.toHaveBeenCalled()
    expect(h.deps.respawn).not.toHaveBeenCalled()
    expect(h.deps.killPane).not.toHaveBeenCalled()
    expect(h.deps.relaunchOld).not.toHaveBeenCalled()
    expect(h.events).not.toContain('hold')
  })

  it('a launch restore would not make changes nothing', async () => {
    const h = harness({ buildLaunch: vi.fn(async () => ({ error: 'WORKSPACE_MISSING', detail: 'The folder is gone.' })) })
    expect(await run(h.deps)).toEqual({ moved: false, reason: expect.stringContaining('The folder is gone.'), fellBack: false })
    expect(h.deps.createSeeded).not.toHaveBeenCalled()
    expect(h.events).not.toContain('hold')
  })

  it('a new engine that never appears falls back to the old pane', async () => {
    const h = harness({
      probeProcess: vi.fn(async () => null),
      // The old engine comes back before the gate lets held input through.
      relaunchOld: vi.fn(async () => { await after(2_000, null); h.events.push('relaunchOld (engine up)'); return true }),
    })
    const outcome = await run(h.deps)
    expect(outcome).toEqual({ moved: false, reason: expect.any(String), fellBack: true })
    expect(h.events).toEqual(['capture', 'buildLaunch', 'create', 'hold', 'stop', 'prepare', 'respawn', 'kill %7', 'relaunchOld (engine up)', 'release'])
    expect(h.deps.swap).not.toHaveBeenCalled()
    expect(h.row.runtime).toBe(OLD)
    expect(h.gate.holding('a1')).toBe(false)
  })

  it('an engine seen only once is not proven: one that exits at once falls back', async () => {
    let probes = 0
    const h = harness({ probeProcess: vi.fn(async () => (probes++ === 0 ? ID : null)) })
    expect(await run(h.deps)).toMatchObject({ moved: false, fellBack: true })
    expect(h.deps.swap).not.toHaveBeenCalled()
  })

  it('a failed relaunch in the old pane still lets the input go, and says it did not fall back', async () => {
    const h = harness()
    h.deps.respawn = vi.fn(async () => { h.events.push('respawn'); return { ok: false, reason: 'host refused' } })
    h.deps.relaunchOld = vi.fn(async () => { h.events.push('relaunchOld'); return false })
    expect(await run(h.deps)).toEqual({ moved: false, reason: expect.stringContaining('host refused'), fellBack: false })
    // Input then goes to the old pane, as it does after any failed restart.
    expect(h.events.slice(-4)).toEqual(['respawn', 'kill %7', 'relaunchOld', 'release'])
    expect(h.routes.size).toBe(0)
    expect(h.gate.holding('a1')).toBe(false)
  })

  it('never relaunches the old engine while the new pane may still run one', async () => {
    const h = harness({ probeProcess: vi.fn(async () => null), killPane: vi.fn(async () => false) })
    expect(await run(h.deps)).toMatchObject({ moved: false, fellBack: false })
    expect(h.deps.relaunchOld).not.toHaveBeenCalled()
    expect(h.events).toContain('release')
    // Its route stays held, so discovery never mints the pane a second agent; the old pane's is let go.
    expect([...h.routes.keys()]).toEqual([terminalRouteKey(NEW)])
    expect(h.deps.log).toHaveBeenCalledWith(expect.stringMatching(/warning: the new pane %7 was not confirmed closed/))
  })

  it('nothing after the switch relaunches the old engine', async () => {
    const h = harness({
      retarget: vi.fn(async () => { throw new Error('no stream') }),
      killPane: vi.fn(async () => { throw new Error('host gone') }),
      log: vi.fn(() => { throw new Error('no log') }),
    })
    expect(await run(h.deps)).toEqual({ moved: true, resumed: true })
    expect(h.deps.relaunchOld).not.toHaveBeenCalled()
    expect(h.row.runtime).toBe(NEW)
    expect(h.events.at(-1)).toBe('release')
  })

  it('open streams are retargeted after the swap, never before', async () => {
    const h = harness()
    await run(h.deps)
    expect(h.deps.retarget).toHaveBeenCalledTimes(1)
    expect(h.deps.retarget).toHaveBeenCalledWith('a1', NEW)
    expect(h.events).toContain('retarget(row names it)')
    expect(h.events).not.toContain('retarget(row names the old pane)')
    expect(h.events.indexOf('swap')).toBeLessThan(h.events.indexOf('retarget(row names it)'))
    expect(h.events.indexOf('retarget(row names it)')).toBeLessThan(h.events.indexOf('release'))

    // A move that falls back never points a stream anywhere: they stay on the old pane, which the row still names.
    const failed = harness({ probeProcess: vi.fn(async () => null) })
    await run(failed.deps)
    expect(failed.deps.retarget).not.toHaveBeenCalled()
  })

  it('the gate is released on every path', async () => {
    const boom = () => { throw new Error('boom') }
    const paths: Array<[string, Partial<MoveAgentDeps>]> = [
      ['capture fails', { capture: vi.fn(async () => null) }],
      ['buildLaunch throws', { buildLaunch: vi.fn(async () => boom()) }],
      ['create refused', { createSeeded: vi.fn(async () => ({ ok: false as const, reason: 'no' })) }],
      ['create throws', { createSeeded: vi.fn(async () => boom()) }],
      ['stop throws', { stopEngine: vi.fn(async () => boom()) }],
      ['stop unconfirmed', { stopEngine: vi.fn(async () => 'failed' as const) }],
      ['respawn refused', { respawn: vi.fn(async () => ({ ok: false, reason: 'no' })) }],
      ['respawn throws', { respawn: vi.fn(async () => boom()) }],
      ['probe throws', { probeProcess: vi.fn(async () => boom()) }],
      ['probe never proves', { probeProcess: vi.fn(async () => null) }],
      ['swap throws', { swap: vi.fn(() => boom()) }],
      ['retarget throws', { retarget: vi.fn(async () => boom()) }],
      ['kill throws', { killPane: vi.fn(async () => boom()) }],
      ['relaunch throws', { probeProcess: vi.fn(async () => null), relaunchOld: vi.fn(async () => boom()) }],
    ]
    for (const [name, overrides] of paths) {
      const h = harness(overrides)
      const delivered: string[] = []
      const outcome = await run(h.deps)
      expect(outcome, name).toHaveProperty('moved')
      if (h.events.includes('hold')) {
        expect(h.events.filter((event) => event === 'release'), name).toEqual(['release'])
        // Released last: nothing after it changes a pane.
        expect(h.events.at(-1), name).toBe('release')
      }
      h.gate.enqueue('a1', async () => { delivered.push('after') })
      await vi.advanceTimersByTimeAsync(0)
      expect(delivered, name).toEqual(['after'])
      expect(h.gate.holding('a1'), name).toBe(false)
      expect(h.routes.size, name).toBe(0)
    }
  })

  it('the hold, and the whole move, end well under two minutes when every step is slow or hangs', async () => {
    const slowest = harness({
      capture: vi.fn(() => after(4_000, 'old')),
      buildLaunch: vi.fn(() => after(9_000, LAUNCH)),
      createSeeded: vi.fn(() => after(4_000, { ok: true as const, runtime: NEW })),
      stopEngine: vi.fn(() => after(9_000, 'terminated' as const)),
      prepareResume: vi.fn(() => after(4_000, undefined)),
      respawn: vi.fn(() => after(4_000, { ok: true })),
      probeProcess: vi.fn(() => never<ProcessIdentity | null>()),
      killPane: vi.fn(() => after(4_000, true)),
      relaunchOld: vi.fn(() => never<boolean>()),
    })
    await run(slowest.deps)
    // Held: stop 9 + prepare 4 + respawn 4 + probe 30 + closing the new pane 4 + relaunch 20. Before it: 4 + 9 + 4.
    // Every bound was waited out, and no more.
    expect(slowest.heldMs()!).toBeGreaterThan(65_000)
    expect(slowest.heldMs()!).toBeLessThan(80_000)
    expect(movedMs).toBeGreaterThan(80_000)
    expect(movedMs).toBeLessThan(100_000)

    const hangs = harness({
      stopEngine: vi.fn(() => never<'terminated'>()),
      killPane: vi.fn(() => never<boolean>()),
      relaunchOld: vi.fn(() => never<boolean>()),
    })
    await run(hangs.deps)
    expect(hangs.heldMs()!).toBeLessThan(100_000)

    const movedButSlow = harness({
      retarget: vi.fn(() => never<void>()), releaseHold: vi.fn(() => never<void>()), killPane: vi.fn(() => never<boolean>()),
    })
    expect(await run(movedButSlow.deps)).toEqual({ moved: true, resumed: true })
    expect(movedButSlow.heldMs()!).toBeLessThan(100_000)
  })

  it('a launch that never comes ends the move with nothing changed and no route held', async () => {
    const h = harness({ buildLaunch: vi.fn(() => never<typeof LAUNCH>()) })
    expect(await run(h.deps)).toEqual({ moved: false, reason: expect.stringContaining('building the launch'), fellBack: false })
    expect(movedMs).toBeLessThan(120_000)
    expect(h.deps.createSeeded).not.toHaveBeenCalled()
    expect(h.deps.stopEngine).not.toHaveBeenCalled()
    expect(h.deps.killPane).not.toHaveBeenCalled()
    expect(h.events).not.toContain('hold')
    expect(h.holdRoute).not.toHaveBeenCalled()
    expect(h.routes.size).toBe(0)
  })

  it('a create answered after its bound closes the pane it made', async () => {
    const h = harness({ createSeeded: vi.fn(() => after(60_000, { ok: true as const, runtime: NEW })) })
    expect(await run(h.deps)).toMatchObject({ moved: false, fellBack: false })
    expect(h.deps.stopEngine).not.toHaveBeenCalled()
    expect(vi.mocked(h.deps.killPane).mock.calls.map(([runtime]) => runtime)).toEqual([NEW])
    expect(h.routes.size).toBe(0)
  })

  it('prepares the conversation only once the old engine is confirmed stopped', async () => {
    const h = harness()
    await run(h.deps)
    expect(h.events.indexOf('stop')).toBeLessThan(h.events.indexOf('prepare'))
    expect(h.events.indexOf('prepare')).toBeLessThan(h.events.indexOf('respawn'))
    expect(h.deps.prepareResume).toHaveBeenCalledTimes(1)

    for (const stopEngine of [async () => 'failed' as const, async () => 'not-ours' as const, () => never<'terminated'>()]) {
      const unconfirmed = harness({ stopEngine: vi.fn(stopEngine) })
      await run(unconfirmed.deps)
      expect(unconfirmed.deps.prepareResume).not.toHaveBeenCalled()
      expect(unconfirmed.deps.respawn).not.toHaveBeenCalled()
    }
  })

  it('a failed preparation falls back to the old pane', async () => {
    for (const prepareResume of [async () => { throw new Error('rollout repair failed') }, () => never<void>()]) {
      const h = harness({ prepareResume: vi.fn(prepareResume) })
      expect(await run(h.deps)).toEqual({ moved: false, reason: expect.any(String), fellBack: true })
      expect(h.deps.respawn).not.toHaveBeenCalled()
      expect(h.deps.swap).not.toHaveBeenCalled()
      expect(h.events.slice(-3)).toEqual(['kill %7', 'relaunchOld', 'release'])
    }
  })

  it('a route hold another owner took after the move\'s is not released by the move', async () => {
    const h = harness()
    let stopsHold: (() => void) | null = null
    // A Stop cancels the move while the old engine stops, and takes the old pane's route for its own retirement.
    let live = true
    h.deps.current = () => live
    h.deps.stopEngine = vi.fn(async () => {
      live = false
      stopsHold = h.deps.holdRoute(terminalRouteKey(OLD))
      return 'terminated' as const
    })
    expect(await run(h.deps)).toMatchObject({ moved: false })
    expect([...h.routes.keys()]).toEqual([terminalRouteKey(OLD)])
    stopsHold!()
    expect(h.routes.size).toBe(0)
  })

  it('a cancelled move (current() false) before step 5 changes nothing', async () => {
    // Each point the move can be cancelled at before the old engine is stopped, and whether a new pane exists then.
    const points: Array<[string, boolean]> = [['start', false], ['capture', false], ['buildLaunch', false], ['create', true], ['hold', true]]
    for (const [point, madePane] of points) {
      let live = point !== 'start'
      const h = harness()
      const inner = { ...h.deps }
      const cancelAt = <A extends unknown[], R>(name: string, step: (...args: A) => R) => (...args: A): R => {
        const result = step(...args)
        if (name === point) live = false
        return result
      }
      h.deps.current = () => live
      h.deps.capture = cancelAt('capture', inner.capture)
      h.deps.buildLaunch = cancelAt('buildLaunch', inner.buildLaunch)
      h.deps.createSeeded = cancelAt('create', inner.createSeeded)
      const gateHold = h.gate.hold
      h.gate.hold = cancelAt('hold', gateHold)
      const outcome = await run(h.deps)
      // Cancelled, not failed: the mover may try the agent again.
      expect(outcome, point).toMatchObject({ moved: false, fellBack: false, cancelled: true })
      expect(h.deps.stopEngine, point).not.toHaveBeenCalled()
      expect(h.deps.respawn, point).not.toHaveBeenCalled()
      expect(h.deps.swap, point).not.toHaveBeenCalled()
      expect(h.deps.relaunchOld, point).not.toHaveBeenCalled()
      // Only the pane the move made is closed; the old one is never touched.
      expect(vi.mocked(h.deps.killPane).mock.calls.map(([runtime]) => runtime), point).toEqual(madePane ? [NEW] : [])
      expect(h.gate.holding('a1'), point).toBe(false)
      expect(h.routes.size, point).toBe(0)
    }
  })

  it('input, a turn or a viewer during capture, launch or create cancels the move before the stop', async () => {
    // The agent stops being idle, quiet and unwatched while each step before the stop runs, and right before the stop.
    for (const point of ['capture', 'buildLaunch', 'create', 'hold'] as const) {
      let eligible = true
      const h = harness({ eligible: () => eligible })
      const inner = { ...h.deps }
      const at = <A extends unknown[], R>(name: string, step: (...args: A) => R) => (...args: A): R => {
        const result = step(...args)
        if (name === point) eligible = false
        return result
      }
      h.deps.capture = at('capture', inner.capture)
      h.deps.buildLaunch = at('buildLaunch', inner.buildLaunch)
      h.deps.createSeeded = at('create', inner.createSeeded)
      h.gate.hold = at('hold', h.gate.hold)
      const outcome = await run(h.deps)
      expect(outcome, point).toMatchObject({ moved: false, fellBack: false, cancelled: true })
      expect(h.deps.stopEngine, point).not.toHaveBeenCalled()
      expect(h.deps.prepareResume, point).not.toHaveBeenCalled()
      expect(h.deps.relaunchOld, point).not.toHaveBeenCalled()
      expect(vi.mocked(h.deps.killPane).mock.calls.map(([runtime]) => runtime), point).toEqual(point === 'capture' || point === 'buildLaunch' ? [] : [NEW])
      expect(h.gate.holding('a1'), point).toBe(false)
      expect(h.routes.size, point).toBe(0)
    }
  })

  it('once the old engine stopped, the agent becoming busy does not stop the move', async () => {
    let eligible = true
    const h = harness({ eligible: () => eligible, stopEngine: vi.fn(async () => { eligible = false; return 'terminated' as const }) })
    expect(await run(h.deps)).toEqual({ moved: true, resumed: true })
  })

  it('input that arrives once held, before the old engine stops, cancels the move and reaches the old pane', async () => {
    const h = harness()
    const delivered: string[] = []
    const hold = h.gate.hold
    h.gate.hold = (agentId) => {
      hold(agentId)
      h.gate.enqueue(agentId, async () => { delivered.push(h.row.runtime.paneId) })
    }
    expect(await run(h.deps)).toMatchObject({ moved: false, fellBack: false, cancelled: true })
    expect(h.deps.stopEngine).not.toHaveBeenCalled()
    expect(vi.mocked(h.deps.killPane).mock.calls.map(([runtime]) => runtime)).toEqual([NEW])
    expect(delivered).toEqual(['%1'])
  })

  it('a move cancelled once the old engine stopped leaves it stopped, for whoever cancelled it', async () => {
    let live = true
    const h = harness({ current: () => live, stopEngine: vi.fn(async () => { live = false; return 'terminated' as const }) })
    expect(await run(h.deps)).toMatchObject({ moved: false, fellBack: false, cancelled: true })
    expect(h.deps.respawn).not.toHaveBeenCalled()
    expect(h.deps.relaunchOld).not.toHaveBeenCalled()
    expect(vi.mocked(h.deps.killPane).mock.calls.map(([runtime]) => runtime)).toEqual([NEW])
    expect(h.events.at(-1)).toBe('release')
  })

  it('a pane with nothing to carry is created without a seed', async () => {
    const h = harness({ capture: vi.fn(async () => '') })
    expect(await run(h.deps)).toEqual({ moved: true, resumed: true })
    expect(h.deps.createSeeded).toHaveBeenCalledWith(expect.anything(), '')
    const request = moveCreateRequest('a1', { seed: '', command: ['sh'], cwd: '/w' })
    expect(request).not.toHaveProperty('seed')
    expect(moveCreateRequest('a1', { seed: 'x', command: ['sh'], cwd: '/w' })).toMatchObject({ seed: 'x' })
  })

  it('never moves an agent with no conversation to resume', async () => {
    const h = harness()
    const row = { ...session(), sessionId: '' } as RegisteredSession
    expect(await run(h.deps, row)).toMatchObject({ moved: false, fellBack: false })
    expect(h.deps.capture).not.toHaveBeenCalled()
  })
})

describe('moveCreateRequest', () => {
  it('opens the waiting shell in the row\'s folder, marked as the move of its agent', () => {
    expect(moveCreateRequest('a1', { seed: 'old\r\nlines', command: ['sh', '-c', 'wait'], cwd: '/w' })).toEqual({
      command: ['sh', '-c', 'wait'],
      cwd: '/w',
      env: { [MOVE_MARKER_ENV]: 'a1' },
      label: `${MOVE_MARKER_ENV}=a1`,
      seed: 'old\r\nlines',
    })
    expect(MOVE_MARKER_ENV).toBe('HARNESS_MOVE_OF')
  })
})

describe('removeOrphanMovePanes', () => {
  const backend = (inventory: TerminalInventoryResult) => {
    const kill = vi.fn(async (_runtime: TerminalRuntimeRef) => ({ state: 'succeeded' as const, dispatch: 'executed' as const }))
    return { backend: { inventory: vi.fn(async () => inventory), kill } as unknown as TerminalBackend, kill }
  }
  const pane = (paneId: string, label?: string) => ({
    runtime: { backend: 'ptyhost' as const, instance: 'p2-1.2.3', paneId }, rootPid: 100, cwd: '/w', ...(label ? { label } : {}),
  })

  it('a_move_pane_left_by_a_dead_daemon_is_removed_before_discovery', async () => {
    const marker = moveCreateRequest('a1', { seed: '', command: ['sh'] }).label!
    const target = backend({
      state: 'available',
      roots: [
        // The daemon died mid-move: the row still names the old pane, and this one is no agent's.
        pane('%7', marker),
        // An earlier move that finished: its row names the pane, which keeps its label.
        pane('%9', moveCreateRequest('a2', { seed: '', command: ['sh'] }).label),
        // Any other pane is discovery's to judge.
        pane('%3'),
      ],
    })
    const unreachable = backend({ state: 'unavailable', reason: 'pty host is unavailable' })
    const rows = [
      { ...session(), runtimes: [OLD] },
      { ...session(), agentId: 'a2', runtimes: [{ backend: 'ptyhost', instance: 'p2-1.2.3', paneId: '%9' }] },
    ] as RegisteredSession[]
    expect(await removeOrphanMovePanes([target.backend, unreachable.backend], rows)).toEqual({ removed: 1, unconfirmed: [], keptPanes: [] })
    expect(target.kill.mock.calls.map(([runtime]) => runtime.paneId)).toEqual(['%7'])
    expect(unreachable.kill).not.toHaveBeenCalled()
  })

  it('names the agents whose orphan move pane could not be confirmed closed, for restore to hold', async () => {
    const refused = backend({ state: 'available', roots: [pane('%7', moveCreateRequest('a1', { seed: '', command: ['sh'] }).label)] })
    refused.kill.mockResolvedValue({ state: 'failed', dispatch: 'rejected', reason: 'busy' } as never)
    const throws = backend({ state: 'available', roots: [pane('%8', moveCreateRequest('a3', { seed: '', command: ['sh'] }).label)] })
    throws.kill.mockRejectedValue(new Error('host gone'))
    // And the panes themselves, whose routes restore holds so discovery never mints them an agent.
    expect(await removeOrphanMovePanes([refused.backend, throws.backend], [session()])).toEqual({
      removed: 0, unconfirmed: ['a1', 'a3'], keptPanes: [expect.objectContaining({ paneId: '%7' }), expect.objectContaining({ paneId: '%8' })],
    })
  })
})
