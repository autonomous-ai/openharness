import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { claudeGhost, claudeSessions, HELD_OUT, listed, MAIN, scenario } from './catalog.js'
import { evaluate } from './checks.js'
import { BASELINE_PATH, droppedKeys, grade, loadBaseline, RACED_B, tierAVerdict, tierBVerdict, updateBaseline } from './grade.js'
import type { Baseline, CheckResult, CoverageGap, Platform, RunResults, WrongSend } from './types.js'

function result(over: Partial<CheckResult> & Pick<CheckResult, 'check' | 'dim' | 'score'>): CheckResult {
  return { tier: 'a', platform: 'darwin', scenario: 'C1', app: 'claude', heldOut: false, timed: false, evidence: [], ...over }
}

function run(results: CheckResult[], more: { wrongSends?: WrongSend[]; gaps?: CoverageGap[] } = {}): RunResults {
  return { schema: 1, results, wrongSends: more.wrongSends ?? [], gaps: more.gaps ?? [] }
}

function baseline(checks: Record<string, number>, apps: Baseline['apps'] = {}): Baseline {
  return { schema: 1, checks, apps }
}

const wrongSend: WrongSend = { tier: 'b', platform: 'darwin', scenario: 'C5', target: 'a', got: 'b', path: 'mod', at: 1200 }

// D1 [1, 0] and D5 [0]: with no D8 the weights are D1 15 and D5 25 of 40.
const mixed = [
  result({ check: 'ring.recall', dim: 'D1', score: 1 }),
  result({ check: 'ring.order', dim: 'D1', score: 0, evidence: ['row 2 at index 0'] }),
  result({ scenario: 'C5', check: 'voice.reached', dim: 'D5', score: 0, evidence: ['no delivery'] }),
]

