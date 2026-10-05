import { join } from 'node:path'
import { env } from '../../config/env.js'
import type { EngineTranscript } from '../facets/transcript.js'
import { devinMessagesToEvents, lastDevinTurnText } from './normalizer.js'
import { readDevinMessages } from './reader.js'

/** Devin keeps all of its history in one SQLite store. */
const store = (): string => join(env.DEVIN_HOME, 'sessions.db')

export const transcript: EngineTranscript = {
  async lastTurnText(session) {
    return lastDevinTurnText(await readDevinMessages(store(), session.sessionId))
  },
  async storedConversation(session) {
    return devinMessagesToEvents(await readDevinMessages(store(), session.sessionId))
  },
}
