/** Stop retains the logical session before retiring its process and terminal. */
import { stopSharedCodexSession } from './codexSessionLifecycle.js'
import { captureResumeIdentity } from './captureResumeIdentity.js'
import { isTerminalEngine } from '../engines/types.js'
import type { registry as liveRegistry, RegisteredSession } from './registry.js'
import type { StoppedAgentStore } from './stoppedAgents.js'
import type { AgentRestartCoordinator } from './restartAgent.js'
import type { TerminalBackend } from './terminalBackend.js'
import type { TmuxRuntimeRef } from './terminalTypes.js'
import { terminalRouteKey } from './terminalRuntime.js'
import { checkPidRuntime, terminateDeletedAgent } from './deleteAgentFallback.js'

export interface StopAgentServiceDeps {
  registry: Pick<typeof liveRegistry, 'resolve'>
  stoppedAgents: StoppedAgentStore
  restartJobs: AgentRestartCoordinator
  stopJobs: Map<string, Promise<void>>
  tmuxBackend: Pick<TerminalBackend<TmuxRuntimeRef>, 'kill'> | null
  agentReconciler: {
    suppress(session: RegisteredSession): void
    holdRoute(route: string): void
    releaseRoute(route: string): void
    trigger(): Promise<unknown>
  }
  forgetSession(agentId: string, options: { force: true }): void
  markDeleted(agentId: string): void
  clearDeleted(agentId: string): void
}
export class AgentStopError extends Error {
  readonly code = 'STOP_UNCONFIRMED'
}

export interface StopAgentOptions {
  /** Synchronous cancellation/identity fence at the actual signal boundary. */
  current?(): boolean
  /** A Close must earn its permission again after saving, immediately before signalling. */
  beforeStop?(session: RegisteredSession): Promise<void>
  /** Retain native history before exit, then include anything the engine flushed while exiting. */
  checkpoint?(session: RegisteredSession, phase: 'before' | 'after'): Promise<void>
  /** Fresh proof that an unbound chat has never started and its composer is empty. */
  confirmUnusedConversation?(session: RegisteredSession): Promise<boolean>
}

// Hooks rebuild registry objects. Compare stable values, never JavaScript object
// identity or property ordering, while retaining the exact PID-reuse guard.
const runtimeIdentity = (entry: RegisteredSession | undefined) => entry ? JSON.stringify([
  entry.engine, entry.registeredAt, entry.processIdentity?.pid,
  entry.processIdentity?.executable, entry.processIdentity?.startMarker,
  entry.runtimes.map(terminalRouteKey).sort(),
]) : null

export function createStopAgentService(deps: StopAgentServiceDeps) {
  const { registry, stoppedAgents, restartJobs, stopJobs, tmuxBackend, agentReconciler,
    forgetSession, markDeleted, clearDeleted } = deps
  return (target: string, options: StopAgentOptions = {}) => {
    const sessionId = registry.resolve(target)?.agentId ?? target
    const existing = stopJobs.get(sessionId)
    if (existing) return existing
    restartJobs.cancel(sessionId)
    const job = Promise.resolve().then(async () => {
      const live = registry.resolve(sessionId)
      if (!live) return
      const identity = runtimeIdentity(live)
      const conversation = live.sessionId
      const sameTarget = () => {
        const current = registry.resolve(sessionId)
        return runtimeIdentity(current) === identity && (!conversation || current!.sessionId === conversation)
      }
      const captured = await captureResumeIdentity({ ...live })
      // Discovery or a hook may have updated this row while reading the native store.
      // A replacement process must never be stopped using an older snapshot.
      if (!sameTarget() || options.current?.() === false) {
        throw new AgentStopError('Harness changed while saving its conversation. Try stopping again.')
      }
      const current = registry.resolve(sessionId)!
      const s = current.sessionId && current.sessionId !== captured.sessionId ? { ...current } : { ...current, sessionId: captured.sessionId,
        transcriptPath: captured.transcriptPath, boundAt: captured.boundAt, source: captured.source }
      // Saving precedes every mutation. A storage failure leaves the live agent alone.
      stoppedAgents.save(s)
      await options.checkpoint?.(s, 'before')
      await options.beforeStop?.(s)
      if (!sameTarget() || options.current?.() === false) {
        throw new AgentStopError('Harness changed while saving its conversation. Try stopping again.')
      }
      const routes = s.runtimes.map(terminalRouteKey)
      for (const route of routes) agentReconciler.holdRoute(route)
      try {
        markDeleted(sessionId)
        if (s.sessionId) markDeleted(s.sessionId)
        await stopSharedCodexSession(s, () => sameTarget() && options.current?.() !== false,
          undefined, options.confirmUnusedConversation)
        // Keep the terminal alive while the engine handles SIGTERM and flushes
        // its native store. Killing tmux in parallel can deliver SIGHUP first.
        const termination = await (isTerminalEngine(s.engine) ? Promise.resolve('gone' as const)
          : terminateDeletedAgent(s, {
            checkRuntime: checkPidRuntime,
            kill: (pid, signal) => {
              if (!sameTarget() || options.current?.() === false) throw new AgentStopError('The close request was cancelled or changed.')
              process.kill(pid, signal)
            },
            sleep: ms => new Promise(resolve => { const timer = setTimeout(resolve, ms); timer.unref?.() }),
            log: message => console.log(message),
          }, 0)).catch(() => 'failed' as const)
        if (termination === 'failed' || termination === 'not-ours') {
          throw new AgentStopError('Could not confirm that the harness stopped. Its saved conversation is safe. Try stopping again.')
        }
        // Never close a replacement's pane, even when our old process exited.
        if (!sameTarget() || options.current?.() === false) {
          throw new AgentStopError('The harness changed while pausing. Check its current state before trying again.')
        }
        await options.checkpoint?.(s, 'after')
        if (!sameTarget() || options.current?.() === false) {
          throw new AgentStopError('The harness changed while pausing. Check its current state before trying again.')
        }
        const panes = await Promise.allSettled(tmuxBackend
          ? s.runtimes.filter((runtime): runtime is TmuxRuntimeRef => runtime.backend === 'tmux')
            .map(runtime => tmuxBackend.kill(runtime)) : [])
        if (panes.some(result => result.status !== 'fulfilled' || result.value.state !== 'succeeded')
          || (isTerminalEngine(s.engine) && !panes.length)) {
          throw new AgentStopError('Could not confirm that the harness stopped. Its saved conversation is safe. Try stopping again.')
        }
        if (!sameTarget()) {
          throw new AgentStopError('The harness changed while pausing. Check its current state before trying again.')
        }
        stoppedAgents.finishResume(sessionId)
        if (s.processIdentity) agentReconciler.suppress(s)
        // This publishes agent_deleted. It must follow confirmed termination, or a
        // desktop can display Paused and allow Resume while the old process runs.
        forgetSession(sessionId, { force: true })
      } finally {
        clearDeleted(sessionId)
        if (s.sessionId) clearDeleted(s.sessionId)
        for (const route of routes) agentReconciler.releaseRoute(route)
        void agentReconciler.trigger()
      }
    }).finally(() => {
      if (stopJobs.get(sessionId) === job) stopJobs.delete(sessionId)
    })
    stopJobs.set(sessionId, job)
    return job
  }
}
