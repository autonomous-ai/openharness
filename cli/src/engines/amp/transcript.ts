import type { EngineTranscript } from '../facets/transcript.js'
import { lastTurnFromTail } from '../kit/lastTurn.js'
import { lastAmpTurnText } from './normalizer.js'

/** Amp's transcript: the file Harness's own Amp plugin writes, since Amp keeps no conversation on disk. */
export const transcript: EngineTranscript = {
  lastTurnText: (session) => lastTurnFromTail(session, lastAmpTurnText),
}
