// GitHub events on an open task's pull request reach the task's Engineer directly (Dee, #1891, from DeepSeek's Super-agent):
// CI failed or passed, a review or comment, a merge conflict, each once, without waiting for the PM's 30-minute sync. No
// webhook reaches the backend, so the singleton worker reads them every minute with the Harness GitHub App
// (docs/plans/2026-11-03-pr-events-to-engineer-plan.md).
import type { PrismaClient } from '@prisma/client'
import { PULL_WATCH_PERMISSIONS, type GitHubApp } from '../github/app.js'
import { githubRepository, type GitHubRepository } from '../github/repository.js'
import type { SuperTabStore } from './store.js'
import { logger } from '../utils/logger.js'

/** What GitHub says of one pull request, as the watch reads it (github/app.ts watchPullRequest). */
export interface PullRequestWatch {
  url: string
  number: number
  state: 'open' | 'closed'
  draft: boolean
  /** The head commit's SHA. */
  head: string
  /** The branch it merges into. */
  base: string
  /** False on a merge conflict; null while GitHub is still working it out. */
  mergeable: boolean | null
  /** The head's latest check run of each name. */
  checkRuns: Array<{ name: string; status: string; conclusion: string | null; completedAt: number | null }>
  /** The head's check suites, with how many check runs each has. */
  checkSuites: Array<{ status: string; runs: number }>
  /** Each with its author's tie to the repository, GitHub's author_association (OWNER, MEMBER, COLLABORATOR, NONE...). */
  reviews: Array<{ id: number; login: string; association: string; state: string; body: string; url: string }>
  comments: Array<{ id: number; login: string; association: string; body: string; url: string }>
}

/** One message for the Engineer, and the key it is posted under once. */
export interface PullRequestEvent { key: string; text: string }

const FAILED = new Set(['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure'])
const PASSED = new Set(['success', 'neutral', 'skipped'])
/** The keys a group keeps per pull request: enough for its open heads, reviews and comments. */
export const SEEN_KEPT = 50
const QUOTE = 300

const short = (sha: string) => sha.slice(0, 7)
const quoted = (body: string) => {
  const text = body.trim().replace(/\s+/g, ' ')
  return text.length > QUOTE ? `${text.slice(0, QUOTE - 1)}…` : text
}
const REVIEWED: Record<string, string> = { CHANGES_REQUESTED: 'asked for changes on', APPROVED: 'approved' }
/** Whose words reach the Engineer: the repository's own people. Anyone can comment on a public pull request, and the line
 *  reaches an agent as its Lead's, so anyone else's text stays on GitHub behind the link (ENGINEERING.md 7, review of #2750). */
const QUOTED = new Set(['OWNER', 'MEMBER', 'COLLABORATOR'])
const said = (association: string, body: string, url: string) => {
  const text = QUOTED.has(association) ? quoted(body) : ''
  return text ? `: "${text}" ${url}` : `: ${url}`
}

/**
 * What is new in [watch] since the keys in [seen], and the keys to keep from now on. The first read of a pull request
 * ([seen] empty) records what is already there and posts only a merge conflict, which still needs acting on. Nothing from
 * [botLogin], the app's own account, which the Engineer's own comments go out as. While a draft, no CI: a pull request read
 * as a draft (`draft`), whatever its head, is marked when next read as ready (`ready:<ms>`), and a failure finished before
 * that was a draft's own run, still the latest of its name until the ready run starts (review of #2750: a push and Ready
 * in the same minute leave the new head never read as a draft).
 */
