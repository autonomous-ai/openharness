/**
 * Read-only SQLite access for the engines that keep their conversation in a store instead of a
 * transcript file (opencode, kilo, hermes, devin) and for the session-repair branch that looks them up.
 *
 * Two ways in, tried in this order:
 *
 *  1. `node:sqlite` — built into the Node the installers ship (22.23, see `runtime/current-node`),
 *     and into any Node ≥ 22.13 without a flag. In-process, parameterised, no JSON round-trip: the
 *     query that hung the `sqlite3` CLI for good on one machine (an opencode session with a ~7.5 MB
 *     row) finishes here in tens of milliseconds. The binding is SYNCHRONOUS — it blocks the event
 *     loop for the length of the query — so the busy timeout is kept short: a contended read returns
 *     `transient` and the caller polls again next tick, exactly as a locked CLI read did before.
 *  2. The `sqlite3` CLI — for a daemon on a Node without the binding (`engines.node >= 20`). Same
 *     invocation the readers always used, plus a hard timeout: a CLI that never answers used to hold
 *     the caller (and, at boot, the whole daemon) forever.
 *
 * Neither present ⇒ `missing`, which the readers report once and stop on, as they did for a missing CLI.
 *
 * Every store this reads is WAL (measured: opencode, kilo, hermes), so a reader never blocks the
 * engine's writer and is rarely blocked by it; `busy_timeout` only covers the checkpoint window.
 */

import { execFile } from 'node:child_process'
import { statSync } from 'node:fs'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export type SqliteRow = Record<string, unknown>
export type SqliteParam = string | number | null

export interface SqliteReadOptions {
  /** How long the built-in binding may wait on a lock. Short on purpose: it blocks the event loop. */
  busyTimeoutMs?: number
  /** Hard bound on the CLI fallback process. */
  cliTimeoutMs?: number
  /** stdout cap for the CLI fallback. */
  maxBuffer?: number
}

export type SqliteReadResult =
  | { ok: true; rows: SqliteRow[]; via: 'builtin' | 'cli' }
  /** `missing`: no way to read SQLite on this machine. `transient`: locked, mid-write, unreadable — retry. */
  | { ok: false; reason: 'missing' | 'transient'; error?: Error }

const DEFAULT_BUSY_TIMEOUT_MS = 250
const DEFAULT_CLI_TIMEOUT_MS = 5_000
const DEFAULT_MAX_BUFFER = 32 * 1024 * 1024

// ---- built-in binding ---------------------------------------------------------------------------

interface StatementLike { all(...params: SqliteParam[]): SqliteRow[] }
interface DatabaseLike {
  prepare(sql: string): StatementLike
  exec(sql: string): void
  close(): void
}
interface DatabaseConstructor { new (path: string, options: { readOnly: boolean }): DatabaseLike }

let builtin: DatabaseConstructor | null | undefined

/**
 * `node:sqlite` when this Node has it, else null. Resolved through `process.getBuiltinModule` (Node
 * ≥ 20.16 / 22.3) rather than `import()`: synchronous, and invisible to the bundler, which must not
 * try to resolve a module that only some runtimes have.
 *
 * The binding announces itself with an ExperimentalWarning on first load. That line would land in
 * `harness.log` at every daemon boot, so it is filtered — only that one warning, and every other
 * listener is kept.
 */
export function builtinSqlite(): DatabaseConstructor | null {
  if (builtin !== undefined) return builtin
  builtin = null
  const get = (process as { getBuiltinModule?: (id: string) => unknown }).getBuiltinModule
  if (typeof get !== 'function') return builtin
  const previous = process.listeners('warning')
  process.removeAllListeners('warning')
  process.on('warning', (warning) => {
    if (warning.name === 'ExperimentalWarning' && /SQLite/i.test(warning.message)) return
    for (const listener of previous) listener.call(process, warning)
  })
  try {
    const mod = get.call(process, 'node:sqlite') as { DatabaseSync?: unknown } | undefined
    if (mod && typeof mod.DatabaseSync === 'function') builtin = mod.DatabaseSync as DatabaseConstructor
  } catch {
    builtin = null
  }
  return builtin
}

interface Handle { db: DatabaseLike; dev: number; ino: number }

/** One open handle per store: the readers poll every second, and opening is the expensive part. */
const handles = new Map<string, Handle>()

/**
 * The cached handle, or a fresh one. Keyed by path but checked by inode: an engine that rebuilds its
 * store (a reinstall, a `rm` and restart) leaves a handle on the OLD file, which would keep answering
 * from a database nobody writes to any more — a poller that never sees another row, with no error.
 */
