/**
 * OpenClaw's transcript reader: its live tail and its history.
 *
 * OpenClaw keeps every conversation in its agent database (`openclaw-agent.sqlite`, schema 27), written by the
 * Gateway. A key (`agent:<id>:<key>`) points at its current window (`session_nodes.current_session_id`), and a
 * window's rows are `transcript_events`, keyed `(session_id, seq)`, each as JSON text or zstd-compressed JSON. This
 * reader polls every second, as `OpencodeReader` does, on the cached read-only `node:sqlite` handle. A poll that finds
 * the store's files as the last read left them reads nothing, so a bound idle pane costs a stat a second. There is no
 * `sqlite3` CLI fallback: the CLI's `-json` output mangles the compressed blobs.
 *
 * What the recorded fixtures (`__fixtures__/`, OpenClaw 2026.11.2) taught it:
 *  - Rewind makes a new window and copies every old row into it, ids and all. A new window is read from its start
 *    and an event whose id was already emitted is dropped, so a copied row is never emitted twice.
 *  - `/reset` keeps the window and appends a `reset` event, so the tail simply continues.
 *  - A rewrite inside a window bumps `transcript_rewrite_watermarks.generation`. Then the active branch
 *    (`session_transcript_active_events`) is read again and only what it has not emitted is emitted: rows the
 *    rewrite left off the branch never are.
 *  - Hidden rows (the system prompt's tool catalog, runtime context, cache bookkeeping) carry their custom type in
 *    `navigation_custom_type`, or, on a compressed row, in `navigation_json`, so they are dropped in SQL before
 *    any decompression. A plain row may carry it in neither, so a parsed record is checked again.
 *
 * The live tail follows `seq`, not the active-events table: OpenClaw can rebuild that projection after the row is
 * written, and a cursor over it would step past a row that becomes active later. It owns no turn state: that is
 * the normalizer's (normalizer.ts), which it hands what was there at attach, and the key's status.
 */
import { statSync } from 'node:fs'
import * as zlib from 'node:zlib'
import { sid } from '../../lib/log.js'
import { builtinSqlite, readBuiltin } from '../../lib/sqliteBuiltin.js'
import type { SqliteParam, SqliteRow } from '../../lib/sqliteRead.js'
import { OPENCLAW_COLUMNS } from './contract.js'

/** One transcript row: the window it was read from, its place there and the event OpenClaw wrote. */
export type OpenclawEvent = { windowId: string; seq: number; record: Record<string, unknown> }

/**
 * Why OpenClaw's store cannot be read. `missing`: this Node has no `node:sqlite` or no zstd (OpenClaw needs Node
 * 24, Harness ships it). `unsupported`: a column the reader reads is gone, a version it does not read yet.
 * `transient`: locked, mid-checkpoint or replaced; read again on the next poll.
 */
class OpenclawReadError extends Error {
  constructor(readonly reason: 'missing' | 'unsupported' | 'transient', detail: string) {
    super(`openclaw store ${reason} · ${detail}`)
  }
}

const POLL_MS = 1_000
/** A store whose files did not change is read this often all the same: a write a file's stamp could miss is late, never lost. */
const QUIET_READ_MS = 10_000
/** Rows per read: a long backlog drains over a few polls instead of in one blocking read. */
const PAGE = 500
/** The binding is synchronous and blocks the event loop while it waits on a lock: kept short, as in sqliteRead. */
const BUSY_TIMEOUT_MS = 250
/** Windows followed back through `previous_session_id`, and the guard against a cycle. */
const MAX_WINDOWS = 64
/** The store's own bound on a row (`event_utf8_bytes`), so a corrupt frame cannot inflate without limit. */
const MAX_EVENT_BYTES = 4 * 1024 * 1024
/** Unreadable rows remembered so each is logged once; forgotten past this many. */
const MAX_LOGGED = 1_000
/**
 * Event ids a reader remembers (about 50 B each). Past this many the oldest are forgotten: a rewind of a conversation
 * that long could show its oldest copied rows again, which beats a reader whose memory grows for the pane's life.
 */
