/**
 * The fourteen engines' history and last turn: each conversation read from its transcript or its store, then
 * replayed and windowed by its engine's own code. They run in the engines' worker (engines/others/otherEnginesProcess.ts), and in
 * the core's process only for explicit inline compatibility (services/inline.ts): an older master, or
 * `HARNESSD_SERVICES=none`. Moved out of core/transcripts/history.ts and lastTurn.ts (docs/design/2026-11-12-core-audit.md,
 * section 3), the readings as they were.
 *
 * Each engine's code is loaded on its first read (engines/inProcess.ts `loadEngine`): an engine nobody reads costs
 * nothing, and one that cannot load reads as an empty conversation with no last turn, as it did in the core. The
 * store a conversation is in is the core's to say (`TranscriptSession.store`): this module reads only what it is
 * handed.
 *
 * The file engines read at most the newest 64 MB of their transcripts (lib/transcriptTail.ts), because the whole
 * history of one long session is more memory than a process has (the crash of 2026-10-03). The database engines
 * still read a whole conversation from their stores and cut the page from it, in this process now and never in the
 * core's.
 */
import { stat } from 'node:fs/promises'
import type { EngineTranscript, HistoryAnswer, HistoryAsk, TranscriptSession } from '../facets/transcript.js'
import type { LastTurnText, SessionEvent } from '../kit/events.js'
import { loadEngine, type InProcessModules } from '../inProcess.js'
import { isOtherEngine, keepsStore, type OtherEngine } from '../otherEngines.js'
import { sid } from '../../lib/log.js'
import { tailFileCapped, WHOLE_READ_CAP_BYTES } from '../../lib/transcriptTail.js'

/**
 * Amp history comes from AMP's store, not from ours.
 *
 * The plugin's JSONL is a record of what the plugin saw; a thread that ran before the integration existed
 * — or in a pane still holding an older plugin — is simply not in it, and no local file can rebuild those
 * turns. `amp threads export` returns the thread complete, including the tools Amp runs server-side.
 *
 * The local file stays as the FALLBACK, because an export is a network call and a pane with no history at
 * all is worse than a partial one. Which source answered is logged either way: silently serving the lesser
 * record is exactly how the missing tool cards went unnoticed for a day.
 */
async function ampHistory(amp: InProcessModules['amp'], sessionId: string, lines: string[]): Promise<SessionEvent[]> {
  const messages = await amp.readAmpThread(sessionId)
  if (messages) {
    console.log(`[history] ${sessionId.slice(0, 12)} amp · ${messages.length} message(s) from amp's own store`)
    return amp.ampThreadToEvents(messages)
  }
  console.warn(`[history] ${sessionId.slice(0, 12)} amp · export unavailable — falling back to the local transcript`)
  return amp.ampMessagesToEvents(lines)
}

/** Grok, agy and Copilot have no transcript windower yet. Keep BOTH `session_get` shapes on the same real-record
 * replay: web always sends a limit, while legacy callers omit it. Returning the whole small transcript for a
 * page is honest (`hasMore:false`) and cannot fall through to Claude's incompatible line cursor. */
export function wholeHistoryPage(events: SessionEvent[], paginated: boolean):
  { events: SessionEvent[]; hasMore?: false; oldestCursor?: null } {
  return paginated ? { events, hasMore: false, oldestCursor: null } : { events }
}

/** A conversation with nothing to show: its engine's code could not be loaded. */
const emptyPage = (timestamp: string): HistoryAnswer => ({ events: [], timestamp, hasMore: false, oldestCursor: null })

/**
 * An engine that keeps its conversations in a database, not a transcript file: the conversation read
 * from its store, then replayed whole or windowed, in the same shape as every other engine's answer.
 *
 * Both shapes are load-bearing: the web client always sends a `limit`, so answering only the whole
 * conversation opens an empty pane, the half-dispatch the socket was once caught on. Each windower
 * namespaces its cursors by engine (`kilo:<index>`), so a cursor from another engine reads as stale
 * rather than silently indexing into the wrong conversation.
 */
function storePage<M>(
  messages: M[],
  timestamp: string,
  { limit, before }: HistoryAsk,
  toEvents: (messages: M[]) => SessionEvent[],
  windowOf: (messages: M[], opts: { limit: number; before?: string }) =>
    { window: M[]; hasMore: boolean; oldestCursor: string | null; staleCursor?: boolean },
): HistoryAnswer {
  if (!limit) return { events: toEvents(messages), timestamp }
  const w = windowOf(messages, { limit, before })
  if (w.staleCursor) return { events: [], timestamp, hasMore: false, oldestCursor: null, staleCursor: true }
  const events = toEvents(w.window)
  if (before && events[events.length - 1]?.type === 'done') events.pop()
  return { events, timestamp, hasMore: w.hasMore, oldestCursor: w.oldestCursor }
}

/** A store engine's history. Devin, OpenCode and Kilo keep one store on this machine, Hermes one per home and OpenClaw
 *  one per TUI's state folder: whichever, it is the one the core named. OpenClaw's is none for a key it does not hold. */
