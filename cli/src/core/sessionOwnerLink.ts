/** Current service-port operations; both native and service sessions use the same public request handlers. */
import { OWNER_DOWN, type SessionOwnerPort, type OwnerDelivery } from '../lib/sessionOwnerWire.js'

export type CallSessionOwner = (type: string, payload: Record<string, unknown>) => Promise<Record<string, unknown>>
function result(answer: Record<string, unknown>): OwnerDelivery {
  if (answer.ok === true) return typeof answer.detail === 'string' ? { ok: true, detail: answer.detail } : { ok: true }
  if (answer.ok === false && typeof answer.error === 'string') return { ok: false, error: answer.error,
    ...(typeof answer.detail === 'string' ? { detail: answer.detail } : {}) }
  return OWNER_DOWN
}
export function createSessionOwnerLink(call: CallSessionOwner): SessionOwnerPort {
  return {
    create: async request => await call('create', request) as Awaited<ReturnType<SessionOwnerPort['create']>>,
    deliver: async (agentId, text) => result(await call('deliver', { agentId, text })),
    answer: async (agentId, requestId, answers) => await call('answer', { agentId, questionId: requestId, answers }) as Awaited<ReturnType<SessionOwnerPort['answer']>>,
    rename: async (agentId, name, before) => await call('rename', { agentId, name, before }) as Awaited<ReturnType<SessionOwnerPort['rename']>>,
    stopHarness: async agentId => await call('stopHarness', { agentId }) as Awaited<ReturnType<SessionOwnerPort['stopHarness']>>,
  }
}
