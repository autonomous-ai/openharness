import type { LastTurnText, LiveEvent, SessionEvent } from '../../lib/normalize.js'
import type { RegisteredSession } from '../../lib/registry.js'
import type { TranscriptPager } from '../../lib/transcriptPages.js'

export interface HistoryAsk { limit?: number; before?: string }
/** The reader receives no mutable agent, process, terminal or turn state. `store` is the database a conversation is
 *  kept in, for an engine that keeps one (engines/otherEngines.ts `STORE_ENGINES`): the core says which file is read. */
export type TranscriptSession = Pick<RegisteredSession, 'sessionId' | 'transcriptPath' | 'touchedAt' | 'codexHome'> & { store?: string | null }
/** What a replay of history holds: the replay's events, and an async sub-agent's end where agy's and Muse's say it. */
export type HistoryEvent = SessionEvent | Extract<LiveEvent, { type: 'subagent_finished' }>
export interface HistoryAnswer {
  events: HistoryEvent[]
  timestamp: string
  hasMore?: boolean
  oldestCursor?: string | null
  staleCursor?: true
  /** The transcript is past what an engine without pages reads at once: its oldest history is not in it. */
  truncated?: true
}
export interface EngineTranscript {
  lastTurnText(session: TranscriptSession): Promise<LastTurnText | null>
  /** `pages` is the pager of the process the reader runs in; the reader hands it its own rules (`ThreadPages`). */
  historyPage(session: TranscriptSession, ask: HistoryAsk, pages: Pick<TranscriptPager, 'page'>): Promise<HistoryAnswer>
}

/** The core's reader is already bound to its process-owned pager; no pager crosses this boundary. */
export interface TranscriptReader {
  lastTurnText: EngineTranscript['lastTurnText']
  historyPage(session: TranscriptSession, ask: HistoryAsk): Promise<HistoryAnswer>
}
