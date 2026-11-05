import { describe, expect, it } from 'vitest'
import type { Check, Conversation } from '../model.js'
import { componentOf, eligible, headReads, laneOf, splitRed, type TrainCandidate, type TrainTask } from './plan.js'
import { requiredReads, SEED_RULES } from '../policy.js'

const URL = 'https://github.com/acme/app/pull/7'
const HEAD = 'a'.repeat(40), OLD = 'b'.repeat(40)

const check = (verdicts: Array<{ passed: boolean; head?: string; patch?: string | null; stale?: unknown; pullRequest?: string; base?: string }>): Check => ({
  id: 'c1', description: 'Review', independent: true, evidence: null, passedBy: null,
  verdicts: verdicts.map((v, i) => ({ by: `agent:r${i}`, evidence: 'read', at: 1, pullRequest: URL, base: 'main', ...v })) as Check['verdicts'],
})
const step = (checks: Check[], over: Partial<Conversation> = {}): TrainTask['steps'][number] => ({
  step: 'Review', title: 'Review', checks, archived: false, assignment: { status: 'done' } as Conversation['assignment'], ...over,
})
const task = (over: Partial<TrainTask> = {}): TrainTask => ({
  checks: [check([{ passed: true, head: HEAD }])],
  pullRequestHeads: { [URL]: { head: HEAD, patch: 'p1', at: 1, base: 'main' } },
  steps: [step([check([{ passed: true, head: HEAD }])])],
  ...over,
})
const candidate = (over: Partial<TrainCandidate> = {}): TrainCandidate => ({
  url: URL, number: 7, head: HEAD, state: 'open', draft: false, base: 'main', mergeable: true, labels: [], files: ['backend/src/a.ts'],
  ciRequired: 'success', ...over,
})

describe('headReads', () => {
  it('counts passes recorded at the head GitHub shows now', () => {
    expect(headReads(task(), URL, HEAD, 'main')).toBe(1)
  })
  it('refuses a pass at an older head with another patch', () => {
    const t = task({ steps: [step([check([{ passed: true, head: OLD, patch: 'p0' }])])] })
    expect(headReads(t, URL, HEAD, 'main')).toBe(null)
  })
  it('keeps a pass at an older head whose patch is the same (a plain rebase)', () => {
    const t = task({ steps: [step([check([{ passed: true, head: OLD, patch: 'p1' }])])] })
    expect(headReads(t, URL, HEAD, 'main')).toBe(1)
  })
  it('never counts a pass with no head, though old clients still count it', () => {
    const t = task({ steps: [step([check([{ passed: true }])])] })
    expect(headReads(t, URL, HEAD, 'main')).toBe(null)
  })
  it('never counts a stale pass, or one on another pull request', () => {
    expect(headReads(task({ steps: [step([check([{ passed: true, head: HEAD, stale: { head: OLD } }])])] }), URL, HEAD, 'main')).toBe(null)
    expect(headReads(task({ steps: [step([check([{ passed: true, head: HEAD, pullRequest: 'https://github.com/acme/app/pull/8' }])])] }), URL, HEAD, 'main')).toBe(null)
  })
  it('refuses when the watch has not seen this head yet', () => {
    expect(headReads(task({ pullRequestHeads: { [URL]: { head: OLD, patch: 'p1', at: 1, base: 'main' } } }), URL, HEAD, 'main')).toBe(null)
    expect(headReads(task({ pullRequestHeads: undefined }), URL, HEAD, 'main')).toBe(null)
  })
  it('refuses a failure at the head next to a pass', () => {
    const t = task({ steps: [step([check([{ passed: true, head: HEAD }, { passed: false, head: HEAD }])])] })
    expect(headReads(t, URL, HEAD, 'main')).toBe(null)
  })
  it('needs a review step, every open step done, and the task checks too', () => {
    expect(headReads(task({ steps: [] }), URL, HEAD, 'main')).toBe(null)
    expect(headReads(task({ steps: [step([check([{ passed: true, head: HEAD }])], { step: 'Test', title: 'Test' })] }), URL, HEAD, 'main')).toBe(null)
    expect(headReads(task({ steps: [...task().steps, step([check([{ passed: true, head: HEAD }])], { step: 'Test', title: 'Test', assignment: { status: 'working' } as Conversation['assignment'] })] }), URL, HEAD, 'main')).toBe(null)
    expect(headReads(task({ steps: [...task().steps, step([], { step: 'Test', title: 'Test' })] }), URL, HEAD, 'main')).toBe(null)
    expect(headReads(task({ checks: [check([{ passed: true, head: OLD, patch: 'p0' }])] }), URL, HEAD, 'main')).toBe(null)
  })
  it('counts each reviewer once, over every review step passed at the head', () => {
    const two = step([check([{ passed: true, head: HEAD }])], { step: 'Security review 2', title: 'Security review 2' })
    two.checks[0]!.verdicts![0]!.by = 'agent:other'
    expect(headReads(task({ steps: [...task().steps, two] }), URL, HEAD, 'main')).toBe(2)
    const same = step([check([{ passed: true, head: HEAD }])], { step: 'Security review 2', title: 'Security review 2' })
    expect(headReads(task({ steps: [...task().steps, same] }), URL, HEAD, 'main')).toBe(1)
  })
  it('never counts the task\'s own builders as reads: its assignee or an earlier attempt\'s agent', () => {
    // The review step is passed by agent:r0 (the step helper's checker): as the builder, its pass counts for nothing, so the
    // step has no pass at all and the pull request may not merge, however many other steps passed.
    expect(headReads(task({ builders: ['agent:r0'] }), URL, HEAD, 'main')).toBe(null)
    const two = step([check([{ passed: true, head: HEAD }])], { step: 'Security review 2', title: 'Security review 2' })
    two.checks[0]!.verdicts![0]!.by = 'agent:other'
    expect(headReads(task({ steps: [...task().steps, two], builders: ['agent:r0'] }), URL, HEAD, 'main')).toBe(null)
    expect(headReads(task({ steps: [...task().steps, two], builders: ['agent:someone-else'] }), URL, HEAD, 'main')).toBe(2)
  })
  it('never counts a builder\'s pass of a test step, but keeps the builder\'s own task checks', () => {
    const tested = step([check([{ passed: true, head: HEAD }])], { step: 'Test', title: 'Test' })
    tested.checks[0]!.verdicts![0]!.by = 'agent:builder'
    expect(headReads(task({ steps: [...task().steps, tested], builders: ['agent:builder'] }), URL, HEAD, 'main')).toBe(null)
    const own = task({ builders: ['agent:r0'] })
    own.steps[0]!.checks[0]!.verdicts![0]!.by = 'agent:reviewer'
    expect(headReads(own, URL, HEAD, 'main')).toBe(1)
  })
  it('ignores a cancelled step', () => {
    const t = task({ steps: [...task().steps, step([], { step: 'Test', assignment: { status: 'cancelled' } as Conversation['assignment'] })] })
    expect(headReads(t, URL, HEAD, 'main')).toBe(1)
  })
})

