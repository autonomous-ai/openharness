/**
 * OpenCode and Kilo (an OpenCode fork): one SQLite store each, `opencode.db` and `kilo.db`, with the
 * same `session` / `message` / `part` tables (measured: opencode 1.18.31, kilo 7.4.20). One list query
 * per store, run again only when the store's files changed.
 *
 * Who started a session is in its row: a sub-agent's has a `parent_id`, an archived one a
 * `time_archived`, and a headless `opencode run` writes a permission list that denies `question`
 * (measured in the 1.18.32 binary; the TUI leaves it NULL). A session with no message was never used.
 * Times are epoch milliseconds.
 *
 * Neither engine leaves a per-session lock or pid file: the only owner evidence is the id in a
 * process's arguments (`-s/--session`, never with `--fork`, which writes a NEW session), and it names
 * the session the process started on, not necessarily the one it has now (`fromArgs`). Whether it is
 * mid-turn is read from the last message.
 *
 * The helpers below the provider are shared with `hermes.ts` and `devin.ts`: the other two stores
 * are read the same way.
 */

import { basename } from 'node:path'

import { kiloMessagesToEvents, isPermissionRejection } from '../../../engines/kilo/normalizer.js'
import { readKiloMessages } from '../../../engines/kilo/reader.js'
import { opencodeMessagesToEvents } from '../../../engines/opencode/normalizer.js'
import { readOpencodeMessages } from '../../../engines/opencode/reader.js'
import { agentCommandOwnershipSnapshot } from '../../engineBin.js'
import { hasSqliteReader } from '../../sqliteAvailability.js'
import { sqliteReadAll, type SqliteParam, type SqliteReadResult, type SqliteRow } from '../../sqliteRead.js'
import { argvTokens, engineProcessMatch, resumeSessionId } from '../../tmux.js'
import { absoluteFolder, epochMs, fileStamp, text } from './support.js'
import type { ExternalEngine, ExternalProvider, ExternalSession, OwnerClaim, ProcessView, RunningProcess, ScanContext } from './types.js'

export interface OpencodeOptions {
  engine: 'opencode' | 'kilo'
  dbPath: string
  /** How a statement is run; tests replace it. */
  read?: SqlRead
  /** Whether this machine can read SQLite at all; tests replace it. */
  available?: () => boolean
}

/** The newest sessions a scan lists: a person looks for a recent conversation, not the thousandth. */
export const LIST_LIMIT = 500

/** OpenCode's ids: `ses_` and 26 base62 characters (kilo's too). What `--session` takes. */
const SESSION_ID = /^ses_[A-Za-z0-9]{1,64}$/

/** The title OpenCode gives a session until it names it (the regex is OpenCode's own, 1.18.32). */
const PLACEHOLDER_TITLE = /^(New session - |Child session - )\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

/** A headless `run` (and the GitHub agent) denies the `question` tool: nobody is there to answer. */
const HEADLESS = "EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(s.permission) THEN s.permission ELSE '[]' END) r"
  + " WHERE CASE WHEN r.type = 'object' THEN json_extract(r.value, '$.permission') END = 'question'"
  + " AND CASE WHEN r.type = 'object' THEN json_extract(r.value, '$.action') END = 'deny')"

/** Subcommands that serve other clients (an editor, the desktop app, a browser): never stopped from here. */
const SERVERS = new Set(['serve', 'web', 'acp', 'daemon'])
const VALUE_FLAGS = new Set(['-s', '--session', '-m', '--model', '--agent', '--prompt', '--port', '--hostname', '--log-level'])

interface Listed { rows: SqliteRow[]; counts: Tally }

/**
 * One statement: the newest sessions a person can resume, and how many rows each rule kept out (a
 * row with a null id is a count). Columns come from the store's own schema, since versions differ.
 */
export function opencodeListSql(session: ReadonlySet<string>, message: ReadonlySet<string>): string | null {
  if (!session.has('id') || !session.has('directory') || !session.has('time_updated')) return null
  const lastMessage = message.has('session_id') && message.has('time_created')
    ? '(SELECT max(m.time_created) FROM message m WHERE m.session_id = s.id)'
    : 'NULL'
  const skip = `CASE${session.has('parent_id') ? " WHEN s.parent_id IS NOT NULL THEN 'child'" : ''}`
    + `${session.has('time_archived') ? " WHEN s.time_archived IS NOT NULL THEN 'archived'" : ''}`
    + `${session.has('permission') ? ` WHEN ${HEADLESS} THEN 'headless'` : ''}`
    + ` WHEN ${lastMessage} IS NULL THEN 'empty' ELSE '' END`
  const title = session.has('title') ? 's.title' : "''"
  return 'SELECT * FROM (SELECT s.id AS id, s.directory AS directory, '
    + `${title} AS title, s.time_updated AS updated, ${lastMessage} AS last_msg, '' AS skip, NULL AS n `
    + `FROM session s WHERE ${skip} = '' `
    + `ORDER BY max(coalesce(s.time_updated, 0), coalesce(${lastMessage}, 0)) DESC LIMIT ${LIST_LIMIT}) `
    + `UNION ALL SELECT NULL, NULL, NULL, NULL, NULL, ${skip} AS skip, count(*) AS n FROM session s GROUP BY skip`
}

