/**
 * What the core knows of Copilot without loading its code: declared data, read in line on the hook path
 * (docs/design/2026-10-08-other-engines-out-of-core.md). It imports nothing of Copilot's code.
 */
import { join } from 'node:path'

/** A session id: its folder's name. */
export const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * `<COPILOT_HOME>/session-state/<sessionId>/events.jsonl`.
 *
 * Deterministic from the session id alone, and confirmed by Copilot itself: the `agentStop` hook
 * reports this exact path in `transcriptPath`.
 */
export function copilotTranscriptPath(copilotHome: string, sessionId: string): string | null {
  if (!SESSION_ID.test(sessionId)) return null
  return join(copilotHome, 'session-state', sessionId, 'events.jsonl')
}