describe('scores', () => {
  it('an app\'s score is the weighted mean of its dimensions, renormalised without D8', () => {
    const report = grade(run(mixed), null)
    expect(report.apps.claude.score).toBe(18.75)
    expect(report.apps.claude.dims).toEqual({ D1: 50, D2: null, D3: null, D4: null, D5: 0, D6: null, D7: null, D8: null })
    expect(report.apps.chatgpt).toEqual({ score: null, dims: expect.objectContaining({ D1: null, D5: null }), leftOut: 0 })
  })

  it('points lost: D1\'s failing check 18.75 and D5\'s 62.5, summing to 100 − score', () => {
    const report = grade(run(mixed), null)
    expect(report.failing.map((r) => [r.check, r.pointsLost])).toEqual([['voice.reached', 62.5], ['ring.order', 18.75]])
    expect(report.failing[0]!.evidence).toEqual(['no delivery'])
    expect(report.groups).toEqual([
      { app: 'claude', dim: 'D5', scenario: 'C5', pointsLost: 62.5, checks: ['a/darwin/C5/voice.reached'] },
      { app: 'claude', dim: 'D1', scenario: 'C1', pointsLost: 18.75, checks: ['a/darwin/C1/ring.order'] },
    ])
    const lost = report.failing.reduce((sum, r) => sum + r.pointsLost, 0)
    expect(lost).toBe(100 - report.apps.claude.score!)
  })

  it('a wait that held scores nothing, in the headline, a subset or points lost; one that missed costs its dimension', () => {
    // A held wait is the harness's own readiness, kept only so tier A's exact baseline sees one that stops holding.
    const held = result({ check: 'wait.1', dim: 'D5', score: 1, timed: true })
    const report = grade(run([...mixed, held]), null)
    expect(report.apps.claude.score).toBe(18.75)
    expect(report.apps.claude.dims.D5).toBe(0)
    expect(report.byTier.a.claude.score).toBe(18.75)
    expect(report.delta.apps.a!.claude.after).toBe(18.75)
    expect(report.failing.map((r) => [r.check, r.pointsLost])).toEqual([['voice.reached', 62.5], ['ring.order', 18.75]])
    expect(updateBaseline(null, run([...mixed, held]), ['a'])).toMatchObject({
      checks: { 'a/darwin/C1/wait.1': 1 }, apps: { a: { claude: 18.75 } },
    })
    const missed = grade(run([...mixed, { ...held, score: 0 }]), null)
    expect(missed.apps.claude.dims.D5).toBe(0)
    expect(missed.failing.map((r) => r.check)).toContain('wait.1')
  })

  it('held-out results are scored apart and never in the headline', () => {
    const report = grade(run([
      result({ check: 'ring.recall', dim: 'D1', score: 1 }),
      result({ scenario: 'CH1', heldOut: true, check: 'ring.recall', dim: 'D1', score: 0 }),
    ]), null)
    expect(report.apps.claude.score).toBe(100)
    expect(report.heldOut.claude.score).toBe(0)
    expect(report.byTier.a.claude.score).toBe(100)
    expect(report.byPlatform['a/darwin']!.claude.score).toBe(100)
    expect(report.failing).toEqual([])
    expect(report.groups).toEqual([])
  })

  it('the report names no held-out check or gap: the delta counts the changed ones', () => {
    const report = grade(run([
      result({ check: 'ring.recall', dim: 'D1', score: 1 }),
      result({ scenario: 'CH1', heldOut: true, check: 'ring.recall', dim: 'D1', score: 0 }),
    ], { gaps: [{ tier: 'a', platform: 'linux', scenario: 'CH2', app: 'claude', heldOut: true, reason: 'a platform read' }] }),
    baseline({ 'a/darwin/C1/ring.recall': 0, 'a/darwin/CH1/ring.recall': 1, 'a/darwin/CH1/ring.order': 1 }))
    expect(report.delta.checks).toEqual([{ key: 'a/darwin/C1/ring.recall', before: 0, after: 1 }])
    expect(report.delta.heldOutChanged).toBe(2)
    expect(report.gaps).toEqual([])
    expect(report.heldOut.claude.leftOut).toBe(1)
  })

  it('byTier and byPlatform score each subset of the main set', () => {
    const report = grade(run([
      result({ check: 'ring.recall', dim: 'D1', score: 1 }),
      result({ platform: 'linux', check: 'ring.recall', dim: 'D1', score: 0.5 }),
      result({ tier: 'b', check: 'ring.recall', dim: 'D1', score: 0 }),
    ]), null)
    expect(report.apps.claude.score).toBe(50)
    expect(report.byTier.a.claude.score).toBe(75)
    expect(report.byTier.b.claude.score).toBe(0)
    expect(Object.keys(report.byPlatform).sort()).toEqual(['a/darwin', 'a/linux', 'b/darwin'])
    expect(report.byPlatform['a/linux']!.claude.score).toBe(50)
  })

  it('a gap\'s run is in no score, and each app\'s leftOut counts its runs left out once each', () => {
    const report = grade(run([
      result({ check: 'ring.recall', dim: 'D1', score: 1 }),
      result({ scenario: 'X2', app: 'chatgpt', check: 'ring.recall', dim: 'D1', score: 0 }),
      result({ scenario: 'X2', app: 'chatgpt', platform: 'linux', check: 'ring.recall', dim: 'D1', score: 1 }),
    ], {
      gaps: [
        { tier: 'a', platform: 'darwin', scenario: 'X2', app: 'chatgpt', heldOut: false, reason: 'reads process.platform in windowTitle' },
        { tier: 'a', platform: 'darwin', scenario: 'X2', app: 'chatgpt', heldOut: false, reason: 'reads process.platform in openLink' },
      ],
    }), null)
    expect(report.apps.chatgpt.score).toBe(100)
    expect(report.apps.chatgpt.leftOut).toBe(1)
    expect(report.apps.claude.leftOut).toBe(0)
    expect(report.byTier.a.chatgpt.leftOut).toBe(1)
    expect(report.byPlatform['a/darwin']!.chatgpt.leftOut).toBe(1)
    expect(report.byPlatform['a/linux']!.chatgpt.leftOut).toBe(0)
    expect(report.heldOut.chatgpt.leftOut).toBe(0)
    expect(report.failing).toEqual([])
    expect(report.gaps).toHaveLength(2)
  })

  it('each of the four apps is scored from its own results', () => {
    const report = grade(run([
      result({ scenario: 'V1', app: 'vscode', check: 'ring.recall', dim: 'D1', score: 1 }),
      result({ scenario: 'U1', app: 'cursor', check: 'voice.reached', dim: 'D5', score: 0.5 }),
    ]), null)
    expect(report.apps.vscode).toEqual({ score: 100, dims: expect.objectContaining({ D1: 100, D5: null }), leftOut: 0 })
    expect(report.apps.cursor).toEqual({ score: 50, dims: expect.objectContaining({ D1: null, D5: 50 }), leftOut: 0 })
    expect(report.apps.claude.score).toBeNull()
    expect(report.apps.chatgpt.score).toBeNull()
    expect(report.byTier.a.vscode.score).toBe(100)
    expect(report.byPlatform['a/darwin']!.cursor.score).toBe(50)
    expect(report.failing.map((r) => [r.app, r.check, r.pointsLost])).toEqual([['cursor', 'voice.reached', 50]])
  })

  it('Orca is scored from its own results, the other four untouched', () => {
    const others = [
      result({ check: 'ring.recall', dim: 'D1', score: 1 }),
      result({ scenario: 'X1', app: 'chatgpt', check: 'ring.recall', dim: 'D1', score: 0.5 }),
      result({ scenario: 'V1', app: 'vscode', check: 'ring.recall', dim: 'D1', score: 1 }),
      result({ scenario: 'U1', app: 'cursor', check: 'voice.reached', dim: 'D5', score: 0.5 }),
    ]
    const orca = [
      result({ scenario: 'O1', app: 'orca', check: 'ring.recall', dim: 'D1', score: 1 }),
      result({ scenario: 'O5', app: 'orca', check: 'voice.reached', dim: 'D5', score: 0 }),
    ]
    const without = grade(run(others), null)
    const report = grade(run([...others, ...orca]), null)
    // D1 15 of 40 scores 100, D5 25 of 40 scores 0.
    expect(report.apps.orca).toEqual({ score: 37.5, dims: expect.objectContaining({ D1: 100, D5: 0 }), leftOut: 0 })
    expect(report.byTier.a.orca.score).toBe(37.5)
    expect(report.byPlatform['a/darwin']!.orca.score).toBe(37.5)
    for (const app of ['claude', 'chatgpt', 'vscode', 'cursor'] as const) expect(report.apps[app], app).toEqual(without.apps[app])
    expect(without.apps.orca).toEqual({ score: null, dims: expect.objectContaining({ D1: null }), leftOut: 0 })
  })

  it('iTerm2 is scored from its own results, the other five untouched', () => {
    const others = [
      result({ check: 'ring.recall', dim: 'D1', score: 1 }),
      result({ scenario: 'X1', app: 'chatgpt', check: 'ring.recall', dim: 'D1', score: 0.5 }),
      result({ scenario: 'V1', app: 'vscode', check: 'ring.recall', dim: 'D1', score: 1 }),
      result({ scenario: 'U1', app: 'cursor', check: 'voice.reached', dim: 'D5', score: 0.5 }),
      result({ scenario: 'O1', app: 'orca', check: 'ring.recall', dim: 'D1', score: 1 }),
    ]
    const iterm = [
      result({ scenario: 'I1', app: 'iterm', check: 'ring.recall', dim: 'D1', score: 0 }),
      result({ scenario: 'I5', app: 'iterm', check: 'voice.reached', dim: 'D5', score: 1 }),
    ]
    const without = grade(run(others), null)
    const report = grade(run([...others, ...iterm]), null)
    // D1 15 of 40 scores 0, D5 25 of 40 scores 100.
    expect(report.apps.iterm).toEqual({ score: 62.5, dims: expect.objectContaining({ D1: 0, D5: 100 }), leftOut: 0 })
    expect(report.byTier.a.iterm.score).toBe(62.5)
    expect(report.byPlatform['a/darwin']!.iterm.score).toBe(62.5)
    expect(report.failing.filter((r) => r.app === 'iterm').map((r) => [r.check, r.pointsLost])).toEqual([['ring.recall', 37.5]])
    for (const app of ['claude', 'chatgpt', 'vscode', 'cursor', 'orca'] as const) expect(report.apps[app], app).toEqual(without.apps[app])
    expect(without.apps.iterm).toEqual({ score: null, dims: expect.objectContaining({ D1: null }), leftOut: 0 })
  })

  it('a baseline written before Orca joined has no Orca entry and grades its results all the same', () => {
    const before = baseline({ 'a/darwin/C1/ring.recall': 1 }, { a: { claude: 100, chatgpt: null, vscode: null, cursor: null } })
    const results = run([
      result({ check: 'ring.recall', dim: 'D1', score: 1 }),
      result({ scenario: 'O1', app: 'orca', check: 'ring.recall', dim: 'D1', score: 0.5 }),
    ])
    const report = grade(results, before)
    expect(report.apps.orca.score).toBe(50)
    expect(report.delta.apps.a!.orca).toEqual({ before: null, after: 50 })
    expect(report.delta.apps.a!.claude).toEqual({ before: 100, after: 100 })
    expect(report.delta.checks).toEqual([{ key: 'a/darwin/O1/ring.recall', before: null, after: 0.5 }])
  })

  it('a held-out scenario\'s gap counts in the held-out leftOut, by the gap\'s own mark', () => {
    // No other run of XH1 says it is held out: the gap does.
    const report = grade(run([], { gaps: [{ tier: 'a', platform: 'darwin', scenario: 'XH1', app: 'chatgpt', heldOut: true, reason: 'reads process.platform' }] }), null)
    expect(report.heldOut.chatgpt.leftOut).toBe(1)
    expect(report.apps.chatgpt.leftOut).toBe(0)
  })
})

