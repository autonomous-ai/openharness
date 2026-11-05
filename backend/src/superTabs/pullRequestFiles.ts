/**
 * The files a task's pull requests change, read with the Harness GitHub App when its Engineer hands it over (task #3401):
 * what reviewTable.ts plans its review steps from. Only pull requests of the project's own repository are read, at most
 * MAX_PULLS, with one read-only token revoked when done. Any failure reads as files null, which plans the strictest steps.
 */
import { PULL_WATCH_PERMISSIONS, type GitHubApp } from '../github/app.js'
import { githubRepository, type GitHubRepository } from '../github/repository.js'
import { logger } from '../utils/logger.js'

/** What this read needs of the app: the pull request's head from its watch read, and its files (github/app.ts). */
export interface PullRequestFilesApp {
  resolve: GitHubApp['resolve']
  createToken: GitHubApp['createToken']
  revoke: GitHubApp['revoke']
  watchPullRequest(repository: GitHubRepository, number: number, token: string): Promise<{ head: string } | null>
  pullRequestFiles(repository: GitHubRepository, number: number, token: string): Promise<Array<{ filename: string }> | null>
}

/** What the store gives a Ready's command: the pull requests read, the first one's head, and every file they change. */
export interface PullRequestFilesRead { urls: string[]; head: string | null; files: string[] | null }

const MAX_PULLS = 5
const PULL = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/([1-9][0-9]*)$/

/** The store's hook: null when [urls] holds no pull request of [repositoryUrl]'s repository, so there is nothing to read. */
export const projectPullRequestFiles = (app: PullRequestFilesApp) =>
  async (repositoryUrl: string | null, urls: string[]): Promise<PullRequestFilesRead | null> => {
    const repository = githubRepository(repositoryUrl)
    if (!repository) return null
    const own = urls.flatMap(url => {
      const match = PULL.exec(url)
      return match && match[1]!.toLowerCase() === repository.fullName.toLowerCase() ? [{ url, number: Number(match[2]) }] : []
    })
    if (!own.length) return null
    const read: PullRequestFilesRead = { urls: own.map(pull => pull.url), head: null, files: null }
    // More than it reads: the ones left unread could change anything, so the plan is as strict as the rules go, never one
    // made from some of them (security review 2 of #3227).
    if (own.length > MAX_PULLS) return read
    let token: string | null = null
    try {
      const resolved = await app.resolve(repository)
      if (!resolved) return read
      token = (await app.createToken(resolved.installation, resolved.repository, PULL_WATCH_PERMISSIONS)).token
      const files = new Set<string>()
      for (const [i, pull] of own.entries()) {
        // The files of the head the watch read: when a push moved it while they were listed, they read as unreadable.
        const watch = await app.watchPullRequest(resolved.repository, pull.number, token)
        if (i === 0) read.head = watch?.head ?? null
        const listed = watch ? await app.pullRequestFiles(resolved.repository, pull.number, token) : null
        const after = listed ? await app.watchPullRequest(resolved.repository, pull.number, token) : null
        const changed = listed && after?.head === watch!.head ? listed : null
        if (!changed) return { ...read, files: null }
        for (const file of changed) files.add(file.filename)
      }
      return { ...read, files: [...files] }
    } catch (error) {
      logger.warn('[swarm-review-steps] pull request files not read', { error: error instanceof Error ? error.message : String(error) })
      return { ...read, files: null }
    } finally {
      if (token) await app.revoke(token).catch(() => {})
    }
  }
