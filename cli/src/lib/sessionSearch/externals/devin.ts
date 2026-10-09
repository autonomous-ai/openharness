/**
 * Devin CLI: one SQLite store, `<DEVIN_HOME>/sessions.db` (WAL; `~/.local/share/devin/cli` on macOS
 * too). `sessions` holds one row a conversation (id, `working_directory`, `title`, `created_at` and
 * `last_activity_at` in integer epoch seconds, `hidden` for compaction helpers and deleted ones);
 * `message_nodes` holds what was said, as JSON, re-persisted on every inference. Columns are read from
 * the store first: Devin migrates its schema (refinery) and versions differ. Not measured on this
 * machine (Devin is not installed): the schema is the one other readers of the store publish, and
 * the one Harness's own reader was written against (3000.2.17).
 *
 * A running Devin holds `session_locks/<id>.lock` with its pid, the one per-session ownership file
 * among the database engines. A lock outlives a crash, so it counts only while that pid is alive and
 * is Devin. `devin -r <id>` names the session a process started on in its arguments (`fromArgs`).
 */

import { open } from 'node:fs/promises'
import { join } from 'node:path'

import { DevinErrorTail } from '../../../engines/devin/errorLog.js'
import { devinMessagesToEvents } from '../../../engines/devin/normalizer.js'
import { isDevinSessionId, readDevinMessages } from '../../../engines/devin/reader.js'
import { hasSqliteReader } from '../../sqliteAvailability.js'
import type { SqliteRow } from '../../sqliteRead.js'
import { resumeSessionId } from '../../tmux.js'
import {
  LIST_LIMIT, argvSubcommand, engineProcess, ownerRecord, parseOwnerRecord, readSql, checkedSql, rowsOf, splitCounts, storeStamp,
  tableColumns, tally, type Counting, type SqlRead, type Tally,
} from './opencode.js'
import { absoluteFolder, entries, epochMs, parseLine, record, text } from './support.js'
import type { ExternalProvider, ExternalSession, OwnerClaim, ProcessView, RunningProcess, ScanContext } from './types.js'
import { externalEvidenceActive, externalReadFailed } from '../evidence.js'

export interface DevinOptions {
  home: string
  /** How a statement is run; tests replace it. */
  read?: SqlRead
  /** Whether this machine can read SQLite at all; tests replace it. */
  available?: () => boolean
}

/** An editor's agent server: never stopped from here. */
const SERVERS = new Set(['acp'])
const VALUE_FLAGS = new Set(['-p', '--prompt', '-r', '--resume', '-m', '--model'])

/**
 * One statement: the newest conversations that are neither hidden nor empty (nothing but the system
 * prompt), and how many rows each rule kept out (a row with a null id is a count).
 */
export function devinListSql(sessions: ReadonlySet<string>, nodes: ReadonlySet<string>): string | null {
  if (!sessions.has('id') || !sessions.has('working_directory')) return null
  const col = (name: string): string => (sessions.has(name) ? `s.${name}` : 'NULL')
  const said = nodes.has('session_id') && nodes.has('chat_message')
    ? 'EXISTS (SELECT 1 FROM message_nodes m WHERE m.session_id = s.id'
      + " AND CASE WHEN json_valid(m.chat_message) THEN json_extract(m.chat_message, '$.role') END <> 'system')"
    : '0'
  const skip = `CASE${sessions.has('hidden') ? " WHEN COALESCE(s.hidden, 0) <> 0 THEN 'hidden'" : ''}`
    + ` WHEN NOT ${said} THEN 'empty' ELSE '' END`
  return 'SELECT * FROM (SELECT s.id AS id, s.working_directory AS cwd, '
    + `${col('title')} AS title, ${col('last_activity_at')} AS active, ${col('created_at')} AS created, '' AS skip, NULL AS n `
    + `FROM sessions s WHERE ${skip} = '' `
    + `ORDER BY coalesce(${col('last_activity_at')}, ${col('created_at')}, 0) DESC LIMIT ${LIST_LIMIT}) `
    + `UNION ALL SELECT NULL, NULL, NULL, NULL, NULL, ${skip} AS skip, count(*) AS n FROM sessions s GROUP BY skip`
}

interface Listed { rows: SqliteRow[]; counts: Tally }

async function listSessions(read: SqlRead, dbPath: string): Promise<Listed | null> {
  const columns = await tableColumns(read, dbPath, ['sessions', 'message_nodes'])
  if (!columns) return null
  const sql = devinListSql(columns.get('sessions') ?? new Set(), columns.get('message_nodes') ?? new Set())
  if (!sql) return { rows: [], counts: {} }
  const rows = await rowsOf(read, dbPath, sql)
  return rows && splitCounts(rows)
}

/** The pid a session lock names: a bare number, or `{"pid": n}`. */
export function lockPid(content: string): number | null {
  const trimmed = content.trim()
  const value = /^\d+$/.test(trimmed) ? Number(trimmed) : record(parseLine(trimmed))?.pid
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null
}

/** How much earlier than its process's start (`ps`, whole seconds) a lock may seem to be written. */
const LOCK_SLACK_MS = 2_000

/** A lock's pid and when it was written; null when it cannot be read. */
async function readLock(path: string): Promise<{ pid: number | null; written: number } | null> {
  const handle = await open(path, 'r').catch(error => { externalReadFailed(error, 'record'); return null })
  if (!handle) return null
  try {
    const [info, content] = await Promise.all([handle.stat(), handle.readFile('utf8')])
    const pid = lockPid(content)
    if (pid === null) externalReadFailed(new Error('invalid lock PID'), 'owner record')
    return { pid, written: info.mtimeMs }
  } finally {
    await handle.close()
  }
}

