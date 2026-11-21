/** Cloud owns public result policy; its captured common session facts contain no core provider record. */
import type { SessionOwnerPort, OwnerDelivery, OwnerRefusal } from '../lib/sessionOwnerWire.js'
import { SESSION_OWNER_LIMITS } from '../lib/sessionOwnerWire.js'
import { readSessionFacts } from '../lib/sessionFactsAdmission.js'
import { sessionFrame, type SessionFacts } from '../lib/sessionPresentation.js'
import { isCloudAgent, type CloudAgentFrame } from '../lib/cloudAgents.js'

export type CloudCreateResult = { ok: true; agent: CloudAgentFrame } | { ok: false; error: string; detail?: string }
type Operations = {
  create(request: Record<string, unknown>): Promise<CloudCreateResult>
  deliver: SessionOwnerPort['deliver']
  answer(agentId: string, requestId: string, answers: Record<string, string>): Promise<OwnerDelivery>
  rename(agentId: string, name: string, before: SessionFacts): Promise<OwnerDelivery>
  stopHarness(agentId: string): Promise<OwnerDelivery>
}
const refusal = (result: { error: string; detail?: string }): OwnerRefusal => ({ error: result.error, ...(result.detail ? { detail: result.detail } : {}) })

export function prepareCloudPort(operations: Operations): SessionOwnerPort {
  return {
    create: async request => {
      const result = await operations.create(request)
      return result.ok ? { agent: result.agent } : refusal(result)
    },
    deliver: operations.deliver,
    answer: async (agentId, requestId, answers) => {
      const result = await operations.answer(agentId, requestId, answers)
      return result.ok ? { ok: true } : { ok: false, error: result.error === 'STALE_QUESTION' ? 'STALE_QUESTION' : 'ANSWER_FAILED', detail: result.detail ?? '' }
    },
    rename: async (agentId, name, before) => {
      let snapshot: SessionFacts
      try { snapshot = readSessionFacts(before, { ...SESSION_OWNER_LIMITS.catalogue, bytes: 512 * 1024 }, isCloudAgent).facts }
      catch { return { error: 'CLOUD_RESPONSE_INVALID' } }
      if (snapshot.id !== agentId) return { error: 'CLOUD_RESPONSE_INVALID' }
      const result = await operations.rename(agentId, name, snapshot)
      if (!result.ok) return refusal(result)
      const renamed = name.trim().slice(0, 120)
      return { agent: sessionFrame({ ...snapshot, name: renamed }),
        renamed: { type: 'agent_renamed', payload: { agentId, name: renamed, engine: snapshot.engine } } }
    },
    stopHarness: async agentId => {
      const result = await operations.stopHarness(agentId)
      return result.ok ? { deleted: true, ...(result.detail ? { detail: result.detail } : {}) } : refusal(result)
    },
  }
}
