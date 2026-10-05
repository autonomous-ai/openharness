/**
 * The new-pane watcher: after create or fork opens a pane, watch it until its engine process shows up
 * (ready), the pane dies (failed: not installed, or did not start), the engine starts and exits before
 * it was ever seen (the pane is kept as a terminal, with the engine's words on screen), or the budget
 * runs out (failed: start timeout; the terminal stays).
 *
 * Moved verbatim out of `runForeground` (the core boundary, step 11: docs/design/2026-10-03-harnessd.md).
 */
import type { AgentEngine } from '../../engines/types.js'
import { describeAgentCreateFailure, summarizePaneOutput } from '../../lib/agentCreateDiagnosis.js'
import type { engineInstallRecipe } from '../../lib/engineInstall.js'
import { commandAvailableInInteractiveShell } from '../../lib/engineLaunch.js'
import { sid } from '../../lib/log.js'
import type { registry, RegisteredSession } from '../../lib/registry.js'
import type { TerminalRuntimeRef, TmuxRuntimeRef } from '../../lib/terminalTypes.js'
import { clearPaneRemainOnExit, resolvePaneEngineProcess, tmuxPaneState } from '../../lib/tmux.js'

export interface PaneWatcherDeps {
  registry: Pick<typeof registry, 'byAgent' | 'updateProcessIdentity' | 'setLaunch' | 'setTerminalAvailable' | 'releaseEngine'>
  announceSession: (session: RegisteredSession) => void
  /** Ask the reconciler to bind what now runs in a pane (TerminalAgentReconciler.triggerHint). */
  triggerHint: (runtime: TerminalRuntimeRef, engine: AgentEngine) => Promise<void>
  captureTerminal: (target: string, historyLines?: number) => Promise<string | null>
  retainExitedSession: (session: RegisteredSession, announce: boolean) => void
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => {
  const timer = setTimeout(resolve, ms)
  timer.unref?.()
})

export function createPaneWatcher({ registry, announceSession, triggerHint, captureTerminal, retainExitedSession }: PaneWatcherDeps) {
  /**
   * Watch a pane this daemon just opened until its engine process shows up (ready), dies (failed), or
   * ten minutes pass. Shared by create and fork: the two open panes the same way and wait the same way.
   */
  const watchNewPane = async (engine: AgentEngine, pending: RegisteredSession, spawned: { runtime: TmuxRuntimeRef }, command: string[], installIfMissing: ReturnType<typeof engineInstallRecipe> | undefined, budgetMs = 10 * 60_000): Promise<void> => {
    const startedAt = Date.now()
    let delayMs = 50
    try {
      while (Date.now() - startedAt < budgetMs) {
        if (!registry.byAgent(pending.agentId)) return
        const processIdentity = await resolvePaneEngineProcess(spawned.runtime.paneId, engine)
        if (processIdentity) {
          registry.updateProcessIdentity(pending.agentId, processIdentity)
          const ready = registry.setLaunch(pending.agentId, { state: 'ready' })
          await clearPaneRemainOnExit(spawned.runtime.paneId)
          if (ready) announceSession(ready)
          void triggerHint(spawned.runtime, engine).catch((error) => {
            console.warn(`[agent] background bind failed · ${engine} · ${error instanceof Error ? error.message : error}`)
          })
          console.log(`[agent] create ready · ${engine} · agent ${pending.agentId} · ${Date.now() - startedAt}ms`)
          return
        }
        const paneState = await tmuxPaneState(spawned.runtime.paneId)
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
        if (paneState.dead) {
          const installed = await commandAvailableInInteractiveShell(command[0], undefined, installIfMissing)
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
          // terminal and `releaseEngine` rewrites the launch to `ready`, so after this point nothing
          // anywhere — frame, registry, archive — records that an engine was ever meant to be here
          // or why it left. openharness#285 was exactly this: opencode printed its help over a flag
          // it did not know, and the only trace was one line saying the pane had become a terminal.
          // `describeAgentCreateFailure` was written for this and had no caller.
          // `dead: true` describes the ENGINE, which is what the diagnosis is about, not the pane —
          // the pane is alive and about to become a terminal. That is the sentence this state
          // selects ("started and exited with status N"), and it is the true one here.
          const captured = await captureTerminal(pending.agentId, 40)
          console.warn(`[agent] create · ${engine} · agent ${sid(pending.agentId)} · `
            + describeAgentCreateFailure({
              state: { dead: true, exitStatus: paneState.engineExit, command: engine },
              output: summarizePaneOutput(captured ?? ''),
              engineBin: command[0],
              shellName: null,
              processes: [],
              elapsedMs: Date.now() - startedAt,
            }))
          await clearPaneRemainOnExit(spawned.runtime.paneId)
          // A hook may have bound a conversation while this watcher was awaiting its probe.
          // Archive the current row, not the pre-hook pending snapshot.
          const row = registry.byAgent(pending.agentId)
          if (row?.sessionId) retainExitedSession(row, true)
          else {
            const released = registry.releaseEngine(pending.agentId)
            if (released) announceSession(released)
          }
          console.warn(`[agent] create · ${engine} exited (${paneState.engineExit}) before ready · agent ${pending.agentId} kept as a terminal`)
          return
        }
        await sleep(delayMs)
        delayMs = Math.min(delayMs * 2, 750)
      }
      const detail = `${engine} did not expose an engine process within ${Math.round(budgetMs / 60_000)} minutes. The terminal remains available.`
      const failed = registry.setLaunch(pending.agentId, { state: 'failed', error: 'START_TIMEOUT', detail })
      if (failed) announceSession(failed)
      console.warn(`[agent] create timed out · ${engine} · agent ${pending.agentId}`)
    } catch (error) {
      console.warn(`[agent] create watch failed · ${engine} · ${error instanceof Error ? error.message : error}`)
    }
  }
  return watchNewPane
}