describe('gate', () => {
  it('the gate fails on one wrong send', () => {
    expect(grade(run(mixed), null).gate).toEqual({ passed: true, wrongSends: [] })
    expect(grade(run(mixed, { wrongSends: [wrongSend] }), null).gate).toEqual({ passed: false, wrongSends: [wrongSend] })
  })
})

describe('delta', () => {
  it('delta lists each changed check and every app\'s score of each subset the run drove, against that subset\'s', () => {
    const before = baseline(
      { 'a/darwin/C1/ring.recall': 1, 'a/darwin/C1/ring.order': 1, 'a/darwin/C1/ring.cap': 1, 'b/darwin/C1/ring.recall': 1 },
      { a: { claude: 90, chatgpt: 80 }, 'b/darwin': { claude: 70, chatgpt: null } },
    )
    const report = grade(run(mixed), before)
    // Tier A against tier A's: tier B was not run, so its scores are no change.
    expect(report.delta.apps).toEqual({ a: { claude: { before: 90, after: 18.75 }, chatgpt: { before: 80, after: null },
      vscode: { before: null, after: null }, cursor: { before: null, after: null }, orca: { before: null, after: null },
      iterm: { before: null, after: null } } })
    // Tier B was not run here, so its entry is no change.
    expect(report.delta.checks).toEqual([
      { key: 'a/darwin/C1/ring.cap', before: 1, after: null },
      { key: 'a/darwin/C1/ring.order', before: 1, after: 0 },
      { key: 'a/darwin/C5/voice.reached', before: null, after: 0 },
    ])
  })

  it('no baseline: every app score is new and every check is new', () => {
    const report = grade(run(mixed.slice(0, 1)), null)
    expect(report.delta).toEqual({
      apps: { a: { claude: { before: null, after: 100 }, chatgpt: { before: null, after: null },
        vscode: { before: null, after: null }, cursor: { before: null, after: null }, orca: { before: null, after: null },
        iterm: { before: null, after: null } } },
      checks: [{ key: 'a/darwin/C1/ring.recall', before: null, after: 1 }],
      heldOutChanged: 0,
    })
  })

  it('each subset\'s app scores, in the delta and an updated baseline, hold the six apps', () => {
    // A baseline written before the editors, Orca and iTerm2 joined has no entry of theirs.
    const before = baseline({}, { a: { claude: 90, chatgpt: 80 } })
    const results = run([
      result({ check: 'ring.recall', dim: 'D1', score: 1 }),
      result({ scenario: 'V1', app: 'vscode', check: 'ring.recall', dim: 'D1', score: 0.5 }),
      result({ tier: 'b', scenario: 'U1', app: 'cursor', check: 'ring.recall', dim: 'D1', score: 1 }),
    ])
    expect(grade(results, before).delta.apps).toEqual({
      a: { claude: { before: 90, after: 100 }, chatgpt: { before: 80, after: null }, vscode: { before: null, after: 50 },
        cursor: { before: null, after: null }, orca: { before: null, after: null }, iterm: { before: null, after: null } },
      'b/darwin': { claude: { before: null, after: null }, chatgpt: { before: null, after: null },
        vscode: { before: null, after: null }, cursor: { before: null, after: 100 }, orca: { before: null, after: null },
        iterm: { before: null, after: null } },
    })
    expect(updateBaseline(before, results, ['a', 'b']).apps).toEqual({
      a: { claude: 100, chatgpt: null, vscode: 50, cursor: null, orca: null, iterm: null },
      'b/darwin': { claude: null, chatgpt: null, vscode: null, cursor: 100, orca: null, iterm: null },
    })
  })
})

