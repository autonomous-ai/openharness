// A stand-in for OpenClaw 2026.11.2's `openclaw`, run in a real tmux pane by the daemon under test
// (e2e/openclawShow.e2e.ts). It does what the daemon reads of an OpenClaw, as OpenClaw does it, and nothing more:
//
//   - answers `--version` as 2026.11.2 does, or, with `oldNode`, as it does on a Node it cannot run on
//     (`src/engines/openclaw/__fixtures__/version-old-node-darwin.txt`);
//   - `tui [--session <key> | <agent:id:key>] [--local]` renames its process `openclaw` (`ps-*.txt`), resolves its
//     state folder as `openclawDefaultStateDir` does, keeps `<state>/state/openclaw.sqlite` open for its whole run (the
//     daemon finds the folder from the files the process holds), and creates the agent store from `schema.sql` when it
//     is missing. With `noToken` it prints what `screen-no-token.txt` recorded and exits 1;
//   - draws whole screens at the pane's size, only shapes recorded from 2026.11.2 (`__fixtures__/screen-*.txt`) or by
//     the reproduction of docs/plans/2026-11-19-openclaw-show-goal-design.md: the banner with no footer, then the
//     title, the chat (system lines one space in), the status line, the footer and the input box between two rules.
//     Its startup draws `connecting | idle`, then `⠙ starting up • Ns | subscribing to session events` while its
//     history loads, ` history failed: …` in the chat when the load fails, then `gateway connected | idle`
//     (`gateway reconnected` after a drop), which reads `connected` from 4 s on, drawn by the next render as the TUI
//     draws it. `auto` walks it in about 2 s; `manual` waits for an `advance` step before each step, up to the first
//     connection's outcome. A busy line redraws each second with its timer;
//   - takes input as the TUI does (tui 6164-6188, 2722-2805): text and bracketed pastes go into the box, Enter submits,
//     C-u clears. A message is refused while not connected, while its history is not loaded, or while a run is
//     pending, and goes back into the box; `/session <key>` loads history again when it is not loaded and leaves the
//     box empty. A load that succeeds clears the chat and adds ` session <key>`;
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
//   {"blip":<ms>}                          a drop that reconnects by itself after <ms>
//   {"history":"ok"|"fail"|"fail-always","historyMs"?:<ms>}
//                                          how the next loads end (`fail`: the next one fails), and how long they take
//   {"next":{"reply":"plain"|"tool"|"list"|"approval"|"fail","quietMs"?:<ms>,"hold"?:"send","heartbeats"?:<n>}}
//                                          what the next accepted message does: `quietMs` a tool step that writes
//                                          nothing that long; `hold` stays sending, with no row, until a release;
//                                          `heartbeats` that many heartbeat runs after the answer
//   {"release":"send"}
//   {"refuseNext":"disconnected","historyMs":<ms>}
//                                          the next message meets a Gateway drop: refused, back in the box, and the
//                                          TUI reconnects at once with a history load of <ms>
//   {"localStop":"<reason>"}               a `--local` run's runtime stops: `local runtime stopped: <reason> | idle`,
//                                          `local stopped | idle` from 5 s on, drawn by the next render
//   {"exit":<code>}
// Events, one JSON object a line it appends to `options.events`, each with its time `at` in ms: {"started":<args>},
// {"drawn":<status line>} each time the status changes, {"submitted":<box text>}, {"accepted":<text>},
// {"refused":<reason>}, {"command":"/session <key>"}, {"history":"ok"|"failed"}.
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
const REFUSED_CONNECTION = `gateway disconnected: connect ECONNREFUSED ${GATEWAY}`
const HISTORY_FAILED = 'history failed: gateway request timeout for chat.history'
const REFUSED = {
  disconnected: 'not connected to gateway — message not sent',
  'session-loading': 'session history not ready — wait or retry /session',
  pending: 'agent is busy — press Esc to abort before sending a new message',
}
const LOCAL_REFUSED = 'local runtime not ready — message not sent'
const RUN_ERROR = 'run error: This model was not found. Choose another model in the Control UI.'
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
 * `startup`: `auto` (the default) or `manual`. `history`: how its history loads end, `ok` by default.
 *
 * @param {{ steps: string, events: string, oldNode?: boolean, noToken?: boolean, startup?: 'auto' | 'manual', history?: 'ok' | 'fail' | 'fail-always' }} options
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
  // Every `openclaw` command renames its process so (`ps-*.txt`): its argv never shows the session.
  process.title = 'openclaw'
  // Node's warning that node:sqlite is experimental would be drawn in the pane.
  process.removeAllListeners('warning')
  const { DatabaseSync } = process.getBuiltinModule('node:sqlite')
  const log = (event) => appendFileSync(options.events, `${JSON.stringify({ at: Date.now(), ...event })}\n`)
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

  const ui = { tui: false, chat: [], connection: '', activity: 'idle', since: Date.now(), box: '', model: 'unknown', tokens: '?' }
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
      lines.push('─'.repeat(width), ...cut(ui.box, width), '─'.repeat(width))
    }
    process.stdout.write(`\x1b[H\x1b[2J${lines.slice(-(process.stdout.rows || 24)).join('\r\n')}`)
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

  let connected = false, everConnected = false, historyLoaded = false, gateway = 'up'
  let failures = { ok: 0, fail: 1, 'fail-always': Infinity }[options.history ?? 'ok']
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
    if (gateway === 'down') {
      manual = false
      disconnected()
      setActivity('idle')
      retry = setTimeout(tryConnect, BACKOFF_MS[Math.min(tries++, BACKOFF_MS.length - 1)])
      return
    }
    setConnection('subscribing to session events')
    if (!BUSY.has(ui.activity)) setActivity('starting up')
    proceed(() => {
      manual = false
      tries = 0
      loadHistory()
      connected = true
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
  const runMessage = async (text, next) => {
    pending = true
    const recording = scenario(SCENARIOS[next.reply])
    const rows = runOf(recording.rows, recording.rows[1])
    setActivity('sending')
    await sleep(300)
    setActivity('waiting')
    if (next.hold === 'send') {
      await new Promise((done) => { release = done })
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
    ui.box = value
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
    const text = ui.box
    ui.box = ''
    const value = text.trim()
    if (!value) return
    log({ submitted: text })
    if (value.startsWith('/')) { command(value); return }
    if (refuseNext) {
      const ms = refuseNext.historyMs
      refuseNext = null
      connected = false
      historyLoaded = false
      disconnected()
      refuse('disconnected', value)
      tryConnect(ms)
      return
    }
    const reason = !connected ? 'disconnected' : !historyLoaded ? 'session-loading' : pending ? 'pending' : null
    if (reason) { refuse(reason, value); return }
    log({ accepted: value })
    transcript.push(said(value))
    ui.chat.push(said(value))
    const next = { reply: 'plain', ...plan }
    plan = null
    void runMessage(value, next)
  }
  const PASTE = '\x1b[200~', PASTED = '\x1b[201~'
  let input = '', pasting = false
  const typed = (chunk) => {
    input += chunk.toString('utf8')
    while (input) {
      if (pasting) {
        const end = input.indexOf(PASTED)
        if (end < 0) {
          // The end mark may come in the next chunk: what could be its start waits for it.
          let keep = PASTED.length - 1
          while (keep > 0 && !PASTED.startsWith(input.slice(-keep))) keep--
          ui.box += input.slice(0, input.length - keep).replace(/\r/g, '\n')
          input = input.slice(input.length - keep)
          break
        }
        ui.box += input.slice(0, end).replace(/\r/g, '\n')
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
      else if (character === '\x15') ui.box = ''
      else if (character >= ' ' && character !== '\x7f') ui.box += character
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
    if (line.gateway === 'down') {
      gateway = 'down'
      tries = 0
      if (connected) drop(BACKOFF_MS[tries++])
    }
    if (line.gateway === 'up') gateway = 'up'
    if (line.blip) drop(line.blip)
    if (line.history) {
      failures = { ok: 0, fail: 1, 'fail-always': Infinity }[line.history]
      if (line.historyMs) loadMs = line.historyMs
    }
    if (line.next) plan = line.next
    if (line.release === 'send') release?.()
    if (line.refuseNext) refuseNext = { historyMs: line.historyMs ?? loadMs }
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
  let offset = statSync(options.steps).size
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
