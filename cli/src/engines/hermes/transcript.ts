import { hermesDbForSession } from '../../lib/hermesHome.js'
import type { EngineTranscript } from '../facets/transcript.js'
import { hermesMessagesToEvents, lastHermesTurnText } from './normalizer.js'
import { readHermesMessages } from './reader.js'

/**
 * Hermes keeps one SQLite store per home, and `hermes -p <name>` runs in a profile's own home, so each
 * session is read from the store its own home holds (lib/hermesHome.ts). Reading one fixed store is what
 * left profile agents' activity empty (openharness#191).
 */
export const transcript: EngineTranscript = {
  async lastTurnText(session) {
    return lastHermesTurnText(await readHermesMessages(await hermesDbForSession(session), session.sessionId))
  },
  async storedConversation(session) {
    return hermesMessagesToEvents(await readHermesMessages(await hermesDbForSession(session), session.sessionId))
  },
}
