/** The native SQLite read mechanism is eager: hook admission must not depend on a lazy code chunk.
 *  The optional Node builtin is resolved without a bundler import, and older Node keeps its CLI fallback. */
import { statSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { idleWalStore, type SqliteParam, type SqliteReadResult, type SqliteRow } from './sqliteRead.js'

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

interface Handle { db: DatabaseLike; dev: number; ino: number; immutable: boolean; stamp: string; busyTimeoutMs: number }

/** One open handle per store: the readers poll every second, and opening is the expensive part. */
const handles = new Map<string, Handle>()

/**
 * The cached handle, or a fresh one. Keyed by path but checked by inode: an engine that rebuilds its
 * store (a reinstall, a `rm` and restart) leaves a handle on the OLD file, which would keep answering
 * from a database nobody writes to any more — a poller that never sees another row, with no error.
 */
function openHandle(Database: DatabaseConstructor, dbPath: string, busyTimeoutMs: number): DatabaseLike {
  const { dev, ino, size, mtimeMs, ctimeMs } = statSync(dbPath)
  const stamp = `${size}:${mtimeMs}:${ctimeMs}`
  // An idle store is read immutable; once its engine opens it again (a `-wal` appears), it is read live.
  const immutable = idleWalStore(dbPath)
  const cached = handles.get(dbPath)
  const timeout = Math.max(0, Math.trunc(busyTimeoutMs))
  // A writer can open, checkpoint, and close between polls, leaving no WAL. An immutable handle
  // never checks for writes itself, so reuse it only while the main file's fingerprint holds.
  if (cached && cached.dev === dev && cached.ino === ino && cached.immutable === immutable
    && (!immutable || cached.stamp === stamp)) {
    // A control lookup may have less time left than the optional reader that opened this handle.
    if (cached.busyTimeoutMs !== timeout) {
      cached.db.exec(`PRAGMA busy_timeout = ${timeout}`)
      cached.busyTimeoutMs = timeout
    }
    return cached.db
  }
  if (cached) dropHandle(dbPath)
  const url = pathToFileURL(dbPath)
  url.search = 'immutable=1'
  const db = new Database(immutable ? url : dbPath, { readOnly: true })
  // Not a write: the pragma is per-connection state, accepted on a read-only handle.
  db.exec(`PRAGMA busy_timeout = ${timeout}`)
  handles.set(dbPath, { db, dev, ino, immutable, stamp, busyTimeoutMs: timeout })
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

export function readBuiltin(
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

/** Test seam: force the CLI path (or the built-in one) regardless of what this Node has. */
export function overrideBuiltinSqlite(value: DatabaseConstructor | null | undefined): void {
  builtin = value
}
