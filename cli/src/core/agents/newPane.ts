/**
 * The new-pane watcher: after create or fork opens a pane, watch it until its engine process shows up
 * (ready; an OpenClaw `--local` run once its TUI has drawn too), the pane dies (failed: not installed, or did not start), the engine starts and exits before
 * it was ever seen (the pane is kept as a terminal, with the engine's words on screen), or the budget
 * runs out (failed: start timeout; the terminal stays).
 *
 * Moved verbatim out of `runForeground` (the core boundary, step 11: docs/design/2026-10-03-harnessd.md).
 */
import { OPENCLAW_LOCAL, openclawFolderInUse, readOpenclawScreen } from '../../engines/openclaw/contract.js'
import type { AgentEngine } from '../../engines/types.js'
import { describeAgentCreateFailure, summarizePaneOutput } from '../../lib/agentCreateDiagnosis.js'
import type { engineInstallRecipe } from '../../lib/engineInstall.js'
import { commandAvailableInInteractiveShell } from '../../lib/engineLaunch.js'
import { errorKind, sid } from '../../lib/log.js'
import { matchesLaunchReceipt, RegistryOwnershipChanged, type LaunchPublication, type registry, type RegisteredSession, type RegistryAuthority } from '../../lib/registry.js'
import { IdentityReadUnavailable } from '../../engines/kit/identityScan.js'
import type { TerminalBackendCoordinator } from '../../lib/terminalBackendCoordinator.js'
import type { TerminalRuntimeRef } from '../../lib/terminalTypes.js'
import { resolvePaneEngineProcess } from '../../lib/paneEngineProcess.js'
import { sameProcessIdentity, terminalRouteKey, terminalRuntimeLabel } from '../../lib/terminalRuntime.js'

export interface PaneWatcherDeps {
  registry: Pick<typeof registry, 'byAgent' | 'confirmLaunch' | 'setLaunch' | 'setTerminalAvailable' | 'confirmEngineExit'>
  announceSession: (session: RegisteredSession) => void
  /** Ask the reconciler to bind what now runs in a pane (TerminalAgentReconciler.triggerHint). */
  triggerHint: (runtime: TerminalRuntimeRef, engine: AgentEngine) => Promise<void>
  captureTerminal: (target: string, historyLines?: number) => Promise<string | null>
  retainExitedSession: (session: RegisteredSession, announce: boolean, authority?: RegistryAuthority) => Promise<LaunchPublication>
  revision?: (agentId: string) => number
  cancelled?: (agentId: string) => boolean
  /** The backend that holds a new pane: its process, state and hold (`isHeld`) are asked of it. */
  terminals: Pick<TerminalBackendCoordinator, 'backendFor'>
  /** Keeps discovery off a pane until the returned release (TerminalAgentReconciler.holdRoute, with no timer). */
  holdRoute: (routeKey: string) => () => void
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => {
  const timer = setTimeout(resolve, ms)
  timer.unref?.()
})

