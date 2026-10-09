import { claudePageLine, lastTurnTextFromRawLines, messagesToEvents, selectClaudeRecapLine } from './normalize.js'
import { tailFileUntil } from '../../lib/transcriptTail.js'
import type { ThreadPages } from '../../lib/transcriptPages.js'
import type { EngineTranscript } from '../facets/transcript.js'
import { pagedHistory } from '../kit/history.js'
import { enrichSubagentStats } from './subagentStats.js'

/** A cursor is the id a record carries; a page starts at a real prompt, so a turn is never split. */
export const pages: ThreadPages = { cursor: 'record', line: claudePageLine }

export const transcript: EngineTranscript = {
  async lastTurnText(session) {
    return session.transcriptPath ? lastTurnTextFromRawLines(await tailFileUntil(session.transcriptPath, selectClaudeRecapLine)) : null
  },
  historyPage: (session, ask, pager) => pagedHistory(session, ask, (path, options) => pager.page(path, pages, options), messagesToEvents, enrichSubagentStats),
}
