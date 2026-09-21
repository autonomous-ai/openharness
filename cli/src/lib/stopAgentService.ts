/** Stop retains the logical session before retiring its process and terminal. */
import { isTerminalEngine } from '../engines/types.js'
import type { registry as liveRegistry, RegisteredSession } from './registry.js'
import type { StoppedAgentStore } from './stoppedAgents.js'
import type { AgentRestartCoordinator } from './restartAgent.js'
import type { TerminalBackend } from './terminalBackend.js'
import type { TmuxRuntimeRef } from './terminalTypes.js'
import { checkPidRuntime, terminateDeletedAgent } from './deleteAgentFallback.js'

export interface StopAgentServiceDeps {
  registry: Pick<typeof liveRegistry, 'resolve'>
  stoppedAgents: StoppedAgentStore
  restartJobs: AgentRestartCoordinator
  stopJobs: Map<string, Promise<void>>
  tmuxBackend: Pick<TerminalBackend<TmuxRuntimeRef>, 'kill'> | null
  agentReconciler: { suppress(session: RegisteredSession): void; trigger(): Promise<unknown> }
  forgetSession(agentId: string, options: { force: true }): void
  markDeleted(agentId: string): void
  clearDeleted(agentId: string): void
}
export function createStopAgentService(deps: StopAgentServiceDeps) {
  const { registry, stoppedAgents, restartJobs, stopJobs, tmuxBackend, agentReconciler,
    forgetSession, markDeleted, clearDeleted } = deps
  return (target: string) => {
    const sessionId = registry.resolve(target)?.agentId ?? target
    const existing = stopJobs.get(sessionId)
    if (existing) return existing
    restartJobs.cancel(sessionId)
    const job = Promise.resolve().then(async () => {
      const s = registry.resolve(sessionId)
      if (!s) return
      // Saving precedes every mutation. A storage failure leaves the live agent alone.
      stoppedAgents.save(s)
      markDeleted(sessionId)
      if (s.sessionId) markDeleted(s.sessionId)
      if (s.processIdentity) agentReconciler.suppress(s)
      forgetSession(sessionId, { force: true })
      const paneStop = tmuxBackend
        ? Promise.all(s.runtimes.filter((runtime): runtime is TmuxRuntimeRef => runtime.backend === 'tmux')
          .map(runtime => tmuxBackend!.kill(runtime)))
        : Promise.resolve([])
      const processStop = isTerminalEngine(s.engine) ? Promise.resolve('gone' as const)
        : terminateDeletedAgent(s, {
          checkRuntime: checkPidRuntime,
          kill: (pid, signal) => process.kill(pid, signal),
          sleep: ms => new Promise(resolve => { const timer = setTimeout(resolve, ms); timer.unref?.() }),
          log: message => console.log(message),
        }, 0)
      const [paneOutcomes, outcome] = await Promise.all([paneStop, processStop])
      if (outcome !== 'failed') {
        if (paneOutcomes.every(result => result.state === 'succeeded')) stoppedAgents.finishResume(sessionId)
        clearDeleted(sessionId)
        if (s.sessionId) clearDeleted(s.sessionId)
      }
      void agentReconciler.trigger()
    }).finally(() => {
      if (stopJobs.get(sessionId) === job) stopJobs.delete(sessionId)
    })
    stopJobs.set(sessionId, job)
    return job
  }
}
