/** Test seeding/cleanup uses the same durable transitions as the daemon's callers. */
import type { registry, RegisteredSession } from '../lib/registry.js'

type Registry = Pick<typeof registry, 'byAgent' | 'bySession' | 'confirmEngineExit' | 'confirmSessionUnbound'>

export async function removeRegistryAgent(rows: Registry, agentId: string): Promise<boolean> {
  const result = await rows.confirmEngineExit(agentId, 'remove')
  return result.state === 'confirmed' && !rows.byAgent(agentId)
}

export async function removeRegistrySession(rows: Registry, sessionId: string): Promise<boolean> {
  const row = rows.bySession(sessionId)
  return row ? removeRegistryAgent(rows, row.agentId) : false
}

export async function unbindRegistrySession(rows: Registry, sessionId: string): Promise<boolean> {
  const row = rows.bySession(sessionId)
  if (!row) return false
  const result = await rows.confirmSessionUnbound(row.agentId, sessionId)
  return result.state === 'confirmed' && !!result.entry
}

export async function releaseRegistryEngine(rows: Registry, agentId: string, separateShell = false): Promise<RegisteredSession | null> {
  const result = await rows.confirmEngineExit(agentId, separateShell ? 'successor' : 'shell')
  return result.state === 'confirmed' ? result.entry : null
}
