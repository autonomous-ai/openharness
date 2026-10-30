/**
 * How often Swarm transactions run again, per route, logged every minute (DB roadmap 2.1). The design keeps a retry of up
 * to 8 attempts for write conflicts (retry.ts) and a second load when a command names what its first load lacks
 * (store.ts ensure); prod receipts showed ~0.05% of commands could have collided (2026-10-31), but conflicts with
 * deliveries, machine reports and sweeps leave no receipt. This says when that changes. Route patterns and error codes
 * only, never an id.
 */
import { logger } from '../utils/logger.js'
import { workKind } from '../lib/queryStats.js'

interface Row { attempts: number; retries: Record<string, number>; busy: number; reloads: number }
/** Routes one window keeps; any more count as `other`, so memory stays bounded. */
const MAX_ROUTES = 50

let rows = new Map<string, Row>()
const row = (): Row => {
  const kind = workKind()
  const key = rows.has(kind) || rows.size < MAX_ROUTES ? kind : 'other'
  let found = rows.get(key)
  if (!found) rows.set(key, found = { attempts: 0, retries: {}, busy: 0, reloads: 0 })
  return found
}

/** A transaction attempt started (retry.ts). */
export function recordAttempt(): void { row().attempts++ }
/** An attempt failed with `code` and runs again. */
export function recordRetry(code: string): void { const r = row(); r.retries[code] = (r.retries[code] ?? 0) + 1 }
/** The attempts ran out: the caller answers SWARM_BUSY. */
export function recordBusy(): void { row().busy++ }
/** A command loaded its Swarm again for parts the first load lacked (store.ts ensure). */
export function recordReload(): void { row().reloads++ }

/** Logs `swarm retries` every `everyMs` while anything was counted. Returns its stop. */
export function startRetryStats({ everyMs = 60_000, log = (message: string, context: Record<string, unknown>) => logger.info(message, context) }:
  { everyMs?: number; log?: (message: string, context: Record<string, unknown>) => void } = {}): () => void {
  let since = Date.now()
  const timer = setInterval(() => {
    const now = Date.now(), window = rows
    rows = new Map()
    if (window.size) log('swarm retries', { windowMs: now - since, routes: Object.fromEntries(window) })
    since = now
  }, everyMs)
  timer.unref()
  return () => clearInterval(timer)
}
