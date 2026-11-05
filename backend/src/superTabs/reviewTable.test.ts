import { describe, expect, it } from 'vitest'
import { globMatch, REVIEW_TABLE, reviewPlan, sharedFiles, type ReviewTable } from './reviewTable.js'

const names = (files: string[] | null, table?: ReviewTable) => reviewPlan(files, table).map(step => step.name)

describe('globMatch', () => {
  it('matches ** across folders, * and ? within one, ignoring case', () => {
    expect(globMatch('**/*auth*', 'backend/src/routes/Auth.ts')).toBe(true)
    expect(globMatch('**/*auth*', 'auth.ts')).toBe(true)
    expect(globMatch('desktop/**', 'desktop/lib/a/b.dart')).toBe(true)
    expect(globMatch('desktop/*', 'desktop/lib/b.dart')).toBe(false)
    expect(globMatch('docs/?.md', 'docs/a.md')).toBe(true)
    expect(globMatch('cli/**', 'backend/cli/x.ts')).toBe(false)
  })

  it('reads a dot or a bracket in a glob as itself', () => {
    expect(globMatch('**/a.ts', 'x/aXts')).toBe(false)
    expect(globMatch('**/[a].ts', 'x/[a].ts')).toBe(true)
  })
})

describe('reviewPlan', () => {
  it('gives a docs-only change one read', () => {
    expect(names(['docs/plans/x.md', 'README.md'])).toEqual(['Review'])
  })

  it('gives a sign-in change two security reviews, naming the area', () => {
    const plan = reviewPlan(['backend/src/routes/auth.ts', 'docs/x.md'])
    expect(plan.map(step => step.name)).toEqual(['Security review 1', 'Security review 2'])
    expect(plan.every(step => step.kind === 'security' && step.areas.includes('Sign-in'))).toBe(true)
  })

  it('gives each sensitive area of the table two security reviews', () => {
    for (const file of ['cli/src/lib/loginPage.ts', 'backend/src/github/holds.ts', 'cli/src/lib/e2ee/core.ts', 'backend/src/superTabs/machineAccess.ts',
      'cli/src/lib/buddyGuard.ts', 'cli/src/device/deviceLink.ts', 'backend/src/superTabs/purge.ts', 'cli/src/lib/worktreeDeletion.ts']) {
      expect(reviewPlan([file]).filter(step => step.kind !== 'test').map(step => step.name), file).toEqual(['Security review 1', 'Security review 2'])
    }
  })

  it('adds a test step where the change runs, and none for docs or tests alone', () => {
    const plan = reviewPlan(['desktop/lib/super_tabs/view.dart', 'cli/src/superTabs/route.ts'])
    expect(plan.map(step => step.name)).toEqual(['Review', 'Test'])
    expect(plan.find(step => step.kind === 'test')?.where).toEqual(['Desktop on a Mac', 'The CLI on a Mac and on a Linux machine'])
    expect(names(['desktop/test/super_tabs/view_test.dart', 'backend/src/superTabs/steps.test.ts', 'docs/a.md'])).toEqual(['Review'])
    expect(names(['backend/src/superTabs/steps.ts'])).toEqual(['Review'])
  })

  it('plans the strictest reads when the files could not be read', () => {
    const plan = reviewPlan(null)
    expect(plan.map(step => step.name)).toEqual(['Security review 1', 'Security review 2'])
    expect(plan[0]!.unread).toBe(true)
  })

  it('reads its numbers from the table it is given', () => {
    const table: ReviewTable = { defaultReads: 2, rows: [{ area: 'Billing', reads: 3, paths: ['billing/**'] }], test: [] }
    expect(names(['a.ts'], table)).toEqual(['Review 1', 'Review 2'])
    expect(names(['billing/x.ts'], table)).toEqual(['Security review 1', 'Security review 2', 'Security review 3'])
  })

  it('keeps one table, the seed of the project rules record', () => {
    expect(REVIEW_TABLE.defaultReads).toBe(1)
    expect(REVIEW_TABLE.rows.map(row => [row.area, row.reads])).toEqual(
      ['Sign-in', 'Tokens', 'Encryption', 'Access', 'Buddy guard', 'Device links', 'Deletion'].map(area => [area, 2]))
  })
})

describe('sharedFiles', () => {
  it('names only the files two pull requests of a batch both touch', () => {
    expect(sharedFiles([
      { url: 'a', files: ['x.ts', 'y.ts'] },
      { url: 'b', files: ['y.ts', 'z.ts'] },
      { url: 'c', files: ['w.ts'] },
    ])).toEqual([{ file: 'y.ts', urls: ['a', 'b'] }])
    expect(sharedFiles([{ url: 'a', files: ['x.ts'] }, { url: 'b', files: ['z.ts'] }])).toEqual([])
  })

  it('counts a pull request whose files were not read as touching everything', () => {
    expect(sharedFiles([{ url: 'a', files: null }, { url: 'b', files: ['z.ts'] }])).toEqual([{ file: '*', urls: ['a', 'b'] }])
  })
})
