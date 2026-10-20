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
import * as opencodeLaunch from '../../engines/launchControl.js'
import { binaryOnPath } from '../../lib/binaryOnPath.js'
import { builtinSqlite } from '../../lib/sqliteBuiltin.js'
import { probeGatewayRuntime } from '../../lib/gatewayRuntime.js'
import { describeGridLaunch, gridEnvVarNames } from '../../lib/gridLaunchWire.js'
import { validateLaunchOverrides, type LaunchOverridesDeps, type LaunchSource } from '../../lib/launchOverrides.js'
import { sid } from '../../lib/log.js'
import type { registry, RegisteredSession } from '../../lib/registry.js'
import { bypassPermissionFor, restartAgent } from '../../lib/restartAgent.js'
import type { RuntimeProfileManager } from '../../lib/runtimeProfile.js'
import { parseRuntimeProfile } from '../../lib/runtimeProfileWire.js'
import type { TerminalAgentReconciler } from '../../lib/terminalAgentReconciler.js'
import { canRestart, restartTargetOf } from '../../lib/terminalBackend.js'
import type { TerminalBackendCoordinator } from '../../lib/terminalBackendCoordinator.js'
import { terminalRouteKey } from '../../lib/terminalRuntime.js'
import { workspaceMissing } from '../../lib/workspaceCheck.js'
import type { createLaunchHelpers } from './launch.js'
import type { PaneSwap } from './swap.js'
import { createLaunchAuthority } from './launchAuthority.js'
import { nativeOpencodeStore } from '../../engines/kit/nativeLocations.js'
import { GUEST_HARNESS_REFUSAL } from '../guestPolicy.js'

type LaunchHelpers = ReturnType<typeof createLaunchHelpers>

type RetargetAgent = NonNullable<BackendSocket['onRetargetAgent']>

export interface RetargetDeps {
  /** What it answers when no backend here can respawn a pane: the configured backend's own code (terminalBackend.ts
   *  `noBackendCode`); `TMUX_UNAVAILABLE`, as before, by default. */
  noBackendCode?: string
  /** Whether the engine's turn state says this session is mid-turn (normalizers.sessionTurnOpen). */
  sessionTurnOpen: (sessionId: string) => boolean
  /** Whether a purge holds this agent (PurgeAgentService.busy). */
  purgeBusy: (agentId: string) => boolean | undefined
  /** The backends, and each runtime's own: a row is retargeted in the pane it is in (`restartTargetOf`). */
  terminals: Pick<TerminalBackendCoordinator, 'backendFor' | 'instances'>
  registry: typeof registry
  runtimeProfiles: Pick<RuntimeProfileManager, 'selectedModel'>
  launchOverridesDeps: LaunchOverridesDeps
  acquireTerminalControl: (id: string, opts?: { forAnswer?: boolean }) => (() => void) | null
  relaunchOverrides: LaunchHelpers['relaunchOverrides']
  downgradedPermission: LaunchHelpers['downgradedPermission']
  agentReconciler: Pick<TerminalAgentReconciler, 'holdRoute'>
  restartJobs: PaneSwap['restartJobs']
  paneSwapDeps: PaneSwap['paneSwapDeps']
  liveBypassPermission: PaneSwap['liveBypassPermission']
  announceSession: (session: RegisteredSession) => void
  refreshGridAssignment: (session: RegisteredSession) => void
  /** OpenCode's store, whose rows a resumed session takes its model from. */
  opencodeDb: string
}