describe('headReads at the base it read (task #3493)', () => {
  it('counts a verdict at the exact head on the base GitHub shows now', () => {
    expect(headReads(task(), URL, HEAD, 'main')).toBe(1)
  })
  it('never counts the same patch on a new base: a patch id names its base', () => {
    const t = task({ pullRequestHeads: { [URL]: { head: HEAD, patch: 'p-main', at: 2, base: 'main' } },
      steps: [step([check([{ passed: true, head: OLD, patch: 'p-release', base: 'release' }])])] })
    expect(headReads(t, URL, HEAD, 'main')).toBe(null)
  })
  it('never counts a verdict once the pull request was retargeted: the live base differs from the watched one', () => {
    // Ledger's case on #3218: passed at this head against another branch, retargeted to main before the watch's next pass.
    const t = task({ pullRequestHeads: { [URL]: { head: HEAD, patch: 'p-release', at: 1, base: 'release' } },
      checks: [check([{ passed: true, head: HEAD, base: 'release' }])], steps: [step([check([{ passed: true, head: HEAD, base: 'release' }])])] })
    expect(headReads(t, URL, HEAD, 'main')).toBe(null)
  })
  it('never counts a verdict naming no base, or another base, at the same head', () => {
    expect(headReads(task({ steps: [step([check([{ passed: true, head: HEAD, base: undefined }])])] }), URL, HEAD, 'main')).toBe(null)
    expect(headReads(task({ steps: [step([check([{ passed: true, head: HEAD, base: 'release' }])])] }), URL, HEAD, 'main')).toBe(null)
  })
  it('never counts a verdict naming no pull request, which the shared check reads against the latest watched head', () => {
    expect(headReads(task({ steps: [step([check([{ passed: true, head: HEAD, pullRequest: undefined }])])] }), URL, HEAD, 'main')).toBe(null)
  })
  it('reads nothing from a head recorded before bases', () => {
    expect(headReads(task({ pullRequestHeads: { [URL]: { head: HEAD, patch: 'p1', at: 1 } } }), URL, HEAD, 'main')).toBe(null)
  })
  it('reads nothing when a base holds a control or format character, however it reads on screen', () => {
    const hidden = 'main\u200b'
    const t = task({ pullRequestHeads: { [URL]: { head: HEAD, patch: 'p1', at: 1, base: hidden } },
      checks: [check([{ passed: true, head: HEAD, base: hidden }])], steps: [step([check([{ passed: true, head: HEAD, base: hidden }])])] })
    expect(headReads(t, URL, HEAD, hidden)).toBe(null)
    expect(headReads(task(), URL, HEAD, 'main\u202e')).toBe(null)
  })
})