describe('tierAVerdict', () => {
  const now = run([
    result({ check: 'ring.recall', dim: 'D1', score: 1 }),
    result({ check: 'ring.order', dim: 'D1', score: 0.5 }),
  ])

  it('passes when tier A matches the baseline, whatever tier B holds', () => {
    const verdict = tierAVerdict(now, baseline({ 'a/darwin/C1/ring.recall': 1, 'a/darwin/C1/ring.order': 0.5, 'b/darwin/C9/x': 1 }))
    expect(verdict.ok).toBe(true)
  })

  it('tier A: a drop or a new check below 1 is a regression, a rise or a new passing check a stale baseline naming the update command', () => {
    const drop = tierAVerdict(now, baseline({ 'a/darwin/C1/ring.recall': 1, 'a/darwin/C1/ring.order': 1 }))
    expect(drop).toEqual({ ok: false, message: 'regression: a/darwin/C1/ring.order' })
    const failingNew = tierAVerdict(now, baseline({ 'a/darwin/C1/ring.recall': 1 }))
    expect(failingNew).toEqual({ ok: false, message: 'regression: a/darwin/C1/ring.order' })

    const update = '; run `npm run eval:dial-apps -- --tier a --update-baseline` and commit cli/src/testing/dialAppEval/baseline.json'
    const rise = tierAVerdict(now, baseline({ 'a/darwin/C1/ring.recall': 1, 'a/darwin/C1/ring.order': 0 }))
    expect(rise).toEqual({ ok: false, message: `stale baseline: a/darwin/C1/ring.order${update}` })
    const passingNew = tierAVerdict(now, baseline({ 'a/darwin/C1/ring.order': 0.5 }))
    expect(passingNew).toEqual({ ok: false, message: `stale baseline: a/darwin/C1/ring.recall${update}` })
  })

  it('tier A: a baseline check the run no longer gives is missing', () => {
    const verdict = tierAVerdict(now, baseline({ 'a/darwin/C1/ring.recall': 1, 'a/darwin/C1/ring.order': 0.5, 'a/linux/C1/ring.cap': 1 }))
    expect(verdict).toEqual({ ok: false, message: 'missing: a/linux/C1/ring.cap' })
  })

  it('names both a regression and a stale entry', () => {
    const verdict = tierAVerdict(now, baseline({ 'a/darwin/C1/ring.order': 1 }))
    expect(verdict.ok).toBe(false)
    expect(verdict.message).toContain('regression: a/darwin/C1/ring.order')
    expect(verdict.message).toContain('stale baseline: a/darwin/C1/ring.recall;')
  })

  it('tier A names no held-out check: their differences are a count', () => {
    const held = run([...now.results, result({ scenario: 'CH1', heldOut: true, check: 'ring.recall', dim: 'D1', score: 0 })])
    const verdict = tierAVerdict(held, baseline({ 'a/darwin/C1/ring.recall': 1, 'a/darwin/C1/ring.order': 0.5,
      'a/darwin/CH1/ring.recall': 1, 'a/darwin/CH1/ring.order': 1 }))
    expect(verdict).toEqual({ ok: false, message: 'held out: 2 checks differ from the baseline' })
  })

  it('fails on a wrong send, naming keys and path, never text', () => {
    const verdict = tierAVerdict(run(now.results, { wrongSends: [wrongSend] }),
      baseline({ 'a/darwin/C1/ring.recall': 1, 'a/darwin/C1/ring.order': 0.5 }))
    expect(verdict).toEqual({ ok: false, message: 'wrong-session send: b/darwin/C5 to b, not a, by mod' })
  })
})

