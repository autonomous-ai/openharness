/** Bind background learning to the collection's observed native runtime. */
import type { CompanionIntelligence } from '../pair/intelligence.js'
import { codexMemoryCapability } from './inference.js'
import { claudeMemoryCapability } from './claudeInference.js'
import { opencodeMemoryCapability } from './opencodeInference.js'
import type { MemoryInference } from './learner.js'
import { inferenceWaitReason } from './inferenceStatus.js'

export function companionMemoryInference(intelligence: Pick<CompanionIntelligence, 'extractionStatus' | 'extract'>,
  foregroundBusy: (companionAgentId: string) => boolean,
  codexCapability = codexMemoryCapability, claudeCapability = claudeMemoryCapability,
  opencodeCapability = opencodeMemoryCapability): MemoryInference {
  return {
    async target() {
      const status = await intelligence.extractionStatus()
      const reason = inferenceWaitReason(status.reason)
      if (status.state === 'off') return { state: 'off' }
      if (status.state === 'unsupported') return { state: 'unsupported', ...(reason ? { reason } : {}) }
      if (status.state !== 'ready' || !status.contextKey || !status.agentId) return { state: 'waiting', ...(reason ? { reason } : {}) }
      if (status.engine === 'codex' && !(await codexCapability()).supported) return { state: 'unsupported', reason: 'codex_version_uncertified' }
      if (status.engine === 'claude' && !(await claudeCapability()).supported) return { state: 'unsupported', reason: 'claude_version_uncertified' }
      if (status.engine === 'opencode' && !(await opencodeCapability()).supported) return { state: 'unsupported', reason: 'opencode_version_uncertified' }
      if (!['claude', 'codex', 'opencode'].includes(status.engine ?? '')) return { state: 'unsupported', reason: 'companion_configuration_unsupported' }
      return { state: 'ready', key: status.contextKey, foregroundBusy: foregroundBusy(status.agentId) }
    },
    run: (prompt, options) => intelligence.extract(prompt, options),
  }
}
