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

const MAX_PULLS = 5
const MAX_PR_COMMITS = 250
const COMMIT_PAGES = 3
const ACTIVITY_PAGES = 20
/** How long before a pull request opened its commits may have been pushed, for the log's scan to stop. */
const BEFORE_PULL_MS = 7 * 24 * 3_600_000
const TEAM_ADDRESS = /\[bot\]@|^harnessteam@/i

type Json = Record<string, unknown>
const object = (value: unknown): Json => value && typeof value === 'object' ? value as Json : {}
const isBot = (user: unknown): boolean => {
  const { type, login } = object(user)
  return type === 'Bot' || (typeof login === 'string' && login.endsWith('[bot]'))
}

/** Reads the pull request [number] of `owner/name` [repository] through [read]. A failed or partial read is `unknown`. */
export async function readPushOrigin(read: GitHubRead, repository: string, number: number): Promise<PushOrigin> {
  const base = `/repos/${repository}`
  try {
    const pull = await read(`${base}/pulls/${number}`)
    if (pull.status !== 200) return 'unknown'
    const head = object(object(pull.body).head), created = Date.parse(String(object(pull.body).created_at))
    const headRepository = object(head.repo).full_name
    // A fork's pushes are not in this repository's log.
    if (typeof headRepository !== 'string' || headRepository.toLowerCase() !== repository.toLowerCase() || typeof head.sha !== 'string' || !Number.isFinite(created)) return 'unknown'

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
    for (const commit of commits) {
      const detail = object(commit.commit)
      if (isBot(commit.author) || isBot(commit.committer)) return 'team'
      if ([object(detail.author).email, object(detail.committer).email].some(email => typeof email === 'string' && TEAM_ADDRESS.test(email))) return 'team'
    }

    const until = created - BEFORE_PULL_MS
    let path: string | undefined = `${base}/activity?per_page=100`, headByPerson = false
    for (let page = 0; page < ACTIVITY_PAGES && path; page++) {
      const answer: Awaited<ReturnType<GitHubRead>> = await read(path)
      if (answer.status !== 200 || !Array.isArray(answer.body)) return 'unknown'
      const entries = answer.body.map(object)
      for (const entry of entries) {
        if (!shas.has(entry.after)) continue
        if (!entry.actor) return 'unknown'
        if (isBot(entry.actor)) return 'team'
        if (entry.after === head.sha) headByPerson = true
      }
      path = Date.parse(String(entries.at(-1)?.timestamp)) < until ? undefined : answer.next
      if (!path) return headByPerson ? 'clean' : 'unknown'
    }
    // Twenty pages did not reach the time this pull request's commits could have been pushed.
    return 'unknown'
  } catch {
    return 'unknown'
  }
}
