import type { EngineTranscript } from '../facets/transcript.js'
import { lastTurnFromTail } from '../kit/lastTurn.js'
import { lastAgyTurnText } from './normalizer.js'

/** agy's transcript. */
export const transcript: EngineTranscript = {
  lastTurnText: (session) => lastTurnFromTail(session, lastAgyTurnText),
}
