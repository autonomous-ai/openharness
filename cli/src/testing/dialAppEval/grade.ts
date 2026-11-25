// The dial eval's grader: pure functions from a run's results (and the committed baseline) to the report and the
// verdicts the tier A spec and the tier B files assert (docs/plans/2026-11-21-dial-app-eval-design.md).
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { evaluate } from './checks.js'
import {
  APPS, DIMENSIONS, WEIGHTS, resultKey,
  type App, type AppScores, type Baseline, type CheckResult, type CoverageGap, type Dimension, type Group,
  type Platform, type Report, type RunResults, type Scenario, type Seen, type Tier, type Verdict,
} from './types.js'

export const BASELINE_PATH = fileURLToPath(new URL('./baseline.json', import.meta.url))
/**
 * Set to `1` by the eval command for the tier spec and the e2e files it runs: it judges the ratchet itself from the
 * merged results, so their own ratchet cases skip and a failure of theirs is never one.
 */
export const SKIP_RATCHET_ENV = 'DIAL_EVAL_SKIP_RATCHET'

const UPDATE_TIER_A = 'run `npm run eval:dial-apps -- --tier a --update-baseline` and commit cli/src/testing/dialAppEval/baseline.json'

type Run = Pick<CheckResult, 'tier' | 'platform' | 'scenario'>
const runKey = (r: Run): string => `${r.tier}/${r.platform}/${r.scenario}`
const runOfKey = (key: string): string => key.split('/', 3).join('/')
/** The scenarios held out, as the run marks them: each result and gap carries its scenario's mark. */
const heldOutOf = (results: RunResults): Set<string> =>
  new Set([...results.results, ...results.gaps].filter((r) => r.heldOut).map((r) => r.scenario))
const heldOutKey = (held: ReadonlySet<string>) => (key: string): boolean => held.has(key.split('/', 3)[2]!)
/** A baseline subset: tier A as one, as it runs every platform by injection; tier B one per platform it drove. */
const subsetOf = (r: Pick<CheckResult, 'tier' | 'platform'>): string => (r.tier === 'a' ? 'a' : `b/${r.platform}`)
const subsetOfKey = (key: string): string => {
  const [tier, platform] = key.split('/', 2) as [Tier, Platform]
  return subsetOf({ tier, platform })
}
const platformKey = (r: Pick<CheckResult, 'tier' | 'platform'>): string => `${r.tier}/${r.platform}`
const mean = (values: readonly number[]): number => values.reduce((sum, v) => sum + v, 0) / values.length
// Code-unit order, not localeCompare: the baseline and the report read the same on every host.
const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

/** The results that count: a gap's run is neither pass nor fail, so whatever it produced is left out. */
function scoredResults(results: RunResults): CheckResult[] {
  const gapRuns = new Set(results.gaps.map(runKey))
  return results.results.filter((r) => !gapRuns.has(runKey(r)))
}

/** What the scores are made of: a wait that held is the harness's own readiness, kept in the results only so tier A's
 *  exact baseline sees one that stops holding; one that missed costs its dimension (runner.ts). */
const scoring = (results: readonly CheckResult[]): CheckResult[] =>
  results.filter((r) => !(r.check.startsWith('wait.') && r.score === 1))

/** A tier B timed result scores the host's wall clock, which moves between runs of the same commit: it counts in the
 *  headline, but nothing held or committed (the baseline, its app scores, the report's delta) is made of it. */
const runnerTimed = (r: Pick<CheckResult, 'tier' | 'timed'>): boolean => r.tier === 'b' && r.timed

function appScores(results: readonly CheckResult[], gaps: readonly CoverageGap[], app: App): AppScores {
  const rows = results.filter((r) => r.app === app)
  const dims = Object.fromEntries(DIMENSIONS.map((d) => {
    const scores = rows.filter((r) => r.dim === d).map((r) => r.score)
    return [d, scores.length > 0 ? 100 * mean(scores) : null]
  })) as Record<Dimension, number | null>
  // A dimension with no check is left out and the others' weights renormalised.
  const present = DIMENSIONS.filter((d) => dims[d] !== null)
  const weight = present.reduce((sum, d) => sum + WEIGHTS[d], 0)
  const score = present.length > 0 ? present.reduce((sum, d) => sum + WEIGHTS[d] * dims[d]!, 0) / weight : null
  const leftOut = new Set(gaps.filter((g) => g.app === app).map(runKey)).size
  return { score, dims, leftOut }
}

function table(results: readonly CheckResult[], gaps: readonly CoverageGap[]): Record<App, AppScores> {
  return Object.fromEntries(APPS.map((app) => [app, appScores(results, gaps, app)])) as Record<App, AppScores>
}

