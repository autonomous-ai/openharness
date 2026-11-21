/** The existing version-1 database checkpoint, streamed into a core-owned stage. */
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { nativeFileKey } from '../kit/nativePaths.js'
import { observeNativeFile } from '../kit/nativeFileObservation.js'
import { readStorePage, utf8Bytes, type PageColumn } from '../../lib/sqlitePage.js'
import { sqliteReadAll, type SqliteParam, type SqliteRow } from '../../lib/sqliteRead.js'
import { closeSqliteHandle } from '../../lib/sqliteBuiltin.js'
import { offThreadSqliteActive } from '../../lib/sqliteThread.js'
import { OPENCLAW_COLUMNS } from '../openclaw/contract.js'
import { STORAGE_CHUNK_BYTES, STORAGE_STAGE_BYTES, type ExportSource, type ExportStage, type ExportReceipt, type StorageEngine, type StorageSession } from '../worker/storageProtocol.js'

/** A column of the paged table `t`, by its name. */
const column = (name: string): PageColumn => ({ as: name, sql: `t."${name.replace(/"/g, '""')}"` })

/** How a conversation table is read: every column, or these, with their size. */
type Paged = true | { columns: PageColumn[]; size: string }
class UnwrittenOpenclawHistory extends Error {}

/**
 * A conversation table's rows of this session, read in pages bounded by bytes (#4188): read whole against the 32 MiB
 * reply limit, a longer conversation could not be checkpointed, so its session could not be closed. A page follows the
 * table's primary key (its rowid when it declares none), so a row added between pages is still read. Each row holds
 * exactly the selected columns, in their order. Throws when a page is not answered or a row is over the row cap: a
 * checkpoint holds every row or none.
 */
async function* pagedRows(database: string, table: string, where: string, sessionId: string, paged: Paged, fresh: boolean): AsyncGenerator<SqliteRow> {
  const declared = await sqliteReadAll(database, 'SELECT name, pk FROM pragma_table_xinfo(?) WHERE hidden <> 1 ORDER BY cid', [table], { fresh })
  if (!declared.ok || !declared.rows.length) throw new Error('checkpoint schema unavailable')
  const pk = declared.rows.filter((row) => Number(row.pk) > 0).sort((a, b) => Number(a.pk) - Number(b.pk)).map((row) => String(row.name))
  const selected = paged === true ? declared.rows.map((row) => column(String(row.name))) : paged.columns
  const page = { table, where, params: [sessionId],
    key: pk.length ? pk.map(column) : [{ as: 'rowid', sql: 't.rowid' }],
    columns: selected.filter((c) => !pk.includes(c.as)), ...(paged !== true && { size: paged.size }) }
  for (let cursor: SqliteParam[] | null = null;;) {
    const read = await readStorePage(database, page, cursor, { fresh })
    if (!read.ok || read.rows.some(row => Number(row.page_big))) throw new Error('checkpoint rows unavailable')
    for (const row of read.rows) yield Object.fromEntries(selected.map(c => [c.as, row[c.as]]))
    if (!read.full) return
    if (!read.last || JSON.stringify(read.last) === JSON.stringify(cursor)) throw new Error('checkpoint cursor did not advance')
    cursor = read.last
  }
}

/** Native SQLite files can have live WAL writers. Export this conversation's rows through a
 * read-only connection; never copy an incomplete .db or replace an engine's shared store. */
async function* databaseHistory(s: StorageSession & { engine: StorageEngine }, source: ExportSource, fresh: boolean): AsyncGenerator<string> {
  const database = source.path
  const read = (sql: string, params?: SqliteParam[]) => sqliteReadAll(database, sql, params, { fresh })
  /** Table and filter; a conversation table is paged, the others hold one row. */
  let selections: [string, string, Paged?][]
  switch (s.engine) {
    case 'opencode': case 'kilo':
      selections = [['session', 'id = ?'], ['message', 'session_id = ?', true],
        ['part', 'message_id IN (SELECT id FROM message WHERE session_id = ?)', true]]
      break
    case 'hermes':
      selections = [['sessions', 'id = ?'], ['messages', 'session_id = ?', true]]
      break
    case 'devin':
      selections = [['sessions', 'id = ?'], ['message_nodes', 'session_id = ?', true]]
      break
    case 'openclaw': {
      // Every window the key has had, with each row as the reader reads it. A compressed row is kept as hex: JSON has
      // no bytes. It is sized as twice its blob: sizing the hex itself would read every blob.
      const events = OPENCLAW_COLUMNS.transcript_events
      const columns = events.map((name) => name === 'event_zstd' ? { as: 'event_zstd_hex', sql: 'hex(t.event_zstd)' } : column(name))
      const size = events.map((name) => name === 'event_zstd' ? '2 * coalesce(length(t.event_zstd), 0)' : `coalesce(${utf8Bytes(column(name).sql)}, 0)`).join(' + ')
      selections = [['session_nodes', 'session_key = ?'], ['session_windows', 'session_key = ?'],
        ['transcript_events', 'session_id IN (SELECT session_id FROM session_windows WHERE session_key = ?)', { columns, size }]]
      break
    }
    default: throw new Error('This engine has no supported history checkpoint yet. The session is still open.')
  }
  // OpenCode 2 keeps a conversation in `session_v2` and `session_message`; the v1 tables stay in the same file with
  // only older conversations, so a v2 one read there was "not found" and could never be closed (2026-10-14). Read the
  // v2 tables when they hold this session, as purgeAgentService does.
  if (s.engine === 'opencode') {
    const v2 = await read("SELECT name FROM sqlite_master WHERE type='table' AND name='session_v2';")
    const held = v2.ok && v2.rows.length ? await read('SELECT id FROM session_v2 WHERE id = ?;', [s.sessionId]) : null
    if (!v2.ok || (held && !held.ok)) throw new Error('Could not read the saved conversation. The session has not been closed.')
    if (held?.rows.length) selections = [['session_v2', 'id = ?'], ['session_message', 'session_id = ?', true]]
  }
  yield JSON.stringify({ version: 1, sessionId: s.sessionId, engine: s.engine, database: source.database }).slice(0, -1) + ',"tables":{'
  let firstTable = true
  for (const [table, where, paged] of selections) {
    yield (firstTable ? '' : ',') + JSON.stringify(table) + ':['
    firstTable = false
    let firstRow = true
    const rows = paged ? pagedRows(database, table, where, s.sessionId, paged, fresh)
      : await read(`SELECT * FROM ${table} WHERE ${where};`, [s.sessionId]).then(async result => {
        if (s.engine === 'openclaw' && table === selections[0][0] && result.ok && result.rows.length === 0) {
          const windows = await read('SELECT 1 FROM session_windows WHERE session_key = ? LIMIT 1', [s.sessionId])
          // Selected events are joined through these windows; without any window none can belong to this key.
          if (!windows.ok || windows.rows.length) throw new Error('checkpoint history is inconsistent')
          throw new UnwrittenOpenclawHistory()
        }
        if (!result.ok || (table === selections[0][0] && result.rows.length !== 1)) throw new Error('checkpoint row unavailable')
        return result.rows
      })
    for await (const row of rows) {
      if (!firstRow) yield ','
      yield* rowJson(row)
      firstRow = false
    }
    yield ']'
  }
  yield '}}'
}

