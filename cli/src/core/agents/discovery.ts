/**
 * Discovery: what the reconciler's scans of the terminal backends and their processes mean for the
 * registry. A process no row owns opens an agent; a row's own process updates it (runtimes, identity,
 * permissions, profile homes, DSH) and wakes a dormant one; a row whose engine exited keeps its
 * conversation or goes dormant; a row whose pane is gone is removed, unless restore never ran.
 *
 * Moved verbatim out of the reconciler's options in `runForeground` (the core boundary, step 10:
 * docs/design/2026-10-03-harnessd.md). The reconciler itself, with what it scans, stays there.
 */
import { isTerminalEngine } from '../../engines/types.js'
import type { AutonomousDeviceInput } from '../deviceInput.js'
import type { QuestionWatcher } from '../../lib/askQuestion.js'
import { sameGridAssignment } from '../../lib/gridAssignment.js'
import { sid } from '../../lib/log.js'
import type { registry, RegisteredSession } from '../../lib/registry.js'
import type { SessionInputController } from '../../lib/sessionInput.js'
import type { StoppedAgentStore } from '../../lib/stoppedAgents.js'
import type { DiscoveredTerminalAgent } from '../../lib/terminalAgentDiscovery.js'
import { bypassPermissionActive, permissionModeFromArgv, tmuxPaneState } from '../../lib/tmux.js'
import type { SwarmPromptScopes } from '../../teams/promptScope.js'

export interface DiscoveryDeps {
  registry: Pick<typeof registry,
    'byRuntimeEngine' | 'openProcessAgent' | 'adoptEngine' | 'updateRuntimes' | 'updateProcessIdentity' | 'setBypassPermission'
    | 'setPermissionMode' | 'setCodexHome' | 'setHermesHome' | 'setDsh' | 'byAgent' | 'setLaunch' | 'setActive'
    | 'terminalAvailable' | 'setTerminalAvailable'>
  attachDsh: (session: RegisteredSession) => void
  forgetSession: (id: string, opts?: { force?: boolean; agentId?: string }) => void
  announceSession: (session: RegisteredSession) => void
  bindObservedAgent: (observed: DiscoveredTerminalAgent) => Promise<void>
  syncRecapPool: () => void
  attachSession: (session: RegisteredSession) => Promise<boolean>
  invalidateTerminalControl: (agentId: string) => void
  teams: Pick<SwarmPromptScopes, 'forget'>
  input: Pick<SessionInputController, 'forget'>
  deviceInput: Pick<AutonomousDeviceInput, 'forget'>
  questionWatcher: Pick<QuestionWatcher, 'stop'>
  stopHeartbeat: (sessionId: string) => void
  retainExitedSession: (agent: RegisteredSession, announce: boolean) => void
  stoppedAgents: Pick<StoppedAgentStore, 'finishResume'>
  /** Whether restore did not get to this agent this boot (it did not run, or could not look at its row):
   *  its missing pane is then one never rebuilt, not one closed. */
  restoreDegraded: (agentId: string) => boolean
}

