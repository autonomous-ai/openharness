/** Restore may wait for preparation; session ownership must survive that wait before core writes. */
import { externalResumePending } from '../../lib/externalResume.js'
import type { RegisteredSession } from '../../lib/registry.js'
import type { LaunchOverrides, LaunchOverridesResult } from '../../lib/launchOverrides.js'
import type { RestoreAgentsDeps, RestoreLaunch } from '../../lib/restoreAgents.js'
import { windowsLaunchRefusal } from '../../lib/windows/launch.js'

interface RestoreLaunchDeps {
  workspaceMissing(cwd: string | null | undefined): { error: string; detail: string } | null
  relaunchOverrides(entry: RegisteredSession, source: RegisteredSession, current: () => boolean): Promise<LaunchOverridesResult>
  downgradedPermission(entry: RegisteredSession, native?: LaunchOverrides['native']): Promise<{ permissionMode?: string | null; bypassPermission?: boolean; nativeHold?: string }>
  prepareSessionResume(entry: RegisteredSession): void
  refreshGridWebSearch(agentId: string, overrides: LaunchOverrides): void
  launch(entry: RegisteredSession, opts: { resumeSessionId?: string }, overrides: LaunchOverrides,
    permission: { permissionMode?: string | null; bypassPermission?: boolean }): RestoreLaunch
}

export function createRestoreLaunch(deps: RestoreLaunchDeps): RestoreAgentsDeps['buildLaunch'] {
  return async (entry, { current, prepare, ...opts }) => {
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
    const permission = await deps.downgradedPermission(entry, built.overrides.native)
    if (!current()) return { cancelled: true }
    if (permission.nativeHold) return { held: 'native', detail: permission.nativeHold }
    if (built.overrides.native?.current() === false) return { held: 'native', detail: 'Waiting for fresh executable and hook evidence.' }
    // A move builds its launch while the engine still runs (hostMove/moveAgent.ts): the conversation may only be
    // prepared, and the row written, once that engine has stopped. The move runs this itself then, and relaunches with
    // these same overrides if it falls back, so nothing is asked of the grid or the Store again while the agent's input
    // is held.
    const preparation = () => {
      if (opts.resumeSessionId) deps.prepareSessionResume(entry)
      deps.refreshGridWebSearch(entry.agentId, built.overrides)
    }
    // These writes are synchronous and belong to the core. Neither a stopped conversation's
    // transcript/tail nor a replacement binding's grid may be changed by an old Store answer.
    if (prepare !== false) {
      if (opts.resumeSessionId) {
        try { deps.prepareSessionResume(entry) } catch (error) {
          return { error: 'RESUME_PREPARATION_FAILED', detail: error instanceof Error ? error.message : String(error) }
        }
      }
      deps.refreshGridWebSearch(entry.agentId, built.overrides)
    }
    // Windows refuses a batch-file engine whose arguments cmd.exe would read (lib/windows/launch.ts): this row fails
    // alone. Thrown, it ended the whole pass ("restore skipped") on every start.
    let launched: RestoreLaunch
    try { launched = await deps.launch(entry, opts, built.overrides, permission) } catch (error) {
      const { error: code, detail } = windowsLaunchRefusal(error)
      return { error: code, detail }
    }
    return prepare === false ? { ...launched, deferred: { prepare: preparation, overrides: built.overrides, permission } } : launched
  }
}
