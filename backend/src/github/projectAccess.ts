/**
 * Whether teammates' agents can push and open pull requests on a Swarm project's repository: the Harness GitHub App is
 * installed there (docs/plans/2026-10-28-swarm-project-github-access.md). Read by the app to show it where the project
 * is, before a start fails on it. Holds the repository's name and the public install link, never a token.
 */
import { GitHubAppError, type GitHubApp } from './app.js'
import { githubRepository } from './repository.js'

export type ProjectGitHubAccess =
  | { state: 'unavailable' }
  | { state: 'no-repository' }
  | { state: 'not-github'; repositoryUrl: string }
  | { state: 'covered'; repository: string }
  | { state: 'not-installed'; repository: string; installUrl: string | null; canApprove: boolean }
  | { state: 'not-approved'; repository: string; canApprove: boolean }
  | { state: 'unknown'; repository: string }

/** [app]: this server's GitHub App, null when it has none. [approved]: whether someone who can push to the repository
 *  approved it for this project (github/approvals.ts). [canApprove]: this server has the app's sign-in to approve with.
 *  [refresh]: a person asked to check again. */
export async function projectGitHubAccess(app: Pick<GitHubApp, 'resolve' | 'forget' | 'installUrl' | 'currentFullName'> | null, repositoryUrl: string | null,
  approval: { approved: (repository: string) => Promise<boolean>; canApprove: boolean }, refresh = false): Promise<ProjectGitHubAccess> {
  if (!app) return { state: 'unavailable' }
  if (!repositoryUrl) return { state: 'no-repository' }
  const repository = githubRepository(repositoryUrl)
  if (!repository) return { state: 'not-github', repositoryUrl }
  if (refresh) app.forget(repository)
  try {
    const resolved = await app.resolve(repository)
    if (!resolved) {
      return { state: 'not-installed', repository: repository.fullName, installUrl: app.installUrl(), canApprove: approval.canApprove }
    }
    // Shown by its name now; approvals stay with the address the project names.
    const shown = resolved.repository.fullName !== repository.fullName ? resolved.repository.fullName : await app.currentFullName(repository)
    return await approval.approved(repository.fullName.toLowerCase()) ? { state: 'covered', repository: shown }
      : { state: 'not-approved', repository: shown, canApprove: approval.canApprove }
  } catch (error) {
    // Wrong app credentials are the server's to fix and say so; GitHub not answering is never read as covered.
    if (error instanceof GitHubAppError && error.code === 'GITHUB_APP_MISCONFIGURED') throw error
    return { state: 'unknown', repository: repository.fullName }
  }
}