export function createDiscoveryHandlers({
  registry, attachDsh, forgetSession, announceSession, bindObservedAgent, syncRecapPool, attachSession,
  invalidateTerminalControl, teams, input, deviceInput, questionWatcher, stopHeartbeat, retainExitedSession,
  stoppedAgents, restoreDegraded,
}: DiscoveryDeps) {
  const onDiscovered = async (observed: DiscoveredTerminalAgent): Promise<void> => {
    const launching = observed.runtimes
      .map((runtime) => registry.byRuntimeEngine(runtime, observed.engine))
      .find((entry) => entry?.launch?.state !== 'ready')
    const opened = registry.openProcessAgent({
      engine: observed.engine,
      runtimes: observed.runtimes,
      primaryRuntimeKey: observed.primaryRuntimeKey,
      cwd: observed.cwd,
      processIdentity: observed.processIdentity,
      gateway: observed.gateway,
      grid: observed.grid,
      codexHome: observed.codexHome,
      dsh: observed.dsh,
    })
    if (!opened) return
    if (opened.entry.dsh) attachDsh(opened.entry)
    if (opened.evicted) {
      console.log(`[discovery] ${observed.primaryRuntimeKey} replaced ${sid(opened.evicted.agentId)}`)
      // ⚠️ THE REGISTRY ALREADY DROPPED IT; NOBODY HAD TOLD THE CLIENTS. That
      // is the whole bug behind "two sessions, one of them frozen": resuming
      // an engine in a pane another agent owned takes the pane away, and an
      // agent with no pane can never be opened again — but the app kept the
      // row until someone hit Reload machines by hand, and opening it landed
      // on TERMINAL FROZEN. This is the same call the hook path already makes
      // for the same situation (see onRegistered below).
      forgetSession(opened.evicted.sessionId || opened.evicted.agentId, {
        force: true,
        agentId: opened.evicted.agentId,
      })
    }

    if (opened.isNew || launching) {
      console.log(`[discovery] ${sid(opened.entry.agentId)} opened · engine=${observed.engine} · terminal=${observed.primaryRuntimeKey}`)
      announceSession(opened.entry)
    }
    await bindObservedAgent(observed)
  }
  const onObserved = async (observed: DiscoveredTerminalAgent, current: RegisteredSession): Promise<void> => {
    const wasDormant = !current.active
    // Read BEFORE the update, because the update is what overwrites it. `undefined` means the probe
    // could not look, which never counts as a move — see `probeGridAssignment`'s three answers.
    const gridMoved = observed.grid !== undefined
      && !sameGridAssignment(current.grid ?? null, observed.grid)
    const wasLaunching = current.launch?.state !== undefined && current.launch.state !== 'ready'
    // Somebody typed an engine into a terminal. The row becomes that engine's agent — same id,
    // same pane — and from here on is handled exactly like one the app launched: bound by its
    // hooks, watched for turns, listed on the dial. `adopted` makes the announce below
    // unconditional, since the engine changing is the one fact the app must not miss.
    const adopted = isTerminalEngine(current.engine) && !isTerminalEngine(observed.engine)
      ? registry.adoptEngine(current.agentId, observed.engine, observed.processIdentity)
      : null
    if (adopted) console.log(`[discovery] ${sid(current.agentId)} terminal → ${observed.engine} · ${observed.primaryRuntimeKey}`)
    registry.updateRuntimes(current.agentId, observed.runtimes, observed.primaryRuntimeKey)
    registry.updateProcessIdentity(current.agentId, observed.processIdentity, observed.gateway, observed.grid)
    // The live argv is the truth about the bypass flag, and this is the one place every running
    // agent passes through — so a row written before the flag was persisted at all (or by a build
    // that did not yet) learns it here, before any pane recreation ever needs it.
    // `observed.engine`, not `current.engine`: for a terminal that just adopted one, the row's
    // engine was `terminal` a line ago, which has no bypass flag and would read every launch as "no".
    registry.setBypassPermission(current.agentId, bypassPermissionActive(observed.engine, observed.args))
    // And the exact MODE, fill-only: a row that recorded one at create is authoritative, and one
    // that never did (adopted from a terminal, written by an older build, created by a path that
    // passes no mode) learns it from the same argv — so its restart brings back
    // `--dangerously-skip-permissions`, not the auto mode `bypassPermission` alone would pick.
    if (!current.permissionMode) {
      const mode = permissionModeFromArgv(observed.engine, observed.args)
      if (mode) registry.setPermissionMode(current.agentId, mode)
    }
    // Same idea for a Codex profile: a row that never learned which CODEX_HOME its process runs
    // under learns it from the process, before the hook path validates a transcript against it.
    // Fill-only — a profile the row already knows is never re-derived.
    if (observed.codexHome && !current.codexHome) registry.setCodexHome(current.agentId, observed.codexHome)
    // …and a Hermes home the same way, when the process names one. A row that learns it here never
    // has to look its session up store by store (openharness#191).
    if (observed.hermesHome && !current.hermesHome) registry.setHermesHome(current.agentId, observed.hermesHome)
    // And the DSH: a row minted by discovery (or written before the field existed) learns it from
    // the process's own `HARNESS_DSH`, and gets its viewer and verdict watch from here on.
    if (observed.dsh && !current.dsh) registry.setDsh(current.agentId, observed.dsh)
    const withDsh = registry.byAgent(current.agentId)
    if (withDsh?.dsh) attachDsh(withDsh)
    // This live process, in this row's own pane, is what "started" means — for a resumed row as
    // much as any other. A resume used to be held back here until its `SessionStart` hook landed,
    // on the grounds that only the hook proves WHICH conversation reopened. Two things were wrong
    // with that. The hook does not always come: measured on machine-remote-1, both resume-only
    // codex rows carried `lastHookAt: 0` while every fresh launch beside them had hooked, and one
    // of them sat at "Starting" for 19 hours over a pane its owner could type in — re-attached and
    // re-announced every 5s for the whole time, because `wasLaunching` stays true for a row that
    // nothing will ever mark ready (openharness#189). And nothing was actually protected by the
    // wait: the wrong-conversation guard in `registry.register` keys on `lastHookAt`, not on this
    // launch state, so it stays armed until the first hook whatever is written here.
    if (wasLaunching) registry.setLaunch(current.agentId, { state: 'ready' })
    await bindObservedAgent(observed)
    if (wasDormant || wasLaunching || adopted) {
      const active = registry.byAgent(current.agentId)
      if (!active) return
      if (!active.sessionId) {
        syncRecapPool()
        announceSession(active)
        return
      }
      // Not awaited: the attach reads this agent's whole history, and this callback runs inside the
      // reconcile pass whose completion is what publishes `discoveryReady`. One agent's slow store
      // must not hold the pass — or, at boot, the app. The tracker runs a few of these at a time.
      void attachSession(active).then((attached) => {
        if (!attached) {
          registry.setActive(active.agentId, false)
          return
        }
        syncRecapPool()
        announceSession(active)
      }).catch((err) => {
        console.error(`[discovery] ${sid(active.agentId)} attach failed:`, err instanceof Error ? err.message : err)
      })
      return
    }
    // An agent that was already awake changed grid under us. Nobody was told: this branch wrote the
    // new assignment into the registry and stopped, so the app went on drawing the old one until
    // its own 60s reconciliation tick happened to notice — a minute of an agent's header naming a
    // grid it had left. The retarget path has always announced (it is the same fact, arriving by a
    // different door); this is the door an engine's own `exec` comes through, which is what an
    // install-then-launch does the moment the install finishes.
    if (!gridMoved) return
    const refreshed = registry.byAgent(current.agentId)
    if (refreshed) announceSession(refreshed)
  }
  const onDormant = async (agent: RegisteredSession, reason: string): Promise<void> => {
    if (!agent.active) return
    invalidateTerminalControl(agent.agentId)
    teams.forget(agent.agentId)
    input.forget(agent.agentId)
    deviceInput.forget(agent.agentId)
    if (agent.sessionId) {
      questionWatcher.stop(agent.sessionId)
      stopHeartbeat(agent.sessionId)
    }
    // Preserve the conversation's public identity and give the surviving shell its own row.
    // A starting install is not an exited engine; strict uncertain starts keep their reservation.
    if (agent.resumeOnly && agent.launch?.state === 'failed') {
      const pane = await tmuxPaneState(agent.tmuxPane)
      // An unconfirmed install/startup can still be about to launch the engine. Do not
      // turn its live shell into permission to start another one. A pane that is gone is the
      // reconciler's to remove, and one tmux could not read says nothing: both stay as they are.
      if (typeof pane === 'string' || (!pane.dead && pane.engineExit == null)) return
    }
    if (agent.launch?.state !== 'starting') {
      retainExitedSession(agent, true)
      if (agent.resumeOnly) stoppedAgents.finishResume(agent.agentId)
      console.log(`[discovery] ${sid(agent.agentId)} retained · ${reason}`)
      return
    }
    registry.setActive(agent.agentId, false)
    console.log(`[discovery] ${sid(agent.agentId)} dormant · ${reason}`)
    announceSession(agent)
  }
  const onRemoved = (agent: RegisteredSession, reason: string): void => {
    // A pane absent because RESTORE never ran is not a pane the person closed. Retiring it here
    // would archive a row whose tmux pane was simply never rebuilt, and the person would have to
    // Open each one by hand; keeping it dormant leaves the next daemon — the fixed one — something
    // to restore.
    if (restoreDegraded(agent.agentId)) {
      console.log(`[discovery] ${sid(agent.agentId)} kept · restore did not run this boot · ${reason}`)
      registry.setActive(agent.agentId, false)
      announceSession(agent)
      return
    }
    console.log(`[discovery] ${sid(agent.agentId)} removed · ${reason}`)
    forgetSession(agent.agentId, { force: true })
  }
  const onTerminalAvailability = (agent: RegisteredSession, available: boolean): void => {
    const changed = registry.terminalAvailable(agent.agentId) !== available
    registry.setTerminalAvailable(agent.agentId, available)
    if (available && changed) announceSession(agent)
  }
  return { onDiscovered, onObserved, onDormant, onRemoved, onTerminalAvailability }
}