function openHandle(Database: DatabaseConstructor, dbPath: string, busyTimeoutMs: number): DatabaseLike {
  const { dev, ino } = statSync(dbPath)
  const cached = handles.get(dbPath)
  if (cached && cached.dev === dev && cached.ino === ino) return cached.db
  if (cached) dropHandle(dbPath)
  const db = new Database(dbPath, { readOnly: true })
  // Not a write: the pragma is per-connection state, accepted on a read-only handle.
  db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.trunc(busyTimeoutMs))}`)
  handles.set(dbPath, { db, dev, ino })
  return db
}

function dropHandle(dbPath: string): void {
  const handle = handles.get(dbPath)
  handles.delete(dbPath)
  try { handle?.db.close() } catch { /* already gone */ }
}

/** Test seam, and for a store that was replaced on disk: forget every open handle. */
export function closeSqliteHandles(): void {
  for (const path of [...handles.keys()]) dropHandle(path)
}

function readBuiltin(
  Database: DatabaseConstructor,
  dbPath: string,
  sql: string,
  params: SqliteParam[],
  busyTimeoutMs: number,
): SqliteReadResult {
  try {
    const db = openHandle(Database, dbPath, busyTimeoutMs)
    return { ok: true, rows: db.prepare(sql).all(...params), via: 'builtin' }
  } catch (err) {
    // Locked, mid-checkpoint, the file replaced underneath the handle, not a database at all: every one
    // of these is "try again later" for a poller, and a handle that failed is not trusted again — the
    // next call reopens from the path.
    dropHandle(dbPath)
    return { ok: false, reason: 'transient', error: err instanceof Error ? err : new Error(String(err)) }
  }
}

// ---- CLI fallback -------------------------------------------------------------------------------

/**
 * The CLI takes no bound parameters, so the values are inlined as SQL literals: strings with their
 * quotes doubled (the only escaping SQLite needs), numbers as finite decimals, null as NULL. A NUL
 * byte cannot be carried in a literal and is refused rather than truncated. A `?` inside a string
 * literal of the SQL itself (`json_extract(data, '$.a?')`) is left alone: only bare ones bind.
 */
export function inlineSqlParams(sql: string, params: SqliteParam[]): string {
  let index = 0
  const out = sql.replace(/'(?:[^']|'')*'|\?/g, (match) => {
    if (match !== '?') return match
    if (index >= params.length) throw new Error('sqlite: more placeholders than parameters')
    const value = params[index++]
    if (value === null) return 'NULL'
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw new Error('sqlite: non-finite number parameter')
      return String(value)
    }
    if (value.includes('\0')) throw new Error('sqlite: NUL byte in string parameter')
    return `'${value.replace(/'/g, "''")}'`
  })
  if (index !== params.length) throw new Error('sqlite: more parameters than placeholders')
  return out
}

/** A path as a `file:` URI body: the three characters SQLite's URI parser would otherwise read as syntax. */
function uriPath(path: string): string {
  return path.replace(/[%?#]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`)
}

async function readCli(
  dbPath: string,
  sql: string,
  params: SqliteParam[],
  timeoutMs: number,
  maxBuffer: number,
): Promise<SqliteReadResult> {
  let inlined: string
  try {
    inlined = inlineSqlParams(sql, params)
  } catch (err) {
    return { ok: false, reason: 'transient', error: err as Error }
  }
  let stdout: string
  try {
    // `.timeout` is the SILENT dot-command form — `PRAGMA busy_timeout=…` prints a row under -json and
    // would corrupt the single-array parse below. `query_only` is silent and guards against writes.
    // `mode=ro` so a path that does not exist yet is an error, not a freshly created empty store.
    ;({ stdout } = await execFileAsync(
      'sqlite3',
      ['-json', '-cmd', '.timeout 3000', '-cmd', 'PRAGMA query_only=1', `file:${uriPath(dbPath)}?mode=ro`, inlined],
      { maxBuffer, timeout: timeoutMs, killSignal: 'SIGKILL' },
    ))
  } catch (err) {
    const error = err as NodeJS.ErrnoException
    if (error?.code === 'ENOENT') return { ok: false, reason: 'missing', error }
    return { ok: false, reason: 'transient', error }
  }
  const trimmed = stdout.trim()
  if (!trimmed) return { ok: true, rows: [], via: 'cli' }
  try {
    const rows = JSON.parse(trimmed) as unknown
    return { ok: true, rows: Array.isArray(rows) ? rows as SqliteRow[] : [], via: 'cli' }
  } catch (err) {
    return { ok: false, reason: 'transient', error: err as Error }
  }
}

// ---- entry point --------------------------------------------------------------------------------

/**
 * Run one read-only statement against `dbPath` and return its rows. `?` placeholders are bound from
 * `params` in order — build the SQL as a constant and pass the values here, never paste them in.
 */
export async function sqliteReadAll(
  dbPath: string,
  sql: string,
  params: SqliteParam[] = [],
  options: SqliteReadOptions = {},
): Promise<SqliteReadResult> {
  const Database = builtinSqlite()
  if (Database) {
    return readBuiltin(Database, dbPath, sql, params, options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS)
  }
  return readCli(
    dbPath,
    sql,
    params,
    options.cliTimeoutMs ?? DEFAULT_CLI_TIMEOUT_MS,
    options.maxBuffer ?? DEFAULT_MAX_BUFFER,
  )
}

/** Test seam: force the CLI path (or the built-in one) regardless of what this Node has. */
export function overrideBuiltinSqlite(value: DatabaseConstructor | null | undefined): void {
  builtin = value
}
