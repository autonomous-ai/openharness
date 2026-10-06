import type { LastTurnText, LiveEvent } from '../../lib/normalize.js'
import type { RegisteredSession } from '../../lib/registry.js'

/**
 * Reading what an engine writes: its transcript file, or its database (docs/design/2026-10-05-engine-interface.md,
 * section 4.3). Step 1 of the migration fills the members below; attach, live ingest and history pages
 * join them in steps 2 to 4.
 *
 * Members are called detached from the object, so they must not use `this`.
 */
export interface EngineTranscript {
  /** The text of the session's last turn, for its recap. Null when there is nothing to read yet. */
  lastTurnText?(session: RegisteredSession): Promise<LastTurnText | null>
  /** An engine that keeps its conversations in a database: one conversation whole, read when called. */
  storedConversation?(session: RegisteredSession): Promise<readonly LiveEvent[]>
}
