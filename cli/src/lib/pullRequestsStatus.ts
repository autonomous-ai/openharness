/** Read linked PRs as this computer's own GitHub account, independent of running agents or checked-out branches. */
import { ciCounts, ciOf, ghError, ghRun, MERGE_STATES, pooled, type CiCounts, type Run } from './github.js'
import { validPullRequestUrl } from './sessionWorkWire.js'
import { cleanText } from './cleanText.js'

export const PULL_REQUESTS_MAX = 50
export const PULL_REQUESTS_FRESH_MS = 30_000
const CACHE_MAX = 500
export interface PullRequestRow {
  url: string; status: 'found' | 'no_access' | 'unavailable'
  title?: string; state?: 'Draft' | 'Open' | 'Merged' | 'Closed'
  mergedAt?: string; closedAt?: string; updatedAt?: string
  additions?: number; deletions?: number; ci?: ReturnType<typeof ciOf>; checks?: CiCounts
  reviewDecision?: string; mergeStateStatus?: string; autoMerge?: boolean
  error?: string
}
export interface PullRequestsResult extends Record<string, unknown> { rows: PullRequestRow[]; checkedAt: string; error?: string; detail?: string }

const FIELDS = 'title,state,isDraft,mergedAt,closedAt,updatedAt,additions,deletions,statusCheckRollup,reviewDecision,mergeStateStatus,autoMergeRequest'
const text = (value: unknown, max = 40): string => cleanText(value, max)
const lines = (value: unknown): number => Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : 0

export function createPullRequestsStatusReader(run: Run = ghRun, now: () => number = Date.now) {
  const cache = new Map<string, { until: number; value: Promise<PullRequestRow> }>()
  // Several panes can ask together. Their distinct URLs still share four subprocess slots.
  let active = 0
  const waiting: (() => void)[] = []
  async function fetch(url: string): Promise<PullRequestRow> {
    if (active >= 4) await new Promise<void>(resolve => waiting.push(resolve))
    else active++
    try {
      const view = JSON.parse((await run(['pr', 'view', url, '--json', FIELDS])).stdout)
      if (!view || typeof view !== 'object' || !['OPEN', 'CLOSED', 'MERGED'].includes(view.state) || typeof view.title !== 'string') {
        return { url, status: 'unavailable', error: 'GH_FAILED' }
      }
      return { url, status: 'found', title: text(view.title, 512),
        state: view.mergedAt || view.state === 'MERGED' ? 'Merged' : view.state === 'CLOSED' ? 'Closed' : view.isDraft === true ? 'Draft' : 'Open',
        mergedAt: text(view.mergedAt), closedAt: text(view.closedAt), updatedAt: text(view.updatedAt),
        additions: lines(view.additions), deletions: lines(view.deletions), ci: ciOf(view.statusCheckRollup), checks: ciCounts(view.statusCheckRollup),
        reviewDecision: ['APPROVED', 'CHANGES_REQUESTED', 'REVIEW_REQUIRED'].includes(view.reviewDecision) ? view.reviewDecision : '',
        mergeStateStatus: MERGE_STATES.includes(view.mergeStateStatus) ? view.mergeStateStatus : 'UNKNOWN',
        autoMerge: !!view.autoMergeRequest && typeof view.autoMergeRequest === 'object' }
    } catch (error) {
      const e = ghError(error)
      const stderr = String((error as { stderr?: unknown } | null)?.stderr ?? '')
      const denied = /HTTP 403/i.test(stderr) && !/rate limit|secondary rate/i.test(stderr)
      if (denied || e.code === 'GH_FAILED' && /could not resolve to a (?:repository|pullrequest)|could not find|not found|HTTP 404|not accessible/i.test(stderr)) {
        return { url, status: 'no_access' }
      }
      return { url, status: 'unavailable', error: e.code }
    } finally {
      const next = waiting.shift()
      if (next) next()
      else active--
    }
  }
  function read(url: string): Promise<PullRequestRow> {
    const prior = cache.get(url)
    if (prior && prior.until > now()) return prior.value
    const entry = { until: Infinity, value: fetch(url) }
    cache.set(url, entry)
    void entry.value.then(row => {
      entry.until = row.status === 'found' && ['Merged', 'Closed'].includes(row.state!) ? Infinity
        : now() + (row.status === 'unavailable' ? 5_000 : PULL_REQUESTS_FRESH_MS)
      // Final answers cost no more network requests, but an unbounded history must not cost unbounded memory.
      if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!)
    })
    return entry.value
  }
  return async (urls: unknown): Promise<PullRequestsResult> => {
    if (!Array.isArray(urls) || urls.length > PULL_REQUESTS_MAX || !urls.every(validPullRequestUrl)) {
      return { rows: [], checkedAt: new Date(now()).toISOString(), error: 'INVALID_URLS', detail: `Supply at most ${PULL_REQUESTS_MAX} GitHub pull request URLs.` }
    }
    const unique = [...new Set(urls)] as string[], rows = new Map<string, PullRequestRow>()
    await pooled(unique, 4, async url => { rows.set(url, await read(url)) })
    const ordered = unique.map(url => rows.get(url)!)
    const error = ['GH_MISSING', 'GH_SIGNED_OUT', 'RATE_LIMITED', 'TIMEOUT', 'GH_FAILED'].find(code => ordered.some(row => row.error === code))
    return { rows: ordered, checkedAt: new Date(now()).toISOString(), ...(error ? { error } : {}) }
  }
}
