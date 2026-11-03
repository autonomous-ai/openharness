/**
 * Who pushed a pull request's commits (audit H2, docs/plans/2026-11-02-team-written-branch-plan.md). A Team agent pushes with
 * the Harness GitHub App's token, and GitHub's activity log names each push's actor, which the pusher cannot write. A commit's
 * author can be written by anyone, so it can show a branch is Team-written, and never that it is clean.
 *
 * `clean` needs proof: a person's push of the head, and no bot's push among its commits. Anything GitHub cannot show is
 * `unknown`, which callers treat as Team-written. The answer is the verdict alone: no name, branch or title.
 */
import { githubRepository, type GitHubRepository } from './repository.js'

export type PushOrigin = 'clean' | 'team' | 'unknown'

/** One GET: `next` is the following page's path from GitHub's Link header, when there is one. */
export type GitHubRead = (path: string) => Promise<{ status: number; body: unknown; next?: string }>

/** The pull requests [text] speaks of: its links, and "PR #N" or "pull request #N" of this project's repository. A bare "#N" may be a task's number, so it is left out. */
export function pullRequestsIn(text: string, repositoryUrl: string | null): string[] {
  const links = [...text.matchAll(/https:\/\/github\.com\/[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+\/pull\/[1-9][0-9]*\b/g)].map(m => m[0])
  const repository = githubRepository(repositoryUrl)
  if (!repository) return [...new Set(links)]
  const named = [...text.matchAll(/\b(?:PR|pull request)\s*#([1-9][0-9]*)\b/gi)].map(m => `https://github.com/${repository.fullName}/pull/${m[1]}`)
  return [...new Set([...links, ...named])]
}

/**
 * The worst answer among [urls], for the Swarm's store. Only pull requests of the project's own repository are read: a link
 * to another repository can never add or clear a mark, and a task with no such link has nothing to read.
 */
export const projectPushOrigin = (app: { pushOrigin(repository: GitHubRepository, number: number): Promise<PushOrigin> }) =>
  async (repositoryUrl: string | null, urls: string[]): Promise<PushOrigin> => {
    const repository = githubRepository(repositoryUrl)
    if (!repository) return 'unknown'
    const own = urls.flatMap(url => {
      const match = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)$/.exec(url)
      return match && match[1]!.toLowerCase() === repository.fullName.toLowerCase() ? [Number(match[2])] : []
    })
    const answers = await Promise.all(own.slice(0, MAX_PULLS).map(number => app.pushOrigin(repository, number)))
    return answers.includes('team') ? 'team' : answers.includes('unknown') || own.length > MAX_PULLS ? 'unknown' : 'clean'
  }

export const projectBranchOrigin = (app: { branchOrigin(repository: GitHubRepository, branch: string): Promise<PushOrigin> }) =>
  async (repositoryUrl: string | null, branch: string): Promise<PushOrigin> => {
    const repository = githubRepository(repositoryUrl)
    return repository ? app.branchOrigin(repository, branch) : 'unknown'
  }

const MAX_PULLS = 5
const MAX_PR_COMMITS = 250
const COMMIT_PAGES = 3
const REF_PAGES = 3
const ACTIVITY_PAGES = 20
/** How long before a pull request opened its commits may have been pushed, for the log's scan to stop. */
const BEFORE_PULL_MS = 7 * 24 * 3_600_000
// Harness's own address (app.ts COMMIT_IDENTITY) too: a commit that keeps it after a person cherry-picks it. Only ever adds a mark.
const TEAM_ADDRESS = /\[bot\]@|^harnessteam@|^noreply@autonomous\.ai$/i

type Json = Record<string, unknown>
const object = (value: unknown): Json => value && typeof value === 'object' ? value as Json : {}
const isBot = (user: unknown): boolean => {
  const { type, login } = object(user)
  return type === 'Bot' || (typeof login === 'string' && login.endsWith('[bot]'))
}

/**
 * Reads the pull request [number] of `owner/name` [repository] through [read]. A failed or partial read is `unknown`.
 * [bot] is the app's own login. The whole log is too long to walk: 2,000 events reached 3.3 days on this project's repository
 * (review 1 of #2559). So it asks two narrow questions: who pushed this branch's head, and which of this pull request's
 * commits the app's bot ever pushed, on any branch.
 */
export async function readPushOrigin(read: GitHubRead, repository: string, number: number, bot: string | null): Promise<PushOrigin> {
  const base = `/repos/${repository}`
  if (!bot) return 'unknown'
  try {
    const pull = await read(`${base}/pulls/${number}`)
    if (pull.status !== 200) return 'unknown'
    const head = object(object(pull.body).head), created = Date.parse(String(object(pull.body).created_at))
    const headRepository = object(head.repo).full_name
    // A fork's pushes are not in this repository's log.
    if (typeof headRepository !== 'string' || headRepository.toLowerCase() !== repository.toLowerCase()
      || typeof head.sha !== 'string' || typeof head.ref !== 'string' || !Number.isFinite(created)) return 'unknown'

    const commits: Json[] = []
    for (let page = 1; page <= COMMIT_PAGES; page++) {
      const answer = await read(`${base}/pulls/${number}/commits?per_page=100&page=${page}`)
      if (answer.status !== 200 || !Array.isArray(answer.body)) return 'unknown'
      commits.push(...answer.body.map(object))
      if (answer.body.length < 100) break
    }
    if (!commits.length || commits.length >= MAX_PR_COMMITS) return 'unknown'
    const shas = new Set(commits.map(c => c.sha))
    if (!shas.has(head.sha)) return 'unknown'
    let oldest = created
    for (const commit of commits) {
      const detail = object(commit.commit)
      if (isBot(commit.author) || isBot(commit.committer)) return 'team'
      if ([object(detail.author).email, object(detail.committer).email].some(email => typeof email === 'string' && TEAM_ADDRESS.test(email))) return 'team'
      // Only ever widens the scan. A batch opened today holds commits pushed weeks ago; a forged later date changes nothing here.
      const date = Date.parse(String(object(detail.committer).date))
      if (Number.isFinite(date) && date < oldest) oldest = date
    }
    const until = oldest - BEFORE_PULL_MS

    // Who pushed the head, on its own branch.
    let path: string | undefined = `${base}/activity?ref=${encodeURIComponent(head.ref)}&per_page=100`, headByPerson = false
    for (let page = 0; page < REF_PAGES && path && !headByPerson; page++) {
      const answer: Awaited<ReturnType<GitHubRead>> = await read(path)
      if (answer.status !== 200 || !Array.isArray(answer.body)) return 'unknown'
      for (const entry of answer.body.map(object)) {
        if (!shas.has(entry.after)) continue
        if (!entry.actor) return 'unknown'
        if (isBot(entry.actor)) return 'team'
        if (entry.after === head.sha) headByPerson = true
      }
      path = answer.next
    }
    if (!headByPerson) return 'unknown'

    // Whether the app's bot pushed any of these commits, on any branch: how a batch holds a Team agent's commits.
    path = `${base}/activity?actor=${encodeURIComponent(bot)}&per_page=100`
    for (let page = 0; page < ACTIVITY_PAGES; page++) {
      const answer: Awaited<ReturnType<GitHubRead>> = await read(path)
      if (answer.status !== 200 || !Array.isArray(answer.body)) return 'unknown'
      const entries = answer.body.map(object)
      if (entries.some(entry => shas.has(entry.after))) return 'team'
      if (!answer.next || Date.parse(String(entries.at(-1)?.timestamp)) < until) return 'clean'
      path = answer.next
    }
    // Twenty pages of the bot's pushes did not reach the time these commits could have been pushed.
    return 'unknown'
  } catch {
    return 'unknown'
  }
}
