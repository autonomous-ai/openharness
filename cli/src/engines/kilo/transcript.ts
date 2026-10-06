import { join } from 'node:path'
import { env } from '../../config/env.js'
import type { EngineTranscript } from '../facets/transcript.js'
import { kiloMessagesToEvents, lastKiloTurnText } from './normalizer.js'
import { readKiloMessages } from './reader.js'

/** Kilo, OpenCode's fork, keeps the same store shape in its own file and is read through its own reader,
 *  so the two can drift apart without one breaking the other. */
const store = (): string => join(env.KILO_DATA_DIR, 'kilo.db')

export const transcript: EngineTranscript = {
  async lastTurnText(session) {
    return lastKiloTurnText(await readKiloMessages(store(), session.sessionId))
  },
  async storedConversation(session) {
    return kiloMessagesToEvents(await readKiloMessages(store(), session.sessionId))
  },
}
