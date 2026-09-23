import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { validGitPath } from './gitProject.js'

const exec = promisify(execFile)
type Run = (command: string, args: string[], cwd: string) => Promise<string>
const run: Run = async (command, args, cwd) => {
  const env = { ...process.env, GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' }
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_NAMESPACE', 'GIT_PREFIX']) delete (env as NodeJS.ProcessEnv)[key]
  return (await exec(command, args, { cwd, env, timeout: 8000, killSignal: 'SIGKILL', maxBuffer: 256 * 1024 })).stdout.trim()
}
export type PullRequestResult = { status: 'none' | 'unavailable' } | {
  status: 'found'; number: number; url: string; state: 'Draft' | 'Open' | 'Merged' | 'Closed'
}
export function githubRepository(remote: string): string | null {
  const match = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(remote)
  return match?.[1] ?? null
}
/** Read-only, on the machine owning the checkout. No shell, browser login, fetch or checkout. */
export function createPullRequestReader(execute: Run = run, now = Date.now) {
  const cache = new Map<string, { until: number; value: Promise<PullRequestResult> }>()
  return async (cwd: string): Promise<PullRequestResult> => {
    if (!validGitPath(cwd)) return { status: 'unavailable' }
    try {
      const [branch, remote] = await Promise.all([
        execute('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], cwd),
        execute('git', ['remote', 'get-url', 'origin'], cwd),
      ])
      const repo = githubRepository(remote)
      if (!repo || !branch) return { status: 'unavailable' }
      const key = JSON.stringify([cwd, repo, branch])
      const previous = cache.get(key)
      if (previous && previous.until > now()) return previous.value
      const value = (async (): Promise<PullRequestResult> => {
        try {
          // GitHub redirects renamed repositories; compare against its canonical identity,
          // not a stale origin spelling (for example autonomous-harness → openharness).
          const metadata = JSON.parse(await execute('gh', ['api', '--hostname', 'github.com', '--jq', '{full_name}', `repos/${repo}`], cwd))
          const canonical = typeof metadata?.full_name === 'string' ? metadata.full_name : ''
          if (!canonical || githubRepository(`https://github.com/${canonical}`) !== canonical) return { status: 'unavailable' }
          const query = new URLSearchParams({ state: 'all', head: `${canonical.split('/')[0]}:${branch}`, sort: 'updated', direction: 'desc', per_page: '100' })
          const rows: unknown = JSON.parse(await execute('gh', ['api', '--hostname', 'github.com', '--jq', 'map({number,html_url,state,draft,merged_at,head:{ref:.head.ref,repo:{full_name:.head.repo.full_name}}})', `repos/${canonical}/pulls?${query}`], cwd))
          if (!Array.isArray(rows)) return { status: 'unavailable' }
          const matches = rows.filter(p => p?.head?.ref === branch && p?.head?.repo?.full_name?.toLowerCase() === canonical.toLowerCase())
          const pr = matches.find(p => p.state === 'open') ?? matches[0]
          if (!pr) return { status: 'none' }
          if (!Number.isSafeInteger(pr.number) || pr.number <= 0 || !['open', 'closed'].includes(pr.state)
            || pr.html_url !== `https://github.com/${canonical}/pull/${pr.number}`) return { status: 'unavailable' }
          return { status: 'found', number: pr.number, url: pr.html_url,
            state: pr.merged_at ? 'Merged' : pr.state === 'closed' ? 'Closed' : pr.draft ? 'Draft' : 'Open' }
        } catch { return { status: 'unavailable' } }
      })()
      cache.set(key, { until: now() + 60_000, value })
      if (cache.size > 128) cache.delete(cache.keys().next().value!)
      return value
    } catch { return { status: 'unavailable' } }
  }
}
export const readGitPullRequest = createPullRequestReader()