export function pullRequestEvents(watch: PullRequestWatch, seen: readonly string[], botLogin: string | null, now: number): { events: PullRequestEvent[]; keys: string[] } {
  const first = seen.length === 0, known = new Set(seen), events: PullRequestEvent[] = [], found: string[] = []
  const { url, number, head } = watch
  const add = (key: string, text: string, post = !first) => {
    found.push(key)
    if (!known.has(key) && post) events.push({ key, text })
  }
  const readyMark = seen.find(key => key.startsWith('ready:'))
  if (watch.draft) found.push('draft')
  else {
    // Ready since a draft read: from now, unless it was ready already. On the first read everything there is recorded.
    const readyAt = known.has('draft') ? now : readyMark ? Number(readyMark.slice('ready:'.length)) : null
    if (readyAt !== null) found.push(`ready:${readyAt}`)
    const since = !first && readyAt !== null ? readyAt : -Infinity
    const failing = (run: PullRequestWatch['checkRuns'][number]) => !!run.conclusion && FAILED.has(run.conclusion)
    const failed = watch.checkRuns.filter(run => failing(run) && (run.completedAt ?? now) >= since)
    const stale = watch.checkRuns.some(run => failing(run) && (run.completedAt ?? now) < since)
    if (failed.length) add(`ci-red:${head}`, `CI failed on your pull request #${number} (head ${short(head)}): ${failed.map(run => run.name).join(', ')}. ${url}`)
    const suites = watch.checkSuites.filter(suite => suite.runs > 0)
    if (!failed.length && !stale && watch.checkRuns.length && suites.length && suites.every(suite => suite.status === 'completed')
      && watch.checkRuns.every(run => run.status === 'completed' && run.conclusion && PASSED.has(run.conclusion))) {
      add(`ci-green:${head}`, `CI passed on your pull request #${number} (head ${short(head)}). ${url}`)
    }
  }
  if (watch.mergeable === false) {
    add(`conflict:${head}`, `Your pull request #${number} has a merge conflict with ${watch.base} (head ${short(head)}): merge ${watch.base} into its branch and push. ${url}`, true)
  }
  for (const review of watch.reviews) {
    if (review.login === botLogin) continue
    add(`review:${review.id}`, `${review.login} ${REVIEWED[review.state] ?? 'reviewed'} your pull request #${number}${said(review.association, review.body, review.url)}`)
  }
  for (const comment of watch.comments) {
    if (comment.login === botLogin) continue
    add(`comment:${comment.id}`, `${comment.login} commented on your pull request #${number}${said(comment.association, comment.body, comment.url)}`)
  }
  // The newest first: what this read found, then what was seen before. The draft and ready marks stand for the pull request
  // as it is now: a stale one goes, and the current one always stays.
  const state = (key: string) => key === 'draft' || key.startsWith('ready:')
  const marks = found.filter(state).length ? found.filter(state) : seen.filter(state).slice(0, 1)
  const kept = [...new Set([...found, ...seen])].filter(key => !state(key)).slice(0, SEEN_KEPT - marks.length)
  return { events, keys: [...marks, ...kept] }
}

/** What a pass asks GitHub: a pull request's watch (null: it cannot say), the app's own login, and `done` once it is over. */
export interface PullRequestReader { watch(url: string): Promise<PullRequestWatch | null>; botLogin(): Promise<string | null>; done(): Promise<void> }

const PULL = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/([1-9][0-9]*)$/
/** A task quiet this long is not watched: its Engineer is not waiting on its pull request. */
export const WATCH_QUIET_MS = 7 * 24 * 3_600_000
/** The most tasks a pass reads, the most recently active first (ENGINEERING.md 4: no read grows without a bound). */
export const WATCH_GROUPS = 200

/** Reads with the Harness GitHub App: one read-only token per repository for the whole pass, revoked when it is done (as the
 *  archive pass's, archive.ts). A repository the app is not installed on, or any GitHub failure, reads as null. */
