/** Read the existing runtime-v1 model ID without loading the CLI's runtime manager or config. */
export interface RuntimeProfile {
  id: string
  sessionId: string
  engine: 'claude' | 'codex' | 'opencode'
  model: string
  effort: string
}
const EFFORTS = new Set(['auto', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'ultracode'])

export function encodeRuntimeProfile(profile: Omit<RuntimeProfile, 'id'>): string {
  return `runtime-v1:${encodeURIComponent(profile.sessionId)}:${profile.engine}:${encodeURIComponent(profile.model)}@${profile.effort}`
}

export function parseRuntimeProfile(value: unknown): RuntimeProfile | null {
  if (typeof value !== 'string') return null
  const match = /^runtime-v1:([^:]+):(claude|codex|opencode):([^@]+)@([a-z0-9_-]+)$/i.exec(value)
  if (!match) return null
  try {
    const sessionId = decodeURIComponent(match[1]), model = decodeURIComponent(match[3]), effort = match[4].toLowerCase()
    if (!sessionId || !model || !EFFORTS.has(effort)) return null
    return { id: value, sessionId, engine: match[2].toLowerCase() as RuntimeProfile['engine'], model, effort }
  } catch { return null }
}
