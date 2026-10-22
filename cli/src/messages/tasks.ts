/**
 * A shared tab's tasks (docs/plans/2026-10-15-shared-tabs-1b-delivery.md, Task C2): the GitHub issues that carry the
 * tab's hidden marker `<!-- harness-tab:<id> assignee:<account>/<harness> -->`, found with this machine's own `gh`
 * login, with the pull request that closes each and its CI.
 *
 * Nothing here is shared with another account: each member's computer asks GitHub as its own person, so a member
 * sees only the repositories that person may read. GitHub's search only names candidates, since it matches text
 * loosely; the marker in the body is the real filter, so an issue that merely mentions the id is not a task.
 */
import { ciOf, ghError, ghRun, MERGE_STATES, pooled, type CiState, type Run } from '../lib/github.js'
export { findGh, resetGhPath, GH_DIRS } from '../lib/github.js'
export type { CiState, Run } from '../lib/github.js'
import { validPullRequestUrl } from '../lib/sessionWorkWire.js'
import { MessageError } from './model.js'
import { cleanText } from './tabDelivery.js'

export interface TaskRow {
  repo: string; issue: number; title: string; url: string; state: 'open' | 'closed'
  assignee: { account: string; harness: string } | null
  /** `mergedAt`: when the pull request was merged, as `gh pr view` says (ISO), else empty — the window keeps a merged task
   *  for 24 hours after it. */
  pr: { number: number; url: string; state: 'Draft' | 'Open' | 'Merged' | 'Closed'; ci: CiState; autoMerge: boolean; mergeState: string; mergedAt: string } | null
  updatedAt: string
}
export interface TaskResult { rows: TaskRow[]; truncated: boolean; checkedAt: string }
/** `gh` only; rejects as `execFile` does: `{ code?, killed?, signal?, stderr? }`. */
export type TaskReader = (sharedTabId: string) => Promise<TaskResult>

export const TASKS_FRESH_MS = 30_000
/** A failure is kept briefly: a repeated `harness send` must not start `gh` again for each try while GitHub is down or
 *  the login is missing, and the person who fixed it should not wait long to see it work. */
export const TASKS_FAILED_MS = 5_000
const SEARCH_LIMIT = 100
/** CI is read per pull request, one `gh` run each: only the first rows get it, so a refresh stays a bounded number of runs. */
const CI_MAX = 20
const CI_PARALLEL = 4
const TITLE_MAX = 512
const REPO = /^[\w.-]+\/[\w.-]+$/
const ISSUE_URL = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/issues\/[1-9]\d*$/

const rowsOf = (stdout: string): Record<string, unknown>[] => {
  let parsed: unknown
  try { parsed = JSON.parse(stdout) } catch { throw new MessageError('GH_FAILED', 'gh answered with something Harness cannot read.') }
  if (!Array.isArray(parsed)) throw new MessageError('GH_FAILED', 'gh answered with something Harness cannot read.')
  return parsed.filter((row): row is Record<string, unknown> => !!row && typeof row === 'object')
}

const repoOf = (row: Record<string, unknown>): string | null => {
  const name = (row.repository as { nameWithOwner?: unknown } | undefined)?.nameWithOwner
  return typeof name === 'string' && REPO.test(name) ? name : null
}

/** The tab's marker in a body, the first only: a quoted copy further down is not another assignment. */
function markerIn(body: unknown, marker: RegExp): { assignee: TaskRow['assignee'] } | null {
  const found = typeof body === 'string' ? marker.exec(body) : null
  if (!found) return null
  return { assignee: found[1] ? { account: found[1], harness: found[2] } : null }
}

type PrState = NonNullable<TaskRow['pr']>['state']
interface Linked { number: number; url: string; state: PrState }
const PR_RANK: Record<PrState, number> = { Draft: 0, Open: 0, Merged: 1, Closed: 2 }

function searchedPrState(row: Record<string, unknown>): PrState {
  const state = String(row.state).toLowerCase()
  return state === 'merged' ? 'Merged' : state === 'closed' ? 'Closed' : row.isDraft === true ? 'Draft' : 'Open'
}

