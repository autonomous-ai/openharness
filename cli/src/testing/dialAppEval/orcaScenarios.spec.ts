import { describe, expect, it } from 'vitest'
import { HELD_OUT, MAIN } from './catalog.js'
import { evaluate } from './checks.js'
import { agentIdOf, type Dimension, type Scenario, type Seen, type SessionDef, type SessionKey } from './types.js'

const ORCA = MAIN.filter((s) => s.app === 'orca')
const byId = (id: string): Scenario => ORCA.find((s) => s.id === id)!
const agents = (s: Scenario): SessionDef[] => s.sessions.filter((d) => d.app === 'orca' && !d.ghost)

describe("Orca's scenarios", () => {
  it("Orca's main ids are O1-O26, none held out, 26", () => {
    expect(ORCA.map((s) => s.id)).toEqual(Array.from({ length: 26 }, (_, i) => `O${i + 1}`))
    expect(ORCA.every((s) => !s.heldOut)).toBe(true)
    expect(HELD_OUT.filter((s) => s.id.startsWith('O') && !s.id.startsWith('OH'))).toEqual([])
  })

  it("every O scenario runs on every platform in both tiers, but O16 in tier A alone, for its time in tier B, the chats' O18-O23, which tier B's fake Orca does not list, and O11, O24, O25 and O26 in tier A on macOS and Linux alone, for their tmux", () => {
    const tmux = ['O11', 'O24', 'O25', 'O26']
    const onlyA = [...tmux, 'O16', 'O18', 'O19', 'O20', 'O21', 'O22', 'O23']
    for (const s of ORCA) {
      expect(s.platforms, s.id).toEqual(tmux.includes(s.id) ? ['darwin', 'linux'] : ['darwin', 'win32', 'linux'])
      expect(s.tiers, s.id).toEqual(onlyA.includes(s.id) ? ['a'] : ['a', 'b'])
    }
  })

  it("each O scenario's checks cover exactly the spec's dims, and D8 in tier B", () => {
    const dims: Record<string, Dimension[]> = {
      O1: ['D1'], O2: ['D1', 'D7'], O3: ['D1', 'D7'], O4: ['D2'], O5: ['D2'], O6: ['D2', 'D1'], O7: ['D3'], O8: ['D4', 'D6'],
      O9: ['D5'], O10: ['D5'], O11: ['D1', 'D3', 'D5'], O12: ['D7', 'D1', 'D2'], O13: ['D7', 'D1', 'D3'], O14: ['D7', 'D1'],
      O15: ['D7', 'D1'], O16: ['D1', 'D7'], O17: ['D7', 'D3'], O18: ['D1', 'D7'], O19: ['D1', 'D7'], O20: ['D3'], O21: ['D2'],
      O22: ['D5'], O23: ['D5'], O24: ['D2'], O25: ['D1', 'D2'], O26: ['D2'],
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

  it("O5's world has no watch-focus, O13's no plugin, and O19's w2 no identity", () => {
    for (const s of ORCA) {
      expect(s.world?.orca, s.id).toEqual({ O5: { watchFocus: false }, O13: { plugin: false }, O19: { noIdentity: ['w2'] } }[s.id])
    }
  })

  it('no two sessions of a scenario share a pane, and no chat has one', () => {
    for (const s of ORCA) {
      const panes = agents(s).filter((d) => !d.chat).map((d) => `${d.worktree} ${d.tab} ${d.split}`)
      expect(new Set(panes).size, s.id).toBe(panes.length)
      for (const d of agents(s).filter((d) => d.chat)) expect([d.handle, d.tab, d.split], `${s.id} ${d.key}`).toEqual([undefined, undefined, undefined])
    }
  })

  it("the chats' scenarios hold resting chats and live ones, of Claude Code and Codex, in worktrees Orca lays out", () => {
    const chats = (id: string) => agents(byId(id)).filter((d) => d.chat).map((d) => [d.key, d.chat, d.engine ?? 'claude', d.worktree])
    expect(chats('O18')).toEqual([['c', 'resting', 'claude', 'w1'], ['d', 'live', 'claude', 'w2'], ['e', 'resting', 'codex', 'w2']])
    expect(chats('O19')).toEqual([['c', 'resting', 'claude', 'w1'], ['d', 'resting', 'claude', 'w2']])
    expect(chats('O20')).toEqual([['c', 'resting', 'claude', 'w2'], ['d', 'resting', 'claude', 'w1']])
    expect([chats('O21'), chats('O22'), chats('O23')]).toEqual([[['b', 'live', 'claude', 'w1']], [['a', 'resting', 'claude', 'w1']],
      [['a', 'live', 'claude', 'w1']]])
    for (const s of ORCA) {
      const laid = new Set(s.steps.flatMap((step) => (step.kind === 'orca.layout' ? step.worktrees : [])))
      for (const d of agents(s).filter((d) => d.chat)) expect(laid.has(d.worktree!), `${s.id} ${d.key}`).toBe(true)
      // Only a live chat's process hooks: a resting one's row is Orca's list's alone.
      for (const step of s.steps) {
        if (step.kind === 'hook') expect(s.sessions.find((d) => d.key === step.session)!.chat, `${s.id} ${step.session}`).not.toBe('resting')
      }
    }
  })

  it("O22's words to a resting chat are refused with Orca's sentence, and O23's to a live Claude Code chat go by the mod", () => {
    expect(byId('O22').checks).toEqual([{ id: 'refused', kind: 'refused', dim: 'D5', session: 'a', text: 'Type in Orca for chats.', after: 'voice' }])
    expect(byId('O23').checks.flatMap((c) => (c.kind === 'voice' ? [[c.session, c.path]] : []))).toEqual([['a', 'mod']])
    expect(byId('O23').title).toContain('until the owner tries it in Orca by hand')
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

  it('O11: c under tmux at its tab is the third row, tapped, then spoken to by its mod', () => {
    const o11 = byId('O11')
    const c = o11.sessions.find((d) => d.key === 'c')!
    expect([c.tmux, c.tab]).toEqual([true, 2])
    // apart none: the grader counts c on tmux's page too (Diego's 2026-11-26 rule).
    expect(o11.checks.flatMap((x) => (x.kind === 'ring' ? [[x.expect, x.apart]] : []))).toEqual([[['a', 'b', 'c'], []]])
    expect(o11.checks.flatMap((x) => (x.kind === 'open' ? [[x.session, x.after, x.at]] : []))).toEqual([['c', 'tap', 'face']])
    expect(o11.checks.flatMap((x) => (x.kind === 'voice' ? [[x.session, x.path, x.text]] : []))).toEqual([['c', 'mod', 'Eval words for charlie.']])
  })

  /** Each agent's [key, tmux, tab, split]. */
  const placed = (s: Scenario) => agents(s).map((d) => [d.key, d.tmux ?? false, d.tab, d.split])

  it('O24: c alone under tmux in tab 1, focused, then a, then c again within one read', () => {
    const o24 = byId('O24')
    expect(placed(o24)).toEqual([['a', false, 0, 0], ['c', true, 1, 0]])
    expect(o24.steps.flatMap((step) => (step.kind === 'orca.focus' ? [[step.label, step.session]] : []))).toEqual([
      [undefined, 'a'], ['focus', 'c'], ['away', 'a'], ['again', 'c'],
    ])
    // Below the tmux pane poll's period (FOCUS_POLL_MS, 500 ms): its last answer may still be c's pane.
    const again = o24.steps.findIndex((step) => step.label === 'again')
    expect(o24.steps[again - 1]).toEqual({ kind: 'wait', ms: 200 })
    expect(o24.checks).toEqual([
      { id: 'focus', kind: 'focus', dim: 'D2', session: 'c', after: 'focus', at: 'away' },
      { id: 'again', kind: 'focus', dim: 'D2', session: 'c', after: 'again' },
    ])
  })

  it("O25: c and d under one tmux in tab 1, c first: the ring [a, c, d] on tmux's page too, then a pane switch to d", () => {
    const o25 = byId('O25')
    expect(placed(o25)).toEqual([['a', false, 0, 0], ['c', true, 1, 0], ['d', true, 1, 1]])
    // c's start comes first, so tmux selects its pane until the switch.
    expect(o25.steps.flatMap((step) => (step.kind === 'hook' && step.event === 'start' ? [step.session] : []))).toEqual(['c', 'd', 'a'])
    expect(o25.steps.flatMap((step) => (step.kind === 'tmux.selectPane' ? [[step.label, step.session]] : []))).toEqual([['pane', 'd']])
    expect(o25.checks).toEqual([
      { id: 'ring', kind: 'ring', dim: 'D1', page: 'orca', expect: ['a', 'c', 'd'], apart: [] },
      { id: 'focus', kind: 'focus', dim: 'D2', session: 'd', after: 'pane' },
    ])
  })

  it("O26: c and d each under its own tmux in tabs 1 and 2, one engine and folder: a focus on d's tab is graded still", () => {
    const o26 = byId('O26')
    expect(placed(o26)).toEqual([['a', false, 0, 0], ['c', true, 1, 0], ['d', true, 2, 0]])
    const [c, d] = [o26.sessions.find((x) => x.key === 'c')!, o26.sessions.find((x) => x.key === 'd')!]
    expect([c.engine, c.cwd, c.worktree]).toEqual([d.engine, d.cwd, d.worktree])
    expect(o26.checks).toEqual([{ id: 'still', kind: 'still', dim: 'D2', ms: 3_000, after: 'other' }])
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

  it("a ring an O scenario waits for or expects lists its agents in Orca's tab order, then its chats in Orca's list order", () => {
    // Each worktree in the order it was first laid out, then its tabs, then each tab's splits; the chats after them all,
    // in the order Orca lists them, which is the order they are declared in.
    for (const s of ORCA) {
      const worktrees = [...new Set(s.steps.flatMap((step) => (step.kind === 'orca.layout' ? step.worktrees : [])))]
      const chats = agents(s).filter((d) => d.chat)
      const place = new Map(agents(s).map((d) => [d.key, d.chat ? [worktrees.length, chats.indexOf(d), 0]
        : [worktrees.indexOf(d.worktree!), d.tab!, d.split!]]))
      const before = (x: SessionKey, y: SessionKey): number => {
        const [p, q] = [place.get(x)!, place.get(y)!]
        return p[0]! - q[0]! || p[1]! - q[1]! || p[2]! - q[2]!
      }
      const rings = [...s.steps.flatMap((step) => (step.kind === 'wait' && step.until?.kind === 'ring' ? [step.until.expect] : [])),
        ...[...s.checks, ...s.probes].flatMap((c) => (c.kind === 'ring' ? [c.expect.filter((key) => key !== 'z')] : []))]
      for (const ring of rings) expect(ring, s.id).toEqual([...ring].sort(before))
    }
  })
})
