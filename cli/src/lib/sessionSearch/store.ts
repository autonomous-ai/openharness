/**
 * The session search index: one SQLite database per machine, one row per turn, searched with FTS5.
 *
 * Keyword search (BM25) rather than embeddings, on purpose. What people type into a quick-open box is
 * one to three words and very often an exact token — a codename, a file, an issue number, a branch —
 * which BM25 matches exactly and an embedding blurs. It needs no model, answers in milliseconds, and
 * updates a turn at a time. See docs/research/2026-09-26-session-search.md.
 *
 * Every query word must appear in the SESSION, not necessarily in one turn: "mobile swipe" finds the
 * session titled Mobile whose swipe discussion came an hour later. A turn holding every word is still
 * the better match and ranks first.
 */

import { chmodSync, existsSync, rmSync } from 'node:fs'

import { builtinSqlite } from '../sqliteRead.js'
import type { IndexedTurn } from './turns.js'

// Rebuild schema 10's external-engine index with Codex app/editor context removed from asks.
const SCHEMA_VERSION = '11'

/** The row that holds a session's name, title and folder: searchable beside its turns. */
export const HEADER_TURN = -1

interface Statement {
  all(...params: unknown[]): Record<string, unknown>[]
  get(...params: unknown[]): Record<string, unknown> | undefined
  run(...params: unknown[]): unknown
}
interface Database {
  prepare(sql: string): Statement
  exec(sql: string): void
  close(): void
}
type DatabaseConstructor = new (path: string, options?: Record<string, unknown>) => Database

export interface IndexedSession {
  sessionId: string
  agentId: string
  engine: string
  path: string
  /** The session's name, title and folders, as the header row holds them. */
  header: string
  /** File size and mtime when last read, to tell whether it changed since. */
  size: number
  mtime: number
  /** Where the next pass starts: the opening of the last turn, which may still be growing. */
  resumeOffset: number
  resumeTurn: number
  lastAt: number | null
  turns: number
  /**
   * A conversation Harness did not start (lib/sessionSearch/external.ts), whose `agentId` is empty:
   * its title (Codex's thread name, Claude's own title, else the first ask), the folder it resumes in,
   * and where it ran. Empty for a Harness session.
   */
  title?: string
  cwd?: string
  origin?: string
}

/** What a hit on a conversation Harness did not start carries, so a client can show and resume it. */
export interface ExternalHit {
  title: string
  cwd: string
  origin: string
  /** Open in a running process elsewhere (a terminal, the engine's app): not to be opened twice. */
  open?: boolean
  /** Confirmed mid-turn, idle, or omitted when the engine cannot report its current work state. */
  working?: boolean
  /** Where it is open: a terminal, which Harness can take it over from; an app, which it cannot; or
   *  one of Harness's own panes, an agent the daemon is still binding; or `maybe` a terminal whose
   *  process was started on it and may have moved on. */
  openIn?: 'terminal' | 'app' | 'harness' | 'maybe'
}

export interface SearchHit {
  sessionId: string
  agentId: string
  engine: string
  /** The turn the snippet comes from, or -1 for the session's name and folder. */
  turn: number
  /** When that turn happened (epoch ms), when known. */
  at: number | null
  /** The session's latest turn (epoch ms), when known. */
  lastAt: number | null
  /** Which part of the turn matched best. */
  field: 'name' | 'ask' | 'answer' | 'tools'
  /** Text around the match, with each matched word between `\u0002` and `\u0003`. */
  snippet: string
  /** Every word in one turn, or spread across the session. */
  together: boolean
  /** 0–1, higher is better: relevance blended with recency; comparable across machines. */
  score: number
  /** Set for a conversation Harness did not start; its `agentId` is then empty. */
  external?: ExternalHit
}

// BM25 column weights: header (name/title/folder), what was asked, the answer, tool calls.
const WEIGHTS = [6, 4, 1.5, 1] as const
const FIELDS = ['name', 'ask', 'answer', 'tools'] as const
export const MARK_OPEN = '\u0002'
export const MARK_CLOSE = '\u0003'
/** How much recency counts against relevance, and how fast it fades. */
const RECENCY_WEIGHT = 0.2
const RECENCY_HALF_LIFE_DAYS = 10
/**
 * The turns that say what a session was started for, and how much more they count. A session named
 * "Claude harness 9-25 7:25" is found by its opening ask or not at all, and a session that merely
 * lists other sessions by name must not outrank the one that set out to do the thing. Tuned on real
 * sessions (see the research note): +10 points top-1 for one-word queries, +15 for topic queries,
 * −2 for four-letter prefixes.
 */