describe('eligible', () => {
  it('takes a ready pull request with its Yes at its head, green ci/required, mergeable, no hold', () => {
    expect(eligible(candidate(), 1, 1)).toEqual({ ok: true })
    expect(eligible(candidate(), 2, 2)).toEqual({ ok: true })
  })
  it.each([
    ['closed', { state: 'closed' as const }],
    ['draft', { draft: true }],
    ['base', { base: 'release' }],
    ['ci', { ciRequired: 'pending' as const }],
    ['ci', { ciRequired: 'failure' as const }],
    ['ci', { ciRequired: null }],
    ['mergeable', { mergeable: null }],
    ['conflict', { mergeable: false }],
    ['hold', { labels: ['Hold'] }],
  ])('refuses %s', (why, over) => {
    expect(eligible(candidate(over), 1, 1)).toEqual({ ok: false, why })
  })
  it('refuses one whose verdicts are not at its head', () => {
    expect(eligible(candidate(), null, 1)).toEqual({ ok: false, why: 'verdict' })
  })
  it('refuses one with fewer passed reads at its head than the review table asks', () => {
    expect(eligible(candidate(), 1, 2)).toEqual({ ok: false, why: 'reads' })
  })
})

describe('lanes and components', () => {
  it('sends docs and Markdown alone down the fast lane; scripts run CI and release, so they batch', () => {
    expect(laneOf(['docs/a.md', 'AGENTS.md', 'cli/README.md'])).toBe('fast')
    expect(laneOf(['docs/a.md', 'scripts/ci-plan.py'])).toBe('code')
    expect(laneOf(['docs/a.md', 'backend/src/a.ts'])).toBe('code')
    expect(laneOf([])).toBe('code')
  })
  it('names a pull request by the top folders it touches', () => {
    expect(componentOf(['backend/src/a.ts', 'backend/b.ts'])).toBe('backend')
    expect(componentOf(['desktop/lib/a.dart', 'backend/src/a.ts', 'AGENTS.md'])).toBe('backend+desktop+root')
  })
  it('splits a red batch by component, then in halves, and stops at one', () => {
    const m = (n: number, files: string[]) => ({ number: n, files })
    expect(splitRed([m(1, ['backend/a']), m(2, ['desktop/a']), m(3, ['backend/b'])]).map(g => g.map(x => x.number))).toEqual([[1, 3], [2]])
    expect(splitRed([m(1, ['cli/a']), m(2, ['cli/b']), m(3, ['cli/c']), m(4, ['cli/d'])]).map(g => g.map(x => x.number))).toEqual([[1, 2], [3, 4]])
    expect(splitRed([m(1, ['cli/a'])])).toEqual([])
  })
})

// The train's reads come from the project rules record (policy.ts, task #3475); its seed asks what the train's own table did.
describe('requiredReads, from the rules record\'s seed', () => {
  it('asks the default for ordinary paths and two for the security areas, failing closed', () => {
    expect(requiredReads(SEED_RULES, ['backend/src/superTabs/cards.ts'])).toBe(1)
    expect(requiredReads(SEED_RULES, ['backend/src/github/tokens.ts'])).toBe(2)
    expect(requiredReads(SEED_RULES, ['backend/src/routes/auth.ts', 'docs/a.md'])).toBe(2)
    expect(requiredReads(SEED_RULES, ['backend/src/superTabs/purge.ts'])).toBe(2)
    expect(requiredReads(SEED_RULES, ['desktop/lib/super_tabs/buddy_guard.dart'])).toBe(2)
    expect(requiredReads(SEED_RULES, null)).toBe(2)
  })
})

describe('the rules record\'s seed for the train', () => {
  it('is off until a project switches it on, every 10 minutes', () => {
    expect(SEED_RULES.mergeTrain).toEqual({ enabled: false, everyMinutes: 10 })
  })
})
