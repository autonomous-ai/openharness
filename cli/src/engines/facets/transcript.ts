import type { LastTurnText, SessionEvent } from '../../lib/normalize.js'
import type { RegisteredSession } from '../../lib/registry.js'
import type { TranscriptPager } from '../../lib/transcriptPages.js'

export interface HistoryAsk { limit?: number; before?: string }
export interface HistoryAnswer {
  events: SessionEvent[]
  timestamp: string
  hasMore?: boolean
  oldestCursor?: string | null
  staleCursor?: true
}
export interface EngineTranscript {
  lastTurnText(session: RegisteredSession): Promise<LastTurnText | null>
  historyPage(session: RegisteredSession, ask: HistoryAsk, pages: Pick<TranscriptPager, 'claude' | 'codex'>): Promise<HistoryAnswer>
}
