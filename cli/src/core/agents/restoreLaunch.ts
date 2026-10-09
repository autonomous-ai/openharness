/** Restore may wait for preparation; session ownership must survive that wait before core writes. */
import { externalResumePending } from '../../lib/externalResume.js'
import type { RegisteredSession } from '../../lib/registry.js'
import type { LaunchOverrides, LaunchOverridesResult } from '../../lib/launchOverrides.js'
import type { RestoreAgentsDeps, RestoreLaunch } from '../../lib/restoreAgents.js'

interface RestoreLaunchDeps {
  workspaceMissing(cwd: string | null | undefined): { error: string; detail: string } | null
  relaunchOverrides(entry: RegisteredSession, source: RegisteredSession, current: () => boolean): Promise<LaunchOverridesResult>
  downgradedPermission(entry: RegisteredSession): Promise<{ permissionMode?: string | null; bypassPermission?: boolean }>
  prepareSessionResume(entry: RegisteredSession): void
  refreshGridWebSearch(agentId: string, overrides: LaunchOverrides): void
  launch(entry: RegisteredSession, opts: { resumeSessionId?: string }, overrides: LaunchOverrides,
    permission: { permissionMode?: string | null; bypassPermission?: boolean }): RestoreLaunch
}

export function createRestoreLaunch(deps: RestoreLaunchDeps): RestoreAgentsDeps['buildLaunch'] {
  return async (entry, { current, ...opts }) => {
    if (externalResumePending(entry.externalResume)) return { held: 'search', holdScope: 'workspace',
      detail: entry.launch?.state === 'held' ? entry.launch.detail : 'Waiting to verify this external conversation.' }
    const missing = deps.workspaceMissing(entry.cwd)
    if (missing) return missing
    const built = await deps.relaunchOverrides(entry, entry, current)
    if (!current()) return { cancelled: true }
    if (!built.ok && built.error === 'AGENT_CHANGED') return { cancelled: true }
    if (!built.ok) return built.unavailable
      ? { held: built.unavailable, detail: built.detail, holdScope: built.holdScope }
      : { error: built.error, detail: built.detail }
    const permission = await deps.downgradedPermission(entry)
    if (!current()) return { cancelled: true }
    // These writes are synchronous and belong to the core. Neither a stopped conversation's
    // transcript/tail nor a replacement binding's grid may be changed by an old Store answer.
    if (opts.resumeSessionId) {
      try { deps.prepareSessionResume(entry) } catch (error) {
        return { error: 'RESUME_PREPARATION_FAILED', detail: error instanceof Error ? error.message : String(error) }
      }
    }
    deps.refreshGridWebSearch(entry.agentId, built.overrides)
    return deps.launch(entry, opts, built.overrides, permission)
  }
}
