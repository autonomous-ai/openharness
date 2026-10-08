import { readLastCodexTurnText } from './lastTurn.js'
import { codexMessagesToEvents, codexPageStart } from './normalizer.js'
import { codexSubagentResolverFor } from './subagent.js'
import type { ThreadPages } from '../../lib/transcriptPages.js'
import type { EngineTranscript } from '../facets/transcript.js'
import { pagedHistory } from '../kit/history.js'

/** A cursor is `codex:<lines before it>`; a page starts at a user's message or a goal's injected context. */
export const pages: ThreadPages = { cursor: 'line', prefix: 'codex', startsPage: codexPageStart }

export const transcript: EngineTranscript = {
  async lastTurnText(session) { return session.transcriptPath ? readLastCodexTurnText(session.transcriptPath) : null },
  historyPage: (session, ask, pager) => pagedHistory(session, ask, (path, options) => pager.page(path, pages, options),
    lines => codexMessagesToEvents(lines, codexSubagentResolverFor(session.codexHome))),
}