describe('tierBVerdict', () => {
  const now = run([
    result({ tier: 'b', check: 'open.link', dim: 'D3', score: 0 }),
    result({ tier: 'b', check: 'open.latency', dim: 'D3', score: 0, timed: true }),
    result({ tier: 'b', check: 'ring.recall', dim: 'D1', score: 1 }),
  ])

  it('tier B: a pass/fail drop fails, a timed drop does not, a platform with no entries asserts the gate only', () => {
    const before = baseline({ 'b/darwin/C1/open.link': 1, 'b/darwin/C1/open.latency': 1, 'b/darwin/C1/ring.recall': 1 })
    expect(tierBVerdict(now, before, 'darwin')).toEqual({ ok: false, message: 'regression: b/darwin/C1/open.link' })

    const timedOnly = baseline({ 'b/darwin/C1/open.link': 0, 'b/darwin/C1/open.latency': 1 })
    expect(tierBVerdict(now, timedOnly, 'darwin').ok).toBe(true)

    const linux = run(now.results.map((r) => ({ ...r, platform: 'linux' as const })))
    expect(tierBVerdict(linux, before, 'linux').ok).toBe(true)
    expect(tierBVerdict(run(linux.results, { wrongSends: [{ ...wrongSend, platform: 'linux' }] }), before, 'linux'))
      .toEqual({ ok: false, message: 'wrong-session send: b/linux/C5 to b, not a, by mod' })
  })

  it('reads only the given platform\'s results', () => {
    const before = baseline({ 'b/darwin/C1/open.link': 1 })
    expect(tierBVerdict(now, before, 'linux').ok).toBe(true)
  })

  it('tier B reports I3\'s ring order, a race in the product after the devices restart, but does not hold it; its other checks and other scenarios\' order are held', () => {
    const i3 = (check: string, score: number, scenario = 'I3'): CheckResult =>
      result({ tier: 'b', app: 'iterm', scenario, check, dim: 'D1', score })
    const before = baseline({ 'b/darwin/I3/ring.order': 1, 'b/darwin/I3/ring.recall': 1, 'b/darwin/I1/ring.order': 1 })

    const raced = run([i3('ring.order', 0.25), i3('ring.recall', 1), i3('ring.order', 1, 'I1')])
    expect(tierBVerdict(raced, before, 'darwin')).toEqual({ ok: true, message: 'tier B on darwin holds its baseline' })
    expect(grade(raced, before).delta.checks).toContainEqual({ key: 'b/darwin/I3/ring.order', before: 1, after: 0.25 })

    const lost = run([i3('ring.order', 0.25, 'I1'), i3('ring.order', 0.25), i3('ring.recall', 0)])
    expect(tierBVerdict(lost, before, 'darwin'))
      .toEqual({ ok: false, message: 'regression: b/darwin/I1/ring.order, b/darwin/I3/ring.recall' })
  })

  it('tier B reports I15\'s ring order, the same race after the devices restart, but does not hold it', () => {
    const before = baseline({ 'b/darwin/I15/ring.order': 1 })
    const raced = run([result({ tier: 'b', app: 'iterm', scenario: 'I15', check: 'ring.order', dim: 'D1', score: 1 / 3 })])
    expect(tierBVerdict(raced, before, 'darwin')).toEqual({ ok: true, message: 'tier B on darwin holds its baseline' })
  })

  it("tier B reports I3's and I15's ringKept, pass/fail over the same list as their ring and so its order, but does not hold it; another scenario's is held", () => {
    const kept = (scenario: string, score: number): CheckResult =>
      result({ tier: 'b', app: 'iterm', scenario, check: 'ringKept', dim: 'D7', score })
    const before = baseline({ 'b/darwin/I3/ringKept': 1, 'b/darwin/I15/ringKept': 1, 'b/darwin/I21/ringKept': 1 })
    expect(tierBVerdict(run([kept('I3', 0), kept('I15', 0), kept('I21', 1)]), before, 'darwin'))
      .toEqual({ ok: true, message: 'tier B on darwin holds its baseline' })
    expect(tierBVerdict(run([kept('I3', 1), kept('I15', 1), kept('I21', 0)]), before, 'darwin'))
      .toEqual({ ok: false, message: 'regression: b/darwin/I21/ringKept' })
  })

  it('each check tier B reports and does not hold is a tier B result of the catalog, so a rename cannot hold it again unseen', () => {
    expect(RACED_B.size).toBeGreaterThan(0)
    for (const key of RACED_B) {
      const [tier, platform, id, check] = key.split('/') as [string, Platform, string, string]
      const s = [...MAIN, ...HELD_OUT].find((one) => one.id === id)
      expect([tier, s?.tiers.includes('b'), s?.platforms.includes(platform)], key).toEqual(['b', true, true])
      // A check gives its results, a D7 one its pass/fail alone, whatever was seen: a driver that saw nothing gives each.
      const given = s!.checks.flatMap((c) => evaluate(c, s!, { frames: [], faces: [], commands: [], deliveries: [], steps: [] }, 'b', platform))
      expect(given.map((r) => r.check), key).toContain(check)
    }
  })
})