export function appPullRequestWatch(app: GitHubApp): PullRequestReader {
  const tokens = new Map<string, Promise<string | null>>()
  const token = (repository: GitHubRepository) => {
    const key = repository.fullName.toLowerCase()
    if (!tokens.has(key)) tokens.set(key, (async () => {
      const installation = await app.installation(repository)
      return installation === null ? null : (await app.createToken(installation, repository, PULL_WATCH_PERMISSIONS)).token
    })().catch(() => null))
    return tokens.get(key)!
  }
  return {
    async watch(url) {
      const match = PULL.exec(url), repository = match ? githubRepository(`https://github.com/${match[1]}`) : null
      const granted = repository ? await token(repository) : null
      return granted ? app.watchPullRequest(repository!, Number(match![2]), granted) : null
    },
    botLogin: () => app.botLogin(),
    async done() {
      for (const granted of tokens.values()) {
        const value = await granted
        if (value) await app.revoke(value).catch(() => {})
      }
      tokens.clear()
    },
  }
}

/**
 * One pass: open tasks (not steps) active in the last [WATCH_QUIET_MS] that link a pull request, at most [limit] of them, the
 * most recently active first, have each open one read once, and what is new goes to its Engineer (store.ts
 * pullRequestSeen). One group's failure is logged and skips that group alone. A pass that posted, or could not read a pull
 * request, says so in one line: the measure of this feature (ENGINEERING.md 6 and 8). The messages posted.
 */
export async function watchPullRequests(db: PrismaClient, store: Pick<SuperTabStore, 'pullRequestSeen'>, reader: PullRequestReader, now: number,
  limit = WATCH_GROUPS): Promise<number> {
  try {
    // The finished mark's index, [workFinished, archived, lastActivityAt]: equality, equality, then the range, which also
    // gives the sort; the rest filters what it fetches. A step's reviewOf is a string and a task has none (null matches it).
    const rows = await db.swarmGroup.aggregateRaw({ pipeline: [
      { $match: { workFinished: false, archived: false, lastActivityAt: { $gte: { $date: new Date(now - WATCH_QUIET_MS).toISOString() } },
        deleted: false, kind: null, 'data.reviewOf': null, 'data.pullRequestUrls.0': { $exists: true } } },
      { $sort: { lastActivityAt: -1 } },
      { $limit: limit },
      { $project: { _id: 0, tabId: 1, key: 1, urls: '$data.pullRequestUrls' } },
    ] }) as unknown as Array<{ tabId: string; key: string; urls: string[] }>
    if (!rows.length) return 0
    const bot = await reader.botLogin()
    // One read per pull request a pass, however many tasks link it.
    const reads = new Map<string, Promise<PullRequestWatch | null>>()
    const watchOf = (url: string) => { if (!reads.has(url)) reads.set(url, reader.watch(url).catch(() => null)); return reads.get(url)! }
    let posted = 0
    for (const row of rows) {
      for (const url of row.urls) {
        try {
          const watch = await watchOf(url)
          if (watch?.state === 'open') posted += await store.pullRequestSeen(row.tabId, row.key, watch, bot)
        } catch (error) {
          logger.warn('[swarm-pr-events] group skipped', { tabId: row.tabId, group: row.key, error: error instanceof Error ? error.message : String(error) })
        }
      }
    }
    const unreadable = (await Promise.all(reads.values())).filter(watch => watch === null).length
    const line = { groups: rows.length, pulls: reads.size, unreadable, posted }
    if (unreadable) logger.warn('[swarm-pr-events] pass', line)
    else if (posted) logger.info('[swarm-pr-events] pass', line)
    return posted
  } finally { await reader.done() }
}

/** Runs the pass every minute in the singleton worker, one at a time. */
export function startPullRequestWatch(db: PrismaClient, store: Pick<SuperTabStore, 'pullRequestSeen'>, reader: () => PullRequestReader, everyMs = 60_000): () => void {
  let running = false
  const run = () => {
    if (running) return
    running = true
    void watchPullRequests(db, store, reader(), Date.now())
      .catch(error => logger.warn('[swarm-pr-events] failed', { error: error instanceof Error ? error.message : String(error) }))
      .finally(() => { running = false })
  }
  run()
  const timer = setInterval(run, everyMs)
  timer.unref()
  return () => clearInterval(timer)
}