export function createPaneWatcher({ registry, announceSession, triggerHint, captureTerminal, retainExitedSession, terminals, holdRoute, revision, cancelled }: PaneWatcherDeps) {
  /**
   * Watch a pane this daemon just opened until its engine process shows up (ready), dies (failed), or
   * ten minutes pass. Shared by create and fork: the two open panes the same way and wait the same way.
   */
  const watchNewPane = async (engine: AgentEngine, pending: RegisteredSession, spawned: { runtime: TerminalRuntimeRef }, command: string[], installIfMissing: ReturnType<typeof engineInstallRecipe> | undefined, budgetMs = 10 * 60_000): Promise<void> => {
    const startedAt = Date.now()
    pending = structuredClone(pending)
    let delayMs = 50
    const nativeToken = pending.launch?.state === 'starting' ? pending.launch.nativeToken : undefined
    const local = !!pending.openclawLocal
    // A delayed probe belongs to this launch, including its original route and
    // binding. Stop, a newer launch or discovery can supersede it while tmux waits.
    const generation = revision?.(pending.agentId)
    const lifecycle = () => !cancelled?.(pending.agentId) && revision?.(pending.agentId) === generation
    const current = () => {
      const row = registry.byAgent(pending.agentId)
      return lifecycle() && !!row && row.registeredAt === pending.registeredAt && row.engine === engine
        && row.cwd === pending.cwd && row.codexHome === pending.codexHome && row.claudeHome === pending.claudeHome
        && row.hermesHome === pending.hermesHome
        && row.runtimes.some(route => terminalRouteKey(route) === terminalRouteKey(spawned.runtime))
        && (!pending.sessionId || row.sessionId === pending.sessionId)
        && (!pending.processIdentity || (sameProcessIdentity(pending.processIdentity, row.processIdentity)
          && pending.processIdentity.executable === row.processIdentity?.executable))
        && (!row.launch || row.launch.state === 'starting' || row.launch.state === 'ready')
        && (row.launch?.state !== 'starting' || row.launch.nativeToken === nativeToken)
    }
    // A local OpenClaw's process shows seconds before its TUI draws. Discovery seeing it would mark the launch ready and
    // supersede this watcher, which then never releases the pane's hold, says it ready, binds it or says a folder in
    // use: the pane is this watcher's alone until it is done.
    const releaseRoute = local ? holdRoute(terminalRouteKey(spawned.runtime)) : () => {}
    try {
      // Create and fork open the pane through this backend, so it is there; reported below if not.
      const backend = terminals.backendFor(spawned.runtime)
      if (!backend) throw new Error(`no terminal backend for ${terminalRuntimeLabel(spawned.runtime)}`)
      while (Date.now() - startedAt < budgetMs) {
        if (!registry.byAgent(pending.agentId) || !current()) return
        const processIdentity = await resolvePaneEngineProcess(backend, spawned.runtime, engine)
        if (!current()) return
        // A local OpenClaw takes its folder's lock before it draws anything, so its process alone does not say it
        // will stay: one that leaves on the lock must still be starting when it leaves, to be said below.
        const drawn = processIdentity && local
          ? readOpenclawScreen(await captureTerminal(pending.agentId, 40) ?? '').footer !== null
          : true
        if (!current()) return
        if (processIdentity && drawn) {
          const selected = structuredClone(registry.byAgent(pending.agentId)!)
          const origin = (row: RegisteredSession) => JSON.stringify([row.registeredAt, row.engine, row.cwd, row.runtimes,
            row.primaryRuntimeKey, row.codexHome, row.claudeHome, row.hermesHome, row.dsh, row.dshRuntime,
            row.openclawLocal, row.openclawStateDir, row.launchArgs, row.gridLaunch, row.subscriptionModel])
          const expires = performance.now() + Math.min(5_000, Math.max(0, budgetMs - (Date.now() - startedAt)))
          const exact = () => {
            const selected = registry.byAgent(pending.agentId)?.processIdentity
            return current() && terminals.backendFor(spawned.runtime) === backend && (!selected
              || (sameProcessIdentity(processIdentity, selected) && selected.executable === processIdentity.executable))
          }
          const refresh = async () => {
            const observed = await resolvePaneEngineProcess(backend, spawned.runtime, engine)
            if (!sameProcessIdentity(processIdentity, observed) || observed?.executable !== processIdentity.executable
              || (local && readOpenclawScreen(await captureTerminal(pending.agentId, 40) ?? '').footer === null)) {
              throw new IdentityReadUnavailable('the new pane changed before readiness publication')
            }
          }
          if (!exact()) return
          let publication: LaunchPublication
          try { publication = await registry.confirmLaunch(pending.agentId, { processIdentity }, { current: exact, refresh, expires }) }
          catch (error) {
            // One first native hook may bind this same process while preparation waits. Its old image
            // was revoked before publication; uncertainty is never retried by reselecting an owner.
            const hooked = registry.byAgent(pending.agentId)
            if (!(error instanceof RegistryOwnershipChanged) || selected.sessionId || !hooked?.sessionId || origin(hooked) !== origin(selected) || !exact()) throw error
            await refresh()
            publication = await registry.confirmLaunch(pending.agentId, { processIdentity }, { current: exact, refresh, expires })
          }
          const ready = publication.state === 'confirmed' ? publication.entry : null
          const committed = () => lifecycle() && !!ready && terminals.backendFor(spawned.runtime) === backend
            && matchesLaunchReceipt(registry.byAgent(pending.agentId), ready)
          if (!committed()) return
          await backend.releaseHold(spawned.runtime, committed)
          if (!committed() || !ready) return
          announceSession(ready)
          // Before the hint: the pass it asks for is the one that must see this pane again.
          releaseRoute()
          void triggerHint(spawned.runtime, engine).catch((error) => {
            console.warn(`[agent] background bind failed · ${engine} · ${errorKind(error)}`)
          })
          console.log(`[agent] create ready · ${engine}${local ? ' · local' : ''} · agent ${pending.agentId} · ${Date.now() - startedAt}ms`)
          return
        }
        const paneState = await backend.paneState(spawned.runtime)
        if (!current()) return
        if (paneState === 'gone') {
          registry.setTerminalAvailable(pending.agentId, false)
          announceSession(pending)
          return
        }
        // A pane tmux could not read is asked again, as one still starting is: a call that timed out
        // says nothing about it, and giving up here left a working agent's launch unconfirmed.
        if (paneState === 'unknown') {
          await sleep(delayMs)
          delayMs = Math.min(delayMs * 2, 750)
          continue
        }
        // A pane holds a launch by token on a backend that can say so (`TerminalBackend.isHeld`): tmux and the
        // pty host. On the pty host the held shell has no tmux to respawn itself with; it stays inert there, and a
        // restore replaces it through `respawn` with the token.
        const waitingOwner = structuredClone(registry.byAgent(pending.agentId)!)
        const waiting = nativeToken && await backend.isHeld?.(spawned.runtime, nativeToken)
        if (!current() || !matchesLaunchReceipt(registry.byAgent(pending.agentId), waitingOwner)) return
        if (waiting === true) {
          const held = registry.setLaunch(pending.agentId, { state: 'held', service: 'native', nativeToken,
            detail: 'The engine did not start because its executable or native hooks changed. The original launch is held for recovery.' })
          if (held) announceSession(held)
          return
        }
        if (paneState.dead) {
          const installed = await commandAvailableInInteractiveShell(command[0], undefined, installIfMissing)
          if (!current()) return
          const error = installed ? 'ENGINE_DID_NOT_START' : 'ENGINE_NOT_INSTALLED'
          const detail = installed
            ? `${engine} exited before its engine process became ready. See the terminal output for details.`
            : `${engine} is not installed, or its automatic install failed. See the terminal output for details.`
          const failed = registry.setLaunch(pending.agentId, { state: 'failed', error, detail })
          if (failed) announceSession(failed)
          console.warn(`[agent] create failed · ${engine} · ${detail}`)
          return
        }
        // The engine started and was gone again before it was ever seen (a flag it refused, a
        // config it could not read): its wrapper has handed the pane to a shell with the engine's
        // own words on screen. That pane is a terminal, and the row says so — the person reads
        // the error where it was printed and types the command again, rather than being handed a
        // "Start failed" tile they cannot type into.
        if (paneState.engineExit !== null) {
          // Say what happened before the evidence goes. The pane is about to become an ordinary
          // terminal and `confirmEngineExit` rewrites the launch to `ready`, so after this point nothing
          // anywhere — frame, registry, archive — records that an engine was ever meant to be here
          // or why it left. openharness#285 was exactly this: opencode printed its help over a flag
          // it did not know, and the only trace was one line saying the pane had become a terminal.
          // `describeAgentCreateFailure` was written for this and had no caller.
          // `dead: true` describes the ENGINE, which is what the diagnosis is about, not the pane —
          // the pane is alive and about to become a terminal. That is the sentence this state
          // selects ("started and exited with status N"), and it is the true one here.
          const captured = await captureTerminal(pending.agentId, 40)
          if (!current()) return
          // A local run another OpenClaw's lock turned away: the person gives it another folder, so it is a
          // failed launch that says so, not a terminal.
          if (local && openclawFolderInUse(captured ?? '')) {
            const failed = registry.setLaunch(pending.agentId, { state: 'failed', error: 'OPENCLAW_FOLDER_IN_USE', detail: OPENCLAW_LOCAL.folderInUse })
            if (failed) announceSession(failed)
            console.warn(`[agent] create failed · ${engine} · ${OPENCLAW_LOCAL.folderInUse}`)
            return
          }
          console.warn(`[agent] create · ${engine} · agent ${sid(pending.agentId)} · `
            + describeAgentCreateFailure({
              state: { dead: true, exitStatus: paneState.engineExit, command: engine },
              output: summarizePaneOutput(captured ?? ''),
              engineBin: command[0],
              shellName: null,
              processes: [],
              elapsedMs: Date.now() - startedAt,
            }))
          // A hook may have bound a conversation while this watcher was awaiting its probe.
          // Archive the current row, not the pre-hook pending snapshot.
          const row = registry.byAgent(pending.agentId)
          const authority = { current, refresh: async () => {
            const latest = await backend.paneState(spawned.runtime)
            if (latest === 'gone' || latest === 'unknown' || latest.dead || latest.engineExit !== paneState.engineExit
              || await resolvePaneEngineProcess(backend, spawned.runtime, engine)) {
              throw new IdentityReadUnavailable('the exited pane changed before shell publication')
            }
          } }
          const publication = row?.sessionId ? await retainExitedSession(row, true, authority)
            : await registry.confirmEngineExit(pending.agentId, 'shell', authority)
          const shell = publication.state === 'confirmed' ? publication.entry : null
          const committed = () => lifecycle() && !!shell && terminals.backendFor(spawned.runtime) === backend
            && matchesLaunchReceipt(registry.byAgent(shell.agentId), shell)
          if (!committed()) return
          await backend.releaseHold(spawned.runtime, committed)
          if (!committed()) return
          if (!row?.sessionId && shell) announceSession(shell)
          console.warn(`[agent] create · ${engine} exited (${paneState.engineExit}) before ready · agent ${pending.agentId} kept as a terminal`)
          return
        }
        await sleep(delayMs)
        delayMs = Math.min(delayMs * 2, 750)
      }
      if (!current()) return
      const detail = `${engine} did not expose an engine process within ${Math.round(budgetMs / 60_000)} minutes. The terminal remains available.`
      const failed = registry.setLaunch(pending.agentId, nativeToken
        ? { state: 'held', service: 'native', nativeToken, detail: 'Waiting to confirm the native engine process. The original launch and terminal are preserved.' }
        : { state: 'failed', error: 'START_TIMEOUT', detail })
      if (failed) announceSession(failed)
      console.warn(`[agent] create timed out · ${engine} · agent ${pending.agentId}`)
    } catch (error) {
      console.warn(`[agent] create watch failed · ${engine} · readiness publication unavailable · ${errorKind(error)}`)
    } finally {
      releaseRoute()
    }
  }
  return watchNewPane
}
