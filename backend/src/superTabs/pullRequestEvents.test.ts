import { describe, expect, it } from 'vitest'
import { pullRequestEvents, type PullRequestWatch } from './pullRequestEvents.js'

// Dee, #1891: what GitHub says about a task's pull request becomes one message per event for its Engineer.
const URL = 'https://github.com/acme/app/pull/12'
const HEAD = 'abc1234def5678'
const NOW = Date.parse('2026-11-03T09:00:00.000Z')
const watch = (patch: Partial<PullRequestWatch> = {}): PullRequestWatch => ({ url: URL, number: 12, state: 'open', draft: false, head: HEAD,
  base: 'main', mergeable: true, checkRuns: [], checkSuites: [], reviews: [], comments: [], ...patch })
const run = (name: string, conclusion: string | null, completedAt: number | null = NOW - 1_000) =>
  ({ name, status: conclusion ? 'completed' : 'in_progress', conclusion, completedAt })
/** Seen before: the pull request was read once already, ready at this head long ago. */
const SEEN = [`ready:${HEAD}:${NOW - 3_600_000}`]
const events = (w: PullRequestWatch, seen: readonly string[] = SEEN, bot: string | null = 'harness[bot]') => pullRequestEvents(w, seen, bot, NOW)

describe('pullRequestEvents', () => {
  it('posts CI failed with the failing job names', () => {
    const { events: posted } = events(watch({ checkRuns: [run('build (ubuntu)', 'failure'), run('lint', 'success'), run('ci/required', 'failure'), run('test', null)] }))
    expect(posted).toEqual([{ key: `ci-red:${HEAD}`, text: `CI failed on your pull request #12 (head abc1234): build (ubuntu), ci/required. ${URL}` }])
  })

  it('posts CI passed once every suite is done', () => {
    const green = watch({ checkRuns: [run('build', 'success'), run('docs', 'skipped')], checkSuites: [{ status: 'completed', runs: 2 }, { status: 'queued', runs: 0 }] })
    expect(events(green).events).toEqual([{ key: `ci-green:${HEAD}`, text: `CI passed on your pull request #12 (head abc1234). ${URL}` }])
    expect(events({ ...green, checkSuites: [{ status: 'completed', runs: 1 }, { status: 'in_progress', runs: 1 }] }).events).toEqual([])
    expect(events({ ...green, checkRuns: [] }).events).toEqual([])
  })

  it('posts each event once', () => {
    const red = watch({ checkRuns: [run('build', 'failure')] })
    const first = events(red)
    expect(first.keys).toContain(`ci-red:${HEAD}`)
    expect(events(red, first.keys).events).toEqual([])
  })

  it('posts a review once, in its own words', () => {
    const reviewed = watch({ reviews: [{ id: 7, login: 'huy', state: 'CHANGES_REQUESTED', body: 'Please keep the arrow.', url: `${URL}#pullrequestreview-7` }] })
    const first = events(reviewed)
    expect(first.events).toEqual([{ key: 'review:7', text: `huy asked for changes on your pull request #12: "Please keep the arrow." ${URL}#pullrequestreview-7` }])
    expect(events(reviewed, first.keys).events).toEqual([])
    expect(events(watch({ reviews: [{ id: 8, login: 'ken', state: 'APPROVED', body: '', url: `${URL}#pullrequestreview-8` }] })).events[0]!.text)
      .toBe(`ken approved your pull request #12. ${URL}#pullrequestreview-8`)
  })

  it('posts a comment once, cut to 300 characters', () => {
    const long = 'x'.repeat(400)
    const { events: posted } = events(watch({ comments: [{ id: 9, login: 'dee', body: long, url: `${URL}#issuecomment-9` }] }))
    expect(posted).toEqual([{ key: 'comment:9', text: `dee commented on your pull request #12: "${'x'.repeat(299)}…" ${URL}#issuecomment-9` }])
  })

  it('skips the app\'s bot', () => {
    expect(events(watch({ comments: [{ id: 9, login: 'harness[bot]', body: 'Red/green evidence', url: URL }],
      reviews: [{ id: 3, login: 'harness[bot]', state: 'COMMENTED', body: 'x', url: URL }] })).events).toEqual([])
  })

  it('posts a merge conflict, and nothing while GitHub is still computing', () => {
    expect(events(watch({ mergeable: false })).events).toEqual([{ key: `conflict:${HEAD}`,
      text: `Your pull request #12 has a merge conflict with main (head abc1234): merge main into its branch and push. ${URL}` }])
    expect(events(watch({ mergeable: null })).events).toEqual([])
  })

  it('first sight records and posts nothing but a conflict', () => {
    const busy = watch({ mergeable: false, checkRuns: [run('build', 'failure')], reviews: [{ id: 7, login: 'huy', state: 'COMMENTED', body: 'ok', url: URL }] })
    const first = pullRequestEvents(busy, [], 'harness[bot]', NOW)
    expect(first.events.map(e => e.key)).toEqual([`conflict:${HEAD}`])
    expect(first.keys).toEqual(expect.arrayContaining([`ci-red:${HEAD}`, 'review:7', `conflict:${HEAD}`, `ready:${HEAD}:${NOW}`]))
    expect(pullRequestEvents(busy, first.keys, 'harness[bot]', NOW + 60_000).events).toEqual([])
  })

  it('a draft posts no CI', () => {
    const draft = watch({ draft: true, checkRuns: [run('ci/required', 'failure')], checkSuites: [{ status: 'completed', runs: 1 }] })
    const { events: posted, keys } = events(draft, [])
    expect(posted).toEqual([])
    expect(keys.some(k => k.startsWith('ready:'))).toBe(false)
    expect(events(draft).events).toEqual([])
  })

  it('ignores a draft\'s failure on the same head', () => {
    // Read as a draft, then marked ready: the draft's failed ci/required is still the latest run until the new runs start.
    const seen = pullRequestEvents(watch({ draft: true }), [], null, NOW - 120_000).keys
    const ready = watch({ checkRuns: [run('ci/required', 'failure', NOW - 300_000)] })
    const marked = pullRequestEvents(ready, seen, null, NOW)
    expect(marked.events).toEqual([])
    expect(marked.keys).toContain(`ready:${HEAD}:${NOW}`)
    // The ready run's own failure is news.
    expect(pullRequestEvents(watch({ checkRuns: [run('ci/required', 'failure', NOW + 30_000)] }), marked.keys, null, NOW + 60_000).events.map(e => e.key))
      .toEqual([`ci-red:${HEAD}`])
  })

  it('a new head is news again', () => {
    const red = events(watch({ mergeable: false, checkRuns: [run('build', 'failure')] }))
    const next = watch({ head: 'fff0000aaa', mergeable: false, checkRuns: [run('build', 'failure', NOW + 30_000)] })
    expect(pullRequestEvents(next, red.keys, null, NOW + 60_000).events.map(e => e.key)).toEqual(['ci-red:fff0000aaa', 'conflict:fff0000aaa'])
  })

  it('keeps the newest 50 keys', () => {
    const old = Array.from({ length: 60 }, (_, i) => `comment:${i}`)
    const { keys } = events(watch({ comments: [{ id: 100, login: 'dee', body: 'hi', url: URL }] }), [...SEEN, ...old])
    expect(keys).toHaveLength(50)
    expect(keys).toContain('comment:100')
    expect(keys.some(k => k.startsWith('ready:'))).toBe(true)
  })
})
