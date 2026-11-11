/**
 * How daemons call the delivery routes, logged every minute as `delivery calls` (spec 2026-11-02 poll cost, Part 0): claims
 * of a delivery its host claimed again within 10 s (a held delivery re-claimed each second, cli host.ts), receipt reads
 * refused with 403 or 404 (a journal entry asked about forever), and holds by reason. Counts only, never an id.
 */
import { logger } from '../utils/logger.js'

type Event = 'reclaim' | 'receipt403' | 'receipt404' | 'hold'
let counts = { reclaims: 0, receipt403: 0, receipt404: 0, holds: {} as Record<string, number> }
const empty = () => ({ reclaims: 0, receipt403: 0, receipt404: 0, holds: {} as Record<string, number> })

export function recordDeliveryCall(event: Event, reason?: string): void {
  if (event === 'reclaim') counts.reclaims++
  else if (event === 'receipt403') counts.receipt403++
  else if (event === 'receipt404') counts.receipt404++
  else counts.holds[reason ?? 'other'] = (counts.holds[reason ?? 'other'] ?? 0) + 1
}

/** Each delivery's last claim on this process, so a host claiming the same delivery again within RECLAIM_MS counts as a
 *  re-claim. Bounded: the oldest are forgotten first. */
const RECLAIM_MS = 10_000, CLAIMS_KEPT = 10_000
const lastClaims = new Map<string, number>()
export function noteClaim(deliveryId: string, now: number): void {
  const last = lastClaims.get(deliveryId)
  if (last !== undefined && now - last < RECLAIM_MS) counts.reclaims++
  lastClaims.delete(deliveryId)
  lastClaims.set(deliveryId, now)
  if (lastClaims.size > CLAIMS_KEPT) lastClaims.delete(lastClaims.keys().next().value!)
}

export function startDeliveryCalls({ everyMs = 60_000, log = (message: string, context: Record<string, unknown>) => logger.info(message, context) }:
  { everyMs?: number; log?: (message: string, context: Record<string, unknown>) => void } = {}): () => void {
  let since = Date.now()
  const timer = setInterval(() => {
    const now = Date.now(), window = counts
    counts = empty()
    if (window.reclaims || window.receipt403 || window.receipt404 || Object.keys(window.holds).length) log('delivery calls', { windowMs: now - since, ...window })
    since = now
  }, everyMs)
  timer.unref()
  return () => clearInterval(timer)
}
