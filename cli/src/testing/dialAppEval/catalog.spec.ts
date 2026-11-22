import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { HELD_OUT, MAIN, titleOf } from './catalog.js'
import { runScenario } from './runner.js'
import { hookHandle, orcaTerminalHandle, STEP_KINDS, THRESHOLDS, type Check, type CheckKind, type EvalDriver, type Scenario, type SessionKey, type Step,
  type StepKind } from './types.js'

const ALL = [...MAIN, ...HELD_OUT]
const byId = (id: string): Scenario => ALL.find((s) => s.id === id)!

/** The session keys a step names. */
function stepKeys(step: Step): SessionKey[] {
  switch (step.kind) {
    case 'claude.write': return step.sessions
    case 'codex.write': return [...step.sessions, ...step.archived ?? [], ...Object.keys(step.names ?? {}), ...Object.keys(step.ages ?? {})]
    case 'hook': case 'attach': case 'tap': case 'swipe': case 'editor.focus': case 'editor.closeTerminal':
    case 'orca.focus': case 'orca.close': return [step.session]
    case 'editor.window': return [...step.terminals ?? [], ...step.active === null ? [] : [step.active]]
    case 'orca.layout': return Object.keys(step.renamed ?? {})
    case 'voice': return [step.target]
    default: return []
  }
}
/** The session keys a check names. */
function checkKeys(check: Check): SessionKey[] {
  switch (check.kind) {
    case 'ring': return [...check.expect, ...check.apart ?? []]
    case 'focus': case 'open': case 'state': case 'voice': case 'recap': case 'scroll': return [check.session]
    default: return []
  }
}

