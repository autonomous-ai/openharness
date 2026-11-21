/**
 * `npm run eval:dial-apps`: runs tier A's spec, then tier B's e2e files, each writing its results to DIAL_EVAL_OUT, then
 * grades them together into one report (docs/plans/2026-11-21-dial-app-eval-design.md, "One command").
 */
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { BASELINE_PATH, grade, loadBaseline, updateBaseline } from './grade.js'
import { summary, writeReport } from './report.js'
import { readResults } from './runner.js'
import type { RunResults, Tier } from './types.js'

const USAGE = 'usage: npm run eval:dial-apps -- [--tier a|b] [--update-baseline]'
const CLI_DIR = fileURLToPath(new URL('../../..', import.meta.url))
// Node runs Vitest's entry itself: `npx` is a .cmd on Windows, which needs a shell to start.
const VITEST = join(CLI_DIR, 'node_modules', 'vitest', 'vitest.mjs')
const FILES: Record<Tier, string[]> = {
  a: ['src/testing/dialAppEval/dialAppEval.spec.ts'],
  b: ['--config', 'vitest.e2e.config.ts', 'e2e/dialAppEvalClaude.e2e.ts', 'e2e/dialAppEvalChatgpt.e2e.ts',
    'e2e/dialAppEvalHeldOut.e2e.ts'],
}
const NO_TIER_B_ON_WINDOWS = 'tier B is not run on Windows: its e2e files run on macOS and Linux only'
const WRONG_SEND = 'a voice prompt reached another session: stop and ask the PM before a baseline is written'

export interface EvalDeps {
  exec(cmd: string, args: string[], env: NodeJS.ProcessEnv): Promise<number>
  /** Where the tiers write their results and the report goes; a new temp folder when not given. */
  out?: string
  /** For this command's tests: the committed baseline otherwise. */
  baseline?: string
  platform: NodeJS.Platform
  log(line: string): void
}

export function parseArgs(argv: string[]): { tiers: Tier[]; update: boolean } {
  let tiers: Tier[] = ['a', 'b']
  let update = false
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--update-baseline') update = true
    else if (arg === '--tier' && (argv[i + 1] === 'a' || argv[i + 1] === 'b')) tiers = [argv[++i] as Tier]
    else throw new Error(USAGE)
  }
  return { tiers, update }
}

const ran = (results: RunResults, tier: Tier): boolean =>
  results.results.some((r) => r.tier === tier) || results.gaps.some((g) => g.tier === tier)

export async function main(argv: string[], deps: EvalDeps): Promise<number> {
  let args: ReturnType<typeof parseArgs>
  try {
    args = parseArgs(argv)
  } catch (error) {
    deps.log((error as Error).message)
    return 2
  }
  const tiers = deps.platform === 'win32' ? args.tiers.filter((t) => t !== 'b') : args.tiers
  const skipsB = tiers.length < args.tiers.length
  if (tiers.length === 0) {
    deps.log(NO_TIER_B_ON_WINDOWS)
    return 1
  }

  const out = deps.out ?? mkdtempSync(join(tmpdir(), 'dial-eval-'))
  mkdirSync(out, { recursive: true })
  // An earlier run's results would count as this run's, and hide a tier that wrote none.
  for (const name of readdirSync(out)) if (/^results-.*\.json$/.test(name)) rmSync(join(out, name))
  deps.log(`results and report: ${out}`)

  for (const tier of tiers) {
    // A tier's spec fails on its own ratchet; the report says what changed, so that is not fatal here.
    const code = await deps.exec(process.execPath, [VITEST, 'run', ...FILES[tier]], { ...process.env, DIAL_EVAL_OUT: out })
    if (code !== 0) deps.log(`tier ${tier}: vitest exited ${code}`)
  }

  const results = readResults(out)
  const baselinePath = deps.baseline ?? BASELINE_PATH
  const baseline = loadBaseline(baselinePath)
  const report = grade(results, baseline)
  deps.log(summary(report))
  if (skipsB) deps.log(NO_TIER_B_ON_WINDOWS)
  writeReport(out, report)

  const missing = tiers.filter((t) => !ran(results, t))
  for (const tier of missing) deps.log(`tier ${tier} wrote no results`)
  const code = missing.length > 0 || !report.gate.passed ? 1 : 0
  if (args.update) {
    if (!report.gate.passed) deps.log(WRONG_SEND)
    else if (code !== 0) deps.log('no baseline written: a tier wrote no results')
    else {
      writeFileSync(baselinePath, `${JSON.stringify(updateBaseline(baseline, results, tiers), null, 2)}\n`)
      deps.log(`baseline written: ${baselinePath}`)
    }
  }
  return code
}

const realDeps: EvalDeps = {
  exec: (cmd, args, env) => new Promise((done, fail) => {
    const child = spawn(cmd, args, { cwd: CLI_DIR, env, stdio: 'inherit' })
    child.once('error', fail)
    child.once('exit', (code) => done(code ?? 1))
  }),
  ...(process.env.DIAL_EVAL_OUT ? { out: process.env.DIAL_EVAL_OUT } : {}),
  platform: process.platform,
  log: (line) => { console.log(line) },
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2), realDeps)
}
