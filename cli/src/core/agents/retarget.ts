/**
 * Moving a RUNNING agent onto a grid, or back to its engine's own login (`agent_retarget`).
 *
 * A process's environment is fixed at `execve`, so there is no way to re-point a live engine short of
 * replacing the process. `respawn-pane -k` does exactly that and keeps the pane, which keeps the pane
 * id, which keeps the agent's identity, its tile and its scrollback — the user sees their agent
 * restart, not a new agent appear. `--resume` brings the conversation back.
 *
 * Every check refuses instead of doing something partial, because a half-applied move is
 * indistinguishable from a working one until the bill arrives.
 *
 * Moved verbatim out of `runForeground` (the core boundary, step 11: docs/design/2026-10-03-harnessd.md).
 */
import type { BackendSocket } from '../../backendSocket.js'
import { applyOpencodeSessionModel, parseOpencodeModelId } from '../../engines/opencode/sessionModel.js'
import { isOpencodeV2, opencodeMajorVersion } from '../../engines/opencode/version.js'
import { binaryOnPath } from '../../lib/binaryOnPath.js'
import { probeGatewayRuntime } from '../../lib/gatewayRuntime.js'
import { probeGridAssignment } from '../../lib/gridAssignment.js'
import { describeGridLaunch, gridEnvVarNames } from '../../lib/gridLaunch.js'
import { validateLaunchOverrides, type LaunchOverridesDeps, type LaunchSource } from '../../lib/launchOverrides.js'
import { sid } from '../../lib/log.js'
import type { registry, RegisteredSession } from '../../lib/registry.js'
import { bypassPermissionFor, restartAgent } from '../../lib/restartAgent.js'
import type { RuntimeProfileManager } from '../../lib/runtimeProfile.js'
import { parseRuntimeProfile } from '../../lib/runtimeProfileWire.js'
import type { ScreenReader } from '../../lib/screenReader.js'
import type { TerminalAgentReconciler } from '../../lib/terminalAgentReconciler.js'
import { terminalRouteKey } from '../../lib/terminalRuntime.js'
import type { TmuxRuntimeRef } from '../../lib/terminalTypes.js'
import { clearPaneRemainOnExit, processArgs } from '../../lib/tmux.js'
import type { TmuxBackend } from '../../lib/tmuxBackend.js'
import { workspaceMissing } from '../../lib/workspaceCheck.js'
import type { createLaunchHelpers } from './launch.js'
import type { PaneSwap } from './swap.js'

type LaunchHelpers = ReturnType<typeof createLaunchHelpers>

type RetargetAgent = NonNullable<BackendSocket['onRetargetAgent']>

export interface RetargetDeps {
  readScreen: ScreenReader
  /** Whether a purge holds this agent (PurgeAgentService.busy). */
  purgeBusy: (agentId: string) => boolean | undefined
  tmuxBackend: TmuxBackend | null
  registry: typeof registry
  runtimeProfiles: Pick<RuntimeProfileManager, 'selectedModel'>
  launchOverridesDeps: LaunchOverridesDeps
  captureTerminal: (target: string, historyLines?: number) => Promise<string | null>
  acquireTerminalControl: (id: string, opts?: { forAnswer?: boolean }) => (() => void) | null
  relaunchOverrides: LaunchHelpers['relaunchOverrides']
  downgradedPermission: LaunchHelpers['downgradedPermission']
  agentReconciler: Pick<TerminalAgentReconciler, 'holdRoute' | 'releaseRoute'>
  restartJobs: PaneSwap['restartJobs']
  paneSwapDeps: PaneSwap['paneSwapDeps']
  liveBypassPermission: PaneSwap['liveBypassPermission']
  announceSession: (session: RegisteredSession) => void
  /** OpenCode's store, whose rows a resumed session takes its model from. */
  opencodeDb: string
}

