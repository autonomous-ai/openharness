import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { failedCopy, movedCopy, pausedCopy, pickPmAccount, PmRotation, pmNeedsMove, resetTime, type PmAccount, type PmRotationDeps, type PmWindow } from './pmRotation.js'
import type { PmMove } from '../lib/pmAccountPool.js'

const T0 = Date.parse('2026-11-06T10:00:00Z')
const MIN = 60_000
const w5 = (leftPercent: number, resetsAt?: string): PmWindow => ({ name: '5-hour', leftPercent, ...(resetsAt ? { resetsAt } : {}) })
const wk = (leftPercent: number, resetsAt?: string): PmWindow => ({ name: 'weekly', leftPercent, ...(resetsAt ? { resetsAt } : {}) })
const LIMIT = "  ⎿  You've hit your weekly limit · resets Nov 10 at 6pm"
const ROW = { tabId: 't1', agent: { id: 'a1', harnessId: 'h1' } }

function rig(input: Partial<Omit<PmRotationDeps, 'pool' | 'windows'>> & { pool?: string[]; windows?: Record<string, PmWindow[]> } = {}) {
  const { pool, windows, ...over } = input
  const accounts: PmAccount[] = [{ id: 'A', label: 'Ann', home: null }, { id: 'B', label: 'Bo', home: '/b' }, { id: 'C', label: 'Cy', home: '/c' }]
  const clock = { now: T0 }
  const state = {
    windows: { A: [w5(60), wk(60)], B: [w5(80), wk(70)], C: [w5(50), wk(50)], ...windows } as Record<string, PmWindow[]>,
    screen: { text: '', hold: null as null | 'permission_open' },
    turn: 'idle' as 'busy' | 'idle' | 'unknown', alive: true, current: { h1: 'A', h2: 'A' } as Record<string, string | undefined>,
    signedIn: { A: true, B: true, C: true } as Record<string, boolean>,
  }
  const restarts: Array<[string, string | null]> = [], typed: string[] = [], told: string[] = [], moves: PmMove[] = []
  const deps: PmRotationDeps = {
    pool: () => pool ?? ['A', 'B'], accounts: () => accounts, windows: id => state.windows[id] ?? [],
    signedIn: async id => state.signedIn[id] ?? false, current: h => state.current[h], name: () => 'River',
    screen: async () => state.screen, turn: async () => state.turn, alive: () => state.alive,
    restart: async (h, home) => { restarts.push([h, home]); state.current[h] = accounts.find(a => a.home === home)!.id; return { ok: true } },
    type: async (_h, text) => { typed.push(text); return true },
    tell: async (_row, text) => { told.push(text) }, record: m => { moves.push(m) }, now: () => clock.now, log: () => {},
    ...over,
  }
  const kept: Record<string, string[]> = {}
  deps.told ??= { read: h => kept[h] ?? [], write: (h, keys) => { kept[h] = keys } }
  const rotation = new PmRotation(deps)
  const serve = (ms = 0, row = ROW) => { clock.now += ms; return rotation.serve(row, clock.now) }
  return { rotation, serve, state, restarts, typed, told, moves, clock, deps }
}

describe('pmNeedsMove', () => {
  it('4% weekly is low', () => expect(pmNeedsMove([w5(50), wk(4)], T0)).toEqual({ why: 'low', window: 'weekly', leftPercent: 4 }))
  it('5-hour at 3% with weekly 60% is low on the 5-hour window', () => expect(pmNeedsMove([w5(3), wk(60)], T0)).toEqual({ why: 'low', window: '5-hour', leftPercent: 3 }))
  it('a limit line on screen is out', () => {
    expect(pmNeedsMove([w5(50), wk(10)], T0, true)).toEqual({ why: 'out', window: 'weekly', leftPercent: 10 })
    expect(pmNeedsMove([], T0, true)).toEqual({ why: 'out', window: '5-hour', leftPercent: 0 })
  })
  it('5% exactly is not low, nor is a window whose reset has passed', () => {
    expect(pmNeedsMove([w5(5), wk(60)], T0)).toBeNull()
    expect(pmNeedsMove([w5(0, new Date(T0 - 1).toISOString()), wk(60)], T0)).toBeNull()
  })
})

