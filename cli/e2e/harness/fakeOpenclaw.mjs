// A stand-in for OpenClaw 2026.11.2's `openclaw`, run in a real tmux pane by the daemon under test
// (e2e/openclawShow.e2e.ts). It does what the daemon reads of an OpenClaw, as OpenClaw does it, and nothing more:
//
//   - answers `--version` as 2026.11.2 does, or, with `oldNode`, as it does on a Node it cannot run on
//     (`src/engines/openclaw/__fixtures__/version-old-node-darwin.txt`);
//   - `tui [--session <key> | <agent:id:key>] [--local]` renames its process `openclaw` (`ps-*.txt`), resolves its
//     state folder as `openclawDefaultStateDir` does, keeps `<state>/state/openclaw.sqlite` open for its whole run (the
//     daemon finds the folder from the files the process holds), and creates the agent store from `schema.sql` when it
//     is missing. With `noToken` it prints what `screen-no-token.txt` recorded and exits 1;
//   - draws whole screens at the pane's size, its scrollback cleared as pi-tui's full render clears it, only shapes
//     recorded from 2026.11.2 (`__fixtures__/screen-*.txt`) or by the reproduction of
//     docs/plans/2026-11-19-openclaw-show-goal-design.md: the banner with no footer, then the title, the chat (system
//     lines one space in), the status line, the footer and the input box between two rules.
//     Its startup draws `connecting | idle`, then `⠙ starting up • Ns | subscribing to session events` while its
//     history loads, ` history failed: …` in the chat when the load fails, then `gateway connected | idle`
//     (`gateway reconnected` after a drop), which reads `connected` from 4 s on, drawn by the next render as the TUI
//     draws it. `auto` walks it in about 2 s; `manual` waits for an `advance` step before each step, up to the first
//     connection's outcome. A busy line redraws each second with its timer;
//   - takes input as the TUI does (tui 6164-6188, 2722-2805): typed text and bracketed pastes go into the box at its
//     cursor, which pi-tui's editor keeps as lines and a cursor (`node_modules/@earendil-works/pi-tui/dist/components/
//     editor.js`: `insertTextAtCursorInternal` 961-995, line endings and tabs as `normalizeText` 953 makes them), Enter
//     submits, and C-u deletes from the cursor to its line's start, or at column 0 joins the line above, the cursor at
//     that line's old end (`deleteToStartOfLine` 1358-1384, `tui.editor.deleteToLineStart` in `keybindings.js` 63). A
//     message is refused while not connected, while its history is not loaded, or while a run is pending, and goes back
//     into the box as `setText` puts it, the cursor at its end (921-933, 371): the message, then on a line of its own
//     whatever the box held by then (tui 6164-6167); `/session <key>` loads history again when it is not loaded and
//     leaves the box empty. A load that succeeds clears the chat and adds ` session <key>`;
//   - meets a Gateway that refuses its sign-in as the TUI draws it (tui 7623-7657, `resolveGatewayDisconnectState`
//     6636-6647, with `classifyGatewayConnectFailure` and the remedies of `dist/connect-error-details-DhaB57zU.mjs`
//     234-290): `gateway disconnected: <reason> | <activity>` for 5 s, then `disconnected | <activity>`, the activity
//     kept between tries and the remedy printed in the chat once an outage. The reasons are the Gateway's own
//     (`dist/message-handler-DiZ30TB5.mjs` 788-801, the TUI an operator UI client; a pairing request's 2201-2208; a
//     proxy's upgrade rejection, `dist/client-BFZnuo31.mjs` 1171-1197). A TUI waiting for its pairing, or behind a
//     proxy, tries again on its backoff; one whose token or sign-in rate the Gateway refused tries no more
//     (`shouldPauseGatewayReconnect`, client 900-925, `tokenMismatchIsTerminal` 1539-1553), and nothing in the TUI
//     connects it again. Each retry of a pairing refusal, its Gateway client prints `gateway connect failed: <error>`
//     straight to the terminal (`dist/client-BFZnuo31.mjs` 1508-1510, `logError`; a probe, a rate limit and a stopped
//     client print none), where the TUI left the cursor, in its input box: over the box and its bottom rule, then on below
//     the frame, which scrolls up (`screen-pairing-retries*.txt`). The TUI draws over them only once it connects;
//   - when its Gateway acknowledges a message as failed before its run started (tui 3313, 3375-3389), draws `sending`
//     until then, drops the message from the chat, loads the history again and adds ` send failed: Chat failed before
//     the run started; try again.` with the activity `error`. The Gateway writes no row;
//   - with `respawn`, starts its TUI as OpenClaw's launcher does on a Node it does not admit (`recoverNodeRuntime` and
//     `runRespawnedChild` in `node-runtime-recovery.mjs` 739-767 and 46-179; `openclaw.mjs` 112-149 starts it so for
//     its compile cache too): it checks the Node it found in a child of its own, then runs the same script and
//     arguments in another, `OPENCLAW_NODE_UPDATE_RESPAWNED=1`, its terminal inherited, signals passed on; the launcher
//     keeps its node argv, waits, and exits as the child did. The child is the TUI. OpenClaw 2026.11.2 on Node 24.3
//     (macOS 26.6) did so: its launcher alone for 0.18 s, then the TUI, a bare `openclaw` 0.1 s later;
//   - for an accepted message, writes into the agent store, in the Gateway's place, the rows a recorded scenario wrote
//     (`plain.sql`, `tool.sql`, `fail.sql`, `approval.sql`, a heartbeat run of `main-heartbeat.sql`), the key, ids,
//     times and the message replaced, and draws the run: `sending`, a waiting phrase, `running`, the answer, idle.
//
// It talks to no Gateway and no model: the Gateway's states reach the daemon only through the screen and the store, so
// the test sets them with steps. It draws no tool output, overlay or picker, keeps no input history, and runs no
// command but `/session <key>`.
//
// Steps, one JSON object a line in `options.steps`, read from where the file ended when the TUI started:
//   {"advance":true}                       the next step of a `manual` startup
//   {"gateway":"down"|"up"}                down drops a connection, and every try fails (`gateway disconnected:
//                                          connect ECONNREFUSED …` for 5 s, `disconnected` after it) until up;
//                                          the tries come 1, 2, 4, 8, 16, then 30 s apart, as the TUI's backoff
//   {"gateway":"pairing"|"token"|"rate-limited"|"proxy"}
//                                          as down, every try refused with that sign-in, drawn as above; a token or a
//                                          rate limit stops the tries at the first, so up connects it no more
//   {"blip":<ms>}                          a drop that reconnects by itself after <ms>
//   {"history":"ok"|"fail"|"fail-always","historyMs"?:<ms>}
//                                          how the next loads end (`fail`: the next one fails), and how long they take
//   {"next":{"reply":"plain"|"tool"|"list"|"approval"|"fail"|"send-failed","quietMs"?:<ms>,"hold"?:"send",
//            "heartbeats"?:<n>,"sendMs"?:<ms>}}
//                                          what the next accepted message does: `quietMs` a tool step that writes
//                                          nothing that long; `hold` stays sending, with no row, until a release;
//                                          `heartbeats` that many heartbeat runs after the answer; `send-failed` its
//                                          send acknowledged as failed after `sendMs`
//   {"release":"send"}
//   {"refuseNext":"disconnected","historyMs":<ms>,"history"?:"fail"}
//                                          the next message meets a Gateway drop: refused, back in the box, and the
//                                          TUI reconnects at once with a history load of <ms>, which fails with `fail`
//   {"localStop":"<reason>"}               a `--local` run's runtime stops: `local runtime stopped: <reason> | idle`,
//                                          `local stopped | idle` from 5 s on, drawn by the next render
//   {"exit":<code>}
// Events, one JSON object a line it appends to `options.events`, each with its time `at` in ms: {"started":<args>},
// {"drawn":<status line>} each time the status changes, {"submitted":<box text>}, {"accepted":<text>},
// {"refused":<reason>}, {"command":"/session <key>"}, {"history":"ok"|"failed"}, {"keyed":"C-u","box":<box text after>}.
import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync, watch } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'

