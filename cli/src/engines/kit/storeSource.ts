/**
 * Whether a hook's session is a pane's own or one a session delegated to, read from the engine's store as its
 * contract declares (Hermes: `sessions.source`). A delegated session runs its hooks from the parent's pane, so the
 * hook server verifies this before the session may take the pane (hookServer.ts `inspectHermesKind`).
 *
 * The source rule is declared by the engine. Read through `lib/sqliteRead` like every other query against such a store: the engine
 * writes to it constantly, and the read's busy wait is bounded there so a contended lookup cannot park the daemon.
 */
import { sqliteReadAll } from '../../lib/sqliteRead.js'
import { stat } from 'node:fs/promises'

export type StoreSessionSource = string | null | { unavailable: true; reason: 'missing' | 'transient' }

export interface StoreSourceRule {
  /** The ids a pane's own session has. Any other (an editor's) reads as a pane's own: `''`. */
  id: RegExp
  /** The query for one id's row, with the id as its one parameter. */
  query: string
  /** The row's column that names its source. */
  column: string
  /** The sources of a pane's own session; any other is a delegated one's. */
  interactive: readonly string[]
  /** The most the read may return. */
  maxBuffer: number
}

/**
 * The source of one id's row, or null when the row is not there YET — which is a real state, not an error:
 * measured, a Hermes delegation child's `on_session_start` hook reached the adapter 110ms BEFORE Hermes inserted
 * its row, so an immediate lookup said "not a sub-agent" and the child took over the pane. Callers that can afford
 * to wait should treat null as "ask again shortly".
 */
export async function readStoreSessionSource(rule: StoreSourceRule, dbPath: string, sessionId: string): Promise<StoreSessionSource> {
  if (!rule.id.test(sessionId)) return ''
  // A home with no store yet is different from a store whose rows cannot be verified.
  try { await stat(dbPath) } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? null : { unavailable: true, reason: 'transient' }
  }
  const result = await sqliteReadAll(dbPath, rule.query, [sessionId], { maxBuffer: rule.maxBuffer })
  if (!result.ok) return { unavailable: true, reason: result.reason }
  if (result.rows.length === 0) return null
  const source = result.rows[0]?.[rule.column]
  return typeof source === 'string' ? source : { unavailable: true, reason: 'transient' }
}

/** Compatibility for optional readers: unknown stays unknown, never an interactive source. */
export async function storeSessionSource(rule: StoreSourceRule, dbPath: string, sessionId: string): Promise<string | null> {
  const source = await readStoreSessionSource(rule, dbPath, sessionId)
  return source !== null && typeof source === 'object' ? null : source
}

/** Whether a source is a pane's own session's. */
export function isInteractiveSource(rule: StoreSourceRule, source: string): boolean {
  return rule.interactive.includes(source)
}