describe('the catalog', () => {
  it('the main ids are C1-C12, X1-X11, V1-V15, U1-U14 and O1-O17', () => {
    const range = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}${i + 1}`)
    expect(MAIN.map((s) => s.id)).toEqual([...range('C', 12), ...range('X', 11), ...range('V', 15), ...range('U', 14),
      ...range('O', 17)])
    expect(MAIN.every((s) => !s.heldOut)).toBe(true)
  })

  it('the held out are CH1-CH3, XH1-XH3, VH1-VH4, UH1-UH3 and OH1-OH4: 17 of 86, VS Code 4 of 19, Cursor 3 of 17, Orca 4 of 21', () => {
    expect(HELD_OUT.map((s) => s.id)).toEqual(['CH1', 'CH2', 'CH3', 'XH1', 'XH2', 'XH3', 'VH1', 'VH2', 'VH3', 'VH4', 'UH1', 'UH2', 'UH3',
      'OH1', 'OH2', 'OH3', 'OH4'])
    expect(HELD_OUT.every((s) => s.heldOut)).toBe(true)
    expect(ALL).toHaveLength(86)
    const of = (app: string) => [HELD_OUT.filter((s) => s.app === app).length, ALL.filter((s) => s.app === app).length]
    expect([of('vscode'), of('cursor'), of('orca')]).toEqual([[4, 19], [3, 17], [4, 21]])
  })

  it('VH1 and UH3 are D5 alone, UH1 macOS only', () => {
    for (const id of ['VH1', 'UH3']) expect(byId(id).dims.filter((d) => d !== 'D8'), id).toEqual(['D5'])
    expect(byId('UH1').platforms).toEqual(['darwin'])
  })

  it('OH1 and OH2 are D5 alone, on Codex agents: OH1\'s focused a beside a Claude Code, OH2\'s two', () => {
    // The plan's Decision 17: Codex's words are typed into its pane, so a send to the wrong pane is what they can catch.
    for (const id of ['OH1', 'OH2']) expect(byId(id).dims.filter((d) => d !== 'D8'), id).toEqual(['D5'])
    const engines = (id: string) => byId(id).sessions.filter((d) => !d.ghost).map((d) => [d.key, d.engine ?? 'claude'])
    expect([engines('OH1'), engines('OH2')]).toEqual([[['a', 'codex'], ['b', 'claude']], [['a', 'codex'], ['b', 'codex']]])
  })

  it('OH2 runs on macOS only: on Linux and Windows nothing is driven and its run lists the gap, named for its cause', async () => {
    // PM, 2026-11-22: there frontAppId tells no Orca front, so the dial never follows and the words would reach a.
    const calls: string[] = []
    const note = (name: string) => async () => { calls.push(name) }
    const driver: EvalDriver = { tier: 'a', start: note('start'), step: note('step'), settle: note('settle'), stop: note('stop'),
      seen: () => ({ frames: [], faces: [], commands: [], deliveries: [], steps: [] }), gaps: () => [] }
    const reason = 'not run until "Orca in front on Linux and Windows (frontAppId)" merges: the dial never follows Orca\'s focus there'
    for (const platform of ['linux', 'win32'] as const) {
      expect(await runScenario(driver, byId('OH2'), platform)).toEqual({ scenario: 'OH2', platform, results: [], probes: [], wrongSends: [],
        gaps: [{ tier: 'a', platform, scenario: 'OH2', app: 'orca', heldOut: true, reason }] })
    }
    expect(calls).toEqual([])
    expect(byId('OH2').platforms).toEqual(['darwin', 'win32', 'linux'])
    expect(byId('OH2').gaps).toEqual({ linux: reason, win32: reason })
  })

  it('OH4\'s b names no handle in its hooks, a beside it in the same worktree does', () => {
    const agents = byId('OH4').sessions.filter((d) => !d.ghost)
    expect(agents.map((d) => [d.key, d.worktree, hookHandle(d, 0)])).toEqual([['a', 'w1', orcaTerminalHandle('a')], ['b', 'w1', undefined]])
  })

  it('VH2\'s two windows both list a, the focused w2 last; UH2\'s agent has two folders, neither its cwd: a tap that opens the cwd fails', () => {
    expect(byId('VH2').steps.filter((s) => s.kind === 'editor.window')).toEqual([
      { kind: 'editor.window', window: 'w1', terminals: ['a'], active: 'a', focused: false },
      { kind: 'editor.window', window: 'w2', terminals: ['a'], active: 'a', focused: true },
    ])
    const c = byId('UH2').sessions.find((d) => d.key === 'c')!
    expect([c.place, c.folders, c.cwd]).toEqual(['agent', ['/work/eval-c1', '/work/eval-c2'], '/work/eval-c'])
  })

  it('VH3\'s split is in a second window, behind the first, so its focus brings that window up and is not V3\'s', () => {
    const vh3 = byId('VH3')
    expect(vh3.sessions.filter((d) => !d.ghost).map((d) => [d.key, d.window])).toEqual([['a', 'w1'], ['c', 'w2'], ['b', 'w2']])
    expect(vh3.steps.filter((s) => s.kind === 'editor.window' || s.kind === 'editor.focus')).toEqual([
      { kind: 'editor.window', window: 'w1', terminals: ['a'], active: 'a', focused: true },
      { kind: 'editor.window', window: 'w2', terminals: ['c', 'b'], active: 'c', focused: false },
      { label: 'focus', kind: 'editor.focus', session: 'b' },
    ])
    expect(vh3.checks.filter((c) => c.kind !== 'cost')).toEqual([{ id: 'focus', kind: 'focus', dim: 'D2', session: 'b', after: 'focus' }])
  })

  it('no VS Code session is an agent of the editor\'s own: VS Code has none, only Cursor does', () => {
    for (const s of ALL) for (const d of s.sessions) if (d.app === 'vscode') expect(d.place, `${s.id} ${d.key}`).not.toBe('agent')
  })

  it('each scenario\'s checks cover exactly its dims', () => {
    for (const s of ALL) {
      expect(new Set(s.dims).size, s.id).toBe(s.dims.length)
      expect([...new Set(s.checks.map((c) => c.dim))].sort(), s.id).toEqual([...s.dims].sort())
    }
    expect(byId('CH3').dims.filter((d) => d !== 'D8')).toEqual(['D5'])
    expect(byId('XH3').dims.filter((d) => d !== 'D8')).toEqual(['D5'])
  })

  it('each scenario\'s check ids are its own, so no two results share a key', () => {
    for (const s of ALL) expect(new Set(s.checks.map((c) => c.id)).size, s.id).toBe(s.checks.length)
  })

  it('X10 counts the Codex CLI session apart from the thread, on another page, and its probe asks for one more there', () => {
    const x10 = byId('X10')
    expect(x10.checks.find((c) => c.id === 'ring')).toMatchObject({ kind: 'ring', expect: ['t1'], apart: ['c1'] })
    expect(x10.probes).toContainEqual(expect.objectContaining({ id: 'apart', kind: 'ring', expect: ['t1'], apart: ['c1', 'z'] }))
  })

  it('X3, V11 and UH1 are macOS only', () => {
    const mac = ['X3', 'V11', 'UH1']
    for (const s of ALL) expect(s.platforms, s.id).toEqual(mac.includes(s.id) ? ['darwin'] : ['darwin', 'win32', 'linux'])
  })

  it('X3 starts with another app in front, so its front step brings the ChatGPT app up, on a world with no Accessibility', () => {
    expect(byId('X3').world).toEqual({ front: 'other', accessibility: false })
    for (const s of ALL) if (s.id !== 'X3') expect(s.world?.accessibility, s.id).toBeUndefined()
  })

  it('X3\'s still window ends at its tap, so the tap is not the dial moving by itself', () => {
    expect(byId('X3').checks.find((c) => c.kind === 'still')).toMatchObject({ after: 'front', at: 'tap' })
  })

  it('X3\'s ring check reads the ring the dial holds when its still window ends, though the whole list came before front', () => {
    const ringKept = byId('X3').checks.find((c) => c.id === 'ringKept')!
    expect(ringKept.after).toBeUndefined()
    expect(ringKept.at).toBe('tap')
  })

  it('C9 swipes from the older a to the new b, which has no hook yet, rests on it, and then b\'s hook arrives', () => {
    const c9 = byId('C9')
    expect(c9.sessions.filter((s) => !s.ghost).map((s) => [s.key, s.ageMs])).toEqual([['b', 60_000], ['a', 120_000]])
    expect(c9.steps.map((s) => [s.kind, 'session' in s ? s.session : s.kind === 'wait' ? s.ms : ''])).toEqual([
      ['front', ''], ['claude.write', ''], ['wait', 10_000], ['wait', 1_000], ['swipe', 'a'], ['wait', 1_000], ['swipe', 'b'], ['wait', 3_500], ['hook', 'b']])
    expect(c9.steps.filter((s) => s.kind === 'hook')).toEqual([{ label: 'hook', kind: 'hook', session: 'b', event: 'start' }])
    expect(c9.checks.filter((c) => c.kind !== 'cost')).toEqual([
      { id: 'open', kind: 'open', dim: 'D3', session: 'b', link: true, after: 'swipe', at: 'hook' },
      { id: 'ring', kind: 'ring', dim: 'D1', page: 'claude', expect: ['b', 'a'], after: 'hook' },
      { id: 'ringKept', kind: 'ring', dim: 'D7', page: 'claude', expect: ['b', 'a'] },
    ])
  })

  it('a ring read after a write comes after a listing, so it reads the change and not the first read of the store', () => {
    for (const s of ALL) {
      for (const c of s.checks.filter((c) => c.kind === 'ring' && c.after !== undefined)) {
        const step = s.steps.findIndex((step) => step.label === c.after)
        if (!['claude.write', 'codex.write'].includes(s.steps[step]!.kind)) continue
        expect(s.steps.slice(0, step).some((step) => step.kind === 'wait' && step.until !== undefined), `${s.id} ${c.id}`).toBe(true)
      }
    }
  })

  it("an editor's quit and its relaunch are farther apart than the end delay and one tick, so the relaunch grades its rows' return", () => {
    // An ended entry stays listed until the 30 s tick after its 10 s end delay (cable/hosts/observed.ts, services/devices.ts):
    // a relaunch sooner finds its rows still there, and a ring check after it passes whatever the relaunch does.
    const leave = 10 * 1_000 + 30 * 1_000
    const quits = ALL.filter((s) => s.steps.some((step) => step.kind === 'quit' && (step.app === 'vscode' || step.app === 'cursor')))
    expect(quits.map((s) => s.id)).toEqual(['V14', 'U13'])
    for (const s of quits) {
      const from = s.steps.findIndex((step) => step.kind === 'quit')
      const to = s.steps.findIndex((step) => step.kind === 'relaunch')
      const ms = s.steps.slice(from, to).reduce((sum, step) => sum + (step.kind === 'wait' && step.until === undefined ? step.ms : 0), 0)
      expect(ms, s.id).toBeGreaterThan(leave)
    }
  })

  it('an open window closed by a step is longer than the open\'s half mark, so a late open still scores half', () => {
    // The window leaves out its closing step's instant: a person's wait of exactly the half mark would leave out an open
    // that lands on it.
    for (const s of ALL) {
      for (const c of s.checks.filter((c) => c.kind === 'open' && c.at !== undefined)) {
        const from = s.steps.findIndex((step) => step.label === c.after)
        const to = s.steps.findIndex((step) => step.label === c.at)
        const ms = s.steps.slice(from, to).reduce((sum, step) => sum + (step.kind === 'wait' && step.until === undefined ? step.ms : 0), 0)
        expect(ms, `${s.id} ${c.id}`).toBeGreaterThan(THRESHOLDS.open[1])
      }
    }
  })

  it('XH2 shows the Claude app\'s page first and its title names the ChatGPT page\'s second tile, so only the title can pass it', () => {
    const xh2 = byId('XH2')
    expect(xh2.steps.find((s) => s.kind === 'wait' && s.until !== undefined)).toMatchObject({ until: { page: 'claude' } })
    expect(xh2.steps.find((s) => s.kind === 'thread')).toMatchObject({ title: titleOf('t2') })
    expect(xh2.sessions.filter((d) => d.app === 'chatgpt' && !d.ghost).map((d) => [d.key, d.ageMs])).toEqual([['t1', 60_000], ['t2', 120_000]])
  })

  it('a state is timed from a step after the dial listed its row, and a turn lasts at least 2 s', () => {
    // Before the first list the row is not on the dial, and the latency would time the first list, not the change. A
    // stop right after its start replaces working before a person could see it.
    for (const s of ALL) {
      for (const c of s.checks.filter((c) => c.kind === 'state')) {
        const step = s.steps.findIndex((step) => step.label === c.after)
        const listed = s.steps.slice(0, step).some((w) => w.kind === 'wait' && w.until?.expect.includes(c.session) === true)
        expect(listed, `${s.id} ${c.id}`).toBe(true)
      }
      for (const [i, step] of s.steps.entries()) {
        if (step.kind !== 'hook' || step.event !== 'turn-stop') continue
        const start = s.steps.slice(0, i).findLastIndex((h) => h.kind === 'hook' && h.event === 'turn-start' && h.session === step.session)
        const ms = s.steps.slice(start, i).reduce((sum, w) => sum + (w.kind === 'wait' && w.until === undefined ? w.ms : 0), 0)
        expect(ms, `${s.id} turn of ${step.session}`).toBeGreaterThanOrEqual(2_000)
      }
    }
  })

  it('a voice speaks to a session with a running process, or to one its link resumes', () => {
    // Words for a session with no process are refused before any send: the voice check and the gate then test nothing.
    for (const s of ALL) {
      for (const [i, step] of s.steps.entries()) {
        if (step.kind !== 'voice') continue
        const started = s.steps.slice(0, i).some((h) => h.kind === 'hook' && h.event === 'start' && h.session === step.target)
        const resumable = s.sessions.find((d) => d.key === step.target)!.resumable === true
        expect(started || resumable, `${s.id} voice ${step.target}`).toBe(true)
      }
    }
  })

  it('C12 speaks to a running, idle Claude app session with no input first: the words reach it, once', () => {
    const c12 = byId('C12')
    expect([c12.app, c12.dims]).toEqual(['claude', ['D5', 'D8']])
    expect(c12.steps.filter((s) => s.kind !== 'wait').map((s) => s.kind)).toEqual(['claude.write', 'hook', 'voice'])
    expect(c12.checks.find((c) => c.kind === 'voice')).toMatchObject({ session: 'a', after: 'voice' })
  })

  it('C8 has no tap or swipe, so its open can only be the voice\'s', () => {
    // A swipe's rest opens the session too: one before the voice would pass the open whatever the voice did. The pick
    // lands on its only row.
    expect(byId('C8').steps.filter((s) => s.kind === 'tap' || s.kind === 'swipe')).toEqual([])
  })

  it('C3, CH1, CH2, XH1 and V2 are tier A only, V12 tier B only, every other scenario (C10, C11, X7, C8, X9, CH3 and XH3 among them) runs in both', () => {
    const onlyA = ['C3', 'CH1', 'CH2', 'XH1', 'V2']
    const onlyB = ['V12']
    for (const s of ALL) expect(s.tiers, s.id).toEqual(onlyA.includes(s.id) ? ['a'] : onlyB.includes(s.id) ? ['b'] : ['a', 'b'])
  })

  it('each tier B scenario carries exactly one cost check, D8, and the tier A only ones none', () => {
    for (const s of ALL) {
      const costs = s.checks.filter((c) => c.kind === 'cost')
      if (s.tiers.includes('b')) expect(costs, s.id).toEqual([{ id: 'cost', kind: 'cost', dim: 'D8' }])
      else expect([costs, s.dims.includes('D8')], s.id).toEqual([[], false])
    }
  })

  it('every key a step or check names is declared, and only probes name a ghost', () => {
    for (const s of ALL) {
      const declared = new Map(s.sessions.map((d) => [d.key, d]))
      const real = (key: SessionKey) => declared.has(key) && !declared.get(key)!.ghost
      expect(declared.size, s.id).toBe(s.sessions.length)
      for (const step of s.steps) {
        for (const key of stepKeys(step)) expect(real(key), `${s.id} ${step.kind} ${key}`).toBe(true)
        // A window title is the title of a session the scenario writes.
        if (step.kind === 'thread') expect(s.sessions.some((d) => !d.ghost && d.title === step.title), `${s.id} thread`).toBe(true)
      }
      for (const check of s.checks) for (const key of checkKeys(check)) expect(real(key), `${s.id} ${check.id} ${key}`).toBe(true)
      for (const probe of s.probes) {
        const keys = checkKeys(probe)
        expect(keys.every((key) => declared.has(key)), `${s.id} probe ${probe.id}`).toBe(true)
        expect(keys.some((key) => declared.get(key)!.ghost), `${s.id} probe ${probe.id}`).toBe(true)
      }
    }
  })

  it('each check\'s after and at name a step\'s label', () => {
    for (const s of ALL) {
      const labels = new Set(s.steps.flatMap((step) => (step.label === undefined ? [] : [step.label])))
      for (const check of [...s.checks, ...s.probes]) {
        for (const label of [check.after, check.at]) if (label !== undefined) expect(labels.has(label), `${s.id} ${check.id} ${label}`).toBe(true)
      }
    }
  })

  it('every title starts with "Eval " and every folder with /work/eval-', () => {
    for (const s of ALL) {
      for (const d of s.sessions) expect([d.title.startsWith('Eval '), d.cwd.startsWith('/work/eval-')], `${s.id} ${d.key}`).toEqual([true, true])
      for (const step of s.steps) {
        if (step.kind === 'codex.write') for (const name of Object.values(step.names ?? {})) expect(name.startsWith('Eval '), s.id).toBe(true)
        if (step.kind === 'voice') expect(step.transcript.startsWith('Eval '), s.id).toBe(true)
        if (step.kind === 'hook' && step.lastAnswer !== undefined) expect(step.lastAnswer.startsWith('Eval '), s.id).toBe(true)
      }
    }
  })

  it('every scenario has a probe, and each step kind but wait is used by a scenario whose probe can see it', () => {
    const sees: Record<Exclude<StepKind, 'wait'>, CheckKind[]> = {
      'claude.write': ['ring'], 'codex.write': ['ring'], quit: ['ring'], relaunch: ['ring'],
      unplug: ['ring', 'focus'], replug: ['ring', 'focus'],
      hook: ['state', 'recap'],
      tap: ['open', 'focus'], swipe: ['open', 'focus'],
      front: ['focus', 'open'], thread: ['focus', 'open'], attach: ['focus', 'open'],
      voice: ['voice'],
      'editor.window': ['ring', 'open', 'scroll'], 'editor.focus': ['focus'], 'editor.closeTerminal': ['ring'],
      'editor.reload': ['ring', 'open'], 'editor.close': ['open', 'scroll'], stroke: ['scroll'],
      'orca.layout': ['ring'], 'orca.focus': ['focus'], 'orca.front': ['ring'], 'orca.plugin': ['ring'], 'orca.close': ['ring'],
    }
    for (const s of ALL) expect(s.probes.length, s.id).toBeGreaterThan(0)
    // A stroke is left out: V11 and V13 alone stroke, and neither has a scroll probe that is caught. V11's row is filed
    // under Terminal (the spec's Expected to fail at baseline), so tier A sees no frame, command or stream line between
    // its stroke and the window's close, and V13 has no stream.
    // Only the kinds some scenario takes, while Orca's are built ahead of its scenarios: the baseline task restores
    // every kind (docs/plans/2026-11-22-dial-eval-orca-plan.md, Decision 18).
    const used = STEP_KINDS.filter((k) => ALL.some((s) => s.steps.some((step) => step.kind === k)))
    for (const kind of used.filter((k) => k !== 'wait' && k !== 'stroke')) {
      const seenBy = ALL.filter((s) => s.steps.some((step) => step.kind === kind) && s.probes.some((p) => sees[kind].includes(p.kind)))
      expect(seenBy.length, kind).toBeGreaterThan(0)
    }
  })

  it('a wait is the person\'s own timing or a condition on the dial bounded by 10 s, never a fixed wait for the dial', () => {
    const waits = (kind: 'condition' | 'reading' | 'own'): string[] => ALL.flatMap((s) => s.steps.flatMap((step, i) => {
      if (step.kind !== 'wait') return []
      const after = s.steps[i - 1]
      const is = step.until !== undefined ? 'condition' : after?.kind === 'wait' && after.until !== undefined ? 'reading' : 'own'
      return is === kind ? [`${s.id} ${step.ms}`] : []
    }))
    // C6's turn, C9's rests on a and on b, C10's gap between quit and relaunch, C11's rest and its time unplugged, X3's
    // still window, X8's turn, X11's switches, CH3's rest on a and XH3's switch. The editors' agents start a second apart
    // (started), so each V scenario has one wait fewer than its starts; then V7's turn and its wait on the person, V10's
    // pause after the reload, V11's rests between its tap, strokes and close, V13's rest before the stroke, V14's gap
    // between quit and relaunch, and V15's rest and its time unplugged; U8's turn, U12's pause after the close and U13's
    // gap between quit and relaunch; O4's rests after the focus and the tap, O7's after the tap and the swipe, O8's two
    // turns and the pause between them, O10's rest on b, O12's time quit and its rest after the focus, O16's agents a
    // second apart, and O17's rest and its time unplugged; VH1's rest on a, UH3's voice 200 ms after the prompt, OH1's rest
    // on a and OH2's voice 200 ms after the focus.
    const starts = (id: string, n: number): string[] => Array<string>(n - 1).fill(`${id} 1000`)
    expect(waits('own')).toEqual(['C6 5000', 'C9 1000', 'C9 3500', 'C10 2000', 'C11 1000', 'C11 3000', 'X3 5000', 'X8 2000',
      'X11 300', 'X11 300', ...starts('V1', 4), ...starts('V2', 20), ...starts('V3', 2), ...starts('V4', 2), ...starts('V5', 2),
      'V7 2000', 'V7 2000', ...starts('V10', 2), 'V10 2000', 'V11 1000', 'V11 1000', 'V11 1000', 'V13 1000',
      ...starts('V14', 3), 'V14 45000', ...starts('V15', 2), 'V15 1000', 'V15 3000',
      ...starts('U1', 4), ...starts('U2', 2), ...starts('U3', 2), ...starts('U4', 2), 'U8 2000', 'U12 2000', ...starts('U13', 3),
      'U13 45000', ...starts('U14', 2),
      'O4 2000', 'O4 3000', 'O7 4000', 'O7 2000', 'O8 2000', 'O8 2000', 'O8 6000', 'O8 2000', 'O10 1000', 'O12 2000', 'O12 2000',
      ...starts('O16', 40), 'O17 1000', 'O17 3000', 'CH3 1000', 'XH3 200',
      ...starts('VH1', 2), 'VH1 1000', ...starts('VH3', 3), ...starts('UH3', 2), 'UH3 200',
      'OH1 1000', 'OH2 200'])
    expect(new Set(waits('condition').map((w) => w.split(' ')[1]))).toEqual(new Set(['10000']))
    // The person reading the face once the list is there.
    expect(new Set(waits('reading').map((w) => w.split(' ')[1]))).toEqual(new Set(['1000']))
    expect(waits('reading')).toHaveLength(waits('condition').length)
  })

  it('an input on the dial or the app comes at least 1 s after its listing, and any step at least 1 s after an input', () => {
    // Faster, it lands in the same instant the list arrives, inside the devices' echo window after a push, or inside a
    // swipe's rest, whose open makes the devices drop the next title as its echo: no person does either. X11's switches
    // 300 ms apart, XH3's voice 200 ms after the follow and OH2's 200 ms after the focus are those scenarios' point: only
    // the input right after one of their own short waits is let through.
    const inputs = new Set<Step['kind']>(['tap', 'swipe', 'voice', 'attach', 'thread', 'stroke', 'editor.focus', 'orca.focus'])
    const quick = new Set(['X11', 'XH3', 'OH2'])
    for (const s of ALL) {
      // Since the last listing, or the last input once there is one. A condition wait may end at once: it counts 0.
      let since: number | null = null
      let afterInput = false
      for (const [i, step] of s.steps.entries()) {
        if (step.kind === 'wait') {
          since = step.until !== undefined ? 0 : since === null ? null : since + step.ms
          if (step.until !== undefined) afterInput = false
          continue
        }
        const input = inputs.has(step.kind)
        if (!input && !afterInput) continue
        const before = s.steps[i - 1]
        if (!(quick.has(s.id) && before?.kind === 'wait' && before.until === undefined)) {
          expect(since, `${s.id} ${step.kind} ${i}`).toBeGreaterThanOrEqual(1_000)
        }
        if (input) [since, afterInput] = [0, true]
      }
    }
  })

  it('a step on a row of the dial comes after a wait until the dial lists that row', () => {
    for (const s of ALL) {
      const listed = new Set<SessionKey>()
      for (const step of s.steps) {
        if (step.kind === 'wait' && step.until) for (const key of step.until.expect) listed.add(key)
        const row = step.kind === 'tap' || step.kind === 'swipe' || step.kind === 'attach' ? step.session
          : step.kind === 'voice' ? step.target
          : step.kind === 'thread' ? s.sessions.find((d) => d.title === step.title)!.key
          : undefined
        // Otherwise the step outruns the first list, and the dial has no row to act on.
        if (row !== undefined) expect(listed.has(row), `${s.id} ${step.kind} ${row}`).toBe(true)
      }
    }
  })

  it('the held-out file cites both specs and says it is not to be read', () => {
    const lines = readFileSync(new URL('./heldOut.ts', import.meta.url), 'utf8').split('\n')
    const header = lines.slice(0, lines.findIndex((line) => !line.startsWith('//'))).map((line) => line.replace(/^\/\/ ?/, '')).join(' ')
    // No string starts with a path: the cross-read scan (scripts/ci-plan.py) takes a quoted one for a read of the docs.
    expect(header.startsWith('Held out (docs/plans/2026-11-21-dial-app-eval-design.md, Held-out set, and '
      + 'the editors\' docs/plans/2026-11-22-dial-eval-vscode-cursor-design.md, Held-out set): whoever fixes '
      + 'a failing group of the dial eval does not read this file.'), header).toBe(true)
  })
})