describe('updateBaseline', () => {
  it('updateBaseline keeps the other tier\'s entries and app scores', () => {
    const before = baseline({ 'a/darwin/C1/ring.recall': 0, 'a/linux/C9/gone': 1, 'b/darwin/C1/ring.recall': 1 },
      { a: { claude: 1, chatgpt: 2 }, 'b/darwin': { claude: 3, chatgpt: 4 } })
    const after = updateBaseline(before, run(mixed), ['a'])
    expect(after).toEqual({
      schema: 1,
      checks: {
        'a/darwin/C1/ring.recall': 1, 'a/darwin/C1/ring.order': 0, 'a/darwin/C5/voice.reached': 0,
        'b/darwin/C1/ring.recall': 1,
      },
      apps: { a: { claude: 18.75, chatgpt: null, vscode: null, cursor: null, orca: null, iterm: null }, 'b/darwin': { claude: 3, chatgpt: 4 } },
    })
  })

  it('tier B replaces only that run\'s platforms, its checks and its app scores', () => {
    const before = baseline({ 'b/darwin/C1/ring.recall': 1, 'b/darwin/C1/gone': 1, 'b/linux/C1/ring.recall': 0.5 },
      { 'b/darwin': { claude: 100, chatgpt: null }, 'b/linux': { claude: 50, chatgpt: null } })
    const after = updateBaseline(before, run([result({ tier: 'b', check: 'ring.recall', dim: 'D1', score: 0 })]), ['b'])
    expect(after.checks).toEqual({ 'b/darwin/C1/ring.recall': 0, 'b/linux/C1/ring.recall': 0.5 })
    expect(after.apps).toEqual({ 'b/darwin': { claude: 0, chatgpt: null, vscode: null, cursor: null, orca: null, iterm: null },
      'b/linux': { claude: 50, chatgpt: null } })
  })

  it('a tier given that wrote nothing keeps its entries', () => {
    const before = baseline({ 'a/darwin/C1/ring.recall': 1 }, { a: { claude: 100, chatgpt: null } })
    const after = updateBaseline(before, run([result({ tier: 'b', check: 'ring.recall', dim: 'D1', score: 1 })]), ['a', 'b'])
    expect(after).toEqual({ schema: 1, checks: { 'a/darwin/C1/ring.recall': 1, 'b/darwin/C1/ring.recall': 1 },
      apps: { a: { claude: 100, chatgpt: null }, 'b/darwin': { claude: 100, chatgpt: null, vscode: null, cursor: null, orca: null, iterm: null } } })
  })

  it('leaves out a tier it was not given and starts from nothing with no baseline', () => {
    const results = run([result({ check: 'ring.recall', dim: 'D1', score: 1 }), result({ tier: 'b', check: 'x', dim: 'D1', score: 1 })])
    expect(updateBaseline(null, results, ['b']).checks).toEqual({ 'b/darwin/C1/x': 1 })
  })
})

