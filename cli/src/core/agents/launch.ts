import type { NativeLaunch } from '../../engines/nativeLaunch.js'
/**
 * Relaunch helpers: what a restart, a retarget, a restore or a resume needs to bring an agent's pane
 * back. Its launch overrides, rebuilt from the row (an API's key as saved now); the web-search decision
 * refreshed; a permission flag the engine no longer takes dropped, rather than the pane; and the history made
 * resumable (Codex's rollout, engines/launchPrep.ts), with the tail moved to its new length.
 *
 * Moved verbatim out of `runForeground` (the core boundary, step 10: docs/design/2026-10-03-harnessd.md).
 */
import { join } from 'node:path'
import { env } from '../../config/env.js'
import { repairedItemsName } from '../../engines/launchPrep.js'
import { REPAIR_LIMITS, type HistoryRepair, type ResumeSource, type Unrepaired } from '../../engines/facets/resumeRepair.js'
import { bringPiSessionHome } from '../../lib/piSessionHome.js'
import { gridConfigRoot } from '../../lib/gridConfigDir.js'
import { dropPermissionFlagIfUnsupported } from '../../lib/engineLaunch.js'
import { gridUnavailable, type GridLaunchAnswer, type GridLaunchRequest } from '../../lib/gridLaunchWire.js'
import { buildLaunchOverrides, type LaunchOverrides, type LaunchOverridesDeps, type LaunchOverridesResult, type LaunchSource } from '../../lib/launchOverrides.js'
import type { ModelsPort } from '../api.js'
import { sid } from '../../lib/log.js'
import { prepareInstructionWrites } from '../../scm/launch.js'
import type { registry, RegisteredSession } from '../../lib/registry.js'

/**
 * The models service's grid launch, as every launch in the core asks it (`ModelsPort.gridLaunch`): its answer, or,
 * when models is down or answers nothing usable, the refusal that says so (`gridUnavailable`), never a launch on
 * the engine's own login and never a wait past the call's bound (core/serviceLinks.ts). A saved API's endpoint
 * the answer read is one the core's grid assignment recognises from then on, as when the core read it itself.
 */
export function gridLaunchThrough(models: () => Pick<ModelsPort, 'gridLaunch'>) {
  return async (request: GridLaunchRequest): Promise<GridLaunchAnswer> => {
    let answer: GridLaunchAnswer
    try { answer = await models().gridLaunch(request) } catch { return gridUnavailable(request.engine, request.override) }
    return answer
  }
}

/** Why a history was left unrepaired, in the daemon log's words. */
const UNREPAIRED: Record<Unrepaired, string> = {
  too_large: `its history is over ${REPAIR_LIMITS.maxBytes / 1024 ** 3} GiB, or a record over ${REPAIR_LIMITS.maxRecordBytes / 1024 ** 2} MiB`,
  timed_out: `the repair took over ${REPAIR_LIMITS.deadlineMs / 1000} s`,
  cancelled: 'what asked for it stopped waiting',
  unavailable: 'Codex\'s worker did not provide a usable preparation',
  busy: 'the bounded repair capacity is in use',
  cleanup_failed: 'RESUME_REPAIR_CLEANUP_FAILED: private staging needs recovery',
}

export interface LaunchHelperDeps {
  /** Capture dispatch authority before a service can yield to Stop or a replacement binding. */
  authority: (agentId: string) => () => boolean
  /** Writes the saved APIs' tool instructions into the agent's folder before it launches. */
  prepareApiTools: (cwd: string | null | undefined, engine: string) => void
  launchOverridesDeps: LaunchOverridesDeps
  setGridLaunch: typeof registry.setGridLaunch
  /** The publication coordinator moves the tail in the same turn as its atomic replacement. */
  prepareResume: (source: ResumeSource, current: () => boolean) => Promise<HistoryRepair>
}

