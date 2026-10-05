import type { EngineTranscript } from '../facets/transcript.js'
import { lastTurnFromTail } from '../kit/lastTurn.js'
import { lastPiTurnText } from './normalizer.js'

/** pi's transcript. */
export const transcript: EngineTranscript = {
  lastTurnText: (session) => lastTurnFromTail(session, lastPiTurnText),
}