describe('tier B timed results', () => {
  // Two runs that differ only in tier B timed results: I17's needs-you latency and its step-4 wait.
  const tierB = (check: string, score: number, timed: boolean): CheckResult =>
    result({ tier: 'b', app: 'iterm', scenario: 'I17', check, dim: 'D4', score, timed })
  const runOf = (latency: number, wait: number): RunResults => run([
    result({ check: 'open.latency', dim: 'D3', score: 0.5, timed: true }), // tier A timed: still written
    tierB('needsYou.shown', 1, false),
    tierB('needsYou.latency', latency, true),
    tierB('wait.4', wait, true),
  ])

  it('two runs that differ only in a tier B timed result give the same baseline, checks and app scores, and no delta for them', () => {
    const fast = updateBaseline(null, runOf(1, 1), ['a', 'b'])
    const slow = updateBaseline(null, runOf(0.5, 0), ['a', 'b'])
    expect(slow).toEqual(fast)
    expect(fast.checks).toEqual({ 'a/darwin/C1/open.latency': 0.5, 'b/darwin/I17/needsYou.shown': 1 })
    expect(fast.apps['b/darwin']!.iterm).toBe(100)
    const report = grade(runOf(0.5, 0), fast)
    expect(report.delta.checks).toEqual([])
    expect(report.delta.apps['b/darwin']!.iterm).toEqual({ before: 100, after: 100 })
  })

  it('the headline, byTier and byPlatform still count a tier B timed result', () => {
    const fast = grade(runOf(1, 1), null)
    const slow = grade(runOf(0.5, 0), null)
    expect(slow.apps.iterm.score).toBeLessThan(fast.apps.iterm.score!)
    expect(slow.byTier.b.iterm.score).toBeLessThan(fast.byTier.b.iterm.score!)
    expect(slow.byPlatform['b/darwin']!.iterm.score).toBeLessThan(fast.byPlatform['b/darwin']!.iterm.score!)
    expect(slow.failing.map((r) => r.check)).toEqual(expect.arrayContaining(['needsYou.latency', 'wait.4']))
  })

  it('the delta leaves out a tier B timed key the old baseline holds, keeps a tier A one, and counts no held-out one', () => {
    const old = baseline({ 'a/darwin/C1/open.latency': 1, 'b/darwin/I17/needsYou.shown': 1, 'b/darwin/I17/needsYou.latency': 1,
      'b/darwin/I17/wait.4': 1, 'b/darwin/XH1/open.latency': 1 })
    const held = result({ tier: 'b', app: 'iterm', scenario: 'XH1', heldOut: true, check: 'open.latency', dim: 'D3', score: 0, timed: true })
    const report = grade(run([...runOf(0.5, 0).results, held]), old)
    expect(report.delta.checks).toEqual([{ key: 'a/darwin/C1/open.latency', before: 1, after: 0.5 }])
    expect(report.delta.heldOutChanged).toBe(0)
  })
})

