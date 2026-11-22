import { describe, expect, it } from 'vitest'
import { HELD_OUT, MAIN } from './catalog.js'
import { engineOf, type Dimension, type Scenario, type SessionKey } from './types.js'

const CURSOR = MAIN.filter((s) => s.app === 'cursor')
const byId = (id: string): Scenario => CURSOR.find((s) => s.id === id)!

describe("Cursor's scenarios", () => {
  it("Cursor's main ids are U1-U14, 14", () => {
    expect(CURSOR.map((s) => s.id)).toEqual(Array.from({ length: 14 }, (_, i) => `U${i + 1}`))
    expect(CURSOR.every((s) => !s.heldOut)).toBe(true)
    expect(HELD_OUT.filter((s) => s.id.startsWith('U') && !s.id.startsWith('UH'))).toEqual([])
  })

  it('every U scenario runs on every platform in both tiers', () => {
    for (const s of CURSOR) {
      expect(s.platforms, s.id).toEqual(['darwin', 'win32', 'linux'])
      expect(s.tiers, s.id).toEqual(['a', 'b'])
    }
  })

  it("each U scenario's checks cover exactly the spec's dims", () => {
    const dims: Record<string, Dimension[]> = {
      U1: ['D1'], U2: ['D1'], U3: ['D2'], U4: ['D2'], U5: ['D3'], U6: ['D3'], U7: ['D3'], U8: ['D4', 'D6'], U9: ['D5'],
      U10: ['D5'], U11: ['D5'], U12: ['D7', 'D3'], U13: ['D7', 'D1'], U14: ['D1'],
    }
    for (const s of CURSOR) {
      const want = [...dims[s.id]!, 'D8']
      expect([...s.dims].sort(), s.id).toEqual([...want].sort())
      expect([...new Set(s.checks.map((c) => c.dim))].sort(), s.id).toEqual([...want].sort())
    }
  })

  it("U2's VS Code session is counted apart from Cursor's page", () => {
    const u2 = byId('U2')
    expect(u2.sessions.filter((d) => !d.ghost).map((d) => [d.key, d.app, d.window])).toEqual([['a', 'vscode', 'w1'], ['b', 'cursor', 'w2']])
    expect(u2.checks.find((c) => c.id === 'ring')).toMatchObject({ page: 'cursor', expect: ['b'], apart: ['a'] })
    expect(u2.probes).toContainEqual(expect.objectContaining({ id: 'ring', kind: 'ring', page: 'cursor', expect: ['b', 'z'] }))
    expect(u2.probes).toContainEqual(expect.objectContaining({ id: 'apart', kind: 'ring', page: 'cursor', expect: ['b'], apart: ['a', 'z'] }))
  })

  it("U14's two sessions share a folder", () => {
    const u14 = byId('U14')
    const [a, c] = ['a', 'c'].map((key) => u14.sessions.find((d) => d.key === key)!)
    expect([a!.cwd, c!.cwd, c!.folders]).toEqual(['/work/eval-shared', '/work/eval-shared', ['/work/eval-shared']])
    expect([a!.place, c!.place]).toEqual(['terminal', 'agent'])
    expect(u14.checks.find((c) => c.id === 'ring')).toMatchObject({ page: 'cursor', expect: ['a', 'c'] })
  })

  it("U1 has a Claude Code and cursor-agent in terminals, Cursor's own agent on its folder and a Claude Code panel session, none on another page", () => {
    const u1 = byId('U1')
    expect(u1.sessions.filter((d) => !d.ghost).map((d) => [d.key, d.place, engineOf(d), d.folders])).toEqual([
      ['a', 'terminal', 'claude', undefined], ['b', 'terminal', 'cursor', undefined], ['c', 'agent', 'cursor', ['/work/eval-c']],
      ['d', 'panel', 'claude', undefined]])
    expect(u1.checks.find((c) => c.id === 'ring')).toMatchObject({ page: 'cursor', expect: ['a', 'b', 'c', 'd'], apart: [] })
  })

  it('a ring a U scenario waits for or expects lists its sessions in the order they started, as the ring keeps them', () => {
    // The dial's ring keeps each agent where it entered and puts a new one at the end (cable/hosts/select.ts DialRing).
    for (const s of CURSOR) {
      const order: SessionKey[] = s.steps.flatMap((step) => (step.kind === 'hook' && step.event === 'start' ? [step.session] : []))
      const rings = [...s.steps.flatMap((step) => (step.kind === 'wait' && step.until ? [step.until.expect] : [])),
        ...s.checks.flatMap((c) => (c.kind === 'ring' ? [c.expect] : [])), ...s.probes.flatMap((c) => (c.kind === 'ring' ? [c.expect] : []))]
      for (const ring of rings) expect(ring.filter((key) => key !== 'z'), s.id).toEqual(order.filter((key) => ring.includes(key)))
    }
  })

  it("U12 closes the window before the tap, so the tap has no stream and falls to Cursor's folder", () => {
    const u12 = byId('U12')
    const close = u12.steps.findIndex((step) => step.label === 'close')
    const tap = u12.steps.findIndex((step) => step.label === 'tap')
    expect(u12.steps[close]).toEqual({ label: 'close', kind: 'editor.close', window: 'w1' })
    expect(close).toBeLessThan(tap)
    expect(u12.checks.filter((c) => c.kind === 'open').map((c) => [c.id, c.dim])).toEqual([['open', 'D3'], ['openKept', 'D7']])
  })

  it('a tap on a terminal or agent row asks for no link, a tap on the panel for its link', () => {
    for (const s of CURSOR) {
      for (const c of [...s.checks, ...s.probes]) {
        if (c.kind !== 'open') continue
        expect(c.link, `${s.id} ${c.id}`).toBe(s.id === 'U7')
        const place = s.sessions.find((d) => d.key === c.session)!.place
        if (c.session !== 'z') expect(place, `${s.id} ${c.id}`).toBe({ U6: 'agent', U7: 'panel' }[s.id] ?? 'terminal')
      }
    }
  })
})
