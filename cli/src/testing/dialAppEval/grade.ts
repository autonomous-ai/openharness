// The dial eval's grader: pure functions from a run's results (and the committed baseline) to the report and the
// verdicts the tier A spec and the tier B files assert (docs/plans/2026-11-21-dial-app-eval-design.md).
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  DIMENSIONS, WEIGHTS, resultKey,
  type App, type AppScores, type Baseline, type CheckResult, type CoverageGap, type Dimension, type Group,
  type Platform, type Report, type RunResults, type Tier, type Verdict,
} from './types.js'

export const BASELINE_PATH = fileURLToPath(new URL('./baseline.json', import.meta.url))

const APPS: readonly App[] = ['claude', 'chatgpt']
const UPDATE_TIER_A = 'run `npm run eval:dial-apps -- --tier a --update-baseline` and commit cli/src/testing/dialAppEval/baseline.json'

type Run = Pick<CheckResult, 'tier' | 'platform' | 'scenario'>
const runKey = (r: Run): string => `${r.tier}/${r.platform}/${r.scenario}`
const platformKey = (r: Pick<CheckResult, 'tier' | 'platform'>): string => `${r.tier}/${r.platform}`
const platformOfKey = (key: string): string => key.split('/', 2).join('/')
const mean = (values: readonly number[]): number => values.reduce((sum, v) => sum + v, 0) / values.length
// Code-unit order, not localeCompare: the baseline and the report read the same on every host.
const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

/** The results that count: a gap's run is neither pass nor fail, so whatever it produced is left out. */
function scoredResults(results: RunResults): CheckResult[] {
  const gapRuns = new Set(results.gaps.map(runKey))
  return results.results.filter((r) => !gapRuns.has(runKey(r)))
}

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
  const main = scored.filter((r) => !r.heldOut)
  // A gap's run has no results to say it is held out, so a scenario held out in any other run counts as held out.
  const heldOutScenarios = new Set(results.results.filter((r) => r.heldOut).map((r) => r.scenario))
  const mainGaps = results.gaps.filter((g) => !heldOutScenarios.has(g.scenario))
  const heldOutGaps = results.gaps.filter((g) => heldOutScenarios.has(g.scenario))

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
  // A baseline entry of a tier × platform this run did not drive is not a change.
  const keys = new Set([...after.keys(), ...Object.keys(before).filter((key) => ran.includes(platformOfKey(key)))])
  const checks = [...keys].sort()
    .map((key) => ({ key, before: before[key] ?? null, after: after.get(key) ?? null }))
    .filter((c) => c.before !== c.after)

  return {
    schema: 1,
    apps,
    heldOut: table(scored.filter((r) => r.heldOut), heldOutGaps),
    byTier,
    byPlatform,
    gate: { passed: results.wrongSends.length === 0, wrongSends: results.wrongSends },
    failing,
    groups: rankedGroups(failing),
    gaps: results.gaps,
    delta: {
      apps: Object.fromEntries(APPS.map((app) =>
        [app, { before: baseline?.apps[app] ?? null, after: apps[app].score }])) as Report['delta']['apps'],
      checks,
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

/** Tier A is deterministic, so its baseline is exact: any difference fails, a drop as a regression, the rest as stale. */
export function tierAVerdict(results: RunResults, baseline: Baseline): Verdict {
  const gate = gateFailure(results)
  if (gate) return gate
  const now = new Map(scoredResults(results).filter((r) => r.tier === 'a').map((r) => [resultKey(r), r.score]))
  const before = new Map(Object.entries(baseline.checks).filter(([key]) => key.startsWith('a/')))
  const regressions: string[] = []
  const stale: string[] = []
  for (const key of [...new Set([...now.keys(), ...before.keys()])].sort()) {
    const was = before.get(key)
    const is = now.get(key)
    if (was !== undefined && is !== undefined && is < was) regressions.push(key)
    else if (was !== is) stale.push(key)
  }
  const lines = [
    ...(regressions.length > 0 ? [`regression: ${regressions.join(', ')}`] : []),
    ...(stale.length > 0 ? [`stale baseline: ${stale.join(', ')}; ${UPDATE_TIER_A}`] : []),
  ]
  return lines.length > 0 ? { ok: false, message: lines.join('\n') } : { ok: true, message: 'tier A matches the baseline' }
}

/** Only pass/fail checks the platform's baseline passes are held: timed ones depend on the runner. */
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
  return regressions.length > 0
    ? { ok: false, message: `regression: ${regressions.join(', ')}` }
    : { ok: true, message: `tier B on ${platform} holds its baseline` }
}

/**
 * Replaces the given tiers' entries and keeps the rest. Tier A always runs every platform by injection, so all of its
 * entries go; tier B only those of the platforms this run drove.
 */
export function updateBaseline(baseline: Baseline | null, results: RunResults, tiers: readonly Tier[]): Baseline {
  const ran = new Set([...results.results, ...results.gaps].map(platformKey))
  const replaced = (key: string): boolean => {
    const tier = key.split('/', 1)[0] as Tier
    return tiers.includes(tier) && (tier === 'a' || ran.has(platformOfKey(key)))
  }
  const fresh = scoredResults(results).filter((r) => tiers.includes(r.tier))
  const entries = [
    ...Object.entries(baseline?.checks ?? {}).filter(([key]) => !replaced(key)),
    ...fresh.map((r) => [resultKey(r), r.score] as const),
  ].sort(([a], [b]) => byText(a, b))
  const given: RunResults = {
    ...results,
    results: results.results.filter((r) => tiers.includes(r.tier)),
    gaps: results.gaps.filter((g) => tiers.includes(g.tier)),
  }
  const apps = grade(given, null).apps
  return {
    schema: 1,
    checks: Object.fromEntries(entries),
    apps: { claude: apps.claude.score, chatgpt: apps.chatgpt.score },
  }
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
