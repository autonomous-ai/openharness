/** Public response policy belongs to the component, alongside the operation that produced it. */
import type { CloudPort, CloudResult, CloudRefusal } from '../core/api.js'
import { cloudAgentFrame, cloudHarnessIn, type CloudAgentFrame, type CloudHarness } from '../lib/cloudAgents.js'
import { boundedJsonBytes } from '../lib/boundedJsonBytes.js'

export type CloudCreateResult = { ok: true; agent: CloudAgentFrame } | { ok: false; error: string; detail?: string }
type Operations = {
  create(request: Record<string, unknown>): Promise<CloudCreateResult>
  deliver: CloudPort['deliver']
  answer(agentId: string, requestId: string, answers: Record<string, string>): Promise<CloudResult>
  rename(agentId: string, name: string, before: CloudHarness): Promise<CloudResult>
  stopHarness(agentId: string): Promise<CloudResult>
}
const refusal = (result: { error: string; detail?: string }): CloudRefusal => ({ error: result.error, ...(result.detail ? { detail: result.detail } : {}) })

export function prepareCloudPort(operations: Operations): CloudPort {
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
      if (boundedJsonBytes(before, 512 * 1024) === null) return { error: 'CLOUD_RESPONSE_INVALID' }
      const snapshot = cloudHarnessIn(before)
      if (!snapshot || snapshot.agentId !== agentId) return { error: 'CLOUD_RESPONSE_INVALID' }
      const result = await operations.rename(agentId, name, snapshot)
      if (!result.ok) return refusal(result)
      const renamed = name.trim().slice(0, 120)
      return { agent: cloudAgentFrame({ ...snapshot, name: renamed }),
        renamed: { type: 'agent_renamed', payload: { agentId, name: renamed, engine: snapshot.agent } } }
    },
    stopHarness: async agentId => {
      const result = await operations.stopHarness(agentId)
      return result.ok ? { deleted: true, ...(result.detail ? { detail: result.detail } : {}) } : refusal(result)
    },
  }
}
