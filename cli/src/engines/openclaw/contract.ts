/**
 * What the core knows of OpenClaw without loading its code: declared data, read off OpenClaw 2026.11.2 on Linux and
 * macOS (`__fixtures__/`, docs/superpowers/specs/2026-11-10-openclaw-engine-design.md). It imports nothing of
 * OpenClaw's code.
 */
import { join, resolve } from 'node:path'
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
 * a local Gateway from one on another host. It word-wraps like the footer: a Harness key (`harness-<uuid>`) makes it
 * about 103 characters, so under that many columns the URL is read off its first line and the session off its lines
 * joined.
 */
const TITLE_START = /^\s*openclaw tui - (wss?:\/\/\S+) - agent /
const TITLE = /^openclaw tui - wss?:\/\/\S+ - agent ([A-Za-z0-9_-]{1,64})(?: \([^)]*\))? - session ([A-Za-z0-9._:-]{1,128})$/

/** The composer's borders: the two rules under the footer are the last lines a running TUI draws. */
export const OPENCLAW_RULE = /^\s*─{8,}\s*$/

/**
 * The status line, the last line above the footer: `connected | idle`, `gateway reconnected | idle`, `connected |
 * aborted`, `⠏ running • 6s | connected`, `gateway disconnected: <error> | idle`.
 */
const STATUS = {
  ready: /^(?:gateway )?(?:connected|reconnected) \| (?:idle|aborted|error)$/,
  busy: /^\S{1,2} (?:running|streaming|connecting)\b/,
  /** A run in progress; `connecting` is the TUI still reaching its Gateway, before any run. */
  running: /^\S{1,2} (?:running|streaming)\b/,
  noGateway: /^gateway disconnected\b/,
  /** The connection dropped or just came back: `gateway disconnected: …` (5 s), `disconnected` after it, `gateway
   * reconnected` (4 s; `setConnectionStatus` in OpenClaw's tui). */
  gatewayLost: /^(?:gateway )?(?:disconnected|reconnected)\b/,
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
  /** The status line says the Gateway connection dropped or just came back. */
  gatewayLost: boolean
  /** The status line says a run is in progress: `running` or `streaming`, not `connecting`. */
  running: boolean
}

const NOTHING: OpenclawScreen = { key: null, url: null, state: null, footer: null, gatewayLost: false, running: false }

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
 * The title from its first line, joined with the lines it wrapped onto until it reads whole. Null when it never
 * does (a key cut mid-word, a title-like line in the chat).
 */
function readTitle(lines: readonly string[], start: number): RegExpExecArray | null {
  let text = ''
  for (let i = start; i < lines.length && lines[i].trim() && !OPENCLAW_RULE.test(lines[i]); i++) {
    text = text ? `${text} ${lines[i].trim()}` : lines[i].trim()
    const title = TITLE.exec(text)
    if (title) return title
  }
  return null
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
  const titled = lastIndex(lines, (line) => TITLE_START.test(line))
  const url = titled >= 0 ? TITLE_START.exec(lines[titled])![1] : null
  const title = titled >= 0 ? readTitle(lines, titled) : null
  const remote = url !== null && !LOOPBACK.test(url)
  const footer = start >= 0 && titled <= start ? liveFooter(lines, start) : null
  if (!footer) return { ...NOTHING, url, state: remote ? 'remote' : null }
  const shown = FOOTER.exec(footer)
  // A title on screen that cannot be read whole agrees with no footer.
  const agrees = titled < 0 || (!!title && !!shown && title[1] === shown[1] && title[2] === shown[2])
  const status = lastIndex(lines.slice(0, start), (line) => !!line.trim())
  const said = status >= 0 ? lines[status].trim() : ''
  const state: OpenclawPaneState | null = remote ? 'remote'
    : STATUS.noGateway.test(said) ? 'no-gateway'
      : STATUS.busy.test(said) ? 'busy'
        : STATUS.ready.test(said) ? 'ready' : null
  return {
    key: shown && agrees ? `agent:${shown[1]}:${shown[2]}` : null,
    url,
    state,
    footer,
    gatewayLost: STATUS.gatewayLost.test(said),
    running: STATUS.running.test(said),
  }
}

/**
 * How the TUI is started. A bare `openclaw tui` opens the last session any TUI used, so a launch always names one;
 * `--session <key>` creates or attaches `agent:main:<key>`, and a full key as the target resumes it.
 */
export const OPENCLAW_LAUNCH = {
  base: ['tui'],
  newSession: (agentId: string): string[] => ['--session', `harness-${agentId}`],
  resume: (key: string): string[] => [key],
  /**
   * The first prompt is typed into the pane, never given in argv: the TUI sends `--message` once, after its first
   * Gateway connection, and never again (OpenClaw 2026.11.2 `state.autoMessageSent`), so a TUI started before its
   * Gateway would drop it.
   */
  firstPrompt: 'typed',
  /** The daemon's variables a TUI starts with, so it opens the state folder Harness reads. */
  environment: ['OPENCLAW_STATE_DIR', 'OPENCLAW_HOME'],
} as const

/** What a person reads when OpenClaw cannot work for Harness, each with what to do about it. */
export const OPENCLAW_STATES = {
  noGateway: 'OpenClaw Gateway is not running. Start it with openclaw gateway.',
  noToken: 'OpenClaw has no Gateway token. Run openclaw onboard.',
  oldNode: 'OpenClaw needs Node 24.',
  /** Harness's own Node lacks what reads OpenClaw's store (`node:sqlite`, zstd). */
  harnessNode: 'This Harness needs Node 24 to read OpenClaw.',
  remote: 'This OpenClaw runs on another machine.',
  unsupported: 'This OpenClaw version is not supported yet.',
  /** A run is in progress and Harness's state folder holds no session for it: the Gateway writes to another folder. */
  noSessions: "Harness cannot find this OpenClaw's sessions. Start Harness with the Gateway's OPENCLAW_STATE_DIR, then restart this agent.",
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

/** A leading `~` alone or before a separator, as OpenClaw's `expandHomePrefix` (`~user` is left as written). */
const HOME_PREFIX = /^~(?=$|[\\/])/

/**
 * The state folder OpenClaw opens when nothing else names one, as its `resolveStateDir`: `OPENCLAW_STATE_DIR`, else
 * `<home>/.openclaw`, where home is `OPENCLAW_HOME` when set, else the OS home. Both are trimmed, a blank one is unset,
 * and a leading `~` is expanded: `OPENCLAW_HOME`'s against the OS home, `OPENCLAW_STATE_DIR`'s against that home.
 */
export function openclawDefaultStateDir(vars: Readonly<Record<string, string | undefined>>, osHome: string): string {
  const named = vars.OPENCLAW_HOME?.trim()
  const home = named ? resolve(named.replace(HOME_PREFIX, () => osHome)) : resolve(osHome)
  const stateDir = vars.OPENCLAW_STATE_DIR?.trim()
  return stateDir ? resolve(stateDir.replace(HOME_PREFIX, () => home)) : resolve(home, '.openclaw')
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
