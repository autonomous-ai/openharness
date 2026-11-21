import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { HELD_OUT, MAIN } from './catalog.js'
import { STEP_KINDS, type Check, type CheckKind, type Scenario, type SessionKey, type Step, type StepKind } from './types.js'

const ALL = [...MAIN, ...HELD_OUT]
const byId = (id: string): Scenario => ALL.find((s) => s.id === id)!

/** The session keys a step names. */
function stepKeys(step: Step): SessionKey[] {
  switch (step.kind) {
    case 'claude.write': return step.sessions
    case 'codex.write': return [...step.sessions, ...step.archived ?? [], ...Object.keys(step.names ?? {}), ...Object.keys(step.ages ?? {})]
    case 'hook': case 'attach': case 'tap': case 'swipe': return [step.session]
    case 'voice': return [step.target]
    default: return []
  }
}
/** The session keys a check names. */
function checkKeys(check: Check): SessionKey[] {
  switch (check.kind) {
    case 'ring': return check.expect
    case 'focus': case 'open': case 'state': case 'voice': case 'recap': return [check.session]
    default: return []
  }
}

describe('the catalog', () => {
  it('the ids are C1-C11, X1-X11 and the six held out, 6 of 28', () => {
    const range = (prefix: string) => Array.from({ length: 11 }, (_, i) => `${prefix}${i + 1}`)
    expect(MAIN.map((s) => s.id)).toEqual([...range('C'), ...range('X')])
    expect(HELD_OUT.map((s) => s.id)).toEqual(['CH1', 'CH2', 'CH3', 'XH1', 'XH2', 'XH3'])
    expect(MAIN.every((s) => !s.heldOut)).toBe(true)
    expect(HELD_OUT.every((s) => s.heldOut)).toBe(true)
    expect(ALL).toHaveLength(28)
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

  it('X3 is macOS only', () => {
    for (const s of ALL) expect(s.platforms, s.id).toEqual(s.id === 'X3' ? ['darwin'] : ['darwin', 'win32', 'linux'])
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
      ['front', ''], ['claude.write', ''], ['wait', 10_000], ['wait', 1_000], ['swipe', 'a'], ['wait', 1_000], ['swipe', 'b'], ['wait', 3_000], ['hook', 'b']])
    expect(c9.steps.filter((s) => s.kind === 'hook')).toEqual([{ label: 'hook', kind: 'hook', session: 'b', event: 'start' }])
    expect(c9.checks.filter((c) => c.kind !== 'cost')).toEqual([
      { id: 'open', kind: 'open', dim: 'D3', session: 'b', link: true, after: 'swipe', at: 'hook' },
      { id: 'ring', kind: 'ring', dim: 'D1', page: 'claude', expect: ['b', 'a'], after: 'hook' },
      { id: 'ringKept', kind: 'ring', dim: 'D7', page: 'claude', expect: ['b', 'a'] },
    ])
  })

  it('C8 has no tap or swipe, so its open can only be the voice\'s', () => {
    // A swipe's rest opens the session too: one before the voice would pass the open whatever the voice did. The pick
    // lands on its only row.
    expect(byId('C8').steps.filter((s) => s.kind === 'tap' || s.kind === 'swipe')).toEqual([])
  })

  it('C3, CH1, CH2 and XH1 are tier A only, every other scenario (C10, C11, X7, C8, X9, CH3 and XH3 among them) runs in tier B', () => {
    const onlyA = ['C3', 'CH1', 'CH2', 'XH1']
    for (const s of ALL) expect(s.tiers, s.id).toEqual(onlyA.includes(s.id) ? ['a'] : ['a', 'b'])
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
    }
    for (const s of ALL) expect(s.probes.length, s.id).toBeGreaterThan(0)
    for (const kind of STEP_KINDS.filter((k) => k !== 'wait')) {
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
    // C6's turn, C9's rests on a and on b, C10's gap between quit and relaunch, C11's time unplugged, X3's still window,
    // X11's and XH3's switches.
    expect(waits('own')).toEqual(['C6 5000', 'C9 1000', 'C9 3000', 'C10 2000', 'C11 3000', 'X3 5000', 'X11 300', 'X11 300', 'XH3 200'])
    expect(new Set(waits('condition').map((w) => w.split(' ')[1]))).toEqual(new Set(['10000']))
    // The person reading the face once the list is there.
    expect(new Set(waits('reading').map((w) => w.split(' ')[1]))).toEqual(new Set(['1000']))
    expect(waits('reading')).toHaveLength(waits('condition').length)
  })

  it('an input on the dial or the app comes at least 1 s after its listing and after the input before it', () => {
    // Faster, it lands in the same instant the list arrives, inside the devices' echo window after a push, or inside a
    // swipe's rest, whose open makes the devices drop the next title as its echo: no person does either. XH2 has no
    // listing (see below). X11's switches 300 ms apart and XH3's voice 200 ms after the follow are those scenarios'
    // point: only the input right after one of their own short waits is let through.
    const inputs = new Set<Step['kind']>(['tap', 'swipe', 'voice', 'attach', 'thread'])
    const quick = new Set(['X11', 'XH3'])
    for (const s of ALL.filter((s) => s.id !== 'XH2')) {
      // Since the last listing, or the last input once there is one. A condition wait may end at once: it counts 0.
      let since: number | null = null
      for (const [i, step] of s.steps.entries()) {
        if (step.kind === 'wait') {
          since = step.until !== undefined ? 0 : since === null ? null : since + step.ms
          continue
        }
        if (!inputs.has(step.kind)) continue
        const before = s.steps[i - 1]
        if (!(quick.has(s.id) && before?.kind === 'wait' && before.until === undefined)) {
          expect(since, `${s.id} ${step.kind} ${i}`).toBeGreaterThanOrEqual(1_000)
        }
        since = 0
      }
    }
  })

  it('a step on a row of the dial comes after a wait until the dial lists that row', () => {
    // XH2's thread is on the ChatGPT page while the dial shows the Claude app's: no list of it reaches the dial first.
    const unlisted = new Set(['XH2'])
    for (const s of ALL.filter((s) => !unlisted.has(s.id))) {
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

  it('the held-out file says it is not to be read', () => {
    const lines = readFileSync(new URL('./heldOut.ts', import.meta.url), 'utf8').split('\n')
    const header = lines.slice(0, lines.findIndex((line) => !line.startsWith('//'))).map((line) => line.replace(/^\/\/ ?/, '')).join(' ')
    expect(header.startsWith('Held out (docs/plans/2026-11-21-dial-app-eval-design.md, Held-out set): whoever fixes a failing group of the dial eval does not read this file.')).toBe(true)
  })
})
