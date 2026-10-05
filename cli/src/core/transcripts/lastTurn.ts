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
import { readLastCodexTurnText } from '../../engines/codex/lastTurn.js'
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
import { lastTurnTextFromRawLines, selectClaudeRecapLine, type LastTurnText } from '../../lib/normalize.js'
import type { RegisteredSession } from '../../lib/registry.js'
import { tailFile, tailFileUntil } from '../../lib/transcriptTail.js'

export interface LastTurnDeps {
  bySession: (sessionId: string) => RegisteredSession | undefined
  /** The database engines' stores. */
  dbs: { opencode: string; kilo: string; devin: string }
  /** Hermes keeps a store per profile: the one this session's lives in. */
  hermesDb: (s: RegisteredSession) => Promise<string>
}

export function createLastTurnReader({ bySession, dbs, hermesDb }: LastTurnDeps) {
  return async (sessionId: string): Promise<LastTurnText | null> => {
    const s = bySession(sessionId)
    if (!s) return null
    if (s.engine === 'opencode') return lastOpencodeTurnText(await readOpencodeMessages(dbs.opencode, sessionId))
    if (s.engine === 'kilo') return lastKiloTurnText(await readKiloMessages(dbs.kilo, sessionId))
    if (s.engine === 'hermes') return lastHermesTurnText(await readHermesMessages(await hermesDb(s), sessionId))
    if (s.engine === 'devin') return lastDevinTurnText(await readDevinMessages(dbs.devin, sessionId))
    if (!s.transcriptPath) return null
    if (s.engine === 'codex') return readLastCodexTurnText(s.transcriptPath)
    // Its last turn, read backward — not the whole conversation once per turn end.
    if (s.engine === 'claude') return lastTurnTextFromRawLines(await tailFileUntil(s.transcriptPath, selectClaudeRecapLine))
    const lines = await tailFile(s.transcriptPath, Infinity)
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
