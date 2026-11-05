/**
 * Whether the account an agent would run in can reach its project's repository (task #3266): an agent in a Harness Team
 * account, or on a machine whose owner does not own the project, reaches GitHub only through the Harness GitHub App's token
 * (routes/superTabs.ts `github-token`, cli superTabs/projectFolder.ts startGitHub). Such a start was failed by its machine
 * instead, twice, which suspended Claude there (Huy's groupme, 2026-11-05). The token endpoint still decides access: this
 * only refuses earlier, and a read that could not say refuses nothing.
 */
import type { ProjectGitHubAccess } from '../github/projectAccess.js'
import { fail, type SuperTabState } from './model.js'
import { ownsProject, type SwarmProject } from './projects.js'

/** What the store read of the project's GitHub access before the command (store.ts repositoryReachFor). */
export type RepositoryReach = Extract<ProjectGitHubAccess, { state: 'covered' | 'unknown' }> | { state: 'not-installed'; repository: string; installUrl: string | null }
  | { state: 'not-approved'; repository: string }

export const REPOSITORY_UNREACHABLE = 'REPOSITORY_UNREACHABLE'

const ownerOf = (repository: string) => repository.split('/')[0]
const install = (reach: Extract<RepositoryReach, { state: 'not-installed' }>) =>
  `An owner of ${ownerOf(reach.repository)} installs it${reach.installUrl ? ` (${reach.installUrl})` : ''}`

/** Refuses an agent in a Team account ([team]), or of a machine owner who does not own [project], when the app does not reach its repository. */
export function requireRepositoryReach(state: SuperTabState, team: boolean, machineOwnerId: string, project: SwarmProject, reach: RepositoryReach | undefined): void {
  if (!reach || (reach.state !== 'not-installed' && reach.state !== 'not-approved')) return
  if (!team && ownsProject(state, machineOwnerId, project)) return
  const through = `An agent in this account reaches ${reach.repository} only through the Harness GitHub App`
  fail(REPOSITORY_UNREACHABLE, reach.state === 'not-installed'
    ? `${through}, which is not installed on it. ${install(reach)}, then start or assign it again.`
    : `${through}, and nobody who can push to it has approved it for this project. Someone who can push to it approves it in Harness `
      + '(Project details, GitHub access), then start or assign it again.', 409)
}

/** Why GitHub cannot show who pushed, when it is that the app is not installed: a Team account cannot reach it either. */
export function unknownPushReason(reach: RepositoryReach | undefined): string | null {
  return reach?.state === 'not-installed'
    ? `GitHub cannot show who pushed this task's code because the Harness GitHub App is not installed on ${reach.repository}, so it may run only in a `
      + `Team account, and a Team account reaches the repository only through that app. ${install(reach)}; then it runs in your own account.`
    : null
}
