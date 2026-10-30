/** A creation receipt projected without its launch request or credentials. */
export type CreationObservation = {
  creationId: string
  state: 'missing' | 'pending' | 'unconfirmed' | 'failed' | 'cancelled'
} | { creationId: string; state: 'created'; agentId: string }

export function creationObservation(creationId: string, value: unknown): CreationObservation | null {
  if (!/^[A-Za-z0-9_-]{16,96}$/.test(creationId) || !value || typeof value !== 'object') return null
  const row = value as Record<string, unknown>
  if (row.creationId !== creationId) return null
  if (row.state === 'created') {
    return typeof row.agentId === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(row.agentId)
      ? { creationId, state: 'created', agentId: row.agentId } : null
  }
  return ['missing', 'pending', 'unconfirmed', 'failed', 'cancelled'].includes(row.state as string)
    ? { creationId, state: row.state as Exclude<CreationObservation['state'], 'created'> } : null
}
