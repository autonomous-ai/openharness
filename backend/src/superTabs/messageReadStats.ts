import { logger } from '../utils/logger.js'

/**
 * Who reads messages and how (spec 5 A1): every minute, `messages by reader` logs each reader kind, cursor kind and sign-in
 * session kind with its request count, the batches it read, the rows those batches decoded and the rows the pages showed.
 * `db by shape` keeps only each minute's top shapes and says nothing of the caller. No id or text is kept.
 */

export interface MessageReadKey {
  reader: 'person' | 'agent' | 'buddy'
  /** `before` alone is Desktop's re-read of the page it shows; `beforeId` is scrolling back. */
  cursor: 'latest' | 'after' | 'before' | 'beforeId' | 'thread' | 'messageId' | 'catchUp'
  /** The Harness session the request signed in with (AuthUser.harnessSessionKind), `sso` for an Autonomous token. */
  session: 'viewer' | 'computer' | 'team' | 'sso'
}

interface Counts { n: number; batches: number; decoded: number; shown: number }

let window: Map<string, MessageReadKey & Counts> | undefined

export function recordMessageRead(key: MessageReadKey, batches: number, decoded: number, shown: number): void {
  if (!window) return
  const id = `${key.reader}|${key.cursor}|${key.session}`
  const row = window.get(id) ?? { reader: key.reader, cursor: key.cursor, session: key.session, n: 0, batches: 0, decoded: 0, shown: 0 }
  row.n++
  row.batches += batches
  row.decoded += decoded
  row.shown += shown
  window.set(id, row)
}

/** Logs each window's reads, every `everyMs`, until stopped; stopping logs what is left. */
export function startMessageReadStats({ everyMs = 60_000, log = (m, c) => logger.info(m, c) }: {
  everyMs?: number; log?: (message: string, context: Record<string, unknown>) => void } = {}): () => void {
  const counts = new Map<string, MessageReadKey & Counts>()
  window = counts
  let since = Date.now()
  const flush = () => {
    const now = Date.now()
    if (counts.size) log('messages by reader', { windowMs: now - since, rows: [...counts.values()] })
    counts.clear()
    since = now
  }
  const timer = setInterval(flush, everyMs)
  timer.unref()
  return () => {
    clearInterval(timer)
    if (window === counts) window = undefined
    flush()
  }
}