const OPENING_TURNS = 2
const OPENING_BOOST = 1.2
/** The start of what was asked, for a hit found by time alone. */
function clipAsk(ask: string): string {
  const line = ask.replace(/\s+/g, ' ').trim()
  return line.length > 160 ? line.slice(0, 160).trimEnd() + '…' : line
}

/** One row of a session as a preview shows it: a turn, or a long turn's continuation (no ask). */
export interface TailRow {
  turn: number
  at: number | null
  ask: string
  answer: string
  /** Tool calls, one per line: the paths, commands and queries they named. */
  tools: string
}

/** Dated conversation text for an explicit learning review; never tool output or reasoning. */
export interface RecentConversationTurn extends TailRow {
  sessionId: string
  agentId: string
  engine: string
  title: string
  cwd: string
}

/** The end of a session, oldest row first. */
export interface SessionTail {
  sessionId: string
  rows: TailRow[]
  /** Whether rows older than the first one here exist. */
  hasMore: boolean
  /** Rows in the whole session. */
  total: number
  lastAt: number | null
  /**
   * With the last page: the latest row that has an ask. After a long autonomous turn it is many
   * continuation rows up, and it is what the session is doing now.
   */
  lastAsk?: TailRow
  /** For a conversation Harness did not start: what a hit on it carries, and whether it is open. */
  external?: ExternalHit
}

/** What one preview page holds, and what a caller may ask for. */
export const TAIL_CHARS = 16_000
const TAIL_CHARS_MAX = 64_000
const TAIL_BATCH = 16

export interface SearchOptions {
  limit?: number
  /** Only sessions worked on in this window (epoch ms, inclusive). */
  from?: number
  to?: number
  now?: number
}

/** Rows considered per query before grouping by session: bounds the work of a very common word. */
const CANDIDATE_ROWS = 3_000
/** Past this many matching turns a query is ranked by recency first (see search()). */
export const COMMON_MATCHES = 30_000

/**
 * Query words as the index sees them: each split into its letter-and-digit parts, since the index
 * splits on everything else — "swarm_search.dart" and "OH-14" become phrases of their parts.
 */
function queryWords(query: string): string[][] {
  const seen = new Set<string>()
  const words: string[][] = []
  for (const word of query.toLowerCase().normalize('NFKC').split(/\s+/).filter(Boolean)) {
    const parts = word.split(/[^\p{L}\p{N}]+/u).filter(Boolean)
    if (!parts.length) continue
    // One letter matches too much of everything to mean anything on its own.
    if (parts.length === 1 && [...parts[0]].length < 2) continue
    const key = parts.join(' ')
    if (seen.has(key)) continue
    seen.add(key)
    words.push(parts)
  }
  return words
}

