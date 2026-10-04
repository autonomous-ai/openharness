/**
 * Relaunch helpers: what a restart, a retarget, a restore or a resume needs to bring an agent's pane
 * back. Its launch overrides, rebuilt from the row (an API's key as saved now); the web-search decision
 * refreshed; a permission flag the engine no longer takes dropped, rather than the pane; and a Codex
 * rollout repaired for resume, with the tail moved to its new length.
 *
 * Moved verbatim out of `runForeground` (the core boundary, step 10: docs/design/2026-10-03-harnessd.md).
 */
import { prepareCodexResume } from '../../engines/codex/portableHistory.js'
import { ApiConnectionError, type ApiConnections } from '../../lib/apiConnections.js'
import { refreshApiLaunch } from '../../lib/apiModels.js'
import { dropPermissionFlagIfUnsupported } from '../../lib/engineLaunch.js'
import { isApiLaunch } from '../../lib/gridLaunch.js'
import { buildLaunchOverrides, type LaunchOverrides, type LaunchOverridesDeps, type LaunchOverridesResult, type LaunchSource } from '../../lib/launchOverrides.js'
import { sid } from '../../lib/log.js'
import { prepareInstructionWrites } from '../../scm/scmProjects.js'
import type { registry, RegisteredSession } from '../../lib/registry.js'

export interface LaunchHelperDeps {
  /** Writes the saved APIs' tool instructions into the agent's folder before it launches. */
  prepareApiTools: (cwd: string | null | undefined, engine: string) => void
  savedApis: ApiConnections
  launchOverridesDeps: LaunchOverridesDeps
  setGridLaunch: typeof registry.setGridLaunch
  /** Moves a session's tail to a byte (Watcher.setTail). */
  setTail: (sessionId: string, offset: number) => void
}

export function createLaunchHelpers({ prepareApiTools, savedApis, launchOverridesDeps, setGridLaunch, setTail }: LaunchHelperDeps) {
  // Whatever the source (the row itself, or a grid override the desktop just sent), the agent's DSH,
  // workspace and named agent come from the row: a retarget must not silently drop the harness the
  // agent is, or bring a pane opened as `harness-compute` back as a general session.
  // An agent on a saved API's model relaunches with that API's endpoint and key as saved now, so a key
  // pasted since takes effect, and a removed API is refused rather than kept on its old key.
  const relaunchOverrides = async (session: RegisteredSession, source: LaunchSource = session): Promise<LaunchOverridesResult> => {
    await prepareInstructionWrites(session.cwd)
    prepareApiTools(session.cwd, session.engine)
    let gridLaunch = source.gridLaunch ?? null
    if (gridLaunch && isApiLaunch(gridLaunch)) {
      try {
        gridLaunch = refreshApiLaunch(savedApis, gridLaunch)
      } catch (error) {
        return {
          ok: false,
          error: 'API_UNAVAILABLE',
          detail: error instanceof ApiConnectionError ? error.message : `${gridLaunch.networkName} could not be read from saved APIs.`,
        }
      }
    }
    return buildLaunchOverrides(launchOverridesDeps, session.engine, { dsh: session.dsh ?? null, dshRuntime: session.dshRuntime ?? null, cwd: session.cwd, agent: session.agent ?? null, scmLaunch: session.scmLaunch ?? null, ...source, gridLaunch }, session.agentId)
  }

  /**
   * A restart or a post-reboot restore rebuilds the ROW's own launch, and the machine may decide
   * differently about web search this time than it did when the row was written (an administrator
   * pinned `/etc/hermes` since, or unpinned it). The override is the row's already; what is
   * refreshed is the decision, so the frame describes the pane that actually came up. Retarget
   * does not go through here — its override is new, and it records the pair itself once the move
   * has succeeded.
   */
  const refreshGridWebSearch = (agentId: string, overrides: LaunchOverrides): void => {
    if (overrides.gridLaunchRecord) setGridLaunch(agentId, overrides.gridLaunchRecord)
  }

  /**
   * The permission this relaunch can actually ask for. Nobody is waiting on a restart, a retarget, a
   * restore or a resume, so an engine that no longer takes the row's flag costs it the mode, not the
   * harness — the alternative is a pane of help text, or no pane at all (openharness#285).
   *
   * The row is NOT rewritten. `permissionMode` is the person's recorded choice and `setPermissionMode`
   * is fill-only for that reason; an engine put back the way it was gets Auto again on the next
   * relaunch, with nobody having to ask for it twice. The row stops CLAIMING the mode on its own:
   * discovery re-derives `bypassPermission` from the live argv on every pass (`setBypassPermission`
   * above), so a launch without the flag reads as one within a reconcile.
   *
   * ⚠️ Its alias in runForeground is DECLARED BEFORE THE RESTORE PASS, and has to stay there:
   * `restoreAgents` calls `buildLaunch` for every pane it rebuilds, which asks this, during start-up.
   */
  const downgradedPermission = async (
    session: RegisteredSession,
    bypassPermission: boolean,
    what: string,
  ): Promise<{ permissionMode?: string | null; bypassPermission?: boolean }> => {
    const { choice, droppedFlag } = await dropPermissionFlagIfUnsupported(session.engine, {
      permissionMode: session.permissionMode ?? null,
      bypassPermission,
    })
    if (droppedFlag) {
      console.warn(`[agent] ${what} ${sid(session.agentId)} · ${session.engine} does not take ${droppedFlag}`
        + ` · starting in Ask · update ${session.engine} to get ${session.permissionMode ?? 'Auto'} back`)
    }
    return choice
  }

  const prepareSessionResume = (session: RegisteredSession): void => {
    const repair = prepareCodexResume(session)
    if (repair.repairedItems) {
      // The rollout we tail was just shrunk in place. Move the tail to the repaired length now, before
      // the resumed engine appends, or the watcher would read the whole repaired history as new lines
      // and the live normalizer would replay the conversation into web/device. See Watcher.setTail.
      if (repair.repairedBytes !== undefined) setTail(session.sessionId, repair.repairedBytes)
      console.log(`[resume] repaired ${repair.repairedItems} Codex reasoning items · backup: ${repair.backupPath}`)
    }
  }
  return { relaunchOverrides, refreshGridWebSearch, downgradedPermission, prepareSessionResume }
}
