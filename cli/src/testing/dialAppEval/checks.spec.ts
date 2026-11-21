import { describe, expect, it } from 'vitest'
import { evaluate, graded, holds, wrongSends } from './checks.js'
import { agentIdOf, THRESHOLDS, type Check, type CheckResult, type Platform, type Scenario, type Seen, type SessionDef,
  type Step, type Tier } from './types.js'

const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const claude = (key: string, n: number): SessionDef =>
  ({ key, app: 'claude', id: uuid(n), localId: `local_${uuid(100 + n)}`, title: `Eval ${key}`, cwd: `/work/eval-${key}`, ageMs: n * 1000 })
const thread = (key: string, n: number): SessionDef =>
  ({ key, app: 'chatgpt', id: uuid(n), title: `Eval ${key}`, cwd: `/work/eval-${key}`, ageMs: n * 1000 })

const A = claude('a', 1)
const B = claude('b', 2)
const C = claude('c', 3)
const GHOST: SessionDef = { ...claude('ghost', 9), ghost: true }
const T = thread('t', 11)
const U = thread('u', 12)
const id = agentIdOf

function scenario(steps: Step[], sessions: SessionDef[] = [A, B, C, GHOST, T, U]): Scenario {
  return { id: 'S1', app: sessions[0]!.app, title: 'Eval scenario', dims: ['D1'], platforms: ['darwin', 'linux', 'win32'],
    tiers: ['a', 'b'], heldOut: false, sessions, steps, checks: [], probes: [] }
}

/** What the driver saw; each step ran at the time given, in order. */
function seen(s: Scenario, times: number[], parts: Partial<Omit<Seen, 'steps'>> = {}): Seen {
  return { frames: [], faces: [], commands: [], deliveries: [], ...parts,
    steps: times.map((at, index) => ({ at, index, kind: s.steps[index]!.kind, label: s.steps[index]!.label })) }
}

type Row = SessionDef | [string, string]
/** One push: the apps frame, then a whole ring. */
function list(at: number, page: string, rows: Row[]): Seen['frames'] {
  return [
    { at, message: { t: 'apps', shown: page, apps: [] } },
    { at, message: { t: 'agents.begin' } },
    ...rows.map((r) => ({ at, message: Array.isArray(r) ? { t: 'agent', id: r[0], name: r[1] } : { t: 'agent', id: id(r), name: r.title } })),
    { at, message: { t: 'agents.end', total: rows.length, tab: '' } },
  ]
}
const frame = (at: number, message: Record<string, unknown>): Seen['frames'][number] => ({ at, message })
const face = (at: number, active: SessionDef | null): Seen['faces'][number] =>
  ({ at, page: 'claude', tiles: [id(A), id(B), id(C)], active: active && id(active) })

function run(check: Check, s: Scenario, w: Seen, tier: Tier = 'a', platform: Platform = 'darwin'): CheckResult[] {
  return evaluate(check, s, w, tier, platform)
}
/** Each result's score by its part. */
const scores = (results: CheckResult[]): Record<string, number> =>
  Object.fromEntries(results.map((r) => [r.check.slice(r.check.indexOf('.') + 1), r.score]))
const ms = (results: CheckResult[], part: string): number | null | undefined =>
  results.find((r) => r.check.endsWith(`.${part}`))?.ms

const write: Step = { kind: 'claude.write', sessions: ['a', 'b', 'c'], label: 'w' }
const tap: Step = { kind: 'tap', session: 'a', label: 'go' }

it('graded is inclusive: at the full mark 1, at the half mark 0.5, past it or never 0', () => {
  expect(graded(1000, THRESHOLDS.follow)).toBe(1)
  expect(graded(3000, THRESHOLDS.follow)).toBe(0.5)
  expect(graded(3001, THRESHOLDS.follow)).toBe(0)
  expect(graded(null, THRESHOLDS.follow)).toBe(0)
})

