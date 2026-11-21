// The eval command on a fake exec: each "vitest run" writes fixture results where the command told it to, so no
// test file, daemon or network is run.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { main, parseArgs } from './run.js'
import { writeResults } from './runner.js'
import type { Baseline, CheckResult, Report, RunResults, Tier, WrongSend } from './types.js'

const TIER_A_FILES = ['src/testing/dialAppEval/dialAppEval.spec.ts']
const TIER_B_FILES = ['--config', 'vitest.e2e.config.ts', 'e2e/dialAppEvalClaude.e2e.ts', 'e2e/dialAppEvalChatgpt.e2e.ts',
  'e2e/dialAppEvalHeldOut.e2e.ts']

const result = (tier: Tier, score: number): CheckResult => ({
  tier, platform: 'darwin', scenario: 'C1', check: 'ring.recall', app: 'claude', dim: 'D1', heldOut: false,
  score, timed: false, evidence: [],
})
const results = (tier: Tier, score: number, wrongSends: WrongSend[] = []): RunResults =>
  ({ schema: 1, results: [result(tier, score)], wrongSends, gaps: [] })
const wrongSend: WrongSend = { tier: 'a', platform: 'darwin', scenario: 'C8', target: 'a', got: 'b', path: 'mod', at: 900 }

let dir = ''
let out = ''
let baselinePath = ''
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dial-eval-run-'))
  out = join(dir, 'out')
  baselinePath = join(dir, 'baseline.json')
})
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

interface Call { cmd: string; args: string[]; out: string | undefined }

/** A fake exec: tier A's run writes `a`, tier B's `b` (when given), and each exits with its code. */
function harness(written: { a?: RunResults; b?: RunResults }, opts: { platform?: NodeJS.Platform; codes?: Partial<Record<Tier, number>> } = {}) {
  const calls: Call[] = []
  const lines: string[] = []
  const deps = {
    out,
    baseline: baselinePath,
    platform: opts.platform ?? 'darwin',
    log: (line: string) => { lines.push(line) },
    async exec(cmd: string, args: string[], env: NodeJS.ProcessEnv): Promise<number> {
      calls.push({ cmd, args, out: env.DIAL_EVAL_OUT })
      const tier: Tier = args.includes('vitest.e2e.config.ts') ? 'b' : 'a'
      const file = written[tier]
      if (file && env.DIAL_EVAL_OUT) writeResults(env.DIAL_EVAL_OUT, tier === 'a' ? 'spec' : 'claude', file)
      return opts.codes?.[tier] ?? 0
    },
  }
  return { deps, calls, lines, log: () => lines.join('\n') }
}

const report = (): Report => JSON.parse(readFileSync(join(out, 'report.json'), 'utf8')) as Report
const writeBaseline = (b: Baseline): void => { writeFileSync(baselinePath, JSON.stringify(b)) }
const readBaseline = (): Baseline => JSON.parse(readFileSync(baselinePath, 'utf8')) as Baseline

it('argument errors name the usage', async () => {
  expect(parseArgs([])).toEqual({ tiers: ['a', 'b'], update: false })
  expect(parseArgs(['--tier', 'b', '--update-baseline'])).toEqual({ tiers: ['b'], update: true })
  for (const argv of [['--tier', 'c'], ['--tier'], ['--fast'], ['a']]) {
    expect(() => parseArgs(argv)).toThrow('usage: npm run eval:dial-apps -- [--tier a|b] [--update-baseline]')
  }
  const h = harness({})
  expect(await main(['--tier', 'c'], h.deps)).toBe(2)
  expect(h.log()).toContain('usage: npm run eval:dial-apps')
  expect(h.calls).toEqual([])
})

it('tier a then b, merged into one report in DIAL_EVAL_OUT', async () => {
  const h = harness({ a: results('a', 1), b: results('b', 0.5) })
  expect(await main([], h.deps)).toBe(0)
  expect(h.calls.map((c) => [c.cmd, c.args.slice(1), c.out])).toEqual([
    [process.execPath, ['run', ...TIER_A_FILES], out],
    [process.execPath, ['run', ...TIER_B_FILES], out],
  ])
  expect(h.calls[0]!.args[0]).toMatch(/vitest\.mjs$/)
  expect(report().byTier.a.claude.dims.D1).toBe(100)
  expect(report().byTier.b.claude.dims.D1).toBe(50)
  expect(existsSync(join(out, 'report.md'))).toBe(true)
  expect(h.log()).toContain('Dial eval (target 95)')
  expect(h.log()).toContain(out)
})