describe('pickPmAccount', () => {
  const c = (id: string, windows: PmWindow[], signedIn = true) => ({ id, signedIn, windows })
  it('picks the most left in the tighter window', () => {
    expect(pickPmAccount([c('x', [w5(90), wk(30)]), c('y', [w5(60), wk(50)])], 'A')).toBe('y')
  })
  it('on a tie picks the soonest weekly reset, one with no time last', () => {
    expect(pickPmAccount([c('x', [wk(50, '2026-11-12T00:00:00Z')]), c('y', [wk(50, '2026-11-09T00:00:00Z')]), c('z', [wk(50)])], 'A')).toBe('y')
    expect(pickPmAccount([c('z', [wk(50)]), c('x', [wk(50, 'nonsense')])], 'A')).toBe('z')
  })
  it('skips signed-out, 5% or less, no reading, and the current account', () => {
    expect(pickPmAccount([c('x', [w5(90), wk(90)], false), c('y', [w5(90), wk(5)]), c('n', []), c('A', [w5(99), wk(99)])], 'A')).toBeNull()
  })
  it('counts a passed reset as full', () => {
    expect(pickPmAccount([c('x', [w5(0, new Date(T0 - 1).toISOString()), wk(80)])], 'A', T0)).toBe('x')
    expect(pickPmAccount([c('x', [w5(0, new Date(T0 - 1).toISOString()), wk(80)])], 'A')).toBeNull()
  })
})

