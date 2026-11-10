/**
 * Whether a hook's session is a pane's own or one a session delegated to, read from the engine's store as its
 * contract declares (Hermes: `sessions.source`). A delegated session runs its hooks from the parent's pane, so the
 * hook server verifies this before the session may take the pane (hookServer.ts `inspectHermesKind`).
 *
 * The source rule is declared by the engine. Read through `lib/sqliteRead` like every other query against such a store: the engine
 * writes to it constantly, and the read's busy wait is bounded there so a contended lookup cannot park the daemon.
 */
import { sqliteReadAll, type SqliteRow } from '../../lib/sqliteRead.js'
import { stat } from 'node:fs/promises'

export type StoreSessionSource = string | null | { unavailable: true; reason: 'missing' | 'transient' }

/**
 * A source that names a routing label, not who created the session: the creator is in a second column, which
 * older stores do not have (Hermes 0.23's unified runtime: `source='local'`, the surface in `created_source`).
 */
export interface StoreSurfaceRule {
  /** The routing label whose rows name their creator in `column`. */
  source: string
  /** The creator's column. A store without it reads as before: the label is the row's source. */
  column: string
  /** The query for one id's row on a store that has `column`: both columns, the id as its one parameter. */
  query: string
  /** A row when the store has `column`, none when it does not. No parameters. */
  probe: string
  /** Creator values that mean "not stamped yet": read as a row that is not there yet. */
  pending: readonly string[]
}

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
  /** A source whose creator is named elsewhere; without one, the source column is the whole answer. */
  surface?: StoreSurfaceRule
}

/** The one-id query for a store with these (non-hidden) columns. */
export function storeSourceQuery(rule: StoreSourceRule, columns: ReadonlySet<string>): string {
  return rule.surface && columns.has(rule.surface.column) ? rule.surface.query : rule.query
}

/**
 * The source a row stands for, tested with `isInteractiveSource`: the creator for a surfaced row, else the source
 * column. A row read without the creator's column (an older store) keeps its own source. An unstamped creator is
 * null, "ask again shortly", like a missing row; a value that is not text is unavailable, never a source.
 */
export function rowSessionSource(rule: StoreSourceRule, row: SqliteRow): StoreSessionSource {
  const source = row[rule.column]
  if (typeof source !== 'string') return { unavailable: true, reason: 'transient' }
  const surface = rule.surface
  if (!surface || source !== surface.source || !(surface.column in row)) return source
  const created = row[surface.column]
  if (typeof created !== 'string') return { unavailable: true, reason: 'transient' }
  return surface.pending.includes(created) ? null : created
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
  const read = (query: string, params: string[]) => sqliteReadAll(dbPath, query, params, { maxBuffer: rule.maxBuffer })
  const result = await read(rule.query, [sessionId])
  if (!result.ok) return { unavailable: true, reason: result.reason }
  if (result.rows.length === 0) return null
  const source = rowSessionSource(rule, result.rows[0] ?? {})
  // Only a surfaced row pays the two further reads: whether the store names creators, then the creator.
  if (!rule.surface || source !== rule.surface.source) return source
  const probe = await read(rule.surface.probe, [])
  if (!probe.ok) return { unavailable: true, reason: probe.reason }
  if (probe.rows.length === 0) return source
  const surfaced = await read(rule.surface.query, [sessionId])
  if (!surfaced.ok) return { unavailable: true, reason: surfaced.reason }
  if (surfaced.rows.length === 0) return null
  const row = surfaced.rows[0] ?? {}
  return rule.surface.column in row ? rowSessionSource(rule, row) : { unavailable: true, reason: 'transient' }
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
