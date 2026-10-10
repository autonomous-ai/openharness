/**
 * Your conversations, from the session index Harness already keeps for search.
 *
 * Harness indexes every turn of every conversation on this computer — the ones it ran and the ones
 * started outside it — for `harness search` (cli/src/lib/sessionSearch). That index is the raw record
 * of how you work across agents, so this module reads it rather than parsing a dozen transcript formats
 * again. It opens the file read-only, never writes, and degrades to "no sessions" when the file or
 * `node:sqlite` is missing: the memories are useful on their own.
 *
 * The schema it relies on (sessions: session_id, engine, cwd, title, last_at, turns; turns: session_id,
 * turn, at, ask; turns_fts over name/ask/answer/tools) is checked once on open; a different schema is
 * reported, not guessed at.
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'

export const INDEX_FILE = 'session-search.db'
const DAY = 86_400_000

let sqlite
async function driver() {
  if (sqlite !== undefined) return sqlite
  try { sqlite = (await import('node:sqlite')).DatabaseSync } catch { sqlite = null }
  return sqlite
}

/** An open, read-only handle on the index, or `{ error }` saying why there is none. */
export async function openIndex(dataDir) {
  const path = join(dataDir, INDEX_FILE)
  if (!existsSync(path)) return { error: 'No session index on this computer yet. Harness builds it as you work.' }
  const DatabaseSync = await driver()
  if (!DatabaseSync) return { error: 'This Node has no built-in SQLite, so sessions cannot be read.' }
  try {
    const db = new DatabaseSync(path, { readOnly: true })
    const columns = (table) => db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name)
    const need = { sessions: ['session_id', 'engine', 'cwd', 'title', 'last_at', 'turns'], turns: ['session_id', 'turn', 'at', 'ask'] }
    for (const [table, names] of Object.entries(need)) {
      const have = columns(table)
      if (!names.every((name) => have.includes(name))) { db.close(); return { error: `The session index has a format this version cannot read (${table}).` } }
    }
    return { db, path }
  } catch (error) {
    return { error: `The session index could not be opened: ${error instanceof Error ? error.message : String(error)}` }
  }
}

const rows = (db, sql, ...args) => db.prepare(sql).all(...args).map((row) => ({ ...row }))

/** Totals per agent: sessions, your messages, and the latest one. */
export function engines(db) {
  return rows(db, `
    SELECT s.engine AS engine, COUNT(DISTINCT s.session_id) AS sessions,
           SUM(CASE WHEN t.ask != '' THEN 1 ELSE 0 END) AS asks, MAX(t.at) AS lastAt, MIN(t.at) AS firstAt
    FROM sessions s LEFT JOIN turns t ON t.session_id = s.session_id
    GROUP BY s.engine ORDER BY asks DESC, s.engine`)
}

/** Your messages per local day and agent, for the last `days` days. */
export function activity(db, { days = 371, now = Date.now() } = {}) {
  return rows(db, `
    SELECT date(t.at / 1000, 'unixepoch', 'localtime') AS day, s.engine AS engine, COUNT(*) AS asks
    FROM turns t JOIN sessions s ON s.session_id = t.session_id
    WHERE t.ask != '' AND t.at >= ?
    GROUP BY day, s.engine ORDER BY day`, now - days * DAY)
}

/** Every folder you worked in, with how much and with whom. */
export function folders(db) {
  const found = rows(db, `
    SELECT s.cwd AS cwd, s.engine AS engine, COUNT(DISTINCT s.session_id) AS sessions,
           SUM(CASE WHEN t.ask != '' THEN 1 ELSE 0 END) AS asks, MAX(t.at) AS lastAt
    FROM sessions s LEFT JOIN turns t ON t.session_id = s.session_id
    WHERE s.cwd != '' GROUP BY s.cwd, s.engine`)
  const byFolder = new Map()
  for (const row of found) {
    const entry = byFolder.get(row.cwd) ?? { cwd: row.cwd, sessions: 0, asks: 0, lastAt: 0, engines: {} }
    entry.sessions += row.sessions
    entry.asks += row.asks ?? 0
    entry.lastAt = Math.max(entry.lastAt, row.lastAt ?? 0)
    entry.engines[row.engine] = (entry.engines[row.engine] ?? 0) + (row.asks ?? 0)
    byFolder.set(row.cwd, entry)
  }
  return [...byFolder.values()].sort((a, b) => b.lastAt - a.lastAt)
}