describe('droppedKeys', () => {
  const before = baseline({
    'a/darwin/C1/ring.recall': 1, 'a/darwin/C1/ring.order': 1, 'a/linux/C1/ring.order': 1, 'a/darwin/X2/ring.recall': 1,
    'a/darwin/C9/ring.recall': 1, 'b/darwin/C1/ring.recall': 1, 'b/linux/C1/ring.recall': 1,
  })
  // C1 as the catalog has it now: its condition wait is step 1, and its only check its ring.
  const c1 = scenario({
    id: 'C1', app: 'claude', title: 'Eval C1', dims: ['D1'], tiers: ['a'], sessions: [...claudeSessions(['a']), claudeGhost],
    steps: [{ kind: 'claude.write', sessions: ['a'] }, ...listed('claude', ['a'])],
    checks: [{ id: 'ring', kind: 'ring', dim: 'D1', page: 'claude', expect: ['a'] }], probes: [],
  })
  const catalog = new Map(['a/darwin/C1', 'a/linux/C1', 'a/darwin/X2', 'b/darwin/C1', 'b/linux/C1'].map((key) => [key, c1]))
  const ran = run([result({ check: 'ring.recall', dim: 'D1', score: 1 })],
    { gaps: [{ tier: 'a', platform: 'darwin', scenario: 'X2', app: 'chatgpt', heldOut: false, reason: 'a platform read' }] })

  it('names each check of a subset the update replaces that the run no longer gives, unless a gap or the catalog explains it', () => {
    // C1's order on both platforms went with nothing to say why; X2 is a gap; C9 left the catalog; tier B was not run.
    expect(droppedKeys(before, ran, ['a'], catalog)).toEqual(['a/darwin/C1/ring.order', 'a/linux/C1/ring.order'])
    expect(droppedKeys(before, ran, ['b'], catalog)).toEqual([])
    expect(droppedKeys(null, ran, ['a'], catalog)).toEqual([])
  })

  it('lets go of a wait whose step is no condition wait now, and of a check its scenario no longer has', () => {
    // A catalog edit moved C1's condition wait from step 2 to step 1, and dropped its focus check.
    const was = baseline({
      'a/darwin/C1/ring.recall': 1, 'a/darwin/C1/ring.order': 1, 'a/darwin/C1/wait.1': 1, 'a/darwin/C1/wait.2': 1,
      'a/darwin/C1/wait.3': 1, 'a/darwin/C1/focus.lands': 1,
    })
    expect(droppedKeys(was, ran, ['a'], new Map([['a/darwin/C1', c1]])))
      .toEqual(['a/darwin/C1/ring.order', 'a/darwin/C1/wait.1'])
  })

  it('lets go of a tier B timed key the run did not give: an update no longer writes one', () => {
    // C1 in tier B: its cost check's cpu and loopP99 are timed, and its step-1 condition wait.
    const b1 = { ...c1, tiers: ['b' as const], checks: [...c1.checks, { id: 'cost', kind: 'cost' as const, dim: 'D8' as const }] }
    const was = baseline({ 'b/darwin/C1/ring.recall': 1, 'b/darwin/C1/ring.order': 1, 'b/darwin/C1/wait.1': 1,
      'b/darwin/C1/cost.cpu': 1, 'b/darwin/C1/cost.loopP99': 1 })
    const ranB = run([result({ tier: 'b', check: 'ring.recall', dim: 'D1', score: 1 })])
    expect(droppedKeys(was, ranB, ['b'], new Map([['b/darwin/C1', b1]]))).toEqual(['b/darwin/C1/ring.order'])
  })

  it('grades every main tier B scenario on nothing seen to tell its timed keys, without throwing', () => {
    const on = MAIN.filter((s) => s.tiers.includes('b') && s.platforms.includes('darwin'))
    const was = baseline(Object.fromEntries(on.map((s) => [`b/darwin/${s.id}/cost.cpu`, 1])))
    // A gap of a scenario outside the catalog given: tier B on darwin was driven, so its subset is replaced.
    const driven = run([], { gaps: [{ tier: 'b', platform: 'darwin', scenario: 'Z1', app: 'claude', heldOut: false, reason: 'none' }] })
    expect(droppedKeys(was, driven, ['b'], new Map(on.map((s) => [`b/darwin/${s.id}`, s])))).toEqual([])
  })
})

describe('loadBaseline', () => {
  let dir: string | undefined
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }) })

  it('reads a baseline, and gives null when there is none', () => {
    dir = mkdtempSync(join(tmpdir(), 'grade-'))
    const path = join(dir, 'baseline.json')
    expect(loadBaseline(path)).toBeNull()
    const written = baseline({ 'a/darwin/C1/ring.recall': 1 }, { a: { claude: 100, chatgpt: null } })
    writeFileSync(path, JSON.stringify(written))
    expect(loadBaseline(path)).toEqual(written)
  })

  it('refuses a file of another schema', () => {
    dir = mkdtempSync(join(tmpdir(), 'grade-'))
    const path = join(dir, 'baseline.json')
    writeFileSync(path, JSON.stringify({ schema: 2, checks: {}, apps: {} }))
    expect(() => loadBaseline(path)).toThrow(/schema/)
  })

  it('lives beside the catalog', () => {
    expect(BASELINE_PATH.replaceAll('\\', '/')).toMatch(/\/cli\/src\/testing\/dialAppEval\/baseline\.json$/)
  })
})
