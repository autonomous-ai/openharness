import type { BackendSocket } from '../backendSocket.js'
import type { ResumeAgent } from '../core/agents/launches.js'

export interface NativeResumeRequests {
  resume: ResumeAgent
  stop: (agentId: string) => Promise<void>
}

/** Composition point for the standalone native resume fixture. */
export function bindNativeResumeRequests(_socket: BackendSocket, _requests: NativeResumeRequests): void {}
