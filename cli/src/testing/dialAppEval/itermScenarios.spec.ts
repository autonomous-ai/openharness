import { describe, expect, it } from 'vitest'
import { DIAL_BRINGS_MS } from '../../cable/hosts/appFilter.js'
import { HELD_OUT, MAIN } from './catalog.js'
import { evaluate } from './checks.js'
import { tabLabel } from './itermRecords.js'
import { agentIdOf, itermPlaceOf, sessionPages, type Dimension, type Scenario, type Seen, type SessionDef } from './types.js'

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
  it("iTerm2's main ids are I1-I24, none held out, 24", () => {
    expect(ITERM.map((s) => s.id)).toEqual(Array.from({ length: 24 }, (_, i) => `I${i + 1}`))
    expect(ITERM.every((s) => !s.heldOut)).toBe(true)
    expect(HELD_OUT.filter((s) => s.id.startsWith('I') && !s.id.startsWith('IH'))).toEqual([])
  })

  it('every I scenario runs on darwin alone, in both tiers', () => {
    for (const s of ITERM) expect([s.platforms, s.tiers], s.id).toEqual([['darwin'], ['a', 'b']])
  })

  it("each I scenario's checks cover exactly the spec's dims, and D8 in tier B", () => {
    const dims: Record<string, Dimension[]> = {
      I1: ['D1'], I2: ['D1', 'D2'], I3: ['D1', 'D7'], I4: ['D1', 'D3'], I5: ['D3'], I6: ['D3'], I7: ['D3'], I8: ['D2'], I9: ['D2', 'D7'],
      I10: ['D2'], I11: ['D2'], I12: ['D1', 'D7'], I13: ['D7', 'D3'], I14: ['D7', 'D1'], I15: ['D7', 'D1'], I16: ['D4', 'D6'],
      I17: ['D4'], I18: ['D5'], I19: ['D5'], I20: ['D5'], I21: ['D7'], I22: ['D3', 'D7'], I23: ['D3', 'D7'], I24: ['D3'],
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
    const restarted = ITERM.filter((s) => s.steps.some((step) => step.kind === 'devices.restart'))
    expect(restarted.map((s) => s.id)).toEqual(['I3', 'I15'])
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

  it("I10's pane move leaves the active pane: the person is on a's pane when the tab is selected, then moves to b's", () => {
    // A move to the pane already active moves nothing: following the active pane on the tab report would pass it.
    const steps = byId('I10').steps
    const select = steps.findIndex((step) => step.label === 'select')
    expect(steps.flatMap((step, i) => (step.kind === 'tmux.selectPane' ? [[step.session, i < select ? 'before select' : step.label]] : [])))
      .toEqual([['a', 'before select'], ['b', 'pane']])
  })

  it("I6 and I21 start d before b in b's tmux, so the pick lands on d and the swipe must move the dial to b", () => {
    for (const s of [byId('I6'), byId('I21')]) {
      const tmux = agents(s).filter((d) => sessionPages(d).includes('tmux'))
      // One tmux, whose client runs in b's tab.
      expect(new Set(tmux.map((d) => d.tab)).size, s.id).toBe(1)
      const starts = s.steps.flatMap((step) => (step.kind === 'hook' && step.event === 'start' ? [step.session] : []))
      expect(starts.filter((key) => tmux.some((d) => d.key === key)), s.id).toEqual(['d', 'b'])
      // Nothing between the pick and the swipe moves the face off d.
      const pick = s.steps.findIndex((step) => step.kind === 'pick' && step.page === 'tmux')
      const swipe = s.steps.findIndex((step) => step.kind === 'swipe')
      expect([pick >= 0, s.steps[swipe]], s.id).toMatchObject([true, { kind: 'swipe', session: 'b' }])
      expect(s.steps.slice(pick + 1, swipe).every((step) => step.kind === 'wait'), s.id).toBe(true)
    }
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

  // Diego's 2026-11-26 rule (docs/plans/2026-11-26-dial-mux-host-pages-design.md): an agent in tmux or herdr is on
  // iTerm2's page and the multiplexer's.
  it("I2, I3 and I15 list every agent on iTerm2's page, count each nested one on its multiplexer's too, and grade "
    + "tmux's and herdr's rings after a pick of each", () => {
    for (const s of [byId('I2'), byId('I3'), byId('I15')]) {
      const keys = agents(s).map((d) => d.key)
      for (const id of ['ring', 'ringKept']) {
        const ring = s.checks.find((c) => c.id === id)
        if (ring) expect(ring, `${s.id} ${id}`).toMatchObject({ page: 'iterm', expect: keys, apart: [] })
      }
      for (const c of s.checks) {
        if (c.kind !== 'ring' || c.page === 'iterm') continue
        expect(s.steps.find((step) => step.label === c.after), `${s.id} ${c.id}`).toMatchObject({ kind: 'pick', page: c.page })
      }
    }
    const counts = (id: string) => byId(id).steps.flatMap((step) => (step.kind === 'wait' && step.until?.kind === 'apps' ? [step.until.counts] : []))
    expect([counts('I3'), counts('I15')]).toEqual([[{ iterm: 4, tmux: 1, herdr: 2 }], [{ iterm: 3, tmux: 1, herdr: 1 }]])
  })

  it("I2's select of b's tab keeps iTerm2's page and moves the dial to b; I19's select moves it from a to b before the voice", () => {
    const i2 = byId('I2')
    expect(i2.steps.find((step) => step.label === 'select')).toMatchObject({ kind: 'iterm.select', window: 'w1', tab: 1 })
    expect(i2.checks.find((c) => c.kind === 'focus')).toEqual({ id: 'focus', kind: 'focus', dim: 'D2', session: 'b', after: 'select', at: 'toTmux' })
    // The ring the dial holds once the select has run is still iTerm2's.
    expect(i2.checks.find((c) => c.id === 'ring')).toMatchObject({ page: 'iterm', at: 'toTmux' })
    const i19 = byId('I19')
    expect(i19.steps.flatMap((step) => (step.kind === 'hook' && step.event === 'start' ? [step.session] : []))).toEqual(['a', 'b'])
    expect(i19.steps.filter((step) => step.kind === 'iterm.select')).toEqual([{ kind: 'iterm.select', window: 'w1', tab: 1 }])
  })

  // Diego's 2026-11-26 rule (docs/plans/2026-11-26-dial-mux-host-pages-design.md): a pick or a rest on tmux's or herdr's
  // page brings the app holding the agent's client, and the first app in front within 2 s of that bring keeps the page.
  it("I22, I23 and I24 start with another app in front, so the dial's bring is what an open grades", () => {
    for (const id of ['I22', 'I23', 'I24']) expect(byId(id).world, id).toEqual({ front: 'other' })
  })

  it("I22 and I23 bring iTerm2 to the front themselves within 2 s of the dial's bring, as tier A's world moves no front "
    + 'app, and grade the page held after it', () => {
    for (const [id, bring, page] of [['I22', 'pick', 'tmux'], ['I23', 'rest', 'herdr']] as const) {
      const s = byId(id)
      const from = s.steps.findIndex((step) => step.label === bring)
      const front = s.steps.findIndex((step) => step.label === 'front')
      expect(s.steps[front], id).toEqual({ label: 'front', kind: 'front', app: 'iterm' })
      expect(s.steps.filter((step) => step.kind === 'front'), id).toHaveLength(1)
      const between = s.steps.slice(from + 1, front)
      expect(between.every((step) => step.kind === 'wait' && step.until === undefined), id).toBe(true)
      expect(between.reduce((ms, step) => ms + (step.kind === 'wait' ? step.ms : 0), 0), id).toBeLessThan(DIAL_BRINGS_MS)
      expect(s.checks.find((c) => c.kind === 'ring'), id).toMatchObject({ dim: 'D7', page, after: 'front' })
    }
  })

  it("I22 picks tmux's page: b's tab and pane come forward, and tmux's page holds once iTerm2 is in front", () => {
    const i22 = byId('I22')
    expect(agents(i22).map((d) => [d.key, itermPlaceOf(d), d.tab])).toEqual([['a', 'tab', 0], ['b', 'tmux', 1]])
    expect(i22.steps.find((step) => step.label === 'pick')).toEqual({ label: 'pick', kind: 'pick', page: 'tmux' })
    expect(i22.checks.filter((c) => c.kind !== 'cost')).toEqual([
      { id: 'open', kind: 'open', dim: 'D3', session: 'b', link: false, after: 'pick' },
      { id: 'ringKeptTmux', kind: 'ring', dim: 'D7', page: 'tmux', expect: ['b'], apart: ['a'], after: 'front' },
    ])
  })

  it("I23 rests on d on herdr's page: d's tab and pane come forward, herdr's page holds, and a rest on c shows c's pane", () => {
    const i23 = byId('I23')
    expect(agents(i23).map((d) => [d.key, itermPlaceOf(d), d.tab, d.split]))
      .toEqual([['a', 'tab', 0, 0], ['c', 'herdr', 2, 0], ['d', 'herdr', 2, 1]])
    expect(i23.steps.filter((step) => step.kind === 'pick' || step.kind === 'swipe'))
      .toEqual([{ kind: 'pick', page: 'herdr' }, { label: 'rest', kind: 'swipe', session: 'd' }, { label: 'restC', kind: 'swipe', session: 'c' }])
    expect(i23.checks.filter((c) => c.kind !== 'cost')).toEqual([
      { id: 'open', kind: 'open', dim: 'D3', session: 'd', link: false, after: 'rest', at: 'restC' },
      { id: 'ringKeptHerdr', kind: 'ring', dim: 'D7', page: 'herdr', expect: ['c', 'd'], apart: ['a'], after: 'front', at: 'restC' },
      { id: 'openC', kind: 'open', dim: 'D3', session: 'c', link: false, after: 'restC' },
    ])
  })

  it("I24's tmux is attached from a second tab, used last: a pick of tmux's page brings that tab", () => {
    const i24 = byId('I24')
    expect(agents(i24).map((d) => [d.key, itermPlaceOf(d), d.tab])).toEqual([['a', 'tab', 0], ['b', 'tmux', 1]])
    const attach = i24.steps.findIndex((step) => step.kind === 'tmux.attach')
    expect(i24.steps.slice(attach - 1, attach + 1)).toEqual([{ kind: 'iterm.tab', window: 'w1', tab: 2 },
      { kind: 'tmux.attach', session: 'b', window: 'w1', tab: 2 }])
    expect(i24.steps.filter((step) => step.kind === 'tap' || step.kind === 'swipe')).toEqual([])
    expect(i24.checks.filter((c) => c.kind !== 'cost'))
      .toEqual([{ id: 'open', kind: 'open', dim: 'D3', session: 'b', link: false, tab: 'w1.2.0', after: 'pick' }])
  })

  it("I10, I11, I17 and I20 wait for their agents on iTerm2's page, which holds them though iTerm2 runs no agent of its own", () => {
    for (const id of ['I10', 'I11', 'I17', 'I20']) {
      const pages = byId(id).steps.flatMap((step) => (step.kind === 'wait' && step.until?.kind === 'ring' ? [step.until.page] : []))
      expect(pages, id).toEqual(['iterm'])
    }
  })
})
