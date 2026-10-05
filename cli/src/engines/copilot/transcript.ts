import type { EngineTranscript } from '../facets/transcript.js'
import { lastTurnFromTail } from '../kit/lastTurn.js'
import { lastCopilotTurnText } from './normalizer.js'

/** Copilot's transcript (`events.jsonl`). */
export const transcript: EngineTranscript = {
  lastTurnText: (session) => lastTurnFromTail(session, lastCopilotTurnText),
}
