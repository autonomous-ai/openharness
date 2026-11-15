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


/**
 * Is the pane sitting idle?
 *
 * agy's transcript carries no end-of-turn marker at all - the `Stop` hook is the only one - so after a
 * daemon restart a folded history leaves the turn open forever, and the device tile spins with nothing
 * left to close it (measured: `turn_heartbeat` every second, indefinitely).
 *
 * The pane does know. Its bottom row reads `? for shortcuts` when the composer is free and
 * `esc to cancel` while a turn, a question or a permission prompt is live. Checked only at attach; the
 * live lifecycle stays on USER_INPUT -> Stop. Declared here, so the core reads it with no code of agy's: at attach, and in its
 * backstop for a final Stop that never came (core/turns/agyBackstop.ts).
 */
export function agyPaneIdle(capture: string): boolean {
  const tail = capture.replace(/\u001b\[[0-9;:]*[A-Za-z]/g, '').split('\n').filter((line) => line.trim()).slice(-4).join('\n')
  if (/esc to cancel/i.test(tail)) return false
  return /\?\s*for shortcuts/i.test(tail)
}
