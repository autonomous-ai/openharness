import { join } from 'node:path'
import { env } from '../../config/env.js'
import type { EngineTranscript } from '../facets/transcript.js'
import { lastOpencodeTurnText, opencodeMessagesToEvents } from './normalizer.js'
import { readOpencodeMessages } from './reader.js'

/** OpenCode keeps every conversation on this machine in one SQLite store, not in a transcript file. */
const store = (): string => join(env.OPENCODE_DATA_DIR, 'opencode.db')

export const transcript: EngineTranscript = {
  async lastTurnText(session) {
    return lastOpencodeTurnText(await readOpencodeMessages(store(), session.sessionId))
  },
  async storedConversation(session) {
    return opencodeMessagesToEvents(await readOpencodeMessages(store(), session.sessionId))
  },
}
