import { describe, expect, it } from 'vitest'
import { HELD_OUT, MAIN } from './catalog.js'
import { evaluate } from './checks.js'
import { agentIdOf, type Dimension, type Scenario, type Seen, type SessionDef, type SessionKey } from './types.js'

const ORCA = MAIN.filter((s) => s.app === 'orca')
const byId = (id: string): Scenario => ORCA.find((s) => s.id === id)!
const agents = (s: Scenario): SessionDef[] => s.sessions.filter((d) => d.app === 'orca' && !d.ghost)

describe("Orca's scenarios", () => {
  it("Orca's main ids are O1-O17, none held out, 17", () => {
    expect(ORCA.map((s) => s.id)).toEqual(Array.from({ length: 17 }, (_, i) => `O${i + 1}`))
    expect(ORCA.every((s) => !s.heldOut)).toBe(true)
    expect(HELD_OUT.filter((s) => s.id.startsWith('O') && !s.id.startsWith('OH'))).toEqual([])
  })

  it('every O scenario runs on every platform in both tiers, but O16 in tier A alone, for its time in tier B', () => {
    for (const s of ORCA) {
      expect(s.platforms, s.id).toEqual(['darwin', 'win32', 'linux'])
      expect(s.tiers, s.id).toEqual(s.id === 'O16' ? ['a'] : ['a', 'b'])
    }
  })

  it("each O scenario's checks cover exactly the spec's dims, and D8 in tier B", () => {
    const dims: Record<string, Dimension[]> = {
      O1: ['D1'], O2: ['D1', 'D7'], O3: ['D1', 'D7'], O4: ['D2'], O5: ['D2'], O6: ['D2', 'D1'], O7: ['D3'], O8: ['D4', 'D6'],
      O9: ['D5'], O10: ['D5'], O11: ['D1'], O12: ['D7', 'D1', 'D2'], O13: ['D7', 'D1', 'D3'], O14: ['D7', 'D1'],
      O15: ['D7', 'D1'], O16: ['D1', 'D7'], O17: ['D7', 'D3'],
    }
    for (const s of ORCA) {
      const want = [...dims[s.id]!, ...s.tiers.includes('b') ? ['D8'] : []]
      expect([...s.dims].sort(), s.id).toEqual([...want].sort())
      expect([...new Set(s.checks.map((c) => c.dim))].sort(), s.id).toEqual([...want].sort())
    }
  })

  it('every O scenario declares the ghost and opens with the layout, then the plugin', () => {
    for (const s of ORCA) {
      expect(s.sessions.filter((d) => d.ghost).map((d) => [d.key, d.app]), s.id).toEqual([['z', 'orca']])
      expect(s.steps.slice(0, 2).map((step) => step.kind), s.id).toEqual(['orca.layout', 'orca.plugin'])
    }
  })

  it("O5's world has no watch-focus and O13's no plugin", () => {
    for (const s of ORCA) {
      expect(s.world?.orca, s.id).toEqual({ O5: { watchFocus: false }, O13: { plugin: false } }[s.id])
    }
  })

  it('no two sessions of a scenario share a pane', () => {
    for (const s of ORCA) {
      const panes = agents(s).map((d) => `${d.worktree} ${d.tab} ${d.split}`)
      expect(new Set(panes).size, s.id).toBe(panes.length)
    }
  })

  it("O12 grades its ring and its focus line past the devices' next 30 s look after the relaunch, whatever its phase", () => {
    const o12 = byId('O12')
    const at = (label: string): number => o12.steps.findIndex((step) => step.label === label)
    // The person's own time from the relaunch to the focus line: a 30 s look at the agents' processes
    // (services/devices.ts OBSERVED_TICK_MS) falls in it on every run, with 5 s for its push to reach the face.
    const own = o12.steps.slice(at('relaunch'), at('focus'))
      .reduce((sum, step) => sum + (step.kind === 'wait' && step.until === undefined ? step.ms : 0), 0)
    expect(own).toBeGreaterThanOrEqual(35_000)
    expect(o12.checks.filter((c) => c.kind === 'ring').map((c) => [c.id, c.after, c.at])).toEqual([
      ['ringKept', 'relaunch', undefined], ['ring', 'relaunch', 'focus'],
    ])
  })

  it("O14 and O15 run in tier B on a daemon of their own, so the devices' 30 s look has the phase it has in tier A", () => {
    // A pane closed with no end hook leaves at the devices' next look at their agents' processes. Tier A's devices start
    // with the scenario; on a shared daemon the look's phase is the scenario before's, and it fell 3 s after O14's removal
    // when O14 followed O13 (whose agents end with SessionEnd), after its end when O14 began on a look.
    expect(ORCA.filter((s) => s.fresh).map((s) => s.id)).toEqual(['O14', 'O15'])
  })

  it("O4's echo check can fail: the dial left on b after the tap on a passes, the tap's echo pulling it back to a fails", () => {
    const o4 = byId('O4')
    const [a, b] = agents(o4).map(agentIdOf)
    // Each step at the scenario's own time; the person swipes to b a second after the tap, and the tap's echo, Orca's
    // focus line for a, lands 1.5 s after it.
    let now = 0
    const steps = o4.steps.flatMap((step, index) => {
      if (step.kind === 'wait') {
        now += step.ms
        return []
      }
      return [{ at: now, index, kind: step.kind, ...(step.label === undefined ? {} : { label: step.label }) }]
    })
    const tap = steps.find((s) => s.label === 'tap')!.at
    const face = (at: number, active: string) => ({ at, page: 'orca', tiles: [a!, b!], active, refused: 0 })
    const faces = [face(0, b!), face(tap, a!), face(tap + 1_000, b!)]
    const echo = (seen: Seen['faces']) => evaluate(o4.checks.find((c) => c.id === 'echo')!, o4,
      { frames: [], faces: seen, commands: [], deliveries: [], steps }, 'a', 'darwin').map((r) => [r.check, r.score])
    expect(echo(faces)).toEqual([['echo.lands', 1], ['echo.latency', 1], ['echo.noBounce', 1]])
    expect(echo([...faces, face(tap + 1_500, a!)])).toEqual([['echo.lands', 0], ['echo.latency', 1], ['echo.noBounce', 0]])
  })

  it("O9's words reach its Claude Code through the mod, O10's are typed into its Codex's pane", () => {
    const paths = (id: string) => byId(id).checks.flatMap((c) => (c.kind === 'voice' ? [c.path] : []))
    expect([paths('O9'), paths('O10')]).toEqual([['mod'], ['typed']])
  })

  it("O2's c is in w2 with w1's folder", () => {
    const c = byId('O2').sessions.find((d) => d.key === 'c')!
    expect([c.worktree, c.cwd]).toEqual(['w2', '/work/eval-w1'])
  })

  it('O16 stays inside the bounds: 40 worktrees, 40 handles, no front over 50 terminals', () => {
    // 64 worktrees, 256 handles and 50 front terminals are the devices' bounds: a scenario past one is not graded.
    const o16 = byId('O16')
    const layouts = o16.steps.flatMap((step) => (step.kind === 'orca.layout' ? [step.worktrees] : []))
    expect(layouts.map((w) => new Set(w).size)).toEqual([40])
    expect(new Set(agents(o16).map((d) => d.handle)).size).toBe(40)
    for (const step of o16.steps) {
      if (step.kind === 'orca.front') expect(agents(o16).filter((d) => d.worktree === step.worktree).length).toBeLessThanOrEqual(50)
    }
    expect(o16.steps.filter((step) => step.kind === 'orca.front').length).toBeLessThanOrEqual(1)
  })

  it("a ring an O scenario waits for or expects lists its agents in Orca's tab order", () => {
    // Each worktree in the order it was first laid out, then its tabs, then each tab's splits.
    for (const s of ORCA) {
      const worktrees = [...new Set(s.steps.flatMap((step) => (step.kind === 'orca.layout' ? step.worktrees : [])))]
      const place = new Map(agents(s).map((d) => [d.key, [worktrees.indexOf(d.worktree!), d.tab!, d.split!]]))
      const before = (x: SessionKey, y: SessionKey): number => {
        const [p, q] = [place.get(x)!, place.get(y)!]
        return p[0]! - q[0]! || p[1]! - q[1]! || p[2]! - q[2]!
      }
      const rings = [...s.steps.flatMap((step) => (step.kind === 'wait' && step.until ? [step.until.expect] : [])),
        ...[...s.checks, ...s.probes].flatMap((c) => (c.kind === 'ring' ? [c.expect.filter((key) => key !== 'z')] : []))]
      for (const ring of rings) expect(ring, s.id).toEqual([...ring].sort(before))
    }
  })
})
