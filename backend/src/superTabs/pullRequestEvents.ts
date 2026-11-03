// GitHub events on an open task's pull request reach the task's Engineer directly (Dee, #1891, from DeepSeek's Super-agent):
// CI failed or passed, a review or comment, a merge conflict, each once, without waiting for the PM's 30-minute sync. No
// webhook reaches the backend, so the singleton worker reads them every minute with the Harness GitHub App
// (docs/plans/2026-11-03-pr-events-to-engineer-plan.md).

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
  reviews: Array<{ id: number; login: string; state: string; body: string; url: string }>
  comments: Array<{ id: number; login: string; body: string; url: string }>
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

/**
 * What is new in [watch] since the keys in [seen], and the keys to keep from now on. The first read of a pull request
 * ([seen] empty) records what is already there and posts only a merge conflict, which still needs acting on. Nothing from
 * [botLogin], the app's own account, which the Engineer's own comments go out as. While a draft, no CI: a head read as a
 * draft (`draft:<head>`) is marked when first read as ready (`ready:<head>:<ms>`), and a failure finished before that was
 * the draft's own run, still the latest of its name until the ready run's start.
 */
export function pullRequestEvents(watch: PullRequestWatch, seen: readonly string[], botLogin: string | null, now: number): { events: PullRequestEvent[]; keys: string[] } {
  const first = seen.length === 0, known = new Set(seen), events: PullRequestEvent[] = [], found: string[] = []
  const { url, number, head } = watch
  const add = (key: string, text: string, post = !first) => {
    found.push(key)
    if (!known.has(key) && post) events.push({ key, text })
  }
  if (watch.draft) found.push(`draft:${head}`)
  else {
    const readyMark = seen.find(key => key.startsWith(`ready:${head}:`))
    found.push(readyMark ?? `ready:${head}:${now}`)
    // On the first read everything there is recorded, whenever it finished.
    const since = !first && known.has(`draft:${head}`) ? readyMark ? Number(readyMark.split(':')[2]) : now : -Infinity
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
    const body = quoted(review.body)
    add(`review:${review.id}`, `${review.login} ${REVIEWED[review.state] ?? 'reviewed'} your pull request #${number}${body ? `: "${body}"` : '.'} ${review.url}`)
  }
  for (const comment of watch.comments) {
    if (comment.login === botLogin) continue
    add(`comment:${comment.id}`, `${comment.login} commented on your pull request #${number}: "${quoted(comment.body)}" ${comment.url}`)
  }
  // The newest first: what this read found, then what was seen before; the current head's ready mark always stays.
  const keys = [...new Set([...found, ...seen])]
  const mark = keys.find(key => key.startsWith(`ready:${head}:`))
  const kept = keys.filter(key => key !== mark).slice(0, mark ? SEEN_KEPT - 1 : SEEN_KEPT)
  return { events, keys: mark ? [mark, ...kept] : kept }
}

