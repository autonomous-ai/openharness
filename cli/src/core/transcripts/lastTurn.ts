/**
 * The text of an agent's last turn, for its recap. Every engine's is its reader's (`readerFor`): Claude Code's and
 * Codex's in their workers, read backward from the end, and the fourteen others' in theirs (engines/others/), from
 * the end of a transcript or from its engine's store, which the core names.
 *
 * Moved verbatim out of `runForeground` (the core boundary, step 7: docs/design/2026-10-03-harnessd.md); the other
 * engines' reading left for their worker (docs/design/2026-11-12-core-audit.md, section 3).
 */
import type { EngineTranscript } from '../../engines/facets/transcript.js'
import { keepsStore } from '../../engines/otherEngines.js'
import { EngineReadError } from '../../engines/worker/protocol.js'
import { transcriptReadIdentity } from './readIdentity.js'
import type { LastTurnText } from '../../engines/kit/events.js'
import type { RegisteredSession } from '../../lib/registry.js'

export interface LastTurnDeps {
  bySession: (sessionId: string) => RegisteredSession | undefined
  readerFor: (engine: string) => EngineTranscript | undefined
  /** The store a conversation kept in a database is in (core/transcripts/stores.ts); null for one that is in none. */
  storeOf: (session: RegisteredSession) => Promise<string | null>
}

export function createLastTurnReader({ bySession, readerFor, storeOf }: LastTurnDeps) {
  return async (sessionId: string): Promise<LastTurnText | null> => {
    const s = bySession(sessionId)
    if (!s) return null
    // No reader, no last turn: a shell keeps no transcript, and every other engine has one.
    const reader = readerFor(s.engine)
    if (!reader) return null
    const identity = transcriptReadIdentity(s)
    try {
      const answer = await reader.lastTurnText(keepsStore(s.engine) ? { ...s, store: await storeOf(s) } : s)
      return transcriptReadIdentity(bySession(sessionId)) === identity ? answer : null
    } catch (error) {
      console.warn(`[engine ${s.engine}] last turn unavailable · ${error instanceof EngineReadError ? error.code : 'ENGINE_UNAVAILABLE'}`)
      return null
    }
  }
}