const FIXTURES = join(import.meta.dirname, '..', '..', 'src', 'engines', 'openclaw', '__fixtures__')
const fixture = (name) => readFileSync(join(FIXTURES, name), 'utf8')
const VERSION = 'OpenClaw 2026.11.2 (b556fdf)'
const BANNER = ['│', '◇', '', `🦞 ${VERSION} — I have a SOUL.md and I'm not afraid to use it.`]
/** OpenClaw's own Gateway address, as every recorded screen names it. */
const GATEWAY = '127.0.0.1:18789'
const UNREACHABLE = `connect ECONNREFUSED ${GATEWAY}`
const REFUSED_CONNECTION = `gateway disconnected: ${UNREACHABLE}`
const HISTORY_FAILED = 'history failed: gateway request timeout for chat.history'
const REFUSED = {
  disconnected: 'not connected to gateway — message not sent',
  'session-loading': 'session history not ready — wait or retry /session',
  pending: 'agent is busy — press Esc to abort before sending a new message',
}
const LOCAL_REFUSED = 'local runtime not ready — message not sent'
const RUN_ERROR = 'run error: This model was not found. Choose another model in the Control UI.'
/** `TERMINAL_CHAT_SEND_FAILURE_MESSAGE` (tui 2758), after `send failed: `. */
const SEND_FAILED = 'send failed: Chat failed before the run started; try again.'
/**
 * Each way a Gateway that is not up refuses the TUI's tries: the reason drawn, the activity `resolveGatewayDisconnectState`
 * gives it, the remedy printed, and whether the TUI tries again. `down` is nothing listening; the rest are the sign-ins it
 * refuses. A pairing request's id is one per request, new each outage.
 */
