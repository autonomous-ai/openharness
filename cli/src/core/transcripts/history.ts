/**
 * A conversation's history, for a window that asks for it (`session_get`): the whole thread, or the page
 * before a cursor and the cursor to the page before that; and the conversation an agent holds, with how
 * many lines it has (`sessions_list`). The socket hands each request here and sends back what comes out,
 * so every field of the replies is decided in this file.
 *
 * Claude Code and Codex read only the page asked for (lib/transcriptPages.ts), and the other file engines
 * at most the newest 64 MB of their transcripts (lib/transcriptTail.ts), because the whole history of one
 * long session is more memory than the daemon has (the crash of 2026-10-03). The database engines still
 * read a whole conversation from their stores and cut the page from it: bounding them is engine work
 * still to come (docs/design/2026-10-03-harnessd.md, "Next").
 *
 * Moved verbatim out of the socket's request switch (docs/design/2026-10-03-harnessd.md), but for the
 * four database engines: each had its own copy of the same windowing, and they now share one.
 */
import { stat } from 'node:fs/promises'
import type { EngineTranscript } from '../../engines/facets/transcript.js'
import { EngineReadError } from '../../engines/worker/protocol.js'
import { transcriptReadIdentity } from './readIdentity.js'
import { isOtherEngine, loadEngine, type InProcessModules, type OtherEngine } from '../../engines/inProcess.js'
import { sid } from '../../lib/log.js'
import { lastActivityAt } from '../../lib/agentFrame.js'
import type { SessionEvent } from '../../engines/kit/events.js'
import { projectDisplayName, type RegisteredSession } from '../../lib/registry.js'
import type { TranscriptPager } from '../../lib/transcriptPages.js'
import { tailFileCapped, WHOLE_READ_CAP_BYTES } from '../../lib/transcriptTail.js'

export interface HistoryDeps {
  /** The registry's lookup, by agent or session id. */
  resolve: (id: string) => RegisteredSession | undefined
  /** The conversations kept as stopped harnesses (lib/stoppedAgents.ts): a stop's, an exited engine's,
   *  and one a restart, a move or a restore had to leave for a new one. */
  stopped: () => readonly RegisteredSession[]
  /** Line counts, and the explicit inline compatibility path's pages. Isolated readers own their indexes. */
  pages: Pick<TranscriptPager, 'page' | 'lineCount'>
  readerFor: (engine: string) => EngineTranscript | undefined
  /** The database engines' stores. */
  dbs: { opencode: string; kilo: string; devin: string }
  /** Hermes keeps a store per profile: the one this session's lives in. */
  hermesDb: (session: RegisteredSession) => Promise<string>
}

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

/** What a window asks for: `limit` records before the `before` cursor. No limit asks for all of them. */
interface PageAsk { limit?: number; before?: string }

/** One database engine's answer to `session_get`, about `s`, under the id it was asked by. */
type DatabasePage = (s: RegisteredSession, sessionId: string, ask: PageAsk) => Promise<Record<string, unknown>>

/**
 * An engine that keeps its conversations in a database, not a transcript file: the conversation read
 * from its store, then replayed whole or windowed, in the same shape as every other engine's answer.
 *
 * Both shapes are load-bearing: the web client always sends a `limit`, so answering only the whole
 * conversation opens an empty pane, the half-dispatch the socket was once caught on. Each windower
 * namespaces its cursors by engine (`kilo:<index>`), so a cursor from another engine reads as stale
 * rather than silently indexing into the wrong conversation.
 */
