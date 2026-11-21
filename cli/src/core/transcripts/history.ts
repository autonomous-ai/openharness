/**
 * A conversation's history, for a window that asks for it (`session_get`): the whole thread, or the page
 * before a cursor and the cursor to the page before that; and the conversation an agent holds, with how
 * many lines it has (`sessions_list`). The socket hands each request here and sends back what comes out,
 * so every field of the replies is decided in this file.
 *
 * Every engine's history is its reader's (`readerFor`): Claude Code's and Codex's in their workers, which read
 * only the page asked for (lib/transcriptPages.ts), and the fourteen others' in theirs (engines/others/), which read
 * at most the newest 64 MB of a transcript, or a conversation from its engine's store. The core reads none of it: it
 * says which conversation and which store, and checks what comes back (core/engines/readers.ts).
 *
 * Moved verbatim out of the socket's request switch (docs/design/2026-10-03-harnessd.md); the other engines'
 * reading left for their worker (docs/design/2026-11-12-core-audit.md, section 3).
 */
import { withoutOutputTail } from '../../lib/cardUpdate.js'
import type { TranscriptReader } from '../../engines/facets/transcript.js'
import { keepsStore } from '../../engines/otherEngines.js'
import { EngineReadError } from '../../engines/worker/protocol.js'
import { transcriptReadIdentity } from './readIdentity.js'
import { lastActivityAt } from '../../lib/agentFrame.js'
import { sid } from '../../lib/log.js'
import { projectDisplayName, type RegisteredSession } from '../../lib/registry.js'

export interface HistoryDeps {
  /** The registry's lookup, by agent or session id. */
  resolve: (id: string) => RegisteredSession | undefined
  /** The conversations kept as stopped harnesses (lib/stoppedAgents.ts): a stop's, an exited engine's,
   *  and one a restart, a move or a restore had to leave for a new one. */
  stopped: () => Promise<readonly RegisteredSession[]>
  /** Incremental line counts; paging belongs to the reader's own process. */
  lineCount: (path: string) => Promise<number>
  readerFor: (engine: string) => TranscriptReader | undefined
  /** The store a conversation kept in a database is in (core/transcripts/stores.ts); null for one that is in none. */
  storeOf: (session: RegisteredSession) => Promise<string | null>
}

export function createHistory({ resolve, stopped, lineCount, readerFor, storeOf }: HistoryDeps) {
  /** A conversation with nothing to show: no transcript yet, or no reader for its engine. */
  const emptyPage = (s: RegisteredSession, sessionId: string): Record<string, unknown> => ({
    id: sessionId,
    title: projectDisplayName(s),
    events: [],
    timestamp: new Date(s.touchedAt).toISOString(),
    engine: s.engine,
    hasMore: false,
    oldestCursor: null,
  })

  const lookup = async (id: string) => {
    const live = resolve(id)
    if (live) return live
    const saved = await stopped()
    return resolve(id) ?? saved.find(row => row.sessionId === id)
  }

  /** The reply to a `session_get` request, for the socket to send as it is. */
  const sessionGet = async (payload: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const reply = await readHistory(payload)
    return Array.isArray(reply.events) ? { ...reply, events: reply.events.map(withoutOutputTail) } : reply
  }
  const readHistory = async (payload: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const sessionId = payload.sessionId as string | undefined
    if (!sessionId) return { error: 'MISSING_SESSION_ID' }
    // Only serve transcripts for a session this daemon REGISTERED — live, or kept as a stopped one —
    // read from its own trusted transcriptPath: never resolve an arbitrary request-supplied id to a
    // file (that let a caller read any *.jsonl on the computer, incl. unshared claude history /
    // traversal). A kept conversation used to answer NOT_FOUND, so a conversation the daemon had to
    // leave for a new one could no longer be read at all (round 24).
    const s = await lookup(sessionId)
    if (!s) return { error: 'NOT_FOUND' }
    // The registry finds an agent by its agent id too, and the reply names the id it was asked by. What
    // is read is the conversation's own, `s.sessionId`: an engine's store, Amp's export and Cursor's task
    // links know that id alone, and under the agent id they read nothing.
    // Optional pagination: `limit` = window size; `before` = cursor (the oldest record the
    // client already holds). Absent → full transcript (legacy). Clamp limit defensively.
    const rawLimit = payload.limit
    const limit = typeof rawLimit === 'number' && rawLimit > 0 ? Math.min(Math.floor(rawLimit), 500) : undefined
    const before = typeof payload.before === 'string' ? payload.before : undefined
    // A conversation kept in a store has no transcript: the store is read, and it is the core that says which one.
    const store = keepsStore(s.engine)
    if (!s.transcriptPath && !store) return emptyPage(s, sessionId)
    const reader = readerFor(s.engine)
    // No engine reaches this without a reader (a shell keeps no transcript: registry.engineKeepsTranscriptFile).
    if (!reader) return emptyPage(s, sessionId)
    const identity = transcriptReadIdentity(s)
    try {
      const read = store ? { ...s, store: await storeOf(s) } : s
      const { events, timestamp, ...page } = await reader.historyPage(read, { limit, before })
      if (transcriptReadIdentity(await lookup(sessionId)) !== identity) throw new EngineReadError('ENGINE_STALE_REPLY')
      return { id: sessionId, title: projectDisplayName(s), events, timestamp, engine: s.engine, ...page }
    } catch (error) {
      const failed = error instanceof EngineReadError ? error : new EngineReadError('ENGINE_UNAVAILABLE')
      // The window shows the error; the log says whose history it was, so a pane left empty can be traced.
      console.warn(`[engine ${s.engine}] history unavailable · ${failed.code} · ${sid(s.sessionId)}`)
      return { error: failed.code, retryable: failed.retryable }
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
    // Counted from an index kept as the file grows (lib/transcriptIndex.ts), not by reading it whole.
    const messageCount = s.transcriptPath ? await lineCount(s.transcriptPath) : 0
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
