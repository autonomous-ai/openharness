import { describe, expect, it } from 'vitest'
import type { Check, Conversation } from '../model.js'
import { componentOf, eligible, headReads, laneOf, skipReason, splitRed, type TrainCandidate, type TrainTask } from './plan.js'
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
    expect(headReads(t, URL, HEAD, 'main')).toEqual(expect.any(String))
  })
  it('keeps a pass at an older head whose patch is the same (a plain rebase)', () => {
    const t = task({ steps: [step([check([{ passed: true, head: OLD, patch: 'p1' }])])] })
    expect(headReads(t, URL, HEAD, 'main')).toBe(1)
  })
  it('never counts a pass with no head, though old clients still count it', () => {
    const t = task({ steps: [step([check([{ passed: true }])])] })
    expect(headReads(t, URL, HEAD, 'main')).toEqual(expect.any(String))
  })
  it('never counts a stale pass, or one on another pull request', () => {
    expect(headReads(task({ steps: [step([check([{ passed: true, head: HEAD, stale: { head: OLD } }])])] }), URL, HEAD, 'main')).toEqual(expect.any(String))
    expect(headReads(task({ steps: [step([check([{ passed: true, head: HEAD, pullRequest: 'https://github.com/acme/app/pull/8' }])])] }), URL, HEAD, 'main')).toEqual(expect.any(String))
  })
  it('refuses when the watch has not seen this head yet', () => {
    expect(headReads(task({ pullRequestHeads: { [URL]: { head: OLD, patch: 'p1', at: 1, base: 'main' } } }), URL, HEAD, 'main')).toEqual(expect.any(String))
    expect(headReads(task({ pullRequestHeads: undefined }), URL, HEAD, 'main')).toEqual(expect.any(String))
  })
  it('refuses a failure at the head next to a pass', () => {
    const t = task({ steps: [step([check([{ passed: true, head: HEAD }, { passed: false, head: HEAD }])])] })
    expect(headReads(t, URL, HEAD, 'main')).toEqual(expect.any(String))
  })
  it('needs a review step, every open step done, and the task checks too', () => {
    expect(headReads(task({ steps: [] }), URL, HEAD, 'main')).toEqual(expect.any(String))
    expect(headReads(task({ steps: [step([check([{ passed: true, head: HEAD }])], { step: 'Test', title: 'Test' })] }), URL, HEAD, 'main')).toEqual(expect.any(String))
    expect(headReads(task({ steps: [...task().steps, step([check([{ passed: true, head: HEAD }])], { step: 'Test', title: 'Test', assignment: { status: 'working' } as Conversation['assignment'] })] }), URL, HEAD, 'main')).toEqual(expect.any(String))
    expect(headReads(task({ steps: [...task().steps, step([], { step: 'Test', title: 'Test' })] }), URL, HEAD, 'main')).toEqual(expect.any(String))
    expect(headReads(task({ checks: [check([{ passed: true, head: OLD, patch: 'p0' }])] }), URL, HEAD, 'main')).toEqual(expect.any(String))
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
    expect(headReads(task({ builders: ['agent:r0'] }), URL, HEAD, 'main')).toEqual(expect.any(String))
    const two = step([check([{ passed: true, head: HEAD }])], { step: 'Security review 2', title: 'Security review 2' })
    two.checks[0]!.verdicts![0]!.by = 'agent:other'
    expect(headReads(task({ steps: [...task().steps, two], builders: ['agent:r0'] }), URL, HEAD, 'main')).toEqual(expect.any(String))
    expect(headReads(task({ steps: [...task().steps, two], builders: ['agent:someone-else'] }), URL, HEAD, 'main')).toBe(2)
  })
  it('never counts a builder\'s pass of a test step, but keeps the builder\'s own task checks', () => {
    const tested = step([check([{ passed: true, head: HEAD }])], { step: 'Test', title: 'Test' })
    tested.checks[0]!.verdicts![0]!.by = 'agent:builder'
    expect(headReads(task({ steps: [...task().steps, tested], builders: ['agent:builder'] }), URL, HEAD, 'main')).toEqual(expect.any(String))
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
    expect(headReads(t, URL, HEAD, 'main')).toEqual(expect.any(String))
  })
  it('never counts a verdict once the pull request was retargeted: the live base differs from the watched one', () => {
    // Ledger's case on #3218: passed at this head against another branch, retargeted to main before the watch's next pass.
    const t = task({ pullRequestHeads: { [URL]: { head: HEAD, patch: 'p-release', at: 1, base: 'release' } },
      checks: [check([{ passed: true, head: HEAD, base: 'release' }])], steps: [step([check([{ passed: true, head: HEAD, base: 'release' }])])] })
    expect(headReads(t, URL, HEAD, 'main')).toEqual(expect.any(String))
  })
  it('never counts a verdict naming no base, or another base, at the same head', () => {
    expect(headReads(task({ steps: [step([check([{ passed: true, head: HEAD, base: undefined }])])] }), URL, HEAD, 'main')).toEqual(expect.any(String))
    expect(headReads(task({ steps: [step([check([{ passed: true, head: HEAD, base: 'release' }])])] }), URL, HEAD, 'main')).toEqual(expect.any(String))
  })
  it('never counts a verdict naming no pull request, which the shared check reads against the latest watched head', () => {
    expect(headReads(task({ steps: [step([check([{ passed: true, head: HEAD, pullRequest: undefined }])])] }), URL, HEAD, 'main')).toEqual(expect.any(String))
  })
  it('reads nothing from a head recorded before bases', () => {
    expect(headReads(task({ pullRequestHeads: { [URL]: { head: HEAD, patch: 'p1', at: 1 } } }), URL, HEAD, 'main')).toEqual(expect.any(String))
  })
  it('reads nothing when a base holds a control or format character, however it reads on screen', () => {
    const hidden = 'main\u200b'
    const t = task({ pullRequestHeads: { [URL]: { head: HEAD, patch: 'p1', at: 1, base: hidden } },
      checks: [check([{ passed: true, head: HEAD, base: hidden }])], steps: [step([check([{ passed: true, head: HEAD, base: hidden }])])] })
    expect(headReads(t, URL, HEAD, hidden)).toEqual(expect.any(String))
    expect(headReads(task(), URL, HEAD, 'main\u202e')).toEqual(expect.any(String))
  })
})

