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
import { join } from 'node:path'
import { agyMessagesToEvents } from '../../engines/agy/normalizer.js'
import { ampMessagesToEvents } from '../../engines/amp/normalizer.js'
import { ampThreadToEvents, readAmpThread } from '../../engines/amp/threadExport.js'
import { codexMessagesToEvents } from '../../engines/codex/normalizer.js'
import { codexSubagentResolverFor } from '../../engines/codex/subagent.js'
import { commandcodeMessagesToEvents, windowCommandCodeLines } from '../../engines/commandcode/normalizer.js'
import { copilotMessagesToEvents } from '../../engines/copilot/normalizer.js'
import { cursorConfigDir, cursorDataDir } from '../../engines/cursor/home.js'
import { cursorMessagesToEvents, windowCursorLines } from '../../engines/cursor/normalizer.js'
import { loadCursorReplayTaskLinks } from '../../engines/cursor/subagent.js'
import { devinMessagesToEvents, windowDevinMessages } from '../../engines/devin/normalizer.js'
import { readDevinMessages } from '../../engines/devin/reader.js'
import { grokMessagesToEvents } from '../../engines/grok/normalizer.js'
import { hermesMessagesToEvents, windowHermesMessages } from '../../engines/hermes/normalizer.js'
import { readHermesMessages } from '../../engines/hermes/reader.js'
import { kiloMessagesToEvents, windowKiloMessages } from '../../engines/kilo/normalizer.js'
import { readKiloMessages } from '../../engines/kilo/reader.js'
import { museMessagesToEvents } from '../../engines/muse/normalizer.js'
import { opencodeMessagesToEvents, windowOpencodeMessages } from '../../engines/opencode/normalizer.js'
import { readOpencodeMessages } from '../../engines/opencode/reader.js'
import { piMessagesToEvents, windowPiLines } from '../../engines/pi/normalizer.js'
import { sid } from '../../lib/log.js'
import { lastActivityAt } from '../../lib/agentFrame.js'
import { messagesToEvents, SubagentStats, windowRawLines, type SessionEvent } from '../../lib/normalize.js'
import { projectDisplayName, type RegisteredSession } from '../../lib/registry.js'
import type { TranscriptPager } from '../../lib/transcriptPages.js'
import { streamRecords, tailFileCapped, WHOLE_READ_CAP_BYTES } from '../../lib/transcriptTail.js'

