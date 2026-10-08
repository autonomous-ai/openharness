import type { LastTurnText, SessionEvent } from '../../lib/normalize.js'
import type { RegisteredSession } from '../../lib/registry.js'
import type { TranscriptPager } from '../../lib/transcriptPages.js'

export interface HistoryAsk { limit?: number; before?: string }
/** The reader receives no mutable agent, process, terminal or turn state. */
export type TranscriptSession = Pick<RegisteredSession, 'sessionId' | 'transcriptPath' | 'touchedAt' | 'codexHome'>
export interface HistoryAnswer {
  events: SessionEvent[]
  timestamp: string
  hasMore?: boolean
  oldestCursor?: string | null
  staleCursor?: true
}
export interface EngineTranscript {
  lastTurnText(session: TranscriptSession): Promise<LastTurnText | null>
  /** `pages` is the pager of the process the reader runs in; the reader hands it its own rules (`ThreadPages`). */
  historyPage(session: TranscriptSession, ask: HistoryAsk, pages: Pick<TranscriptPager, 'page'>): Promise<HistoryAnswer>
}
