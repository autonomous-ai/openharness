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
    // Task #3602: a test that runs on a Mac and a Linux machine is one step per OS; one OS is that step's.
    const plan = reviewPlan(['desktop/lib/super_tabs/view.dart', 'cli/src/superTabs/route.ts'])
    expect(plan.map(step => [step.name, step.os ?? null])).toEqual([['Review', null], ['Test on a Mac', 'mac'], ['Test on a Linux machine', 'linux'], ['Test on Windows', 'windows']])
    expect(plan.find(step => step.kind === 'test')?.where).toEqual(['Desktop on a Mac', 'The CLI on a Mac and on a Linux machine'])
    expect(reviewPlan(['desktop/lib/a.dart']).map(step => [step.name, step.os ?? null])).toEqual([['Review', null], ['Test', 'mac'], ['Test on Windows', 'windows']])
    expect(reviewPlan(['mobile/lib/a.dart']).map(step => [step.name, step.os ?? null])).toEqual([['Review', null], ['Test', null]])
    expect(names(['desktop/test/super_tabs/view_test.dart', 'backend/src/superTabs/steps.test.ts', 'docs/a.md'])).toEqual(['Review'])
    expect(names(['backend/src/superTabs/steps.ts'])).toEqual(['Review'])
  })


  // Removing Windows detection must leave these Ready flows without their required test.
  it.each([
    'desktop/lib/super_tabs/view.dart', 'desktop/windows/runner/main.cpp', 'desktop/pubspec.yaml',
    'cli/src/services/process.ts', 'cli/src/lib/daemonLaunch.ts', 'cli/src/lib/path.ts',
    'cli/src/superTabs/buddyHome.ts', 'cli/src/team/autoSetup.ts', 'cli/src/team/windowsScript.ts',
    'cli/src/lib/windows/noWindow.ts', 'cli/src/lib/machineResources.ts',
  ])('requires Windows for %s even with saved rules predating Windows', file => {
    const windows = reviewPlan([file], structuredClone(SEED_RULES)).filter(step => step.os === 'windows')
    expect(windows).toHaveLength(1)
    expect(windows[0]).toMatchObject({ name: 'Test on Windows', kind: 'test' })
  })

  it.each([
    'docs/windows-rules.md', 'backend/src/superTabs/steps.ts', 'cli/README.md',
    'desktop/test/view_test.dart', 'cli/src/lib/daemonLaunch.spec.ts', 'cli/src/lib/__fixtures__/process.ts',
    'desktop/macos/Runner/MainFlutterWindow.swift', 'desktop/lib/core/mac_responsibility_probe_native.dart',
    'desktop/lib/core/linux_app_image.dart', 'cli/src/lib/macosProcessGpu.ts',
    'cli/src/team/script.ts', 'cli/src/team/nodeTools.ts', 'cli/src/team/tmux.ts',
  ])('does not require Windows for docs, tests or platform-only code: %s', file => {
    expect(reviewPlan([file]).filter(step => step.os === 'windows')).toEqual([])
  })

  it('keeps custom test places and emits only one Windows step when the rules already request Windows', () => {
    const rules: ProjectRules = { ...SEED_RULES, reviews: { ...SEED_RULES.reviews,
      test: [{ where: 'Desktop on Windows', paths: ['desktop/**'] }, { where: 'Staging', paths: ['desktop/**'] }] } }
    const plan = reviewPlan(['desktop/lib/view.dart'], rules)
    expect(plan.filter(step => step.os === 'windows')).toHaveLength(1)
    expect(plan.find(step => step.os === 'windows')).toMatchObject({ name: 'Test on Windows', where: ['Desktop on Windows', 'Staging'] })
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
  it('names each pull request at its own whole head and base branch', () => {
    const [step] = reviewPlan(['docs/a.md'])
    const [h7, h8] = ['abc1234'.padEnd(40, '0'), 'def5678'.padEnd(40, '0')]
    const brief = stepBrief(step!, { number: 9, title: 'Fix', pulls: [
      { url: 'https://github.com/acme/app/pull/7', head: h7, base: 'main' },
      { url: 'https://github.com/acme/app/pull/8', head: h8, base: 'release' }] })
    expect(brief).toContain(`https://github.com/acme/app/pull/7 at head ${h7} on base main, https://github.com/acme/app/pull/8 at head ${h8} on base release`)
  })

  // Task #3540: a verdict counts only at the exact head and base it read (#3394), so the brief asks for both, as the role sheets do.
  it('asks every kind of step to record its verdict at the head (whole commit id) and base branch it read', () => {
    for (const step of [...reviewPlan(['backend/src/routes/auth.ts', 'desktop/lib/a.dart']), ...reviewPlan(['docs/a.md']), ...reviewPlan(null)]) {
      const brief = stepBrief(step, { number: 9, title: 'Fix', pulls: [{ url: 'https://github.com/acme/app/pull/7', head: null, base: null }] })
      expect(brief, step.name).toContain('at the pull request head (whole commit id) and base branch you read')
    }
  })
})
