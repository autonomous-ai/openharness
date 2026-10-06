import type { EngineTranscript } from '../facets/transcript.js'
import { lastTurnFromTail } from '../kit/lastTurn.js'
import { lastCursorTurnText } from './normalizer.js'

/** Cursor's transcript. */
export const transcript: EngineTranscript = {
  lastTurnText: (session) => lastTurnFromTail(session, lastCursorTurnText),
}
