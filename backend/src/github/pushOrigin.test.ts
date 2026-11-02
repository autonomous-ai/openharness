import { describe, expect, it } from 'vitest'
import { pullRequestsIn, readPushOrigin, type GitHubRead } from './pushOrigin.js'

const BOT = 'harness-for-acme[bot]', REPO = 'acme/app', HEAD = 'head-sha', BASE_COMMIT = 'older-sha'
const person = { login: 'ken', type: 'User' }, bot = { login: 'harness-for-acme[bot]', type: 'Bot' }
const commit = (sha: string, email = 'ken@example.com', author: unknown = person) => ({ sha, author, committer: person,
  commit: { author: { email }, committer: { email: 'ken@example.com' } } })
const push = (after: string, actor: unknown = person, timestamp = '2026-11-02T08:00:00Z') => ({ id: 1, after, actor, timestamp })
const pull = { head: { sha: HEAD, ref: 'fix', repo: { full_name: REPO } }, created_at: '2026-11-02T07:00:00Z' }

/** A fake GitHub of one pull request, its commits and pages of its activity log, filtered by actor or by ref as GitHub does. */
const github = (options: { pull?: unknown; commits?: unknown[]; activity?: unknown[][]; failing?: RegExp } = {}): GitHubRead => async path => {
  if (options.failing?.test(path)) return { status: 502, body: {} }
  if (path.includes('/commits')) return { status: 200, body: options.commits ?? [commit(HEAD), commit(BASE_COMMIT)] }
  if (path.includes('/activity')) {
    const pages = options.activity ?? [[push(HEAD), push(BASE_COMMIT)]]
    const query = new URLSearchParams(path.split('?')[1])
    const actor = query.get('actor')
    const shown = pages.map(page => page.filter(e => !actor || (e as { actor?: { login?: string } | null }).actor?.login === actor))
      .filter((page, index) => page.length || index === 0)
    const page = Number(query.get('after') ?? 0)
    return { status: 200, body: shown[page] ?? [], ...(page + 1 < shown.length ? { next: `/repos/${REPO}/activity?${actor ? `actor=${encodeURIComponent(actor)}&` : ''}${query.get('ref') ? `ref=${query.get('ref')}&` : ''}per_page=100&after=${page + 1}` } : {}) }
  }
  return { status: 200, body: options.pull ?? pull }
}
const origin = (options: Parameters<typeof github>[0] = {}) => readPushOrigin(github(options), REPO, 7, BOT)