export function createTaskReader(run: Run = ghRun, now: () => number = Date.now): TaskReader {
  const cache = new Map<string, { until: number; value: Promise<TaskResult> }>()

  async function fetchTasks(id: string): Promise<TaskResult> {
    const marker = new RegExp('<!--\\s*harness-tab:' + id + '(?:\\s+assignee:([\\w.-]{1,64})/([\\w.-]{1,64}))?\\s*-->')
    const query = `harness-tab:${id}`
    const call = async (args: string[]): Promise<string> => {
      try { return (await run(args)).stdout } catch (error) { throw ghError(error) }
    }
    const [issueRows, prRows] = await Promise.all([
      call(['search', 'issues', query, '--match', 'body', '--limit', String(SEARCH_LIMIT), '--json', 'number,title,state,url,repository,body,updatedAt']).then(rowsOf),
      call(['search', 'prs', query, '--match', 'body', '--limit', String(SEARCH_LIMIT), '--json', 'number,state,url,repository,body,isDraft']).then(rowsOf),
    ])
    // Pull requests by the issue they close, in the same repository and carrying the same marker: a pull request that
    // names an issue of another repository, or of another tab, is no one's work on this task.
    const closing = new Map<string, Linked[]>()
    for (const pr of prRows) {
      const repo = repoOf(pr)
      if (!repo || !validPullRequestUrl(pr.url) || !Number.isSafeInteger(pr.number) || !markerIn(pr.body, marker)) continue
      const linked: Linked = { number: Number(pr.number), url: pr.url, state: searchedPrState(pr) }
      for (const [, n] of String(pr.body).matchAll(/\bCloses #(\d+)\b/g)) {
        const key = `${repo}#${Number(n)}`
        closing.set(key, [...(closing.get(key) ?? []), linked])
      }
    }
    const rows: TaskRow[] = []
    for (const issue of issueRows) {
      const repo = repoOf(issue), found = markerIn(issue.body, marker)
      if (!repo || !found || !Number.isSafeInteger(issue.number) || typeof issue.url !== 'string' || !ISSUE_URL.test(issue.url) || new URL(issue.url).href !== issue.url) continue
      // The pull request to show: open work first, then merged, then closed, the newest of each.
      const [best] = (closing.get(`${repo}#${issue.number}`) ?? []).sort((a, b) => PR_RANK[a.state] - PR_RANK[b.state] || b.number - a.number)
      rows.push({ repo, issue: Number(issue.number), title: cleanText(issue.title, TITLE_MAX), url: issue.url,
        state: String(issue.state).toLowerCase() === 'open' ? 'open' : 'closed', assignee: found.assignee,
        pr: best ? { ...best, ci: 'none', autoMerge: false, mergeState: 'UNKNOWN', mergedAt: '' } : null, updatedAt: typeof issue.updatedAt === 'string' ? cleanText(issue.updatedAt, 40) : '' })
    }
    rows.sort((a, b) => (a.state === 'open' ? 0 : 1) - (b.state === 'open' ? 0 : 1) || (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0))
    // CI, and the pull request's state as GitHub says now (a search can lag a merge). One that cannot be read keeps what
    // the search said and no CI: a single pull request must not hide the whole list.
    await pooled(rows.filter((r) => r.pr).slice(0, CI_MAX), CI_PARALLEL, async (row) => {
      const pr = row.pr!
      try {
        const view = JSON.parse(await call(['pr', 'view', pr.url, '--json', 'statusCheckRollup,state,isDraft,mergedAt,autoMergeRequest,mergeStateStatus'])) as Record<string, unknown>
        const state = String(view.state).toUpperCase()
        pr.state = view.mergedAt || state === 'MERGED' ? 'Merged' : state === 'CLOSED' ? 'Closed' : view.isDraft === true ? 'Draft' : 'Open'
        pr.ci = ciOf(view.statusCheckRollup)
        // "Merging" is auto-merge only: gh has no merge-queue field (`isInMergeQueue` is refused as an unknown field, which
        // failed this whole read), and the queue would cost another `gh api graphql` run per pull request.
        pr.autoMerge = !!view.autoMergeRequest && typeof view.autoMergeRequest === 'object'
        const merge = String(view.mergeStateStatus ?? '').toUpperCase()
        pr.mergeState = MERGE_STATES.includes(merge) ? merge : 'UNKNOWN'
        pr.mergedAt = cleanText(view.mergedAt, 40)
      } catch { /* keeps the search's word */ }
    })
    return { rows, truncated: issueRows.length >= SEARCH_LIMIT || prRows.length >= SEARCH_LIMIT, checkedAt: new Date(now()).toISOString() }
  }

  return (sharedTabId) => {
    // Only a tab id as the backend derives one (24 hex) is ever put on a command line.
    if (!/^[a-f0-9]{24}$/.test(sharedTabId)) return Promise.reject(new MessageError('NOT_SHARED', 'That is not a shared tab.'))
    const kept = cache.get(sharedTabId)
    if (kept && kept.until > now()) return kept.value
    // One flight per tab: callers that arrive while it runs share it, and the answer is kept from when it ends.
    const entry = { until: Infinity, value: fetchTasks(sharedTabId) }
    entry.value.then(() => { entry.until = now() + TASKS_FRESH_MS }, () => { entry.until = now() + TASKS_FAILED_MS })
    cache.set(sharedTabId, entry)
    return entry.value
  }
}