const REFUSALS = {
  down: { reason: () => UNREACHABLE, activity: 'idle', remedy: null, retries: true },
  pairing: {
    reason: () => `device pairing required (requestId: ${randomUUID()})`,
    activity: 'device approval needed: preview latest request',
    remedy: 'Run `openclaw devices approve --latest` to preview the pending request, then rerun the printed `openclaw devices approve <requestId>` command and reconnect (pass the same --url and --token/--password flags if you connected with explicit credentials).',
    retries: true,
    printed: 'GatewayClientRequestError',
  },
  token: {
    reason: () => 'unauthorized: gateway token mismatch (open the dashboard URL and paste the token in Control UI settings)',
    activity: 'gateway authentication needs attention',
    remedy: 'Verify `gateway.remote.token` matches `gateway.auth.token`. If a paired-device token is stale, rotate it with `openclaw devices rotate --device <deviceId> --role operator`, then reconnect.',
    retries: false,
  },
  'rate-limited': {
    reason: () => 'unauthorized: too many failed authentication attempts (retry later)',
    activity: 'gateway authentication temporarily rate-limited',
    remedy: 'Wait for the temporary authentication lockout to expire, then retry.',
    retries: false,
  },
  proxy: {
    reason: () => 'gateway rejected websocket upgrade (HTTP 401)',
    activity: 'identity-aware proxy rejected connection',
    remedy: 'An identity-aware proxy rejected the WebSocket upgrade. Configure gateway.remote.edgeAuth for the configured Gateway origin, then reconnect. See https://docs.openclaw.ai/gateway/remote#gateway-behind-an-identity-aware-proxy.',
    retries: true,
  },
}
/** What OpenClaw's launcher sets on the TUI it starts again on another Node (`node-runtime-recovery.mjs` 763-767). */
const RESPAWNED = 'OPENCLAW_NODE_UPDATE_RESPAWNED'
/** The launcher's check of that Node (`node-runtime-recovery.mjs` 401-416, `probeSqlite` in `node-sqlite.mjs` 4-31). */
const SQLITE_PROBE = 'const db = new (require("node:sqlite").DatabaseSync)(":memory:"); process.stdout.write(JSON.stringify({ version: process.versions.node, sqlite: db.prepare("SELECT sqlite_version() AS version").get().version })); db.close()'
/** The signals the launcher passes on to it (`node-runtime-recovery.mjs` 39-42). */
const RESPAWN_SIGNALS = ['SIGTERM', 'SIGINT', 'SIGHUP', 'SIGQUIT']
const SPINNER = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'
/** The activities drawn as a spinner and a timer (tui 6740-6747); `waiting` as a random phrase, here one recorded. */
const BUSY = new Set(['sending', 'waiting', 'streaming', 'running', 'starting up'])
const WAITING = 'flibbertigibbeting…'
const BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000]
/** How long each step of an `auto` startup, and a history load, takes. */
const STEP_MS = 500
const MODEL = 'deepseek/deepseek-v4.1-flash'
const HEARTBEAT_POLL = '[OpenClaw heartbeat poll]'
/** A reply ending in a numbered list, as a model writes one: text, not a dialog. */
const LIST = 'Three ways to fix it:\n1. Retry the request\n2. Raise the timeout\n3. Cache the result\nWhich one do you want?'
const SCENARIOS = { plain: 'plain', list: 'plain', tool: 'tool', fail: 'fail', approval: 'approval' }

/**
 * The text of the `openclaw` the test writes at `OPENCLAW_PATH`.
 *
 * `steps`: the file of JSON lines the test appends to (it must exist). `events`: the file the fake appends its events
 * to. `oldNode`: `--version` answers as on a Node OpenClaw cannot run on. `noToken`: the TUI finds no Gateway token.
 * `startup`: `auto` (the default) or `manual`. `history`: how its history loads end, `ok` by default. `respawn`: its
 * launcher starts the TUI as a child of its own, as OpenClaw's does.
 *
 * @param {{ steps: string, events: string, oldNode?: boolean, noToken?: boolean, startup?: 'auto' | 'manual', history?: 'ok' | 'fail' | 'fail-always', respawn?: boolean }} options
 */
export function fakeOpenclawScript(options) {
  return `#!${process.execPath}\nimport(${JSON.stringify(pathToFileURL(import.meta.filename).href)}).then((m) => m.run(${JSON.stringify(options)}))\n`
}

