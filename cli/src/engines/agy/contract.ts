/**
 * What the core knows of agy without loading its code: declared data, read in line on the hook path
 * (docs/design/2026-10-08-other-engines-out-of-core.md). It imports nothing of agy's code.
 */
import { join } from 'node:path'

/** A conversation id: its folder's name. */
export const CONVERSATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** `<AGY_HOME>/brain/<conversationId>/.system_generated/logs/transcript_full.jsonl`. */
export function agyTranscriptPath(agyHome: string, conversationId: string): string | null {
  if (!CONVERSATION_ID.test(conversationId)) return null
  return join(agyHome, 'brain', conversationId, '.system_generated', 'logs', 'transcript_full.jsonl')
}
