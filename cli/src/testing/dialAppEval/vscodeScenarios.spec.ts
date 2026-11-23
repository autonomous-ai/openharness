import { describe, expect, it } from 'vitest'
import { HELD_OUT, listed, MAIN } from './catalog.js'
import type { Dimension, Scenario, SessionKey } from './types.js'

const VSCODE = MAIN.filter((s) => s.app === 'vscode')
const byId = (id: string): Scenario => VSCODE.find((s) => s.id === id)!

describe("VS Code's scenarios", () => {
  it("VS Code's main ids are V1-V15, none held out, 15", () => {
    expect(VSCODE.map((s) => s.id)).toEqual(Array.from({ length: 15 }, (_, i) => `V${i + 1}`))
    expect(VSCODE.every((s) => !s.heldOut)).toBe(true)
    expect(HELD_OUT.filter((s) => s.id.startsWith('V') && !s.id.startsWith('VH'))).toEqual([])
  })

  it('V11 is macOS only, V2 tier A only, V12 tier B only, every other on every platform in both tiers', () => {
    for (const s of VSCODE) {
      expect(s.platforms, s.id).toEqual(s.id === 'V11' ? ['darwin'] : ['darwin', 'win32', 'linux'])
      expect(s.tiers, s.id).toEqual(s.id === 'V2' ? ['a'] : s.id === 'V12' ? ['b'] : ['a', 'b'])
    }
  })

  it("each V scenario's checks cover exactly the spec's dims", () => {
    const dims: Record<string, Dimension[]> = {
      V1: ['D1'], V2: ['D1', 'D7'], V3: ['D2'], V4: ['D2'], V5: ['D3', 'D7'], V6: ['D3'], V7: ['D4', 'D6'], V8: ['D5'],
      V9: ['D5'], V10: ['D7', 'D3'], V11: ['D1', 'D3', 'D7'], V12: ['D7', 'D1', 'D3'], V13: ['D7', 'D3'], V14: ['D7', 'D1'],
      V15: ['D7', 'D3'],
    }
    for (const s of VSCODE) {
      const want = s.tiers.includes('b') ? [...dims[s.id]!, 'D8'] : dims[s.id]!
      expect([...s.dims].sort(), s.id).toEqual([...want].sort())
      expect([...new Set(s.checks.map((c) => c.dim))].sort(), s.id).toEqual([...want].sort())
    }
  })

  it("V9's Codex has its own home and V13's world no extension", () => {
    expect(byId('V9').sessions.find((d) => d.key === 'b')).toMatchObject({ engine: 'codex', codexHome: 'own' })
    expect(byId('V13').world).toEqual({ extension: false })
    for (const s of VSCODE) if (s.id !== 'V13') expect(s.world?.extension, s.id).toBeUndefined()
  })

  it('a ring a V scenario waits for or expects lists its sessions in the order they started, as the ring keeps them', () => {
    // The dial's ring keeps each agent where it entered and puts a new one at the end (cable/hosts/select.ts DialRing).
    // V2's ring is full, so the agents that replace others go to the end in their turn: its own case holds it.
    for (const s of VSCODE.filter((s) => s.id !== 'V2')) {
      const order: SessionKey[] = s.steps.flatMap((step) => (step.kind === 'hook' && step.event === 'start' ? [step.session] : []))
      const rings = [...s.steps.flatMap((step) => (step.kind === 'wait' && step.until ? [step.until.expect] : [])),
        ...s.checks.flatMap((c) => (c.kind === 'ring' ? [c.expect] : [])), ...s.probes.flatMap((c) => (c.kind === 'ring' ? [c.expect] : []))]
      for (const ring of rings) expect(ring.filter((key) => key !== 'z'), s.id).toEqual(order.filter((key) => ring.includes(key)))
    }
  })

  it("V2 starts s20 first and s01 last: the ring keeps the newest 16 in their turn, and s17 comes back at the end when s05's terminal closes", () => {
    const v2 = byId('V2')
    const s = (n: number) => `s${String(n).padStart(2, '0')}`
    const down = (from: number, to: number) => Array.from({ length: from - to + 1 }, (_, i) => s(from - i))
    expect(v2.steps.filter((step) => step.kind === 'hook').map((step) => 'session' in step && step.session)).toEqual(down(20, 1))
    const afterClose = [...down(16, 6), ...down(4, 1), 's17']
    // The leave comes seconds after s05's end hook (services/devices.ts dropEnded): the run waits for it, or it ends before
    // s17 is in.
    const close = v2.steps.findIndex((step) => step.label === 'close')
    expect(v2.steps.slice(close)).toEqual([{ label: 'close', kind: 'editor.closeTerminal', session: 's05' },
      ...listed('vscode', afterClose)])
    expect(v2.steps.find((step) => step.kind === 'wait' && step.until)).toMatchObject({ until: { page: 'vscode', expect: down(16, 1) } })
    expect(v2.checks.map((c) => [c.id, c.kind === 'ring' && c.expect])).toEqual([['ring', afterClose], ['ringKept', afterClose]])
  })

  it('V1 has a Claude Code panel session and a Codex in a terminal beside two Claude Codes, none on another page', () => {
    const v1 = byId('V1')
    expect(v1.sessions.filter((d) => !d.ghost).map((d) => [d.key, d.place, d.engine ?? 'claude'])).toEqual([
      ['a', 'terminal', 'claude'], ['b', 'terminal', 'codex'], ['c', 'terminal', 'claude'], ['d', 'panel', 'claude']])
    expect(v1.checks.find((c) => c.id === 'ring')).toMatchObject({ page: 'vscode', expect: ['a', 'b', 'c', 'd'], apart: [] })
  })

  it('V11 starts VS Code from Terminal.app, and its scroll is read between its first stroke and the window\'s close', () => {
    const v11 = byId('V11')
    expect(v11.world).toEqual({ launchedFrom: 'terminal-app' })
    expect(v11.checks.find((c) => c.kind === 'scroll')).toMatchObject({ session: 'a', after: 'stroke', at: 'close' })
    expect(v11.checks.find((c) => c.kind === 'logged')).toMatchObject({ dim: 'D7', after: 'skip' })
    expect(v11.steps.filter((step) => step.kind === 'stroke').map((step) => step.label)).toEqual(['stroke', 'skip'])
  })

  it("V12 runs its Claude Code in the person's tmux, so its row is on tmux's page, VS Code's counting none (decision 3)", () => {
    const v12 = byId('V12')
    expect(v12.sessions.find((d) => d.key === 'a')).toMatchObject({ tmux: true })
    expect(v12.steps.filter((step) => step.kind === 'wait' && step.until).map((step) => step.kind === 'wait' && step.until))
      .toEqual([{ kind: 'ring', page: 'tmux', expect: ['a'] }])
    expect(v12.checks.filter((c) => c.kind === 'ring').map((c) => c.kind === 'ring' && [c.id, c.page, c.apart]))
      .toEqual([['ring', 'tmux', []], ['ringKept', 'tmux', []]])
  })

  it('a tap on a terminal row asks for no link, a tap on the panel for its link', () => {
    for (const s of VSCODE) {
      for (const c of [...s.checks, ...s.probes]) {
        if (c.kind !== 'open') continue
        const place = s.sessions.find((d) => d.key === c.session)!.place
        expect(c.link, `${s.id} ${c.id}`).toBe(s.id === 'V6')
        if (c.session !== 'z') expect(place, `${s.id} ${c.id}`).toBe(s.id === 'V6' ? 'panel' : 'terminal')
      }
    }
  })
})