/** The fake itself, in the `openclaw` process. */
export function run(options) {
  const args = process.argv.slice(2)
  if (args.includes('--version')) {
    process.stdout.write(options.oldNode ? fixture('version-old-node-darwin.txt') : `${VERSION}\n`)
    process.exit(0)
  }
  if (args[0] !== 'tui') {
    process.stderr.write(`this fake OpenClaw runs only --version and tui, not ${args.join(' ')}\n`)
    process.exit(1)
  }
  if (options.respawn && process.env[RESPAWNED] !== '1') {
    spawnSync(process.execPath, ['-e', SQLITE_PROBE], { stdio: ['ignore', 'pipe', 'pipe'], env: { NODE_NO_WARNINGS: '1' }, timeout: 5_000 })
    const child = spawn(process.execPath, [...process.execArgv, process.argv[1], ...args], { stdio: 'inherit', env: { ...process.env, [RESPAWNED]: '1' } })
    const passOn = RESPAWN_SIGNALS.map((signal) => [signal, () => child.kill(signal)])
    for (const [signal, listener] of passOn) process.on(signal, listener)
    child.once('close', (code, signal) => {
      for (const [name, listener] of passOn) process.off(name, listener)
      // As the launcher ends: by the child's signal, or with its code.
      if (signal) process.kill(process.pid, signal)
      else process.exitCode = code ?? 1
    })
    return
  }
  // Every `openclaw` command renames its process so (`ps-*.txt`): its argv never shows the session.
  process.title = 'openclaw'
  // Node's warning that node:sqlite is experimental would be drawn in the pane.
  process.removeAllListeners('warning')
  const { DatabaseSync } = process.getBuiltinModule('node:sqlite')
  const log = (event) => appendFileSync(options.events, `${JSON.stringify({ at: Date.now(), ...event })}\n`)
  // Where the steps start, read before the TUI says it started: the test appends a TUI's steps once it reads that, and
  // read later, after the stores open, the first ones were skipped.
  let offset = statSync(options.steps).size
  log({ started: args })
  if (options.noToken) {
    // The recorder marked the exit with a line of its own, `[exit 1]`: not OpenClaw's.
    const lines = fixture('screen-no-token.txt').split('\n').filter((line) => !/^\[exit \d+\]$/.test(line))
    process.stdout.write(`${lines.join('\r\n').trimEnd()}\r\n`)
    process.exit(1)
  }

  const local = args.includes('--local')
  const named = args.includes('--session') ? args[args.indexOf('--session') + 1] : args.slice(1).find((arg) => !arg.startsWith('-'))
  let key = !named ? 'agent:main:main' : named.startsWith('agent:') ? named : `agent:main:${named}`
  const agentId = key.split(':')[1]
  // `resolveStateDir`: OPENCLAW_STATE_DIR, else <OPENCLAW_HOME or the OS home>/.openclaw, a leading `~` expanded.
  const tilde = (path, home) => resolve(path.replace(/^~(?=$|\/)/, home))
  const home = process.env.OPENCLAW_HOME?.trim() ? tilde(process.env.OPENCLAW_HOME.trim(), homedir()) : homedir()
  const stateDir = process.env.OPENCLAW_STATE_DIR?.trim() ? tilde(process.env.OPENCLAW_STATE_DIR.trim(), home) : join(home, '.openclaw')
  mkdirSync(join(stateDir, 'state'), { recursive: true })
  const own = new DatabaseSync(join(stateDir, 'state', 'openclaw.sqlite'))
  own.exec('PRAGMA journal_mode = WAL')
  // Held to the end: a handle nothing refers to is collected, and its file closed with it.
  process.on('exit', () => own.close())
  const agentDir = join(stateDir, 'agents', agentId, 'agent')
  const storePath = join(agentDir, 'openclaw-agent.sqlite')
  const fresh = !existsSync(storePath)
  mkdirSync(agentDir, { recursive: true })
  const store = new DatabaseSync(storePath)
  store.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;')
  if (fresh) {
    store.exec(fixture('schema.sql'))
    store.prepare("INSERT INTO schema_meta (meta_key, role, schema_version, agent_id, app_version, created_at, updated_at) VALUES ('primary', 'agent', 27, ?, '2026.11.2', ?, ?)")
      .run(agentId, Date.now(), Date.now())
  }

  // ── the store, written as the Gateway writes a run ──────────────────────────────────────────────────────────────

  const recorded = new Map()
  /** A recorded scenario's window, its rows decoded. */
  const scenario = (name) => {
    if (recorded.has(name)) return recorded.get(name)
    const db = new DatabaseSync(':memory:')
    db.exec(fixture('schema.sql'))
    db.exec(fixture(`${name}.sql`))
    const node = db.prepare('SELECT * FROM session_nodes').get()
    const window = db.prepare('SELECT * FROM session_windows WHERE session_id = ?').get(node.current_session_id)
    const active = new Map(db.prepare('SELECT * FROM session_transcript_active_events WHERE session_id = ?').all(window.session_id)
      .map((row) => [row.event_seq, row]))
    const rows = db.prepare('SELECT * FROM transcript_events WHERE session_id = ? ORDER BY seq').all(window.session_id).map((row) => ({
      row, active: active.get(row.seq) ?? null,
      record: JSON.parse(row.event_json ?? zstdDecompressSync(row.event_zstd).toString('utf8')),
    }))
    db.close()
    const found = { node, window, rows }
    recorded.set(name, found)
    return found
  }
  /** The rows of one run: from [first] to the next user row. */
  const runOf = (rows, first) => {
    const start = rows.indexOf(first)
    const next = rows.findIndex((row, i) => i > start && row.record.message?.role === 'user')
    return rows.slice(start, next < 0 ? undefined : next)
  }
  const insert = (table, row) => {
    const columns = Object.keys(row)
    store.prepare(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`).run(...columns.map((column) => row[column]))
  }
  const swap = (text, ids) => {
    if (typeof text !== 'string') return text
    for (const [from, to] of ids) text = text.replaceAll(from, to)
    return text
  }
  let window = null
  /** The key's window, made with its node, header and watermark on its first message, as the Gateway makes them. */
  const openWindow = (recording) => {
    const node = store.prepare('SELECT current_session_id AS id FROM session_nodes WHERE session_key = ?').get(key)
    if (node) {
      const seq = store.prepare('SELECT max(seq) AS seq FROM transcript_events WHERE session_id = ?').get(node.id).seq
      const at = store.prepare('SELECT max(active_position) AS position, max(message_position) AS message FROM session_transcript_active_events WHERE session_id = ?').get(node.id)
      return { id: node.id, seq: (seq ?? 0) + 1, position: (at.position ?? -1) + 1, message: (at.message ?? -1) + 1, last: null }
    }
    const id = randomUUID()
    const now = Date.now()
    const ids = [[recording.window.session_id, id], [recording.node.session_key, key]]
    const header = recording.rows[0]
    const record = JSON.stringify({ ...header.record, id, timestamp: new Date(now).toISOString(), cwd: process.cwd() })
    store.exec('BEGIN')
    insert('session_nodes', { ...recording.node, session_key: key, current_session_id: id, entry_json: swap(recording.node.entry_json, ids),
      status: 'running', created_at: now, updated_at: now, session_started_at: now, last_interaction_at: now, last_activity_at: now })
    insert('session_windows', { ...recording.window, session_id: id, session_key: key, row_transcript_json: swap(recording.window.row_transcript_json, ids),
      status: 'running', created_at: now, updated_at: now, started_at: now, ended_at: null, transcript_updated_at: now,
      row_transcript_updated_at: now, transcript_observed_at: now })
    insert('transcript_events', { ...header.row, session_id: id, event_json: record, event_utf8_bytes: Buffer.byteLength(record), created_at: now })
    insert('transcript_rewrite_watermarks', { session_id: id, generation: randomUUID().replaceAll('-', ''), updated_at: now })
    store.exec('COMMIT')
    return { id, seq: 1, position: 0, message: 0, last: null }
  }
  /** A run's new names for what a recording named: its window and key, each event's id, the run's id. */
  const renamed = (recording, rows) => {
    const ids = new Map([[recording.window.session_id, window.id], [recording.node.session_key, key]])
    for (const { record } of rows) {
      if (record.id) ids.set(record.id, randomUUID())
      const runId = record.message?.idempotencyKey?.split(':')[0]
      if (runId) ids.set(runId, randomUUID())
    }
    return ids
  }
  /** Writes [rows] of a recording into the key's window, renamed by [ids], at the time now. */
  const write = (rows, ids, change = (record) => record) => {
    const now = Date.now()
    store.exec('BEGIN')
    for (const { row, active, record } of rows) {
      const next = change(JSON.parse(swap(JSON.stringify(record), ids)))
      next.timestamp = new Date(now).toISOString()
      if (typeof next.message?.timestamp === 'number') next.message.timestamp = now
      // A run's first row hangs from the window's last one, which a recording of another window cannot name.
      if (next.parentId !== undefined && !ids.has(record.parentId)) next.parentId = window.last
      const json = JSON.stringify(next)
      insert('transcript_events', { ...row, session_id: window.id, seq: window.seq, created_at: now,
        event_json: row.event_zstd ? null : json, event_zstd: row.event_zstd ? zstdCompressSync(json) : null,
        event_utf8_bytes: Buffer.byteLength(json), navigation_json: swap(row.navigation_json, ids) })
      if (active) {
        insert('session_transcript_active_events', { session_id: window.id, active_position: window.position++, event_seq: window.seq,
          message_position: active.message_position === null ? null : window.message++, context_eligible: active.context_eligible })
      }
      window.last = next.id ?? window.last
      window.seq++
    }
    store.exec('COMMIT')
  }
  const setStatus = (status) => {
    const now = Date.now()
    store.prepare('UPDATE session_nodes SET status = ?, updated_at = ?, last_activity_at = ? WHERE session_key = ?').run(status, now, now, key)
    store.prepare('UPDATE session_windows SET status = ?, updated_at = ?, transcript_updated_at = ? WHERE session_id = ?').run(status, now, now, window.id)
  }

  // ── the screen ─────────────────────────────────────────────────────────────────────────────────────────────────

  /** [printed]: what the Gateway client wrote over the TUI's screen since it last connected. */
  const ui = { tui: false, chat: [], connection: '', activity: 'idle', since: Date.now(), model: 'unknown', tokens: '?', printed: [] }
  /** The input box as pi-tui's editor keeps it: its lines, and the cursor's line and column in them. */
  const box = { lines: [''], line: 0, col: 0 }
  const boxText = () => box.lines.join('\n')
  /** `normalizeText` (editor.js 953): `\r\n` and `\r` to `\n`, a tab to four spaces. */
  const normalized = (text) => text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\t/g, '    ')
  /** `setText`: the text whole, the cursor at its end. */
  const setBox = (text) => {
    box.lines = normalized(text).split('\n')
    box.line = box.lines.length - 1
    box.col = box.lines[box.line].length
  }
  /** `insertTextAtCursorInternal`: [text] at the cursor, the cursor after it. */
  const insertAtCursor = (text) => {
    const inserted = normalized(text).split('\n')
    const current = box.lines[box.line]
    const before = current.slice(0, box.col), after = current.slice(box.col)
    const lines = [before + inserted[0], ...inserted.slice(1)]
    box.col = lines.at(-1).length
    lines[lines.length - 1] += after
    box.lines.splice(box.line, 1, ...lines)
    box.line += lines.length - 1
  }
  /** `deleteToStartOfLine`: Ctrl+U. */
  const deleteToLineStart = () => {
    if (box.col > 0) {
      box.lines[box.line] = box.lines[box.line].slice(box.col)
      box.col = 0
    } else if (box.line > 0) {
      const above = box.lines[box.line - 1]
      box.lines.splice(box.line - 1, 2, above + box.lines[box.line])
      box.line--
      box.col = above.length
    }
  }
  /** The person's messages and the answers, drawn again when a history load clears the chat. */
  const transcript = []
  const system = (text) => ({ system: true, text })
  const said = (text) => ({ system: false, text })
  let lastDrawn = null
  const short = () => key.split(':').slice(2).join(':')
  const statusLine = () => {
    if (!BUSY.has(ui.activity)) return `${ui.connection} | ${ui.activity}`
    const seconds = Math.floor((Date.now() - ui.since) / 1_000)
    const elapsed = seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`
    return `${SPINNER[Math.floor(Date.now() / 80) % SPINNER.length]} ${ui.activity === 'waiting' ? WAITING : ui.activity} • ${elapsed} | ${ui.connection}`
  }
  /** A line of the TUI's own (title, system line, status, footer): one space in, wrapped between words. */
  const wrapped = (text, width) => {
    const lines = []
    let line = ''
    for (const word of text.split(' ')) {
      if (line && line.length + 1 + word.length > width - 2) { lines.push(` ${line}`); line = word }
      else line = line ? `${line} ${word}` : word
    }
    return [...lines, ` ${line}`]
  }
  /** What the person or the model wrote: from column 0, cut at the width. */
  const cut = (text, width) => text.split('\n').flatMap((line) => line ? line.match(new RegExp(`.{1,${width}}`, 'gu')) : [''])
  /** Draws once whatever this tick changed, as the TUI's render request does: no state set half-way is drawn. */
  let requested = false
  const render = () => {
    if (requested) return
    requested = true
    setImmediate(() => { requested = false; draw() })
  }
  const draw = () => {
    const width = process.stdout.columns || 80
    const lines = [...BANNER]
    if (ui.tui) {
      const url = local ? 'local embedded' : `ws://${GATEWAY}`
      lines.push(...wrapped(`openclaw tui - ${url} - agent ${agentId} - session ${short()}`, width), '')
      ui.chat.forEach((entry, i) => lines.push(...(i ? [''] : []), ...(entry.system ? wrapped(entry.text, width) : cut(entry.text, width))))
      const status = statusLine()
      const drawn = BUSY.has(ui.activity) ? `${ui.activity} | ${ui.connection}` : status
      if (drawn !== lastDrawn) { lastDrawn = drawn; log({ drawn: status }) }
      lines.push(...wrapped(status, width), ...wrapped(`agent ${agentId} | session ${short()} | ${ui.model} | deliver:off | tokens ${ui.tokens}`, width))
      const boxAt = lines.length + 1
      lines.push('─'.repeat(width), ...cut(boxText(), width), '─'.repeat(width))
      // From the box's first line, where the cursor of the recorded screens' empty box was, each over what is drawn there.
      ui.printed.flatMap((text) => cut(text, width)).forEach((part, i) => {
        lines[boxAt + i] = part + (lines[boxAt + i] ?? '').slice(part.length)
      })
    }
    // As pi-tui's full render: screen, home, then scrollback cleared. Without the last, tmux keeps each cleared screen in
    // the scrollback the daemon reads, and a line the TUI no longer draws (` history failed:`) was read there for good.
    process.stdout.write(`\x1b[2J\x1b[H\x1b[3J${lines.slice(-(process.stdout.rows || 24)).join('\r\n')}`)
  }
  let ttl = null
  /**
   * The connection's part of the status line. One that lasts [ms] then gives way to what the connection is, which the
   * TUI sets without a render (tui 7173-7180; pi-tui's `setText` requests none): the next render draws it. [redrawn]:
   * one comes as it expires.
   */
  const setConnection = (text, ms, redrawn = false) => {
    clearTimeout(ttl)
    ui.connection = text
    if (ms) {
      ttl = setTimeout(() => {
        ui.connection = connected ? (local ? 'local ready' : 'connected') : (local ? 'local stopped' : 'disconnected')
        if (redrawn) render()
      }, ms)
    }
    render()
  }
  /** A refused try, or the drop: between its tries the TUI is redrawn (a resize, a key) and reads `disconnected` alone,
   *  the line Harness must hold through (the design's finding 4). */
  const disconnected = () => setConnection(REFUSED_CONNECTION, 5_000, true)
  const setActivity = (activity) => {
    if (activity !== ui.activity) ui.since = Date.now()
    ui.activity = activity
    render()
  }
  const addSystem = (text) => { ui.chat.push(system(text)); render() }
  setInterval(() => { if (ui.tui && BUSY.has(ui.activity)) render() }, 1_000)
  process.stdout.on('resize', render)

  // ── the connection ─────────────────────────────────────────────────────────────────────────────────────────────

  /** [gateway]: null while it is up, else how it refuses every try ({@link REFUSALS}, its reason fixed for the outage). */
  let connected = false, everConnected = false, historyLoaded = false, gateway = null, remedyShown = false
  const FAILURES = { ok: 0, fail: 1, 'fail-always': Infinity }
  let failures = FAILURES[options.history ?? 'ok']
  let loadMs = STEP_MS
  let manual = options.startup === 'manual', advances = 0, waiting = null
  let tries = 0, retry = null
  /** The next step of the startup: after [ms], or, while it is manual, on the next advance. */
  const proceed = (step, ms) => {
    if (!manual) { setTimeout(step, ms); return }
    if (advances > 0) { advances--; step() } else waiting = step
  }
  const loadHistory = () => {
    if (failures > 0) {
      failures--
      addSystem(HISTORY_FAILED)
      log({ history: 'failed' })
      return
    }
    historyLoaded = true
    ui.model = MODEL
    ui.tokens = '0/1.0m (0%)'
    ui.chat = [system(`session ${key}`), ...transcript]
    log({ history: 'ok' })
    render()
  }
  const tryConnect = (ms = loadMs) => {
    retry = null
    if (gateway) {
      manual = false
      if (gateway.printed && gateway.tried++) ui.printed.push(`gateway connect failed: ${gateway.printed}: ${gateway.reason}`)
      setConnection(`gateway disconnected: ${gateway.reason}`, 5_000, true)
      setActivity(gateway.activity)
      if (gateway.remedy && !remedyShown) { remedyShown = true; addSystem(gateway.remedy) }
      if (gateway.retries) retry = setTimeout(tryConnect, BACKOFF_MS[Math.min(tries++, BACKOFF_MS.length - 1)])
      return
    }
    // Once an outage, its remedy (tui 7561).
    remedyShown = false
    setConnection('subscribing to session events')
    if (!BUSY.has(ui.activity)) setActivity('starting up')
    proceed(() => {
      manual = false
      tries = 0
      loadHistory()
      connected = true
      ui.printed = []
      if (ui.activity === 'starting up') setActivity('idle')
      if (everConnected && !local) addSystem('gateway reconnected after transport loss')
      setConnection(local ? 'local ready' : everConnected ? 'gateway reconnected' : 'gateway connected', 4_000)
      everConnected = true
    }, ms)
  }
  /** The Gateway went away: the next try comes in [ms]. */
  const drop = (ms) => {
    clearTimeout(retry)
    connected = false
    historyLoaded = false
    disconnected()
    setActivity('idle')
    retry = setTimeout(tryConnect, ms)
  }

  // ── a run ──────────────────────────────────────────────────────────────────────────────────────────────────────

  const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
  let pending = false, plan = null, refuseNext = null, release = null
  /** [entry]: the message as the chat and the transcript show it. */
  const runMessage = async (text, next, entry) => {
    pending = true
    if (next.reply === 'send-failed') {
      setActivity('sending')
      await sleep(next.sendMs ?? 300)
      // No row was written: the history the TUI loads again holds no such message.
      transcript.splice(transcript.indexOf(entry), 1)
      pending = false
      loadHistory()
      addSystem(SEND_FAILED)
      setActivity('error')
      return
    }
    const recording = scenario(SCENARIOS[next.reply])
    const rows = runOf(recording.rows, recording.rows[1])
    // Held from its acceptance: a release the test sends as soon as it reads the paste comes during `sending`.
    const held = next.hold === 'send' ? new Promise((done) => { release = done }) : null
    setActivity('sending')
    await sleep(300)
    setActivity('waiting')
    if (held) {
      await held
      release = null
    }
    window ??= openWindow(recording)
    const ids = renamed(recording, rows)
    write(rows.slice(0, 1), ids, (record) => ({ ...record, message: { ...record.message, content: text } }))
    setStatus('running')
    await sleep(1_000)
    setActivity('running')
    const answer = (record) => next.reply !== 'list' || record.message?.role !== 'assistant' ? record
      : { ...record, message: { ...record.message, content: record.message.content.map((block) => block.type === 'text' ? { ...block, text: LIST } : block) } }
    const call = rows.findIndex((row) => row.record.message?.stopReason === 'toolUse')
    write(rows.slice(1, call < 0 ? undefined : call + 1), ids, answer)
    // `running` is on screen until the run ends: 0.6 s in a recorded plain run, a tool step as long as it lasts.
    await sleep(call < 0 ? 600 : next.quietMs ?? 1_000)
    if (call >= 0) write(rows.slice(call + 1), ids, answer)
    if (next.heartbeats) {
      const beat = scenario('main-heartbeat')
      const beats = runOf(beat.rows, beat.rows.find((row) => row.record.message?.content === HEARTBEAT_POLL))
      for (let i = 0; i < next.heartbeats; i++) write(beats, renamed(beat, beats))
    }
    setStatus(recording.node.status)
    pending = false
    if (next.reply === 'fail') {
      addSystem(RUN_ERROR)
      setActivity('error')
      return
    }
    const last = rows.map(({ record }) => answer(record).message).filter((message) => message?.role === 'assistant').at(-1)
    const reply = said(last.content.filter((block) => block.type === 'text').map((block) => block.text).join(''))
    transcript.push(reply)
    ui.chat.push(reply)
    setActivity('idle')
  }

  // ── input ──────────────────────────────────────────────────────────────────────────────────────────────────────

  const refuse = (reason, value) => {
    addSystem(reason === 'disconnected' && local ? LOCAL_REFUSED : REFUSED[reason])
    const newer = boxText()
    setBox(newer ? `${value}\n${newer}` : value)
    if (reason === 'disconnected') setActivity('disconnected')
    log({ refused: reason })
  }
  const command = (value) => {
    log({ command: value })
    const [name, target] = value.split(/\s+/)
    if (name !== '/session' || !target) return
    const chosen = target.startsWith('agent:') ? target : `agent:${agentId}:${target}`
    const changed = chosen !== key
    key = chosen
    if (changed || !historyLoaded) setTimeout(loadHistory, loadMs)
  }
  const submit = () => {
    const text = boxText()
    setBox('')
    const value = text.trim()
    if (!value) return
    log({ submitted: text })
    if (value.startsWith('/')) { command(value); return }
    if (refuseNext) {
      const { historyMs, history } = refuseNext
      refuseNext = null
      connected = false
      historyLoaded = false
      if (history) failures = FAILURES[history]
      disconnected()
      refuse('disconnected', value)
      tryConnect(historyMs)
      return
    }
    const reason = !connected ? 'disconnected' : !historyLoaded ? 'session-loading' : pending ? 'pending' : null
    if (reason) { refuse(reason, value); return }
    log({ accepted: value })
    const entry = said(value)
    transcript.push(entry)
    ui.chat.push(entry)
    const next = { reply: 'plain', ...plan }
    plan = null
    void runMessage(value, next, entry)
  }
  const PASTE = '\x1b[200~', PASTED = '\x1b[201~'
  /** [pasted]: a paste's text so far, which goes into the box whole at its end mark, as `handlePaste` takes it. */
  let input = '', pasting = false, pasted = ''
  const typed = (chunk) => {
    input += chunk.toString('utf8')
    while (input) {
      if (pasting) {
        const end = input.indexOf(PASTED)
        if (end < 0) {
          // The end mark may come in the next chunk: what could be its start waits for it.
          let keep = PASTED.length - 1
          while (keep > 0 && !PASTED.startsWith(input.slice(-keep))) keep--
          pasted += input.slice(0, input.length - keep)
          input = input.slice(input.length - keep)
          break
        }
        // `handlePaste` (editor.js 1050-1106) keeps a newline and every printable character.
        insertAtCursor([...normalized(pasted + input.slice(0, end))].filter((c) => c === '\n' || c >= ' ').join(''))
        pasted = ''
        input = input.slice(end + PASTED.length)
        pasting = false
        continue
      }
      if (input.startsWith(PASTE)) { input = input.slice(PASTE.length); pasting = true; continue }
      if (input[0] === '\x1b') {
        if (PASTE.startsWith(input)) break
        // Any other key's escape sequence: nothing the box takes.
        input = input.slice((/^\x1b(?:\[[0-9;?]*[@-~]|.)?/.exec(input) ?? ['\x1b'])[0].length)
        continue
      }
      const [character] = input
      input = input.slice(character.length)
      if (character === '\r') submit()
      else if (character === '\x15') {
        deleteToLineStart()
        log({ keyed: 'C-u', box: boxText() })
      } else if (character >= ' ' && character !== '\x7f') insertAtCursor(character)
    }
    render()
  }
  if (process.stdin.isTTY) process.stdin.setRawMode(true)
  process.stdin.on('data', typed)
  // Bracketed paste on, as the TUI asks for it: a paste comes between its marks.
  process.stdout.write('\x1b[?2004h')

  // ── steps ──────────────────────────────────────────────────────────────────────────────────────────────────────

  const step = (line) => {
    if (line.advance) {
      if (waiting) { const next = waiting; waiting = null; next() } else advances++
    }
    const refusing = REFUSALS[line.gateway]
    if (refusing) {
      gateway = { ...refusing, reason: refusing.reason(), tried: 0 }
      tries = 0
      if (connected) drop(BACKOFF_MS[tries++])
    }
    // A try waiting connects; a TUI that tries no more stays as it is.
    if (line.gateway === 'up') gateway = null
    if (line.blip) drop(line.blip)
    if (line.refuseNext) refuseNext = { historyMs: line.historyMs ?? loadMs, history: line.history }
    else if (line.history) {
      failures = FAILURES[line.history]
      if (line.historyMs) loadMs = line.historyMs
    }
    if (line.next) plan = line.next
    if (line.release === 'send') release?.()
    if (typeof line.localStop === 'string') {
      connected = false
      setConnection(`local runtime stopped: ${line.localStop}`, 5_000)
      setActivity('idle')
    }
    if (typeof line.exit === 'number') {
      process.stdout.write('\x1b[?2004l')
      process.exit(line.exit)
    }
  }
  let partial = ''
  const follow = () => {
    const size = statSync(options.steps).size
    if (size <= offset) return
    const text = Buffer.alloc(size - offset)
    const fd = openSync(options.steps, 'r')
    try { readSync(fd, text, 0, text.length, offset) } finally { closeSync(fd) }
    offset = size
    const lines = (partial + text.toString('utf8')).split('\n')
    partial = lines.pop()
    for (const line of lines) if (line.trim()) step(JSON.parse(line))
  }
  watch(options.steps, follow)
  // A change the watch did not report is read on this tick.
  setInterval(follow, 1_000)

  // The banner, then the TUI.
  render()
  proceed(() => {
    ui.tui = true
    setConnection(local ? 'starting local runtime' : 'connecting')
    proceed(() => tryConnect(), STEP_MS)
  }, STEP_MS)
}