describe('who pushed a pull request', () => {
  it('reads clean only when a person pushed its head and no bot pushed any of its commits', async () => {
    expect(await origin()).toBe('clean')
  })

  it('reads team when a bot pushed its head', async () => {
    expect(await origin({ activity: [[push(HEAD, bot)]] })).toBe('team')
  })

  it('reads team for a batch branch: a person pushed its head, a bot pushed a commit inside it', async () => {
    expect(await origin({ activity: [[push(HEAD), push(BASE_COMMIT, bot)]] })).toBe('team')
  })

  it('finds a bot\'s push on a later page', async () => {
    expect(await origin({ activity: [[push(HEAD), ...Array(99).fill(push('other'))], [push(BASE_COMMIT, bot)]] })).toBe('team')
  })

  it('does not take a forged author as clean: the log names the bot whatever the commit says', async () => {
    expect(await origin({ commits: [commit(HEAD, 'ken@example.com', person)], activity: [[push(HEAD, bot)]] })).toBe('team')
  })

  it('reads team on a Team account\'s or a bot\'s commit address and author', async () => {
    expect(await origin({ commits: [commit(HEAD, 'harnessteam@mac.local')] })).toBe('team')
    expect(await origin({ commits: [commit(HEAD, '42+harness[bot]@users.noreply.github.com')] })).toBe('team')
    expect(await origin({ commits: [commit(HEAD, 'ken@example.com', bot)] })).toBe('team')
  })

  it('reads unknown when the log does not show who pushed its head, or names nobody', async () => {
    expect(await origin({ activity: [[push('other')]] })).toBe('unknown')
    expect(await origin({ activity: [[push(HEAD, null)]] })).toBe('unknown')
  })

  it('reads unknown for a fork, whose pushes this log never shows', async () => {
    expect(await origin({ pull: { ...pull, head: { sha: HEAD, ref: 'fix', repo: { full_name: 'mallory/app' } } } })).toBe('unknown')
    expect(await origin({ pull: { ...pull, head: { sha: HEAD, ref: 'fix', repo: null } } })).toBe('unknown')
  })

  it('reads unknown on any failed read, never clean', async () => {
    for (const failing of [/\/pulls\/7$/, /\/commits/, /\/activity/]) expect(await origin({ failing }), String(failing)).toBe('unknown')
    expect(await readPushOrigin(async () => { throw new Error('down') }, REPO, 7, BOT)).toBe('unknown')
  })

  it('reads unknown on a page limit: too many commits, or a log too long to reach the start', async () => {
    expect(await origin({ commits: Array.from({ length: 100 }, (_, i) => commit(i ? `c${i}` : HEAD)) })).toBe('unknown')
    expect(await origin({ activity: Array.from({ length: 25 }, () => [push('other', bot)]) })).toBe('unknown')
  })

  it('reads back past the pull request\'s week to its oldest commit: a batch opened today holds a Team push from weeks ago', async () => {
    const dated = (sha: string, date: string) => ({ sha, author: person, committer: person, commit: { author: { email: 'ken@example.com' }, committer: { email: 'ken@example.com', date } } })
    const commits = [dated(HEAD, '2026-11-02T06:00:00Z'), dated(BASE_COMMIT, '2026-10-01T00:00:00Z')]
    const late = push('other', bot, '2026-10-20T00:00:00Z')
    expect(await origin({ commits, activity: [[push(HEAD), late], [push(BASE_COMMIT, bot, '2026-10-02T00:00:00Z')]] })).toBe('team')
  })

  it('names the pull requests a brief speaks of, in this repository only', () => {
    expect(pullRequestsIn('Review PR #2500 and pull request #12, not #7, and https://github.com/acme/app/pull/9 or https://github.com/other/app/pull/4', 'https://github.com/acme/app'))
      .toEqual(['https://github.com/acme/app/pull/9', 'https://github.com/other/app/pull/4', 'https://github.com/acme/app/pull/2500', 'https://github.com/acme/app/pull/12'])
    expect(pullRequestsIn('Review PR #2500', null)).toEqual([])
  })

  it('reads clean on a busy repository: thousands of people\'s pushes do not hide the head, and only the bot\'s are walked', async () => {
    const busy = Array.from({ length: 30 }, () => Array(100).fill(push('other')))
    const paths: string[] = []
    const counted: GitHubRead = async path => { paths.push(path); return github({ activity: [[push(HEAD)], ...busy] })(path) }
    expect(await readPushOrigin(counted, REPO, 7, BOT)).toBe('clean')
    expect(paths.filter(p => p.includes('/activity')).length).toBeLessThan(5)
    expect(paths.some(p => p.includes(`actor=${encodeURIComponent(BOT)}`))).toBe(true)
    expect(paths.some(p => p.includes('ref=fix'))).toBe(true)
  })

  it('stops reading the bot\'s pushes once they are a week older than the pull request', async () => {
    let reads = 0
    const log = [[push(HEAD), push('recent', bot)], [push('old', bot, '2026-10-01T00:00:00Z')], [push('older', bot)]]
    const counted: GitHubRead = async path => { if (path.includes('actor=')) reads++; return github({ activity: log })(path) }
    expect(await readPushOrigin(counted, REPO, 7, BOT)).toBe('clean')
    expect(reads).toBe(2)
  })

  it('reads unknown when the app\'s own login is not known: the bot\'s pushes cannot be asked for', async () => {
    expect(await readPushOrigin(github(), REPO, 7, null)).toBe('unknown')
  })
})
