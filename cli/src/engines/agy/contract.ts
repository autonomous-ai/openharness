/**
 * What the core knows of agy without loading its code: declared data, read in line on the hook path
 * (docs/design/2026-10-08-other-engines-out-of-core.md). It imports nothing of agy's code.
 */
import { join } from 'node:path'
import type { ProcessSessionLocation, TranscriptLocation } from '../kit/sessionLocation.js'

/** A conversation id: its folder's name. */
export const CONVERSATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const AGY_TRANSCRIPT: TranscriptLocation = {
  id: CONVERSATION_ID, kind: 'direct', root: 'brain', file: ['.system_generated', 'logs', 'transcript_full.jsonl'],
}
export const AGY_PROCESS_SESSION: ProcessSessionLocation = {
  id: CONVERSATION_ID, kind: 'open-lock', root: 'presence', suffix: '.lock', timeoutMs: 4_000,
}

/** `<AGY_HOME>/brain/<conversationId>/.system_generated/logs/transcript_full.jsonl`. */
export function agyTranscriptPath(agyHome: string, conversationId: string): string | null {
  if (!CONVERSATION_ID.test(conversationId)) return null
  return join(agyHome, 'brain', conversationId, '.system_generated', 'logs', 'transcript_full.jsonl')
}
