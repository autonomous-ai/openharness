import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BASELINE_PATH, droppedKeys, grade, loadBaseline, tierAVerdict, tierBVerdict, updateBaseline } from './grade.js'
import type { Baseline, CheckResult, CoverageGap, RunResults, WrongSend } from './types.js'

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
  it('delta lists each changed check and both app scores of each subset the run drove, against that subset\'s', () => {
    const before = baseline(
      { 'a/darwin/C1/ring.recall': 1, 'a/darwin/C1/ring.order': 1, 'a/darwin/C1/ring.cap': 1, 'b/darwin/C1/ring.recall': 1 },
      { a: { claude: 90, chatgpt: 80 }, 'b/darwin': { claude: 70, chatgpt: null } },
    )
    const report = grade(run(mixed), before)
    // Tier A against tier A's: tier B was not run, so its scores are no change.
    expect(report.delta.apps).toEqual({ a: { claude: { before: 90, after: 18.75 }, chatgpt: { before: 80, after: null } } })
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
      apps: { a: { claude: { before: null, after: 100 }, chatgpt: { before: null, after: null } } },
      checks: [{ key: 'a/darwin/C1/ring.recall', before: null, after: 1 }],
      heldOutChanged: 0,
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
      apps: { a: { claude: 18.75, chatgpt: null }, 'b/darwin': { claude: 3, chatgpt: 4 } },
    })
  })

  it('tier B replaces only that run\'s platforms, its checks and its app scores', () => {
    const before = baseline({ 'b/darwin/C1/ring.recall': 1, 'b/darwin/C1/gone': 1, 'b/linux/C1/ring.recall': 0.5 },
      { 'b/darwin': { claude: 100, chatgpt: null }, 'b/linux': { claude: 50, chatgpt: null } })
    const after = updateBaseline(before, run([result({ tier: 'b', check: 'ring.recall', dim: 'D1', score: 0 })]), ['b'])
    expect(after.checks).toEqual({ 'b/darwin/C1/ring.recall': 0, 'b/linux/C1/ring.recall': 0.5 })
    expect(after.apps).toEqual({ 'b/darwin': { claude: 0, chatgpt: null }, 'b/linux': { claude: 50, chatgpt: null } })
  })

  it('a tier given that wrote nothing keeps its entries', () => {
    const before = baseline({ 'a/darwin/C1/ring.recall': 1 }, { a: { claude: 100, chatgpt: null } })
    const after = updateBaseline(before, run([result({ tier: 'b', check: 'ring.recall', dim: 'D1', score: 1 })]), ['a', 'b'])
    expect(after).toEqual({ schema: 1, checks: { 'a/darwin/C1/ring.recall': 1, 'b/darwin/C1/ring.recall': 1 },
      apps: { a: { claude: 100, chatgpt: null }, 'b/darwin': { claude: 100, chatgpt: null } } })
  })

  it('leaves out a tier it was not given and starts from nothing with no baseline', () => {
    const results = run([result({ check: 'ring.recall', dim: 'D1', score: 1 }), result({ tier: 'b', check: 'x', dim: 'D1', score: 1 })])
    expect(updateBaseline(null, results, ['b']).checks).toEqual({ 'b/darwin/C1/x': 1 })
  })
})

describe('droppedKeys', () => {
  const before = baseline({
    'a/darwin/C1/ring.recall': 1, 'a/darwin/C1/ring.order': 1, 'a/linux/C1/ring.order': 1, 'a/darwin/X2/ring.recall': 1,
    'a/darwin/C9/ring.recall': 1, 'b/darwin/C1/ring.recall': 1, 'b/linux/C1/ring.recall': 1,
  })
  const catalog = new Set(['a/darwin/C1', 'a/linux/C1', 'a/darwin/X2', 'b/darwin/C1', 'b/linux/C1'])
  const ran = run([result({ check: 'ring.recall', dim: 'D1', score: 1 })],
    { gaps: [{ tier: 'a', platform: 'darwin', scenario: 'X2', app: 'chatgpt', heldOut: false, reason: 'a platform read' }] })

  it('names each check of a subset the update replaces that the run no longer gives, unless a gap or the catalog explains it', () => {
    // C1's order on both platforms went with nothing to say why; X2 is a gap; C9 left the catalog; tier B was not run.
    expect(droppedKeys(before, ran, ['a'], catalog)).toEqual(['a/darwin/C1/ring.order', 'a/linux/C1/ring.order'])
    expect(droppedKeys(before, ran, ['b'], catalog)).toEqual([])
    expect(droppedKeys(null, ran, ['a'], catalog)).toEqual([])
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
