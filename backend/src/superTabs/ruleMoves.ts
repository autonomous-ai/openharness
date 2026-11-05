/**
 * When GitHub says the pull requests a person's moved rule waits on merged (task #3463, review of #3220): read by the store
 * before an instructions save that may drop a line kept in a code task (store.ts pullRequestMergesFor), with the Harness
 * GitHub App's read-only token, so it needs no archive pass and works with tidying off. The store caps what it asks for
 * (store.ts MAX_MERGE_READS). The guard counts a task merged only
 * for a merge after its brief was set (ruleGuard.ts rulePlaces).
 */
import { githubRepository, type GitHubRepository } from '../github/repository.js'
import { PULL_READ_PERMISSIONS, type GitHubApp } from '../github/app.js'
import { logger } from '../utils/logger.js'

const PULL = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/([1-9][0-9]*)$/

/** GitHub's read of one pull request: its status and body, or status 0 when it could not be read. */
export type PullGet = (repository: GitHubRepository, number: number) => Promise<{ status: number; body: unknown }>

/** When each of [urls] merged (ms), null for one GitHub says is not merged; one GitHub could not answer for is left out. */
export async function pullRequestMerges(urls: readonly string[], get: PullGet): Promise<Record<string, number | null>> {
  const answers = await Promise.all(urls.map(async url => {
    const match = PULL.exec(url), repository = match ? githubRepository(`https://github.com/${match[1]}`) : null
    if (!repository) return null
    const number = Number(match![2])
    const answer = await get(repository, number)
    const body = answer.body as { merged_at?: unknown } | null
    if (answer.status !== 200 || !body) {
      // Its rule's line stays as for a task not merged: said here, so a person told it waits can be told why (ENGINEERING.md 6).
      logger.warn('[swarm-instructions] merge time not read; the moved rule stays', { repository: repository.fullName, number, status: answer.status })
      return null
    }
    const at = typeof body.merged_at === 'string' ? Date.parse(body.merged_at) : null
    return [url, at !== null && Number.isNaN(at) ? null : at] as const
  }))
  return Object.fromEntries(answers.filter((answer): answer is readonly [string, number | null] => answer !== null))
}

/** The reader over the Harness GitHub App: one read-only token per repository for this save, revoked after. */
export function appPullRequestMerges(app: GitHubApp): (urls: readonly string[]) => Promise<Record<string, number | null>> {
  return async urls => {
    const tokens = new Map<string, Promise<string | null>>()
    const token = (repository: GitHubRepository) => {
      const key = repository.fullName.toLowerCase()
      if (!tokens.has(key)) tokens.set(key, (async () => {
        const installation = await app.installation(repository)
        return installation === null ? null : (await app.createToken(installation, repository, PULL_READ_PERMISSIONS)).token
      })().catch(() => null))
      return tokens.get(key)!
    }
    try {
      return await pullRequestMerges(urls, async (repository, number) => {
        const granted = await token(repository)
        return granted ? app.get(`/repos/${repository.fullName}/pulls/${number}`, granted).catch(() => ({ status: 0, body: null })) : { status: 0, body: null }
      })
    } finally {
      for (const [repository, granted] of tokens) {
        const value = await granted
        // Never the token: which repository's, and that it lives on until GitHub expires it (ENGINEERING.md 6).
        if (value) await app.revoke(value).catch(() => logger.warn('[swarm-instructions] GitHub token not revoked; it expires by itself within the hour', { repository }))
      }
    }
  }
}
