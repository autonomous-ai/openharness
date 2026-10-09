import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { insideGitCheckout, validGitPath } from './gitProject.js'
import { canonicalRepository } from './agentProject.js'
import { validPullRequestUrl } from './sessionWorkWire.js'
import { tmpdir } from 'node:os'

const exec = promisify(execFile)
type Run = (command: string, args: string[], cwd: string) => Promise<string>
/** Bound process and queue counts across simultaneous badges and history pages. */
export function boundedPullRequestRunner(execute: Run, limit = 4, queueLimit = 64, waitMs = 2000): Run {
  let active = 0
  const waiting: Array<() => void> = []
  return async (...args) => {
    if (active >= limit) {
      if (waiting.length >= queueLimit) throw new Error('Git context is busy')
      await new Promise<void>((resolve, reject) => {
        const ready = () => { clearTimeout(timer); resolve() }
        const timer = setTimeout(() => {
          const index = waiting.indexOf(ready)
          if (index >= 0) waiting.splice(index, 1)
          reject(new Error('Git context is busy'))
        }, waitMs)
        timer.unref?.()
        waiting.push(ready)
      })
    } else active++
    try { return await execute(...args) }
    finally {
      const next = waiting.shift()
      if (next) next()
      else active--
    }
  }
}
const run: Run = boundedPullRequestRunner(async (command, args, cwd) => {
  // The focused pane's folder is read for its pull request whatever it is (insideGitCheckout).
  if (command === 'git' && !(await insideGitCheckout(cwd))) throw new Error('not a Git checkout')
  const env = { ...process.env, GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' }
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_NAMESPACE', 'GIT_PREFIX']) delete (env as NodeJS.ProcessEnv)[key]
  return (await exec(command, args, { cwd, env, timeout: command === 'git' ? 1500 : 5000,
    killSignal: 'SIGKILL', maxBuffer: 256 * 1024 })).stdout.trim()
})
export type FoundPullRequest = {
  status: 'found'; number: number; url: string; state: 'Draft' | 'Open' | 'Merged' | 'Closed'
  title?: string; headBranch?: string; baseBranch?: string; headRepository?: string;
  checkedAt?: string;
  createdAt?: string; updatedAt?: string; mergedAt?: string; closedAt?: string;
  related?: FoundPullRequest[];
}
export type PullRequestResult = { status: 'none' | 'unavailable' } | FoundPullRequest
export type PullRequestIdentity = { branch: string; remote: string | null }
export function githubRepository(remote: string): string | null {
  const match = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(remote)
  const repo = match?.[1]
  return repo && validPullRequestUrl(`https://github.com/${repo}/pull/1`) ? repo : null
}
function prResult(pr: unknown, repo: string): PullRequestResult {
  if (pr === null || typeof pr !== 'object') return { status: 'unavailable' }
  const row = pr as Record<string, unknown>
  if (!Number.isSafeInteger(row.number) || Number(row.number) <= 0 || !['open', 'closed'].includes(String(row.state))
    || row.html_url !== `https://github.com/${repo}/pull/${row.number}` || !validPullRequestUrl(row.html_url)) return { status: 'unavailable' }
  const label = (v: unknown): string | undefined => typeof v === 'string' && v.length <= 512
    ? v.replace(/[\x00-\x1f\x7f]+/g, ' ').trim() || undefined : undefined
  const head = row.head as { ref?: unknown; repo?: { full_name?: unknown } } | undefined
  const base = row.base as { ref?: unknown } | undefined
  const dates: Partial<FoundPullRequest> = {}
  for (const [wire, field] of [['created_at', 'createdAt'], ['updated_at', 'updatedAt'],
    ['merged_at', 'mergedAt'], ['closed_at', 'closedAt']] as const) {
    const value = row[wire]
    if (typeof value === 'string' && Number.isFinite(Date.parse(value))) dates[field] = new Date(value).toISOString()
  }
  return { status: 'found', number: Number(row.number), url: row.html_url,
    ...dates,
    state: row.merged_at ? 'Merged' : row.state === 'closed' ? 'Closed' : row.draft ? 'Draft' : 'Open',
    ...(label(row.title) ? { title: label(row.title) } : {}),
    ...(label(head?.ref) ? { headBranch: label(head?.ref) } : {}),
    ...(label(base?.ref) ? { baseBranch: label(base?.ref) } : {}),
    ...(label(head?.repo?.full_name) ? { headRepository: label(head?.repo?.full_name) } : {}),
  }
}
/** Look up PRs for a branch already associated with a session, even after checkout/deletion. */
export function createBranchPullRequestReader(execute: Run = run, now = Date.now) {
  const cache = new Map<string, { until: number; value: Promise<PullRequestResult> }>()
  return async ({ branch, remote }: PullRequestIdentity, cwd = tmpdir()): Promise<PullRequestResult> => {
    const repo = remote && githubRepository(`https://${remote}`)
    if (!repo || !branch || branch.length > 256 || /[\x00-\x1f\x7f]/.test(branch)) return { status: 'unavailable' }
    const key = JSON.stringify([repo, branch])
    const previous = cache.get(key)
    if (previous && previous.until > now()) return previous.value
    const value = (async (): Promise<PullRequestResult> => {
      try {
        // GitHub redirects renamed repositories; compare against its canonical identity,
        // not a stale origin spelling (for example autonomous-harness → openharness).
        const metadata = JSON.parse(await execute('gh', ['api', '--hostname', 'github.com', '--jq', '{full_name,fork,parent:{full_name:.parent.full_name}}', `repos/${repo}`], cwd))
        const canonical = typeof metadata?.full_name === 'string' ? metadata.full_name : ''
        if (!canonical || githubRepository(`https://github.com/${canonical}`) !== canonical) return { status: 'unavailable' }
        const parent = metadata.fork && typeof metadata.parent?.full_name === 'string'
          && githubRepository(`https://github.com/${metadata.parent.full_name}`) === metadata.parent.full_name
          ? metadata.parent.full_name as string : null
        const repositories = [...new Set([...(parent ? [parent] : []), canonical])]
        const found: FoundPullRequest[] = []
        let unavailable = false
        const deadline = Date.now() + 10_000
        for (const baseRepo of repositories) {
          try {
            // Ask for open work first, so a long history of closed PRs cannot hide an old open PR.
            for (const state of ['open', 'closed']) {
              if (Date.now() >= deadline) { unavailable = true; break }
              const query = new URLSearchParams({ state, head: `${canonical.split('/')[0]}:${branch}`, sort: 'updated', direction: 'desc', per_page: '100' })
              const rows: unknown = JSON.parse(await execute('gh', ['api', '--hostname', 'github.com', '--jq', 'map({number,html_url,title,state,draft,created_at,updated_at,merged_at,closed_at,head:{ref:.head.ref,repo:{full_name:.head.repo.full_name}},base:{ref:.base.ref}})', `repos/${baseRepo}/pulls?${query}`], cwd))
              if (!Array.isArray(rows)) { unavailable = true; break }
              const matches = rows.filter(p => p?.head?.ref === branch && p?.head?.repo?.full_name?.toLowerCase() === canonical.toLowerCase())
              for (const match of matches) {
                const result = prResult(match, baseRepo)
                if (result.status === 'found') {
                  const duplicate = found.findIndex(p => p.url === result.url)
                  if (duplicate < 0) found.push(result)
                  else if (result.state === 'Open' || result.state === 'Draft') found[duplicate] = result
                } else unavailable = true
              }
            }
          } catch { unavailable = true }
        }
        const pr = found.find(p => p.state === 'Open' || p.state === 'Draft') ?? found[0]
        if (!pr) return { status: unavailable ? 'unavailable' : 'none' }
        const checkedAt = new Date(now()).toISOString()
        const related = found.filter(p => p !== pr).slice(0, 127).map(p => ({ ...p, checkedAt }))
        return { ...pr, checkedAt, ...(related.length ? { related } : {}) }
      } catch { return { status: 'unavailable' } }
    })()
    cache.set(key, { until: now() + 60_000, value })
    if (cache.size > 128) cache.delete(cache.keys().next().value!)
    return value
  }
}
export const readBranchPullRequest = createBranchPullRequestReader()

/** Read-only, on the machine owning the checkout. No shell, browser login, fetch or checkout. */
export function createPullRequestReader(execute: Run = run, now = Date.now) {
  const readBranch = createBranchPullRequestReader(execute, now)
  const cache = new Map<string, { until: number; value: Promise<PullRequestResult> }>()
  return async (cwd: string, expected?: PullRequestIdentity): Promise<PullRequestResult> => {
    if (!validGitPath(cwd)) return { status: 'unavailable' }
    try {
      const [branch, remote] = await Promise.all([
        execute('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], cwd),
        execute('git', ['remote', 'get-url', 'origin'], cwd),
      ])
      const repo = githubRepository(remote)
      if (!repo || !branch) return { status: 'unavailable' }
      if (expected && (expected.branch !== branch || expected.remote !== canonicalRepository(remote))) return { status: 'unavailable' }
      const stillCurrent = async (result: PullRequestResult): Promise<PullRequestResult> => {
        const [head, origin] = await Promise.all([
          execute('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], cwd),
          execute('git', ['remote', 'get-url', 'origin'], cwd),
        ])
        return head === branch && origin === remote ? result : { status: 'unavailable' }
      }
      const key = JSON.stringify([cwd, repo, branch])
      const previous = cache.get(key)
      if (previous && previous.until > now()) return await stillCurrent(await previous.value)
      const value = readBranch({ branch, remote: canonicalRepository(remote) }, cwd)
      cache.set(key, { until: now() + 60_000, value })
      if (cache.size > 128) cache.delete(cache.keys().next().value!)
      return await stillCurrent(await value)
    } catch { return { status: 'unavailable' } }
  }
}
export const readGitPullRequest = createPullRequestReader()

/** A recorded PR survives its branch and checkout. Resolve it by its durable URL on the owning
 * machine, without setting cwd to a directory that may since have been removed. */
export function createPullRequestUrlReader(execute: Run = run, now = Date.now) {
  const cache = new Map<string, { until: number; value: Promise<PullRequestResult> }>()
  return async (url: string): Promise<PullRequestResult> => {
    if (!validPullRequestUrl(url)) return { status: 'unavailable' }
    const previous = cache.get(url)
    if (previous && previous.until > now()) return previous.value
    const value = (async (): Promise<PullRequestResult> => {
      try {
        const [, owner, name, , number] = new URL(url).pathname.split('/')
        const row = JSON.parse(await execute('gh', ['api', '--hostname', 'github.com',
          '--jq', '{number,html_url,title,state,draft,created_at,updated_at,merged_at,closed_at,head:{ref:.head.ref,repo:{full_name:.head.repo.full_name}},base:{ref:.base.ref}}', `repos/${owner}/${name}/pulls/${number}`], tmpdir()))
        // GitHub redirects renamed repositories. Return its canonical URL so history can
        // merge an old saved alias with a match discovered through the renamed origin.
        if (!validPullRequestUrl(row?.html_url) || row.number !== Number(number)) return { status: 'unavailable' }
        const canonical = new URL(row.html_url).pathname.split('/').slice(1, 3).join('/')
        const result = prResult(row, canonical)
        return result.status === 'found' ? { ...result, checkedAt: new Date(now()).toISOString() } : result
      } catch { return { status: 'unavailable' } }
    })()
    cache.set(url, { until: now() + 60_000, value })
    if (cache.size > 256) cache.delete(cache.keys().next().value!)
    return value
  }
}
export const readPullRequestUrl = createPullRequestUrlReader()
