import { describe, expect, it } from 'vitest'
import { SEED_RULES, type ProjectRules } from './policy.js'
import { reviewPlan, sharedFiles, stepBrief } from './reviewTable.js'

const names = (files: string[] | null, rules?: ProjectRules) => reviewPlan(files, rules).map(step => step.name)

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

  it('reads its numbers from the project rules it is given', () => {
    const rules: ProjectRules = { ...SEED_RULES, reviews: { defaultReads: 2, rows: [{ area: 'Billing', reads: 3, paths: ['billing/**'] }],
      test: [{ where: 'Staging', paths: ['web/**'] }], untested: ['**/*.md'] } }
    expect(names(['a.ts'], rules)).toEqual(['Review 1', 'Review 2'])
    expect(names(['billing/x.ts'], rules)).toEqual(['Security review 1', 'Security review 2', 'Security review 3'])
    expect(reviewPlan(['web/a.ts'], rules).at(-1)).toMatchObject({ name: 'Test', where: ['Staging'] })
    expect(names(['web/a.md'], rules)).toEqual(['Review 1', 'Review 2'])
  })

  it('reads the project rules seed when given none', () => {
    expect(reviewPlan(['backend/src/routes/auth.ts'])).toEqual(reviewPlan(['backend/src/routes/auth.ts'], SEED_RULES))
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

// Security review 2 of #3227 (Elm, minor): each pull request's own list was pinned to its own head; the brief says so.
describe('stepBrief', () => {
  it('names each pull request with its own head', () => {
    const [step] = reviewPlan(['docs/a.md'])
    const brief = stepBrief(step!, { number: 9, title: 'Fix', pulls: [
      { url: 'https://github.com/acme/app/pull/7', head: 'abc1234'.padEnd(40, '0') },
      { url: 'https://github.com/acme/app/pull/8', head: 'def5678'.padEnd(40, '0') }] })
    expect(brief).toContain('https://github.com/acme/app/pull/7 at head abc1234, https://github.com/acme/app/pull/8 at head def5678')
  })
})