async function listSessions(read: SqlRead, dbPath: string): Promise<Listed | null> {
  const columns = await tableColumns(read, dbPath, ['session', 'message'])
  if (!columns) return null
  const sql = opencodeListSql(columns.get('session') ?? new Set(), columns.get('message') ?? new Set())
  if (!sql) return { rows: [], counts: {} }
  const rows = await rowsOf(read, dbPath, sql)
  return rows && splitCounts(rows)
}

/**
 * The tail says whether a turn runs: a user message waits for its answer; an assistant one is done
 * when it completed with no tool still pending and did not stop to call tools. A `!cmd` shell run
 * leaves an assistant message with no `finish` and a completed tool: done. A refused permission
 * (kilo's measured shape, and OpenCode's by inheritance) or an error (an abort) ends the turn too.
 */
const TAIL_SQL = "SELECT json_extract(m.data, '$.role') AS role, json_extract(m.data, '$.finish') AS finish,"
  + " json_extract(m.data, '$.time.completed') AS completed, json_type(m.data, '$.error') AS failed,"
  + " json_extract(p.data, '$.type') AS part, json_extract(p.data, '$.state.status') AS status,"
  + " json_extract(p.data, '$.state.error') AS part_error"
  + ' FROM (SELECT id, data FROM message WHERE session_id = ? ORDER BY time_created DESC, id DESC LIMIT 1) m'
  + ' LEFT JOIN part p ON p.message_id = m.id'

export function opencodeTurnOpen(rows: readonly SqliteRow[]): boolean | null {
  const head = rows[0]
  if (!head) return false
  if (head.role === 'user') return true
  if (head.role !== 'assistant') return null
  const parts = rows.filter((row) => row.part !== null && row.part !== undefined)
  const rejected = parts.some((row) => isPermissionRejection({
    id: '', type: text(row.part), data: { state: { status: row.status, error: row.part_error } },
  }))
  // `json_type` names a present key's type, 'null' for a JSON null.
  const failed = typeof head.failed === 'string' && head.failed !== 'null'
  if (rejected || failed) return false
  if (!head.completed) return true
  if (parts.some((row) => row.part === 'tool' && (row.status === 'pending' || row.status === 'running'))) return true
  return head.finish === 'tool-calls'
}

export function opencodeProvider(options: OpencodeOptions): ExternalProvider & Counting {
  const { engine, dbPath } = options
  const read = options.read ?? readSql
  const available = options.available ?? hasSqliteReader
  let counts: Tally = {}
  const history = (sessionId: string) => engine === 'kilo'
    ? async () => kiloMessagesToEvents(await readKiloMessages(dbPath, sessionId))
    : async () => opencodeMessagesToEvents(await readOpencodeMessages(dbPath, sessionId))
  return {
    engine,
    lastScan: () => counts,
    async scan(ctx: ScanContext): Promise<ExternalSession[]> {
      counts = {}
      if (!available()) return []
      const stamp = await storeStamp(dbPath)
      if (!stamp) return []
      const listed = await ctx.memo(`${engine}:${dbPath}`, stamp, () => listSessions(read, dbPath))
      await ctx.pace()
      if (!listed) return []
      counts = { ...listed.counts }
      const found: ExternalSession[] = []
      for (const row of listed.rows) {
        const sessionId = text(row.id)
        const cwd = absoluteFolder(row.directory)
        if (!SESSION_ID.test(sessionId)) { tally(counts, 'badId'); continue }
        // A session with no folder cannot be resumed: there is nowhere to run it.
        if (!cwd) { tally(counts, 'noFolder'); continue }
        if (ctx.excluded(cwd)) { tally(counts, 'excluded'); continue }
        const title = text(row.title).trim()
        found.push({
          sessionId, engine, cwd, origin: 'terminal',
          title: PLACEHOLDER_TITLE.test(title) ? '' : title,
          // `time_updated` can lag the messages by an hour (measured): the later of the two.
          mtime: Math.max(epochMs(row.updated) ?? 0, epochMs(row.last_msg) ?? 0),
          transcriptPath: null,
          readHistory: history(sessionId),
        })
      }
      counts.found = found.length
      return found
    },
    async owners(view: ProcessView): Promise<OwnerClaim[]> {
      const processes = await view.list()
      const isEngine = engineProcess(engine)
      const claims: OwnerClaim[] = []
      for (const row of processes) {
        if (!isEngine(row)) continue
        const sessionId = resumeSessionId(engine, row.args)
        if (!sessionId) continue
        // The session it was started on: the TUI may have switched to another since.
        claims.push({
          sessionId, pid: row.pid, record: ownerRecord(dbPath, sessionId), fromArgs: true,
          ...(SERVERS.has(argvSubcommand(row.args, VALUE_FLAGS)) ? { app: true } : {}),
        })
      }
      return claims
    },
    async busy(owner): Promise<boolean | null> {
      const at = parseOwnerRecord(owner.record)
      if (!at) return null
      const result = await read(at.dbPath, TAIL_SQL, [at.sessionId])
      return result.ok ? opencodeTurnOpen(result.rows) : null
    },
  }
}