describe('ring', () => {
  const ring: Check = { id: 'r', kind: 'ring', dim: 'D1', page: 'claude', expect: ['a', 'b', 'c'], after: 'w' }

  it('a whole list with exactly the expected rows, in order and named, passes every part', () => {
    const s = scenario([write])
    const results = run(ring, s, seen(s, [100], { frames: list(200, 'claude', [A, B, C]) }))
    expect(scores(results)).toEqual({ recall: 1, precision: 1, order: 1, names: 1, cap: 1, archived: 1 })
    expect(results[0]).toMatchObject({ tier: 'a', platform: 'darwin', scenario: 'S1', check: 'r.recall', app: 'claude',
      dim: 'D1', heldOut: false, timed: false })
    // The report names session keys, never a title or a folder.
    for (const line of results.flatMap((r) => r.evidence)) expect(line).not.toMatch(/Eval|\/work\//)
  })

  it('missing rows, a duplicate and an unknown id lose recall, precision and order', () => {
    const s = scenario([write])
    const results = run(ring, s, seen(s, [100], { frames: list(200, 'claude', [A, C, [uuid(77), 'Eval x'], A]) }))
    expect(scores(results)).toMatchObject({ recall: 2 / 3, precision: 0.5, order: 1 / 3 })
    expect(results.every((r) => r.evidence.length > 0)).toBe(true)
  })

  it('reads the last whole list after `after` and before `at`, on its own page', () => {
    const s = scenario([write, { kind: 'wait', ms: 1000, label: 'end' }])
    const check: Check = { ...ring, at: 'end' }
    const frames = [...list(50, 'claude', [A, B, C]), ...list(300, 'claude', [A, B, C]), ...list(400, 'codex', [T]),
      ...list(2000, 'claude', [A, B, C])]
    expect(scores(run(check, s, seen(s, [100, 1500], { frames: [...list(50, 'claude', [A, B, C]), ...list(400, 'codex', [T])] }))).recall).toBe(0)
    expect(scores(run(check, s, seen(s, [100, 1500], { frames }))).recall).toBe(1)
  })

  it('names are the latest codex.write names before `at`, as observedTitle makes them', () => {
    const steps: Step[] = [{ kind: 'codex.write', sessions: ['t', 'u'], label: 'w' },
      { kind: 'codex.write', sessions: ['t'], names: { t: 'Eval   renamed ' } }]
    const s = scenario(steps, [T, U, A])
    const check: Check = { id: 'r', kind: 'ring', dim: 'D1', page: 'chatgpt', expect: ['t', 'u'], after: 'w' }
    expect(scores(run(check, s, seen(s, [100, 200], { frames: list(300, 'codex', [[id(T), 'Eval renamed'], U]) }))).names).toBe(1)
    expect(scores(run(check, s, seen(s, [100, 200], { frames: list(300, 'codex', [T, U]) }))).names).toBe(0.5)
  })

  it('more than 16 rows fail the cap, and a row archived before `at` fails archived', () => {
    const many = Array.from({ length: 17 }, (_, i) => claude(`s${i}`, 20 + i))
    const s = scenario([{ kind: 'claude.write', sessions: many.map((m) => m.key), label: 'w' }], many)
    const check: Check = { ...ring, expect: many.slice(0, 16).map((m) => m.key) }
    expect(scores(run(check, s, seen(s, [100], { frames: list(200, 'claude', many) }))).cap).toBe(0)

    const archived = scenario([write, { kind: 'claude.write', sessions: ['c'], archived: true }])
    const two: Check = { ...ring, expect: ['a', 'b'] }
    expect(scores(run(two, archived, seen(archived, [100, 150], { frames: list(200, 'claude', [A, B, C]) }))).archived).toBe(0)
    expect(scores(run(two, archived, seen(archived, [100, 150], { frames: list(200, 'claude', [A, B]) }))).archived).toBe(1)
  })

  it('a timed ring scores the change from `after` to the first right list', () => {
    const s = scenario([write])
    const timed: Check = { ...ring, timed: true }
    const at = (right: number): CheckResult[] =>
      run(timed, s, seen(s, [1000], { frames: [...list(1500, 'claude', [A, B]), ...list(right, 'claude', [A, B, C])] }))
    expect(ms(at(3000), 'change')).toBe(2000)
    expect(scores(at(3000)).change).toBe(1)
    expect(scores(at(4000)).change).toBe(0.5)
    expect(scores(at(6001)).change).toBe(0)
    const never = run(timed, s, seen(s, [1000], { frames: list(1500, 'claude', [A, B]) }))
    expect(scores(never).change).toBe(0)
    expect(ms(never, 'change')).toBeNull()
    expect(never.find((r) => r.check === 'r.change')?.timed).toBe(true)
  })

  it('a probe on a ghost session fails with what was observed', () => {
    const s = scenario([write])
    const probe: Check = { ...ring, expect: ['ghost'] }
    const results = run(probe, s, seen(s, [100], { frames: list(200, 'claude', [A, B, C]) }))
    expect(scores(results).recall).toBe(0)
    expect(results.find((r) => r.check === 'r.recall')?.evidence.length).toBeGreaterThan(0)
  })
})

describe('focus', () => {
  const s = scenario([tap])
  const focus: Check = { id: 'f', kind: 'focus', dim: 'D2', session: 'a', after: 'go' }

  it('the face landing on the session passes, with its latency', () => {
    const results = run(focus, s, seen(s, [500], { faces: [face(100, B), face(600, A)] }))
    expect(scores(results)).toEqual({ lands: 1, latency: 1 })
    expect(ms(results, 'latency')).toBe(100)
  })

  it('the face on another session fails', () => {
    const results = run(focus, s, seen(s, [500], { faces: [face(600, B)] }))
    expect(scores(results)).toEqual({ lands: 0, latency: 0 })
    expect(ms(results, 'latency')).toBeNull()
  })

  it('latency is inclusive: 3000 ms is half, 3001 none', () => {
    expect(scores(run(focus, s, seen(s, [500], { faces: [face(1500, A)] }))).latency).toBe(1)
    expect(scores(run(focus, s, seen(s, [500], { faces: [face(3500, A)] }))).latency).toBe(0.5)
    expect(scores(run(focus, s, seen(s, [500], { faces: [face(3501, A)] }))).latency).toBe(0)
  })

  it('noBounce fails when the face visits another session after landing', () => {
    const check: Check = { ...focus, noBounce: true }
    expect(scores(run(check, s, seen(s, [500], { faces: [face(600, A)] }))).noBounce).toBe(1)
    expect(scores(run(check, s, seen(s, [500], { faces: [face(600, A), face(700, B), face(800, A)] })))).toMatchObject({ lands: 1, noBounce: 0 })
  })
})

describe('still', () => {
  const s = scenario([tap])
  const still: Check = { id: 's', kind: 'still', dim: 'D7', ms: 1000, after: 'go' }

  it('no face change in ms after `after` passes', () => {
    expect(run(still, s, seen(s, [500], { faces: [face(100, A), face(1600, B)] })).map((r) => [r.check, r.score])).toEqual([['s', 1]])
  })

  it('a face change inside the window fails', () => {
    const results = run(still, s, seen(s, [500], { faces: [face(100, A), face(1500, B)] }))
    expect(results.map((r) => r.score)).toEqual([0])
    expect(results[0]!.evidence.length).toBeGreaterThan(0)
  })

  it('the window is inclusive of its last ms', () => {
    const check: Check = { ...still, dim: 'D2' }
    expect(scores(run(check, s, seen(s, [500], { faces: [face(100, A), face(1500, B)] }))).still).toBe(0)
    expect(scores(run(check, s, seen(s, [500], { faces: [face(100, A), face(1501, B)] }))).still).toBe(1)
  })
})

describe('open', () => {
  const s = scenario([tap])
  const open: Check = { id: 'o', kind: 'open', dim: 'D3', session: 'a', link: true, after: 'go' }
  const link = `claude://code/continue?session=${A.localId}`
  const cmd = (at: number, argv: string[]): Seen['commands'][number] => ({ at, argv })

  it('the session\'s link sent to the app by its bundle passes link, front and latency on macOS', () => {
    const results = run(open, s, seen(s, [500], { commands: [cmd(700, ['/usr/bin/open', '-b', 'com.anthropic.claudefordesktop', link])] }))
    expect(scores(results)).toEqual({ link: 1, front: 1, latency: 1 })
    expect(ms(results, 'latency')).toBe(200)
  })

  it('a Codex thread opens by codex://threads/<id> and the ChatGPT app\'s bundle', () => {
    const x = scenario([{ kind: 'tap', session: 't', label: 'go' }], [T, U])
    const check: Check = { ...open, session: 't' }
    const argv = ['/usr/bin/open', '-b', 'com.openai.codex', `codex://threads/${T.id}`]
    expect(scores(run(check, x, seen(x, [500], { commands: [cmd(600, argv)] })))).toEqual({ link: 1, front: 1, latency: 1 })
  })

  it('another session\'s link fails link; no command fails all', () => {
    const other = `claude://code/continue?session=${B.localId}`
    expect(scores(run(open, s, seen(s, [500], { commands: [cmd(700, ['/usr/bin/open', '-b', 'com.anthropic.claudefordesktop', other])] }))))
      .toEqual({ link: 0, front: 1, latency: 1 })
    expect(scores(run(open, s, seen(s, [500])))).toEqual({ link: 0, front: 0, latency: 0 })
  })

  it('front is xdg-open with the link or a raise on Linux, harness-pty open-link or raise on Windows', () => {
    const front = (platform: Platform, argv: string[]): number | undefined =>
      scores(run(open, s, seen(s, [500], { commands: [cmd(600, argv)] }), 'a', platform)).front
    expect(front('linux', ['/usr/bin/xdg-open', link])).toBe(1)
    expect(front('linux', ['raise', 'claude'])).toBe(1)
    expect(front('linux', ['/usr/bin/open', '-b', 'com.anthropic.claudefordesktop'])).toBe(0)
    expect(front('win32', ['C:\\h\\harness-pty.exe', 'open-link', link])).toBe(1)
    expect(front('win32', ['C:\\h\\harness-pty.exe', 'raise', '--exe', 'claude.exe'])).toBe(1)
    expect(front('darwin', ['/usr/bin/open', '-b', 'com.anthropic.claudefordesktop'])).toBe(1)
    expect(front('darwin', ['/usr/bin/open', '-b', 'com.openai.codex'])).toBe(0)
  })

  it('latency 3001 ms scores 0, and link: false has no link part', () => {
    const late = seen(s, [500], { commands: [cmd(3501, ['/usr/bin/open', '-b', 'com.anthropic.claudefordesktop'])] })
    expect(scores(run({ ...open, link: false }, s, late))).toEqual({ front: 1, latency: 0 })
  })
})

describe('state', () => {
  const s = scenario([write, { kind: 'hook', session: 'a', event: 'turn-start', label: 'go' }])
  const state = (want: 'working' | 'needs-you' | 'done' | 'idle'): Check =>
    ({ id: 'st', kind: 'state', dim: 'D4', session: 'a', state: want, after: 'go' })
  const ring = list(100, 'claude', [A, B, C])

  it('the row in that state after `after` passes, with its latency', () => {
    const results = run(state('working'), s, seen(s, [50, 500], { frames: [...ring, frame(800, { t: 'turn.started', agentId: id(A), text: '' })] }))
    expect(scores(results)).toEqual({ shown: 1, latency: 1 })
    expect(ms(results, 'latency')).toBe(300)
    const asked = run(state('needs-you'), s, seen(s, [50, 500], { frames: [...ring, frame(900, { t: 'question', agentId: id(A), id: 'q' })] }))
    expect(scores(asked)).toEqual({ shown: 1, latency: 1 })
  })

  it('no state frame, or a row not on its page, fails', () => {
    expect(scores(run(state('working'), s, seen(s, [50, 500], { frames: ring })))).toEqual({ shown: 0, latency: 0 })
    const off = seen(s, [50, 500], { frames: [...list(100, 'claude', [B]), frame(800, { t: 'turn.started', agentId: id(A), text: '' })] })
    expect(scores(run(state('working'), s, off)).shown).toBe(0)
  })

  it('done has its own latency: 2500 ms full, 5000 half; idle has no latency', () => {
    const done = (at: number): Record<string, number> =>
      scores(run(state('done'), s, seen(s, [50, 500], { frames: [...ring, frame(at, { t: 'summary', agentId: id(A), recap: '', text: '' })] })))
    expect(done(3000)).toEqual({ shown: 1, latency: 1 })
    expect(done(3001)).toEqual({ shown: 1, latency: 0.5 })
    expect(done(5501)).toEqual({ shown: 1, latency: 0 })
    expect(scores(run(state('idle'), s, seen(s, [50, 500], { frames: ring })))).toEqual({ shown: 1 })
  })

  it('a question\'s close puts the row back to working', () => {
    const frames = [...ring, frame(600, { t: 'question', agentId: id(A), id: 'q' }), frame(700, { t: 'question.close', agentId: id(A), id: 'q' })]
    const s2 = scenario([write, { kind: 'hook', session: 'a', event: 'needs-input', label: 'go' }])
    expect(scores(run(state('working'), s2, seen(s2, [50, 650], { frames }))).shown).toBe(1)
  })
})

describe('voice', () => {
  const s = scenario([{ kind: 'voice', transcript: 'Eval hello', target: 'a', label: 'go' }])
  const voice: Check = { id: 'v', kind: 'voice', dim: 'D5', session: 'a', text: 'Eval hello', after: 'go' }
  const to = (at: number, target: string | null, text = 'Eval hello'): Seen['deliveries'][number] => ({ at, path: 'mod', target, text })

  it('the exact text reaching the target once passes', () => {
    expect(scores(run(voice, s, seen(s, [500], { deliveries: [to(600, 'a')] })))).toEqual({ reached: 1, once: 1, exact: 1 })
  })

  it('twice fails once, another text fails exact, none fails all', () => {
    expect(scores(run(voice, s, seen(s, [500], { deliveries: [to(600, 'a'), to(700, 'a')] })))).toEqual({ reached: 1, once: 0, exact: 1 })
    expect(scores(run(voice, s, seen(s, [500], { deliveries: [to(600, 'a', 'Eval hell')] })))).toEqual({ reached: 1, once: 1, exact: 0 })
    expect(scores(run(voice, s, seen(s, [500], { deliveries: [to(600, 'b')] })))).toEqual({ reached: 0, once: 0, exact: 0 })
  })

  it('a delivery before `after` is not this step\'s', () => {
    expect(scores(run(voice, s, seen(s, [500], { deliveries: [to(400, 'a')] }))).reached).toBe(0)
  })
})

describe('recap', () => {
  const s = scenario([write, { kind: 'hook', session: 'a', event: 'turn-stop', lastAnswer: 'Eval answer', label: 'go' }])
  const recap: Check = { id: 'c', kind: 'recap', dim: 'D6', session: 'a', text: 'Eval answer', after: 'go' }
  const summary = (at: number, text: string): Seen['frames'][number] => frame(at, { t: 'summary', agentId: id(A), recap: text, text })

  it('the session\'s summary text exactly passes; another fails; none fails', () => {
    expect(scores(run(recap, s, seen(s, [50, 500], { frames: [summary(2100, 'Eval answer')] })))).toEqual({ exact: 1 })
    expect(scores(run(recap, s, seen(s, [50, 500], { frames: [summary(2100, 'Eval answe')] })))).toEqual({ exact: 0 })
    expect(scores(run(recap, s, seen(s, [50, 500], { frames: [summary(400, 'Eval answer')] })))).toEqual({ exact: 0 })
  })
})

describe('cost', () => {
  const s = scenario([write])
  const cost: Check = { id: 'cost', kind: 'cost', dim: 'D8' }

  it('scores CPU and loop p99 against their marks, and processes left as pass/fail', () => {
    const results = run(cost, s, seen(s, [0], { cost: { cpuPercent: 10, loopP99Ms: 200, leftovers: 0 } }), 'b')
    expect(scores(results)).toEqual({ cpu: 1, loopP99: 0.5, leftovers: 1 })
    expect(results.map((r) => [r.check, r.timed])).toEqual([['cost.cpu', true], ['cost.loopP99', true], ['cost.leftovers', false]])
    expect(scores(run(cost, s, seen(s, [0], { cost: { cpuPercent: 25.1, loopP99Ms: 201, leftovers: 1 } }), 'b')))
      .toEqual({ cpu: 0, loopP99: 0, leftovers: 0 })
  })

  it('no measure fails every part with no evidence', () => {
    const results = run(cost, s, seen(s, [0]), 'b')
    expect(scores(results)).toEqual({ cpu: 0, loopP99: 0, leftovers: 0 })
    expect(results.flatMap((r) => r.evidence)).toEqual([])
  })

  it('cost gives nothing in tier A', () => {
    expect(run(cost, s, seen(s, [0], { cost: { cpuPercent: 1, loopP99Ms: 1, leftovers: 0 } }), 'a')).toEqual([])
  })
})

it('two rows with the same title are matched by id', () => {
  const twin: SessionDef = { ...B, title: A.title }
  const s = scenario([write], [A, twin, C])
  const check: Check = { id: 'r', kind: 'ring', dim: 'D1', page: 'claude', expect: ['a', 'b'], after: 'w' }
  expect(scores(run(check, s, seen(s, [100], { frames: list(200, 'claude', [twin, A]) }))))
    .toMatchObject({ recall: 1, precision: 1, order: 0, names: 1 })
})

it('a list with no agents.end, or cut by a second agents.begin, is not read', () => {
  const s = scenario([write])
  const check: Check = { id: 'r', kind: 'ring', dim: 'D1', page: 'claude', expect: ['b'], after: 'w' }
  const open = [...list(200, 'claude', [A]), frame(300, { t: 'agents.begin' }), frame(300, { t: 'agent', id: id(B), name: B.title })]
  expect(scores(run(check, s, seen(s, [100], { frames: open }))).recall).toBe(0)
  const cut = [frame(200, { t: 'apps', shown: 'claude', apps: [] }), frame(200, { t: 'agents.begin' }),
    frame(200, { t: 'agent', id: id(B), name: B.title }), frame(200, { t: 'agents.begin' }),
    frame(200, { t: 'agent', id: id(A), name: A.title }), frame(200, { t: 'agents.end', total: 1, tab: '' })]
  expect(scores(run(check, s, seen(s, [100], { frames: cut })))).toMatchObject({ recall: 0, precision: 0 })
})

it('a delivery with no known target is a wrong send', () => {
  const s = scenario([write, { kind: 'voice', transcript: 'Eval hi', target: 'a' }])
  const deliveries: Seen['deliveries'] = [
    { at: 40, path: 'turns', target: 'b', text: 'Eval before' },
    { at: 600, path: 'mod', target: 'a', text: 'Eval hi' },
    { at: 700, path: 'typed', target: null, text: 'Eval hi' },
    { at: 800, path: 'codex', target: 'b', text: 'Eval hi' },
  ]
  expect(wrongSends(s, seen(s, [50, 500], { deliveries }))).toEqual([
    { scenario: 'S1', target: 'a', got: null, path: 'typed', at: 700 },
    { scenario: 'S1', target: 'a', got: 'b', path: 'codex', at: 800 },
  ])
})

it('a ring check with D7 is one pass/fail result', () => {
  const s = scenario([write])
  const check: Check = { id: 'r', kind: 'ring', dim: 'D7', page: 'claude', expect: ['a', 'b', 'c'], after: 'w', timed: true }
  // Right but slow: timed parts do not count.
  const right = run(check, s, seen(s, [100], { frames: list(9000, 'claude', [A, B, C]) }))
  expect(right.map((r) => [r.check, r.score, r.timed])).toEqual([['r', 1, false]])
  const extra = run(check, s, seen(s, [100], { frames: list(200, 'claude', [A, B, C, [uuid(77), 'Eval x']]) }))
  expect(extra.map((r) => [r.check, r.score])).toEqual([['r', 0]])
  expect(extra[0]!.evidence.length).toBeGreaterThan(0)
})

it('evidence is empty when nothing was seen', () => {
  const s = scenario([write, { kind: 'voice', transcript: 'Eval hi', target: 'a', label: 'go' }])
  const checks: Check[] = [
    { id: 'r', kind: 'ring', dim: 'D1', page: 'claude', expect: ['a'], timed: true },
    { id: 'f', kind: 'focus', dim: 'D2', session: 'a', noBounce: true },
    { id: 'o', kind: 'open', dim: 'D3', session: 'a', link: true },
    { id: 'st', kind: 'state', dim: 'D4', session: 'a', state: 'working' },
    { id: 'v', kind: 'voice', dim: 'D5', session: 'a', text: 'Eval hi', after: 'go' },
    { id: 'c', kind: 'recap', dim: 'D6', session: 'a', text: 'Eval hi' },
  ]
  for (const check of checks) {
    const results = run(check, s, seen(s, [50, 500]))
    expect(results.length).toBeGreaterThan(0)
    for (const r of results) expect([r.check, r.score, r.evidence]).toEqual([r.check, 0, []])
  }
})

it('holds is whether a wait may end: every untimed part right', () => {
  const s = scenario([write])
  const check: Check = { id: 'r', kind: 'ring', dim: 'D1', page: 'claude', expect: ['a', 'b'], after: 'w', timed: true }
  expect(holds(check, s, seen(s, [100], { frames: list(9000, 'claude', [A, B]) }))).toBe(true)
  expect(holds(check, s, seen(s, [100], { frames: list(200, 'claude', [A]) }))).toBe(false)
  // Its `after` step has not run yet.
  expect(holds(check, s, seen(s, []))).toBe(false)
})
