/**
 * The dial eval's runner (docs/plans/2026-11-21-dial-app-eval-plan.md, Task 8): one scenario through a driver of
 * either tier, its steps turned into what the driver saw, then scored by the check evaluators (checks.ts). The results
 * of a run go to a JSON file per tier and source, which the eval command merges.
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { condition, evaluate, wrongSends } from './checks.js'
import type { Check, CheckResult, CoverageGap, EvalDriver, Platform, RunResults, Scenario, Tier, WrongSend } from './types.js'

/** After the last step: past the largest half threshold (5 s), so a late reaction still counts. */
export const SETTLE_END_MS = 6_000

export interface ScenarioRun {
  scenario: string; platform: Platform; results: CheckResult[]; probes: CheckResult[]
  wrongSends: WrongSend[]; gaps: CoverageGap[]
}

type Source = 'spec' | 'claude' | 'chatgpt' | 'heldOut'
/** The tier spec runs tier A; the e2e files, one per app and the held-out one, run tier B. */
const TIER_OF: Readonly<Record<Source, Tier>> = { spec: 'a', claude: 'b', chatgpt: 'b', heldOut: 'b' }
const RESULTS_FILE = /^results-[ab]-\w+\.json$/

export async function runScenario(driver: EvalDriver, scenario: Scenario, platform: Platform): Promise<ScenarioRun> {
  /** Each condition wait that reached its limit: what came after it ran on a world that was not ready. */
  const missed: Array<{ index: number; evidence: string[] }> = []
  try {
    await driver.start(scenario, platform)
    for (const [index, step] of scenario.steps.entries()) {
      if (step.kind !== 'wait') await driver.step(step)
      else if (step.until === undefined) await driver.settle(step.ms)
      else {
        const until = step.until
        await driver.settle(step.ms, () => condition(until, scenario, driver.seen()).holds)
        const after = condition(until, scenario, driver.seen())
        if (!after.holds) missed.push({ index, evidence: [`not held in ${step.ms} ms`, ...after.evidence] })
      }
    }
    await driver.settle(SETTLE_END_MS)
  } finally {
    await driver.stop()
  }
  // Read after stop: tier B measures its cost through the end of stop.
  const seen = driver.seen()
  const { tier } = driver
  const on = { tier, platform }
  const gaps = driver.gaps().map((reason) => ({ ...on, scenario: scenario.id, app: scenario.app, reason }))
  // A wrong send fails the run whatever else holds, so a gap does not hide one.
  const wrong = wrongSends(scenario, seen).map((w) => ({ ...on, ...w }))
  const score = (checks: readonly Check[]): CheckResult[] => gaps.length > 0 ? []
    : checks.flatMap((check) => evaluate(check, scenario, seen, tier, platform))
  // A missed wait costs the scenario's first dimension, so a run whose steps outran the dial never passes unseen.
  const waits: CheckResult[] = gaps.length > 0 ? [] : missed.map(({ index, evidence }) => ({ ...on, scenario: scenario.id,
    check: `wait.${index}`, app: scenario.app, dim: scenario.dims[0]!, heldOut: scenario.heldOut, score: 0, timed: false, evidence }))
  return { scenario: scenario.id, platform, results: [...score(scenario.checks), ...waits], probes: score(scenario.probes),
    wrongSends: wrong, gaps }
}

/** A probe is caught by a result below 1 that says what was seen; its id is its results' check up to the part. */
export function uncaughtProbes(run: ScenarioRun): string[] {
  const ids = new Map<string, boolean>()
  for (const r of run.probes) {
    const id = r.check.split('.')[0]!
    ids.set(id, (ids.get(id) ?? false) || (r.score < 1 && r.evidence.length > 0))
  }
  return [...ids].filter(([, caught]) => !caught).map(([id]) => id)
}

export function collect(runs: readonly ScenarioRun[]): RunResults {
  return { schema: 1, results: runs.flatMap((r) => r.results), wrongSends: runs.flatMap((r) => r.wrongSends),
    gaps: runs.flatMap((r) => r.gaps) }
}

/** Writes `results-<tier>-<source>.json` in dir; returns its path. */
export function writeResults(dir: string, source: Source, results: RunResults): string {
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `results-${TIER_OF[source]}-${source}.json`)
  writeFileSync(path, `${JSON.stringify(results, null, 2)}\n`)
  return path
}

/** Every results file in dir, merged in name order. */
export function readResults(dir: string): RunResults {
  const merged: RunResults = { schema: 1, results: [], wrongSends: [], gaps: [] }
  for (const name of readdirSync(dir).filter((n) => RESULTS_FILE.test(n)).sort()) {
    const file = JSON.parse(readFileSync(join(dir, name), 'utf8')) as RunResults
    if (file.schema !== 1) throw new Error(`${name}: results schema ${String(file.schema)}, not 1`)
    merged.results.push(...file.results)
    merged.wrongSends.push(...file.wrongSends)
    merged.gaps.push(...file.gaps)
  }
  return merged
}
