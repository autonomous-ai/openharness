/** Fresh, complete evidence from every declared native store; no optional reader or home cache. */
import { statSync, type Stats } from 'node:fs'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { sqliteReadAll, type SqliteParam, type SqliteRow } from '../../lib/sqliteRead.js'
import { identityEntries, IdentityReadUnavailable } from './identityScan.js'
import type { StoreHomes } from './storeHomes.js'

interface Evidence { path: string; stamp: string | null }
interface Store { home: string; path: string; files: Evidence[] }
export interface StorePoolRow { home: string; row: SqliteRow }

function stamp(info: Stats): string {
  return `${info.dev}:${info.ino}:${info.mode}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`
}
function unavailable(reason: string): never { throw new IdentityReadUnavailable(reason) }
function missing(error: unknown): boolean { return (error as NodeJS.ErrnoException).code === 'ENOENT' }

/** A final bounded metadata check has no await between the last query and returning its authority. */
function verify(evidence: readonly Evidence[]): void {
  for (const item of evidence) {
    let current: string | null
    try { current = stamp(statSync(item.path)) }
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
  query: { sql: string; params: SqliteParam[]; maxRows: number; maxBuffer: number },
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
    try { info = await stat(path) }
    catch (error) {
      if (!missing(error)) unavailable('a native store path could not be inspected')
      info = null
    }
    if (info && ((kind === 'file' && !info.isFile()) || (kind === 'directory' && !info.isDirectory()))) {
      unavailable('a native store path has an unexpected file type')
    }
    evidence.push({ path, stamp: info ? stamp(info) : null })
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
  const stores: Store[] = []
  const seen = new Set<string>()
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
    if (seen.has(identity)) continue // Two home aliases for the same physical store are one claim.
    seen.add(identity)
    stores.push({ home, path, files: evidence.slice(start) })
  }
  verify(evidence)
  const found: StorePoolRow[] = []
  for (const store of stores) {
    const budget = remaining()
    verify(store.files)
    const result = await sqliteReadAll(store.path, query.sql, query.params, {
      busyTimeoutMs: Math.min(250, budget), cliTimeoutMs: budget, maxBuffer: query.maxBuffer,
    })
    if (!result.ok) unavailable('a native store query is unavailable')
    if (result.rows.length > query.maxRows) unavailable('a native store query exceeded its row limit')
    verify(store.files)
    for (const row of result.rows) found.push({ home: store.home, row })
  }
  remaining()
  // Recheck negative claims and directory membership before the selected store's metadata.
  const selected = found.length === 1 ? declared.store(found[0].home) : null
  verify(evidence.filter(item => item.path !== selected && item.path !== `${selected}-wal` && item.path !== `${selected}-journal`))
  if (selected) verify(evidence.filter(item => item.path === selected || item.path === `${selected}-wal` || item.path === `${selected}-journal`))
  return found
}