const MAX_EMITTED = 100_000

/** Rows the model sees but a person never does (recorded in every scenario's fixture). */
const HIDDEN = ['openclaw.system-prompt', 'openclaw.runtime-context', 'openclaw.cache-ttl', 'openclaw:bootstrap-context:full']
const HIDDEN_SQL = `coalesce(navigation_custom_type, CASE WHEN json_valid(navigation_json) THEN json_extract(navigation_json, '$.navigation.customType') END) IN (${HIDDEN.map((type) => `'${type}'`).join(', ')})`
/** A page of a window's rows; a hidden one comes back without its payload, so only the cursor moves past it. */
const rowsSql = (where: string): string =>
  'SELECT seq, hidden, CASE WHEN hidden THEN NULL ELSE event_json END AS event_json, CASE WHEN hidden THEN NULL ELSE event_zstd END AS event_zstd ' +
  `FROM (SELECT seq, event_json, event_zstd, ${HIDDEN_SQL} AS hidden FROM transcript_events e WHERE ${where} ORDER BY seq LIMIT ${PAGE})`
const LIVE_SQL = rowsSql('e.session_id = ? AND e.seq > ?')
/** The window's header (seq 0) and its active branch, in order: an ancestor is always written before its child. */
const ACTIVE_SQL = rowsSql('e.session_id = ? AND e.seq > ? AND (e.seq = 0 OR EXISTS (SELECT 1 FROM session_transcript_active_events a WHERE a.session_id = e.session_id AND a.event_seq = e.seq))')
const NODE_SQL = 'SELECT n.current_session_id AS window_id, n.status AS status, w.generation AS generation FROM session_nodes n ' +
  'LEFT JOIN transcript_rewrite_watermarks w ON w.session_id = n.current_session_id WHERE n.session_key = ?'
/** The header (seq 0) of the agent's most recently updated window, by `idx_agent_session_windows_updated_at`. */
const NEWEST_HEADER_SQL = 'SELECT w.session_id AS window_id, e.seq AS seq, 0 AS hidden, e.event_json AS event_json, e.event_zstd AS event_zstd FROM session_windows w ' +
  'JOIN transcript_events e ON e.session_id = w.session_id AND e.seq = 0 ORDER BY w.updated_at DESC LIMIT 1'
const PREVIOUS_SQL = 'SELECT previous_session_id AS previous FROM session_windows WHERE session_id = ?'
const LAST_SEQ_SQL = 'SELECT max(seq) AS seq FROM transcript_events WHERE session_id = ?'
const IDS_SQL = "SELECT CASE WHEN json_valid(event_json) THEN json_extract(event_json, '$.id') " +
  "WHEN json_valid(navigation_json) THEN json_extract(navigation_json, '$.navigation.id') END AS id FROM transcript_events WHERE session_id = ?"
const COLUMNS_SQL = 'SELECT name FROM pragma_table_info(?)'
const SCHEMA_SQL = "SELECT schema_version AS version, app_version AS app FROM schema_meta WHERE role = 'agent'"
/** SQLite's own schema cookie: it changes with any change to the store's tables, an OpenClaw upgrade's migration too. */
const COOKIE_SQL = 'SELECT schema_version AS cookie FROM pragma_schema_version'

/**
 * The store's files as they stand: any commit changes the WAL's size or mtime, a checkpoint the database's, a rebuild
 * its inode. Null when they cannot be read, and then the poll reads (and says why it fails).
 */
function storeStamp(db: string): string | null {
  try {
    const main = statSync(db)
    const wal = statSync(`${db}-wal`, { throwIfNoEntry: false })
    return `${main.ino}:${main.size}:${main.mtimeMs}|${wal ? `${wal.size}:${wal.mtimeMs}` : ''}`
  } catch {
    return null
  }
}

const zstd = zlib as typeof zlib & { zstdDecompressSync?: (data: Uint8Array, options?: { maxOutputLength?: number }) => Buffer }

