/** Stop retains the logical session before retiring its process and terminal. */
import { externalResumePending } from './externalResume.js'
import { captureResumeIdentity } from './captureResumeIdentity.js'
import { isTerminalEngine } from '../engines/types.js'
import { IdentityReadUnavailable } from '../engines/kit/identityScan.js'
import { controlTranscriptEvidence, engineKeepsTranscriptFile } from '../engines/transcriptBindings.js'
import type { registry as liveRegistry, RegisteredSession } from './registry.js'
import type { StoppedAgentStore } from './stoppedAgents.js'
import type { AgentRestartCoordinator } from './restartAgent.js'
import type { TerminalBackend } from './terminalBackend.js'
import type { TmuxRuntimeRef } from './terminalTypes.js'
import { terminalRouteKey } from './terminalRuntime.js'
import { checkPidRuntime, terminateDeletedAgent } from './deleteAgentFallback.js'

export interface StopAgentServiceDeps {
  settlePane?: (agentId: string) => Promise<void>
  cancelExternal?: (entry: RegisteredSession, current: () => boolean) => Promise<boolean>
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
  forgetSession(agentId: string, options: { force: true; captured?: RegisteredSession }): void
  markDeleted(agentId: string): void
  clearDeleted(agentId: string): void
  /**
   * Unload the conversation from its engine's own server (Codex's shared app-server) before its client is
   * signalled: core/engines/nativeControls.ts, the engine's worker speaking its protocol under a grant.
   */
  stopNative(session: RegisteredSession, current: () => boolean, confirmUnusedConversation?: (session: RegisteredSession) => Promise<boolean>): Promise<void>
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
const runtimeIdentity = (entry: RegisteredSession | undefined, withProcess = true) => entry ? JSON.stringify([
  entry.engine, entry.registeredAt, entry.cwd,
  entry.codexHome ?? null, entry.hermesHome ?? null,
  ...(withProcess ? [entry.processIdentity?.pid, entry.processIdentity?.executable, entry.processIdentity?.startMarker, entry.processIdentity?.startTicks] : []),
  entry.runtimes.map(terminalRouteKey).sort(),
]) : null
const bindingIdentity = (entry: RegisteredSession) => JSON.stringify([
  entry.sessionId, entry.transcriptPath, entry.boundAt, entry.evidenceRevision,
])

export function createStopAgentService(deps: StopAgentServiceDeps) {
  const { registry, stoppedAgents, restartJobs, stopJobs, tmuxBackend, agentReconciler,
    forgetSession, markDeleted, clearDeleted, stopNative } = deps
  return (target: string, options: StopAgentOptions = {}) => {
    const sessionId = registry.resolve(target)?.agentId ?? target
    const existing = stopJobs.get(sessionId)
    if (existing) return existing
    restartJobs.cancel(sessionId)
    const job = Promise.resolve().then(async () => {
      await deps.settlePane?.(sessionId)
      const live = registry.resolve(sessionId)
      if (!live) return
      if (externalResumePending(live.externalResume)) {
        try {
          if (!deps.cancelExternal || !await deps.cancelExternal(live, () => options.current?.() !== false)) throw new Error('Adoption cancellation is unavailable.')
        } catch (error) { throw new AgentStopError(error instanceof Error ? error.message : 'Adoption could not be cancelled.') }
        return
      }
      // A row still starting has no process yet, and the one it gains while this stop runs is the engine
      // it launched, not a replacement. Comparing it refused every Stop pressed on a starting agent with
      // "Harness changed… Try stopping again" (e2e/races.e2e.ts). The process is still checked exactly
      // before it is signalled; a row with no process at all is retired with its pane.
      const starting = !live.processIdentity
      const identity = runtimeIdentity(live, !starting)
      const conversation = live.sessionId
      let binding = conversation ? bindingIdentity(live) : undefined
      const sameTarget = () => {
        const current = registry.resolve(sessionId)
        return runtimeIdentity(current, !starting) === identity && (!conversation || current!.sessionId === conversation)
          && (binding === undefined || bindingIdentity(current!) === binding)
      }
      const captured = await captureResumeIdentity({ ...live })
      // Discovery or a hook may have updated this row while reading the native store.
      // A replacement process must never be stopped using an older snapshot.
      if (!sameTarget() || options.current?.() === false) {
        throw new AgentStopError('Harness changed while saving its conversation. Try stopping again.')
      }
      const current = registry.resolve(sessionId)!
      const s = current.sessionId && current.sessionId !== captured.sessionId ? { ...current } : { ...current, sessionId: captured.sessionId,
        transcriptPath: captured.transcriptPath, hermesHome: captured.hermesHome, boundAt: captured.boundAt, source: captured.source }
      binding = bindingIdentity(current)
      const transcript = s.sessionId && s.transcriptPath && engineKeepsTranscriptFile(s.engine)
        ? controlTranscriptEvidence(s.engine, s.sessionId, s.transcriptPath, s.codexHome ?? undefined, s.cwd) : undefined
      let nativeIdentityError: IdentityReadUnavailable | undefined
      const verifyTranscript = () => {
        try { transcript?.verify() } catch (error) {
          if (error instanceof IdentityReadUnavailable) nativeIdentityError = error
          throw error
        }
      }
      // Saving precedes every mutation. A storage failure leaves the live agent alone.
      stoppedAgents.save(s)
      await options.checkpoint?.(s, 'before')
      verifyTranscript()
      await options.beforeStop?.(s)
      verifyTranscript()
      if (!sameTarget() || options.current?.() === false) {
        throw new AgentStopError('Harness changed while saving its conversation. Try stopping again.')
      }
      const routes = s.runtimes.map(terminalRouteKey)
      for (const route of routes) agentReconciler.holdRoute(route)
      try {
        markDeleted(sessionId)
        if (s.sessionId) markDeleted(s.sessionId)
        await stopNative(s, () => {
          verifyTranscript()
          return sameTarget() && options.current?.() !== false
        }, options.confirmUnusedConversation).catch(error => { throw nativeIdentityError ?? error })
        if (nativeIdentityError) throw nativeIdentityError
        verifyTranscript()
        // Keep the terminal alive while the engine handles SIGTERM and flushes
        // its native store. Killing tmux in parallel can deliver SIGHUP first.
        const termination = await (isTerminalEngine(s.engine) ? Promise.resolve('gone' as const)
          : terminateDeletedAgent(s, {
            checkRuntime: checkPidRuntime,
            kill: (pid, signal) => {
              verifyTranscript()
              if (!sameTarget() || options.current?.() === false) throw new AgentStopError('The close request was cancelled or changed.')
              process.kill(pid, signal)
            },
            sleep: ms => new Promise(resolve => { const timer = setTimeout(resolve, ms); timer.unref?.() }),
            log: message => console.log(message),
          }, 0)).catch(() => 'failed' as const)
        // The process helper catches signal failures. Preserve native evidence holds
        // so a queued Close retries instead of becoming a permanently failed plan.
        if (nativeIdentityError) throw nativeIdentityError
        if (termination === 'failed' || termination === 'not-ours') {
          throw new AgentStopError('Could not confirm that the harness stopped. Its saved conversation is safe. Try stopping again.')
        }
        // Never close a replacement's pane, even when our old process exited.
        if (!sameTarget() || options.current?.() === false) {
          throw new AgentStopError('The harness changed while pausing. Check its current state before trying again.')
        }
        verifyTranscript()
        await options.checkpoint?.(s, 'after')
        verifyTranscript()
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
        verifyTranscript()
        stoppedAgents.finishResume(sessionId)
        if (s.processIdentity) agentReconciler.suppress(s)
        // This publishes agent_deleted. It must follow confirmed termination, or a
        // desktop can display Paused and allow Resume while the old process runs.
        forgetSession(sessionId, { force: true, captured: s })
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
