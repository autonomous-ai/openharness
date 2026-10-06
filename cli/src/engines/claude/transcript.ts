import { lastTurnTextFromRawLines, selectClaudeRecapLine } from '../../lib/normalize.js'
import { tailFileUntil } from '../../lib/transcriptTail.js'
import type { EngineTranscript } from '../facets/transcript.js'

/**
 * Claude Code's transcript. Claude Code had no folder before the engine interface: its behaviour was the
 * default branch in shared code, and moves here a facet at a time
 * (docs/design/2026-10-05-engine-interface.md, section 5).
 */
export const transcript: EngineTranscript = {
  // Its last turn, read backward from the end: not the whole conversation once per turn end.
  async lastTurnText(session) {
    if (!session.transcriptPath) return null
    return lastTurnTextFromRawLines(await tailFileUntil(session.transcriptPath, selectClaudeRecapLine))
  },
}
