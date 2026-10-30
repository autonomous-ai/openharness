/** Signalling an agent's process: one seam, so a platform without POSIX signals can plug in its own signaller. */

export type AgentSignal = 'SIGTERM' | 'SIGKILL'
type AgentSignaller = (pid: number, signal: AgentSignal) => void

let signaller: AgentSignaller | null = null
export function setAgentSignaller(next: AgentSignaller | null): void { signaller = next }

/** Unix default is `process.kill`: synchronous, and it throws ESRCH/EPERM like the real one. */
export function signalAgentProcess(pid: number, signal: AgentSignal): void {
  if (signaller) signaller(pid, signal)
  else process.kill(pid, signal)
}
