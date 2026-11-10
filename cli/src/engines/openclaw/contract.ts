/**
 * What the core knows of OpenClaw without loading its code: declared data, read off OpenClaw 2026.11.2 on Linux and
 * macOS (`__fixtures__/`, docs/superpowers/specs/2026-11-10-openclaw-engine-design.md). It imports nothing of
 * OpenClaw's code.
 */
import { join } from 'node:path'

/**
 * A session key, `agent:<agentId>:<key>`: Harness's session id for OpenClaw. It outlives the key's windows (reset,
 * rewind, fork), names the agent whose database holds it, and is what the TUI resumes. `/new` makes
 * `agent:main:tui-<uuid>`.
 */
export const OPENCLAW_KEY = /^agent:([A-Za-z0-9_-]{1,64}):([A-Za-z0-9._:-]{1,128})$/

/**
 * The line under the TUI's title, `session agent:main:<key>`. The TUI renames its process to `openclaw`, so its argv
 * never shows the session (`ps-*.txt`): the pane's screen is the only place it is read from. Anchored to the whole
 * line, so `session agent:main:reset reset`, which `/reset` prints later, is not taken for it.
 */
export const OPENCLAW_HEADER = /^\s*session (agent:[A-Za-z0-9_-]{1,64}:[A-Za-z0-9._:-]{1,128})\s*$/m

/**
 * The title, `openclaw tui - <gateway url> - agent <id> - session <key>`. A remote TUI still holds this machine's
 * state database open, so only this URL tells a local Gateway from one on another host.
 */
export const OPENCLAW_HEADER_URL = /^\s*openclaw tui - (wss?:\/\/\S+) - agent /m

/** A Gateway on this machine. Any other header URL is a Gateway on another host, whose database is not here. */
export const OPENCLAW_LOOPBACK = /^wss?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?(?:\/|$)/i

/**
 * The TUI's arguments. A bare `openclaw tui` opens the last session any TUI used, so a launch always names one;
 * `--session <key>` creates or attaches `agent:main:<key>`, and a full key as the target resumes it.
 */
export const OPENCLAW_LAUNCH = {
  base: ['tui'],
  newSession: (agentId: string): string[] => ['--session', `harness-${agentId}`],
  resume: (key: string): string[] => [key],
} as const

/** What a person reads when OpenClaw cannot work for Harness, each with what to do about it. */
export const OPENCLAW_STATES = {
  noGateway: 'OpenClaw Gateway is not running. Start it with openclaw gateway.',
  noToken: 'OpenClaw has no Gateway token. Run openclaw onboard.',
  oldNode: 'OpenClaw needs Node 24.',
  remote: 'This OpenClaw runs on another machine.',
  unsupported: 'This OpenClaw version is not supported yet.',
} as const

/**
 * Asked of the installed OpenClaw before a launch. `--version` is the one command it runs on any Node without
 * installing another: on a Node it cannot run on, and with no other Node it can switch to, it prints a warning
 * (Node 22, `version-old-node-darwin.txt`) or refuses (below 22, `version-node20-darwin.txt`). The TUI would refuse to
 * start there.
 */
export const OPENCLAW_RUNTIME_PROBE = ['--version'] as const
const OLD_NODE = /^(?:Running on an unsupported Node \(|openclaw: Node \S+: )/m

/** The named state for what `openclaw --version` printed (both streams), or null when that OpenClaw can run. */
export function openclawRuntimeState(output: string): string | null {
  return OLD_NODE.test(output) ? OPENCLAW_STATES.oldNode : null
}

/**
 * Where an agent's sessions are: `<stateDir>/agents/<agentId>/agent/openclaw-agent.sqlite`, unless the config's
 * `agents.entries.<id>.agentDir` moved the agent's folder.
 */
export function openclawAgentDb(stateDir: string, agentId: string, agentDir?: string | null): string {
  return join(agentDir || join(stateDir, 'agents', agentId, 'agent'), 'openclaw-agent.sqlite')
}

/**
 * Every table and column the reader reads (agent schema 27). A store missing one is a version Harness does not
 * read yet; the schema version itself is not an allowlist.
 */
export const OPENCLAW_COLUMNS: Record<string, readonly string[]> = {
  session_nodes: ['session_key', 'current_session_id', 'status', 'created_via', 'updated_at', 'last_activity_at',
    'label', 'display_name'],
  session_windows: ['session_id', 'session_key', 'previous_session_id', 'reason', 'session_scope', 'status',
    'chat_type', 'model_provider', 'model', 'transcript_updated_at'],
  transcript_events: ['session_id', 'seq', 'event_json', 'event_zstd', 'created_at', 'navigation_json',
    'navigation_type', 'navigation_custom_type', 'message_role'],
  transcript_rewrite_watermarks: ['session_id', 'generation'],
  session_transcript_active_events: ['session_id', 'active_position', 'event_seq'],
}
