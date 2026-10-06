import type { EngineTranscript } from '../facets/transcript.js'
import { lastTurnFromTail } from '../kit/lastTurn.js'
import { lastMuseTurnText } from './normalizer.js'

/** Muse's transcript. */
export const transcript: EngineTranscript = {
  lastTurnText: (session) => lastTurnFromTail(session, lastMuseTurnText),
}
