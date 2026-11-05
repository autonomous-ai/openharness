import { describe, expect, it } from 'vitest'
import type { Check, Conversation } from '../model.js'
import { componentOf, eligible, headReads, laneOf, requiredReads, splitRed, type TrainCandidate, type TrainTask } from './plan.js'
import { TRAIN_DEFAULTS } from './config.js'

const URL = 'https://github.com/acme/app/pull/7'
const HEAD = 'a'.repeat(40), OLD = 'b'.repeat(40)

const check = (verdicts: Array<{ passed: boolean; head?: string; patch?: string | null; stale?: unknown; pullRequest?: string }>): Check => ({
  id: 'c1', description: 'Review', independent: true, evidence: null, passedBy: null,
  verdicts: verdicts.map((v, i) => ({ by: `agent:r${i}`, evidence: 'read', at: 1, pullRequest: URL, ...v })) as Check['verdicts'],
})
const step = (checks: Check[], over: Partial<Conversation> = {}): TrainTask['steps'][number] => ({
  step: 'Review', title: 'Review', checks, archived: false, assignment: { status: 'done' } as Conversation['assignment'], ...over,
})
const task = (over: Partial<TrainTask> = {}): TrainTask => ({
  checks: [check([{ passed: true, head: HEAD }])],
  pullRequestHeads: { [URL]: { head: HEAD, patch: 'p1', at: 1 } },
  steps: [step([check([{ passed: true, head: HEAD }])])],
  ...over,
})
const candidate = (over: Partial<TrainCandidate> = {}): TrainCandidate => ({
  url: URL, number: 7, head: HEAD, state: 'open', draft: false, base: 'main', mergeable: true, labels: [], files: ['backend/src/a.ts'],
  ciRequired: 'success', ...over,
})

describe('headReads', () => {
  it('counts passes recorded at the head GitHub shows now', () => {
    expect(headReads(task(), URL, HEAD)).toBe(1)
  })
  it('refuses a pass at an older head with another patch', () => {
    const t = task({ steps: [step([check([{ passed: true, head: OLD, patch: 'p0' }])])] })
    expect(headReads(t, URL, HEAD)).toBe(null)
  })
  it('keeps a pass at an older head whose patch is the same (a plain rebase)', () => {
    const t = task({ steps: [step([check([{ passed: true, head: OLD, patch: 'p1' }])])] })
    expect(headReads(t, URL, HEAD)).toBe(1)
  })
  it('never counts a pass with no head, though old clients still count it', () => {
    const t = task({ steps: [step([check([{ passed: true }])])] })
    expect(headReads(t, URL, HEAD)).toBe(null)
  })
  it('never counts a stale pass, or one on another pull request', () => {
    expect(headReads(task({ steps: [step([check([{ passed: true, head: HEAD, stale: { head: OLD } }])])] }), URL, HEAD)).toBe(null)
    expect(headReads(task({ steps: [step([check([{ passed: true, head: HEAD, pullRequest: 'https://github.com/acme/app/pull/8' }])])] }), URL, HEAD)).toBe(null)
  })
  it('refuses when the watch has not seen this head yet', () => {
    expect(headReads(task({ pullRequestHeads: { [URL]: { head: OLD, patch: 'p1', at: 1 } } }), URL, HEAD)).toBe(null)
    expect(headReads(task({ pullRequestHeads: undefined }), URL, HEAD)).toBe(null)
  })
  it('refuses a failure at the head next to a pass', () => {
    const t = task({ steps: [step([check([{ passed: true, head: HEAD }, { passed: false, head: HEAD }])])] })
    expect(headReads(t, URL, HEAD)).toBe(null)
  })
  it('needs a review step, every open step done, and the task checks too', () => {
    expect(headReads(task({ steps: [] }), URL, HEAD)).toBe(null)
    expect(headReads(task({ steps: [step([check([{ passed: true, head: HEAD }])], { step: 'Test', title: 'Test' })] }), URL, HEAD)).toBe(null)
    expect(headReads(task({ steps: [...task().steps, step([check([{ passed: true, head: HEAD }])], { step: 'Test', title: 'Test', assignment: { status: 'working' } as Conversation['assignment'] })] }), URL, HEAD)).toBe(null)
    expect(headReads(task({ steps: [...task().steps, step([], { step: 'Test', title: 'Test' })] }), URL, HEAD)).toBe(null)
    expect(headReads(task({ checks: [check([{ passed: true, head: OLD, patch: 'p0' }])] }), URL, HEAD)).toBe(null)
  })
  it('counts each reviewer once, over every review step passed at the head', () => {
    const two = step([check([{ passed: true, head: HEAD }])], { step: 'Security review 2', title: 'Security review 2' })
    two.checks[0]!.verdicts![0]!.by = 'agent:other'
    expect(headReads(task({ steps: [...task().steps, two] }), URL, HEAD)).toBe(2)
    const same = step([check([{ passed: true, head: HEAD }])], { step: 'Security review 2', title: 'Security review 2' })
    expect(headReads(task({ steps: [...task().steps, same] }), URL, HEAD)).toBe(1)
  })
  it('ignores a cancelled step', () => {
    const t = task({ steps: [...task().steps, step([], { step: 'Test', assignment: { status: 'cancelled' } as Conversation['assignment'] })] })
    expect(headReads(t, URL, HEAD)).toBe(1)
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
  it('sends docs, Markdown and scripts alone down the fast lane', () => {
    expect(laneOf(['docs/a.md', 'AGENTS.md', 'scripts/ci-plan.py', 'cli/README.md'])).toBe('fast')
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

describe('requiredReads', () => {
  it('asks the default for ordinary paths and two for the security areas, failing closed', () => {
    expect(requiredReads(['backend/src/superTabs/cards.ts'])).toBe(1)
    expect(requiredReads(['backend/src/github/tokens.ts'])).toBe(2)
    expect(requiredReads(['backend/src/routes/auth.ts', 'docs/a.md'])).toBe(2)
    expect(requiredReads(['backend/src/superTabs/purge.ts'])).toBe(2)
    expect(requiredReads(['desktop/lib/super_tabs/buddy_guard.dart'])).toBe(2)
  })
  it('takes the reads from the rules record when it names the area, never fewer than the default', () => {
    const reviews = { defaultReads: 1, rows: [{ area: 'Tokens', reads: 3 }] }
    expect(requiredReads(['backend/src/github/tokens.ts'], reviews)).toBe(3)
    expect(requiredReads(['backend/src/superTabs/cards.ts'], { defaultReads: 2, rows: [] })).toBe(2)
  })
})

describe('config', () => {
  it('is off until a project switches it on, every 10 minutes', () => {
    expect(TRAIN_DEFAULTS).toEqual({ enabled: false, everyMinutes: 10 })
  })
})
