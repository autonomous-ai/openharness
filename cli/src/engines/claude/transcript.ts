import { lastTurnTextFromRawLines, messagesToEvents, selectClaudeRecapLine } from '../../lib/normalize.js'
import { tailFileUntil } from '../../lib/transcriptTail.js'
import type { EngineTranscript } from '../facets/transcript.js'
import { pagedHistory } from '../kit/history.js'

export const transcript: EngineTranscript = {
  async lastTurnText(session) {
    return session.transcriptPath ? lastTurnTextFromRawLines(await tailFileUntil(session.transcriptPath, selectClaudeRecapLine)) : null
  },
  historyPage: (session, ask, pages) => pagedHistory(session, ask, (path, options) => pages.claude(path, options), messagesToEvents),
}
