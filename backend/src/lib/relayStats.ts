/**
 * How each frame an adapter sends for one viewer reaches it, logged every minute (`terminal relay`): delivered on this
 * process, or published, and how many subscriptions each publish reached (Redis answers that). A frame for one viewer
 * that wakes several processes is work for nothing (spec 2026-10-31-terminal-relay-direct). Counts only, never an id.
 */
import { logger } from '../utils/logger.js'

export type RelayKind = 'termup' | 'up targeted' | 'up broadcast' | 'pod hop' | 'pod json'
interface Counts { local: number; published: number; receivers: number }

let kinds = new Map<RelayKind, Counts>()

export function recordRelay(kind: RelayKind, path: 'local' | 'published', receivers = 0): void {
  let counts = kinds.get(kind)
  if (!counts) kinds.set(kind, counts = { local: 0, published: 0, receivers: 0 })
  if (path === 'local') counts.local++
  else { counts.published++; counts.receivers += receivers }
}

export function startRelayStats({ everyMs = 60_000, log = (message: string, context: Record<string, unknown>) => logger.info(message, context) }:
  { everyMs?: number; log?: (message: string, context: Record<string, unknown>) => void } = {}): () => void {
  let since = Date.now()
  const timer = setInterval(() => {
    const now = Date.now(), window = kinds
    kinds = new Map()
    if (window.size) log('terminal relay', { windowMs: now - since, kinds: Object.fromEntries(window) })
    since = now
  }, everyMs)
  timer.unref()
  return () => clearInterval(timer)
}
