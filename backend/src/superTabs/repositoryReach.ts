/**
 * Whether the account an agent would run in can reach its project's repository (task #3266): an agent in a Harness Team
 * account, or on a machine whose owner does not own the project, reaches GitHub only through the Harness GitHub App's token
 * (routes/superTabs.ts `github-token`, cli superTabs/projectFolder.ts startGitHub).
 */
import type { ProjectGitHubAccess } from '../github/projectAccess.js'

/** What the store read of the project's GitHub access before the command (store.ts repositoryReachFor). */
export type RepositoryReach = Extract<ProjectGitHubAccess, { state: 'covered' | 'unknown' }> | { state: 'not-installed'; repository: string; installUrl: string | null }
  | { state: 'not-approved'; repository: string }

export const REPOSITORY_UNREACHABLE = 'REPOSITORY_UNREACHABLE'
