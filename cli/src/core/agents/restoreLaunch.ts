/** Restore may wait for preparation; session ownership must survive that wait before core writes. */
import { externalResumePending } from '../../lib/externalResume.js'
import type { RegisteredSession } from '../../lib/registry.js'
import type { LaunchOverrides, LaunchOverridesResult } from '../../lib/launchOverrides.js'
import type { RestoreAgentsDeps, RestoreLaunch } from '../../lib/restoreAgents.js'
import { windowsLaunchRefusal } from '../../lib/windows/launch.js'
import type { AdoptSwarmSkill } from '../api.js'
import { GUEST_HARNESS_REFUSAL } from '../guestPolicy.js'

/** What a harness held for its Swarm role says in its pane, in the person's words. */
export const SWARM_ROLE_HELD = 'Waiting for the Swarm to confirm this agent\'s role. It starts by itself once the Swarm answers.'

interface RestoreLaunchDeps {
  workspaceMissing(cwd: string | null | undefined): { error: string; detail: string } | null
  relaunchOverrides(entry: RegisteredSession, source: RegisteredSession, current: () => boolean): Promise<LaunchOverridesResult>
  downgradedPermission(entry: RegisteredSession, native?: LaunchOverrides['native']): Promise<{ permissionMode?: string | null; bypassPermission?: boolean; nativeHold?: string }>
  prepareSessionResume(entry: RegisteredSession): void
  refreshGridWebSearch(agentId: string, overrides: LaunchOverrides): void
  launch(entry: RegisteredSession, opts: { resumeSessionId?: string }, overrides: LaunchOverrides,
    permission: { permissionMode?: string | null; bypassPermission?: boolean }): RestoreLaunch
  /** An older Swarm session's role, read before it is relaunched (superTabs/inCore/adoption.ts). Absent while the Swarm is off. */
  adoptSwarmSkill?: AdoptSwarmSkill
}

export function createRestoreLaunch(deps: RestoreLaunchDeps): RestoreAgentsDeps['buildLaunch'] {
  return async (given, { current, prepare, ...opts }) => {
    // A guest's harness is never relaunched this way: every relaunch builds an owner's launch, which would run
    // the guest's conversation as the owner, with the owner's keys (core/guestPolicy.ts GUEST_HARNESS_REFUSAL).
    // On Windows the pane also belonged to the guest's own host, whose task may be gone.
    if (given.guest) return { error: GUEST_HARNESS_REFUSAL.error, detail: GUEST_HARNESS_REFUSAL.detail }
    if (externalResumePending(given.externalResume)) return { held: 'search', holdScope: 'workspace',
      detail: given.launch?.state === 'held' ? given.launch.detail : 'Waiting to verify this external conversation.' }
    const missing = deps.workspaceMissing(given.cwd)
    if (missing) return missing
    // An older Swarm session comes back with its role, or waits for it: boot restore and a host move relaunched an old
    // Swarm session with no saved role as an ordinary session (security review 1 of #2255). A held one waits in
    // its pane, and the held pass launches it once the Swarm answers (core/agents/heldLaunches.ts); a move does not happen.
    let entry = given
    const looked = await deps.adoptSwarmSkill?.lookup?.(given, current)
    if (looked !== undefined) {
      // The lookup answers null once this launch no longer owns the row.
      if (looked === null) return { cancelled: true }
      if (looked === 'unavailable') return { held: 'superTabs', detail: SWARM_ROLE_HELD }
      // A move builds this while the old engine still runs and writes the row only once it has stopped: it launches with the
      // role and leaves the record to the agent's next start, which reads it again.
      if (prepare !== false) looked.commit()
      entry = looked.row
    }
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
