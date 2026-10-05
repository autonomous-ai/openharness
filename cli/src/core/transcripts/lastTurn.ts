/**
 * The text of an agent's last turn, for its recap: asked of the session's engine
 * (`transcript.lastTurnText`, src/engines/<engine>/transcript.ts; docs/design/2026-10-05-engine-interface.md).
 * Each engine reads its own way: Claude Code backward from the end, Codex from its rollout's end, the
 * database engines from their stores, the rest from the newest part of their transcripts.
 *
 * An engine without that reader has no last turn. Before 2026-10-05 an engine the reader did not name got
 * Claude Code's raw-line reader instead; the only one that could reach it was `terminal`, and a terminal
 * row never carries a session id or a transcript (`registry.releaseBinding`), so nothing read changed.
 *
 * Moved verbatim out of `runForeground` (the core boundary, step 7: docs/design/2026-10-03-harnessd.md).
 */
import type { Engine } from '../../engines/engine.js'
import type { LastTurnText } from '../../lib/normalize.js'
import type { RegisteredSession } from '../../lib/registry.js'

export interface LastTurnDeps {
  bySession: (sessionId: string) => RegisteredSession | undefined
  /** The engine of a session, by name (src/engines/registry.ts). */
  engineFor: (name: string) => Engine | undefined
}

export function createLastTurnReader({ bySession, engineFor }: LastTurnDeps) {
  return async (sessionId: string): Promise<LastTurnText | null> => {
    const s = bySession(sessionId)
    if (!s) return null
    const read = engineFor(s.engine)?.transcript?.lastTurnText
    return read ? read(s) : null
  }
}