export interface HistoryDeps {
  /** The registry's lookup, by agent or session id. */
  resolve: (id: string) => RegisteredSession | undefined
  /** The conversations kept as stopped harnesses (lib/stoppedAgents.ts): a stop's, an exited engine's,
   *  and one a restart, a move or a restore had to leave for a new one. */
  stopped: () => readonly RegisteredSession[]
  /** Claude Code's and Codex's pages, and every transcript's line count: one pager, so the line index it
   *  keeps for a transcript serves both requests and is not built twice. */
  pages: Pick<TranscriptPager, 'claude' | 'codex' | 'lineCount'>
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
async function ampHistory(sessionId: string, lines: string[]): Promise<SessionEvent[]> {
  const messages = await readAmpThread(sessionId)
  if (messages) {
    console.log(`[history] ${sessionId.slice(0, 12)} amp · ${messages.length} message(s) from amp's own store`)
    return ampThreadToEvents(messages)
  }
  console.warn(`[history] ${sessionId.slice(0, 12)} amp · export unavailable — falling back to the local transcript`)
  return ampMessagesToEvents(lines)
}

/** Grok has no transcript windower yet. Keep BOTH `session_get` shapes on the same real-record replay:
 * web always sends a limit, while legacy callers omit it. Returning the whole small transcript for a
 * page is honest (`hasMore:false`) and cannot fall through to Claude's incompatible line cursor. */
export function grokHistoryPage(lines: string[], paginated: boolean):
  { events: SessionEvent[]; hasMore?: false; oldestCursor?: null } {
  const events = grokMessagesToEvents(lines)
  return paginated ? { events, hasMore: false, oldestCursor: null } : { events }
}

/** agy has no transcript windower either; same both-shapes replay as grok, for the same reason. */
export function agyHistoryPage(lines: string[], paginated: boolean):
  { events: SessionEvent[]; hasMore?: false; oldestCursor?: null } {
  const events = agyMessagesToEvents(lines)
  return paginated ? { events, hasMore: false, oldestCursor: null } : { events }
}

/** Copilot has no transcript windower either; same both-shapes replay as grok and agy. */
export function copilotHistoryPage(lines: string[], paginated: boolean):
  { events: SessionEvent[]; hasMore?: false; oldestCursor?: null } {
  const events = copilotMessagesToEvents(lines)
  return paginated ? { events, hasMore: false, oldestCursor: null } : { events }
}

/** Fill in missing sub-agent aggregates on tool_end events by reading the sub-agent's own transcript
 *  (`<session>/subagents/agent-<id>.jsonl`). Async/background launchers only record
 *  `{status:'async_launched', agentId}` in the main transcript — without this join the delegation
 *  card shows "0 tools · worked for 0s" forever. Best-effort per agent; missing files are skipped. */
async function enrichSubagentStats(events: SessionEvent[], transcriptPath: string): Promise<void> {
  const subagentsDir = join(transcriptPath.replace(/\.jsonl$/, ''), 'subagents')
  for (const e of events) {
    if (e.type !== 'tool_end') continue
    const sub = e.payload.subagent
    if (!sub?.agentId || typeof sub.totalToolUseCount === 'number') continue
    try {
      // A line at a time: a long sub-agent's transcript is never held whole to count its calls.
      const file = join(subagentsDir, `agent-${sub.agentId}.jsonl`)
      const totals = new SubagentStats()
      await streamRecords(file, 0, (await stat(file)).size, (line) => { totals.push(line) }, () => true)
      const stats = totals.result()
      sub.totalToolUseCount = stats.totalToolUseCount
      if (sub.totalDurationMs === undefined) sub.totalDurationMs = stats.totalDurationMs
      if (sub.totalTokens === undefined) sub.totalTokens = stats.totalTokens
    } catch { /* subagent transcript absent (still spawning / pruned) — leave as-is */ }
  }
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

export function createHistory({ resolve, stopped, pages, dbs, hermesDb }: HistoryDeps) {
  // Devin, OpenCode and Kilo keep one store on this machine. Hermes keeps one per HOME, so its path is
  // the session's own (`hermesDb`) rather than this machine's default.
  const databases = new Map<string, DatabasePage>([
    ['devin', databasePage((s) => readDevinMessages(dbs.devin, s.sessionId), devinMessagesToEvents, windowDevinMessages)],
    ['hermes', databasePage(async (s) => readHermesMessages(await hermesDb(s), s.sessionId), hermesMessagesToEvents, windowHermesMessages)],
    ['opencode', databasePage((s) => readOpencodeMessages(dbs.opencode, s.sessionId), opencodeMessagesToEvents, windowOpencodeMessages)],
    ['kilo', databasePage((s) => readKiloMessages(dbs.kilo, s.sessionId), kiloMessagesToEvents, windowKiloMessages)],
  ])

  /** The reply to a `session_get` request, for the socket to send as it is. */
  const sessionGet = async (payload: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const sessionId = payload.sessionId as string | undefined
    if (!sessionId) return { error: 'MISSING_SESSION_ID' }
    // Only serve transcripts for a session this daemon REGISTERED — live, or kept as a stopped one —
    // read from its own trusted transcriptPath: never resolve an arbitrary request-supplied id to a
    // file (that let a caller read any *.jsonl on the computer, incl. unshared claude history /
    // traversal). A kept conversation used to answer NOT_FOUND, so a conversation the daemon had to
    // leave for a new one could no longer be read at all (round 24).
    const s = resolve(sessionId) ?? stopped().find((saved) => saved.sessionId === sessionId)
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
    if (database) return database(s, sessionId, { limit, before })
    if (!s.transcriptPath) {
      return {
        id: sessionId,
        title: projectDisplayName(s),
        events: [],
        timestamp: new Date(s.touchedAt).toISOString(),
        engine: s.engine,
        hasMore: false,
        oldestCursor: null,
      }
    }
    if (s.engine === 'claude' || s.engine === 'codex') {
      // Only the page asked for is read (lib/transcriptPages.ts): the whole history of a long session
      // is more memory than the daemon has. Without a limit, the newest lines that fit a page, and
      // the cursor to the rest when they do not all fit — a cursor the full-transcript reply never had.
      const opts = limit ? { limit, before } : {}
      const page = s.engine === 'codex'
        ? await pages.codex(s.transcriptPath, opts)
        : await pages.claude(s.transcriptPath, opts)
      const st = await stat(s.transcriptPath).catch(() => null)
      const timestamp = new Date(st?.mtimeMs ?? Date.now()).toISOString()
      if (page.staleCursor) {
        return { id: sessionId, title: projectDisplayName(s), events: [], timestamp, engine: s.engine, hasMore: false, oldestCursor: null, staleCursor: true }
      }
      const events = s.engine === 'codex'
        ? codexMessagesToEvents(page.lines, codexSubagentResolverFor(s.codexHome))
        : messagesToEvents(page.lines)
      await enrichSubagentStats(events, s.transcriptPath)
      // Older pages must not inject a spurious end-of-transcript marker mid-scroll.
      if (limit && before && events[events.length - 1]?.type === 'done') events.pop()
      return {
        id: sessionId,
        title: projectDisplayName(s),
        events,
        timestamp,
        engine: s.engine,
        ...(limit || page.hasMore ? { hasMore: page.hasMore, oldestCursor: page.oldestCursor } : {}),
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

    if (!limit) {
      const fullEvents = s.engine === 'cursor'
          ? cursorMessagesToEvents(lines, s.sessionId, await loadCursorReplayTaskLinks(cursorConfigDir(), s.sessionId, cursorDataDir()))
          : s.engine === 'muse'
            ? museMessagesToEvents(lines)
            : s.engine === 'amp'
            ? await ampHistory(s.sessionId, lines)
            : s.engine === 'grok'
              ? grokHistoryPage(lines, false).events
            : s.engine === 'agy'
              ? agyHistoryPage(lines, false).events
            : s.engine === 'copilot'
              ? copilotHistoryPage(lines, false).events
            : s.engine === 'pi'
            ? piMessagesToEvents(lines)
            : s.engine === 'commandcode'
              ? commandcodeMessagesToEvents(lines)
              : messagesToEvents(lines)
      if (s.engine !== 'cursor' && s.engine !== 'pi' && s.engine !== 'commandcode' && s.engine !== 'muse' && s.engine !== 'amp' && s.engine !== 'grok' && s.engine !== 'agy' && s.engine !== 'copilot') await enrichSubagentStats(fullEvents, s.transcriptPath)
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
        ? grokHistoryPage(lines, true)
        : s.engine === 'agy'
          ? agyHistoryPage(lines, true)
          : s.engine === 'copilot'
            ? copilotHistoryPage(lines, true)
            : null
      return {
        id: sessionId,
        title: projectDisplayName(s),
        events: s.engine === 'amp'
          ? await ampHistory(s.sessionId, lines)
          : wholePage
            ? wholePage.events
            : museMessagesToEvents(lines),
        timestamp,
        engine: s.engine,
        hasMore: wholePage?.hasMore ?? false,
        oldestCursor: wholePage?.oldestCursor ?? null,
        ...truncated,
      }
    }
    const w = s.engine === 'cursor'
        ? windowCursorLines(lines, { limit, before })
        : s.engine === 'pi'
          ? windowPiLines(lines, { limit, before })
          : s.engine === 'commandcode'
            ? windowCommandCodeLines(lines, { limit, before })
            : windowRawLines(lines, { limit, before })
    if (w.staleCursor) {
      return { id: sessionId, title: projectDisplayName(s), events: [], timestamp, engine: s.engine, hasMore: false, oldestCursor: null, staleCursor: true, ...truncated }
    }
    const events = s.engine === 'cursor'
        ? cursorMessagesToEvents(
            w.window,
            s.sessionId,
            await loadCursorReplayTaskLinks(cursorConfigDir(), s.sessionId, cursorDataDir()),
            'startIndex' in w && typeof w.startIndex === 'number' ? w.startIndex : 0,
            'initialTodos' in w && Array.isArray(w.initialTodos) ? w.initialTodos : [],
          )
        : s.engine === 'pi'
          ? piMessagesToEvents(w.window)
          : s.engine === 'commandcode'
            ? commandcodeMessagesToEvents(w.window)
            : messagesToEvents(w.window)
    // muse and amp are answered above and never reach here, so both are absent by design.
    if (s.engine !== 'cursor' && s.engine !== 'pi' && s.engine !== 'commandcode') await enrichSubagentStats(events, s.transcriptPath)
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
