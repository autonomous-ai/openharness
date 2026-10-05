import type { EngineTranscript } from '../facets/transcript.js'
import { readLastCodexTurnText } from './lastTurn.js'

/** Codex's rollout. */
export const transcript: EngineTranscript = {
  // Read from the rollout's end (./lastTurn.ts): megabytes of old tool output are never read for a recap.
  async lastTurnText(session) {
    return session.transcriptPath ? readLastCodexTurnText(session.transcriptPath) : null
  },
}
