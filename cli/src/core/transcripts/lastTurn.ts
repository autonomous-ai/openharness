/**
 * The text of an agent's last turn, for its recap: from the database engines' stores, Codex's rollout,
 * Claude Code's transcript read backward from its end, and every other engine's transcript.
 *
 * The file engines other than Claude Code and Codex still read the whole transcript here, once per turn
 * end (docs/research/2026-10-04-whole-history-reads.md); bounding them is the next engine work.
 *
 * Moved verbatim out of `runForeground` (the core boundary, step 7: docs/design/2026-10-03-harnessd.md).
 */
import type { EngineTranscript } from '../../engines/facets/transcript.js'
import { EngineReadError } from '../../engines/worker/protocol.js'
import { transcriptReadIdentity } from './readIdentity.js'
import type { LastTurnText } from '../../engines/kit/events.js'
import type { RegisteredSession } from '../../lib/registry.js'
import { tailFileCapped } from '../../lib/transcriptTail.js'
import { loadEngine } from '../../engines/inProcess.js'

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
    // The other engines' readers are their own code, loaded in this process (engines/inProcess.ts): one that
    // could not load has no last turn to tell.
    if (s.engine === 'opencode') { const m = await loadEngine('opencode'); return m ? m.lastOpencodeTurnText(await m.readOpencodeMessages(dbs.opencode, sessionId)) : null }
    if (s.engine === 'kilo') { const m = await loadEngine('kilo'); return m ? m.lastKiloTurnText(await m.readKiloMessages(dbs.kilo, sessionId)) : null }
    if (s.engine === 'hermes') { const m = await loadEngine('hermes'); return m ? m.lastHermesTurnText(await m.readHermesMessages(await hermesDb(s), sessionId)) : null }
    if (s.engine === 'devin') { const m = await loadEngine('devin'); return m ? m.lastDevinTurnText(await m.readDevinMessages(dbs.devin, sessionId)) : null }
    if (!s.transcriptPath) return null
    // Bounded from the end like every whole read of an engine without pages (lib/transcriptTail.ts):
    // the last turn is at the end, and a transcript past the cap would otherwise be read whole at
    // every turn's end.
    const { lines } = await tailFileCapped(s.transcriptPath)
    if (s.engine === 'cursor') return (await loadEngine('cursor'))?.lastCursorTurnText(lines) ?? null
    if (s.engine === 'muse') return (await loadEngine('muse'))?.lastMuseTurnText(lines) ?? null
    if (s.engine === 'amp') return (await loadEngine('amp'))?.lastAmpTurnText(lines) ?? null
    if (s.engine === 'grok') return (await loadEngine('grok'))?.lastGrokTurnText(lines) ?? null
    if (s.engine === 'agy') return (await loadEngine('agy'))?.lastAgyTurnText(lines) ?? null
    if (s.engine === 'copilot') return (await loadEngine('copilot'))?.lastCopilotTurnText(lines) ?? null
    if (s.engine === 'pi') return (await loadEngine('pi'))?.lastPiTurnText(lines) ?? null
    if (s.engine === 'commandcode') return (await loadEngine('commandcode'))?.lastCommandCodeTurnText(lines) ?? null
    // No reader and no code of its own here: Claude Code and Codex always have a reader, and a shell keeps no
    // transcript, so no engine reaches this. Their recaps are their readers', never core's.
    return null
  }
}
