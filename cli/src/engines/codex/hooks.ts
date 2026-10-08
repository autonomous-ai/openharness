import type { EngineHooks } from '../facets/hooks.js'
import { readCodexRolloutMeta } from './rollout.js'
import { installCodexHooks } from './installHooks.js'

export const hooks: EngineHooks = {
  install: installCodexHooks,
  installIn: installCodexHooks,
  admit: (body) => body.transcriptPath && readCodexRolloutMeta(body.transcriptPath)?.isSubagent
    ? { accepted: false, reason: 'codex_subagent' }
    : { accepted: true },
  // Codex closes turns through its transcript, never a Stop hook.
}
