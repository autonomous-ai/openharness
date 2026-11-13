/**
 * Hermes live tailer.
 *
 * Hermes keeps every surface's history in ONE SQLite store (`<HERMES_HOME>/state.db`, WAL), so there is
 * no file to byte-offset-tail. This polls the DB every ~1s (through `lib/sqliteRead`: `node:sqlite`
 * in-process, or the `sqlite3` CLI on a Node without it) and feeds the same `emitSessionEvents`
 * funnel the file-based engines use.
 *
 * `messages.id` is an INTEGER primary key, which makes the incremental cursor trivial (`id > lastSeen`).
 * The connection is opened READ-ONLY: Hermes retries writes ~15 times on contention, and a long-held
 * reader would eat into that budget.
 */

import type { LiveEvent } from '../../lib/normalize.js'
import { oversizeRow, readStorePages, type StorePage } from '../../lib/sqlitePage.js'
import { HERMES_HISTORY_ID_RE, HERMES_SOURCE } from './contract.js'
import { isInteractiveSource, storeSessionSource } from '../kit/storeSource.js'
import {
  messageToEvents, newHermesTurnState, isTerminalFinish,
  type HermesTurnState, type HmMessage,
} from './normalizer.js'

// Every id a Hermes store keeps a conversation under, declared (contract.ts): homes are found by it too.
export { HERMES_HISTORY_ID_RE } from './contract.js'
const POLL_MS = 1_000

export class HermesSqliteMissing extends Error {
  constructor() { super('no SQLite reader (node:sqlite absent and no sqlite3 CLI on PATH) — Hermes sessions cannot be mirrored') }
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null
}

/**
 * Read a Hermes session's messages, optionally only those after `afterId`.
 * Throws `HermesSqliteMissing` when this machine has no way to read SQLite; returns [] on a transient error.
 */
export async function readHermesMessages(
  dbPath: string,
  sessionId: string,
  afterId?: number | null,
): Promise<HmMessage[]> {
  return await loadHermesMessages(dbPath, sessionId, afterId) ?? []
}

/** As [readHermesMessages], but null when the store did not answer (locked, mid-write, past its deadline). */
async function loadHermesMessages(
  dbPath: string,
  sessionId: string,
  afterId?: number | null,
): Promise<HmMessage[] | null> {
  if (!HERMES_HISTORY_ID_RE.test(sessionId)) return []
  const bounded = Number.isFinite(afterId as number) && (afterId as number) > 0
  // #4188: one query for a whole session was refused for its size on every poll past 32 MiB, so it is read in pages
  // bounded by bytes. The columns are bare so a row is sized without reading its payload.
  const page: StorePage = {
    table: 'messages', where: 't.session_id = ?', params: [sessionId], key: [{ as: 'id', sql: 't.id' }],
    columns: ['role', 'content', 'tool_call_id', 'tool_calls', 'tool_name', 'finish_reason', 'reasoning']
      .map((name) => ({ as: name, sql: `t.${name}` })),
  }
  const result = await readStorePages(dbPath, page, bounded ? [Math.trunc(afterId as number)] : null)
  if (!result.ok) {
    if (result.reason === 'missing') throw new HermesSqliteMissing()
    return null // db locked / mid-write — retry next tick
  }

  return result.rows.filter((row) => {
    if (!Number(row.page_big)) return true
    oversizeRow('hermes', sessionId, `id ${row.id}`)
    return false
  }).map((row) => ({
    id: Number(row.id) || 0,
    role: typeof row.role === 'string' ? row.role : '',
    content: typeof row.content === 'string' ? row.content : '',
    toolCallId: str(row.tool_call_id),
    toolCalls: str(row.tool_calls),
    toolName: str(row.tool_name),
    finishReason: str(row.finish_reason),
    reasoning: str(row.reasoning),
  }))
}

/**
 * Whether a session's source is the CLI's the user is looking at rather than a DELEGATION CHILD's. Declared
 * (contract.ts `HERMES_SOURCE`, which says why), read by the kit.
 */
export function isHermesInteractiveSource(source: string): boolean {
  return isInteractiveSource(HERMES_SOURCE, source)
}

export async function isHermesSubagentSession(dbPath: string, sessionId: string): Promise<boolean> {
  const source = await hermesSessionSource(dbPath, sessionId)
  return source !== null && !isHermesInteractiveSource(source)
}

/**
 * `sessions.source` for one id, or null when the row is not there YET: ask again shortly (kit/storeSource.ts).
 */
export async function hermesSessionSource(dbPath: string, sessionId: string): Promise<string | null> {
  return storeSessionSource(HERMES_SOURCE, dbPath, sessionId)
}

export interface HermesReaderDeps {
  dbPath: string
  sessionId: string
  onEvents: (events: LiveEvent[]) => void
  /** Reports the one-time fatal "no SQLite reader" so the caller can warn + stop the reader. */
  onFatal?: (err: Error) => void
  pollMs?: number
}

export class HermesReader {
  private timer: NodeJS.Timeout | null = null
  private polling = false
  private cursor = 0
  /** Whether the session's rows were read once and seeded; until then nothing is emitted (#4065). */
  private hydrated = false
  private state: HermesTurnState = newHermesTurnState()

  constructor(private readonly deps: HermesReaderDeps) {}

  get turnOpen(): boolean { return this.state.open }
  closeTurn(): void { this.state.open = false; this.state.pendingTools.clear() }

  /** Hydrate silently (no replay), then start polling. */
  async start(): Promise<void> {
    try {
      await this.seed()
    } catch (err) {
      if (err instanceof HermesSqliteMissing) { this.deps.onFatal?.(err); return }
    }
    this.timer = setInterval(() => { void this.tick() }, this.deps.pollMs ?? POLL_MS)
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null }
  }

  /**
   * Read the whole session and seed from it. A store that does not answer leaves the reader unseeded, and the next tick
   * reads in full again: with the cursor still at 0, an incremental read would emit the whole history as new (#4065).
   */
  private async seed(): Promise<void> {
    const all = await loadHermesMessages(this.deps.dbPath, this.deps.sessionId)
    if (!all) return
    this.hydrated = true
    this.hydrate(all)
  }

  /** Seed state from existing rows without emitting, so only NEW activity streams after attach. */
  private hydrate(messages: HmMessage[]): void {
    for (const msg of messages) {
      this.cursor = Math.max(this.cursor, msg.id)
      messageToEvents(msg, this.state, 'live') // advances turn/tool state; output discarded
    }
    // A trailing user row (or an assistant still calling tools) means we attached mid-turn.
    const tail = messages[messages.length - 1]
    if (!tail) return
    this.state.open = tail.role === 'user'
      || this.state.pendingTools.size > 0
      || (tail.role === 'assistant' && !isTerminalFinish(tail.finishReason))
  }

  private async tick(): Promise<void> {
    if (this.polling) return
    this.polling = true
    try {
      if (!this.hydrated) { await this.seed(); return }
      const batch = await readHermesMessages(this.deps.dbPath, this.deps.sessionId, this.cursor)
      if (batch.length === 0) return
      const events: LiveEvent[] = []
      for (const msg of batch) {
        this.cursor = Math.max(this.cursor, msg.id)
        events.push(...messageToEvents(msg, this.state, 'live'))
      }
      if (events.length) this.deps.onEvents(events)
    } catch (err) {
      if (err instanceof HermesSqliteMissing) { this.stop(); this.deps.onFatal?.(err) }
    } finally {
      this.polling = false
    }
  }
}
