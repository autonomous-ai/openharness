/** The native SQLite read mechanism is eager: hook admission must not depend on a lazy code chunk.
 *  The optional Node builtin is resolved without a bundler import, and older Node keeps its CLI fallback. */
import * as fs from 'node:fs'
import * as url from 'node:url'
import type { SqliteParam, SqliteReadResult, SqliteRow } from './sqliteRead.js'

interface StatementLike { all(...params: SqliteParam[]): SqliteRow[] }
export interface DatabaseLike {
  prepare(sql: string): StatementLike
  exec(sql: string): void
  close(): void
}
export interface DatabaseConstructor { new (path: string | URL, options: { readOnly: boolean }): DatabaseLike }

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

/**
 * Run a write script statement by statement through `node:sqlite`, the way `sqlite3 -batch -bail` runs
 * it: each `SELECT` row's first column becomes one output line, and the first failure stops the script
 * and rolls back its open transaction. Windows ships no `sqlite3` CLI; the installers' Node has this.
 */
export function runSqliteScript(Database: DatabaseConstructor, path: string, statements: readonly string[]): string[] {
  const db = new Database(path, { readOnly: false })
  const out: string[] = []
  try {
    for (const statement of statements) {
      if (/^\s*SELECT\b/i.test(statement)) {
        for (const row of db.prepare(statement).all()) out.push(String(Object.values(row)[0]))
      } else {
        db.exec(statement)
      }
    }
  } catch (err) {
    try { db.exec('ROLLBACK') } catch { /* no transaction was open */ }
    throw err
  } finally {
    db.close()
  }
  return out
}

/**
 * The read itself, as CommonJS source, with one copy of the handle rules for both places it runs: this thread
 * ([readBuiltin]) and, in the core, the read threads (sqliteThread.ts), which load no module of ours: the bundle
 * carries them no file. Evaluated with `fs`, `url` and `Database` in scope, it returns `{ read, closeAll, idleWalStore }`.
 */
export const NATIVE_READER = String.raw`
const handles = new Map()
// A WAL store its engine is not using right now: its header says WAL (file format versions 2) and no -wal file is
// beside it. Opening one read-only would CREATE -wal and -shm in the engine's folder, and a handle held open keeps the
// engine from tidying them away when it next closes the store. Opened immutable it creates nothing, and nothing can be
// changing it: a writer would have made the -wal first. A store in the older journal mode is never opened immutable,
// since a writer may be changing it in place; it gets the ordinary locked read.
function idleWalStore(dbPath) {
  if (fs.existsSync(dbPath + '-wal')) return false
  let fd = null
  try {
    fd = fs.openSync(dbPath, 'r')
    const header = Buffer.alloc(20)
    return fs.readSync(fd, header, 0, 20, 0) === 20 && header[18] === 2 && header[19] === 2
  } catch {
    return false
  } finally {
    if (fd !== null) fs.closeSync(fd)
  }
}
function drop(dbPath) {
  const handle = handles.get(dbPath)
  handles.delete(dbPath)
  try { if (handle) handle.db.close() } catch { /* already gone */ }
}
// One open handle per store: the readers poll every second, and opening is the expensive part. Keyed by path but
// checked by inode: an engine that rebuilds its store (a reinstall, a rm and restart) leaves a handle on the OLD file,
// which would keep answering from a database nobody writes to any more: a poller that never sees another row.
function open(dbPath, busyTimeoutMs) {
  const { dev, ino, size, mtimeMs, ctimeMs } = fs.statSync(dbPath)
  const stamp = size + ':' + mtimeMs + ':' + ctimeMs
  // An idle store is read immutable; once its engine opens it again (a -wal appears), it is read live.
  const immutable = idleWalStore(dbPath)
  const cached = handles.get(dbPath)
  const timeout = Math.max(0, Math.trunc(busyTimeoutMs))
  // A writer can open, checkpoint, and close between polls, leaving no WAL. An immutable handle never checks for
  // writes itself, so reuse it only while the main file's fingerprint holds.
  if (cached && cached.dev === dev && cached.ino === ino && cached.immutable === immutable && (!immutable || cached.stamp === stamp)) {
    // A control lookup may have less time left than the optional reader that opened this handle.
    if (cached.busyTimeoutMs !== timeout) {
      cached.db.exec('PRAGMA busy_timeout = ' + timeout)
      cached.busyTimeoutMs = timeout
    }
    return cached.db
  }
  if (cached) drop(dbPath)
  const location = url.pathToFileURL(dbPath)
  location.search = 'immutable=1'
  const db = new Database(immutable ? location : dbPath, { readOnly: true })
  // Not a write: the pragma is per-connection state, accepted on a read-only handle.
  db.exec('PRAGMA busy_timeout = ' + timeout)
  handles.set(dbPath, { db, dev, ino, immutable, stamp, busyTimeoutMs: timeout })
  return db
}
function read(dbPath, sql, params, busyTimeoutMs) {
  try {
    return { ok: true, rows: open(dbPath, busyTimeoutMs).prepare(sql).all(...params) }
  } catch (error) {
    // Locked, mid-checkpoint, the file replaced underneath the handle, not a database at all: every one of these is
    // "try again later" for a poller, and a handle that failed is not trusted again: the next call reopens from the path.
    drop(dbPath)
    return { ok: false, error }
  }
}
function closeAll() { for (const path of [...handles.keys()]) drop(path) }
return { read, closeAll, idleWalStore }
`

interface NativeReader {
  read(dbPath: string, sql: string, params: SqliteParam[], busyTimeoutMs: number): { ok: true; rows: SqliteRow[] } | { ok: false; error: unknown }
  closeAll(): void
  idleWalStore(dbPath: string): boolean
}
const nativeReader = (Database: DatabaseConstructor | null): NativeReader =>
  new Function('fs', 'url', 'Database', NATIVE_READER)(fs, url, Database) as NativeReader

/** A reader for each constructor a test puts in place; the store's own in production. */
const readers = new Map<DatabaseConstructor, NativeReader>()
const plain = nativeReader(null)

/** Whether a store is an idle WAL store, read immutable (see [NATIVE_READER]). */
export const idleWalStore = (dbPath: string): boolean => plain.idleWalStore(dbPath)

/** Test seam, and for a store that was replaced on disk: forget every open handle. */
export function closeSqliteHandles(): void {
  for (const reader of readers.values()) reader.closeAll()
}

export function readBuiltin(
  Database: DatabaseConstructor,
  dbPath: string,
  sql: string,
  params: SqliteParam[],
  busyTimeoutMs: number,
): SqliteReadResult {
  let reader = readers.get(Database)
  if (!reader) readers.set(Database, reader = nativeReader(Database))
  const result = reader.read(dbPath, sql, params, busyTimeoutMs)
  if (result.ok) return { ok: true, rows: result.rows, via: 'builtin' }
  const error = result.error
  return { ok: false, reason: 'transient', error: error instanceof Error ? error : new Error(String(error)) }
}

/** Test seam: force the CLI path (or the built-in one) regardless of what this Node has. */
export function overrideBuiltinSqlite(value: DatabaseConstructor | null | undefined): void {
  builtin = value
}
