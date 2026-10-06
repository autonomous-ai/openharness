/**
 * The conversation of an engine that keeps it in a database instead of a transcript file, whole, read
 * when called: asked of the session's engine (`transcript.storedConversation`, src/engines/<engine>/
 * transcript.ts; docs/design/2026-10-05-engine-interface.md). Undefined for an engine with a file.
 *
 * Moved verbatim out of `runForeground` (the core boundary, step 13: docs/design/2026-10-03-harnessd.md).
 */
import { engineFor } from '../../engines/registry.js'
import type { LiveEvent } from '../../lib/normalize.js'
import type { RegisteredSession } from '../../lib/registry.js'

export const databaseHistory = (s: RegisteredSession): (() => Promise<readonly LiveEvent[]>) | undefined => {
  const read = engineFor(s.engine)?.transcript?.storedConversation
  return read ? () => read(s) : undefined
}
