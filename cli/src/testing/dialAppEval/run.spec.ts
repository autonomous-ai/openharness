// The eval command on a fake exec: each "vitest run" writes fixture results where the command told it to, so no
// test file, daemon or network is run.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
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
afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(dir, { recursive: true, force: true })
})

interface Call { cmd: string; args: string[]; out: string | undefined; env: NodeJS.ProcessEnv }
type Source = Parameters<typeof writeResults>[1]
const EMPTY: RunResults = { schema: 1, results: [], wrongSends: [], gaps: [] }

/**
 * A fake exec: tier A's run writes `a` as the spec's file, tier B's `b` as the Claude file and an empty ChatGPT and
 * held-out file (when `b` is given), save the sources `unwritten` names, and each exits with its code.
 */
function harness(written: { a?: RunResults; b?: RunResults },
  opts: { platform?: NodeJS.Platform; codes?: Partial<Record<Tier, number>>; unwritten?: Source[] } = {}) {
  const calls: Call[] = []
  const lines: string[] = []
  const deps = {
    out,
    baseline: baselinePath,
    platform: opts.platform ?? 'darwin',
    log: (line: string) => { lines.push(line) },
    async exec(cmd: string, args: string[], env: NodeJS.ProcessEnv): Promise<number> {
      calls.push({ cmd, args, out: env.DIAL_EVAL_OUT, env })
      const tier: Tier = args.includes('vitest.e2e.config.ts') ? 'b' : 'a'
      const file = written[tier]
      const files: Array<[Source, RunResults]> = tier === 'a' ? [['spec', file ?? EMPTY]] : [['claude', file ?? EMPTY], ['chatgpt', EMPTY], ['heldOut', EMPTY]]
      for (const [source, results] of files) {
        if (file && env.DIAL_EVAL_OUT && !opts.unwritten?.includes(source)) writeResults(env.DIAL_EVAL_OUT, source, results)
      }
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

it('a relative DIAL_EVAL_OUT reaches the tiers as the folder it names here, as they run in cli/', async () => {
  const h = harness({ a: results('a', 1) })
  expect(await main(['--tier', 'a'], { ...h.deps, out: relative(process.cwd(), out) })).toBe(0)
  expect(isAbsolute(h.calls[0]!.out!)).toBe(true)
  expect(h.calls[0]!.out).toBe(out)
})

it('the tiers get no proxy: their connections stay on this machine', async () => {
  const proxies = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'NODE_USE_ENV_PROXY']
  for (const name of proxies) vi.stubEnv(name, name === 'NODE_USE_ENV_PROXY' ? '1' : 'http://192.0.2.1:3128')
  const h = harness({ a: results('a', 1) })
  expect(await main(['--tier', 'a'], h.deps)).toBe(0)
  for (const name of proxies) expect(h.calls[0]!.env).not.toHaveProperty(name)
  expect(h.calls[0]!.env.PATH).toBe(process.env.PATH)
})

it('a report an earlier run left is gone before the tiers run', async () => {
  mkdirSync(out, { recursive: true })
  for (const name of ['report.json', 'report.md']) writeFileSync(join(out, name), 'earlier')
  const deps = { ...harness({}).deps, exec: async (_cmd: string, _args: string[], env: NodeJS.ProcessEnv) => {
    writeFileSync(join(env.DIAL_EVAL_OUT!, 'results-a-spec.json'), JSON.stringify({ schema: 2 }))
    return 0
  } }
  await expect(main(['--tier', 'a'], deps)).rejects.toThrow(/schema/)
  expect(existsSync(join(out, 'report.json'))).toBe(false)
  expect(existsSync(join(out, 'report.md'))).toBe(false)
})

// Making a symlink needs Developer Mode or an administrator on Windows.
it.skipIf(process.platform === 'win32')('runs when started through a symlink, as npm and a linked checkout start it', () => {
  const cli = fileURLToPath(new URL('../../..', import.meta.url))
  const link = join(dir, 'run.ts')
  symlinkSync(fileURLToPath(new URL('./run.ts', import.meta.url)), link)
  const started = spawnSync(process.execPath, [join(cli, 'node_modules', 'tsx', 'dist', 'cli.mjs'), link, '--tier', 'c'],
    { cwd: cli, encoding: 'utf8' })
  expect(started.stdout).toContain('usage: npm run eval:dial-apps')
  expect(started.status).toBe(2)
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

it('a low score exits 0', async () => {
  const h = harness({ a: results('a', 0), b: results('b', 0) })
  expect(await main([], h.deps)).toBe(0)
  expect(report().apps.claude.score).toBe(0)
})

it('a tier whose vitest fails exits 1, its report still written', async () => {
  const h = harness({ a: results('a', 1), b: results('b', 1) }, { codes: { a: 1 } })
  expect(await main([], h.deps)).toBe(1)
  expect(h.log()).toContain('tier a: vitest exited 1')
  expect(report().apps.claude.score).toBe(100)
})

it('the tiers skip their own ratchet: the command judges it from the merged results, and prints it, not fatal', async () => {
  writeBaseline({ schema: 1, checks: { 'a/darwin/C1/ring.recall': 1, 'b/darwin/C1/ring.recall': 1 }, apps: {} })
  const h = harness({ a: results('a', 0.5), b: results('b', 0) })
  expect(await main([], h.deps)).toBe(0)
  expect(h.calls.map((c) => c.env.DIAL_EVAL_SKIP_RATCHET)).toEqual(['1', '1'])
  expect(h.log()).toContain('tier A ratchet: regression: a/darwin/C1/ring.recall')
  expect(h.log()).toContain('tier B ratchet: regression: b/darwin/C1/ring.recall')
})

it('a results file a tier did not write exits 1, named', async () => {
  const h = harness({ a: results('a', 1), b: results('b', 1) }, { unwritten: ['heldOut'] })
  expect(await main([], h.deps)).toBe(1)
  expect(h.log()).toContain('results-b-heldOut.json was not written')
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

it('and refuses unless every tier passed and wrote every results file', async () => {
  const before = { schema: 1, checks: { 'a/darwin/C1/ring.recall': 0.5 }, apps: { a: { claude: 50, chatgpt: null } } } as const
  writeBaseline(before)
  const failed = harness({ a: results('a', 1), b: results('b', 1) }, { codes: { b: 1 } })
  expect(await main(['--update-baseline'], failed.deps)).toBe(1)
  expect(readBaseline()).toEqual(before)
  expect(failed.log()).toContain('no baseline written')
  const unwritten = harness({ a: results('a', 1), b: results('b', 1) }, { unwritten: ['chatgpt'] })
  expect(await main(['--update-baseline'], unwritten.deps)).toBe(1)
  expect(readBaseline()).toEqual(before)
})

it('and refuses to drop a check of a scenario the catalog still runs, with no gap, naming it', async () => {
  // C1 is still in the catalog: its order went missing. C99 is not: its check goes.
  const before = { schema: 1, checks: { 'a/darwin/C1/ring.order': 1, 'a/darwin/C1/ring.recall': 1, 'a/darwin/C99/ring.recall': 1 },
    apps: {} } as const
  writeBaseline(before)
  const h = harness({ a: results('a', 1) })
  expect(await main(['--tier', 'a', '--update-baseline'], h.deps)).toBe(1)
  expect(readBaseline()).toEqual(before)
  const refusal = h.lines.find((line) => line.startsWith('no baseline written'))
  expect(refusal).toContain('a/darwin/C1/ring.order')
  expect(refusal).not.toContain('C99')

  writeBaseline({ ...before, checks: { 'a/darwin/C1/ring.recall': 1, 'a/darwin/C99/ring.recall': 1 } })
  expect(await main(['--tier', 'a', '--update-baseline'], harness({ a: results('a', 1) }).deps)).toBe(0)
  expect(readBaseline().checks).toEqual({ 'a/darwin/C1/ring.recall': 1 })
})

it('a wrong send exits 1 without --update-baseline too', async () => {
  const h = harness({ a: results('a', 1, [wrongSend]), b: results('b', 1) })
  expect(await main([], h.deps)).toBe(1)
  expect(report().gate.passed).toBe(false)
})

it('tier B is not run on Windows, and the report says so and why', async () => {
  const h = harness({ a: results('a', 1), b: results('b', 1) }, { platform: 'win32' })
  expect(await main([], h.deps)).toBe(0)
  expect(h.calls.map((c) => c.args.slice(1))).toEqual([['run', ...TIER_A_FILES]])
  const why = 'tier B is not run on Windows: its e2e files run on macOS and Linux only'
  expect(h.log()).toContain(why)
  expect(report().skipped).toEqual([{ tier: 'b', reason: why }])
  expect(readFileSync(join(out, 'report.md'), 'utf8')).toContain(why)
  const only = harness({}, { platform: 'win32' })
  expect(await main(['--tier', 'b'], only.deps)).toBe(1)
  expect(only.calls).toEqual([])
})
