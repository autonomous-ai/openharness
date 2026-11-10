/**
 * What the core knows of OpenClaw without loading its code: declared data, read off OpenClaw 2026.11.2 on Linux and
 * macOS (`__fixtures__/`, docs/superpowers/specs/2026-11-10-openclaw-engine-design.md). It imports nothing of
 * OpenClaw's code.
 */
import { join } from 'node:path'
import { stripAnsi } from '../kit/pane.js'

/**
 * A session key, `agent:<agentId>:<key>`: Harness's session id for OpenClaw. It outlives the key's windows (reset,
 * rewind, fork), names the agent whose database holds it, and is what the TUI resumes. `/new` makes
 * `agent:main:tui-<uuid>`.
 */
export const OPENCLAW_KEY = /^agent:([A-Za-z0-9_-]{1,64}):([A-Za-z0-9._:-]{1,128})$/

/** A Gateway on this machine. Any other title URL is a Gateway on another host, whose database is not here. */
const LOOPBACK = /^wss?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?(?:\/|$)/i

/**
 * The TUI's footer, drawn on every screen it draws: `agent <id>[ (<name>)] | session <key>[ (<label>)] | <model> | …`,
 * the key without its `agent:<id>:` prefix (`formatTuiFooter` in OpenClaw's `tui-formatters`). The TUI renames its
 * process to `openclaw`, so its argv never shows the session (`ps-*.txt`): this line is where it is read. It is
 * word-wrapped at the window's width (`screen-main-heartbeat.txt`, 80 columns), so it is read with its continuation lines
 * joined by a space; a key longer than a whole line would be cut mid-word, and then does not match.
 */
const FOOTER = /^agent ([A-Za-z0-9_-]{1,64})(?: \([^)]*\))? \| session ([A-Za-z0-9._:-]{1,128})(?: \([^)]*\))? \| /
const FOOTER_START = /^\s*agent \S+(?: \([^)]*\))? \| session /

/**
 * The title, the first line the TUI draws: `openclaw tui - <gateway url> - agent <id>[ (<name>)] - session <key>`. It
 * scrolls off a long conversation. A remote TUI still holds this machine's state database open, so only this URL tells
 * a local Gateway from one on another host.
 */
const TITLE = /^\s*openclaw tui - (wss?:\/\/\S+) - agent ([A-Za-z0-9_-]{1,64})(?: \([^)]*\))? - session ([A-Za-z0-9._:-]{1,128})\s*$/

/** The composer's borders: the two rules under the footer are the last lines a running TUI draws. */
export const OPENCLAW_RULE = /^\s*─{8,}\s*$/

/**
 * The status line, the last line above the footer: `connected | idle`, `gateway reconnected | idle`, `connected |
 * aborted`, `⠏ running • 6s | connected`, `gateway disconnected: <error> | idle`.
 */
const STATUS = {
  ready: /^(?:gateway )?(?:connected|reconnected) \| (?:idle|aborted|error)$/,
  busy: /^\S{1,2} (?:running|streaming|connecting)\b/,
  noGateway: /^gateway disconnected\b/,
}

/** What `openclaw tui` prints as it exits when the config has no Gateway token (`screen-no-token.txt`). */
const NO_TOKEN = /^Missing gateway auth token\./

export type OpenclawPaneState = 'ready' | 'busy' | 'no-gateway' | 'no-token' | 'remote'

/** What an OpenClaw pane's screen says. */
export interface OpenclawScreen {
  /**
   * The session the running TUI is on, `agent:<id>:<key>`, from its footer. Null unless that footer is the last
   * thing on screen with only the composer under it (a TUI that exited leaves its footer above the shell prompt, and
   * one starting has not drawn its own yet) and the title, when it is on screen, names the same session.
   */
  key: string | null
  /** The title's Gateway URL, while the title is on screen. */
  url: string | null
  state: OpenclawPaneState | null
  /** The running TUI's footer, its wrapped lines joined: where the model and tokens are read. */
  footer: string | null
}

const NOTHING: OpenclawScreen = { key: null, url: null, state: null, footer: null }

/** Lines as drawn: escapes removed, trailing blanks dropped. */
export function openclawScreenLines(capture: string): string[] {
  return stripAnsi(capture).split('\n').map((line) => line.replace(/\s+$/, ''))
}

function lastIndex(lines: readonly string[], test: (line: string) => boolean): number {
  for (let i = lines.length - 1; i >= 0; i--) if (test(lines[i])) return i
  return -1
}

/** A footer the running TUI drew: under it the composer between two rules, and nothing below that. */
function liveFooter(lines: readonly string[], start: number): string | null {
  let end = start + 1
  while (end < lines.length && lines[end].trim() && !OPENCLAW_RULE.test(lines[end])) end++
  const below = lines.slice(end).filter((line) => line.trim())
  if (below.length < 2 || !OPENCLAW_RULE.test(below[0]) || !OPENCLAW_RULE.test(below[below.length - 1])) return null
  return lines.slice(start, end).map((line) => line.trim()).join(' ')
}

/**
 * Reads an OpenClaw pane's screen (OpenClaw 2026.11.2, `__fixtures__/screen-*.txt`). The one reading of it: the binding
 * takes the key and the named states from it, the runtime profile the model and tokens, discovery whether the pane is
 * the TUI at all (every `openclaw` command renames its process `openclaw`, `onboard` and `logs` too).
 */
export function readOpenclawScreen(capture: string): OpenclawScreen {
  const lines = openclawScreenLines(capture)
  const start = lastIndex(lines, (line) => FOOTER_START.test(line))
  const tokenless = lastIndex(lines, (line) => NO_TOKEN.test(line))
  if (tokenless > start) return { ...NOTHING, state: 'no-token' }
  const titled = lastIndex(lines, (line) => TITLE.test(line))
  const title = titled >= 0 ? TITLE.exec(lines[titled]) : null
  const url = title?.[1] ?? null
  const remote = url !== null && !LOOPBACK.test(url)
  const footer = start >= 0 && titled <= start ? liveFooter(lines, start) : null
  if (!footer) return { ...NOTHING, url, state: remote ? 'remote' : null }
  const shown = FOOTER.exec(footer)
  const agrees = !title || (!!shown && title[2] === shown[1] && title[3] === shown[2])
  const status = lastIndex(lines.slice(0, start), (line) => !!line.trim())
  const said = status >= 0 ? lines[status].trim() : ''
  const state: OpenclawPaneState | null = remote ? 'remote'
    : STATUS.noGateway.test(said) ? 'no-gateway'
      : STATUS.busy.test(said) ? 'busy'
        : STATUS.ready.test(said) ? 'ready' : null
  return { key: shown && agrees ? `agent:${shown[1]}:${shown[2]}` : null, url, state, footer }
}

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

/** The screens a TUI cannot work for Harness on, and what the agent says while one is up (cleared once it is gone). */
export const OPENCLAW_SCREEN_HOLDS: Partial<Record<OpenclawPaneState, string>> = {
  'no-gateway': OPENCLAW_STATES.noGateway,
  'no-token': OPENCLAW_STATES.noToken,
  remote: OPENCLAW_STATES.remote,
}

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