describe('headReads names the rule it fails (task #3902)', () => {
  const why = (t: TrainTask) => headReads(t, URL, HEAD, 'main')
  it('names a task check nobody passed: #3367 and #3370, whose steps all passed', () => {
    const unpassed: Check = { id: 'c0', description: 'A widget test per first-join path that fails without the fix', independent: false, evidence: null, passedBy: null }
    expect(why(task({ checks: [unpassed] }))).toBe('the task\'s check "A widget test per first-join path that fails without the fix": nobody has passed it yet')
  })
  it('names the step and what is wrong with it', () => {
    expect(why(task({ steps: [step([check([{ passed: true, head: HEAD }])], { step: 'Test', title: 'Test', assignment: { status: 'working' } as Conversation['assignment'] })] })))
      .toBe('the Test step is not done')
    expect(why(task({ steps: [step([])] }))).toBe('the Review step has no checks')
    expect(why(task({ steps: [step([check([{ passed: true, head: OLD, patch: 'p0' }])])] })))
      .toBe('the Review step: no verdict was read at this head on this base: it moved since, or the verdict is marked stale')
    expect(why(task({ steps: [step([check([{ passed: true, head: HEAD }, { passed: false, head: HEAD }])])] }))).toBe('the Review step: a failed verdict counts at this head')
    expect(why(task({ builders: ['agent:r0'] }))).toContain('only the task\'s own builders passed it')
    expect(why(task({ steps: [step([check([{ passed: true, head: HEAD }])], { step: 'Test', title: 'Test' })] }))).toBe('no Review step has passed')
  })
  it('names the watch when it has not read this head or base', () => {
    expect(why(task({ pullRequestHeads: { [URL]: { head: OLD, patch: 'p1', at: 1, base: 'main' } } }))).toBe('the pull request watch has not read its head on GitHub yet')
    expect(why(task({ pullRequestHeads: undefined }))).toBe('the pull request watch has not read this pull request yet')
    expect(why(task({ pullRequestHeads: { [URL]: { head: HEAD, patch: 'p1', at: 1, base: 'release' } } }))).toBe('its base branch is not the one the pull request watch recorded')
  })
  it('counts a verdict at the current head by an agent that has since left the project: the train reads no roster', () => {
    const t = task()
    t.steps[0]!.checks[0]!.verdicts![0]!.by = 'agent:rowtest-who-left'
    expect(why(t)).toBe(1)
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
    expect(eligible(candidate(), 'nobody has passed it', 1)).toEqual({ ok: false, why: 'verdict' })
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

describe('skipReason (task #3902)', () => {
  it('names the rule in plain words, with a key that changes only when the reason does', () => {
    expect(skipReason('draft', candidate({ draft: true }), '')).toEqual({ key: 'draft', text: 'it is still a draft' })
    expect(skipReason('hold', candidate({ labels: ['hold'] }), '')?.text).toBe('it has the hold label')
    expect(skipReason('base', candidate({ base: 'release' }), '')?.text).toBe('it targets release, and the train merges only into main')
    expect(skipReason('ci', candidate({ ciRequired: 'pending' }), '')).toEqual({ key: 'ci:pending', text: 'ci/required is pending at its head' })
    expect(skipReason('ci', candidate({ ciRequired: null }), '')?.text).toBe('ci/required is not reported at its head')
    expect(skipReason('mergeable', candidate({ mergeable: null }), '')?.text).toContain('worked out')
    expect(skipReason('verdict', candidate(), 'the Test step is not done')).toEqual({ key: 'verdict:the Test step is not done',
      text: 'the train does not count its reviews and tests: the Test step is not done' })
  })
  it('stays silent where the Engineer already hears the reason as its own line, and for a closed pull request', () => {
    for (const why of ['closed', 'conflict', 'reads'] as const) expect(skipReason(why, candidate(), '')).toBeNull()
  })
})
