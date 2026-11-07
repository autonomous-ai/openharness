import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { checkPrHistory } from './prHistory.js'

const sha = (n: number) => n.toString(16).padStart(40, '0')
const file = (filename: string, additions = 1, deletions = 0, extra = {}) => ({ filename, additions, deletions, status: 'added', ...extra })
const commit = (n: number, files: ReturnType<typeof file>[], parents = [sha(n - 1)]) => ({ sha: sha(n), parents, files })
const plan = file('docs/plans/2026-11-06-example-plan.md')
const test = file('backend/src/example.test.ts', 7)
const code = file('backend/src/example.ts', 12, 3)
const good = () => ({ head: sha(3), commits: [commit(1, [plan]), commit(2, [test]), commit(3, [code])], files: [plan, test, code] })

describe('PR history checks', () => {
  it('reports a plan first, prior test-only commit and net production size', () => {
    expect(checkPrHistory(good())).toMatchObject({ planFirst: 'pass', testBeforeCode: 'pass', productionLines: 15, totalLines: 23,
      commits: 3, missingTests: [] })
  })

  it.each([
    { commits: [commit(1, [code]), commit(2, [plan]), commit(3, [test])] },
    { commits: [commit(1, [plan, test]), commit(2, [test]), commit(3, [code])] },
    { commits: [commit(1, [file(plan.filename, 1, 0, { status: 'modified' })]), commit(2, [test]), commit(3, [code])] },
  ])('does not accept a late, mixed or pre-existing plan', ({ commits }) => {
    expect(checkPrHistory({ ...good(), commits }).planFirst).toBe('fail')
  })

  it('does not treat tests in the implementation commit or later as prior tests', () => {
    const together = { ...good(), head: sha(2), commits: [commit(1, [plan]), commit(2, [test, code])] }
    expect(checkPrHistory(together)).toMatchObject({ testBeforeCode: 'fail', missingTests: [sha(2)] })
    const late = { ...good(), commits: [commit(1, [plan]), commit(2, [code]), commit(3, [test])] }
    expect(checkPrHistory(late)).toMatchObject({ testBeforeCode: 'fail', missingTests: [sha(2)] })
  })

  it('needs another test-only commit before another production commit', () => {
    const input = { ...good(), head: sha(4), commits: [...good().commits, commit(4, [code])] }
    expect(checkPrHistory(input)).toMatchObject({ testBeforeCode: 'fail', missingTests: [sha(4)] })
  })

  it('does not borrow a test from a sibling branch', () => {
    const input = { ...good(), commits: [commit(1, [plan]), commit(2, [test]), commit(3, [code], [sha(1)])] }
    expect(checkPrHistory(input)).toMatchObject({ testBeforeCode: 'fail', missingTests: [sha(3)] })
  })

  it('reports docs-only changes as not needing production ordering', () => {
    expect(checkPrHistory({ head: sha(1), commits: [commit(1, [file('README.md')])], files: [file('README.md')] }))
      .toMatchObject({ planFirst: 'not-needed', testBeforeCode: 'not-needed', productionLines: 0, totalLines: 1 })
  })

  it('flags merges for a resolution read rather than declaring their test order passed', () => {
    expect(checkPrHistory({ ...good(), head: sha(4), commits: [...good().commits, commit(4, [code], [sha(3), sha(99)])] }))
      .toMatchObject({ planFirst: 'pass', testBeforeCode: 'unknown', merges: 1 })
  })

  it('classifies both sides of a rename and does not count repeated commit churn as net size', () => {
    const renamed = file('docs/example.md', 4, 2, { status: 'renamed', previousFilename: 'backend/src/example.ts' })
    expect(checkPrHistory({ ...good(), files: [renamed] })).toMatchObject({ productionLines: 6, totalLines: 6 })
    expect(checkPrHistory({ ...good(), head: sha(5), commits: [...good().commits, commit(4, [test]), commit(5, [code])] }).productionLines).toBe(15)
  })

  it.each([null, {}, { ...good(), commits: [] }, { ...good(), head: sha(9) },
    { ...good(), commits: [...good().commits].reverse() }, { ...good(), files: [file('x.ts', -1)] },
    { ...good(), files: Array.from({ length: 301 }, () => code) },
    { ...good(), commits: Array.from({ length: 51 }, (_, n) => commit(n + 1, [test])) },
  ])('never passes malformed, missing or excessive input', input => {
    expect(checkPrHistory(input)).toMatchObject({ planFirst: 'unknown', testBeforeCode: 'unknown', productionLines: null })
  })

  it('runs the scripts entry point on sample JSON without executing repository code', () => {
    const script = fileURLToPath(new URL('../../../scripts/check-pr-history.ts', import.meta.url))
    const output = execFileSync(process.execPath, ['--import', import.meta.resolve('tsx'), script],
      { input: JSON.stringify(good()), encoding: 'utf8', timeout: 10_000, windowsHide: true })
    expect(JSON.parse(output)).toMatchObject({ planFirst: 'pass', testBeforeCode: 'pass', productionLines: 15 })
  })
})
