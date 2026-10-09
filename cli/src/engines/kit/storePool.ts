/** Fresh, complete evidence from every declared native store; no optional reader or home cache. */
import { lstatSync, statSync, type Stats } from 'node:fs'
import { lstat, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { sqliteReadAll, type SqliteParam, type SqliteRow } from '../../lib/sqliteRead.js'
import { identityEntries, IdentityReadUnavailable } from './identityScan.js'
import type { StoreHomes } from './storeHomes.js'

interface Evidence { path: string; stamp: string | null; file: boolean }
interface Store { home: string; aliases: string[]; path: string; files: Evidence[] }
export interface StorePoolRow { home: string; aliases: readonly string[]; row: SqliteRow }
const MAX_POOL_BYTES = 64 * 1024 * 1024
const MAX_POOL_ROWS = 8192

function stamp(info: Stats): string {
  return `${info.dev}:${info.ino}:${info.mode}:${info.nlink}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`
}
function unavailable(reason: string): never { throw new IdentityReadUnavailable(reason) }
function missing(error: unknown): boolean { return (error as NodeJS.ErrnoException).code === 'ENOENT' }

/** A final bounded metadata check has no await between the last query and returning its authority. */
function verify(evidence: readonly Evidence[]): void {
  for (const item of evidence) {
    let current: string | null
    try { current = stamp(item.file ? lstatSync(item.path) : statSync(item.path)) }
    catch (error) {
      if (!missing(error)) unavailable('a native store could not be verified')
      current = null
    }
    if (current !== item.stamp) unavailable('the native store pool changed during lookup')
  }
}

/**
 * Missing stores count as evidence too: a profile's first DB may appear while another DB is read.
 * Directory stamps fence added/removed profiles; DB, WAL and rollback-journal stamps fence changed
 * query results and atomic replacement. Work is bounded, not an atomic multi-file snapshot. Any
 * observed change holds this poll, and the next poll starts from a new pool.
 */
export async function readStorePool(
  declared: StoreHomes,
  defaultHome: string,
  query: { sql: string; params: SqliteParam[]; maxRows: number; maxBuffer: number;
    columns: readonly string[]; pointKey?: string; knownHome?: string },
): Promise<StorePoolRow[]> {
  const deadline = performance.now() + 2_000
  const remaining = (): number => {
    const ms = Math.floor(deadline - performance.now())
    if (ms <= 0) unavailable('the native store lookup deadline was reached')
    return ms
  }
  const evidence: Evidence[] = []
  const inspect = async (path: string, kind: 'file' | 'directory' | 'entry'): Promise<Stats | null> => {
    remaining()
    let info: Stats | null
    try { info = kind === 'file' ? await lstat(path) : await stat(path) }
    catch (error) {
      if (!missing(error)) unavailable('a native store path could not be inspected')
      info = null
    }
    if (info && ((kind === 'file' && !info.isFile()) || (kind === 'directory' && !info.isDirectory()))) {
      unavailable('a native store path has an unexpected file type')
    }
    // SQLite resolves file symlinks and names journals beside the target; hard links may have a
    // journal beside another name. Neither can prove complete WAL evidence from this path.
    if (info && kind === 'file' && info.nlink !== 1) unavailable('a native store has multiple file links')
    evidence.push({ path, stamp: info ? stamp(info) : null, file: kind === 'file' })
    return info
  }
  await inspect(defaultHome, 'directory')
  const profiles = join(defaultHome, declared.profiles)
  await inspect(profiles, 'directory')
  const homes = [defaultHome]
  const entries = []
  for await (const entry of identityEntries(profiles, { remaining: declared.max + 1 })) entries.push(entry)
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const home = join(profiles, entry.name)
    const info = await inspect(home, 'entry')
    if (!info) unavailable('a profile disappeared during lookup')
    if (info.isDirectory()) homes.push(home)
  }
  if (query.knownHome && !homes.includes(query.knownHome)) {
    await inspect(query.knownHome, 'directory')
    homes.push(query.knownHome)
  }
  const stores: Store[] = []
  const seen = new Map<string, Store>()
  let bytes = 0
  for (const home of homes) {
    const path = declared.store(home)
    const start = evidence.length
    const main = await inspect(path, 'file')
    const wal = await inspect(`${path}-wal`, 'file')
    const journal = await inspect(`${path}-journal`, 'file')
    if (!main) {
      if (wal || journal) unavailable('a native store is missing beside its journal')
      continue
    }
    const identity = [main, wal, journal].map(info => info ? `${info.dev}:${info.ino}` : '-').join('/')
    const alias = seen.get(identity)
    if (alias) { alias.aliases.push(home); continue }
    bytes += main.size + (wal?.size ?? 0) + (journal?.size ?? 0)
    if (bytes > MAX_POOL_BYTES) unavailable('the native store pool exceeds the 64 MiB read limit')
    const store = { home, aliases: [home], path, files: evidence.slice(start) }
    seen.set(identity, store)
    stores.push(store)
  }
  verify(evidence)
  const found: StorePoolRow[] = []
  for (const store of stores) {
    const read = async (sql: string, params: SqliteParam[], maxBuffer: number): Promise<SqliteRow[]> => {
      const budget = remaining()
      verify(store.files)
      const result = await sqliteReadAll(store.path, sql, params, {
        busyTimeoutMs: Math.min(250, budget), cliTimeoutMs: budget, maxBuffer,
      })
      if (!result.ok) unavailable('a native store query is unavailable')
      verify(store.files)
      return result.rows
    }
    // A view, virtual table or generated control column can execute unrelated, unbounded work.
    // Repair scans a bounded prefix of this ordinary table, with no full-table sort. Point reads
    // require the declared key to lead the primary index. The shared file cap bounds page input.
    const schema = await read('SELECT type, substr(sql, 1, 16385) AS sql FROM sqlite_schema WHERE name = ? LIMIT 2', ['sessions'], 20_000)
    if (schema.length !== 1 || schema[0].type !== 'table' || typeof schema[0].sql !== 'string'
      || schema[0].sql.length > 16384 || !/^CREATE\s+TABLE\s/i.test(schema[0].sql)) unavailable('the native session table schema is unavailable')
    const columns = await read('SELECT name, hidden, pk FROM pragma_table_xinfo(?) LIMIT 257', ['sessions'], 32_768)
    if (columns.length > 256 || query.columns.some(name => !columns.some(column => column.name === name && column.hidden === 0))
      || (query.pointKey && !columns.some(column => column.name === query.pointKey && column.pk === 1))) {
      unavailable('the native session table has unsupported control columns')
    }
    const result = { rows: await read(query.sql, query.params, query.maxBuffer) }
    if (result.rows.length > query.maxRows) unavailable('a native store query exceeded its row limit')
    if (found.length + result.rows.length > MAX_POOL_ROWS) unavailable('the native store pool exceeded its row limit')
    for (const row of result.rows) found.push({ home: store.home, aliases: store.aliases, row })
  }
  remaining()
  // Recheck negative claims and directory membership before the selected store's metadata.
  const selected = found.length === 1 ? declared.store(found[0].home) : null
  verify(evidence.filter(item => item.path !== selected && item.path !== `${selected}-wal` && item.path !== `${selected}-journal`))
  if (selected) verify(evidence.filter(item => item.path === selected || item.path === `${selected}-wal` || item.path === `${selected}-journal`))
  return found
}