// ---- shared with hermes.ts and devin.ts ---------------------------------------------------------

/** How a provider runs one read-only statement against a store. Tests replace it. */
export type SqlRead = (dbPath: string, sql: string, params?: SqliteParam[]) => Promise<SqliteReadResult>

export const readSql: SqlRead = (dbPath, sql, params = []) => sqliteReadAll(dbPath, sql, params)

/** How many rows each rule kept out of a scan, and how many it found. */
export type Tally = Record<string, number>

export interface Counting {
  /** What the last scan counted, by reason: for a person asking why a conversation is missing. */
  lastScan(): Readonly<Tally>
}

export function tally(counts: Tally, reason: string, n = 1): void {
  counts[reason] = (counts[reason] ?? 0) + n
}

/**
 * A statement's rows; null when this machine has no way to read SQLite. A store that is locked,
 * mid-migration or not a database throws, so the caller keeps what it found last time.
 */
export async function rowsOf(read: SqlRead, dbPath: string, sql: string, params: SqliteParam[] = []): Promise<SqliteRow[] | null> {
  const result = await read(dbPath, sql, params)
  if (result.ok) return result.rows
  if (result.reason === 'missing') return null
  throw new Error(`${basename(dbPath)} not readable: ${result.error?.message ?? 'locked'}`)
}

/** The columns each table has, read from the store: engines migrate their schemas, and versions share one. */
export async function tableColumns(read: SqlRead, dbPath: string, tables: readonly string[]): Promise<Map<string, Set<string>> | null> {
  const sql = tables.map((table) => `SELECT '${table}' AS t, name FROM pragma_table_info('${table}')`).join(' UNION ALL ')
  const rows = await rowsOf(read, dbPath, sql)
  if (!rows) return null
  const columns = new Map<string, Set<string>>()
  for (const row of rows) {
    const table = text(row.t)
    const set = columns.get(table) ?? new Set<string>()
    set.add(text(row.name))
    columns.set(table, set)
  }
  return columns
}

/** A list statement's rows, with the counts (the rows whose id is null) taken out. */
export function splitCounts(rows: readonly SqliteRow[]): { rows: SqliteRow[]; counts: Tally } {
  const counts: Tally = {}
  const listed: SqliteRow[] = []
  for (const row of rows) {
    if (row.id !== null && row.id !== undefined) { listed.push(row); continue }
    const reason = text(row.skip)
    if (reason) tally(counts, reason, Number(row.n) || 0)
    // The rows every rule kept, of which only the newest are listed.
    else if (Number(row.n) > LIST_LIMIT) tally(counts, 'older', Number(row.n) - LIST_LIMIT)
  }
  return { rows: listed, counts }
}

/**
 * A store's fingerprint: the database and its write-ahead log, each by size and time. A commit moves
 * one of them. Null when there is no database.
 */
export async function storeStamp(dbPath: string): Promise<string | null> {
  const db = await fileStamp(dbPath)
  if (!db) return null
  const wal = await fileStamp(`${dbPath}-wal`)
  return `${db.stamp}|${wal?.stamp ?? '-'}`
}

/** What a claim carries for busy(): the store and the session, `<db>#<id>`. */
export function ownerRecord(dbPath: string, sessionId: string): string {
  return `${dbPath}#${sessionId}`
}

export function parseOwnerRecord(record: string): { dbPath: string; sessionId: string } | null {
  const hash = record.lastIndexOf('#')
  if (hash <= 0 || hash === record.length - 1) return null
  return { dbPath: record.slice(0, hash), sessionId: record.slice(hash + 1) }
}

/**
 * The engine's subcommand: its first positional argument. The interpreter's script path before it
 * (`node …/opencode serve`, `python …/hermes gateway`) is skipped, as are flags and their values; a
 * subcommand never contains a slash.
 */
export function argvSubcommand(args: string, valueFlags: ReadonlySet<string>): string {
  const tokens = argvTokens(args)
  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i]
    if (token === '--') return ''
    if (valueFlags.has(token)) { i++; continue }
    if (token.startsWith('-') || token.includes('/')) continue
    return token
  }
  return ''
}

/** [pid]'s process and up to [depth] of its ancestors, nearest first. */
export function ancestry(processes: ReadonlyMap<number, RunningProcess>, pid: number, depth: number): RunningProcess[] {
  const chain: RunningProcess[] = []
  let row = processes.get(pid)
  while (row && chain.length <= depth && !chain.includes(row)) {
    chain.push(row)
    row = processes.get(row.ppid)
  }
  return chain
}

/** Whether [row] is [engine]'s process, by its executable or package entrypoint, never by a word in its arguments. */
export function engineProcess(engine: ExternalEngine, ownership = agentCommandOwnershipSnapshot()): (row: RunningProcess) => boolean {
  return (row) => engineProcessMatch(row, engine, ownership).score > 0
}