export function createAgentRetargeter({
  readScreen, purgeBusy, tmuxBackend, registry, runtimeProfiles, launchOverridesDeps, captureTerminal, acquireTerminalControl,
  relaunchOverrides, downgradedPermission, agentReconciler, restartJobs, paneSwapDeps, liveBypassPermission,
  announceSession, opencodeDb,
}: RetargetDeps) {
  const retargetAgent: RetargetAgent = async ({ agentId, grid }) => {
    if (purgeBusy(agentId)) return { ok: false, error: 'AGENT_BUSY' }
    if (!tmuxBackend) return { ok: false, error: 'TMUX_UNAVAILABLE' }
    const session = registry.resolve(agentId)
    if (!session) return { ok: false, error: 'AGENT_NOT_FOUND' }
    const pane = session.runtimes.find((runtime): runtime is TmuxRuntimeRef => runtime.backend === 'tmux')
    // Only tmux panes can be respawned. Saying so is better than a generic failure the user cannot act on.
    if (!pane) return { ok: false, error: 'RETARGET_UNSUPPORTED_BACKEND', detail: `${session.engine} is not running in a tmux pane` }
    // The swap kills a process it has validated by pid + start marker. Without one there is nothing to
    // validate, and respawning over a pane whose occupant we cannot identify is how you replace
    // something that was not ours.
    if (!session.processIdentity) return { ok: false, error: 'NO_ACTIVE_PROCESS' }
    // Leaving for a grid is the LAST moment this agent's own model is observable: once the pane is on
    // the grid, the engine reports the grid's model and the previous choice exists nowhere. So it is
    // read now and kept, and a later move back returns the person to it rather than to whatever
    // default the engine would otherwise fall to. Read from the live engine, not from the row.
    //
    // Coming back reads what was kept. Not cleared on the way home: an agent bounced between a grid
    // and its own login should land on the same model every time, not only the first.
    // ⚠️ `selectedModel` answers an ENCODED runtime-profile id (`runtime-v1:…`), not a model name —
    // handing that to an engine would point it at a model that does not exist. Decode it and take
    // the model. For claude the decoded value is already the vendor's alias (`opus`), which is what
    // ANTHROPIC_MODEL wants. Null when the daemon has not observed this pane's model yet, which is a
    // real answer: there is then nothing to come back to and the engine decides, as it did before.
    // ⚠️ The profile's OWN engine has to match, not just the session it was read under. A model is
    // only meaningful to the engine that named it — `opencode/big-pickle` handed back as
    // ANTHROPIC_MODEL is not a Claude model, and Claude Code says so ("It may not exist or you may
    // not have access to it") on a pane the user never chose it for. The keying bug that let one
    // agent read another's model is fixed at its source in RuntimeProfileManager; this is the second
    // lock, because the cost of being wrong here is a pane that answers on nothing.
    const profile = parseRuntimeProfile(runtimeProfiles.selectedModel(session))
    const observed = profile && profile.engine === session.engine ? profile.model : null
    const remembered = grid
      // Two guards, and both come from watching this go wrong:
      //
      //  * Capture only when the agent is on its OWN LOGIN. Moving grid→grid must not overwrite the
      //    memory with the first grid's model — the subscription choice has not changed, and the
      //    whole point is to still have it on the way home.
      //
      //  * Never remember the model being moved TO. An engine can keep REPORTING a grid model after
      //    it has come back (Claude Code restores it from its own session file and says so), so a
      //    later move to that same grid would otherwise capture the grid's model as the
      //    "subscription" one and hand it straight back — teaching the bug to itself.
      ? (!session.grid && observed !== grid.model ? observed : (session.subscriptionModel ?? null))
      : (session.subscriptionModel ?? null)
    // What this machine cannot do at all is said first, before the pane is even looked at.
    const target: LaunchSource = {
      gridLaunch: grid,
      codexHome: session.codexHome,
      ...(grid ? {} : { subscriptionModel: remembered }),
    }
    const valid = await validateLaunchOverrides(launchOverridesDeps, session.engine, target)
    if (!valid.ok) return { ok: false, error: valid.error, detail: valid.detail }
    // A resumed opencode session takes its model from its own rows in opencode.db, not from `-m`
    // (see below), and those rows are written through the `sqlite3` CLI. Without it the respawn
    // would land the right provider, key and argv on a pane that then answers on the OLD model —
    // the failure this handler exists to refuse — so it is refused here, before the pane is touched.
    // Only when the launch will name a model: a grid launch always does; a move home does only when
    // the remembered model carries its provider (`subscriptionModel.ts`), and otherwise the engine
    // decides, as it always did. v2 switches the model through OpenCode's own API instead and needs no
    // sqlite3 (`applyOpencodeSessionModel`).
    const rewritesOpencodeSession = session.engine === 'opencode' && !!session.sessionId
      && (!!grid || !!remembered?.includes('/'))
    const opencodeMajor = session.engine === 'opencode' ? opencodeMajorVersion() : null
    if (rewritesOpencodeSession && !isOpencodeV2(opencodeMajor) && !binaryOnPath('sqlite3')) {
      return {
        ok: false,
        error: 'OPENCODE_SQLITE_MISSING',
        detail: 'the sqlite3 CLI is not on PATH, and a resumed opencode session keeps its model unless its store is rewritten — install sqlite3 and retry',
      }
    }
    // The replacement enters the row's folder before it execs: a folder that is gone is refused here,
    // with the other refusals, before the pane is touched or its control taken.
    const missing = workspaceMissing(session.cwd)
    if (missing) return missing
    // Mid-turn is the one state where restarting costs real work: the conversation comes back but
    // whatever the engine was doing does not. The app is told which agents these are so the user can
    // move them once they are done, rather than being asked to choose between losing a turn and losing
    // the grid.
    const capture = await captureTerminal(session.agentId, 100)
    if (!capture) return { ok: false, error: 'TMUX_FAILED' }
    if (!(await readScreen(session, capture))?.pane.idle) return { ok: false, error: 'AGENT_BUSY' }
    // Nothing may type into the pane while it is being replaced.
    if (restartJobs.busy(session.agentId)) return { ok: false, error: 'AGENT_BUSY' }
    const release = acquireTerminalControl(session.agentId)
    if (!release) return { ok: false, error: 'AGENT_BUSY' }
    // The grid's env and argv, config directory written (keyed on the agent, so moving it between
    // grids rewrites one directory) — or nothing at all for a move back to the engine's own login
    // (clearing uses set-environment, which every supported tmux has). Built from the override the
    // desktop just sent, never from the row: the row is what this call REPLACES. After the refusal
    // guards, so a refused move leaves the live process's own configuration untouched.
    const built = await relaunchOverrides(session, target)
    if (!built.ok) {
      release()
      return { ok: false, error: built.error, detail: built.detail }
    }

    // ⚠️ THE AGENT MUST ADOPT THE NEW PROCESS, OR IT STOPS BEING THE SAME AGENT.
    //
    // Identity in this daemon is keyed on the PROCESS, not the pane: the reconciler matches an existing
    // record to an observation by pid + start marker (`currentProcessKey`), and its same-pane fallback
    // only applies to an agent with no bound engine session. A respawn changes the pid, so left to
    // discovery the new process is an unmatched observation — `onDiscovered` mints a NEW agent id, and
    // the record the user was looking at becomes a ghost that the app still lists, still counts as "on
    // an older target", and still offers to move. Moving it respawns the same pane again. Holding the
    // route shuts the reconciler out for the duration; rebinding below is what ends the swap.
    const routeKey = terminalRouteKey(pane)
    agentReconciler.holdRoute(routeKey)
    try {
      // Back to the engine's own login. Nothing is built, because there is no launch to build. If this
      // agent was launched onto a grid at creation, `new-session -e` wrote the grid's variables into
      // the pane's SESSION environment, which a bare respawn-pane would inherit — clearing them first
      // is what makes the env-less respawn below actually land on the engine's own login instead of
      // silently keeping the old grid. If instead the agent was moved here by an earlier retarget,
      // `respawn-pane -e` set those variables on that one process, not the session, so this clear is
      // a harmless no-op and it is the env-less respawn itself that drops them. Either way the pane
      // ends up clean. Run only after every refusal guard above: an early return with the pane
      // already cleared but its live process untouched would leave that process still talking to the
      // grid while the retarget reports failed — the exact half-applied state this handler exists to
      // refuse.
      //
      // OpenCode's TUI drops `-m` when it RESUMES a session: it restores the model from the session's
      // LAST USER MESSAGE (`data.model`), and its server falls back to the `session.model` column
      // (measured on 1.18.31; upstream anomalyco/opencode #26901). Nothing else — config, model.json,
      // `--fork` — changes a resumed session's model; the picker is the only writer opencode ships,
      // and those two rows are what it writes. So they are written here, through SQL, before the
      // respawn, with the exact `provider/model` the respawn's own `-m` names — and the TUI opens
      // already on it, with nothing typed into the pane. Before the live process is touched, so a
      // write that fails refuses the move with that process still on its old target. A session with
      // no user message yet has nothing to restore from and takes `-m` on launch, so it is skipped.
      //
      // OpenCode 2.0 has no `-m` on its TUI, keeps sessions in tables the SQL above never reads (it
      // used to answer SESSION_NOT_FOUND there, read as success, and then respawn with `-m` into
      // `Unrecognized flag: -m` and a dead pane), and ships its own writer: the service's
      // `session.switchModel`. `applyOpencodeSessionModel` picks per version, and on v2 every
      // failure refuses the move — with the live process still untouched.
      if (rewritesOpencodeSession) {
        const model = built.overrides.sessionModel ? parseOpencodeModelId(built.overrides.sessionModel) : null
        if (model) {
          const written = await applyOpencodeSessionModel({
            opencodeMajor, dbPath: opencodeDb, sessionId: session.sessionId, model, cwd: session.cwd ?? undefined,
            // (A model of opencode's own is looked for in its catalogue; a grid's provider lives in
            // the pane's own config, which the service never reads.)
            checkCatalog: !grid,
          })
          if (!written.ok) {
            console.warn(`[grid] retarget ${sid(session.agentId)} refused · ${written.code} · ${written.detail}`)
            return { ok: false, error: written.code, detail: written.detail }
          }
        }
      }
      if (!grid) {
        const cleared = await tmuxBackend.clearEnv(pane, gridEnvVarNames(session.engine))
        if (cleared.state !== 'succeeded') {
          return { ok: false, error: 'GRID_CLEAR_FAILED', detail: 'reason' in cleared ? cleared.reason : 'tmux would not clear the pane environment' }
        }
      }
      const retargetPermission = await downgradedPermission(session,
        await bypassPermissionFor(session, () => liveBypassPermission(session)), 'retarget')
      const outcome = await restartAgent(
        { engine: session.engine, sessionId: session.sessionId },
        retargetPermission.bypassPermission === true,
        paneSwapDeps(session, pane, built.overrides, retargetPermission.permissionMode ?? null),
      )
      if (!outcome.ok) {
        console.warn(`[grid] retarget ${sid(session.agentId)} failed · ${outcome.detail}`)
        return { ok: false, error: 'RESPAWN_FAILED', detail: outcome.detail }
      }
      // Both are read off the new pid: its cached environment, and for the grid its command line too.
      const [gateway, assignment] = await Promise.all([
        probeGatewayRuntime(outcome.processIdentity),
        // Its command line, which carries a Codex or pi grid's address and model: never its executable.
        processArgs(outcome.processIdentity).then((args) => probeGridAssignment(outcome.processIdentity, session.engine, args)),
      ])
      registry.updateProcessIdentity(session.agentId, outcome.processIdentity, gateway.kind, assignment)
      // The launch that just worked is the one a restart or a post-reboot restore must repeat — and
      // what it decided about web search is what the app shows for this agent from now on. Null for
      // a move home: the block, and the status with it, leave the frame together.
      registry.setGridLaunch(session.agentId, built.overrides.gridLaunchRecord ?? null)
      // Persisted only on the way OUT, and only once the move actually succeeded — a refused move
      // must not overwrite the model the agent is still sitting on. Survives a daemon restart, so an
      // agent left on a grid for a week still knows where it came from.
      if (grid && remembered) registry.setSubscriptionModel(session.agentId, remembered)
      registry.setActive(session.agentId, true)
      await clearPaneRemainOnExit(pane.paneId)
      const refreshed = registry.byAgent(session.agentId)
      // The app decides whether to still offer a move from what it is told here, so a silent success
      // would leave the banner up over an agent that had already been moved.
      if (refreshed) announceSession(refreshed)
      const how = outcome.resumed ? 'resumed' : 'fresh session'
      const record = built.overrides.gridLaunchRecord
      const where = record
        ? describeGridLaunch(session.engine, record.override, record.webSearch)
        : `${session.engine} on its own login`
      console.log(`${where} · retargeted ${sid(session.agentId)} · ${how}`)
      // Nothing is typed into the pane after the respawn. A resumed opencode session used to be put
      // on its model through the `/models` picker here (MODEL_SELECT_FAILED); its store is rewritten
      // before the respawn instead, see above.
      return { ok: true }
    } finally {
      release()
      agentReconciler.releaseRoute(routeKey)
    }
  }
  return retargetAgent
}