async function storeHistory(engine: OtherEngine, session: TranscriptSession, ask: HistoryAsk): Promise<HistoryAnswer> {
  const timestamp = new Date(session.touchedAt).toISOString()
  const store = session.store ?? ''
  switch (engine) {
    case 'devin': {
      const m = await loadEngine('devin')
      return m ? storePage(await m.readDevinMessages(store, session.sessionId), timestamp, ask, m.devinMessagesToEvents, m.windowDevinMessages) : emptyPage(timestamp)
    }
    case 'hermes': {
      const m = await loadEngine('hermes')
      return m ? storePage(await m.readHermesMessages(store, session.sessionId), timestamp, ask, m.hermesMessagesToEvents, m.windowHermesMessages) : emptyPage(timestamp)
    }
    case 'opencode': {
      const m = await loadEngine('opencode')
      return m ? storePage(await m.readOpencodeMessages(store, session.sessionId), timestamp, ask, m.opencodeMessagesToEvents, m.windowOpencodeMessages) : emptyPage(timestamp)
    }
    case 'kilo': {
      const m = await loadEngine('kilo')
      return m ? storePage(await m.readKiloMessages(store, session.sessionId), timestamp, ask, m.kiloMessagesToEvents, m.windowKiloMessages) : emptyPage(timestamp)
    }
    default: {
      const m = await loadEngine('openclaw')
      return m ? storePage(session.store ? await m.readOpenclawHistory(session.store, session.sessionId) : [], timestamp, ask,
        m.openclawMessagesToEvents, m.windowOpenclawEvents) : emptyPage(timestamp)
    }
  }
}

/**
 * A file engine's history: read from the end and bounded, because these engines have no pages of their own yet, and one
 * huge transcript read whole would take the process down (lib/transcriptTail.ts). History past the cap is not shown,
 * and the reply says so.
 */
async function fileHistory(engine: OtherEngine, transcriptPath: string, sessionId: string, { limit, before }: HistoryAsk): Promise<HistoryAnswer> {
  const { lines, truncated: capped } = await tailFileCapped(transcriptPath)
  if (capped) console.warn(`[backend] session_get ${sid(sessionId)}: the transcript is over ${WHOLE_READ_CAP_BYTES / 1024 / 1024} MB · its oldest history is not shown`)
  const truncated = capped ? { truncated: true as const } : {}
  const st = await stat(transcriptPath).catch(() => null)
  const timestamp = new Date(st?.mtimeMs ?? Date.now()).toISOString()
  // The engine's replays and windows are its own code: one that could not load shows an empty conversation.
  const other = await loadEngine(engine)
  if (other === null) return emptyPage(timestamp)
  const code = <Name extends OtherEngine>(_name: Name): InProcessModules[Name] => other as InProcessModules[Name]

  if (!limit) {
    const fullEvents = engine === 'cursor'
        ? code('cursor').cursorMessagesToEvents(lines, sessionId, await code('cursor').loadCursorReplayTaskLinks(code('cursor').cursorConfigDir(), sessionId, code('cursor').cursorDataDir()))
        : engine === 'muse'
          ? code('muse').museMessagesToEvents(lines)
          : engine === 'amp'
          ? await ampHistory(code('amp'), sessionId, lines)
          : engine === 'grok'
            ? wholeHistoryPage(code('grok').grokMessagesToEvents(lines), false).events
          : engine === 'agy'
            ? wholeHistoryPage(code('agy').agyMessagesToEvents(lines), false).events
          : engine === 'copilot'
            ? wholeHistoryPage(code('copilot').copilotMessagesToEvents(lines), false).events
          : engine === 'pi'
          ? code('pi').piMessagesToEvents(lines)
          : engine === 'omp'
          ? code('omp').ompMessagesToEvents(lines)
          : code('commandcode').commandcodeMessagesToEvents(lines)
    return { events: fullEvents, timestamp, ...truncated }
  }

  // Muse has no windower, so it must not fall through to the raw one: that pairs claude's
  // line-uuid cursor with claude's normalizer, and a muse transcript comes back EMPTY — the web
  // pane opened blank with no error anywhere. Until a muse window exists, answer the page with
  // the whole transcript (`hasMore: false` ends the scroll honestly, and these sessions are
  // small: a real one measured 271 lines).
  // Amp is in the same position as muse and for the same reason: no windower, so falling
  // through would pair claude's line-uuid cursor with claude's normalizer and return nothing.
  if (engine === 'muse' || engine === 'amp' || engine === 'grok' || engine === 'agy' || engine === 'copilot') {
    const wholePage = engine === 'grok'
      ? wholeHistoryPage(code('grok').grokMessagesToEvents(lines), true)
      : engine === 'agy'
        ? wholeHistoryPage(code('agy').agyMessagesToEvents(lines), true)
        : engine === 'copilot'
          ? wholeHistoryPage(code('copilot').copilotMessagesToEvents(lines), true)
          : null
    return {
      events: engine === 'amp'
        ? await ampHistory(code('amp'), sessionId, lines)
        : wholePage
          ? wholePage.events
          : code('muse').museMessagesToEvents(lines),
      timestamp,
      hasMore: wholePage?.hasMore ?? false,
      oldestCursor: wholePage?.oldestCursor ?? null,
      ...truncated,
    }
  }
  const w = engine === 'cursor'
      ? code('cursor').windowCursorLines(lines, { limit, before })
      : engine === 'pi'
        ? code('pi').windowPiLines(lines, { limit, before })
        : engine === 'omp'
          ? code('omp').windowOmpLines(lines, { limit, before })
          : code('commandcode').windowCommandCodeLines(lines, { limit, before })
  if (w.staleCursor) return { events: [], timestamp, hasMore: false, oldestCursor: null, staleCursor: true, ...truncated }
  const events = engine === 'cursor'
      ? code('cursor').cursorMessagesToEvents(
          w.window,
          sessionId,
          await code('cursor').loadCursorReplayTaskLinks(code('cursor').cursorConfigDir(), sessionId, code('cursor').cursorDataDir()),
          'startIndex' in w && typeof w.startIndex === 'number' ? w.startIndex : 0,
          'initialTodos' in w && Array.isArray(w.initialTodos) ? w.initialTodos : [],
        )
      : engine === 'pi'
        ? code('pi').piMessagesToEvents(w.window)
        : engine === 'omp'
          ? code('omp').ompMessagesToEvents(w.window)
          : code('commandcode').commandcodeMessagesToEvents(w.window)
  // muse and amp are answered above and never reach here, so both are absent by design.
  // Older pages must not inject a spurious end-of-transcript marker mid-scroll.
  if (before && events[events.length - 1]?.type === 'done') events.pop()
  return { events, timestamp, hasMore: w.hasMore, oldestCursor: w.oldestCursor, ...truncated }
}