it('a new temp folder when DIAL_EVAL_OUT is not given, printed', async () => {
  const h = harness({ a: results('a', 1) })
  const { out: _given, ...deps } = h.deps
  expect(await main(['--tier', 'a'], deps)).toBe(0)
  const used = h.calls[0]!.out!
  try {
    expect(used.startsWith(tmpdir())).toBe(true)
    expect(existsSync(join(used, 'report.json'))).toBe(true)
    expect(h.log()).toContain(used)
  } finally {
    rmSync(used, { recursive: true, force: true })
  }
})

it('--tier b runs only the e2e files', async () => {
  const h = harness({ a: results('a', 1), b: results('b', 1) })
  expect(await main(['--tier', 'b'], h.deps)).toBe(0)
  expect(h.calls.map((c) => c.args.slice(1))).toEqual([['run', ...TIER_B_FILES]])
  expect(report().byTier.a.claude.score).toBeNull()
})

it('a tier with no results exits 1', async () => {
  const h = harness({ a: results('a', 1) })
  expect(await main([], h.deps)).toBe(1)
  expect(h.log()).toContain('tier b wrote no results')
})

it('results an earlier run left in DIAL_EVAL_OUT are not read', async () => {
  writeResults(out, 'claude', results('b', 1))
  const h = harness({ a: results('a', 1) })
  expect(await main([], h.deps)).toBe(1)
  expect(h.log()).toContain('tier b wrote no results')
  expect(report().byTier.b.claude.score).toBeNull()
})

it('a low score exits 0, and a tier\'s own failure is printed, not fatal', async () => {
  const h = harness({ a: results('a', 0), b: results('b', 0) }, { codes: { a: 1 } })
  expect(await main([], h.deps)).toBe(0)
  expect(report().apps.claude.score).toBe(0)
  expect(h.log()).toContain('tier a: vitest exited 1')
})

it('--update-baseline writes the baseline, keeping the tier not run', async () => {
  writeBaseline({ schema: 1, checks: { 'a/darwin/C1/ring.recall': 0.5, 'b/darwin/C1/ring.recall': 0.5 },
    apps: { a: { claude: 50, chatgpt: null }, 'b/darwin': { claude: 50, chatgpt: null } } })
  const h = harness({ a: results('a', 1) })
  expect(await main(['--tier', 'a', '--update-baseline'], h.deps)).toBe(0)
  expect(readBaseline()).toEqual({ schema: 1, checks: { 'a/darwin/C1/ring.recall': 1, 'b/darwin/C1/ring.recall': 0.5 },
    apps: { a: { claude: 100, chatgpt: null }, 'b/darwin': { claude: 50, chatgpt: null } } })
  expect(h.log()).toContain(`baseline written: ${baselinePath}`)
})

it('and refuses on a wrong send', async () => {
  const before = { schema: 1, checks: { 'a/darwin/C1/ring.recall': 0.5 }, apps: { a: { claude: 50, chatgpt: null } } } as const
  writeBaseline(before)
  const h = harness({ a: results('a', 1, [wrongSend]) })
  expect(await main(['--tier', 'a', '--update-baseline'], h.deps)).toBe(1)
  expect(readBaseline()).toEqual(before)
  expect(h.log()).toContain('a voice prompt reached another session: stop and ask the PM before a baseline is written')
})

it('a wrong send exits 1 without --update-baseline too', async () => {
  const h = harness({ a: results('a', 1, [wrongSend]), b: results('b', 1) })
  expect(await main([], h.deps)).toBe(1)
  expect(report().gate.passed).toBe(false)
})

it('tier B is not run on Windows', async () => {
  const h = harness({ a: results('a', 1), b: results('b', 1) }, { platform: 'win32' })
  expect(await main([], h.deps)).toBe(0)
  expect(h.calls.map((c) => c.args.slice(1))).toEqual([['run', ...TIER_A_FILES]])
  expect(h.log()).toContain('tier B is not run on Windows')
  const only = harness({}, { platform: 'win32' })
  expect(await main(['--tier', 'b'], only.deps)).toBe(1)
  expect(only.calls).toEqual([])
})