/** Preserve JSON.stringify's bytes without materializing a control-character-heavy row's escaped copy. */
function* stringJson(value: string): Generator<string> {
  yield '"'
  for (let at = 0; at < value.length;) {
    let end = Math.min(value.length, at + 16_384)
    const last = value.charCodeAt(end - 1), next = value.charCodeAt(end)
    if (end < value.length && last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end--
    yield JSON.stringify(value.slice(at, end)).slice(1, -1)
    at = end
  }
  yield '"'
}
function* rowJson(row: SqliteRow): Generator<string> {
  yield '{'
  let first = true
  for (const key of Object.keys(row)) {
    if (!first) yield ','
    first = false
    yield JSON.stringify(key) + ':'
    const value = row[key]
    if (typeof value === 'string') yield* stringJson(value)
    else if (value instanceof Uint8Array) {
      const buffer = Buffer.isBuffer(value)
      yield buffer ? '{"type":"Buffer","data":[' : '{'
      for (let at = 0; at < value.length; at += 4_096) {
        const parts: string[] = []
        for (let i = at; i < Math.min(at + 4_096, value.length); i++) parts.push(buffer ? String(value[i]) : `"${i}":${value[i]}`)
        yield (at ? ',' : '') + parts.join(',')
      }
      yield buffer ? ']}' : '}'
    } else if (value === null || typeof value === 'number') yield JSON.stringify(value)
    else throw new Error('unsupported checkpoint value')
  }
  yield '}'
}

/** The supplied inode is the only write target; output is bounded before each write. */
export async function exportDatabase(engine: StorageEngine, session: StorageSession, stage: ExportStage, source: ExportSource, current: () => boolean = () => true): Promise<ExportReceipt> {
  const input = observeNativeFile(source.path)
  if (input.path !== source.path || input.key !== source.key) throw new Error('checkpoint source refused')
  const output = await open(stage.path, constants.O_WRONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  let bytes = 0, used = 0
  const buffer = Buffer.alloc(STORAGE_CHUNK_BYTES)
  const hash = createHash('sha256')
  const flush = async () => {
    hash.update(buffer.subarray(0, used))
    for (let offset = 0; offset < used;) {
      if (!current()) throw new Error('checkpoint cancelled')
      const { bytesWritten } = await output.write(buffer, offset, used - offset, bytes)
      if (!bytesWritten) throw new Error('checkpoint write made no progress')
      offset += bytesWritten; bytes += bytesWritten
    }
    used = 0
  }
  try {
    const before = await output.stat({ bigint: true })
    if (!current() || !before.isFile() || before.nlink !== 1n || before.size !== 0n || (process.platform !== 'win32' && (before.mode & 0o777n) !== 0o600n)
      || nativeFileKey(before) !== stage.key || (process.getuid && before.uid !== BigInt(process.getuid()))) throw new Error('checkpoint stage refused')
    const fresh = offThreadSqliteActive()
    if (!fresh) closeSqliteHandle(source.path)
    for await (const text of databaseHistory({ ...session, engine }, source, fresh)) {
      if (!current()) throw new Error('checkpoint cancelled')
      const data = Buffer.from(text)
      if (bytes + used + data.length > STORAGE_STAGE_BYTES) throw new Error('checkpoint too large')
      for (let offset = 0; offset < data.length;) {
        const copied = data.copy(buffer, used, offset, Math.min(data.length, offset + buffer.length - used))
        offset += copied; used += copied
        if (used === buffer.length) await flush()
      }
    }
    if (used) await flush()
    if (!current()) throw new Error('checkpoint cancelled')
    input.verify()
    return { bytes, sha256: hash.digest('hex') }
  } catch (error) {
    // No selected conversation means no checkpoint. Never turn a read failure into absence.
    if (!(error instanceof UnwrittenOpenclawHistory) || engine !== 'openclaw' || bytes !== 0 || !current()) throw error
    input.verify()
    return { empty: true, bytes: 0, sha256: createHash('sha256').digest('hex') }
  } finally { await output.close() }
}