function databasePage<M>(
  read: (s: RegisteredSession) => Promise<M[]>,
  toEvents: (messages: M[]) => SessionEvent[],
  windowOf: (messages: M[], opts: { limit: number; before?: string }) =>
    { window: M[]; hasMore: boolean; oldestCursor: string | null; staleCursor?: boolean },
): DatabasePage {
  return async (s, sessionId, { limit, before }) => {
    const messages = await read(s)
    const timestamp = new Date(s.touchedAt).toISOString()
    if (!limit) {
      return { id: sessionId, title: projectDisplayName(s), events: toEvents(messages), timestamp, engine: s.engine }
    }
    const w = windowOf(messages, { limit, before })
    if (w.staleCursor) {
      return { id: sessionId, title: projectDisplayName(s), events: [], timestamp, engine: s.engine, hasMore: false, oldestCursor: null, staleCursor: true }
    }
    const events = toEvents(w.window)
    if (before && events[events.length - 1]?.type === 'done') events.pop()
    return { id: sessionId, title: projectDisplayName(s), events, timestamp, engine: s.engine, hasMore: w.hasMore, oldestCursor: w.oldestCursor }
  }
}

export function createHistory({ resolve, stopped, pages, dbs, hermesDb, readerFor }: HistoryDeps) {
  // Devin, OpenCode and Kilo keep one store on this machine. Hermes keeps one per HOME, so its path is
  // the session's own (`hermesDb`) rather than this machine's default.
  // Each store's reader, replay and window are the engine's own code, loaded in this process (engines/inProcess.ts).
  const databases = new Map<string, (s: RegisteredSession) => Promise<DatabasePage | null>>([
    ['devin', async () => { const m = await loadEngine('devin'); return m && databasePage((s) => m.readDevinMessages(dbs.devin, s.sessionId), m.devinMessagesToEvents, m.windowDevinMessages) }],
    ['hermes', async () => { const m = await loadEngine('hermes'); return m && databasePage(async (s) => m.readHermesMessages(await hermesDb(s), s.sessionId), m.hermesMessagesToEvents, m.windowHermesMessages) }],
    ['opencode', async () => { const m = await loadEngine('opencode'); return m && databasePage((s) => m.readOpencodeMessages(dbs.opencode, s.sessionId), m.opencodeMessagesToEvents, m.windowOpencodeMessages) }],
    ['kilo', async () => { const m = await loadEngine('kilo'); return m && databasePage((s) => m.readKiloMessages(dbs.kilo, s.sessionId), m.kiloMessagesToEvents, m.windowKiloMessages) }],
  ])
  /** A conversation with nothing to show: no transcript yet, or its engine's code could not be loaded. */
  const emptyPage = (s: RegisteredSession, sessionId: string): Record<string, unknown> => ({
    id: sessionId,
    title: projectDisplayName(s),
    events: [],
    timestamp: new Date(s.touchedAt).toISOString(),
    engine: s.engine,
    hasMore: false,
    oldestCursor: null,
  })

  const lookup = (id: string) => resolve(id) ?? stopped().find((saved) => saved.sessionId === id)

  /** The reply to a `session_get` request, for the socket to send as it is. */
  const sessionGet = async (payload: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const sessionId = payload.sessionId as string | undefined
    if (!sessionId) return { error: 'MISSING_SESSION_ID' }
    // Only serve transcripts for a session this daemon REGISTERED — live, or kept as a stopped one —
    // read from its own trusted transcriptPath: never resolve an arbitrary request-supplied id to a
    // file (that let a caller read any *.jsonl on the computer, incl. unshared claude history /
    // traversal). A kept conversation used to answer NOT_FOUND, so a conversation the daemon had to
    // leave for a new one could no longer be read at all (round 24).
    const s = lookup(sessionId)
    if (!s) return { error: 'NOT_FOUND' }
    // The registry finds an agent by its agent id too, and the reply names the id it was asked by. What
    // is read is the conversation's own, `s.sessionId`: an engine's store, Amp's export and Cursor's task
    // links know that id alone, and under the agent id they read nothing.
    // Optional pagination: `limit` = window size; `before` = cursor (the oldest record the
    // client already holds). Absent → full transcript (legacy). Clamp limit defensively.
    const rawLimit = payload.limit
    const limit = typeof rawLimit === 'number' && rawLimit > 0 ? Math.min(Math.floor(rawLimit), 500) : undefined
    const before = typeof payload.before === 'string' ? payload.before : undefined
    const database = databases.get(s.engine)
    if (database) {
      const page = await database(s)
      return page ? page(s, sessionId, { limit, before }) : emptyPage(s, sessionId)
    }
    if (!s.transcriptPath) return emptyPage(s, sessionId)
    const reader = readerFor(s.engine)
    if (reader) {
      const identity = transcriptReadIdentity(s)
      try {
        const { events, timestamp, ...page } = await reader.historyPage(s, { limit, before }, pages)
        if (transcriptReadIdentity(lookup(sessionId)) !== identity) throw new EngineReadError('ENGINE_STALE_REPLY')
        return { id: sessionId, title: projectDisplayName(s), events, timestamp, engine: s.engine, ...page }
      } catch (error) {
        const failed = error instanceof EngineReadError ? error : new EngineReadError('ENGINE_UNAVAILABLE')
        return { error: failed.code, retryable: failed.retryable }
      }
    }
    // Read from the end and bounded: these engines have no pages of their own yet, and one huge
    // transcript read whole would take the whole daemon down (lib/transcriptTail.ts). History past
    // the cap is not shown, and the reply says so.
    const { lines, truncated: capped } = await tailFileCapped(s.transcriptPath)
    if (capped) console.warn(`[backend] session_get ${sid(sessionId)}: the transcript is over ${WHOLE_READ_CAP_BYTES / 1024 / 1024} MB · its oldest history is not shown`)
    const truncated = capped ? { truncated: true } : {}
    const st = await stat(s.transcriptPath).catch(() => null)
    const timestamp = new Date(st?.mtimeMs ?? Date.now()).toISOString()
    // The other file engines' replays and windows are their own code, loaded in this process: one that could
    // not load shows an empty conversation, and so does an engine with no reader and no code of its own here.
    // Claude Code and Codex always have a reader (core/engines/readers.ts), and a shell keeps no transcript
    // (registry.engineKeepsTranscriptFile), so none reaches this: their replays are their readers', never core's.
    const other = isOtherEngine(s.engine) ? await loadEngine(s.engine) : null
    if (other === null) return { ...emptyPage(s, sessionId), timestamp }
    const engine = <Name extends OtherEngine>(name: Name): InProcessModules[Name] => other as InProcessModules[Name]

    if (!limit) {
      const fullEvents = s.engine === 'cursor'
          ? engine('cursor').cursorMessagesToEvents(lines, s.sessionId, await engine('cursor').loadCursorReplayTaskLinks(engine('cursor').cursorConfigDir(), s.sessionId, engine('cursor').cursorDataDir()))
          : s.engine === 'muse'
            ? engine('muse').museMessagesToEvents(lines)
            : s.engine === 'amp'
            ? await ampHistory(engine('amp'), s.sessionId, lines)
            : s.engine === 'grok'
              ? wholeHistoryPage(engine('grok').grokMessagesToEvents(lines), false).events
            : s.engine === 'agy'
              ? wholeHistoryPage(engine('agy').agyMessagesToEvents(lines), false).events
            : s.engine === 'copilot'
              ? wholeHistoryPage(engine('copilot').copilotMessagesToEvents(lines), false).events
            : s.engine === 'pi'
            ? engine('pi').piMessagesToEvents(lines)
            : engine('commandcode').commandcodeMessagesToEvents(lines)
      return {
        id: sessionId,
        title: projectDisplayName(s),
        events: fullEvents,
        timestamp,
        engine: s.engine,
        ...truncated,
      }
    }

    // Muse has no windower, so it must not fall through to the raw one: that pairs claude's
    // line-uuid cursor with claude's normalizer, and a muse transcript comes back EMPTY — the web
    // pane opened blank with no error anywhere. Until a muse window exists, answer the page with
    // the whole transcript (`hasMore: false` ends the scroll honestly, and these sessions are
    // small: a real one measured 271 lines).
    // Amp is in the same position as muse and for the same reason: no windower, so falling
    // through would pair claude's line-uuid cursor with claude's normalizer and return nothing.
    if (s.engine === 'muse' || s.engine === 'amp' || s.engine === 'grok' || s.engine === 'agy' || s.engine === 'copilot') {
      const wholePage = s.engine === 'grok'
        ? wholeHistoryPage(engine('grok').grokMessagesToEvents(lines), true)
        : s.engine === 'agy'
          ? wholeHistoryPage(engine('agy').agyMessagesToEvents(lines), true)
          : s.engine === 'copilot'
            ? wholeHistoryPage(engine('copilot').copilotMessagesToEvents(lines), true)
            : null
      return {
        id: sessionId,
        title: projectDisplayName(s),
        events: s.engine === 'amp'
          ? await ampHistory(engine('amp'), s.sessionId, lines)
          : wholePage
            ? wholePage.events
            : engine('muse').museMessagesToEvents(lines),
        timestamp,
        engine: s.engine,
        hasMore: wholePage?.hasMore ?? false,
        oldestCursor: wholePage?.oldestCursor ?? null,
        ...truncated,
      }
    }
    const w = s.engine === 'cursor'
        ? engine('cursor').windowCursorLines(lines, { limit, before })
        : s.engine === 'pi'
          ? engine('pi').windowPiLines(lines, { limit, before })
          : engine('commandcode').windowCommandCodeLines(lines, { limit, before })
    if (w.staleCursor) {
      return { id: sessionId, title: projectDisplayName(s), events: [], timestamp, engine: s.engine, hasMore: false, oldestCursor: null, staleCursor: true, ...truncated }
    }
    const events = s.engine === 'cursor'
        ? engine('cursor').cursorMessagesToEvents(
            w.window,
            s.sessionId,
            await engine('cursor').loadCursorReplayTaskLinks(engine('cursor').cursorConfigDir(), s.sessionId, engine('cursor').cursorDataDir()),
            'startIndex' in w && typeof w.startIndex === 'number' ? w.startIndex : 0,
            'initialTodos' in w && Array.isArray(w.initialTodos) ? w.initialTodos : [],
          )
        : s.engine === 'pi'
          ? engine('pi').piMessagesToEvents(w.window)
          : engine('commandcode').commandcodeMessagesToEvents(w.window)
    // muse and amp are answered above and never reach here, so both are absent by design.
    // Older pages must not inject a spurious end-of-transcript marker mid-scroll.
    if (before && events[events.length - 1]?.type === 'done') events.pop()
    return {
      id: sessionId,
      title: projectDisplayName(s),
      events,
      timestamp,
      engine: s.engine,
      hasMore: w.hasMore,
      oldestCursor: w.oldestCursor,
      ...truncated,
    }
  }

  /** The reply to a `sessions_list` request: the one conversation an agent holds, for the socket to send. */
  const sessionsList = async (payload: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const projectId = payload.agentId as string | undefined
    if (!projectId) return { error: 'MISSING_AGENT_ID' }
    const s = resolve(projectId)
    // An agent whose engine has not reported a session yet has no transcript to list. Saying so
    // plainly beats inventing one: the web then shows the tab with an empty thread until the bind
    // lands, instead of pinning `currentSessionId` to an id no event will ever carry.
    if (!s || !s.sessionId) return { sessions: [] }
    // Counted from an index kept as the file grows (lib/transcriptPages.ts), not by reading it whole.
    const messageCount = s.transcriptPath ? await pages.lineCount(s.transcriptPath) : 0
    return {
      sessions: [{
        id: s.sessionId,
        title: projectDisplayName(s),
        timestamp: new Date(s.registeredAt).toISOString(),
        messageCount,
        lastActivity: new Date(await lastActivityAt(s)).toISOString(),
        participants: [],
      }],
    }
  }

  return { sessionGet, sessionsList }
}
