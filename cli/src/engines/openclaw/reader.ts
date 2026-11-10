/**
 * OpenClaw's transcript reader: its live tail and its history.
 *
 * OpenClaw keeps every conversation in its agent database (`openclaw-agent.sqlite`, schema 27), written by the
 * Gateway. A key (`agent:<id>:<key>`) points at its current window (`session_nodes.current_session_id`), and a
 * window's rows are `transcript_events`, keyed `(session_id, seq)`, each as JSON text or zstd-compressed JSON. This
 * reader polls every second, as `OpencodeReader` does, on the cached read-only `node:sqlite` handle. There is no
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
 * the normalizer's (normalizer.ts). It only says, once, that a run was already open when it attached.
 */
import * as zlib from 'node:zlib'
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
export class OpenclawReadError extends Error {
  constructor(readonly reason: 'missing' | 'unsupported' | 'transient', detail: string) {
    super(`openclaw store ${reason} · ${detail}`)
  }
}

const POLL_MS = 1_000
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
const PREVIOUS_SQL = 'SELECT previous_session_id AS previous FROM session_windows WHERE session_id = ?'
const LAST_SEQ_SQL = 'SELECT max(seq) AS seq FROM transcript_events WHERE session_id = ?'
const IDS_SQL = "SELECT CASE WHEN json_valid(event_json) THEN json_extract(event_json, '$.id') " +
  "WHEN json_valid(navigation_json) THEN json_extract(navigation_json, '$.navigation.id') END AS id FROM transcript_events WHERE session_id = ?"
const COLUMNS_SQL = 'SELECT name FROM pragma_table_info(?)'
const SCHEMA_SQL = "SELECT schema_version AS version, app_version AS app FROM schema_meta WHERE role = 'agent'"

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
  console.error(`[openclaw] ${key} seq ${seq} unreadable · ${why}`)
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

/**
 * The key's current window past `after`, in order, at most one page; from its start when `after` is another
 * window's or null. Hidden rows are left out.
 */
export async function readOpenclawEvents(db: string, key: string, after: { windowId: string; seq: number } | null): Promise<OpenclawEvent[]> {
  ensureSupported(db)
  const node = readNode(db, key)
  if (!node) return []
  return readPage(db, key, node.windowId, after?.windowId === node.windowId ? after.seq : -1, LIVE_SQL).events
}

/** The key's conversation as OpenClaw holds it now: the active branch, across the window chain. */
export async function readOpenclawHistory(db: string, key: string): Promise<OpenclawEvent[]> {
  ensureSupported(db)
  const node = readNode(db, key)
  return node ? history(db, key, node) : []
}

/**
 * Pi's rule, on what was there at attach: a run is open from a user row until an assistant row that stops for a
 * reason other than `toolUse` with no tool call left unanswered. A key whose status left `running` has no open
 * run (an abort leaves its tool call unanswered), and a heartbeat poll is no person's run.
 */
function runOpen(events: OpenclawEvent[], status: string | null): boolean {
  if (status !== null && status !== 'running') return false
  let open = false
  let heartbeat = false
  const pending = new Set<string>()
  for (const { record } of events) {
    const message = record.type === 'message' && isRecord(record.message) ? record.message : null
    if (!message) continue
    if (message.role === 'user') {
      open = true
      pending.clear()
      heartbeat = isRecord(message.__openclaw) && message.__openclaw.senderIsOwner === false
        && typeof message.content === 'string' && message.content.startsWith('[OpenClaw heartbeat poll]')
    } else if (message.role === 'toolResult') {
      pending.delete(String(message.toolCallId))
    } else if (message.role === 'assistant') {
      for (const part of Array.isArray(message.content) ? message.content : []) {
        if (isRecord(part) && part.type === 'toolCall') pending.add(String(part.id))
      }
      if (message.stopReason !== 'toolUse' && pending.size === 0) open = false
    }
  }
  return open && !heartbeat
}

export interface OpenclawReaderDeps {
  db: string
  key: string
  onEvents(events: OpenclawEvent[]): void
  /** What was there at attach, read silently: the normalizer folds it so its turn state is the conversation's. */
  onHydrated?(events: OpenclawEvent[]): void
  /** Attached while a run was open: the normalizer opens the turn it would otherwise never see start. */
  onTurnStarted(): void
  /**
   * The key's `session_nodes.status` each time it changes after the attach. A run that is aborted, fails or times
   * out writes no closing assistant row, and its status leaving `running` is what closes its turn.
   */
  onStatus?(status: string | null): void
  /** The store cannot be read on this machine or in this version: the reader has stopped. */
  onFatal?(reason: 'unsupported' | 'missing'): void
  pollMs?: number
}

export class OpenclawReader {
  private timer: NodeJS.Timeout | null = null
  private polling = false
  private cursor: { windowId: string; seq: number } | null = null
  private generation: string | null = null
  private status: string | null = null
  /** Event ids already emitted (or seen at attach): a row a rewind copied into a new window is not emitted again. */
  private readonly emitted = new Set<string>()
  private said: 'absent' | 'failing' | null = null

  constructor(private readonly deps: OpenclawReaderDeps) {}

  /** Hydrate silently, saying only whether a run was already open, then poll. */
  async start(): Promise<void> {
    try {
      const node = this.node()
      if (node) {
        this.status = node.status
        const seen = this.hydrate(node)
        this.deps.onHydrated?.(seen)
        if (runOpen(seen, node.status)) this.deps.onTurnStarted()
      }
    } catch (error) {
      if (this.failed(error)) return
    }
    this.timer = setInterval(() => { void this.tick() }, this.deps.pollMs ?? POLL_MS)
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null }
  }

  private node(): KeyNode | null {
    ensureSupported(this.deps.db)
    const node = readNode(this.deps.db, this.deps.key)
    if (!node && this.said !== 'absent') {
      this.said = 'absent'
      console.error(`[openclaw] ${this.deps.key} is not in its agent database yet`)
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
    this.polling = true
    try {
      const node = this.node()
      if (!node) return
      let events: OpenclawEvent[]
      if (!this.cursor || node.windowId !== this.cursor.windowId) {
        this.cursor = { windowId: node.windowId, seq: -1 }
        this.generation = node.generation
        events = this.readLive()
      } else if (node.generation !== this.generation) {
        events = this.hydrate(node)
      } else {
        events = this.readLive()
      }
      this.said = null
      if (events.length) this.deps.onEvents(events)
      if (node.status !== this.status) {
        this.status = node.status
        this.deps.onStatus?.(node.status)
      }
    } catch (error) {
      this.failed(error)
    } finally {
      this.polling = false
    }
  }

  private readLive(): OpenclawEvent[] {
    const cursor = this.cursor!
    const page = readPage(this.deps.db, this.deps.key, cursor.windowId, cursor.seq, LIVE_SQL)
    if (page.lastSeq !== null) cursor.seq = page.lastSeq
    return page.events.filter((event) => this.remember(event))
  }

  /** True when the reader has stopped for good. A transient failure is said once, until a read succeeds. */
  private failed(error: unknown): boolean {
    if (error instanceof OpenclawReadError && error.reason !== 'transient') {
      this.stop()
      this.deps.onFatal?.(error.reason)
      return true
    }
    if (this.said !== 'failing') {
      this.said = 'failing'
      console.error(`[openclaw] ${this.deps.key} read failed · ${error instanceof OpenclawReadError ? error.message : errorCode(error)}`)
    }
    return false
  }
}
