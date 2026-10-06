import type { BackendSocket } from '../backendSocket.js'
import type { ResumeAgent } from '../core/agents/launches.js'
import { bindAgentList, bindCloseRequests, bindLaunchRequests, bindStopRequest } from './socketCore.js'

export interface NativeResumeRequests {
  resume: ResumeAgent
  stop: (agentId: string) => Promise<void>
}

/**
 * Found by QA on a quiet machine: the native resume fixture still assigned the removed socket
 * callbacks after requests moved into the core, so its first inventory answered UNSUPPORTED.
 * Bind the real handlers, reading the current actions so the optional UI fixture can wrap them.
 */
export function bindNativeResumeRequests(socket: BackendSocket, requests: NativeResumeRequests): void {
  bindAgentList(socket)
  bindCloseRequests(socket)
  bindLaunchRequests(socket, { resume: (id, permissionMode) => requests.resume(id, permissionMode) })
  bindStopRequest(socket, id => requests.stop(id))
}
