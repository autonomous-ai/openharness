/** Public profile ids and effort vocabulary, independent of engine implementations. */
import type { AgentEngine } from '../engines/types.js'
import type { RuntimeProfile } from '../engines/facets/runtime.js'
import { RUNTIME_EFFORTS } from '../engines/kit/runtime.js'

const PROFILE_RE = /^runtime-v1:([^:]+):(claude|codex|cursor|commandcode|pi|devin|opencode|hermes|muse|amp|kilo|grok|agy|copilot):([^@]+)@([a-z0-9_-]+)$/i

function decode(value: string): string | null {
  try {
    const out = decodeURIComponent(value)
    return out ? out : null
  } catch {
    return null
  }
}

export function parseRuntimeProfile(value: unknown): RuntimeProfile | null {
  if (typeof value !== 'string') return null
  const match = PROFILE_RE.exec(value)
  if (!match) return null
  const sessionId = decode(match[1])
  const model = decode(match[3])
  const effort = match[4].toLowerCase()
  if (!sessionId || !model || !RUNTIME_EFFORTS.has(effort)) return null
  return {
    id: value,
    sessionId,
    engine: match[2].toLowerCase() as AgentEngine,
    model,
    effort,
  }
}