export function createAgentRetargeter({
  sessionTurnOpen, purgeBusy, terminals, registry, runtimeProfiles, launchOverridesDeps, acquireTerminalControl,
  relaunchOverrides, downgradedPermission, agentReconciler, restartJobs, paneSwapDeps, liveBypassPermission,
  announceSession, refreshGridAssignment, opencodeDb, noBackendCode = 'TMUX_UNAVAILABLE',
}: RetargetDeps) {
  const authority = createLaunchAuthority({ byAgent: id => registry.byAgent(id),
    revision: id => restartJobs.revision(id), cancelled: () => false })
  const retargetAgent: RetargetAgent = async ({ agentId, grid }) => {
    if (purgeBusy(agentId)) return { ok: false, error: 'AGENT_BUSY' }
    // No backend here can respawn a pane (tmux missing, the pty host down): the configured backend's code.
    if (!terminals.instances().some(canRestart)) return { ok: false, error: noBackendCode }
    const live = registry.resolve(agentId)
    if (!live) return { ok: false, error: 'AGENT_NOT_FOUND' }
    if (live.guest) return GUEST_HARNESS_REFUSAL
    // Registry observations can update a row in place while a service or pane
    // read waits. The request keeps its original conversation and exact process.
    const session = structuredClone(live)
    grid = grid && structuredClone(grid)
    const captureAuthority = () => {
      const owns = authority(session.agentId)
      return () => !!registry.byAgent(session.agentId) && owns()
    }
    let current = captureAuthority()
    let nativeEffect: 'none' | 'uncertain' | 'applied' = 'none'
    let replacementStarted = false
    const failed = (error: string, detail: string) => ({ ok: false as const, error, detail: [
      nativeEffect === 'applied' ? 'The native model change was applied.'
        : nativeEffect === 'uncertain' ? 'The native model change may already have applied.' : '',
      replacementStarted ? 'The replacement process started, but retarget did not complete.' : '',
      detail,
    ].filter(Boolean).join(' ') })
    const changed = () => failed('AGENT_CHANGED', 'The harness changed or stopped during retarget.')
    // Only a pane on a backend that respawns in place can be retargeted: its tmux pane first, as before. Saying
    // so is better than a generic failure the user cannot act on.
    const place = restartTargetOf(session, (runtime) => terminals.backendFor(runtime))
    if (!place) return { ok: false, error: 'RETARGET_UNSUPPORTED_BACKEND', detail: `${session.engine} is not running in a tmux pane` }
    const { backend, runtime: pane } = place
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
    const inspected = await launchOverridesDeps.native?.(session.engine, session, { id: session.agentId, current })
    if (!current()) return changed()
    if (inspected && !inspected.ok) return inspected
    const native = inspected?.ok ? inspected.launch : undefined
    const valid = await validateLaunchOverrides(launchOverridesDeps, session.engine, target, native)
    if (!current()) return changed()
    if (!valid.ok) return { ok: false, error: valid.error, detail: valid.detail }
    // A resumed opencode session takes its model from its own rows in opencode.db, not from `-m`
    // (see below), and those rows are written through the `sqlite3` CLI, or through `node:sqlite` where no CLI
    // is installed (Windows; `kit/nativeSessionModel.ts`). Without either the respawn
    // would land the right provider, key and argv on a pane that then answers on the OLD model —
    // the failure this handler exists to refuse — so it is refused here, before the pane is touched.
    // Only when the launch will name a model: a grid launch always does; a move home does only when
    // the remembered model carries its provider (`subscriptionModel.ts`), and otherwise the engine
    // decides, as it always did. v2 switches the model through OpenCode's own API instead and needs no
    // sqlite3 (`applyOpencodeSessionModel`).
    const rewritesOpencodeSession = session.engine === 'opencode' && !!session.sessionId
      && (!!grid || !!remembered?.includes('/'))
    const opencode = session.engine === 'opencode' ? opencodeLaunch : null
    const opencodeMajor = native ? native.opencodeMajor : opencode ? await opencode.opencodeMajorVersion() : null
    if (!current()) return changed()
    if (rewritesOpencodeSession && opencode && !opencode.isOpencodeV2(opencodeMajor) && !builtinSqlite() && !binaryOnPath('sqlite3')) {
      return {
        ok: false,
        error: 'OPENCODE_SQLITE_MISSING',
        detail: 'this Node has no node:sqlite and the sqlite3 CLI is not on PATH, and a resumed opencode session keeps its model unless its store is rewritten — install sqlite3 and retry',
      }
    }
    // The replacement enters the row's folder before it execs: a folder that is gone is refused here,
    // with the other refusals, before the pane is touched or its control taken.
    const missing = workspaceMissing(session.cwd)
    if (missing) return missing
    // Mid-turn is the one state where restarting costs real work: the conversation comes back but
    // whatever the engine was doing does not. The engine's own turn state (hooks, transcript) says
    // so, for every engine; the screen is not read. It used to be, to keep an unsent draft, and an
    // engine whose placeholder colour moved (OpenCode 2) then read as holding one and refused every
    // switch until its first chat. A draft is lost to the respawn; that is the person's call.
    const inTurn = { ok: false as const, error: 'AGENT_BUSY', detail: 'This harness is in a turn. Stop it, then switch the model.' }
    if (session.sessionId && sessionTurnOpen(session.sessionId)) return inTurn
    // OpenCode 2 keeps its turns where that state does not read (`opencodeV2TurnOpen`), so its own
    // record is asked. A store it cannot read is no evidence of a turn, as for an engine with none.
    if (session.sessionId && opencode?.isOpencodeV2(opencodeMajor)) {
      const open = await opencode.opencodeV2TurnOpen(native ? nativeOpencodeStore(native.environment) : opencodeDb, session.sessionId)
      if (!current()) return changed()
      if (open) return inTurn
    }
    // Nothing may type into the pane while it is being replaced.
    if (purgeBusy(session.agentId) || restartJobs.busy(session.agentId)) return { ok: false, error: 'AGENT_BUSY' }
    const release = acquireTerminalControl(session.agentId)
    if (!release) return { ok: false, error: 'AGENT_BUSY' }
    // The old restore watcher stays cancelled after this control pin is released.
    restartJobs.cancel(session.agentId)
    current = captureAuthority()
    const routeKey = terminalRouteKey(pane)
    let releaseRoute: (() => void) | undefined
    try {
      // The grid's env and argv, config directory written (keyed on the agent, so moving it between
      // grids rewrites one directory) — or nothing at all for a move back to the engine's own login
      // (clearing uses set-environment, which every supported tmux has). Built from the override the
      // desktop just sent, never from the row: the row is what this call REPLACES. After the refusal
      // guards, so a refused move leaves the live process's own configuration untouched.
      const built = await relaunchOverrides(session, target, current, native)
      if (!current()) return changed()
      if (!built.ok) return { ok: false, error: built.error, detail: built.detail }
      const dispatchCurrent = () => current() && native?.current() !== false && built.overrides.native?.current() !== false
      const preparationChanged = () => current()
        ? failed('NATIVE_LAUNCH_HELD', 'Waiting for fresh executable and hook evidence.') : changed()
      if (!dispatchCurrent()) return preparationChanged()

      // ⚠️ THE AGENT MUST ADOPT THE NEW PROCESS, OR IT STOPS BEING THE SAME AGENT.
      //
      // Identity in this daemon is keyed on the PROCESS, not the pane: the reconciler matches an existing
      // record to an observation by pid + start marker (`currentProcessKey`), and its same-pane fallback
      // only applies to an agent with no bound engine session. A respawn changes the pid, so left to
      // discovery the new process is an unmatched observation — `onDiscovered` mints a NEW agent id, and
      // the record the user was looking at becomes a ghost that the app still lists, still counts as "on
      // an older target", and still offers to move. Moving it respawns the same pane again. Holding the
      // route shuts the reconciler out for the duration; rebinding below is what ends the swap.
      releaseRoute = agentReconciler.holdRoute(routeKey, null)
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
      if (rewritesOpencodeSession && opencode) {
        const model = built.overrides.sessionModel ? opencode.parseOpencodeModelId(built.overrides.sessionModel) : null
        if (model) {
          nativeEffect = 'uncertain'
          const written = await opencode.applyOpencodeSessionModel({
            opencodeMajor, dbPath: native ? nativeOpencodeStore(native.environment) : opencodeDb, sessionId: session.sessionId, model, cwd: session.cwd ?? undefined,
            // (A model of opencode's own is looked for in its catalogue; a grid's provider lives in
            // the pane's own config, which the service never reads.)
            checkCatalog: !grid,
          }, { current: dispatchCurrent, ...(native?.executable ? { executable: native.executable, environment: { ...built.overrides.env, ...native.environment } } : {}) })
          nativeEffect = written.ok ? 'applied' : (written.effect ?? 'none')
          if (!dispatchCurrent()) return preparationChanged()
          if (!written.ok) {
            console.warn(`[grid] retarget ${sid(session.agentId)} refused · ${written.code} · ${written.detail}`)
            return { ok: false, error: written.code, detail: written.detail }
          }
        }
      }
      // A backend with no `clearEnv()` (the pty host keeps the pane's create env as tmux keeps its session's) clears
      // the same names in the respawn itself: `clearPaneEnv` below.
      if (!grid && backend.clearEnv) {
        const cleared = await backend.clearEnv(pane, gridEnvVarNames(session.engine), dispatchCurrent)
        if (!dispatchCurrent()) return preparationChanged()
        if (cleared.state !== 'succeeded') {
          return failed('GRID_CLEAR_FAILED', 'reason' in cleared ? cleared.reason : 'tmux would not clear the pane environment')
        }
      }
      const bypassPermission = await bypassPermissionFor(session, () => liveBypassPermission(session))
      if (!current()) return changed()
      const retargetPermission = await downgradedPermission(session, bypassPermission, 'retarget', native)
      if (retargetPermission.nativeHold || native?.current() === false) return failed('NATIVE_LAUNCH_HELD', retargetPermission.nativeHold ?? 'Waiting for fresh executable and hook evidence.')
      if (!current()) return changed()
      const outcome = await restartAgent(
        { engine: session.engine, sessionId: session.sessionId, ...(session.resumeOnly ? { resumeOnly: true as const } : {}) },
        retargetPermission.bypassPermission === true,
        { ...paneSwapDeps(session, place, !grid && !backend.clearEnv ? { ...built.overrides, clearPaneEnv: gridEnvVarNames(session.engine) } : built.overrides,
          retargetPermission.permissionMode ?? null, dispatchCurrent), isCurrent: dispatchCurrent },
      )
      replacementStarted = outcome.ok
      if (!current()) return changed()
      if (!outcome.ok) {
        console.warn(`[grid] retarget ${sid(session.agentId)} failed · ${outcome.detail}`)
        return failed('RESPAWN_FAILED', outcome.detail)
      }
      // Commit the new process now. Optional grid metadata follows outside the route hold.
      const gateway = await probeGatewayRuntime(outcome.processIdentity)
      if (!current()) return changed()
      await backend.releaseHold(pane, current)
      if (!current()) return changed()
      registry.updateProcessIdentity(session.agentId, outcome.processIdentity, gateway.kind)
      // The launch that just worked is the one a restart or a post-reboot restore must repeat — and
      // what it decided about web search is what the app shows for this agent from now on. Null for
      // a move home: the block, and the status with it, leave the frame together.
      registry.setGridLaunch(session.agentId, built.overrides.gridLaunchRecord ?? null)
      // Persisted only on the way OUT, and only once the move actually succeeded — a refused move
      // must not overwrite the model the agent is still sitting on. Survives a daemon restart, so an
      // agent left on a grid for a week still knows where it came from.
      if (grid && remembered) registry.setSubscriptionModel(session.agentId, remembered)
      registry.setActive(session.agentId, true)
      const refreshed = registry.byAgent(session.agentId)
      // The app decides whether to still offer a move from what it is told here, so a silent success
      // would leave the banner up over an agent that had already been moved.
      if (refreshed) { announceSession(refreshed); refreshGridAssignment(refreshed) }
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
    } catch (error) {
      if (nativeEffect !== 'none' || replacementStarted) return failed('RETARGET_FAILED', error instanceof Error ? error.message : String(error))
      throw error
    } finally {
      release()
      releaseRoute?.()
    }
  }
  return retargetAgent
}
