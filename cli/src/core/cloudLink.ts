/**
 * Cloud agents in their own process, as the core reaches them (an experiment; the process's side is
 * services/cloudProcess.ts). The core asks them five things, each when a person does it and never in a
 * connection's line: a New Harness for a cloud agent, words for one, an answer to its question, a new name,
 * and Stop Harness (`stopHarness`: never `stop`, which a service host reads as stopping the service).
 * Each is a request to the process (core/serviceLinks.ts `call`, which starts it when it is off); an answer
 * that does not come is the port's fallback (core/api.ts `CLOUD_FALLBACKS`): refused, with a reason.
 */
import { CLOUD_DOWN as DOWN, type CloudPort, type CloudResult } from './api.js'

/** Ask the cloud process (core/serviceLinks.ts `call`, for `cloud`): never rejects. */
export type CallCloud = (type: string, payload: Record<string, unknown>) => Promise<Record<string, unknown>>

/** An answer as the port's result: done, or the refusal it carried, or the fallback for one that is neither. */
function result(answer: Record<string, unknown>): CloudResult {
  if (answer.ok === true) return typeof answer.detail === 'string' ? { ok: true, detail: answer.detail } : { ok: true }
  if (answer.ok === false && typeof answer.error === 'string') return { ok: false, error: answer.error, ...(typeof answer.detail === 'string' ? { detail: answer.detail } : {}) }
  return DOWN
}

export function createCloudLink(call: CallCloud): CloudPort {
  return {
    // Prepared replies are admitted by the owner boundary for both inline and IPC calls.
    create: async request => await call('create', request) as Awaited<ReturnType<CloudPort['create']>>,
    deliver: async (agentId, text) => result(await call('deliver', { agentId, text })),
    // `questionId`: a call's own `requestId` is the link's, written over whatever the payload carried.
    answer: async (agentId, requestId, answers) => await call('answer', { agentId, questionId: requestId, answers }) as Awaited<ReturnType<CloudPort['answer']>>,
    rename: async (agentId, name, before) => await call('rename', { agentId, name, before }) as Awaited<ReturnType<CloudPort['rename']>>,
    stopHarness: async agentId => await call('stopHarness', { agentId }) as Awaited<ReturnType<CloudPort['stopHarness']>>,
  }
}
