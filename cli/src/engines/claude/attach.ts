import { claudeToolLinks, startsClaudeTurn } from './normalize.js'
import type { AttachRules } from '../../lib/attachTranscript.js'
import type { RuntimeField } from '../../lib/runtimeProfile.js'

const bytes = (...markers: string[]): Buffer[] => markers.map((marker) => Buffer.from(marker))

/**
 * Claude Code: a turn opens on a real user prompt, always a `"type":"user"` record. Its results name
 * their tool from the call that made it, so calls the turn answers are reached for. The chips read
 * only the model from the transcript — the attach takes effort from Claude's settings straight after —
 * and `Set model to` is matched case-insensitively, so field records are asked for without a byte test.
 */
export function claudeAttachRules(fields: (line: string) => readonly RuntimeField[]): AttachRules {
  return {
    startsTurn: startsClaudeTurn,
    turnMarkers: bytes('"user"'),
    fields,
    required: ['model'],
    links: claudeToolLinks,
    linkMarkers: bytes('tool_use', 'tool_result'),
  }
}
