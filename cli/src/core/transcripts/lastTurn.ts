/**
 * The text of an agent's last turn, for its recap: from the database engines' stores, Codex's rollout,
 * Claude Code's transcript read backward from its end, and every other engine's transcript.
 *
 * The file engines other than Claude Code and Codex still read the whole transcript here, once per turn
 * end (docs/research/2026-10-04-whole-history-reads.md); bounding them is the next engine work.
 *
 * Moved verbatim out of `runForeground` (the core boundary, step 7: docs/design/2026-10-03-harnessd.md).
 */
import { lastAgyTurnText } from '../../engines/agy/normalizer.js'
import { lastAmpTurnText } from '../../engines/amp/normalizer.js'
import type { EngineTranscript } from '../../engines/facets/transcript.js'
import { EngineReadError } from '../../engines/worker/protocol.js'
import { transcriptReadIdentity } from './readIdentity.js'
import { lastCommandCodeTurnText } from '../../engines/commandcode/normalizer.js'
import { lastCopilotTurnText } from '../../engines/copilot/normalizer.js'
import { lastCursorTurnText } from '../../engines/cursor/normalizer.js'
import { lastDevinTurnText } from '../../engines/devin/normalizer.js'
import { readDevinMessages } from '../../engines/devin/reader.js'
import { lastGrokTurnText } from '../../engines/grok/normalizer.js'
import { lastHermesTurnText } from '../../engines/hermes/normalizer.js'
import { readHermesMessages } from '../../engines/hermes/reader.js'
import { lastKiloTurnText } from '../../engines/kilo/normalizer.js'
import { readKiloMessages } from '../../engines/kilo/reader.js'
import { lastMuseTurnText } from '../../engines/muse/normalizer.js'
import { lastOpencodeTurnText } from '../../engines/opencode/normalizer.js'
import { readOpencodeMessages } from '../../engines/opencode/reader.js'
import { lastPiTurnText } from '../../engines/pi/normalizer.js'
import { lastTurnTextFromRawLines, type LastTurnText } from '../../lib/normalize.js'
import type { RegisteredSession } from '../../lib/registry.js'
import { tailFileCapped } from '../../lib/transcriptTail.js'

export interface LastTurnDeps {
  bySession: (sessionId: string) => RegisteredSession | undefined
  readerFor: (engine: string) => EngineTranscript | undefined
  /** The database engines' stores. */
  dbs: { opencode: string; kilo: string; devin: string }
  /** Hermes keeps a store per profile: the one this session's lives in. */
  hermesDb: (s: RegisteredSession) => Promise<string>
}

export function createLastTurnReader({ bySession, dbs, hermesDb, readerFor }: LastTurnDeps) {
  return async (sessionId: string): Promise<LastTurnText | null> => {
    const s = bySession(sessionId)
    if (!s) return null
    const reader = readerFor(s.engine)
    if (reader) {
      const identity = transcriptReadIdentity(s)
      try {
        const answer = await reader.lastTurnText(s)
        return transcriptReadIdentity(bySession(sessionId)) === identity ? answer : null
      } catch (error) {
        console.warn(`[engine ${s.engine}] last turn unavailable · ${error instanceof EngineReadError ? error.code : 'ENGINE_UNAVAILABLE'}`)
        return null
      }
    }
    if (s.engine === 'opencode') return lastOpencodeTurnText(await readOpencodeMessages(dbs.opencode, sessionId))
    if (s.engine === 'kilo') return lastKiloTurnText(await readKiloMessages(dbs.kilo, sessionId))
    if (s.engine === 'hermes') return lastHermesTurnText(await readHermesMessages(await hermesDb(s), sessionId))
    if (s.engine === 'devin') return lastDevinTurnText(await readDevinMessages(dbs.devin, sessionId))
    if (!s.transcriptPath) return null
    // Bounded from the end like every whole read of an engine without pages (lib/transcriptTail.ts):
    // the last turn is at the end, and a transcript past the cap would otherwise be read whole at
    // every turn's end.
    const { lines } = await tailFileCapped(s.transcriptPath)
    if (s.engine === 'cursor') return lastCursorTurnText(lines)
    if (s.engine === 'muse') return lastMuseTurnText(lines)
    if (s.engine === 'amp') return lastAmpTurnText(lines)
    if (s.engine === 'grok') return lastGrokTurnText(lines)
    if (s.engine === 'agy') return lastAgyTurnText(lines)
    if (s.engine === 'copilot') return lastCopilotTurnText(lines)
    if (s.engine === 'pi') return lastPiTurnText(lines)
    if (s.engine === 'commandcode') return lastCommandCodeTurnText(lines)
    return lastTurnTextFromRawLines(lines)
  }
}
