import { describe, expect, it } from 'vitest'
import { condition, evaluate, graded, wrongSends } from './checks.js'
import { uncaughtProbes } from './runner.js'
import { agentIdOf, orcaPaneHandle, orcaWorktreeId, THRESHOLDS, type Check, type CheckResult, type Platform, type Scenario,
  type Seen, type SessionDef, type Step, type Tier, type Until } from './types.js'

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
  ({ at, page: 'claude', tiles: [id(A), id(B), id(C)], active: active && id(active), refused: 0 })

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

  it('reads the ring the dial holds as the window ends: the last whole list before `at`, whatever its page', () => {
    const s = scenario([write, { kind: 'wait', ms: 1000, label: 'end' }])
    const check: Check = { ...ring, at: 'end' }
    const frames = [...list(300, 'claude', [A, B, C]), ...list(2000, 'claude', [A])]
    expect(scores(run(check, s, seen(s, [100, 1500], { frames })))).toMatchObject({ recall: 1, precision: 1 })
    // The dial moved to another page: claude's ring is not what it holds.
    const moved = run(check, s, seen(s, [100, 1500], { frames: [...list(300, 'claude', [A, B, C]), ...list(400, 'codex', [T])] }))
    expect(scores(moved)).toEqual({ recall: 0, precision: 0, order: 0, names: 0, cap: 0, archived: 0 })
    expect(moved[0]!.evidence).toEqual(['list at 400 on codex, not claude: 1 rows t'])
  })

  it('a page\'s list followed by an empty list with no page fails: the dial shows nothing', () => {
    const s = scenario([write])
    const results = run(ring, s, seen(s, [100], { frames: [...list(200, 'claude', [A, B, C]), ...list(300, '', [])] }))
    expect(scores(results)).toEqual({ recall: 0, precision: 0, order: 0, names: 0, cap: 0, archived: 0 })
    expect(results[0]!.evidence).toEqual(['list at 300 on none, not claude: 0 rows'])
  })

  it('a later list of the same page is the one graded', () => {
    const s = scenario([write])
    const fixed = run(ring, s, seen(s, [100], { frames: [...list(200, 'claude', [A]), ...list(300, 'claude', [A, B, C])] }))
    expect(scores(fixed)).toEqual({ recall: 1, precision: 1, order: 1, names: 1, cap: 1, archived: 1 })
    const shrunk = run(ring, s, seen(s, [100], { frames: [...list(200, 'claude', [A, B, C]), ...list(300, 'claude', [A])] }))
    expect(scores(shrunk)).toMatchObject({ recall: 1 / 3, precision: 1 })
    expect(shrunk[0]!.evidence).toEqual(['list at 300 on claude: 1 rows a'])
  })

  it('a list from before `after` is the ring still held: right, it passes every untimed part, and only change needs a list in the window', () => {
    const s = scenario([write])
    const results = run({ ...ring, timed: true }, s, seen(s, [100], { frames: list(50, 'claude', [A, B, C]) }))
    expect(scores(results)).toEqual({ recall: 1, precision: 1, order: 1, names: 1, cap: 1, archived: 1, change: 0 })
    expect(results[0]!.evidence).toEqual(['list at 50 on claude: 3 rows a b c'])
    expect(results.find((r) => r.check === 'r.change')!.evidence).toEqual(['list at 50 on claude: 3 rows a b c', 'no right list in the window'])
    // Held but stale: an archive no push followed still shows its row.
    const archived = scenario([write, { kind: 'claude.write', sessions: ['b'], archived: true, label: 'archive' }])
    const stale = run({ ...ring, expect: ['a', 'c'], after: 'archive' }, archived, seen(archived, [50, 100], { frames: list(60, 'claude', [A, B, C]) }))
    expect(scores(stale)).toMatchObject({ recall: 1, precision: 2 / 3, archived: 0 })
  })

  it('an unplugged dial holds no list it had before: after a replug only a list since the unplug is read', () => {
    const s = scenario([write, { kind: 'unplug' }, { kind: 'replug', label: 'r' }])
    const check: Check = { ...ring, after: 'r' }
    const before = run(check, s, seen(s, [100, 200, 300], { frames: list(150, 'claude', [A, B, C]) }))
    expect(scores(before).recall).toBe(0)
    expect(before[0]!.evidence).toEqual(['no whole list held on claude; 1 whole lists seen'])
    expect(scores(run(check, s, seen(s, [100, 200, 300], { frames: [...list(150, 'claude', [A, B, C]), ...list(400, 'claude', [A, B, C])] }))).recall)
      .toBe(1)
  })

  it('names are the latest codex.write names before `at`, as observedTitle makes them', () => {
    const steps: Step[] = [{ kind: 'codex.write', sessions: ['t', 'u'], label: 'w' },
      { kind: 'codex.write', sessions: ['t'], names: { t: 'Eval   renamed ' } }]
    const s = scenario(steps, [T, U, A])
    const check: Check = { id: 'r', kind: 'ring', dim: 'D1', page: 'chatgpt', expect: ['t', 'u'], after: 'w' }
    expect(scores(run(check, s, seen(s, [100, 200], { frames: list(300, 'codex', [[id(T), 'Eval renamed'], U]) }))).names).toBe(1)
    expect(scores(run(check, s, seen(s, [100, 200], { frames: list(300, 'codex', [T, U]) }))).names).toBe(0.5)
  })

  it('names are scored over the expected rows present: a missing row loses recall alone', () => {
    const s = scenario([write])
    const results = run(ring, s, seen(s, [100], { frames: list(200, 'claude', [A, C]) }))
    expect(scores(results)).toMatchObject({ recall: 2 / 3, names: 1 })
    expect(results[0]!.evidence).toEqual(['list at 200 on claude: 2 rows a c'])
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

  it('a long ring\'s evidence names at most 20 sessions a line', () => {
    const many = Array.from({ length: 30 }, (_, i) => claude(`s${i}`, 20 + i))
    const s = scenario([{ kind: 'claude.write', sessions: many.map((m) => m.key), label: 'w' }], many)
    const misnamed = many.map((m): Row => [id(m), 'Eval wrong'])
    const results = run({ ...ring, expect: many.map((m) => m.key) }, s, seen(s, [100], { frames: list(200, 'claude', misnamed) }))
    const keys = many.slice(0, 20).map((m) => m.key).join(' ')
    expect(results[0]!.evidence).toEqual([`list at 200 on claude: 30 rows ${keys} … 10 more`, `names wrong: ${keys} … 10 more`])
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

  it('apart: the other pages of the apps frame with the ring count exactly its sessions, so one merged into the ring fails', () => {
    const s = scenario([{ kind: 'codex.write', sessions: ['t', 'u'], label: 'w' }], [T, U])
    const check: Check = { id: 'r', kind: 'ring', dim: 'D1', page: 'chatgpt', expect: ['t'], apart: ['u'], after: 'w' }
    const counted = (ghostty: number): Seen['frames'] => [frame(200, { t: 'apps', shown: 'codex',
      apps: [{ id: 'ghostty', name: 'Ghostty', count: ghostty, waiting: 0 }, { id: 'codex', name: 'ChatGPT', count: 1, waiting: 0 }] }),
    ...list(200, 'codex', [T]).slice(1)]
    const apart = (frames: Seen['frames']): CheckResult => run(check, s, seen(s, [100], { frames })).find((r) => r.check === 'r.apart')!
    expect(apart(counted(1))).toMatchObject({ score: 1, dim: 'D1', timed: false })
    expect(apart(counted(1)).evidence).toContain('apps at 200: ghostty 1, codex 1')
    // u merged into t's row: no other page counts it.
    expect(apart(counted(0)).score).toBe(0)
    expect(apart(counted(2)).score).toBe(0)
    expect(apart(list(200, 'codex', [T])).score).toBe(0)
    // The apps frame the dial holds as the window ends, even one from before `after`.
    expect(run(check, s, seen(s, [300], { frames: counted(1) })).find((r) => r.check === 'r.apart')!.score).toBe(1)
    // The last apps frame, whatever its page: one showing no page counts nothing of the ring's.
    const left = apart([...counted(1), frame(300, { t: 'apps', shown: '', apps: [] })])
    expect(left).toMatchObject({ score: 0, evidence: ['apps at 300 on none, not codex'] })
    // A ring check that names no sessions apart has no such part.
    expect(run({ ...ring }, scenario([write]), seen(scenario([write]), [100], { frames: list(200, 'claude', [A, B, C]) }))
      .some((r) => r.check === 'r.apart')).toBe(false)
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

  it('a face already on the session when the window opens lands at its start, and noBounce is judged from there', () => {
    const check: Check = { ...focus, noBounce: true }
    const already = run(check, s, seen(s, [500], { faces: [face(100, A)] }))
    expect(scores(already)).toEqual({ lands: 1, latency: 1, noBounce: 1 })
    expect(ms(already, 'latency')).toBe(0)
    // It left and came back: a bounce, though the last face is on it again.
    expect(scores(run(check, s, seen(s, [500], { faces: [face(100, A), face(700, B), face(800, A)] })))).toMatchObject({ lands: 1, noBounce: 0 })
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

  it('no face change in ms after `after` passes, naming the face held', () => {
    const results = run(still, s, seen(s, [500], { faces: [face(100, A), face(1600, B)] }))
    expect(results.map((r) => [r.check, r.score, r.evidence])).toEqual([['s', 1, ['face at 100: a']]])
  })

  it('a face that moves at the window\'s first ms moved: the window opens on the face before it', () => {
    expect(scores(run(still, s, seen(s, [500], { faces: [face(100, A), face(500, B)] }))).s).toBe(0)
  })

  it('no face seen at all is not still: it scores 0 with nothing to show', () => {
    expect(run(still, s, seen(s, [500])).map((r) => [r.score, r.evidence])).toEqual([[0, []]])
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

  it('a step that closes the window at its last ms is not the dial moving by itself', () => {
    const t = scenario([tap, { ...tap, label: 'next' }])
    const check: Check = { ...still, dim: 'D2', at: 'next' }
    expect(scores(run(check, t, seen(t, [500, 1500], { faces: [face(100, A), face(1500, B)] }))).still).toBe(1)
    expect(scores(run(check, t, seen(t, [500, 1500], { faces: [face(100, A), face(1499, B)] }))).still).toBe(0)
  })

  it('the first landing from no tile is not a move; leaving that tile for another, or for none, is', () => {
    expect(scores(run(still, s, seen(s, [500], { faces: [face(100, null), face(700, A), face(900, A)] }))).s).toBe(1)
    expect(scores(run(still, s, seen(s, [500], { faces: [face(100, null), face(700, A), face(900, B)] }))).s).toBe(0)
    expect(scores(run(still, s, seen(s, [500], { faces: [face(100, null), face(700, A), face(900, null)] }))).s).toBe(0)
  })
})

describe('open', () => {
  const s = scenario([tap])
  const open: Check = { id: 'o', kind: 'open', dim: 'D3', session: 'a', link: true, after: 'go' }
  const link = `claude://code/continue?session=${A.localId}`
  const cmd = (at: number, argv: string[], ok = true): Seen['commands'][number] => ({ at, argv, ok })

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

  it('a raise counts only for the session\'s app: on Windows by its bundle or program, on Linux by its app id or window class', () => {
    const front = (platform: Platform, argv: string[]): number | undefined =>
      scores(run(open, s, seen(s, [500], { commands: [cmd(600, argv)] }), 'a', platform)).front
    expect(front('win32', ['C:\\h\\harness-pty.exe', 'raise', 'com.anthropic.claudefordesktop'])).toBe(1)
    expect(front('win32', ['C:\\h\\harness-pty.exe', 'raise', '--exe', 'Claude.exe'])).toBe(1)
    expect(front('win32', ['C:\\h\\harness-pty.exe', 'raise', 'com.openai.codex'])).toBe(0)
    expect(front('win32', ['C:\\h\\harness-pty.exe', 'raise', '--exe', 'Code.exe'])).toBe(0)
    expect(front('win32', ['C:\\h\\harness-pty.exe', 'raise'])).toBe(0)
    expect(front('linux', ['raise', '41000', 'claude'])).toBe(1)
    expect(front('linux', ['raise', 'com.anthropic.Claude'])).toBe(1)
    expect(front('linux', ['raise', '41000', 'kitty'])).toBe(0)
    expect(front('linux', ['raise', '41000'])).toBe(0)
    expect(front('linux', ['raise', 'codex'])).toBe(0)
  })

  it('a command that failed is not the app coming up', () => {
    const refused = run(open, s, seen(s, [500], { commands: [cmd(700, ['/usr/bin/open', '-b', 'com.anthropic.claudefordesktop', link], false)] }))
    expect(scores(refused)).toEqual({ link: 1, front: 0, latency: 0 })
    expect(refused[0]!.evidence).toEqual(['tap on a at 500', 'command at 700: link failed'])
  })

  it('a command carrying the link of an app whose links fail is never the app coming up: the one after it is', () => {
    const x: Scenario = { ...scenario([tap]), world: { linkFails: ['claude'] } }
    const commands = [cmd(700, ['/usr/bin/open', '-b', 'com.anthropic.claudefordesktop', link]),
      cmd(900, ['/usr/bin/open', '-b', 'com.anthropic.claudefordesktop'])]
    const results = run({ ...open, link: false }, x, seen(x, [500], { commands }))
    expect(scores(results)).toEqual({ front: 1, latency: 1 })
    expect(ms(results, 'latency')).toBe(400)
  })

  it('the evidence names the tap or swipe it saw, so an input that opened nothing fails with it', () => {
    const x = scenario([{ kind: 'swipe', session: 'b', label: 'go' }])
    const results = run(open, x, seen(x, [500], { frames: [frame(600, { t: 'focus', id: id(B) })] }))
    expect(scores(results)).toEqual({ link: 0, front: 0, latency: 0 })
    for (const r of results) expect(r.evidence).toEqual(['swipe on b at 500', 'no command'])
    const opened = run(open, s, seen(s, [500], { commands: [cmd(700, ['/usr/bin/open', '-b', 'com.anthropic.claudefordesktop', link])] }))
    expect(opened[0]!.evidence).toEqual(['tap on a at 500', 'command at 700: link front'])
  })

  it('an input with no command or frame seen in its window says nothing: a recorder that saw nothing catches no probe', () => {
    const x = scenario([{ kind: 'swipe', session: 'b', label: 'go' }])
    const results = run(open, x, seen(x, [500], { frames: [frame(400, { t: 'focus', id: id(B) })] }))
    expect(results.map((r) => [r.score, r.evidence])).toEqual([[0, []], [0, []], [0, []]])
  })

  it('latency 3001 ms scores 0, and link: false has no link part', () => {
    const late = seen(s, [500], { commands: [cmd(3501, ['/usr/bin/open', '-b', 'com.anthropic.claudefordesktop'])] })
    expect(scores(run({ ...open, link: false }, s, late))).toEqual({ front: 1, latency: 0 })
  })
})

describe('state', () => {
  const s = scenario([write, { kind: 'hook', session: 'a', event: 'turn-start', label: 'go' }])
  const state = (want: 'working' | 'needs-you' | 'done' | 'idle', session = 'a'): Check =>
    ({ id: 'st', kind: 'state', dim: 'D4', session, state: want, after: 'go' })
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

  it('an open question holds the row at needs-you through turn cards, until its close, the turn\'s end or a summary', () => {
    const s2 = scenario([write, { kind: 'hook', session: 'a', event: 'needs-input', label: 'go' }])
    const asked = [frame(600, { t: 'question', agentId: id(A), id: 'q' }), frame(600, { t: 'turn.started', agentId: id(A), text: '' })]
    const shown = (frames: Seen['frames'], want: 'working' | 'needs-you' | 'done'): number | undefined =>
      scores(run(state(want), s2, seen(s2, [50, 600], { frames: [...asked, ...frames] }))).shown
    // The list lands after both cards: the row it shows is still asking.
    expect(shown(list(900, 'claude', [A, B, C]), 'needs-you')).toBe(1)
    expect(shown([frame(800, { t: 'question.close', agentId: id(A), id: 'q' }), ...list(900, 'claude', [A, B, C])], 'working')).toBe(1)
    expect(shown([frame(800, { t: 'turn.done', agentId: id(A) }), ...list(900, 'claude', [A, B, C])], 'done')).toBe(1)
    expect(shown([frame(800, { t: 'summary', agentId: id(A), recap: '', text: '' }), ...list(900, 'claude', [A, B, C])], 'done')).toBe(1)
  })

  it('two open questions: the close of one leaves the row asking, the close of both puts it back to working', () => {
    const s2 = scenario([write, { kind: 'hook', session: 'a', event: 'needs-input', label: 'go' }])
    const asked = [frame(600, { t: 'question', agentId: id(A), id: 'q1' }), frame(650, { t: 'question', agentId: id(A), id: 'q2' }),
      frame(700, { t: 'question.close', agentId: id(A), id: 'q1' })]
    const shown = (frames: Seen['frames'], want: 'working' | 'needs-you'): number | undefined =>
      scores(run(state(want), s2, seen(s2, [50, 600], { frames: [...asked, ...frames] }))).shown
    expect(shown(list(900, 'claude', [A, B, C]), 'needs-you')).toBe(1)
    expect(shown(list(900, 'claude', [A, B, C]), 'working')).toBe(0)
    expect(shown([frame(800, { t: 'question.close', agentId: id(A), id: 'q2' }), ...list(900, 'claude', [A, B, C])], 'working')).toBe(1)
  })

  it('a probe on a ghost session fails with the state changes observed in the window', () => {
    const probe = state('working', 'ghost')
    const frames = [...ring, frame(300, { t: 'turn.started', agentId: id(B), text: '' }), frame(800, { t: 'turn.started', agentId: id(A), text: '' })]
    const results = run(probe, s, seen(s, [50, 500], { frames }))
    expect(scores(results).shown).toBe(0)
    // Only what happened after `after`: b's change came before it.
    expect(results.find((r) => r.check === 'st.shown')?.evidence).toEqual(['a working at 800'])
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

  it('a refused voice scores 0 with the dial\'s voice frames in the window and no delivery, never their text', () => {
    const frames = [frame(400, { t: 'voice.error', message: 'Before' }), frame(700, { t: 'voice.error', message: 'Eval refusal' }),
      frame(800, { t: 'voice.transcript', text: 'Eval hello' })]
    const results = run(voice, s, seen(s, [500], { frames }))
    expect(results.map((r) => [r.check, r.score])).toEqual([['v.reached', 0], ['v.once', 0], ['v.exact', 0]])
    expect(results[0]!.evidence).toEqual(['voice.error at 700', 'voice.transcript at 800', 'no delivery'])
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

  it('a probe on a ghost session fails with the summaries observed in the window, never their text', () => {
    const results = run({ ...recap, session: 'ghost' }, s, seen(s, [50, 500], { frames: [summary(400, 'Eval answer'), summary(2100, 'Eval answer')] }))
    expect(results.map((r) => [r.check, r.score, r.evidence])).toEqual([['c.exact', 0, ['summary at 2100 for a']]])
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

it('a delivery belongs to the latest voice step whose words it carries, else to the latest voice step', () => {
  const s = scenario([{ kind: 'voice', transcript: 'Eval to a', target: 'a' }, { kind: 'voice', transcript: 'Eval to b', target: 'b' }])
  const deliveries: Seen['deliveries'] = [
    // a's words, landing after b's step: a's, and right.
    { at: 600, path: 'mod', target: 'a', text: 'Eval to a' },
    { at: 700, path: 'mod', target: 'b', text: 'Eval to b' },
    // Words no step spoke: the latest step's, so they reached the wrong session.
    { at: 800, path: 'mod', target: 'a', text: 'Eval else' },
  ]
  expect(wrongSends(s, seen(s, [100, 500], { deliveries }))).toEqual([{ scenario: 'S1', target: 'b', got: 'a', path: 'mod', at: 800 }])
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
    { id: 's', kind: 'still', dim: 'D2', ms: 1000 },
  ]
  for (const check of checks) {
    const results = run(check, s, seen(s, [50, 500]))
    expect(results.length).toBeGreaterThan(0)
    for (const r of results) expect([r.check, r.score, r.evidence]).toEqual([r.check, 0, []])
  }
})

it('a condition holds once the last whole list since the start is its page\'s, the one expected, in order', () => {
  const s = scenario([write])
  const until: Until = { kind: 'ring', page: 'claude', expect: ['a', 'b'] }
  // From the scenario's start, whatever step has run.
  expect(condition(until, s, seen(s, [], { frames: list(200, 'claude', [A, B]) }))).toEqual({ holds: true, evidence: [
    'list at 200 on claude: 2 rows a b'] })
  expect(condition(until, s, seen(s, [], { frames: list(200, 'claude', [B, A]) })).holds).toBe(false)
  expect(condition(until, s, seen(s, [], { frames: [...list(200, 'claude', [A, B]), ...list(300, 'claude', [A])] })))
    .toEqual({ holds: false, evidence: ['list at 300 on claude: 1 rows a'] })
  expect(condition(until, s, seen(s, []))).toEqual({ holds: false, evidence: [] })
  // The dial moved off the page: the wait goes on.
  expect(condition(until, s, seen(s, [], { frames: [...list(200, 'claude', [A, B]), ...list(300, '', [])] })))
    .toEqual({ holds: false, evidence: ['list at 300 on none, not claude: 0 rows'] })
})

describe('editors', () => {
  const editor = (key: string, n: number, app: 'vscode' | 'cursor', more: Partial<SessionDef> = {}): SessionDef =>
    ({ key, app, id: uuid(n), title: `Eval ${key}`, cwd: `/work/eval-${key}`, ageMs: n * 1000, window: 'w1', ...more })
  const VA = editor('va', 21, 'vscode')
  const VB = editor('vb', 22, 'vscode')
  const VW = editor('vw', 23, 'vscode', { window: 'w2' })
  const VP = editor('vp', 24, 'vscode', { place: 'panel', window: undefined })
  const VX = editor('vx', 25, 'vscode', { engine: 'codex' })
  const CT = editor('ct', 26, 'cursor')
  const CA = editor('ca', 27, 'cursor', { place: 'agent', window: undefined, folders: ['/work/eval-ca-root', '/work/eval-ca-two'] })
  const EGHOST: SessionDef = { ...editor('eghost', 29, 'vscode'), ghost: true }
  const sessions = [VA, VB, VW, VP, VX, CT, CA, EGHOST]
  const W1 = 'eval-w1-1'
  const W2 = 'eval-w2-1'
  type Line = NonNullable<Seen['streams']>[number]
  const opened = (at: number, window: string): Line => ({ at, window, line: { type: 'vscode', window } })
  const state = (at: number, window: string, terminals: string[], active: string | null): Line =>
    ({ at, window, line: { type: 'vscode-state', terminals, active, focused: true } })
  const show = (at: number, window: string, key: string, raise = true): Line =>
    ({ at, window, line: raise ? { show: key, raise: true } : { show: key } })
  const scrolled = (at: number, window: string, pid: string): Line => ({ at, window, line: { scroll: -3, pid } })
  const ended = (at: number, window: string): Line => ({ at, window, line: { ended: 'closed' } })
  /** w1 lists va and vb, vb active; w2 lists vw. */
  const windows: Line[] = [opened(10, W1), state(10, W1, ['va', 'vb'], 'vb'), opened(20, W2), state(20, W2, ['vw'], 'vw')]
  const cmd = (at: number, argv: string[], ok = true): Seen['commands'][number] => ({ at, argv, ok })
  const tapOn = (key: string): Scenario => scenario([{ kind: 'tap', session: key, label: 'go' }], sessions)
  const open = (key: string, link = false): Check => ({ id: 'o', kind: 'open', dim: 'D3', session: key, link, after: 'go' })
  const bring: Readonly<Record<Platform, string[]>> = {
    darwin: ['/usr/bin/open', '-b', 'com.microsoft.VSCode'],
    linux: ['raise', '41000', 'vscode'],
    win32: ['C:\\h\\harness-pty.exe', 'raise', 'com.microsoft.VSCode'],
  }

  describe('open', () => {
    /** What the driver saw, after a push that listed every editor row: only a row the dial was sent can be opened from it. */
    const listed = (s: Scenario, times: number[], parts: Partial<Omit<Seen, 'steps'>> = {}): Seen =>
      seen(s, times, { ...parts, frames: [...list(0, 'vscode', sessions), ...(parts.frames ?? [])] })

    it('a session the dial was never sent as a row fails every part, however its app came forward', () => {
      const ghost: SessionDef = { ...editor('z', 30, 'vscode'), ghost: true }
      const s = scenario([{ kind: 'tap', session: 'va', label: 'go' }], [...sessions, ghost])
      // Another tap brought VS Code forward; z was never listed.
      const never = run(open('z'), s, listed(s, [500], { commands: [cmd(700, bring.darwin)] }))
      expect(scores(never)).toEqual({ front: 0, latency: 0 })
      expect(never[0]!.evidence).toContain('z never listed')
      expect(scores(run(open('vp', true), s, listed(s, [500], { commands: [cmd(700, bring.darwin)] })))).toMatchObject({ front: 1 })
      const unlisted = seen(s, [500], { commands: [cmd(700, bring.darwin)] })
      for (const key of ['va', 'vp', 'ca']) {
        expect(Object.values(scores(run(open(key, key === 'vp'), s, unlisted))).every((score) => score === 0)).toBe(true)
      }
      // A row listed only after the window closed was not there to tap.
      const late: Check = { ...open('va'), at: 'end' }
      const t = scenario([{ kind: 'tap', session: 'va', label: 'go' }, { kind: 'tap', session: 'vb', label: 'end' }], sessions)
      expect(scores(run(late, t, seen(t, [500, 900], { commands: [cmd(700, bring.darwin)], frames: list(1000, 'vscode', sessions) }))))
        .toEqual({ front: 0, latency: 0 })
      // A listed session still scores as before.
      expect(scores(run(late, t, seen(t, [500, 900], { commands: [cmd(700, bring.darwin)], frames: list(100, 'vscode', sessions) }))))
        .toEqual({ front: 1, latency: 1 })
    })

    it('open of a terminal row passes on show with raise on the stream holding its shell and the app brought forward, on each platform', () => {
      const s = tapOn('va')
      for (const platform of ['darwin', 'linux', 'win32'] as const) {
        const results = run(open('va'), s, listed(s, [500], { streams: [...windows, show(600, W1, 'va')], commands: [cmd(700, bring[platform])] }), 'a', platform)
        expect(scores(results)).toEqual({ show: 1, front: 1, latency: 1 })
        expect(ms(results, 'latency')).toBe(200)
        expect(results[0]!.evidence).toEqual(['tap on va at 500', 'command at 700: front', `show at 600 on ${W1}: va raise`])
      }
      // The later of the two: a late front or a late show.
      const late = (showAt: number, frontAt: number): CheckResult[] =>
        run(open('va'), s, listed(s, [500], { streams: [...windows, show(showAt, W1, 'va')], commands: [cmd(frontAt, bring.darwin)] }))
      expect(ms(late(600, 3700), 'latency')).toBe(3200)
      expect(scores(late(600, 3700)).latency).toBe(0)
      expect(scores(late(3400, 700)).latency).toBe(0.5)
      // A show with no raise is a rest's, not a tap's; no show at all fails show and latency.
      expect(scores(run(open('va'), s, listed(s, [500], { streams: [...windows, show(600, W1, 'va', false)], commands: [cmd(700, bring.darwin)] }))))
        .toEqual({ show: 0, front: 1, latency: 0 })
      expect(scores(run(open('va'), s, listed(s, [500], { streams: windows, commands: [cmd(700, bring.darwin)] }))))
        .toEqual({ show: 0, front: 1, latency: 0 })
      // Another editor's bundle is not this one's front.
      expect(scores(run(open('va'), s, listed(s, [500], { streams: [...windows, show(600, W1, 'va')],
        commands: [cmd(700, ['/usr/bin/open', '-b', 'com.todesktop.230313mzl4w4u92'])] })))).toEqual({ show: 1, front: 0, latency: 0 })
    })

    it('a show on another window\'s stream fails it', () => {
      const s = tapOn('va')
      const other = run(open('va'), s, listed(s, [500], { streams: [...windows, show(600, W2, 'va')], commands: [cmd(700, bring.darwin)] }))
      expect(scores(other)).toEqual({ show: 0, front: 1, latency: 0 })
      expect(other[0]!.evidence).toContain(`show at 600 on ${W2}: va raise`)
      // Right on its own stream, but another stream got a show too.
      const both = run(open('va'), s, listed(s, [500], { streams: [...windows, show(600, W1, 'va'), show(650, W2, 'vw')], commands: [cmd(700, bring.darwin)] }))
      expect(scores(both)).toMatchObject({ show: 0, front: 1 })
    })

    it('a shell two windows list is held by the one that reported it last, and an ended stream holds none', () => {
      const s = tapOn('va')
      const showScore = (streams: Line[]): number | undefined =>
        scores(run(open('va'), s, listed(s, [500], { streams, commands: [cmd(700, bring.darwin)] }))).show
      // va moved to w2: w2 reported it last.
      const moved = [...windows, state(30, W2, ['vw', 'va'], 'vw')]
      expect(showScore([...moved, show(600, W2, 'va')])).toBe(1)
      expect(showScore([...moved, show(600, W1, 'va')])).toBe(0)
      // w1's later state wins back.
      expect(showScore([...moved, state(40, W1, ['va', 'vb'], 'vb'), show(600, W1, 'va')])).toBe(1)
      // w2 ended: w1 still lists va.
      expect(showScore([...moved, ended(40, W2), show(600, W1, 'va')])).toBe(1)
      // A reload: the old stream ended, the new one holds it.
      const reloaded = [...windows, ended(30, W1), opened(40, 'eval-w1-2'), state(40, 'eval-w1-2', ['va', 'vb'], 'vb')]
      expect(showScore([...reloaded, show(600, W1, 'va')])).toBe(0)
      expect(showScore([...reloaded, show(600, 'eval-w1-2', 'va')])).toBe(1)
      // Every stream listing it ended: no stream holds it, so VS Code's row is graded on its front alone.
      const gone = run(open('va'), s, listed(s, [500], { streams: [...windows, ended(30, W1)], commands: [cmd(700, bring.darwin)] }))
      expect(scores(gone)).toEqual({ front: 1, latency: 1 })
    })

    it('a terminal row with no stream holding it is graded on VS Code\'s front, and on Cursor\'s folder', () => {
      const v = tapOn('va')
      expect(scores(run(open('va'), v, listed(v, [500], { commands: [cmd(700, bring.darwin)] })))).toEqual({ front: 1, latency: 1 })
      expect(scores(run(open('va'), v, listed(v, [500], { commands: [cmd(3501, bring.darwin)] })))).toEqual({ front: 1, latency: 0 })
      expect(scores(run(open('va'), v, listed(v, [500])))).toEqual({ front: 0, latency: 0 })
      const c = tapOn('ct')
      const folder = (platform: Platform, argv: string[], at = 700): CheckResult[] =>
        run(open('ct'), c, listed(c, [500], { commands: [cmd(at, argv)] }), 'a', platform)
      expect(scores(folder('darwin', ['/usr/bin/open', '-b', 'com.todesktop.230313mzl4w4u92', '/work/eval-ct']))).toEqual({ folder: 1, latency: 1 })
      expect(scores(folder('linux', ['/eval/bin/cursor', '/work/eval-ct']))).toEqual({ folder: 1, latency: 1 })
      expect(folder('linux', ['/eval/bin/cursor', '/work/eval-ct'])[0]!.evidence).toEqual(['tap on ct at 500', 'command at 700: folder'])
      expect(scores(folder('win32', ['C:\\h\\harness-pty.exe', 'cursor-folder', '/work/eval-ct']))).toEqual({ folder: 1, latency: 1 })
      // Cursor brought forward on no folder is not its folder's window.
      expect(scores(folder('darwin', ['/usr/bin/open', '-b', 'com.todesktop.230313mzl4w4u92']))).toEqual({ folder: 0, latency: 0 })
      expect(scores(folder('linux', ['/eval/bin/cursor', '/work/eval-va']))).toEqual({ folder: 0, latency: 0 })
      expect(scores(folder('darwin', ['/usr/bin/open', '-b', 'com.todesktop.230313mzl4w4u92', '/work/eval-ct'], 3500))).toEqual({ folder: 1, latency: 0.5 })
    })

    it('a panel row on its link; Cursor\'s agent on its folder command, folders[0] first', () => {
      const p = tapOn('vp')
      const link = `vscode://anthropic.claude-code/open?session=${VP.id}`
      expect(scores(run(open('vp', true), p, listed(p, [500], { commands: [cmd(700, ['/usr/bin/open', '-b', 'com.microsoft.VSCode', link])] }))))
        .toEqual({ link: 1, front: 1, latency: 1 })
      expect(scores(run(open('vp', true), p, listed(p, [500], { commands: [cmd(700, ['/usr/bin/xdg-open', link])] }), 'a', 'linux')))
        .toEqual({ link: 1, front: 1, latency: 1 })
      expect(scores(run(open('vp', true), p, listed(p, [500], { commands: [cmd(700, ['C:\\h\\harness-pty.exe', 'open-link', link])] }), 'a', 'win32')))
        .toEqual({ link: 1, front: 1, latency: 1 })
      // Another session's link.
      const other = `vscode://anthropic.claude-code/open?session=${VA.id}`
      expect(scores(run(open('vp', true), p, listed(p, [500], { commands: [cmd(700, ['/usr/bin/xdg-open', other])] }), 'a', 'linux')))
        .toEqual({ link: 0, front: 0, latency: 0 })
      const a = tapOn('ca')
      const agent = (argv: string[], at = 700): Record<string, number> => scores(run(open('ca'), a, listed(a, [500], { commands: [cmd(at, argv)] })))
      expect(agent(['/usr/bin/open', '-b', 'com.todesktop.230313mzl4w4u92', '/work/eval-ca-root'])).toEqual({ folder: 1, latency: 1 })
      expect(agent(['/usr/bin/open', '-b', 'com.todesktop.230313mzl4w4u92', '/work/eval-ca'])).toEqual({ folder: 0, latency: 0 })
      expect(agent(['/usr/bin/open', '-b', 'com.todesktop.230313mzl4w4u92', '/work/eval-ca-root'], 4600)).toEqual({ folder: 1, latency: 0 })
      const bare: SessionDef = { ...CA, folders: undefined }
      const b = scenario([{ kind: 'tap', session: 'ca', label: 'go' }], [bare])
      expect(scores(run(open('ca'), b, listed(b, [500], { commands: [cmd(700, ['/usr/bin/open', '-b', 'com.todesktop.230313mzl4w4u92', '/work/eval-ca'])] }))))
        .toEqual({ folder: 1, latency: 1 })
    })
  })

  describe('scroll', () => {
    const s = scenario([{ kind: 'stroke', label: 'go' }], sessions)
    const scroll: Check = { id: 'sc', kind: 'scroll', dim: 'D3', session: 'va', after: 'go' }
    const activeVa: Line[] = [opened(10, W1), state(10, W1, ['va', 'vb'], 'va')]

    it('scroll passes on a line for its shell while active, and fails on lines the window dropped (another terminal active), on lines for another shell, and with nothing seen', () => {
      const ran = run(scroll, s, seen(s, [500], { streams: [...activeVa, scrolled(600, W1, 'va')] }))
      expect(ran.map((r) => [r.check, r.score, r.timed])).toEqual([['sc.ran', 1, false]])
      expect(ran[0]!.evidence).toEqual([`scroll at 600 on ${W1} for va: ran`])
      // vb active: the extension dropped va's line.
      const dropped = run(scroll, s, seen(s, [500], { streams: [...windows, scrolled(600, W1, 'va')], frames: list(0, 'vscode', [VA]) }))
      expect(dropped.map((r) => [r.score, r.evidence])).toEqual([[0, ['stroke at 500', `scroll at 600 on ${W1} for va: dropped`,
        'no scroll line ran for va']]])
      // Lines for another shell, alone or after va's, in its window or another.
      expect(scores(run(scroll, s, seen(s, [500], { streams: [...windows, scrolled(600, W1, 'vb')] }))).ran).toBe(0)
      expect(scores(run(scroll, s, seen(s, [500], { streams: [...activeVa, scrolled(600, W1, 'va'),
        state(700, W1, ['va', 'vb'], 'vb'), scrolled(800, W1, 'vb')] }))).ran).toBe(0)
      expect(scores(run(scroll, s, seen(s, [500], { streams: [...activeVa, scrolled(600, W1, 'va'), opened(650, W2),
        state(650, W2, ['vw'], 'vw'), scrolled(700, W2, 'vw')] }))).ran).toBe(0)
      // A line before the stroke is not its line.
      expect(scores(run(scroll, s, seen(s, [500], { streams: [...activeVa, scrolled(400, W1, 'va')] }))).ran).toBe(0)
      // A window that no longer holds va: it moved to w2, which reported it last.
      expect(scores(run(scroll, s, seen(s, [500], { streams: [...activeVa, opened(20, W2), state(20, W2, ['va'], 'va'),
        scrolled(600, W1, 'va')] }))).ran).toBe(0)
      expect(run(scroll, s, seen(s, [500])).map((r) => [r.score, r.evidence])).toEqual([[0, []]])
    })

    it('a probe on a ghost editor session fails with the strokes and scroll lines observed, and says it was never listed', () => {
      const probe: Check = { ...scroll, session: 'eghost' }
      const results = run(probe, s, seen(s, [500], { streams: [...activeVa, scrolled(600, W1, 'va')] }))
      expect(results.map((r) => [r.score, r.evidence])).toEqual([[0, ['eghost never listed', 'stroke at 500',
        `scroll at 600 on ${W1} for va: ran`, 'no scroll line ran for eghost']]])
    })

    it('a probe on a ghost whose stroke scrolled nothing still says why, so the runner counts it caught', () => {
      const probe: Check = { ...scroll, session: 'eghost' }
      // The stroke ran no scroll line: only a frame was seen in its window.
      const results = run(probe, s, seen(s, [500], { streams: activeVa, frames: list(600, 'vscode', [VA]) }))
      expect(results.map((r) => [r.score, r.evidence])).toEqual([[0, ['eghost never listed', 'stroke at 500', 'no scroll line ran for eghost']]])
      // A listed session that scrolled nothing is not said to be unlisted.
      expect(run(scroll, s, seen(s, [500], { streams: windows, frames: list(600, 'vscode', [VA]) }))[0]!.evidence)
        .toEqual(['stroke at 500', 'no scroll line ran for va'])
    })
  })

  describe('logged', () => {
    const s = scenario([{ kind: 'stroke', label: 'go' }], sessions)
    const logged: Check = { id: 'lg', kind: 'logged', dim: 'D7', after: 'go' }
    const log = (at: number, line: string): NonNullable<Seen['logs']>[number] => ({ at, line })

    it('logged passes on a skipped line with a reason, fails on a bare prefix and with no line', () => {
      const pass = run(logged, s, seen(s, [500], { logs: [log(600, '[device] scroll · skipped · no stream')] }))
      expect(pass.map((r) => [r.check, r.score, r.timed, r.evidence])).toEqual([['lg', 1, false, ['log at 600: [device] scroll · skipped · no stream']]])
      expect(scores(run(logged, s, seen(s, [500], { logs: [log(600, '[device] scroll · skipped · ')] }))).lg).toBe(0)
      expect(scores(run(logged, s, seen(s, [500], { logs: [log(600, '[device] scroll · skipped ·  ')] }))).lg).toBe(0)
      expect(scores(run(logged, s, seen(s, [500], { logs: [log(400, '[device] scroll · skipped · no stream')] }))).lg).toBe(0)
      expect(run(logged, s, seen(s, [500], { logs: [log(600, '[device] tap · ok')] })).map((r) => [r.score, r.evidence])).toEqual([[0, []]])
      expect(run(logged, s, seen(s, [500])).map((r) => [r.score, r.evidence])).toEqual([[0, []]])
    })

    it('logged\'s evidence keeps the tag and the plain words that lead its reason, never a path, a title, a folder or a number', () => {
      const evidence = (line: string): string[] => run(logged, s, seen(s, [500], { logs: [log(600, line)] }))[0]!.evidence
      expect(evidence('2026-11-22T10:00:01Z [device] scroll · skipped · no stream for 41234 in /work/eval-va (C:\\Users\\eval\\x)'))
        .toEqual(['log at 600: [device] scroll · skipped · no stream for <…>'])
      expect(evidence('[device] scroll · skipped · no app at /Applications/Visual Studio Code.app/Contents/MacOS/Electron'))
        .toEqual(['log at 600: [device] scroll · skipped · no app at <…>'])
      expect(evidence('[device] scroll · skipped · no terminal for eval-a (Eval Alpha) pid 7'))
        .toEqual(['log at 600: [device] scroll · skipped · no terminal for <…>'])
      expect(evidence('[device] scroll · skipped · C:\\Program Files\\Microsoft VS Code\\Code.exe gone'))
        .toEqual(['log at 600: [device] scroll · skipped · <…>'])
      // With no skipped line, the scroll lines seen, made as bare.
      const sent = run(logged, s, seen(s, [500], { logs: [log(600, 'x [device] scroll · sent · 41234 /work/eval-va')] }))
      expect(sent.map((r) => [r.score, r.evidence])).toEqual([[0, ['log at 600: [device] scroll · sent · <…>']]])
    })
  })

  it('a driver that saw nothing catches neither an open probe on a row never listed nor a ring probe apart: their evidence is empty', () => {
    const ghost: SessionDef = { ...editor('z', 30, 'vscode'), ghost: true }
    const s = scenario([{ kind: 'tap', session: 'va', label: 'go' }], [...sessions, ghost])
    // The steps alone, as every driver records them.
    const blind = seen(s, [500])
    const probes = [
      ...run({ id: 'open', kind: 'open', dim: 'D3', session: 'z', link: false, after: 'go' }, s, blind),
      ...run({ id: 'apart', kind: 'ring', dim: 'D1', page: 'vscode', expect: ['va'], apart: ['z'], after: 'go' }, s, blind),
    ]
    expect(probes.flatMap((r) => r.evidence)).toEqual([])
    expect(uncaughtProbes({ scenario: 'S1', platform: 'darwin', results: [], probes, wrongSends: [], gaps: [] })).toEqual(['open', 'apart'])
  })

  it("an editor's session apart is counted on its own app's page: under Terminal, or on its ring's own page, it is not", () => {
    const s = scenario([{ kind: 'hook', session: 'va', event: 'start', label: 'w' }], sessions)
    const check: Check = { id: 'r', kind: 'ring', dim: 'D1', page: 'cursor', expect: ['ct'], apart: ['va'], after: 'w' }
    const apart = (others: Array<[string, number]>): number => run(check, s, seen(s, [100], { frames: [frame(200, { t: 'apps', shown: 'cursor',
      apps: [{ id: 'cursor', count: 1 }, ...others.map(([id, count]) => ({ id, count }))] }), ...list(200, 'cursor', [CT]).slice(1)] }))
      .find((r) => r.check === 'r.apart')!.score
    expect(apart([['vscode', 1]])).toBe(1)
    expect(apart([['terminal-app', 1]])).toBe(0)
    expect(apart([['vscode', 1], ['terminal-app', 1]])).toBe(0)
    expect(apart([])).toBe(0)
    // A Cursor session apart from Cursor's own page is nowhere it can be.
    expect(scores(run({ ...check, apart: ['ct'], expect: [] }, s, seen(s, [100], { frames: [frame(200, { t: 'apps', shown: 'cursor',
      apps: [{ id: 'cursor', count: 1 }, { id: 'vscode', count: 1 }] })] }))).apart).toBe(0)
  })

  it('apart with no apps frame held scores 0 on every page, saying so', () => {
    const s = scenario([{ kind: 'hook', session: 'va', event: 'start', label: 'w' }], sessions)
    const ring = (page: 'vscode' | 'cursor', expect: string[]): Check => ({ id: 'r', kind: 'ring', dim: 'D1', page, expect, apart: [], after: 'w' })
    // A whole ring with no apps frame before it.
    const bare = (page: string, rows: Row[]): Seen['frames'] => list(200, page, rows).slice(1)
    for (const [page, row] of [['vscode', VA], ['cursor', CT]] as const) {
      const apart = run(ring(page, [row.key]), s, seen(s, [100], { frames: bare(page, [row]) })).find((r) => r.check === 'r.apart')!
      expect([apart.score, apart.evidence]).toEqual([0, ['no apps frame']])
      expect(run(ring(page, [row.key]), s, seen(s, [100], { frames: list(200, page, [row]) })).find((r) => r.check === 'r.apart')!.score).toBe(1)
    }
    const b = scenario([write])
    const base: Check = { id: 'r', kind: 'ring', dim: 'D1', page: 'claude', expect: ['a'], apart: [], after: 'w' }
    const apart = run(base, b, seen(b, [100], { frames: bare('claude', [A]) })).find((r) => r.check === 'r.apart')!
    expect([apart.score, apart.evidence]).toEqual([0, ['no apps frame']])
  })

  it('a Codex or Cursor row\'s expected name is its folder\'s, a Claude Code row\'s its title', () => {
    const s = scenario([{ kind: 'hook', session: 'va', event: 'start', label: 'w' }], sessions)
    const ring = (page: 'vscode' | 'cursor', expect: string[]): Check => ({ id: 'r', kind: 'ring', dim: 'D1', page, expect, after: 'w' })
    expect(scores(run(ring('vscode', ['va', 'vx']), s, seen(s, [100], { frames: list(200, 'vscode', [VA, [id(VX), 'eval-vx']]) }))).names).toBe(1)
    expect(scores(run(ring('vscode', ['va', 'vx']), s, seen(s, [100], { frames: list(200, 'vscode', [VA, VX]) }))).names).toBe(0.5)
    expect(scores(run(ring('vscode', ['va']), s, seen(s, [100], { frames: list(200, 'vscode', [[id(VA), 'eval-va']]) }))).names).toBe(0)
    expect(scores(run(ring('cursor', ['ca']), s, seen(s, [100], { frames: list(200, 'cursor', [CA]) }))).names).toBe(0)
  })

  it('a Cursor agent in a multi-root workspace is named by its first root, as its hook sends it, in a check and a wait alike', () => {
    const s = scenario([{ kind: 'hook', session: 'ca', event: 'start', label: 'w' }], sessions)
    const ring: Check = { id: 'r', kind: 'ring', dim: 'D1', page: 'cursor', expect: ['ca'], after: 'w' }
    expect(scores(run(ring, s, seen(s, [100], { frames: list(200, 'cursor', [[id(CA), 'eval-ca-root']]) }))).names).toBe(1)
    expect(scores(run(ring, s, seen(s, [100], { frames: list(200, 'cursor', [[id(CA), 'eval-ca']]) }))).names).toBe(0)
    const until: Until = { kind: 'ring', page: 'cursor', expect: ['ca'] }
    expect(condition(until, s, seen(s, [], { frames: list(200, 'cursor', [[id(CA), 'eval-ca-root']]) })).holds).toBe(true)
    // No folders: the cwd is the root.
    const bare = scenario([{ kind: 'hook', session: 'ca', event: 'start', label: 'w' }], [...sessions.filter((x) => x !== CA), { ...CA, folders: undefined }])
    expect(scores(run(ring, bare, seen(bare, [100], { frames: list(200, 'cursor', [[id(CA), 'eval-ca']]) }))).names).toBe(1)
  })
})

it('the base apps\' checks score as before: a Codex CLI thread is named by its title, and an open is graded on link and front', () => {
  const X: SessionDef = { ...thread('x', 13), cli: true }
  const s = scenario([{ kind: 'codex.write', sessions: ['t', 'x'], label: 'w' }, { kind: 'tap', session: 't', label: 'go' }], [T, X])
  const ring: Check = { id: 'r', kind: 'ring', dim: 'D1', page: 'chatgpt', expect: ['t', 'x'], after: 'w', at: 'go' }
  expect(scores(run(ring, s, seen(s, [100, 500], { frames: list(200, 'codex', [T, X]) })))).toEqual(
    { recall: 1, precision: 1, order: 1, names: 1, cap: 1, archived: 1 })
  const open: Check = { id: 'o', kind: 'open', dim: 'D3', session: 't', link: true, after: 'go' }
  const results = run(open, s, seen(s, [100, 500], { commands: [{ at: 700, argv: ['/usr/bin/open', '-b', 'com.openai.codex', `codex://threads/${T.id}`], ok: true }] }))
  expect(scores(results)).toEqual({ link: 1, front: 1, latency: 1 })
  expect(results[0]!.evidence).toEqual(['tap on t at 500', 'command at 700: link front'])
})

describe('Orca', () => {
  const orca = (key: string, n: number, more: Partial<SessionDef> = {}): SessionDef => {
    const worktree = more.worktree ?? 'w1'
    return { key, app: 'orca', id: uuid(n), title: `Eval ${key}`, cwd: `/work/eval-${worktree}`, ageMs: n * 1000, worktree, tab: 0, ...more }
  }
  const OA = orca('oa', 41)
  const OB = orca('ob', 42, { worktree: 'w2', tab: 1 })
  const OZ: SessionDef = { ...orca('oz', 49), ghost: true }
  const sessions = [OA, OB, OZ]
  const cmd = (at: number, argv: string[], ok = true): Seen['commands'][number] => ({ at, argv, ok })
  /** Orca's CLI as each platform finds it (Decision 6). */
  const CLI: Readonly<Record<Platform, string>> = {
    darwin: '/eval/Orca.app/Contents/Resources/bin/orca',
    linux: '/opt/eval/orca/resources/bin/orca-ide',
    win32: 'C:\\Users\\eval\\AppData\\Local\\Programs\\orca\\resources\\bin\\orca.exe',
  }
  const activate = (at: number, worktree: string, platform: Platform = 'darwin'): Seen['commands'][number] =>
    cmd(at, [CLI[platform], 'worktree', 'activate', '--worktree', `id:${orcaWorktreeId(worktree)}`, '--json'])
  const switchTo = (at: number, handle: string, ok = true, platform: Platform = 'darwin'): Seen['commands'][number] =>
    cmd(at, [CLI[platform], 'terminal', 'switch', '--terminal', handle, '--json'], ok)
  /** Orca brought forward, as the devices run it on each platform (tier A's records). */
  const RAISE: Readonly<Record<Platform, string[]>> = {
    darwin: ['/usr/bin/open', '-b', 'com.stablyai.orca'],
    linux: ['raise', '--app', 'orca', '--pid', '41000'],
    win32: ['C:\\h\\harness-pty.exe', 'raise', 'com.stablyai.orca'],
  }
  const handle = (s: SessionDef, launch = 0): string => orcaPaneHandle(s, launch)
  const input = (kind: 'tap' | 'swipe', key = 'oa'): Scenario => scenario([{ kind, session: key, label: 'go' }], sessions)
  const open: Check = { id: 'o', kind: 'open', dim: 'D3', session: 'oa', link: false, after: 'go' }
  /** What the driver saw after a push that listed every Orca row. */
  const listed = (s: Scenario, times: number[], parts: Partial<Omit<Seen, 'steps'>> = {}): Seen =>
    seen(s, times, { ...parts, frames: [...list(0, 'orca', [OA, OB]), ...(parts.frames ?? [])] })

  describe('open', () => {
    it('a tap on an Orca row passes on its worktree\'s activate, its handle\'s switch, then Orca\'s raise, on each platform', () => {
      const s = input('tap')
      for (const platform of ['darwin', 'linux', 'win32'] as const) {
        const commands = [activate(600, 'w1', platform), switchTo(700, handle(OA), true, platform), cmd(800, RAISE[platform])]
        const results = run(open, s, listed(s, [500], { commands }), 'a', platform)
        expect(scores(results)).toEqual({ worktree: 1, switch: 1, raise: 1, latency: 1 })
        expect(ms(results, 'latency')).toBe(300)
        expect(results[0]!.evidence).toEqual(['tap on oa at 500', 'command at 600: worktree', 'command at 700: switch oa',
          'command at 800: front'])
      }
      const late = (at: number): CheckResult[] =>
        run(open, s, listed(s, [500], { commands: [switchTo(700, handle(OA)), cmd(at, RAISE.darwin)] }))
      expect(scores(late(3500)).latency).toBe(0.5)
      expect(scores(late(3501)).latency).toBe(0)
      expect(ms(late(3501), 'latency')).toBe(3001)
      // Another app brought forward is not Orca's raise.
      expect(scores(run(open, s, listed(s, [500], { commands: [switchTo(700, handle(OA)), cmd(800, ['/usr/bin/open', '-b', 'com.microsoft.VSCode'])] }))))
        .toEqual({ worktree: 1, switch: 1, raise: 0, latency: 0 })
    })

    it('an activate of another worktree before the switch fails worktree, and none passes it', () => {
      const s = input('tap')
      const worktree = (commands: Seen['commands']): number | undefined =>
        scores(run(open, s, listed(s, [500], { commands: [...commands, switchTo(700, handle(OA)), cmd(800, RAISE.darwin)] }))).worktree
      expect(worktree([activate(600, 'w2')])).toBe(0)
      expect(worktree([activate(600, 'w1'), activate(650, 'w2')])).toBe(0)
      expect(worktree([activate(600, 'w2'), activate(650, 'w1')])).toBe(1)
      expect(worktree([])).toBe(1)
      // An activate after the switch is not the one that showed the pane.
      expect(scores(run(open, s, listed(s, [500], { commands: [activate(600, 'w1'), switchTo(700, handle(OA)), activate(750, 'w2'),
        cmd(800, RAISE.darwin)] }))).worktree).toBe(1)
    })

    it('a switch of another handle fails switch, and a raise before the switch fails raise', () => {
      const s = input('tap')
      const other = run(open, s, listed(s, [500], { commands: [switchTo(700, handle(OB)), cmd(800, RAISE.darwin)] }))
      expect(scores(other)).toMatchObject({ switch: 0, raise: 0, latency: 0 })
      expect(other[0]!.evidence).toEqual(['tap on oa at 500', 'command at 700: switch ob', 'command at 800: front'])
      // A handle no session owns, and a switch that failed.
      expect(run(open, s, listed(s, [500], { commands: [switchTo(700, 'term_00000000-0000-4000-8d00-0000000000ff')] }))[0]!.evidence)
        .toEqual(['tap on oa at 500', 'command at 700: switch other'])
      const failed = run(open, s, listed(s, [500], { commands: [switchTo(700, handle(OA), false), cmd(800, RAISE.darwin)] }))
      expect(scores(failed)).toMatchObject({ switch: 0, raise: 0 })
      expect(failed[0]!.evidence).toContain('command at 700: switch oa failed')
      // Brought forward first, then switched: Orca came up on whatever pane it had.
      const early = run(open, s, listed(s, [500], { commands: [cmd(600, RAISE.darwin), switchTo(700, handle(OA))] }))
      expect(scores(early)).toEqual({ worktree: 1, switch: 1, raise: 0, latency: 0 })
      expect(ms(early, 'latency')).toBeNull()
      // Tier A's order is exact, even at one virtual ms; tier B reads a raise in its switch's read as after it (Decision 14).
      const together = [cmd(700, RAISE.darwin), switchTo(700, handle(OA))]
      expect(scores(run(open, s, listed(s, [500], { commands: together }))).raise).toBe(0)
      expect(scores(run(open, s, listed(s, [500], { commands: together }), 'b'))).toEqual({ worktree: 1, switch: 1, raise: 1, latency: 1 })
    })

    it('a rest passes on its switch with no raise and fails on a raise; it has no latency part', () => {
      const s = input('swipe')
      for (const platform of ['darwin', 'linux', 'win32'] as const) {
        const rest = run(open, s, listed(s, [500], { commands: [activate(600, 'w1', platform), switchTo(700, handle(OA), true, platform)] }), 'a', platform)
        expect(scores(rest)).toEqual({ worktree: 1, switch: 1, noRaise: 1 })
        expect(rest.every((r) => !r.timed)).toBe(true)
        expect(rest[0]!.evidence).toEqual(['swipe on oa at 500', 'command at 600: worktree', 'command at 700: switch oa'])
        const raised = run(open, s, listed(s, [500], { commands: [switchTo(700, handle(OA), true, platform), cmd(800, RAISE[platform])] }), 'a', platform)
        expect(scores(raised)).toEqual({ worktree: 1, switch: 1, noRaise: 0 })
      }
    })

    it('after a relaunch the switch must name the session\'s next handle', () => {
      const s = scenario([{ kind: 'relaunch', app: 'orca' }, { kind: 'tap', session: 'oa', label: 'go' }], sessions)
      const switched = (h: string): Record<string, number> =>
        scores(run(open, s, listed(s, [100, 500], { commands: [switchTo(700, h), cmd(800, RAISE.darwin)] })))
      expect(switched(handle(OA, 1))).toEqual({ worktree: 1, switch: 1, raise: 1, latency: 1 })
      expect(switched(handle(OA, 0))).toEqual({ worktree: 1, switch: 0, raise: 0, latency: 0 })
      // The old handle is no session's now.
      expect(run(open, s, listed(s, [100, 500], { commands: [switchTo(700, handle(OA, 0))] }))[0]!.evidence)
        .toEqual(['tap on oa at 500', 'command at 700: switch other'])
      // A relaunch of another app moves no Orca handle.
      const other = scenario([{ kind: 'relaunch', app: 'claude' }, { kind: 'tap', session: 'oa', label: 'go' }], sessions)
      expect(scores(run(open, other, listed(other, [100, 500], { commands: [switchTo(700, handle(OA)), cmd(800, RAISE.darwin)] }))).switch).toBe(1)
    })

    it('a tap in tier B on Linux has no raise and no latency part', () => {
      const s = input('tap')
      const commands = [activate(600, 'w1', 'linux'), switchTo(700, handle(OA), true, 'linux')]
      expect(scores(run(open, s, listed(s, [500], { commands }), 'b', 'linux'))).toEqual({ worktree: 1, switch: 1 })
      expect(scores(run(open, s, listed(s, [500], { commands }), 'a', 'linux'))).toEqual({ worktree: 1, switch: 1, raise: 0, latency: 0 })
      expect(scores(run(open, s, listed(s, [500], { commands: [...commands, cmd(800, RAISE.darwin)] }), 'b', 'darwin')))
        .toEqual({ worktree: 1, switch: 1, raise: 1, latency: 1 })
    })

    it('an Orca row the dial was never sent scores 0 on every part', () => {
      const commands = [activate(600, 'w1'), switchTo(700, handle(OZ)), cmd(800, RAISE.darwin)]
      for (const kind of ['tap', 'swipe'] as const) {
        const s = input(kind, 'oz')
        const never = run({ ...open, session: 'oz' }, s, listed(s, [500], { commands }))
        expect(never.length).toBeGreaterThan(0)
        for (const r of never) expect(r.score).toBe(0)
        expect(never[0]!.evidence).toContain('oz never listed')
      }
      // A row listed only after the window closed was not there to tap.
      const t = scenario([{ kind: 'tap', session: 'oa', label: 'go' }, { kind: 'tap', session: 'ob', label: 'end' }], sessions)
      const late = run({ ...open, at: 'end' }, t, seen(t, [500, 900], { commands: [switchTo(700, handle(OA)), cmd(800, RAISE.darwin)],
        frames: list(1000, 'orca', [OA, OB]) }))
      expect(scores(late)).toEqual({ worktree: 0, switch: 0, raise: 0, latency: 0 })
      // A driver that saw nothing says nothing.
      const s = input('tap', 'oz')
      expect(run({ ...open, session: 'oz' }, s, seen(s, [500])).flatMap((r) => r.evidence)).toEqual([])
    })
  })

  describe('face', () => {
    const s = input('tap')
    const check: Check = { id: 'f', kind: 'face', dim: 'D2', after: 'go' }
    const tiles = [id(OA), id(OB)]
    const at = (when: number, active: SessionDef | null, refused = 0, held = tiles): Seen['faces'][number] =>
      ({ at: when, page: 'orca', tiles: held, active: active && id(active), refused })
    const face = (faces: Seen['faces'], c: Check = check): CheckResult[] => run(c, s, seen(s, [500], { faces }))

    it('face passes with no refusal and a face on a tile whenever tiles are held, from its label on', () => {
      // Before its label the carousel refused and held tiles with none on the face: that is not this check's.
      const results = face([at(100, null, 1), at(200, OA, 2), at(600, OB, 2), at(700, OA, 2)])
      expect(results.map((r) => [r.check, r.score, r.timed])).toEqual([['f.face', 1, false]])
      expect(results[0]!.evidence).toEqual(['face at 700: oa, 2 tiles, refused 2'])
      expect(face([at(600, OA)], { ...check, dim: 'D7' }).map((r) => [r.check, r.score])).toEqual([['f', 1]])
    })

    it('face fails on a refusal after its label, on tiles held with none on the face, and with no face seen', () => {
      const refused = face([at(200, OA, 2), at(600, OB, 3), at(700, OA, 3)])
      expect(scores(refused).face).toBe(0)
      expect(refused[0]!.evidence).toEqual(['face at 600: ob, 2 tiles, refused 3', 'face at 700: oa, 2 tiles, refused 3'])
      const none = face([at(200, OA), at(600, null)])
      expect(scores(none).face).toBe(0)
      expect(none[0]!.evidence).toEqual(['face at 600: none, 2 tiles, refused 0'])
      // The face held as the label runs is shown from it on.
      expect(scores(face([at(200, null), at(900, OA)])).face).toBe(0)
      expect(face([]).map((r) => [r.score, r.evidence])).toEqual([[0, []]])
      expect(face([at(600, OB, 1)], { ...check, dim: 'D7' }).map((r) => [r.check, r.score])).toEqual([['f', 0]])
      // A window that never opened saw no face.
      expect(scores(face([at(600, OA)], { ...check, after: 'never' })).face).toBe(0)
    })

    it('a face with no tiles and none on it passes', () => {
      expect(scores(face([at(200, OA), at(600, null, 0, [])])).face).toBe(1)
    })
  })

  it('an Orca row\'s expected name is its tab\'s rename, else Claude Code\'s own title, else its tab\'s title', () => {
    const OC = orca('oc', 51, { worktree: 'w2', tab: 0, split: 1 })
    const OD = orca('od', 52, { worktree: 'w2', tab: 0, split: 0, engine: 'codex' })
    const OW = orca('ow', 53, { tab: 1, split: 0, engine: 'codex' })
    const OX = orca('ox', 54, { tab: 1, split: 1, engine: 'codex' })
    const OF = orca('of', 55, { worktree: 'w3', engine: 'codex' })
    const named = [OA, OC, OD, OW, OX, OF]
    const t = scenario([{ kind: 'orca.layout', worktrees: ['w1', 'w2'], renamed: { od: 'Eval   tab renamed ' }, label: 'w' },
      { kind: 'orca.layout', worktrees: ['w1', 'w2'], label: 'later' }], named)
    const ring = (at?: string): Check => ({ id: 'r', kind: 'ring', dim: 'D1', page: 'orca', expect: named.map((x) => x.key), after: 'w',
      ...(at === undefined ? {} : { at }) })
    const right: Row[] = [OA, [id(OC), 'Eval tab renamed'], [id(OD), 'Eval tab renamed'], OW, [id(OX), OW.title], [id(OF), 'eval-w3']]
    // The rename of a tab names every pane in it, Claude Code's too; a Codex pane is named by its tab's lowest split; a
    // session in no worktree Orca lists by its folder.
    expect(scores(run(ring('later'), t, seen(t, [100, 2000], { frames: list(200, 'orca', right) }))).names).toBe(1)
    expect(scores(run(ring('later'), t, seen(t, [100, 2000], { frames: list(200, 'orca', named) }))).names).toBe(2 / 6)
    // Once the rename is gone the tab is titled by its lowest split again: Claude Code's by its own title.
    const after: Row[] = [OA, OC, OD, OW, [id(OX), OW.title], [id(OF), 'eval-w3']]
    expect(scores(run(ring(), t, seen(t, [100, 2000], { frames: list(2100, 'orca', after) }))).names).toBe(1)
    expect(condition({ kind: 'ring', page: 'orca', expect: named.map((x) => x.key) }, t, seen(t, [100, 2000], { frames: list(2100, 'orca', after) })).holds)
      .toBe(true)
  })

  it('no evidence holds a handle or a worktree id', () => {
    const t = scenario([{ kind: 'relaunch', app: 'orca' }, { kind: 'tap', session: 'oa', label: 'go' }], sessions)
    const commands = [activate(600, 'w2'), switchTo(650, handle(OA, 0)), switchTo(700, handle(OA, 1), false), switchTo(750, handle(OB, 1)),
      cmd(760, [CLI.darwin, 'terminal', 'send', '--terminal', handle(OA, 1), '--text=Eval words', '--enter', '--json']),
      cmd(800, RAISE.darwin), cmd(900, ['/eval/other', '/work/eval-w1'])]
    const results = [
      ...run(open, t, listed(t, [100, 500], { commands })),
      ...run({ ...open, session: 'oz' }, t, listed(t, [100, 500], { commands })),
      ...run({ id: 'f', kind: 'face', dim: 'D2', after: 'go' }, t, seen(t, [100, 500], { faces: [{ at: 600, page: 'orca', tiles: [id(OA)], active: null, refused: 1 }] })),
    ]
    const lines = results.flatMap((r) => r.evidence)
    expect(lines).toContain('command at 760: send')
    expect(lines).toContain('command at 900: other')
    for (const line of lines) expect(line).not.toMatch(/term_|eval-repo|\/work\/|Eval|orca\b|[0-9a-f]{8}-/)
  })
})