/** Your own messages, newest first: the evidence an About You is built from. */
export function asks(db, { since = 0, engine = null, cwd = null, limit = 200, maxChars = 600 } = {}) {
  const clauses = ["t.ask != ''", 't.at >= ?']
  const args = [since]
  if (engine) { clauses.push('s.engine = ?'); args.push(engine) }
  if (cwd) { clauses.push('s.cwd = ?'); args.push(cwd) }
  args.push(Math.max(1, Math.min(5000, limit)))
  return rows(db, `
    SELECT t.at AS at, s.engine AS engine, s.cwd AS cwd, s.title AS title, s.session_id AS sessionId, t.turn AS turn,
           substr(t.ask, 1, ${Math.max(40, Math.min(4000, maxChars))}) AS text, length(t.ask) AS length
    FROM turns t JOIN sessions s ON s.session_id = t.session_id
    WHERE ${clauses.join(' AND ')} ORDER BY t.at DESC LIMIT ?`, ...args)
}

/** Words a person typed → an FTS5 query that cannot be a syntax error: each word quoted, prefix-matched. */
export function ftsQuery(text) {
  const words = String(text ?? '').toLowerCase().match(/[\p{L}\p{N}_]{2,}/gu) ?? []
  return [...new Set(words)].slice(0, 8).map((word) => `"${word}"*`).join(' ')
}

export const MARK_OPEN = '\u0002'
export const MARK_CLOSE = '\u0003'

/** Conversations that said these words, best first, one hit per conversation. */
export function search(db, text, { limit = 12, any = false } = {}) {
  const query = any ? ftsQuery(text).split(' ').filter(Boolean).join(' OR ') : ftsQuery(text)
  if (!query) return []
  let found
  try {
    // Rank first without snippets — snippet() re-tokenizes each row and is the slow part (the CLI's own
    // search avoids it for the same reason) — then build snippets only for the rows shown.
    found = rows(db, `
      SELECT turns_fts.rowid AS id, t.session_id AS sessionId, t.turn AS turn, t.at AS at, s.engine AS engine, s.title AS title, s.cwd AS cwd,
             bm25(turns_fts, 4, 2, 1, 1) AS rank
      FROM turns_fts JOIN turns t ON t.id = turns_fts.rowid JOIN sessions s ON s.session_id = t.session_id
      WHERE turns_fts MATCH ? ORDER BY rank LIMIT 200`, query)
  } catch {
    return []
  }
  const seen = new Set()
  const hits = []
  const snippetOf = db.prepare(`SELECT snippet(turns_fts, -1, '${MARK_OPEN}', '${MARK_CLOSE}', '…', 14) AS snippet FROM turns_fts WHERE turns_fts MATCH ? AND rowid = ?`)
  for (const row of found) {
    if (seen.has(row.sessionId)) continue
    seen.add(row.sessionId)
    let snippet = ''
    try { snippet = String(snippetOf.get(query, row.id)?.snippet ?? '') } catch { /* a row without a snippet still counts */ }
    const { id, ...hit } = row
    hits.push({ ...hit, snippet: snippet.replace(/\s+/g, ' ').slice(0, 400) })
    if (hits.length >= limit) break
  }
  return hits
}

/** Everything the viewer shows about your sessions, in one read. */
export function overview(db, { now = Date.now() } = {}) {
  const totals = engines(db)
  return {
    engines: totals,
    sessions: totals.reduce((sum, row) => sum + row.sessions, 0),
    asks: totals.reduce((sum, row) => sum + (row.asks ?? 0), 0),
    firstAt: totals.reduce((min, row) => (row.firstAt && (!min || row.firstAt < min) ? row.firstAt : min), null),
    activity: activity(db, { now }),
    folders: folders(db),
  }
}
