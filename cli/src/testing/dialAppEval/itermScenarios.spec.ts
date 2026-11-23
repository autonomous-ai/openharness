import { describe, expect, it } from 'vitest'
import { HELD_OUT, MAIN } from './catalog.js'
import { evaluate } from './checks.js'
import { tabLabel } from './itermRecords.js'
import { agentIdOf, itermPlaceOf, type Dimension, type Scenario, type Seen, type SessionDef } from './types.js'

const ITERM = MAIN.filter((s) => s.app === 'iterm')
const byId = (id: string): Scenario => ITERM.find((s) => s.id === id)!
const agents = (s: Scenario): SessionDef[] => s.sessions.filter((d) => d.app === 'iterm' && !d.ghost)

/** Each step at the scenario's own time, a condition wait taken as held at once. */
function timeline(s: Scenario): Seen['steps'] {
  let now = 0
  return s.steps.flatMap((step, index) => {
    if (step.kind === 'wait') {
      if (step.until === undefined) now += step.ms
      return []
    }
    return [{ at: now, index, kind: step.kind, ...(step.label === undefined ? {} : { label: step.label }) }]
  })
}

describe("iTerm2's scenarios", () => {
  it("iTerm2's main ids are I1-I21, none held out, 21", () => {
    expect(ITERM.map((s) => s.id)).toEqual(Array.from({ length: 21 }, (_, i) => `I${i + 1}`))
    expect(ITERM.every((s) => !s.heldOut)).toBe(true)
    expect(HELD_OUT.filter((s) => s.id.startsWith('I') && !s.id.startsWith('IH'))).toEqual([])
  })

  it('every I scenario runs on darwin alone, in both tiers', () => {
    for (const s of ITERM) expect([s.platforms, s.tiers], s.id).toEqual([['darwin'], ['a', 'b']])
  })

  it("each I scenario's checks cover exactly the spec's dims, and D8 in tier B", () => {
    const dims: Record<string, Dimension[]> = {
      I1: ['D1'], I2: ['D1'], I3: ['D1', 'D7'], I4: ['D1', 'D3'], I5: ['D3'], I6: ['D3'], I7: ['D3'], I8: ['D2'], I9: ['D2', 'D7'],
      I10: ['D2'], I11: ['D2'], I12: ['D1', 'D7'], I13: ['D7', 'D3'], I14: ['D7', 'D1'], I15: ['D7', 'D1'], I16: ['D4', 'D6'],
      I17: ['D4'], I18: ['D5'], I19: ['D5'], I20: ['D5'], I21: ['D7'],
    }
    for (const s of ITERM) {
      const want = [...dims[s.id]!, 'D8'].sort()
      expect([...s.dims].sort(), s.id).toEqual(want)
      expect([...new Set(s.checks.map((c) => c.dim))].sort(), s.id).toEqual(want)
    }
  })

  it('every I scenario declares the ghost, an iTerm2 session', () => {
    for (const s of ITERM) expect(s.sessions.filter((d) => d.ghost).map((d) => [d.key, d.app]), s.id).toEqual([['z', 'iterm']])
  })

  it('no two sessions of a scenario share a tab, a split or a multiplexer pane', () => {
    for (const s of ITERM) {
      // A tab or split holds one plain agent, or the client of one multiplexer, whose panes are its sessions' splits.
      const holder = new Map<string, string>()
      const panes = new Set<string>()
      for (const d of agents(s)) {
        const place = itermPlaceOf(d)!
        const slot = tabLabel({ window: d.window!, tab: d.tab!, split: place === 'tab' ? d.split : 0 })
        const by = place === 'tab' ? `tab ${d.key}` : place
        expect(holder.get(slot) ?? by, `${s.id} ${d.key} in ${slot}`).toBe(by)
        holder.set(slot, by)
        if (place === 'tab') continue
        const pane = `${place} ${d.window}.${d.tab}.${d.split}`
        expect(panes.has(pane), `${s.id} ${d.key} in ${pane}`).toBe(false)
        panes.add(pane)
      }
    }
  })

  it("I13's open names the new client's tab", () => {
    const i13 = byId('I13')
    const attach = i13.steps.find((step) => step.kind === 'tmux.attach')!
    expect(attach).toMatchObject({ session: 'b', label: 'attach' })
    const tab = attach.kind === 'tmux.attach' ? tabLabel({ window: attach.window, tab: attach.tab }) : undefined
    expect(tab).toBe('w1.2.0')
    expect(i13.checks.find((c) => c.kind === 'open')).toMatchObject({ session: 'b', tab, after: 'tap' })
  })

  it("I3's and I15's sessions have a turn before their restart, so the scan finds each conversation on disk", () => {
    const restarted = [...ITERM, ...HELD_OUT.filter((s) => s.app === 'iterm')]
      .filter((s) => s.steps.some((step) => step.kind === 'devices.restart'))
    expect(restarted.filter((s) => !s.heldOut).map((s) => s.id)).toEqual(['I3', 'I15'])
    for (const s of restarted) {
      const restart = s.steps.findIndex((step) => step.kind === 'devices.restart')
      for (const d of agents(s)) {
        const turned = s.steps.slice(0, restart).some((step) => step.kind === 'hook' && step.event === 'turn-stop' && step.session === d.key)
        expect(turned, `${s.id} ${d.key}`).toBe(true)
      }
    }
  })

  it("I8 starts a first, so the face is on a and its select must move the dial: a face left on a fails, one on b passes", () => {
    const i8 = byId('I8')
    expect(i8.steps.find((step) => step.kind === 'hook')).toMatchObject({ session: 'a', event: 'start' })
    const [a, b] = agents(i8).map(agentIdOf)
    const steps = timeline(i8)
    const select = steps.find((s) => s.label === 'select')!.at
    const face = (at: number, active: string) => ({ at, page: 'iterm', tiles: [b!, a!], active, refused: 0 })
    const focus = (faces: Seen['faces']) => evaluate(i8.checks.find((c) => c.kind === 'focus')!, i8,
      { frames: [], faces, commands: [], deliveries: [], steps }, 'a', 'darwin').map((r) => [r.check, r.score])
    expect(focus([face(0, a!), face(select + 500, b!)])).toEqual([['focus.lands', 1], ['focus.latency', 1]])
    expect(focus([face(0, a!)])).toEqual([['focus.lands', 0], ['focus.latency', 0]])
  })

  it("I9's echo can fail: the dial left on a after the rest passes, iTerm2's report of b's tab pulling it back fails", () => {
    const i9 = byId('I9')
    const [a, b] = agents(i9).map(agentIdOf)
    const steps = timeline(i9)
    const at = (label: string): number => steps.find((s) => s.label === label)!.at
    const face = (when: number, active: string) => ({ at: when, page: 'iterm', tiles: [a!, b!], active, refused: 0 })
    const faces = [face(0, a!), face(at('toB'), b!), face(at('toA'), a!)]
    const graded = (seen: Seen['faces']) => i9.checks.filter((c) => c.kind === 'focus' || c.kind === 'still')
      .flatMap((c) => evaluate(c, i9, { frames: [], faces: seen, commands: [], deliveries: [], steps }, 'a', 'darwin'))
      .map((r) => [r.check, r.score])
    expect(graded(faces)).toEqual([['echo.lands', 1], ['echo.latency', 1], ['echo.noBounce', 1], ['still', 1]])
    expect(graded([...faces, face(at('echo') + 300, b!)]))
      .toEqual([['echo.lands', 0], ['echo.latency', 1], ['echo.noBounce', 0], ['still', 0]])
  })
})
