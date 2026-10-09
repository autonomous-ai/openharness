/**
 * What the core knows of Hermes without loading its code: declared data (docs/design/2026-10-08-other-engines-out-of-
 * core.md). It imports nothing of Hermes's code.
 */
import { join } from 'node:path'
import type { StoreHomes } from '../kit/storeHomes.js'
import type { StoreSourceRule } from '../kit/storeSource.js'

export const HERMES_PROFILE = { variable: 'HERMES_HOME', setting: 'HERMES_HOME', trimTrailingSlashes: true } as const

/** The store a Hermes home keeps its sessions in. */
export function hermesDbPath(home: string): string {
  return join(home, 'state.db')
}

/**
 * Every id a Hermes store keeps a conversation under: the CLI's and the gateway's (`YYYYMMDD_HHMMSS_<hex>`), and
 * an editor's. The ACP adapter names its sessions with a uuid4 (`acp_adapter/session.py`; all six ACP rows on the
 * machine measured were uuids), so their history is readable too. `hermesSessionSource` keeps the narrower shape:
 * it decides whether a hook's session is a pane's own, and editors' sessions never are.
 */
export const HERMES_HISTORY_ID_RE =
  /^(?:[0-9]{8}_[0-9]{6}_[0-9a-fA-F]{4,16}|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/

/**
 * Hermes keeps one store per home: `hermes -p <name>` runs against `~/.hermes/profiles/<name>`, with its own
 * `state.db` (engines/hermes/home.ts). Listed by the kit (kit/storeHomes.ts) for the hook server, repair and the
 * readers alike.
 */
export const HERMES_HOMES: StoreHomes = { profiles: 'profiles', store: hermesDbPath, max: 64, ttlMs: 30_000 }

/**
 * A Hermes sub-agent is a full Hermes session of its own and runs the same shell hooks, so it announces itself to
 * the adapter from the parent's pane. Measured live: dispatching two sub-agents fired `on_session_start` for
 * `20260805_111618_8e3027` / `…_0777bc` 0.2s after the parent's rows appeared, the pane re-bound to them, and the
 * parent was `forgotten` mid-turn — taking its delegation bookkeeping and its sub-agent list with it.
 * `sessions.source` separates them: 'cli'/'tui' for the real one, 'subagent'/'tool' for the children (`cwd` also
 * points into `/tmp`, but source is the explicit marker). Read by the kit (kit/storeSource.ts) in the hook server.
 *
 * The ids are the CLI's and the gateway's, `YYYYMMDD_HHMMSS_<hex>` (6 hex chars for the CLI and the TUI, 8 for the
 * gateway): an editor's sessions, never a pane's own, read as one.
 */
export const HERMES_SOURCE: StoreSourceRule = {
  id: /^[0-9]{8}_[0-9]{6}_[0-9a-fA-F]{4,16}$/,
  query: 'SELECT source FROM sessions WHERE id = ?;',
  column: 'source',
  interactive: ['', 'cli', 'tui'],
  maxBuffer: 1 << 20,
}