describe('PmRotation', () => {
  it('moves between turns when low', async () => {
    const r = rig({ windows: { A: [w5(60), wk(4)] } })
    r.state.turn = 'busy'
    await r.serve()
    expect(r.restarts).toEqual([])
    r.state.turn = 'idle'
    await r.serve(1000)
    expect(r.restarts).toEqual([['h1', '/b']])
    expect(r.typed).toEqual([])
  })

  it('does nothing for an unknown turn, or while it is not low', async () => {
    const r = rig({ windows: { A: [w5(60), wk(4)] } })
    r.state.turn = 'unknown'
    await r.serve()
    expect(r.restarts).toEqual([])
    const ok = rig()
    await ok.serve()
    expect(ok.restarts).toEqual([])
  })

  it('moves after 10 minutes without a pause', async () => {
    const r = rig({ windows: { A: [w5(60), wk(4)] } })
    r.state.turn = 'busy'
    for (let i = 0; i < 11; i++) await r.serve(MIN)
    expect(r.restarts).toEqual([])
    r.state.turn = 'idle'
    await r.serve(1000)
    expect(r.restarts).toHaveLength(1)
  })

  it('an out PM moves at once and types Continue', async () => {
    const r = rig()
    r.state.turn = 'busy'
    r.state.screen.text = LIMIT
    await r.serve()
    expect(r.restarts).toEqual([['h1', '/b']])
    expect(r.moves[0]).toMatchObject({ why: 'out', from: 'A', to: 'B', ok: true })
    r.state.screen.text = '> '
    r.state.turn = 'idle'
    await r.serve(1000)
    expect(r.typed).toEqual([])
    r.state.screen.hold = 'permission_open'
    await r.serve(4000)
    expect(r.typed).toEqual([])
    r.state.screen.hold = null
    await r.serve(1000)
    expect(r.typed).toEqual(['Continue'])
    // It went to work on it: counted, never typed again.
    r.state.turn = 'busy'
    await r.serve(1000)
    r.state.turn = 'idle'
    await r.serve(40_000)
    expect(r.typed).toEqual(['Continue'])
  })

  it('Continue waits for an idle turn, and is typed again up to three times until the PM works on it', async () => {
    const r = rig()
    r.state.screen.text = LIMIT
    await r.serve()
    r.state.screen.text = '> '
    r.state.turn = 'busy'
    await r.serve(5000)
    r.state.turn = 'unknown'
    await r.serve(1000)
    expect(r.typed).toEqual([])
    r.state.turn = 'idle'
    await r.serve(1000)
    expect(r.typed).toEqual(['Continue'])
    await r.serve(5000)
    expect(r.typed).toEqual(['Continue'])
    await r.serve(5000)
    expect(r.typed).toEqual(['Continue', 'Continue'])
    await r.serve(10_000)
    expect(r.typed).toHaveLength(3)
    await r.serve(10_000)
    await r.serve(10_000)
    expect(r.typed).toHaveLength(3)
    // Given up on: nothing more is owed, and a limit-free PM moves on normally.
    r.state.windows.B = [w5(60), wk(60)]
    await r.serve(10 * MIN)
    expect(r.typed).toHaveLength(3)
  })

  it('an unconfirmed Continue is not taken for done while it can still be retried', async () => {
    const r = rig({ type: async () => false })
    r.state.screen.text = LIMIT
    await r.serve()
    r.state.screen.text = '> '
    await r.serve(31_000)
    await r.serve(10_000)
    expect(r.typed).toEqual([])
  })

  it('gives up on Continue when the screen never gets ready', async () => {
    const r = rig()
    r.state.screen.text = LIMIT
    await r.serve()
    r.state.screen.text = ''
    for (let i = 0; i < 7; i++) await r.serve(10_000)
    expect(r.typed).toEqual([])
    r.state.screen.text = '> '
    await r.serve(10_000)
    expect(r.typed).toEqual([])
  })

  it('fewer than two ticked accounts never moves', async () => {
    const r = rig({ pool: ['B', 'gone'], windows: { A: [w5(60), wk(4)] } })
    await r.serve()
    expect(r.restarts).toEqual([])
    const solo = rig({ pool: ['A'], windows: { A: [w5(60), wk(4)] } })
    solo.state.screen.text = LIMIT
    await solo.serve()
    expect(solo.restarts).toEqual([])
  })

  it('a second move waits 2 minutes', async () => {
    const r = rig({ pool: ['A', 'B', 'C'], windows: { A: [w5(60), wk(60)] } })
    r.state.windows.A = [w5(60), wk(4)]
    await r.serve()
    expect(r.restarts).toHaveLength(1)
    r.state.windows.B = [w5(2), wk(70)]
    await r.serve(40_000)
    expect(r.restarts).toHaveLength(1)
    await r.serve(60_000)
    expect(r.restarts).toHaveLength(1)
    await r.serve(30_000)
    expect(r.restarts).toEqual([['h1', '/b'], ['h1', '/c']])
  })

  it('the owner is told each move', async () => {
    const r = rig({ windows: { A: [w5(60), wk(4)] } })
    await r.serve()
    expect(r.told).toEqual(['River moved to Bo: Ann had 4% of its week left. Same conversation.'])
    expect(r.moves[0]).toMatchObject({ at: T0, pm: 'River', from: 'A', to: 'B', why: 'low', window: 'weekly', leftPercent: 4, awayMs: 0, ok: true })
    const fiveHour = rig({ windows: { A: [w5(3), wk(60)] } })
    await fiveHour.serve()
    expect(fiveHour.told).toEqual(['River moved to Bo: Ann had 3% of its 5-hour window left. Same conversation.'])
    const out = rig()
    out.state.screen.text = LIMIT
    await out.serve()
    expect(out.told).toEqual(['River moved to Bo: Ann was out of quota. Same conversation.'])
    expect(movedCopy('P', 'B', 'A', { why: 'low', window: 'weekly', leftPercent: 1 }, false)).toContain('1% of its week')
  })

  it('records how long the PM was away', async () => {
    const r = rig()
    r.state.screen.text = LIMIT
    await r.serve()
    r.state.screen.text = '> '
    r.state.current.h1 = 'A'
    await r.serve(2000)
    expect(r.moves[0]!.awayMs).toBe(0)
    const slow = rig({ restart: async () => { slowClock.now += 7000; return { ok: true } } })
    const slowClock = { now: T0 }
    slow.state.screen.text = LIMIT
    const again = new PmRotation({ ...slow.deps, now: () => slowClock.now })
    await again.serve(ROW, T0)
    expect(slow.moves[0]!.awayMs).toBe(7000)
  })

  it('a failed telling does not stop the move', async () => {
    const log = vi.fn()
    const r = rig({ windows: { A: [w5(60), wk(4)] }, tell: async () => { throw new Error('offline') }, log })
    await r.serve()
    expect(r.restarts).toHaveLength(1)
    expect(log).toHaveBeenCalledWith('PM account rotation: could not tell the owner: offline')
    const text = rig({ windows: { A: [w5(60), wk(4)] }, tell: async () => { throw 'no' }, log })
    await text.serve()
    expect(log).toHaveBeenCalledWith('PM account rotation: could not tell the owner: no')
  })

  it('a refused restart tells the owner and waits without claiming a move', async () => {
    const log = vi.fn()
    const r = rig({ windows: { A: [w5(60), wk(4)] }, restart: async () => ({ ok: false, error: 'INVALID_PROFILE' }), log })
    await r.serve()
    await r.serve(1000)
    expect(r.moves).toEqual([expect.objectContaining({ from: 'A', to: 'B', ok: false })])
    expect(r.told).toHaveLength(1)
    expect(r.told[0]).toContain('could not move to Bo')
    expect(r.told[0]).not.toContain('is back on')
    expect(log).toHaveBeenCalledTimes(1)
  })

  it.each(['reply', 'throw'] as const)('a failure after the old PM stops is visible for a %s failure', async failure => {
    const r = rig({ windows: { A: [w5(60), wk(4)] }, restart: async () => {
      r.state.alive = false
      if (failure === 'throw') throw new Error('resume failed')
      return { ok: false, error: 'RESTART_FAILED' }
    } })
    await r.serve()
    expect(r.told).toHaveLength(1)
    expect(r.told[0]).toContain('could not move to Bo')
    expect(r.told[0]).not.toMatch(/is back on|moved to/)
    expect(r.moves).toEqual([expect.objectContaining({ ok: false })])
    await r.serve(1000)
    expect(r.told).toHaveLength(1)
  })

  it('every account out tells the owner once and waits for the earliest reset', async () => {
    const soon = new Date(T0 + 3 * 60 * MIN).toISOString(), later = new Date(T0 + 30 * 60 * MIN).toISOString()
    const r = rig({ windows: { A: [w5(0, later), wk(60)], B: [w5(0, soon), wk(60)] } })
    r.state.screen.text = LIMIT
    await r.serve()
    await r.serve(20_000)
    await r.serve(20_000)
    expect(r.restarts).toEqual([])
    expect(r.told).toEqual([pausedCopy('River', Date.parse(soon), 'Bo')])
    expect(r.told[0]).toBe(`River is paused: every Claude account it may use is out. The earliest resets at ${resetTime(Date.parse(soon))} (Bo).`)
    // Another reset window is told again.
    r.state.windows.B = [w5(0, later), wk(60)]
    r.state.windows.A = [w5(0, new Date(T0 + 60 * MIN).toISOString()), wk(60)]
    await r.serve(20_000)
    expect(r.told).toHaveLength(2)
    // The reset comes and the reading refreshes: the PM moves, as a reset.
    r.state.windows.B = [w5(100), wk(100)]
    await r.serve(20_000)
    expect(r.restarts).toEqual([['h1', '/b']])
    expect(r.moves[0]!.why).toBe('reset')
  })

  it('says nothing when no reading gives a reset time, and uses the screen time for an unread account', async () => {
    const r = rig({ windows: { A: [], B: [w5(0), wk(60)] } })
    r.state.screen.text = "  ⎿  You've hit your weekly limit"
    await r.serve()
    expect(r.told).toEqual([])
    const own = rig({ windows: { A: [], B: [] } })
    own.state.screen.text = "  ⎿  You've hit your weekly limit · try again in 2 hours"
    await own.serve()
    expect(own.told).toEqual([pausedCopy('River', T0 + 120 * MIN, 'Ann')])
  })

  it('a reset after a daemon restart still continues the PM', async () => {
    const past = new Date(T0 - MIN).toISOString()
    const first = rig({ windows: { A: [w5(0, past), wk(60)], B: [w5(0, past), wk(60)] } })
    first.state.screen.text = LIMIT
    // A fresh PmRotation knows nothing of the wait: the readings and the screen are all it has.
    await first.serve()
    expect(first.restarts).toEqual([['h1', '/b']])
    expect(first.moves[0]!.why).toBe('reset')
    first.state.screen.text = '> '
    await first.serve(5000)
    expect(first.typed).toEqual(['Continue'])
  })

  it('a reset of its own account only continues, with no restart', async () => {
    const past = new Date(T0 - MIN).toISOString()
    const r = rig({ windows: { A: [w5(0, past), wk(60)], B: [w5(0, new Date(T0 + 99 * MIN).toISOString()), wk(60)] } })
    r.state.screen.text = LIMIT
    await r.serve()
    expect(r.restarts).toEqual([])
    r.state.screen.text = '> '
    await r.serve(5000)
    expect(r.typed).toEqual(['Continue'])
    expect(r.moves).toEqual([])
  })

  it('an unticked current account is left at the next move, not at once', async () => {
    const r = rig({ pool: ['B', 'C'] })
    await r.serve()
    await r.serve(60_000)
    expect(r.restarts).toEqual([])
    r.state.windows.A = [w5(2), wk(60)]
    await r.serve(1000)
    expect(r.restarts).toEqual([['h1', '/b']])
  })

  it('two PMs pick independently', async () => {
    const r = rig({ pool: ['A', 'B', 'C'], windows: { A: [w5(2), wk(60)] } })
    const row2 = { tabId: 't2', agent: { id: 'a2', harnessId: 'h2' } }
    await r.serve(0, ROW)
    // The first move fills B; the second PM reads quota after it.
    r.state.windows.B = [w5(1), wk(70)]
    await r.serve(0, row2)
    expect(r.restarts).toEqual([['h1', '/b'], ['h2', '/c']])
  })

  it('a failed resume falls back once', async () => {
    const r = rig({ windows: { A: [w5(60), wk(4)] } })
    await r.serve()
    expect(r.restarts).toEqual([['h1', '/b']])
    r.state.screen.text = LIMIT
    await r.serve(10_000)
    expect(r.restarts).toEqual([['h1', '/b'], ['h1', null]])
    expect(r.told[1]).toBe(failedCopy('River', 'Bo', 'Ann'))
    expect(r.told[1]).toBe('River could not move to Bo and is back on Ann.')
    expect(r.moves[1]).toMatchObject({ why: 'fallback', from: 'B', to: 'A', ok: true })
    for (let i = 0; i < 5; i++) await r.serve(3 * MIN)
    expect(r.restarts).toHaveLength(2)
  })

  it('a process that exits, or an error line, within 30 s is a failed resume', async () => {
    const dead = rig({ windows: { A: [w5(60), wk(4)] } })
    await dead.serve()
    dead.state.alive = false
    await dead.serve(5000)
    expect(dead.restarts).toHaveLength(2)
    const bad = rig({ windows: { A: [w5(60), wk(4)] } })
    await bad.serve()
    bad.state.screen.text = '  ⎿  Not logged in · Please run /login'
    await bad.serve(5000)
    expect(bad.restarts).toHaveLength(2)
  })

  it('a fallback that cannot happen is logged, and an unknown first account has none', async () => {
    const log = vi.fn()
    let calls = 0
    const r = rig({ windows: { A: [w5(60), wk(4)] }, log, restart: async (h, home) => (calls++ ? { ok: false, error: 'BOOM' } : (r2.state.current[h] = 'B', { ok: true })) })
    const r2 = r
    await r.serve()
    r.state.alive = false
    await r.serve(5000)
    expect(r.moves[1]).toMatchObject({ why: 'fallback', ok: false })
    expect(log).toHaveBeenCalledWith(expect.stringContaining('could not go back'))
    expect(r.told[1]).toContain('could not move back to Ann')
    expect(r.told[1]).not.toContain('is back on Ann')
    const lost = rig({ windows: { A: [w5(60), wk(4)] }, log })
    lost.state.current.h1 = undefined
    lost.state.screen.text = LIMIT
    await lost.serve()
    expect(lost.restarts).toHaveLength(1)
    expect(lost.told[0]).toContain('its account was out')
    lost.state.alive = false
    await lost.serve(5000)
    expect(lost.restarts).toHaveLength(1)
    expect(log).toHaveBeenCalledWith(expect.stringContaining('first account is unknown'))
    expect(lost.told[1]).toContain('could not recover')
  })

  it('a throwing rollback tells the owner once and does not claim recovery', async () => {
    const r = rig({ windows: { A: [w5(60), wk(4)] } })
    await r.serve()
    r.state.alive = false
    r.deps.restart = async () => { throw new Error('offline') }
    await r.serve(5000)
    expect(r.told[1]).toContain('could not move back to Ann')
    expect(r.told[1]).not.toContain('is back on')
    expect(r.moves[1]).toMatchObject({ why: 'fallback', ok: false })
    await r.serve(1000)
    expect(r.told).toHaveLength(2)
  })

  it('an unreadable screen says nothing, a throwing step is logged, and keep forgets gone PMs', async () => {
    const log = vi.fn()
    const r = rig({ windows: { A: [w5(60), wk(4)] }, screen: async () => null, log })
    await r.serve()
    expect(r.restarts).toHaveLength(1)
    const bad = rig({ log, accounts: () => { throw new Error('disk') } })
    await bad.serve()
    expect(log).toHaveBeenCalledWith('PM account rotation: disk')
    const odd = rig({ log, accounts: () => { throw 'x' } })
    await odd.serve()
    expect(log).toHaveBeenCalledWith('PM account rotation: x')
    r.rotation.keep(new Set(['h1']))
    r.rotation.keep(new Set(['h9']))
    r.rotation.keep(new Set())
    r.state.current.h1 = 'A'
    await r.serve(10 * MIN)
    expect(r.restarts).toHaveLength(2)
  })

  it('one pass at a time per PM, and a low account with nowhere to go waits', async () => {
    let release = () => {}
    const r = rig({ windows: { A: [w5(60), wk(4)], B: [w5(1), wk(1)] }, turn: () => new Promise(done => { release = () => done('idle') }) })
    const first = r.serve()
    await r.serve()
    release()
    await first
    expect(r.restarts).toEqual([])
    await r.serve(1000)
    expect(r.restarts).toEqual([])
  })

  it('an account a resume failed on is avoided until the wait ends', async () => {
    const r = rig({ pool: ['A', 'B', 'C'], windows: { A: [w5(60), wk(4)] } })
    await r.serve()
    r.state.alive = false
    await r.serve(5000)
    r.state.alive = true
    r.state.windows.A = [w5(60), wk(4)]
    await r.serve(3 * MIN)
    expect(r.restarts.at(-1)).toEqual(['h1', '/c'])
    r.state.alive = true
    r.state.current.h1 = 'A'
    r.state.windows.C = [w5(1), wk(1)]
    await r.serve(40 * MIN)
    expect(r.restarts.at(-1)).toEqual(['h1', '/b'])
  })

  describe('review fixes', () => {
    const BUSY_LIMIT = '  ⎿  You\'ve hit your 5-hour limit · resets 4pm'
    it('a stale limit line after an out move does not fall back', async () => {
      const r = rig()
      r.state.screen.text = `> hi\n${LIMIT}`
      await r.serve()
      expect(r.restarts).toEqual([['h1', '/b']])
      // The resume draws the old conversation again, the old limit line included.
      r.state.screen.text = `> hi\n${LIMIT}\n> `
      await r.serve(10_000)
      await r.serve(10_000)
      for (let i = 0; i < 6; i++) await r.serve(MIN)
      expect(r.restarts).toEqual([['h1', '/b']])
      expect(r.moves).toHaveLength(1)
    })

    it('a new limit line after the move falls back once', async () => {
      const r = rig()
      r.state.screen.text = `> hi\n${LIMIT}`
      await r.serve()
      r.state.screen.text = `> hi\n${LIMIT}\n${BUSY_LIMIT}`
      await r.serve(10_000)
      expect(r.restarts).toEqual([['h1', '/b'], ['h1', null]])
      // The failed account's lines drawn again after the way back are not an out PM either.
      r.state.screen.text = `> hi\n${LIMIT}\n${BUSY_LIMIT}\n> `
      for (let i = 0; i < 6; i++) await r.serve(MIN)
      expect(r.restarts).toHaveLength(2)
      // The same sentence once more than before counts as new.
      const again = rig()
      again.state.screen.text = LIMIT
      await again.serve()
      again.state.screen.text = `${LIMIT}\n${LIMIT}`
      await again.serve(10_000)
      expect(again.restarts).toHaveLength(2)
    })

    it('an old line counts again once it has left the screen', async () => {
      const r = rig()
      r.state.screen.text = LIMIT
      await r.serve()
      r.state.screen.text = '> '
      await r.serve(70_000)
      r.state.screen.text = LIMIT
      await r.serve(10_000)
      await r.serve(3 * MIN)
      expect(r.restarts).toEqual([['h1', '/b'], ['h1', null]])
    })

    it('the PM continues on its own account after its reset, even when a fresh reading shows 100%', async () => {
      const r = rig({ windows: { A: [w5(60), wk(60)], B: [w5(0, new Date(T0 + 99 * 60 * MIN).toISOString()), wk(60)] } })
      r.state.screen.text = "  ⎿  You've hit your 5-hour limit · try again in 2 hours"
      await r.serve()
      expect(r.restarts).toEqual([])
      expect(r.told).toHaveLength(1)
      // Three hours on, the screen still says it and the reading is full again.
      r.state.windows.A = [w5(100), wk(100)]
      await r.serve(3 * 60 * MIN)
      expect(r.restarts).toEqual([])
      r.state.screen.text = '> '
      await r.serve(5000)
      expect(r.typed).toEqual(['Continue'])
      expect(r.moves).toEqual([])
    })

    it('a process that is gone and a screen that cannot be read still falls back', async () => {
      const r = rig({ windows: { A: [w5(60), wk(4)] }, screen: async () => null })
      await r.serve()
      r.state.alive = false
      await r.serve(5000)
      expect(r.restarts).toEqual([['h1', '/b'], ['h1', null]])
    })

    it('a manual restart during the check does not fall back', async () => {
      let restarting = true
      const r = rig({ windows: { A: [w5(60), wk(4)] }, restarting: () => restarting })
      await r.serve()
      r.state.alive = false
      await r.serve(5000)
      expect(r.restarts).toHaveLength(1)
      restarting = false
      await r.serve(5000)
      expect(r.restarts).toHaveLength(2)
    })

    it('no tell or log line carries an email', async () => {
      const lines: string[] = []
      const accounts: PmAccount[] = [{ id: 'A', label: 'ann@x.test', reportLabel: 'Claude', home: null }, { id: 'B', label: 'bo@x.test', reportLabel: 'Work', home: '/b' }, { id: 'C', label: 'cy@x.test', home: '/c' }]
      const check = (r: ReturnType<typeof rig>) => { expect([...r.told, ...lines].filter(l => l.includes('@'))).toEqual([]) }
      const r = rig({ accounts: () => accounts, log: m => lines.push(m), pool: ['A', 'B', 'C'], windows: { A: [w5(60), wk(4)] } })
      await r.serve()
      expect(r.told[0]).toContain('Work')
      expect(r.told[0]).toContain('Claude')
      r.state.alive = false
      await r.serve(5000)
      expect(r.told.at(-1)).toContain('back on Claude')
      expect(lines.length).toBeGreaterThan(0)
      check(r)
      const out = rig({ accounts: () => accounts, log: m => lines.push(m), pool: ['A', 'C'], windows: { A: [w5(0, new Date(T0 + 60 * MIN).toISOString()), wk(60)], C: [w5(0, new Date(T0 + 30 * MIN).toISOString()), wk(60)] } })
      out.state.screen.text = LIMIT
      await out.serve()
      expect(out.told[0]).toContain('a Claude account')
      check(out)
      const failing = rig({ accounts: () => accounts, log: m => lines.push(m), restart: async () => ({ ok: false, error: 'BOOM' }), windows: { A: [w5(60), wk(4)] } })
      await failing.serve()
      check(failing)
    })

    it('an unknown turn for ten minutes moves a low PM from a waiting prompt only', async () => {
      const r = rig({ windows: { A: [w5(60), wk(4)] } })
      r.state.turn = 'unknown'
      r.state.screen.text = '> '
      await r.serve()
      await r.serve(9 * MIN)
      expect(r.restarts).toEqual([])
      await r.serve(2 * MIN)
      expect(r.restarts).toEqual([])
      r.state.screen.hold = 'permission_open'
      await r.serve(10_000)
      await r.serve(10_000)
      expect(r.restarts).toEqual([['h1', '/b']])
    })

    it('a busy PM waits for its turn end however long it has been busy, and the unknown clock restarts after a known turn', async () => {
      const r = rig({ windows: { A: [w5(60), wk(4)] } })
      r.state.turn = 'busy'
      for (let i = 0; i < 12; i++) await r.serve(MIN)
      expect(r.restarts).toEqual([])
      r.state.turn = 'idle'
      await r.serve(MIN)
      expect(r.restarts).toEqual([['h1', '/b']])
      const u = rig({ windows: { A: [w5(60), wk(4)], B: [w5(1), wk(1)] } })
      u.state.turn = 'unknown'
      u.state.screen.hold = 'permission_open'
      await u.serve()
      u.state.turn = 'busy'
      await u.serve(6 * MIN)
      u.state.turn = 'unknown'
      await u.serve(6 * MIN)
      expect(u.restarts).toEqual([])
    })

    it('the all-out notice is told once per reset window across a daemon restart', async () => {
      const soon = new Date(T0 + 3 * 60 * MIN).toISOString()
      const kept: Record<string, string[]> = {}
      const told = { read: (h: string) => kept[h] ?? [], write: (h: string, keys: string[]) => { kept[h] = keys } }
      const first = rig({ told, windows: { A: [w5(0, soon), wk(60)], B: [w5(0, soon), wk(60)] } })
      first.state.screen.text = LIMIT
      await first.serve()
      expect(first.told).toHaveLength(1)
      const second = rig({ told, windows: { A: [w5(0, soon), wk(60)], B: [w5(0, soon), wk(60)] } })
      second.state.screen.text = LIMIT
      await second.serve()
      expect(second.told).toEqual([])
    })

    it('without a given store the told windows are kept in the pool\'s private state', async () => {
      const soon = new Date(T0 + 3 * 60 * MIN).toISOString()
      const mk = () => {
        const r = rig({ windows: { A: [w5(0, soon), wk(60)], B: [w5(0, soon), wk(60)] } })
        r.state.screen.text = LIMIT
        return new PmRotation({ ...r.deps, told: undefined, tell: async (_row, text) => { r.told.push(text) } }).serve(ROW, T0).then(() => r.told)
      }
      try {
        expect(await mk()).toHaveLength(1)
        expect(await mk()).toEqual([])
      } finally { rmSync(join(process.env.ADAPTER_DATA_DIR!, 'pm-account-told.json'), { force: true }) }
    })
  })
})
