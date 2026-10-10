/** Private, pull-driven live transcript protocol. A cursor acknowledges the previous complete page. */
import type { LiveEvent } from '../kit/events.js'
import type { LiveTurn } from '../facets/live.js'
import type { RegisteredSession } from '../../lib/registry.js'
import { record, sessionEvent } from './protocol.js'
import type { RuntimeRecord } from '../facets/runtime.js'
import { runtimeRecord } from './runtimeProtocol.js'
import type { TranscriptClose } from '../../lib/transcriptControls.js'

export const LIVE_VERSION = 1
export const LIVE_CAPABILITIES = 'engine_live_capabilities'
export const LIVE_PREPARE = 'engine_live_prepare'
export const LIVE_READ = 'engine_live_read'
export const LIVE_PART = 'engine_live_part'
export const LIVE_CLOSE = 'engine_live_close'
export const LIVE_FORGET = 'engine_live_forget'
export const LIVE_WAIT_MS = 15_000
export const LIVE_PAGE_BYTES = 1024 * 1024
/** Match the legacy tailer's small-rewrite replay limit; larger rewrites hydrate from their end. */
export const LIVE_HISTORY_BYTES = 32 * 1024 * 1024
/** A single record may exceed a page; transfer it in bounded fragments, never a giant socket frame. */
export const LIVE_RESULT_BYTES = 64 * 1024 * 1024
export const LIVE_PART_BYTES = 256 * 1024
export const LIVE_CACHE_BYTES = 128 * 1024 * 1024
export const LIVE_CACHE_SESSIONS = 256
export const LIVE_IN_FLIGHT = 1

export type LiveSession = Pick<RegisteredSession, 'agentId' | 'sessionId' | 'engine' | 'transcriptPath'
  | 'codexHome' | 'cwd' | 'model' | 'cliVersion'>

/** Bytes at the cursor, including file identity. Appends do not change it; replacement/truncation does. */
export interface LiveStamp { device: number; inode: number; bytes: number; digest: string }
export interface LiveCursor {
  /** Changes even for empty polls: acknowledging an empty page permits observing later appends. */
  serial: number
  /** The frozen end used to choose the original parser window. Recovery folds that same window,
   * including later accepted turns, preserving thinking ids, tool links and continuing goals. */
  origin: number
  offset: number
  turn: LiveTurn
  /** Core's explicit cancellation/relaunch closure, which is not necessarily present in the file. */
  closed: false | 'cancel' | 'abandoned' | 'hook'
  /** A frozen attach end while staging; null once this cursor belongs to a live tail. */
  prepareEnd: number | null
  /** A first turn emitted after activation may include its final complete, unterminated record. */
  completeUntil: number | null
  /** A rewritten file's existing records replay as history, even across pages or worker restart. */
  historyUntil?: number
  stamp: LiveStamp | null
}
export interface LiveFrame {
  raw: string
  /** Compact, engine-private profile evidence; core forwards it without interpreting vendor fields. */
  runtime?: RuntimeRecord | null
  /** Profile metadata can begin before the turn's parser window. */
  profile: boolean
  observe: boolean
  events: LiveEvent[]
  failure?: string
  replay: boolean
  turn: LiveTurn
}
export interface LivePage {
  frames: LiveFrame[]
  cursor: LiveCursor
  /** Attach reached its frozen end; later appends belong to a subsequent live read. */
  prepared?: true
  failed?: true
  content: boolean
  more: boolean
  records: number
  turnFrom: number
  profileFrom: number
  end: number
  lastStarted: LiveEvent | null
}

export function liveTurn(value: unknown): value is LiveTurn {
  return record(value) && typeof value.identity === 'string' && value.identity.length <= 512
    && typeof value.turnOpen === 'boolean' && typeof value.continued === 'boolean'
}
export function liveStamp(value: unknown): value is LiveStamp | null {
  return value === null || (record(value) && Number.isSafeInteger(value.device) && Number.isSafeInteger(value.inode)
    && typeof value.bytes === 'number' && Number.isInteger(value.bytes) && value.bytes > 0 && value.bytes <= 512
    && typeof value.digest === 'string' && /^[a-f0-9]{64}$/.test(value.digest))
}
export function liveCursor(value: unknown): value is LiveCursor {
  return record(value) && Number.isSafeInteger(value.serial) && (value.serial as number) >= 0
    && Number.isSafeInteger(value.origin) && (value.origin as number) >= 0
    && typeof value.offset === 'number' && Number.isSafeInteger(value.offset) && value.offset >= 0
    && liveTurn(value.turn) && [false, 'cancel', 'abandoned', 'hook'].includes(value.closed as false | string)
    && (value.prepareEnd === null || (typeof value.prepareEnd === 'number' && Number.isSafeInteger(value.prepareEnd) && value.prepareEnd >= value.offset))
    && (value.completeUntil === null || (typeof value.completeUntil === 'number' && Number.isSafeInteger(value.completeUntil) && value.completeUntil >= value.offset))
    && (value.historyUntil === undefined || (typeof value.historyUntil === 'number' && Number.isSafeInteger(value.historyUntil) && value.historyUntil > value.offset))
    && liveStamp(value.stamp)
}

export function liveEvent(value: unknown): value is LiveEvent {
  if (sessionEvent(value)) return true
  if (!record(value) || !record(value.payload)) return false
  const p = value.payload
  if (value.type === 'turn_started') return typeof p.userMessage === 'string'
  if (value.type === 'turn_ended') return p.aborted === undefined || p.aborted === true
  return value.type === 'subagent_finished' && typeof p.id === 'string' && typeof p.status === 'string'
    && (p.summary === undefined || typeof p.summary === 'string')
}

export function livePage(value: unknown): value is LivePage {
  if (!record(value) || !liveCursor(value.cursor) || !Array.isArray(value.frames)) return false
  if (![value.records, value.turnFrom, value.profileFrom, value.end].every(n => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0)) return false
  return (value.end as number) >= value.cursor.offset && (value.profileFrom as number) <= (value.turnFrom as number)
    && typeof value.content === 'boolean' && typeof value.more === 'boolean' && (value.prepared === undefined || (value.prepared === true && value.cursor.prepareEnd === null))
    && (value.failed === undefined || value.failed === true)
    && (value.lastStarted === null || (liveEvent(value.lastStarted) && value.lastStarted.type === 'turn_started'))
    && value.frames.every(f => record(f) && typeof f.raw === 'string' && typeof f.profile === 'boolean'
      && typeof f.observe === 'boolean' && typeof f.replay === 'boolean' && liveTurn(f.turn)
      && (f.runtime === undefined || f.runtime === null || runtimeRecord(f.runtime))
      && (f.failure === undefined || typeof f.failure === 'string') && Array.isArray(f.events) && f.events.every(liveEvent))
}

export interface LivePull {
  token: string
  session: LiveSession
  /** Null only for the first page of an attach. Each later cursor acknowledges the previous page. */
  cursor: LiveCursor | null
  fromStart: boolean
  replay: boolean
  /** Activate an empty parser first, then stream the first turn with ordinary bounded live pages. */
  liveStart?: boolean
  /** Rebuild after replacement/truncation; stream a small rewritten file as history after activation. */
  rewritten?: boolean
  /** The stream whose read found the file rewritten. Its records up to where that read found them are
   *  history and the rest are live, as the legacy tailer placed the boundary when it noticed the rewrite.
   *  A worker that never saw that read, or a file changed again since, hydrates as `rewritten` alone. */
  rewrittenFrom?: string
  end?: number
  /** Eager core decisions retained across parser reconstruction, in native byte order. */
  closes?: readonly TranscriptClose[]
}