/** Each subset's main-set app scores, for the subsets given. */
function subsetScores(results: RunResults, subsets: Iterable<string>): Map<string, Record<App, number | null>> {
  const main = scoring(scoredResults(results)).filter((r) => !r.heldOut && !runnerTimed(r))
  const gaps = results.gaps.filter((g) => !g.heldOut)
  return new Map([...subsets].map((subset) => {
    const scores = table(main.filter((r) => subsetOf(r) === subset), gaps.filter((g) => subsetOf(g) === subset))
    return [subset, Object.fromEntries(APPS.map((app) => [app, scores[app].score])) as Record<App, number | null>]
  }))
}

/** 100 · (w_d / Σw) · (1 − score) / n_d per check, Σw over the app's dimensions with a check. */
function withPointsLost(main: readonly CheckResult[]): Array<CheckResult & { pointsLost: number }> {
  const counts = new Map<string, number>()
  for (const r of main) counts.set(`${r.app}/${r.dim}`, (counts.get(`${r.app}/${r.dim}`) ?? 0) + 1)
  const weight = (app: App): number => DIMENSIONS.filter((d) => counts.has(`${app}/${d}`)).reduce((sum, d) => sum + WEIGHTS[d], 0)
  const weights = new Map(APPS.map((app) => [app, weight(app)]))
  return main.map((r) => ({
    ...r,
    pointsLost: 100 * (WEIGHTS[r.dim] / weights.get(r.app)!) * (1 - r.score) / counts.get(`${r.app}/${r.dim}`)!,
  }))
}

/** The held-out gaps by reason, in its order, each with its tiers and platforms in theirs: no scenario's id. */
function heldOutReasons(gaps: readonly CoverageGap[]): Report['heldOutGaps'] {
  const distinct = <T extends string>(values: T[]): T[] => [...new Set(values)].sort(byText)
  return distinct(gaps.map((g) => g.reason)).map((reason) => {
    const of = gaps.filter((g) => g.reason === reason)
    return { reason, tiers: distinct(of.map((g) => g.tier)), platforms: distinct(of.map((g) => g.platform)), runs: new Set(of.map(runKey)).size }
  })
}

function rankedGroups(failing: ReadonlyArray<CheckResult & { pointsLost: number }>): Group[] {
  const groups = new Map<string, Group>()
  for (const r of failing) {
    const id = `${r.app}/${r.dim}/${r.scenario}`
    const group = groups.get(id) ?? { app: r.app, dim: r.dim, scenario: r.scenario, pointsLost: 0, checks: [] }
    group.pointsLost += r.pointsLost
    group.checks.push(resultKey(r))
    groups.set(id, group)
  }
  return [...groups.entries()].sort(([a, ga], [b, gb]) => gb.pointsLost - ga.pointsLost || byText(a, b)).map(([, g]) => g)
}

export function grade(results: RunResults, baseline: Baseline | null): Report {
  const scored = scoredResults(results)
  const main = scoring(scored).filter((r) => !r.heldOut)
  const mainGaps = results.gaps.filter((g) => !g.heldOut)
  const heldOutGaps = results.gaps.filter((g) => g.heldOut)

  const apps = table(main, mainGaps)
  const byTier = {
    a: table(main.filter((r) => r.tier === 'a'), mainGaps.filter((g) => g.tier === 'a')),
    b: table(main.filter((r) => r.tier === 'b'), mainGaps.filter((g) => g.tier === 'b')),
  }
  const ran = [...new Set([...results.results, ...results.gaps].map(platformKey))].sort()
  const byPlatform = Object.fromEntries(ran.map((key) =>
    [key, table(main.filter((r) => platformKey(r) === key), mainGaps.filter((g) => platformKey(g) === key))]))

  const failing = withPointsLost(main).filter((r) => r.score < 1)
    .sort((a, b) => b.pointsLost - a.pointsLost || byText(resultKey(a), resultKey(b)))

  const after = new Map(scored.map((r) => [resultKey(r), r.score]))
  const before = baseline?.checks ?? {}
  // A baseline entry of a subset this run did not drive is not a change.
  const subsets = new Set([...results.results, ...results.gaps].map(subsetOf))
  // A key the run marks tier B timed is left out on both sides, so an old baseline's entry of one is no line either.
  const timedB = new Set(scored.filter(runnerTimed).map(resultKey))
  const keys = new Set([...after.keys(), ...Object.keys(before).filter((key) => subsets.has(subsetOfKey(key)))]
    .filter((key) => !timedB.has(key)))
  const changed = [...keys].sort()
    .map((key) => ({ key, before: before[key] ?? null, after: after.get(key) ?? null }))
    .filter((c) => c.before !== c.after)
  const isHeldOut = heldOutKey(heldOutOf(results))

  return {
    schema: 1,
    apps,
    heldOut: table(scoring(scored).filter((r) => r.heldOut), heldOutGaps),
    byTier,
    byPlatform,
    gate: { passed: results.wrongSends.length === 0, wrongSends: results.wrongSends },
    failing,
    groups: rankedGroups(failing),
    gaps: mainGaps,
    heldOutGaps: heldOutReasons(heldOutGaps),
    delta: {
      apps: Object.fromEntries([...subsetScores(results, [...subsets].sort())].map(([subset, now]) => [subset,
        Object.fromEntries(APPS.map((app) => [app, { before: baseline?.apps[subset]?.[app] ?? null, after: now[app] }])) as
          Report['delta']['apps'][string]])),
      checks: changed.filter((c) => !isHeldOut(c.key)),
      heldOutChanged: changed.filter((c) => isHeldOut(c.key)).length,
    },
  }
}

