/** Negotiated local session events. Legacy app traffic keeps its existing transport contract. */
export interface SessionEventBatch { id: number; index: number; count: number; replay?: true }
export interface SessionEventProof { sessionId: string; epoch: string; revision: number }
/** The producer's existing activity stamp, never a component's current registry guess. */
export function sessionEventProof(frame: { dbSessionId?: unknown; payload: Record<string, unknown> }): SessionEventProof | null {
  const activity = frame.payload.activity
  if (typeof frame.dbSessionId !== 'string' || !frame.dbSessionId || frame.dbSessionId.length > 200
    || !activity || typeof activity !== 'object' || Array.isArray(activity)) return null
  const value = activity as Record<string, unknown>
  return typeof value.epoch === 'string' && !!value.epoch && value.epoch.length <= 128
    && Number.isSafeInteger(value.revision) && Number(value.revision) >= 0
    ? { sessionId: frame.dbSessionId, epoch: value.epoch, revision: value.revision as number } : null
}
export const SESSION_EVENT_BYTES = 16 * 1024 * 1024 + 4096
export const SESSION_EVENT_SEND_BYTES = 32 * 1024 * 1024
export const SESSION_EVENT_CONNECTION_FRAMES = 256
export const SESSION_EVENT_FRAMES = 4096
export const SESSION_EVENT_DRAIN_MS = 20_000
