/** A pending adoption is not yet an owned conversation. Persist it before exposing its inert pane. */
import { externalSessionFact, externalSessionOwner, externalSessionRequest,
  type ExternalSessionFact, type ExternalSessionRequest } from './externalSessionWire.js'
import type { SessionOwner } from './sessionSearch/external.js'

export interface ExternalResumeIntent {
  token: string
  request: ExternalSessionRequest
  takeOver: 'idle' | 'now' | 'wait' | null
  phase: 'waiting' | 'quitting' | 'admitted' | 'cancelled'
  session?: ExternalSessionFact
  signal?: 'prepared' | 'sent'
  continue?: true
  dispatched?: true
  /** Only this exact process may inherit an already-dispatched takeover across a daemon restart. */
  owner?: { process: SessionOwner; generation: string }
}

export function parseExternalResume(value: unknown): ExternalResumeIntent | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  try { if (Buffer.byteLength(JSON.stringify(value)) > 64 * 1024) return null } catch { return null }
  const row = value as Record<string, unknown>
  const request = externalSessionRequest(row.request)
  if (!request || typeof row.token !== 'string' || !/^[a-f0-9-]{36}$/.test(row.token)
    || !['waiting', 'quitting', 'admitted', 'cancelled'].includes(String(row.phase))
    || !(row.signal === undefined || row.signal === 'prepared' || row.signal === 'sent')
    || !['continue', 'dispatched'].every(key => row[key] === undefined || row[key] === true)
    || !(row.takeOver === null || ['idle', 'now', 'wait'].includes(String(row.takeOver)))) return null
  const session = row.session === undefined ? undefined : externalSessionFact(row.session)
  if (session === null || session && (session.engine !== request.engine
    || session.sessionId !== request.sessionId && !session.aliases?.includes(request.sessionId))) return null
  let owner: ExternalResumeIntent['owner']
  if (row.owner !== undefined) {
    const raw = row.owner as Record<string, unknown> | null
    const process = externalSessionOwner(raw?.process)
    if (!process || process.engine !== request.engine || !process.tty || process.harness || process.unverified || process.fromArgs
      || typeof raw?.generation !== 'string' || !/^(linux|ps):\d+$/.test(raw.generation)) return null
    owner = { process, generation: raw.generation }
  }
  if (row.phase === 'admitted' && !session || row.phase === 'quitting' && (!session || !owner || row.takeOver === null)
    || row.signal && (!session || !owner || row.takeOver === null || row.phase === 'waiting')
    || row.continue && !row.signal || row.dispatched && row.phase !== 'admitted') return null
  return { token: row.token, request, takeOver: row.takeOver as ExternalResumeIntent['takeOver'],
    phase: row.phase as ExternalResumeIntent['phase'], ...(row.signal ? { signal: row.signal as 'prepared' | 'sent' } : {}), ...(row.continue ? { continue: true } : {}), ...(row.dispatched ? { dispatched: true } : {}), ...(session ? { session } : {}), ...(owner ? { owner } : {}) }
}

/** A cancelled intent no longer reserves a conversation, but can never silently become a fresh launch. */
export function externalResumeIds(intent: ExternalResumeIntent | undefined): readonly string[] {
  return !intent || intent.phase === 'cancelled' ? [] :
    [...new Set([intent.request.sessionId, ...(intent.session ? [intent.session.sessionId, ...intent.session.aliases ?? []] : [])])]
}

export function externalResumePending(intent: ExternalResumeIntent | undefined): boolean {
  return !!intent && intent.phase !== 'admitted'
}

/** Keep admitted aliases until this harness demonstrably moves to another conversation. */
export function externalReservations(row: { sessionId: string; externalResume?: ExternalResumeIntent }): readonly string[] {
  const intent = row.externalResume
  return [row.sessionId, ...(intent?.phase === 'admitted' && row.sessionId && row.sessionId !== intent.session!.sessionId
    ? [] : externalResumeIds(intent))].filter(Boolean)
}