interface KeyNode { windowId: string; status: string | null; generation: string | null }
interface Page { events: OpenclawEvent[]; lastSeq: number | null; full: boolean }

function query(db: string, sql: string, params: SqliteParam[]): SqliteRow[] {
  const Database = builtinSqlite()
  if (!Database || typeof zstd.zstdDecompressSync !== 'function') {
    throw new OpenclawReadError('missing', 'this Node has no node:sqlite or zstd')
  }
  const result = readBuiltin(Database, db, sql, params, BUSY_TIMEOUT_MS)
  if (result.ok) return result.rows
  // A read that failed may be a store whose columns changed under it: check them again on the next read.
  checked.delete(db)
  throw new OpenclawReadError('transient', errorCode(result.error))
}

/** A short name for an error, never its message: a JSON parse error quotes the row's text. */
function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | undefined)?.code
  return typeof code === 'string' ? code : error instanceof Error ? error.name : 'unknown'
}

const checked = new Map<string, string[]>()
/** Every column the reader reads is there, checked once per store. The schema version is logged, never refused. */
function ensureSupported(db: string): void {
  let missing = checked.get(db)
  if (!missing) {
    missing = []
    for (const [table, columns] of Object.entries(OPENCLAW_COLUMNS)) {
      const have = new Set(query(db, COLUMNS_SQL, [table]).map((row) => String(row.name)))
      for (const column of columns) if (!have.has(column)) missing.push(`${table}.${column}`)
    }
    checked.set(db, missing)
    console.error(`[openclaw] agent schema ${schemaVersion(db)}${missing.length ? ` · unsupported, missing ${missing.join(', ')}` : ''}`)
  }
  if (missing.length) throw new OpenclawReadError('unsupported', `missing ${missing.join(', ')}`)
}

function schemaVersion(db: string): string {
  try {
    const row = query(db, SCHEMA_SQL, [])[0]
    return row ? `${String(row.version)} (OpenClaw ${String(row.app ?? 'unknown')})` : 'unknown'
  } catch {
    return 'unknown'
  }
}

function readNode(db: string, key: string): KeyNode | null {
  const row = query(db, NODE_SQL, [key])[0]
  if (!row || typeof row.window_id !== 'string') return null
  return {
    windowId: row.window_id,
    status: typeof row.status === 'string' ? row.status : null,
    generation: typeof row.generation === 'string' ? row.generation : null,
  }
}

function lastSeq(db: string, windowId: string): number {
  const seq = query(db, LAST_SEQ_SQL, [windowId])[0]?.seq
  return typeof seq === 'number' ? seq : -1
}

