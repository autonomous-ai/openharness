/**
 * What the core knows of Hermes without loading its code: declared data (docs/design/2026-10-08-other-engines-out-of-
 * core.md). It imports nothing of Hermes's code.
 */
import { join } from 'node:path'
import { env as hookEnvironment } from '../../config/env.js'
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
 * `state.db` (engines/hermes/home.ts). Session control verifies fresh pools in kit/storePool.ts;
 * optional readers may reuse the kit/storeHomes.ts listing for ttlMs.
 */
export const HERMES_HOMES: StoreHomes = { profiles: 'profiles', store: hermesDbPath, max: 64, ttlMs: 30_000 }

// Validate the original bytes. SQLite text substr/length stop at NUL and would turn a malformed
// source such as "cli\0tool" into interactive authority, or a malformed id into a valid prefix.
export const HERMES_ID_SQL = "CASE WHEN typeof(id) = 'text' AND length(CAST(id AS BLOB)) <= 128 AND instr(CAST(id AS BLOB), x'00') = 0 THEN id END"
export const HERMES_SOURCE_SQL = "CASE WHEN typeof(source) = 'text' AND length(CAST(source AS BLOB)) <= 128 AND instr(CAST(source AS BLOB), x'00') = 0 THEN source END"

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
  query: `SELECT ${HERMES_SOURCE_SQL} AS source FROM sessions WHERE id = ? LIMIT 2;`,
  column: 'source',
  interactive: ['', 'cli', 'tui'],
  maxBuffer: 1 << 20,
}

/**
 * The pane a Hermes 0.22+ session was opened from. Hermes now runs every session, and every shell hook, inside one shared
 * gateway with the gateway's own environment (agent/shell_hooks.py `_spawn`), so a hook names the gateway's pane, not
 * the session's. What does travel is the client's environment: names listed in `terminal.client_env_passthrough` are sent
 * with `session.create` and frozen with the session's policy in `state_meta` (gateway/session_policy.py,
 * hermes_state_local.py). Harness lists its pane names there (`HERMES_HOOK_SETTINGS.passthrough`) and reads them back here.
 * The join to the session's own row keeps the read to the home that holds that session; `state_meta` must be a plain table.
 */
export const HERMES_SESSION_PANE = {
  names: ['HARNESS_PANE', 'TMUX_PANE'],
  key: (sessionId: string): string => `gateway.local_policy.v1:${sessionId}`,
  query: "SELECT s.id AS id, json_extract(m.value, '$.policy.client_env_json') AS client_env FROM sessions s JOIN state_meta m ON m.key = ?"
    + " WHERE s.id = ? AND (SELECT type FROM sqlite_schema WHERE name = 'state_meta') = 'table' LIMIT 2;",
  maxBuffer: 1 << 20,
} as const

/** A profile needs its own command as soon as config exists, before its first history row (#191). */
export const HERMES_CONFIG_HOMES = { directory: 'profiles', file: 'config.yaml', max: 64 } as const

/** pre_llm_call registers resumed sessions too; on_session_start only fires for a new one. */
export const HERMES_HOOK_SETTINGS = {
  home: hookEnvironment.HERMES_HOME,
  homes: HERMES_CONFIG_HOMES,
  begin: '# machine-adapter: session discovery (managed block — safe to delete)',
  end: '# machine-adapter: end',
  events: ['on_session_start', 'pre_llm_call'],
  timeout: 10,
  allowlist: 'shell-hooks-allowlist.json',
  ownership: ['notify.mjs', '--engine hermes'],
  messages: {
    missing: '[hooks] no Hermes config at {file} — skipping (run hermes once first)',
    foreign: '[hooks] {file} has its own `hooks:` block — leaving it untouched.',
    manual: '[hooks] add these entries under it manually to mirror Hermes sessions:',
    current: '[hooks] Hermes session hooks already installed',
    installed: '[hooks] installed Hermes session hooks → {file}',
    collapsed: '[hooks] installed Hermes session hooks (collapsed {removed} stale blocks) → {file}',
    after: '[hooks] (takes effect on the next hermes session start)',
    failed: '[hooks] failed to write Hermes config.yaml:',
  },
  // Each session then carries the pane it was opened from (`HERMES_SESSION_PANE`). Hermes 0.21 ignores the key.
  passthrough: {
    section: 'terminal', key: 'client_env_passthrough', names: HERMES_SESSION_PANE.names,
    unlisted: '[hooks] {file} has no terminal.client_env_passthrough list to add Harness\'s pane names to:'
      + ' sessions from a shared Hermes gateway (Hermes 0.22+) will not bind to their harness',
  },
} as const satisfies import('../kit/nativeHookYaml.js').NativeYamlHooks