/** Names keys and path, never the spoken text. */
function gateFailure(results: RunResults): Verdict | null {
  if (results.wrongSends.length === 0) return null
  const lines = results.wrongSends.map((w) =>
    `wrong-session send: ${runKey(w)} to ${w.got ?? 'no session'}, not ${w.target}, by ${w.path}`)
  return { ok: false, message: lines.join('\n') }
}

/**
 * Tier A is deterministic, so its baseline is exact: any difference fails, a drop as a regression, a check the run no
 * longer gives as missing, the rest as stale.
 */
export function tierAVerdict(results: RunResults, baseline: Baseline): Verdict {
  const gate = gateFailure(results)
  if (gate) return gate
  const now = new Map(scoredResults(results).filter((r) => r.tier === 'a').map((r) => [resultKey(r), r.score]))
  const before = new Map(Object.entries(baseline.checks).filter(([key]) => key.startsWith('a/')))
  const regressions: string[] = []
  const missing: string[] = []
  const stale: string[] = []
  for (const key of [...new Set([...now.keys(), ...before.keys()])].sort()) {
    const was = before.get(key)
    const is = now.get(key)
    if (is === undefined) missing.push(key)
    // A new check that fails is a regression: one that passes, or rose, is the baseline's to catch up with.
    else if (is < (was ?? 1)) regressions.push(key)
    else if (was !== is) stale.push(key)
  }
  // The held-out checks are counted, never named: the message is read by whoever fixes the main set.
  const isHeldOut = heldOutKey(heldOutOf(results))
  const named = (keys: string[]): string[] => keys.filter((key) => !isHeldOut(key))
  const heldOut = [...regressions, ...missing, ...stale].filter(isHeldOut).length
  const line = (label: string, keys: string[], after = ''): string[] => (keys.length > 0 ? [`${label}: ${keys.join(', ')}${after}`] : [])
  const lines = [
    ...line('regression', named(regressions)),
    ...line('missing', named(missing)),
    ...line('stale baseline', named(stale), `; ${UPDATE_TIER_A}`),
    ...(heldOut > 0 ? [`held out: ${heldOut} check${heldOut === 1 ? ' differs' : 's differ'} from the baseline`] : []),
  ]
  return lines.length > 0 ? { ok: false, message: lines.join('\n') } : { ok: true, message: 'tier A matches the baseline' }
}

/**
 * Tier B pass/fail checks reported but not held, as a timed one is: each grades a race in the product that the run's
 * timing decides (the spec's CI rules, PM 2026-11-23). These were I3's and I15's ring order on iTerm2's page, and their
 * ringKept: the tmux row once reached that page only after its client lookup, so a list tick in the gap ordered it last.
 * Since tmux's and herdr's rows have pages of their own (docs/plans/2026-11-23-dial-tmux-herdr-apps-design.md), that
 * ring holds a alone and its order cannot race. The keys stay until a Mac tier B run's evidence prunes or replaces them.
 */
export const RACED_B: ReadonlySet<string> =
  new Set(['b/darwin/I3/ring.order', 'b/darwin/I3/ringKept', 'b/darwin/I15/ring.order', 'b/darwin/I15/ringKept'])

