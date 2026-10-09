/**
 * Read-only SQLite access for the engines that keep their conversation in a store instead of a
 * transcript file (opencode, kilo, hermes, devin) and for the session-repair branch that looks them up.
 *
 * Two ways in, tried in this order:
 *
 *  1. `node:sqlite` (`sqliteBuiltin.ts`, eagerly available for hook admission) — built into the Node the installers ship (22.23, see `runtime/current-node`),
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
import { closeSync, existsSync, openSync, readSync } from 'node:fs'
import { promisify } from 'node:util'
import { builtinSqlite, readBuiltin } from './sqliteBuiltin.js'

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

/** The engines that keep a conversation in a store; here, not beside the binding, for the handoff. */
export const SQLITE_BACKED_ENGINES = ['opencode', 'kilo', 'hermes', 'devin'] as const

const DEFAULT_BUSY_TIMEOUT_MS = 250
const DEFAULT_CLI_TIMEOUT_MS = 5_000
const DEFAULT_MAX_BUFFER = 32 * 1024 * 1024

/**
 * A WAL store its engine is not using right now: its header says WAL (file format versions 2) and no
 * `-wal` file is beside it. Opening one read-only would CREATE `-wal` and `-shm` in the engine's
 * folder — and a handle held open keeps the engine from tidying them away when it next closes the
 * store. Opened immutable it creates nothing, and nothing can be changing it: a writer would have
 * made the `-wal` first. A store in the older journal mode is never opened immutable, since a writer
 * may be changing it in place; it gets the ordinary locked read.
 */
export function idleWalStore(dbPath: string): boolean {
  if (existsSync(`${dbPath}-wal`)) return false
  let fd: number | null = null
  try {
    fd = openSync(dbPath, 'r')
    const header = Buffer.alloc(20)
    return readSync(fd, header, 0, 20, 0) === 20 && header[18] === 2 && header[19] === 2
  } catch {
    return false
  } finally {
    if (fd !== null) closeSync(fd)
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
      ['-json', '-cmd', '.timeout 3000', '-cmd', 'PRAGMA query_only=1', `file:${uriPath(dbPath)}?mode=ro${idleWalStore(dbPath) ? '&immutable=1' : ''}`, inlined],
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