export function createLaunchHelpers({ authority, prepareApiTools, launchOverridesDeps, setGridLaunch, prepareResume }: LaunchHelperDeps) {
  // Whatever the source (the row itself, or a grid override the desktop just sent), the agent's DSH,
  // workspace, named agent and who started it come from the row: a retarget must not silently drop the harness
  // the agent is, or bring a pane opened as `harness-compute` back as a general session.
  // An agent on a saved API's model relaunches with that API's endpoint and key as saved now, so a key
  // pasted since takes effect, and a removed API is refused rather than kept on its old key: the models
  // service reads them as it builds the launch (`buildLaunchOverrides`, `refresh`).
  const relaunchOverrides = async (session: RegisteredSession, source: LaunchSource = session, operationCurrent: () => boolean = () => true, native?: NativeLaunch, configKey = session.agentId): Promise<LaunchOverridesResult> => {
    const dispatchCurrent = authority(session.agentId)
    const current = () => operationCurrent() && dispatchCurrent()
    session = structuredClone(session)
    const changed = { ok: false, error: 'AGENT_CHANGED', detail: 'The harness changed or stopped during launch preparation.' } as const
    if (!current()) return changed
    const result = await buildLaunchOverrides(launchOverridesDeps, session.engine, { dsh: session.dsh ?? null, dshRuntime: session.dshRuntime ?? null, cwd: session.cwd, agent: session.agent ?? null, scmLaunch: session.scmLaunch ?? null, startedBy: session.startedBy ?? null, launchArgs: session.launchArgs, ...source, gridLaunch: source.gridLaunch ?? null, openclawLocal: session.openclawLocal ?? null }, configKey, current, native)
    if (!current()) return changed
    if (!result.ok && (result.unavailable || result.error === 'AGENT_CHANGED')) return result
    // Saved-API instructions remain available after an ordinary semantic refusal, as before.
    // A missing dependency or revoked operation must leave these files untouched.
    await prepareInstructionWrites(session.cwd)
    if (!current()) return changed
    prepareApiTools(session.cwd, session.engine)
    if (result.ok && session.externalResume?.request.engine === session.engine) {
      result.overrides.extraArgs.push(...session.externalResume.session?.launchArgs ?? [])
    }
    return result
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
    native?: NativeLaunch,
  ): Promise<{ permissionMode?: string | null; bypassPermission?: boolean; nativeHold?: string }> => {
    const { choice, droppedFlag, nativeHold } = await dropPermissionFlagIfUnsupported(session.engine, {
      permissionMode: session.permissionMode ?? null,
      bypassPermission,
    }, undefined, native)
    if (droppedFlag) {
      console.warn(`[agent] ${what} ${sid(session.agentId)} · ${session.engine} does not take ${droppedFlag}`
        + ` · starting in Ask · update ${session.engine} to get ${session.permissionMode ?? 'Auto'} back`)
    }
    return { ...choice, ...(nativeHold ? { nativeHold } : {}) }
  }

  /**
   * The conversation made resumable once its engine has stopped; true when its history was replaced. `current` is the
   * operation's own: the history is replaced only while it holds, and is left as it was once it does not. Throws when
   * the history could not be prepared; one too large or too slow to read here is left as it is, as the log says.
   */
  const prepareSessionResume = async (session: RegisteredSession, current: () => boolean): Promise<boolean> => {
    if (session.engine === 'pi') {
      // A Pi an older grid launch moved into the daemon's own folder resumes from its own home now.
      const roots = [gridConfigRoot(), join(env.ADAPTER_DATA_DIR, 'grid-launch-config')]
      const sessions = process.env.PI_CODING_AGENT_SESSION_DIR || join(process.env.PI_CODING_AGENT_DIR || join(env.PI_HOME, 'agent'), 'sessions')
      // Best effort: this runs after the old Pi has stopped, and a copy that cannot be made must not cost the
      // relaunch. Pi then resumes what it can find, as it did before.
      try {
        const home = bringPiSessionHome(session.transcriptPath, roots, sessions)
        if (home && home !== session.transcriptPath) console.log(`[resume] ${sid(session.agentId)} · pi's conversation brought home · ${home}`)
      } catch (error) {
        console.warn(`[resume] ${sid(session.agentId)} · could not bring pi's conversation home · ${error instanceof Error ? error.message : error}`)
      }
    }
    const repair = await prepareResume(session, current)
    if (repair.unrepaired) {
      console.warn(`[resume] ${sid(session.agentId)} · ${repairedItemsName(session.engine)} not repaired: ${UNREPAIRED[repair.unrepaired]} · the history is left as it is`)
    }
    if (repair.repairedItems) {
      // Publication already moved Watcher's cursor in the rename's turn, before another reader or the engine runs.
      console.log(`[resume] repaired ${repair.repairedItems} ${repairedItemsName(session.engine)} · private backup kept`)
    }
    return repair.repairedItems > 0
  }
  return { relaunchOverrides, refreshGridWebSearch, downgradedPermission, prepareSessionResume }
}
