import type { EngineTranscript } from '../facets/transcript.js'
import { lastTurnFromTail } from '../kit/lastTurn.js'
import { lastGrokTurnText } from './normalizer.js'

/** Grok Build's transcript (`updates.jsonl`). */
export const transcript: EngineTranscript = {
  lastTurnText: (session) => lastTurnFromTail(session, lastGrokTurnText),
}
