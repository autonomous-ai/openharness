import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { grade } from './grade.js'
import { markdown, summary, writeReport } from './report.js'
import type { App, AppScores, CheckResult, Dimension, Report } from './types.js'

const none: Record<Dimension, number | null> = {
  D1: null, D2: null, D3: null, D4: null, D5: null, D6: null, D7: null, D8: null,
}
/** Dimension scores 0-100, as the grader gives them. */
const scores = (score: number | null, dims: Partial<Record<Dimension, number>> = {}, leftOut = 0): AppScores =>
  ({ score, dims: { ...none, ...dims }, leftOut })
const both = (claude: AppScores, chatgpt: AppScores): Record<App, AppScores> => ({ claude, chatgpt })

const failing = (evidence: string[]): CheckResult & { pointsLost: number } => ({
  tier: 'a', platform: 'darwin', scenario: 'C1', check: 'ring.recall', app: 'claude', dim: 'D1', heldOut: false,
  score: 0, timed: false, evidence, pointsLost: 18.75,
})

function report(over: Partial<Report> = {}): Report {
  return {
    schema: 1,
    apps: both(scores(80, { D1: 50, D5: 100 }, 2), scores(90, { D1: 100 }, 0)),
    heldOut: both(scores(70, { D2: 70 }), scores(null)),
    byTier: { a: both(scores(80, {}, 2), scores(90)), b: both(scores(null), scores(null)) },
    byPlatform: { 'a/darwin': both(scores(81, {}, 1), scores(91)) },
    gate: { passed: true, wrongSends: [] },
    failing: [],
    groups: [{ app: 'claude', dim: 'D1', scenario: 'C1', pointsLost: 18.75, checks: ['ring.recall'] }],
    gaps: [],
    delta: { apps: { a: { claude: { before: 75, after: 80 }, chatgpt: { before: null, after: 90 } } }, checks: [] },
    ...over,
  }
}

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

it('the table shows — for a dimension with no check', () => {
  const claudeRow = summary(report()).split('\n').find((line) => line.includes('the Claude app') && line.includes('80'))
  expect(claudeRow).toBeDefined()
  // D1 50, D5 100, the six others —.
  expect(claudeRow!.match(/—/g)).toHaveLength(6)
  expect(markdown(report())).toMatch(/\| the Claude app \| 50 \| — \| — \| — \| 100 \| — \| — \| — \| 80 \|/)
})

it('a dimension shows the grader\'s 0-100 as it is', () => {
  const result: CheckResult = { tier: 'a', platform: 'darwin', scenario: 'C1', check: 'ring.recall', app: 'claude', dim: 'D1',
    heldOut: false, score: 1, timed: false, evidence: [] }
  const graded = grade({ schema: 1, results: [result], wrongSends: [], gaps: [] }, null)
  expect(markdown(graded)).toMatch(/\| the Claude app \| 100 \| — \| — \| — \| — \| — \| — \| — \| 100 \|/)
  expect(summary(graded)).not.toContain('10000')
})

it('each app\'s score shows its runs left out beside it', () => {
  for (const text of [summary(report()), markdown(report())]) {
    expect(text).toMatch(/80[^\n]*left out: 2/)
    expect(text).toMatch(/90[^\n]*left out: 0/)
    expect(text).toMatch(/a\/darwin[^\n]*81[^\n]*left out: 1/)
    expect(text).toContain('95')
  }
})

it('held-out is its own table', () => {
  const md = markdown(report())
  const heldOut = md.slice(md.indexOf('## Held out'))
  expect(md.indexOf('## Held out')).toBeGreaterThan(md.indexOf('## Scores'))
  expect(heldOut).toMatch(/\| the Claude app \| — \| 70 \|/)
  expect(md.slice(md.indexOf('## Scores'), md.indexOf('## Held out'))).not.toMatch(/\b70\b/)
})

it('a wrong send is listed by keys and path, never by text', () => {
  const r = report({
    gate: { passed: false, wrongSends: [
      { tier: 'b', platform: 'linux', scenario: 'C9', target: 'c-a', got: 'c-b', path: 'mod', at: 1200 },
      { tier: 'a', platform: 'darwin', scenario: 'X2', target: 'x-a', got: null, path: 'typed', at: 300 },
    ] },
  })
  for (const text of [summary(r), markdown(r)]) {
    expect(text).toMatch(/gate: failed/i)
    expect(text).toMatch(/C9[^\n]*linux[^\n]*c-a[^\n]*c-b[^\n]*mod/)
    expect(text).toMatch(/X2[^\n]*darwin[^\n]*x-a[^\n]*none[^\n]*typed/)
  }
})

it('evidence holding os.tmpdir(), HOME or a /work/eval- folder is printed with that part replaced by <path>', () => {
  const r = report({
    failing: [failing([
      `command open ${join(tmpdir(), 'eval-x1', 'link')}`,
      `read ${join(homedir(), '.claude', 'store.json')} twice`,
      'frame agent cwd=/work/eval-alpha/sub title',
    ])],
    gaps: [{ tier: 'a', platform: 'linux', scenario: 'C3', app: 'claude', heldOut: false, reason: `platform read in ${homedir()}/x.ts` }],
  })
  const dir = mkdtempSync(join(tmpdir(), 'report-spec-'))
  dirs.push(dir)
  const written = writeReport(dir, r)
  for (const text of [summary(r), markdown(r), readFileSync(written.json, 'utf8'), readFileSync(written.md, 'utf8')]) {
    expect(text).toContain('command open <path>')
    expect(text).toContain('read <path> twice')
    expect(text).toContain('frame agent cwd=<path> title')
    expect(text).toContain('platform read in <path>')
    expect(text).not.toContain(tmpdir())
    expect(text).not.toContain(homedir())
    expect(text).not.toContain('/work/eval-')
  }
})

it('the delta gives each subset\'s app scores, before and after', () => {
  for (const text of [summary(report()), markdown(report())]) {
    expect(text).toContain('- a, the Claude app: 75 → 80')
    expect(text).toContain('- a, the ChatGPT app: — → 90')
  }
})

it('writeReport writes report.json and report.md', () => {
  const dir = mkdtempSync(join(tmpdir(), 'report-spec-'))
  dirs.push(dir)
  const r = report()
  const written = writeReport(join(dir, 'out'), r)
  expect(written).toEqual({ json: join(dir, 'out', 'report.json'), md: join(dir, 'out', 'report.md') })
  expect(JSON.parse(readFileSync(written.json, 'utf8'))).toEqual(r)
  expect(readFileSync(written.md, 'utf8')).toBe(markdown(r))
})