const logged = new Set<string>()
function unreadable(key: string, windowId: string, seq: number, why: string): void {
  const id = `${windowId}:${seq}`
  if (logged.has(id)) return
  if (logged.size >= MAX_LOGGED) logged.clear()
  logged.add(id)
  console.error(`[openclaw] ${sid(key)} seq ${seq} unreadable · ${why}`)
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function hiddenRecord(record: Record<string, unknown>): boolean {
  return HIDDEN.includes(String(record.customType)) || (record.type === 'custom_message' && record.display === false)
}

/** The row's event, or null when it is hidden or cannot be read (logged once, and the stream goes on). */
function decode(key: string, windowId: string, row: SqliteRow): Record<string, unknown> | null {
  const seq = Number(row.seq)
  if (row.hidden) return null
  let record: unknown
  try {
    const text = typeof row.event_json === 'string'
      ? row.event_json
      : zstd.zstdDecompressSync!(row.event_zstd as Uint8Array, { maxOutputLength: MAX_EVENT_BYTES }).toString('utf8')
    record = JSON.parse(text)
  } catch (error) {
    unreadable(key, windowId, seq, errorCode(error))
    return null
  }
  if (!isRecord(record)) { unreadable(key, windowId, seq, 'not an object'); return null }
  return hiddenRecord(record) ? null : record
}

function readPage(db: string, key: string, windowId: string, afterSeq: number, sql: string): Page {
  const rows = query(db, sql, [windowId, afterSeq])
  const events: OpenclawEvent[] = []
  for (const row of rows) {
    const record = decode(key, windowId, row)
    if (record) events.push({ windowId, seq: Number(row.seq), record })
  }
  return { events, lastSeq: rows.length ? Number(rows[rows.length - 1].seq) : null, full: rows.length === PAGE }
}

/** A window's header and active branch, every page of it. */
function readActive(db: string, key: string, windowId: string): OpenclawEvent[] {
  const events: OpenclawEvent[] = []
  let after = -1
  for (;;) {
    const page = readPage(db, key, windowId, after, ACTIVE_SQL)
    events.push(...page.events)
    if (!page.full || page.lastSeq === null) return events
    after = page.lastSeq
  }
}

/** The key's window and the ones before it, newest first. */
function windowChain(db: string, windowId: string): string[] {
  const chain = [windowId]
  while (chain.length < MAX_WINDOWS) {
    const previous = query(db, PREVIOUS_SQL, [chain[chain.length - 1]])[0]?.previous
    if (typeof previous !== 'string' || chain.includes(previous)) break
    chain.push(previous)
  }
  return chain
}

/**
 * The active branch across the window chain, oldest first. A window that copied an earlier one's rows (rewind,
 * fork) owns them: an earlier window contributes only events no later window holds, so a row a rewind left off
 * the branch never comes back through the window it was copied from.
 */
function history(db: string, key: string, node: KeyNode): OpenclawEvent[] {
  const chain = windowChain(db, node.windowId)
  const later = new Set<string>()
  const parts: OpenclawEvent[][] = []
  for (const [index, windowId] of chain.entries()) {
    parts.unshift(readActive(db, key, windowId).filter((event) => {
      const id = event.record.id
      return typeof id !== 'string' || !later.has(id)
    }))
    if (index < chain.length - 1) {
      for (const row of query(db, IDS_SQL, [windowId])) if (typeof row.id === 'string') later.add(row.id)
    }
  }
  return parts.flat()
}

/** Where a count of a key's rows stopped: its window, the last seq read there, and the window's rewrite generation. */
export interface OpenclawCursor { windowId: string; seq: number; generation: string | null }

/**
 * The key's rows since `after`, for a count kept by cursor (lib/agentTokenUsage.ts). In the same window and rewrite
 * generation that is every row past its seq; otherwise (a first read, a new window, a rewrite) it is the whole
 * conversation again, `whole`, and the count starts over. Hidden rows are left out. Null when the key is not there.
 */
export async function readOpenclawSince(db: string, key: string, after: OpenclawCursor | null): Promise<{ events: OpenclawEvent[]; cursor: OpenclawCursor; whole: boolean } | null> {
  ensureSupported(db)
  const node = readNode(db, key)
  if (!node) return null
  if (after?.windowId === node.windowId && after.generation === node.generation) {
    const events: OpenclawEvent[] = []
    let seq = after.seq
    for (;;) {
      const page = readPage(db, key, node.windowId, seq, LIVE_SQL)
      events.push(...page.events)
      if (page.lastSeq !== null) seq = page.lastSeq
      if (!page.full) return { events, cursor: { windowId: node.windowId, seq, generation: node.generation }, whole: false }
    }
  }
  // The last seq first: a row written while the history is read is then counted on the next read, never twice.
  const seq = lastSeq(db, node.windowId)
  return { events: history(db, key, node), cursor: { windowId: node.windowId, seq, generation: node.generation }, whole: true }
}

/** The key's conversation as OpenClaw holds it now: the active branch, across the window chain. */
export async function readOpenclawHistory(db: string, key: string): Promise<OpenclawEvent[]> {
  ensureSupported(db)
  const node = readNode(db, key)
  return node ? history(db, key, node) : []
}

export interface OpenclawReaderDeps {
  db: string
  key: string
  onEvents(events: OpenclawEvent[]): void
  /**
   * What was there the first time the key was read, read silently, with its `session_nodes.status` then: the
   * normalizer folds it so its turn state is the conversation's, and the status says whether a run is still going.
   * Not called for a key that was not there yet when the reader started: its rows are all new, and come as events.
   */
  onHydrated(events: OpenclawEvent[], status: string | null): void
  /**
   * The key's status on every read that caught up with its window. A run that is aborted, fails or times out writes
   * no closing assistant row, and its status not being `running` is what closes its turn.
   */
  onStatus?(status: string | null): void
  /**
   * The store cannot be read: `missing`, never on this Node (the reader has stopped); `unsupported`, not in this
   * version of OpenClaw (the reader waits for the store to change, and says `onRecovered` once it reads it again).
   */
  onFatal?(reason: 'unsupported' | 'missing'): void
  onRecovered?(): void
  /**
   * The header of the agent's newest window, once, when the key has no rows yet: OpenClaw's workspace is the agent's, so
   * it stands for the key's until the key's own header (seq 0) comes as an event.
   */
  onAgentHeader?(record: Record<string, unknown>): void
  /**
   * While this says so, every poll reads, changed files or not: an open turn is closed by the key's status, which takes
   * a second read to trust (live.ts).
   */
  busy?(): boolean
  pollMs?: number
}

export class OpenclawReader {
  private timer: NodeJS.Timeout | null = null
  private stopped = false
  private polling = false
  private cursor: { windowId: string; seq: number } | null = null
  private generation: string | null = null
  /** Whether the key's rows at attach were handed over silently (or the key was new, and there were none). */
  private hydrated = false
  /** A read found the store but not the key: when it comes, its rows are new, and read live from its start. */
  private born = false
  /** The schema cookie of a store found unsupported; read again only once it changes. */
  private unsupported: number | null = null
  /** Event ids already emitted (or seen at attach): a row a rewind copied into a new window is not emitted again. */
  private readonly emitted = new Set<string>()
  private said: 'absent' | 'failing' | null = null
  /** Whether the agent's newest header was looked for, for a key with no rows yet. */
  private borrowed = false
  /** The store's stamp when the last read left nothing to read again, and when that read was. */
  private settled: string | null = null
  private readAt = 0
  private stamp: string | null = null
  /** How many times a poll found the store's files changed: live.ts asks whether the pane can show anything new. */
  changes = 0
  /**
   * Whether the last read that reached the store found the key's node; false until one does, so also for a store
   * that cannot be opened. live.ts asks it while the pane reads a run: a store that never gets the key is not the
   * Gateway's.
   */
  keyFound = false

  constructor(private readonly deps: OpenclawReaderDeps) {}

  /** The first read (silent), then a poll. */
  async start(): Promise<void> {
    await this.tick()
    if (!this.stopped) this.timer = setInterval(() => { void this.tick() }, this.deps.pollMs ?? POLL_MS)
  }

  stop(): void {
    this.stopped = true
    if (this.timer) { clearInterval(this.timer); this.timer = null }
  }

  private node(): KeyNode | null {
    ensureSupported(this.deps.db)
    const node = readNode(this.deps.db, this.deps.key)
    if (!node && this.said !== 'absent') {
      this.said = 'absent'
      console.error(`[openclaw] ${sid(this.deps.key)} is not in its agent database yet`)
    }
    return node
  }

  /** Reads the active branch again, and returns the events it holds that were not emitted yet. */
  private hydrate(node: KeyNode): OpenclawEvent[] {
    // The last seq first: a row written while the history is read is then read again, and dropped by its id.
    const seq = lastSeq(this.deps.db, node.windowId)
    const fresh = history(this.deps.db, this.deps.key, node).filter((event) => this.remember(event))
    this.cursor = { windowId: node.windowId, seq }
    this.generation = node.generation
    return fresh
  }

  private remember(event: OpenclawEvent): boolean {
    const id = typeof event.record.id === 'string' ? event.record.id : `${event.windowId}:${event.seq}`
    if (this.emitted.has(id)) return false
    if (this.emitted.size >= MAX_EMITTED) this.emitted.delete(this.emitted.values().next().value!)
    this.emitted.add(id)
    return true
  }

  private async tick(): Promise<void> {
    if (this.polling) return
    const stamp = storeStamp(this.deps.db)
    if (stamp !== this.stamp) { this.stamp = stamp; this.changes++ }
    if (stamp !== null && stamp === this.settled && !this.deps.busy?.() && Date.now() - this.readAt < QUIET_READ_MS) return
    this.polling = true
    this.settled = null
    this.readAt = Date.now()
    // A read that failed, or stopped at a full page, reads again on the next poll.
    let settled = false
    try {
      let recovered = false
      if (this.unsupported !== null) {
        if (schemaCookie(this.deps.db) === this.unsupported) { settled = true; return }
        checked.delete(this.deps.db)
        this.unsupported = null
        recovered = true
      }
      const node = this.node()
      this.keyFound = node !== null
      if (recovered) {
        console.error(`[openclaw] ${sid(this.deps.key)} store readable again`)
        this.deps.onRecovered?.()
      }
      settled = true
      if (!node) {
        if (!this.hydrated) this.born = true
        if (!this.borrowed) {
          const row = query(this.deps.db, NEWEST_HEADER_SQL, [])[0]
          this.borrowed = true
          const header = row ? decode(this.deps.key, String(row.window_id), row) : null
          if (header) this.deps.onAgentHeader?.(header)
        }
        return
      }
      this.said = null
      if (!this.hydrated) {
        this.hydrated = true
        // Attached to a key that already had rows, whether this is the first read or the first good one after a
        // failed one (locked, being replaced): they are history, never live.
        if (!this.born) {
          this.deps.onHydrated(this.hydrate(node), node.status)
          this.deps.onStatus?.(node.status)
          return
        }
      }
      let page: { events: OpenclawEvent[]; full: boolean }
      if (!this.cursor || node.windowId !== this.cursor.windowId) {
        this.cursor = { windowId: node.windowId, seq: -1 }
        this.generation = node.generation
        page = this.readLive()
      } else if (node.generation !== this.generation) {
        page = { events: this.hydrate(node), full: false }
      } else {
        page = this.readLive()
      }
      settled = !page.full
      if (page.events.length) this.deps.onEvents(page.events)
      // A backlog still being read may hold the row that ends the run: the status speaks once it is read.
      if (!page.full) this.deps.onStatus?.(node.status)
    } catch (error) {
      settled = false
      this.failed(error)
    } finally {
      if (settled) this.settled = stamp
      this.polling = false
    }
  }

  private readLive(): { events: OpenclawEvent[]; full: boolean } {
    const cursor = this.cursor!
    const page = readPage(this.deps.db, this.deps.key, cursor.windowId, cursor.seq, LIVE_SQL)
    if (page.lastSeq !== null) cursor.seq = page.lastSeq
    return { events: page.events.filter((event) => this.remember(event)), full: page.full }
  }

  /** A transient failure is said once, until a read succeeds; the others are said to the stream. */
  private failed(error: unknown): void {
    if (error instanceof OpenclawReadError && error.reason === 'missing') {
      this.stop()
      this.deps.onFatal?.('missing')
      return
    }
    if (error instanceof OpenclawReadError && error.reason === 'unsupported') {
      this.unsupported = schemaCookieOr(this.deps.db, -1)
      this.deps.onFatal?.('unsupported')
      return
    }
    if (this.said !== 'failing') {
      this.said = 'failing'
      console.error(`[openclaw] ${sid(this.deps.key)} read failed · ${error instanceof OpenclawReadError ? error.message : errorCode(error)}`)
    }
  }
}

function schemaCookie(db: string): number {
  return Number(query(db, COOKIE_SQL, [])[0]?.cookie ?? -1)
}

function schemaCookieOr(db: string, fallback: number): number {
  try { return schemaCookie(db) } catch { return fallback }
}