/** Query words as FTS5 phrases. Each word matches as a prefix, so the list updates while typing. */
export function queryTerms(query: string): string[] {
  return queryWords(query).map((parts) => `"${parts.join(' ')}"*`)
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Where a query word occurs in text the way the index matches it: at a word start, as a prefix. */
function wordPattern(parts: string[]): RegExp {
  const body = parts.map(escapeRegExp).join('[^\\p{L}\\p{N}]+')
  return new RegExp(`(?<![\\p{L}\\p{N}])${body}[\\p{L}\\p{N}]*`, 'giu')
}

const SNIPPET_BEFORE = 4
const SNIPPET_WORDS = 12

/**
 * The words around the first match in `text`, every match marked, or null when nothing matches.
 * Built here rather than by FTS5's snippet(), which reads the whole posting list of a common word
 * again for each hit: 30 hits of "harness" took a quarter of a second.
 */
export function makeSnippet(text: string, patterns: RegExp[]): string | null {
  let first = -1
  for (const pattern of patterns) {
    pattern.lastIndex = 0
    const match = pattern.exec(text)
    if (match && (first < 0 || match.index < first)) first = match.index
  }
  if (first < 0) return null
  // Only the neighbourhood of the match is tokenized: an answer runs to 12 KB.
  const regionStart = Math.max(0, first - 200)
  const regionEnd = Math.min(text.length, first + 600)
  const words = [...text.slice(regionStart, regionEnd).matchAll(/[\p{L}\p{N}]+/gu)]
    .map((word) => Object.assign(word, { index: word.index! + regionStart }))
  // A word cut by the region's edge is not a word: drop it, unless the edge is the text's own —
  // or it is the only word there, as in a long run of CJK text or an encoded token.
  if (regionStart > 0 && words.length > 1 && words[0].index === regionStart) words.shift()
  if (regionEnd < text.length && words.length > 1 && words.at(-1)!.index! + words.at(-1)![0].length === regionEnd) words.pop()
  if (!words.length) return null
  let at = words.findIndex((word) => word.index! + word[0].length > first)
  if (at < 0) at = words.length - 1
  const from = Math.max(0, at - SNIPPET_BEFORE)
  const to = Math.min(words.length - 1, from + SNIPPET_WORDS - 1)
  const start = from === 0 && regionStart === 0 ? 0 : words[from].index!
  const end = to === words.length - 1 && regionEnd === text.length ? text.length : words[to].index! + words[to][0].length
  // One line: stored text keeps its line breaks for the preview.
  const window = text.slice(start, end).replace(/\s+/g, ' ')
  const marks: Array<[number, number]> = []
  for (const pattern of patterns) {
    pattern.lastIndex = 0
    for (const match of window.matchAll(pattern)) marks.push([match.index!, match.index! + match[0].length])
  }
  marks.sort((a, b) => a[0] - b[0])
  let out = ''
  let cursor = 0
  for (const [markStart, markEnd] of marks) {
    if (markStart < cursor) continue
    out += `${window.slice(cursor, markStart)}${MARK_OPEN}${window.slice(markStart, markEnd)}${MARK_CLOSE}`
    cursor = markEnd
  }
  out += window.slice(cursor)
  return `${start > 0 ? '…' : ''}${out.trim()}${end < text.length ? '…' : ''}`
}

export class SessionSearchStore {
  private readonly db: Database
  private readonly statements = new Map<string, Statement>()

  private constructor(db: Database) {
    this.db = db
  }

  /**
   * The index at `path`, created if missing, for its one writer: the daemon. Null on a Node without
   * `node:sqlite`. The index is derived data — every row can be rebuilt from the transcripts — so a
   * file SQLite says is not a database, or is corrupt, is deleted and started again rather than
   * leaving search broken until somebody notices. Anything else (a lock held by another process)
   * is thrown: deleting a file somebody has open loses their writes.
   */
  static open(path: string): SessionSearchStore | null {
    try {
      return SessionSearchStore.openOnce(path)
    } catch (error) {
      if (path === ':memory:' || !isCorrupt(error)) throw error
      for (const suffix of ['', '-wal', '-shm']) rmSync(`${path}${suffix}`, { force: true })
      return SessionSearchStore.openOnce(path)
    }
  }

  /**
   * The index for a reader beside the daemon (`harness search`): read-only, never migrated, never
   * deleted. `outdated` when it was written by another schema version — the daemon of that version
   * owns it and rebuilds it on its next start.
   */
  static openReader(path: string): SessionSearchStore | 'missing' | 'outdated' | 'busy' | 'unreadable' | null {
    const Constructor = builtinSqlite() as unknown as DatabaseConstructor | null
    if (!Constructor) return null
    if (!existsSync(path)) return 'missing'
    let db: Database | null = null
    try {
      db = new Constructor(path, { readOnly: true })
      db.exec('PRAGMA busy_timeout = 3000')
      const version = db.prepare("SELECT value FROM meta WHERE key = 'schema'").get()?.value
      if (version === SCHEMA_VERSION) return new SessionSearchStore(db)
      db.close()
      return 'outdated'
    } catch (error) {
      try { db?.close() } catch { /* already closed */ }
      // SQLITE_BUSY (5) and SQLITE_LOCKED (6): the daemon is writing; a moment later will do.
      const code = (error as { errcode?: number } | null)?.errcode
      if (code === 5 || code === 6) return 'busy'
      // A table missing is an index from before `meta` existed: another version's.
      if (/no such table/i.test(error instanceof Error ? error.message : String(error))) return 'outdated'
      return 'unreadable'
    }
  }

  private static openOnce(path: string): SessionSearchStore | null {
    const Constructor = builtinSqlite() as unknown as DatabaseConstructor | null
    if (!Constructor) return null
    const fresh = path !== ':memory:' && !existsSync(path)
    const db = new Constructor(path)
    if (path !== ':memory:') {
      db.exec('PRAGMA journal_mode = WAL')
      db.exec('PRAGMA synchronous = NORMAL')
    }
    db.exec('PRAGMA busy_timeout = 1000')
    const store = new SessionSearchStore(db)
    store.migrate()
    if (fresh) {
      // What people said to their agents: this user's eyes only, like the transcripts themselves.
      for (const suffix of ['', '-wal', '-shm']) {
        try { chmodSync(`${path}${suffix}`, 0o600) } catch { /* not created yet */ }
      }
    }
    return store
  }

  private migrate(): void {
    this.db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
    const version = this.db.prepare("SELECT value FROM meta WHERE key = 'schema'").get()?.value
    if (version === SCHEMA_VERSION) return
    this.db.exec(`
      DROP TABLE IF EXISTS turns_fts;
      DROP TABLE IF EXISTS turns;
      DROP TABLE IF EXISTS sessions;
      CREATE TABLE sessions (
        session_id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        engine TEXT NOT NULL,
        path TEXT NOT NULL,
        header TEXT NOT NULL,
        size INTEGER NOT NULL,
        mtime INTEGER NOT NULL,
        resume_offset INTEGER NOT NULL,
        resume_turn INTEGER NOT NULL,
        last_at INTEGER,
        turns INTEGER NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        cwd TEXT NOT NULL DEFAULT '',
        origin TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE turns (
        id INTEGER PRIMARY KEY,
        session_id TEXT NOT NULL,
        turn INTEGER NOT NULL,
        at INTEGER,
        name TEXT NOT NULL DEFAULT '',
        ask TEXT NOT NULL DEFAULT '',
        answer TEXT NOT NULL DEFAULT '',
        tools TEXT NOT NULL DEFAULT ''
      );
      CREATE UNIQUE INDEX turns_by_session ON turns (session_id, turn);
      CREATE INDEX turns_by_time ON turns (at);
      CREATE VIRTUAL TABLE turns_fts USING fts5 (
        name, ask, answer, tools,
        content = 'turns', content_rowid = 'id',
        tokenize = 'unicode61 remove_diacritics 2',
        prefix = '2 3 4'
      );
      CREATE TRIGGER turns_insert AFTER INSERT ON turns BEGIN
        INSERT INTO turns_fts (rowid, name, ask, answer, tools)
        VALUES (new.id, new.name, new.ask, new.answer, new.tools);
      END;
      CREATE TRIGGER turns_delete AFTER DELETE ON turns BEGIN
        INSERT INTO turns_fts (turns_fts, rowid, name, ask, answer, tools)
        VALUES ('delete', old.id, old.name, old.ask, old.answer, old.tools);
      END;
    `)
    this.db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema', ?)").run(SCHEMA_VERSION)
  }

  private statement(sql: string): Statement {
    let statement = this.statements.get(sql)
    if (!statement) {
      statement = this.db.prepare(sql)
      this.statements.set(sql, statement)
    }
    return statement
  }

  private transaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = work()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  /** Who each session belongs to and when it was last worked on, read once per change. */
  private meta: Map<string, SessionMeta> | null = null

  private sessionMeta(): Map<string, SessionMeta> {
    if (!this.meta) {
      this.meta = new Map(this.statement('SELECT session_id, agent_id, engine, last_at, title, cwd, origin FROM sessions').all().map((row) => [
        row.session_id as string,
        {
          agentId: row.agent_id as string, engine: row.engine as string, lastAt: (row.last_at as number | null) ?? null,
          ...(row.agent_id ? {} : { external: { title: String(row.title ?? ''), cwd: String(row.cwd ?? ''), origin: String(row.origin ?? '') } }),
        },
      ]))
    }
    return this.meta
  }

  session(sessionId: string): IndexedSession | undefined {
    const row = this.statement('SELECT * FROM sessions WHERE session_id = ?').get(sessionId)
    return row ? toSession(row) : undefined
  }

  recentConversations(from: number, to: number, limit = 300): { rows: RecentConversationTurn[]; more: boolean } {
    if (!Number.isFinite(from) || !Number.isFinite(to) || from > to) return { rows: [], more: false }
    const count = Math.min(300, Math.max(1, Math.trunc(limit)))
    const found = this.statement(`SELECT t.session_id, t.turn, t.at, t.ask, t.answer,
      s.agent_id, s.engine, s.header, s.title, s.cwd FROM turns t JOIN sessions s ON s.session_id = t.session_id
      WHERE t.turn >= 0 AND t.at BETWEEN ? AND ? AND t.ask != ''
      ORDER BY t.at DESC, t.session_id, t.turn DESC LIMIT ?`).all(from, to, count + 1)
    return { more: found.length > count, rows: found.slice(0, count).map(row => ({
      sessionId: String(row.session_id), agentId: String(row.agent_id), engine: String(row.engine),
      title: String(row.title || row.header || ''), cwd: String(row.cwd || ''),
      turn: Number(row.turn), at: Number(row.at), ask: String(row.ask), answer: String(row.answer), tools: '',
    })) }
  }

  /**
   * The rows before `beforeTurn` (the last rows, without it), newest last, as many as fit in
   * `maxChars` — never fewer than one. A preview shows them from the bottom and pages up with the
   * first row's turn. Null for a session the index does not hold.
   */
  tail(sessionId: string, options: { beforeTurn?: number; maxChars?: number } = {}): SessionTail | null {
    const session = this.session(sessionId)
    if (!session) return null
    const maxChars = Math.min(Math.max(options.maxChars ?? TAIL_CHARS, 1_000), TAIL_CHARS_MAX)
    const before = this.statement(`SELECT turn, at, ask, answer, tools FROM turns
      WHERE session_id = ? AND turn >= 0 AND turn < CAST(? AS INTEGER) ORDER BY turn DESC LIMIT ${TAIL_BATCH}`)
    const rows: TailRow[] = []
    let used = 0
    let cursor = options.beforeTurn ?? Number.MAX_SAFE_INTEGER
    let full = false
    while (!full) {
      const batch = before.all(sessionId, cursor)
      for (const row of batch) {
        const next: TailRow = {
          turn: Number(row.turn), at: row.at === null ? null : Number(row.at),
          ask: String(row.ask ?? ''), answer: String(row.answer ?? ''), tools: String(row.tools ?? ''),
        }
        const size = next.ask.length + next.answer.length + next.tools.length
        if (rows.length && used + size > maxChars) { full = true; break }
        rows.push(next)
        used += size
        cursor = next.turn
      }
      if (batch.length < TAIL_BATCH) break
    }
    rows.reverse()
    const hasMore = rows.length > 0 && !!this.statement(
      'SELECT 1 AS found FROM turns WHERE session_id = ? AND turn >= 0 AND turn < CAST(? AS INTEGER) LIMIT 1',
    ).get(sessionId, rows[0].turn)
    const tail: SessionTail = { sessionId, rows, hasMore, total: session.turns, lastAt: session.lastAt }
    if (options.beforeTurn === undefined) {
      const asked = this.statement(`SELECT turn, at, ask FROM turns
        WHERE session_id = ? AND turn >= 0 AND ask != '' ORDER BY turn DESC LIMIT 1`).get(sessionId)
      if (asked) {
        tail.lastAsk = {
          turn: Number(asked.turn), at: asked.at === null ? null : Number(asked.at),
          ask: String(asked.ask), answer: '', tools: '',
        }
      }
    }
    return tail
  }

  /** Sessions the index files under a Harness agent, earlier ones (before a `/clear`) included. */
  ownedSessionIds(): Set<string> {
    return new Set(this.statement("SELECT session_id FROM sessions WHERE agent_id != ''").all().map((row) => row.session_id as string))
  }

  sessionIds(): string[] {
    return this.statement('SELECT session_id FROM sessions').all().map((row) => row.session_id as string)
  }

  /**
   * Replaces the session's turns from `fromTurn` on with `turns` and records where the next pass
   * starts, in one transaction: a reader never sees a half-written session.
   */
  writeSession(session: IndexedSession, fromTurn: number, turns: readonly IndexedTurn[]): void {
    this.meta = null
    this.windowSessions = null
    this.transaction(() => {
      this.statement('DELETE FROM turns WHERE session_id = ? AND (turn >= ? OR turn = ?)').run(session.sessionId, fromTurn, HEADER_TURN)
      const insert = this.statement('INSERT INTO turns (session_id, turn, at, name, ask, answer, tools) VALUES (?, ?, ?, ?, ?, ?, ?)')
      insert.run(session.sessionId, HEADER_TURN, session.lastAt, session.header, '', '', '')
      for (const turn of turns) insert.run(session.sessionId, turn.turn, turn.at, '', turn.ask, turn.answer, turn.tools)
      const count = this.statement('SELECT count(*) AS n FROM turns WHERE session_id = ? AND turn >= 0').get(session.sessionId)?.n as number
      this.statement(`INSERT OR REPLACE INTO sessions
        (session_id, agent_id, engine, path, header, size, mtime, resume_offset, resume_turn, last_at, turns, title, cwd, origin)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        session.sessionId, session.agentId, session.engine, session.path, session.header, session.size,
        session.mtime, session.resumeOffset, session.resumeTurn, session.lastAt, count,
        session.title ?? '', session.cwd ?? '', session.origin ?? '',
      )
    })
  }

  removeSession(sessionId: string): void {
    this.meta = null
    this.windowSessions = null
    this.transaction(() => {
      this.statement('DELETE FROM turns WHERE session_id = ?').run(sessionId)
      this.statement('DELETE FROM sessions WHERE session_id = ?').run(sessionId)
    })
  }

  counts(): { sessions: number; turns: number } {
    const sessions = this.statement('SELECT count(*) AS n FROM sessions').get()?.n as number
    const turns = this.statement('SELECT count(*) AS n FROM turns WHERE turn >= 0').get()?.n as number
    return { sessions, turns }
  }

  /**
   * The best sessions for `query`, best first. With `from`/`to` (epoch ms), only sessions worked on
   * in that window — any turn then, not necessarily the matching one: "the dial one from last week"
   * is a session about the dial that was open last week. With a window and no words, those
   * sessions by their latest turn in it. `now` is for tests.
   */
  /** Where a query counts as matching too much to rank (tests lower it). */
  commonMatches = COMMON_MATCHES

  search(query: string, options: SearchOptions = {}): SearchHit[] {
    const terms = queryTerms(query)
    const limit = Math.max(1, Math.min(options.limit ?? 30, 100))
    const now = options.now ?? Date.now()
    const window = options.from !== undefined && options.to !== undefined && options.from <= options.to
      ? { from: options.from, to: options.to }
      : null
    if (!terms.length) return window ? this.workedOn(window, limit, now) : []
    const inWindow = window ? this.sessionsWorkedOn(window) : null
    if (inWindow && !inWindow.size) return []

    // 1. Sessions with one turn holding every word.
    const best = new Map<string, { id: number; turn: number; at: number | null; rank: number; together: boolean }>()
    // Ranked inside FTS5 first and joined after, so a word in every turn costs one sort rather than
    // a join per match; the opening-turn boost is applied to those candidates. Words in a large share
    // of all turns barely tell one turn from another, and sorting every match by BM25 is the slowest
    // thing a search can do — those take the most recent matches and let recency decide.
    const allWords = terms.join(' AND ')
    const common = this.statement('SELECT count(*) AS n FROM turns_fts WHERE turns_fts MATCH ?').get(allWords)!.n as number > this.commonMatches
    // A word in a large share of all turns barely tells one from another, and sorting every match
    // by BM25 is the slowest thing a search can do: those take the newest matching turns, unranked,
    // and let recency decide. (By turn time, not the highest rowids: a backfill writes the newest
    // sessions first.) Bounded like the ranked path, so the daemon never holds every match.
    let rows = common
      ? this.statement(`
        SELECT t.id AS id, t.session_id AS sid, t.turn AS turn, t.at AS at, -1 AS rank
        FROM turns_fts JOIN turns t ON t.id = turns_fts.rowid WHERE turns_fts MATCH ?
        ORDER BY t.at DESC LIMIT ${CANDIDATE_ROWS}`).all(allWords)
      : this.statement(`
        SELECT f.id AS id, t.session_id AS sid, t.turn AS turn, t.at AS at, f.rank AS rank
        FROM (SELECT rowid AS id, bm25(turns_fts, ${WEIGHTS.join(', ')}) AS rank FROM turns_fts
              WHERE turns_fts MATCH ? ORDER BY rank LIMIT ${CANDIDATE_ROWS}) f
        JOIN turns t ON t.id = f.id`).all(allWords)
    if (inWindow) {
      // The ranked candidates, narrowed to the window — enough unless the list was cut short and
      // the window holds few of them; then rank within the window's sessions themselves.
      const within = rows.filter((row) => inWindow.has(row.sid as string))
      rows = rows.length < CANDIDATE_ROWS || new Set(within.map((row) => row.sid)).size >= limit
        ? within
        : this.statement(`
          SELECT t.id AS id, t.session_id AS sid, t.turn AS turn, t.at AS at, bm25(turns_fts, ${WEIGHTS.join(', ')}) AS rank
          FROM turns_fts JOIN turns t ON t.id = turns_fts.rowid
          WHERE turns_fts MATCH ? AND t.session_id IN (SELECT value FROM json_each(?))
          ORDER BY rank LIMIT ${CANDIDATE_ROWS}`).all(allWords, JSON.stringify([...inWindow]))
    }
    for (const row of rows) {
      const sid = row.sid as string
      const turn = row.turn as number
      const rank = (row.rank as number) * (turn >= 0 && turn < OPENING_TURNS ? OPENING_BOOST : 1)
      const known = best.get(sid)
      if (!known || rank < known.rank) best.set(sid, { id: row.id as number, turn, at: row.at as number | null, rank, together: true })
    }

    // 2. Sessions holding every word, but in different turns. Each word's sessions, intersected.
    if (terms.length > 1 && best.size < limit) {
      const perTerm = terms.map((term) => new Set(this.statement(`
        SELECT DISTINCT t.session_id AS sid FROM turns_fts JOIN turns t ON t.id = turns_fts.rowid
        WHERE turns_fts MATCH ?`).all(term).map((row) => row.sid as string)))
      let rarestIndex = 0
      for (let index = 1; index < perTerm.length; index++) {
        if (perTerm[index].size < perTerm[rarestIndex].size) rarestIndex = index
      }
      const spread = new Set([...perTerm[rarestIndex]].filter((sid) => !best.has(sid) && perTerm.every((set) => set.has(sid)) && (!inWindow || inWindow.has(sid))))
      // Each such session's best turn for any of the words, in one ranked pass: its rank, discounted
      // for being spread, and its snippet — from what was said rather than the name, which the row
      // already shows, unless the name is the only place.
      if (spread.size) {
        const header = new Map<string, { id: number; turn: number; at: number | null; rank: number; together: boolean }>()
        for (const row of this.statement(`
          SELECT f.id AS id, t.session_id AS sid, t.turn AS turn, t.at AS at, f.rank AS rank
          FROM (SELECT rowid AS id, bm25(turns_fts, ${WEIGHTS.join(', ')}) AS rank FROM turns_fts
                WHERE turns_fts MATCH ? ORDER BY rank LIMIT ${CANDIDATE_ROWS}) f
          JOIN turns t ON t.id = f.id`).all(terms.join(' OR '))) {
          const sid = row.sid as string
          if (!spread.has(sid)) continue
          const turn = row.turn as number
          const rank = (row.rank as number) * (turn >= 0 && turn < OPENING_TURNS ? OPENING_BOOST : 1) / 2
          const into = turn === HEADER_TURN ? header : best
          const known = into.get(sid)
          if (!known || rank < known.rank) into.set(sid, { id: row.id as number, turn, at: row.at as number | null, rank, together: false })
        }
        for (const [sid, match] of header) if (!best.has(sid)) best.set(sid, match)
        // Common words can fill that ranked window with other sessions' rows. A session that has
        // every word must not vanish for it: look its best turn up directly, a bounded few at a time,
        // and rank it last among its kind.
        const missing = [...spread].filter((sid) => !best.has(sid)).slice(0, limit)
        if (missing.length) {
          // bm25 is negative and lower is better, so the weakest rank so far is the largest.
          let weakest = Number.NEGATIVE_INFINITY
          for (const match of best.values()) weakest = Math.max(weakest, match.rank)
          const worst = Number.isFinite(weakest) ? weakest : -1
          const bestTurn = this.statement(`
            SELECT t.id AS id, t.turn AS turn, t.at AS at FROM turns_fts JOIN turns t ON t.id = turns_fts.rowid
            WHERE turns_fts MATCH ? AND t.session_id = ? ORDER BY (t.turn < 0), bm25(turns_fts, ${WEIGHTS.join(', ')}) LIMIT 1`)
          for (const sid of missing) {
            const row = bestTurn.get(terms[rarestIndex], sid)
            if (row) best.set(sid, { id: row.id as number, turn: row.turn as number, at: row.at as number | null, rank: worst * 0.9, together: false })
          }
        }
      }
    }
    if (!best.size) return []

    // 3. Relevance (bm25 is negative; lower is better) relative to the best match, blended with how
    // recently the session was worked on — "the one from last week" usually means the recent one.
    const sessions = this.sessionMeta()
    let top = 0
    for (const match of best.values()) top = Math.min(top, match.rank)
    const ranked = [...best.entries()]
      .filter(([sid]) => sessions.has(sid))
      .map(([sid, match]) => {
        const session = sessions.get(sid)!
        const relevance = top < 0 ? match.rank / top : 1
        const lastAt = session.lastAt ?? match.at
        const ageDays = lastAt ? Math.max(0, now - lastAt) / 86_400_000 : 365
        const recency = Math.pow(0.5, ageDays / RECENCY_HALF_LIFE_DAYS)
        const score = (1 - RECENCY_WEIGHT) * relevance + RECENCY_WEIGHT * recency
        return { sid, match, session, score }
      })
      .sort((a, b) => Number(b.match.together) - Number(a.match.together) || b.score - a.score)
      .slice(0, limit)

    // 4. For the hits only: which field matched, and the words around it — what the person asked
    // says the most about a session, then its name, then the answer, then the tools.
    const patterns = queryWords(query).map(wordPattern)
    const text = this.statement('SELECT name, ask, answer, tools FROM turns WHERE id = CAST(? AS INTEGER)')
    return ranked.map(({ sid, match, session, score }) => {
      const row = text.get(match.id)
      let field: (typeof FIELDS)[number] = 'ask'
      let snippet = ''
      for (const candidate of ['ask', 'name', 'answer', 'tools'] as const) {
        const found = makeSnippet(String(row?.[candidate] ?? ''), patterns)
        if (found) {
          field = candidate
          snippet = found
          break
        }
      }
      return {
        sessionId: sid,
        agentId: session.agentId,
        engine: session.engine,
        turn: match.turn,
        at: match.at,
        lastAt: session.lastAt,
        field,
        snippet,
        together: match.together,
        score: Math.round(score * 1000) / 1000,
        ...externalOf(session),
      }
    })
  }

  /** The last window asked about, and its sessions: typing on, the window stays the same. */
  private windowSessions: { from: number; to: number; sessions: Set<string> } | null = null

  /** Sessions with a turn in the window; a session whose turns carry no time, by its last activity. */
  private sessionsWorkedOn(window: { from: number; to: number }): Set<string> {
    const cached = this.windowSessions
    if (cached && cached.from === window.from && cached.to === window.to) return cached.sessions
    const sessions = this.readSessionsWorkedOn(window)
    this.windowSessions = { ...window, sessions }
    return sessions
  }

  private readSessionsWorkedOn(window: { from: number; to: number }): Set<string> {
    return new Set(this.statement(`
      SELECT DISTINCT session_id AS sid FROM turns WHERE turn >= 0 AND at BETWEEN ? AND ?
      UNION SELECT session_id AS sid FROM sessions WHERE last_at BETWEEN ? AND ?
        AND NOT EXISTS (SELECT 1 FROM turns u WHERE u.session_id = sessions.session_id AND u.turn >= 0 AND u.at IS NOT NULL)`)
      .all(window.from, window.to, window.from, window.to).map((row) => row.sid as string))
  }

  /**
   * No words, only a window: the sessions worked on then, by their latest turn in it — or, for a
   * session whose turns carry no time (a database-backed engine), by its last activity. One row
   * per session.
   */
  private workedOn(window: { from: number; to: number }, limit: number, now: number): SearchHit[] {
    const sessions = this.sessionMeta()
    const latest = new Map<string, number>()
    for (const row of this.statement(`
      SELECT session_id AS sid, max(at) AS at FROM turns
      WHERE turn >= 0 AND at BETWEEN ? AND ? GROUP BY session_id`).all(window.from, window.to)) {
      latest.set(row.sid as string, row.at as number)
    }
    for (const sid of this.sessionsWorkedOn(window)) {
      if (!latest.has(sid)) latest.set(sid, sessions.get(sid)?.lastAt ?? window.to)
    }
    // The latest thing the person asked in the window, else the latest turn there: a turn an
    // agent's report opened says less about the session than what was asked.
    const timedTurn = this.statement(`
      SELECT id, turn, at, ask, answer FROM turns WHERE session_id = ? AND turn >= 0 AND at BETWEEN ? AND ?
      ORDER BY (ask = '') ASC, at DESC, turn DESC LIMIT 1`)
    const lastTurn = this.statement(`
      SELECT id, turn, at, ask, answer FROM turns WHERE session_id = ? AND turn >= 0 ORDER BY (ask = '') ASC, turn DESC LIMIT 1`)
    const hits: SearchHit[] = []
    for (const [sid, at] of [...latest].sort((a, b) => b[1] - a[1]).slice(0, limit)) {
      const session = sessions.get(sid)
      const row = timedTurn.get(sid, window.from, window.to) ?? lastTurn.get(sid)
      if (!session || !row) continue
      // What was asked; a turn opened by an agent's report has only the agent's side.
      const asked = String(row.ask ?? '')
      hits.push({
        sessionId: sid, agentId: session.agentId, engine: session.engine,
        turn: row.turn as number, at, lastAt: session.lastAt, field: asked ? 'ask' : 'answer',
        snippet: clipAsk(asked || String(row.answer ?? '')),
        together: true,
        score: Math.round(Math.pow(0.5, Math.max(0, now - at) / 86_400_000 / RECENCY_HALF_LIFE_DAYS) * 1000) / 1000,
        ...externalOf(session),
      })
    }
    return hits
  }

  close(): void {
    this.statements.clear()
    this.db.close()
  }
}

/** SQLite's SQLITE_CORRUPT (11) and SQLITE_NOTADB (26), as node:sqlite reports them. */
function isCorrupt(error: unknown): boolean {
  const code = (error as { errcode?: number } | null)?.errcode
  if (code === 11 || code === 26) return true
  return /not a database|malformed/i.test(error instanceof Error ? error.message : String(error))
}

function toSession(row: Record<string, unknown>): IndexedSession {
  return {
    sessionId: row.session_id as string,
    agentId: row.agent_id as string,
    engine: row.engine as string,
    path: row.path as string,
    header: row.header as string,
    size: row.size as number,
    mtime: row.mtime as number,
    resumeOffset: row.resume_offset as number,
    resumeTurn: row.resume_turn as number,
    lastAt: (row.last_at as number | null) ?? null,
    turns: row.turns as number,
    title: String(row.title ?? ''),
    cwd: String(row.cwd ?? ''),
    origin: String(row.origin ?? ''),
  }
}

type SessionMeta = { agentId: string; engine: string; lastAt: number | null; external?: ExternalHit }

/** The fields a hit on a session Harness did not start adds. */
function externalOf(session: SessionMeta): { external: ExternalHit } | Record<string, never> {
  // A copy: a search marks whether it is open, and the cache it came from outlives the search.
  return session.external ? { external: { ...session.external } } : {}
}