/**
 * The text of the last turn, for its recap: from a store engine's store, or the end of a file engine's transcript, read
 * bounded like every whole read of an engine without pages (lib/transcriptTail.ts). The last turn is at the end, and a
 * transcript past the cap would otherwise be read whole at every turn's end.
 */
async function lastTurn(engine: OtherEngine, session: TranscriptSession): Promise<LastTurnText | null> {
  const store = session.store ?? '', sessionId = session.sessionId
  if (engine === 'opencode') { const m = await loadEngine('opencode'); return m ? m.lastOpencodeTurnText(await m.readOpencodeMessages(store, sessionId)) : null }
  if (engine === 'kilo') { const m = await loadEngine('kilo'); return m ? m.lastKiloTurnText(await m.readKiloMessages(store, sessionId)) : null }
  if (engine === 'hermes') { const m = await loadEngine('hermes'); return m ? m.lastHermesTurnText(await m.readHermesMessages(store, sessionId)) : null }
  if (engine === 'devin') { const m = await loadEngine('devin'); return m ? m.lastDevinTurnText(await m.readDevinMessages(store, sessionId)) : null }
  if (engine === 'openclaw') {
    const m = await loadEngine('openclaw')
    return m && session.store ? m.lastOpenclawTurnText(await m.readOpenclawHistory(session.store, sessionId)) : null
  }
  if (!session.transcriptPath) return null
  const { lines } = await tailFileCapped(session.transcriptPath)
  if (engine === 'cursor') return (await loadEngine('cursor'))?.lastCursorTurnText(lines) ?? null
  if (engine === 'muse') return (await loadEngine('muse'))?.lastMuseTurnText(lines) ?? null
  if (engine === 'amp') return (await loadEngine('amp'))?.lastAmpTurnText(lines) ?? null
  if (engine === 'grok') return (await loadEngine('grok'))?.lastGrokTurnText(lines) ?? null
  if (engine === 'agy') return (await loadEngine('agy'))?.lastAgyTurnText(lines) ?? null
  if (engine === 'copilot') return (await loadEngine('copilot'))?.lastCopilotTurnText(lines) ?? null
  if (engine === 'pi') return (await loadEngine('pi'))?.lastPiTurnText(lines) ?? null
  if (engine === 'omp') return (await loadEngine('omp'))?.lastOmpTurnText(lines) ?? null
  return (await loadEngine('commandcode'))?.lastCommandCodeTurnText(lines) ?? null
}

/** One of the fourteen engines' history and last turn; undefined for any other engine. */
export function otherTranscriptFor(engine: string): EngineTranscript | undefined {
  if (!isOtherEngine(engine)) return undefined
  return {
    lastTurnText: (session) => lastTurn(engine, session),
    historyPage: async (session, ask) => {
      if (keepsStore(engine)) return storeHistory(engine, session, ask)
      // A file engine with no transcript yet has nothing to show; stamped when it was last touched.
      if (!session.transcriptPath) return emptyPage(new Date(session.touchedAt).toISOString())
      return fileHistory(engine, session.transcriptPath, session.sessionId, ask)
    },
  }
}