/** Only pass/fail checks the platform's baseline passes are held: timed ones depend on the runner, RACED_B's on a race. */
export function tierBVerdict(results: RunResults, baseline: Baseline, platform: Platform): Verdict {
  const gate = gateFailure(results)
  if (gate) return gate
  const prefix = `b/${platform}/`
  if (!Object.keys(baseline.checks).some((key) => key.startsWith(prefix))) {
    return { ok: true, message: `no tier B baseline on ${platform}: the gate only` }
  }
  const regressions = scoredResults(results)
    .filter((r) => r.tier === 'b' && r.platform === platform && !r.timed && r.score < 1 && baseline.checks[resultKey(r)] === 1)
    .map(resultKey)
    .filter((key) => !RACED_B.has(key))
  return regressions.length > 0
    ? { ok: false, message: `regression: ${regressions.join(', ')}` }
    : { ok: true, message: `tier B on ${platform} holds its baseline` }
}

/** The subsets an update with these tiers replaces: those the run drove. */
function replaced(results: RunResults, tiers: readonly Tier[]): Set<string> {
  return new Set([...results.results, ...results.gaps].filter((r) => tiers.includes(r.tier)).map(subsetOf))
}

/** Replaces the checks and app scores of each subset of the given tiers this run drove, and keeps the rest. */
export function updateBaseline(baseline: Baseline | null, results: RunResults, tiers: readonly Tier[]): Baseline {
  const subsets = replaced(results, tiers)
  const kept = Object.entries(baseline?.checks ?? {}).filter(([key]) => !subsets.has(subsetOfKey(key)))
  const keptSubsets = new Set(kept.map(([key]) => subsetOfKey(key)))
  const fresh = scoredResults(results).filter((r) => subsets.has(subsetOf(r)) && !runnerTimed(r))
  const checks = [...kept, ...fresh.map((r) => [resultKey(r), r.score] as const)].sort(([a], [b]) => byText(a, b))
  const apps = [
    ...Object.entries(baseline?.apps ?? {}).filter(([subset]) => keptSubsets.has(subset)),
    ...subsetScores(results, subsets),
  ].sort(([a], [b]) => byText(a, b))
  return { schema: 1, checks: Object.fromEntries(checks), apps: Object.fromEntries(apps) }
}

const NOTHING_SEEN: Seen = { frames: [], faces: [], commands: [], deliveries: [], steps: [] }

/**
 * The baseline checks an update would drop with nothing to say why: each of a subset it replaces that the run no longer
 * gives, while its scenario had no gap and `catalog` (each tier/platform/scenario the catalog runs now, by its runKey)
 * still asks for it: a `wait.<i>` while its step i is a condition wait, any other while the scenario has its check. A
 * tier B timed key goes, as an update writes none: every wait, and each part `evaluate` marks timed.
 */
export function droppedKeys(baseline: Baseline | null, results: RunResults, tiers: readonly Tier[],
  catalog: ReadonlyMap<string, Scenario>): string[] {
  const subsets = replaced(results, tiers)
  const given = new Set(results.results.map(resultKey))
  const gapRuns = new Set(results.gaps.map(runKey))
  // checks.ts alone decides which part is timed: grading on nothing seen gives each timed part, once a run.
  const timedChecks = new Map<string, Set<string>>()
  const timedPart = (key: string, scenario: Scenario, check: string): boolean => {
    const run = runOfKey(key)
    let timed = timedChecks.get(run)
    if (!timed) {
      const platform = key.split('/', 2)[1] as Platform
      timed = new Set(scenario.checks.flatMap((c) => evaluate(c, scenario, NOTHING_SEEN, 'b', platform))
        .filter((r) => r.timed).map((r) => r.check))
      timedChecks.set(run, timed)
    }
    return timed.has(check)
  }
  const asked = (key: string): boolean => {
    const scenario = catalog.get(runOfKey(key))
    if (!scenario) return false
    const check = key.split('/').slice(3).join('/')
    const wait = /^wait\.(\d+)$/.exec(check)
    // An update never writes a tier B timed key (updateBaseline), and every wait is timed (runner.ts). A part the
    // grading above does not give is no timed one: it stays asked, so the update is refused naming it.
    if (key.startsWith('b/') && (wait || timedPart(key, scenario, check))) return false
    if (wait) {
      const step = scenario.steps[Number(wait[1])]
      return step?.kind === 'wait' && step.until !== undefined
    }
    return scenario.checks.some((c) => c.id === check.split('.', 1)[0])
  }
  return Object.keys(baseline?.checks ?? {})
    .filter((key) => subsets.has(subsetOfKey(key)) && !given.has(key) && !gapRuns.has(runOfKey(key)) && asked(key))
    .sort(byText)
}

export function loadBaseline(path: string = BASELINE_PATH): Baseline | null {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  const baseline = JSON.parse(text) as Baseline
  if (baseline.schema !== 1) throw new Error(`baseline.json has schema ${String(baseline.schema)}, expected 1`)
  return baseline
}