/** The last thing said, the system prompt aside (row order: Devin appends the chain it just persisted). */
const TAIL_SQL = "SELECT json_extract(chat_message, '$.role') AS role, json_extract(chat_message, '$.metadata.finish_reason') AS finish,"
  + " json_extract(chat_message, '$.tool_calls') AS calls, json_extract(chat_message, '$.metadata.created_at') AS at"
  + " FROM message_nodes WHERE session_id = ? AND json_extract(chat_message, '$.role') <> 'system' ORDER BY row_id DESC LIMIT 1"

/**
 * Whether the tail says a turn runs: a person's message or a tool's result waits for the model; an
 * assistant message runs on while it stopped to call tools, or named tools no result answered yet.
 */
export function devinTurnOpen(rows: readonly SqliteRow[]): boolean | null {
  const tail = rows[0]
  if (!tail) return false
  if (tail.role === 'user' || tail.role === 'tool') return true
  if (tail.role !== 'assistant') return null
  const calls = typeof tail.calls === 'string' ? parseLine(tail.calls) : null
  return tail.finish === 'tool_calls' || (Array.isArray(calls) && calls.length > 0)
}

export function devinProvider(options: DevinOptions): ExternalProvider & Counting {
  const { home } = options
  const dbPath = join(home, 'sessions.db')
  const read = checkedSql(options.read ?? readSql)
  const available = options.available ?? hasSqliteReader
  let counts: Tally = {}
  return {
    engine: 'devin',
    lastScan: () => counts,
    async scan(ctx: ScanContext): Promise<ExternalSession[]> {
      counts = {}
      if (!available()) { externalReadFailed(new Error('SQLite unavailable'), 'conversation reader'); return [] }
      const stamp = await storeStamp(dbPath)
      if (!stamp) return []
      const listed = await ctx.memo(`devin:${dbPath}`, stamp, () => listSessions(read, dbPath))
      await ctx.pace()
      if (!listed) return []
      counts = { ...listed.counts }
      const found: ExternalSession[] = []
      for (const row of listed.rows) {
        const sessionId = text(row.id)
        const cwd = absoluteFolder(row.cwd)
        if (!isDevinSessionId(sessionId)) { tally(counts, 'badId'); continue }
        // Resumed anywhere else, Devin stops to ask which folder: only its own will do.
        if (!cwd) { tally(counts, 'noFolder'); continue }
        if (ctx.excluded(cwd)) { tally(counts, 'excluded'); continue }
        found.push({
          sessionId, engine: 'devin', cwd, origin: 'terminal', title: text(row.title).trim(),
          mtime: Math.max(epochMs(row.active) ?? 0, epochMs(row.created) ?? 0),
          transcriptPath: null,
          readHistory: async () => devinMessagesToEvents(await readDevinMessages(dbPath, sessionId)),
        })
      }
      counts.found = found.length
      return found
    },
    async owners(view: ProcessView): Promise<OwnerClaim[]> {
      const processes = await view.list()
      const byPid = new Map(processes.map((row) => [row.pid, row]))
      const isDevin = engineProcess('devin')
      const claims = new Map<string, OwnerClaim>()
      const add = (sessionId: string, row: RunningProcess, fromArgs: boolean): void => {
        const key = externalEvidenceActive() ? JSON.stringify([sessionId, row.pid, fromArgs]) : sessionId
        if (claims.has(key)) return
        claims.set(key, {
          sessionId, pid: row.pid, record: ownerRecord(dbPath, sessionId),
          ...(SERVERS.has(argvSubcommand(row.args, VALUE_FLAGS)) ? { app: true } : {}),
          ...(fromArgs ? { fromArgs: true } : {}),
        })
      }
      const locks = join(home, 'session_locks')
      for (const file of (await entries(locks)).sort((a, b) => a.name.localeCompare(b.name))) {
        if (!file.isFile() || !file.name.endsWith('.lock')) continue
        const sessionId = file.name.slice(0, -'.lock'.length)
        if (!isDevinSessionId(sessionId)) continue
        const lock = await readLock(join(locks, file.name))
        if (lock?.pid == null) continue
        // A lock outlives a crash, and its pid can be handed to anything after, another Devin among
        // them: one written before the process under its pid began was that earlier process's.
        const row = byPid.get(lock.pid)
        if (externalEvidenceActive() && !row && view.alive(lock.pid)) externalReadFailed(new Error('missing owner process'), 'owner process')
        if (!row || !view.alive(lock.pid) || !isDevin(row)) continue
        if (!Number.isFinite(row.started)) externalReadFailed(new Error('missing owner start time'), 'owner record')
        if (row.started !== undefined && lock.written < row.started - LOCK_SLACK_MS) continue
        add(sessionId, row, false)
      }
      // The id a process was started on, where no lock says more: it may have moved on since.
      for (const row of processes) {
        if (!isDevin(row)) continue
        if (view.alive(row.pid) && ![...claims.values()].some(claim => claim.pid === row.pid && !claim.fromArgs)) {
          externalReadFailed(new Error('no exact lock for a live process'), 'current owner')
        }
        const sessionId = resumeSessionId('devin', row.args)
        if (sessionId) add(sessionId, row, true)
      }
      return [...claims.values()]
    },
    async busy(owner): Promise<boolean | null> {
      const at = parseOwnerRecord(owner.record)
      if (!at) return null
      const result = await read(at.dbPath, TAIL_SQL, [at.sessionId])
      if (!result.ok) return null
      const open = devinTurnOpen(result.rows)
      if (!open) return open
      // A turn that died on a provider error writes no row: the owner's log says so after the tail.
      return new DevinErrorTail(home, at.sessionId).scanSince(text(result.rows[0].at)).length === 0
    },
  }
}
