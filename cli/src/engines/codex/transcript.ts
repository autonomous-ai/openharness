import { readLastCodexTurnText } from './lastTurn.js'
import { codexMessagesToEvents } from './normalizer.js'
import { codexSubagentResolverFor } from './subagent.js'
import type { EngineTranscript } from '../facets/transcript.js'
import { pagedHistory } from '../kit/history.js'

export const transcript: EngineTranscript = {
  async lastTurnText(session) { return session.transcriptPath ? readLastCodexTurnText(session.transcriptPath) : null },
  historyPage: (session, ask, pages) => pagedHistory(session, ask, (path, options) => pages.codex(path, options),
    lines => codexMessagesToEvents(lines, codexSubagentResolverFor(session.codexHome))),
}
