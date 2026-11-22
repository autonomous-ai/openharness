import { describe, expect, it } from 'vitest'
import { HELD_OUT, MAIN } from './catalog.js'
import type { Dimension, Scenario, SessionDef, SessionKey } from './types.js'

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
