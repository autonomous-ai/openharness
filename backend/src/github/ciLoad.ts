/**
 * The jobs running and waiting on a Swarm project's GitHub Actions, for the route (Scholes's goals, piece 5: work that starts
 * heavy CI waits while the account is at its limit of 20 running jobs, 5 on macOS). Counts only: never a run's name, branch,
 * actor or the token it was read with. Read through the Harness GitHub App, never a person's login, and only for a repository
 * approved for the project wherever approval is asked, as a token for it would be (github/projectAccess.ts).
 */
import { GitHubAppError, type CiLoad, type GitHubApp } from './app.js'
import { githubRepository } from './repository.js'

export type ProjectCiLoad =
  | { state: 'read'; load: CiLoad }
  | { state: 'unavailable' | 'no-repository' | 'not-github' | 'not-installed' | 'not-approved' | 'unknown' }

/** [app]: this server's GitHub App, null when it has none. [approved]: whether the repository is approved for this project. */
export async function projectCiLoad(app: Pick<GitHubApp, 'ciLoad'> | null, repositoryUrl: string | null,
  approved: (repository: string) => Promise<boolean>): Promise<ProjectCiLoad> {
  if (!app) return { state: 'unavailable' }
  if (!repositoryUrl) return { state: 'no-repository' }
  const repository = githubRepository(repositoryUrl)
  if (!repository) return { state: 'not-github' }
  // Not approved reads nothing at all, so a project naming a repository it may not use learns nothing of it.
  if (!await approved(repository.fullName.toLowerCase())) return { state: 'not-approved' }
  try {
    const load = await app.ciLoad(repository)
    return load ? { state: 'read', load } : { state: 'not-installed' }
  } catch (error) {
    // Wrong app credentials are the server's to fix and say so; GitHub not answering is unknown, never a load of zero.
    if (error instanceof GitHubAppError && error.code === 'GITHUB_APP_MISCONFIGURED') throw error
    return { state: 'unknown' }
  }
}
