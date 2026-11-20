#!/usr/bin/env node
/**
 * Pane-scoped session hook shared by the supported hook-capable engines.
 *
 * Self-contained — node built-ins only, no dependency on the adapter's
 * node_modules (it runs inside the user's `claude` process).
 *
 * SessionStart: registers terminal hints plus session metadata with the adapter,
 *   but only from an authenticated tmux context.
 * SessionEnd:   asks the adapter to reconcile the terminal; process discovery remains
 *   the authority for whether the agent exists.
 * Outside a pane, or in a tmux pane the person opened (ownPane): tells the devices what the session did
 *   (postObserved), and registers nothing.
 *
 * Always exits 0 quickly and swallows every error, so it can never block or
 * delay claude's session start/teardown.
 */

import http from 'node:http'
import { execFile, execFileSync } from 'node:child_process'
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import {
  accessSync,
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  mkdirSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep, win32 } from 'node:path'
import { homedir, uptime } from 'node:os'
import { fileURLToPath } from 'node:url'

const BOOT_TOLERANCE_SEC = 120
const HOOK_STARTED_AT = performance.now()
// Self-imposed budget, well under the 10s timeout the vendor hook entries carry: a hook that overruns
// stalls the user's turn, so every optional step checks `remainingBudget()` and gives up rather than
// block. The override exists because that budget is a wall-clock assumption — on a loaded machine (a
// parallel test run, a busy CI box) a cold Node start plus lock retries can eat it before the offline
// registry fallback is reached, and the fallback then silently does nothing. Tests set it explicitly so
// they measure behaviour instead of the host's load. Clamped, and never below the shipped default.
const SHIPPED_DEADLINE_MS = 4500
const HOOK_DEADLINE_MS = Math.min(60_000, Math.max(SHIPPED_DEADLINE_MS, Number(process.env.HARNESS_HOOK_DEADLINE_MS) || 0))
// Each step's own limit (`execFileText`: tmux 2 s, ps and sqlite3 3 s, lsof 1.5 s) is a wall-clock assumption too, and
// the override has to move them with the budget or it does not do what it says: under a loaded full test
// run (load 36, six workers) the Hermes fallback's fake tmux, ps and sqlite3 each took longer than their
// step's limit with 30 s of budget left, the lookup read as no answer, and no registry was written
// (hookNotify.spec.ts, 3 of 3 Hermes cases). 1 with the shipped budget: a hook as shipped is unchanged.
const STEP_SCALE = HOOK_DEADLINE_MS / SHIPPED_DEADLINE_MS
/** A step's limit under the budget in force. Whole milliseconds: child_process refuses a fractional timeout. */
function stepLimit(ms) {
  return Math.round(ms * STEP_SCALE)
}
const EXIT_RESERVE_MS = 500
const LOCK_RETRIES = 60
const LOCK_RETRY_MS = 25
const CURSOR_TASK_MAX_AGE_MS = 10 * 60_000
const CURSOR_TASK_MAX_ENTRIES = 64
const CURSOR_TASK_MAX_INPUT_BYTES = 128 * 1024
const CODEX_META_MAX_BYTES = 128 * 1024

function remainingBudget(reserve = EXIT_RESERVE_MS) {
  return Math.max(0, HOOK_DEADLINE_MS - (performance.now() - HOOK_STARTED_AT) - reserve)
}

// Claude Code reports the model as {id, display_name}; Codex/Cursor as a plain string. The registry stores
// a string, so pick the id rather than shipping the object.
function modelName(value) {
  if (typeof value === 'string') return value
  return typeof value?.id === 'string' ? value.id : null
}

/**
 * The daemon this hook reports to, once the pane it came from has named it (`routeToPaneOwner`): its data
 * folder and port, in place of the `--data-dir` and `--port` the installed command carries.
 */
let routed = null

function argPort() {
  if (routed) return routed.port
  const i = process.argv.indexOf('--port')
  if (i !== -1 && process.argv[i + 1]) return parseInt(process.argv[i + 1], 10)
  return parseInt(process.env.AGENT_ADAPTER_PORT || '18473', 10)
}

function argValue(name, fallback) {
  const i = process.argv.indexOf(name)
  if (i !== -1 && process.argv[i + 1]) return process.argv[i + 1]
  return fallback
}

function argEngine() {
  const i = process.argv.indexOf('--engine')
  const value = i !== -1 ? process.argv[i + 1] : ''
  return value === 'codex' || value === 'cursor' || value === 'hermes' || value === 'commandcode' || value === 'devin' || value === 'muse' || value === 'grok' || value === 'agy' || value === 'copilot' ? value : 'claude'
}

/** Copilot names its hook event only on the command line, like agy. */
function argCopilotEvent() {
  const i = process.argv.indexOf('--copilot-event')
  const value = i !== -1 ? process.argv[i + 1] : ''
  return ['sessionStart', 'userPromptSubmitted', 'agentStop', 'sessionEnd'].includes(value) ? value : ''
}

/** Copilot's agentStop: `stopReason` is `end_turn` on a clean finish; anything else ended the loop early. */
function copilotStopFailed(input) {
  return typeof input.stopReason === 'string' && input.stopReason !== '' && input.stopReason !== 'end_turn'
}

/**
 * agy names its hook event nowhere in the payload, so the installer puts it on the command line.
 *
 * Everything else in the payload is camelCase (protojson): `conversationId`, `workspacePaths`,
 * `transcriptPath`, `modelName`, and on Stop `terminationReason` / `fullyIdle`.
 */
function argAgyEvent() {
  const i = process.argv.indexOf('--agy-event')
  const value = i !== -1 ? process.argv[i + 1] : ''
  return value === 'PreInvocation' || value === 'Stop' ? value : ''
}

/**
 * agy's Stop: 'waiting' while its sub-agents still work (`fullyIdle: false`, the agy branch of main() says why),
 * 'error' when the loop ended early (`terminationReason` is NO_TOOL_CALL on a clean finish), else undefined.
 */
function agyStopStatus(input) {
  const failed = typeof input.terminationReason === 'string'
    && input.terminationReason !== ''
    && input.terminationReason !== 'NO_TOOL_CALL'
    && input.terminationReason !== 'model_stop'
  return input.fullyIdle === false ? 'waiting' : failed || input.error ? 'error' : undefined
}

/**
 * Harness's data and state folders, by the rule of src/config/harnessHome.ts: on Linux the XDG ones once the data one
 * holds its marker (`.harness-root`, a file: a folder of its name is none), else ~/.harness while that exists, else the
 * XDG ones (a variable counts only as an absolute path); ~/.harness elsewhere.
 */
function harnessRoots() {
  const legacy = join(homedir(), '.harness')
  if (process.platform !== 'linux') return { data: legacy, state: legacy }
  const base = (name, ...fallback) => isAbsolute(process.env[name] || '') ? process.env[name] : join(homedir(), ...fallback)
  const xdg = { data: join(base('XDG_DATA_HOME', '.local', 'share'), 'harness'), state: join(base('XDG_STATE_HOME', '.local', 'state'), 'harness') }
  return isRegularFile(join(xdg.data, '.harness-root')) || !existsSync(legacy) ? xdg : { data: legacy, state: legacy }
}

/**
 * A Harness folder override as every process reads it (src/config/envFields.ts homePath): an absolute value as given, a
 * relative one under the home, never the agent's project the hook runs in; an unset or empty one as it is.
 */
function homePath(value) {
  return !value || isAbsolute(value) ? value : join(homedir(), value)
}

/** A regular file, through a link as the installers' `test -f` looks; a folder, or nothing, is none. */
function isRegularFile(path) {
  try { return statSync(path).isFile() } catch { return false }
}

function paths() {
  // Every installed command names its data folder: the rule is looked up only for one that does not.
  const dataDir = routed?.dataDir ?? (argValue('--data-dir', '') || homePath(process.env.ADAPTER_DATA_DIR) || join(harnessRoots().data, 'cli', 'data'))
  const claudeProjectsDir = argValue('--claude-projects-dir', process.env.CLAUDE_PROJECTS_DIR || join(homedir(), '.claude', 'projects'))
  const codexHome = argValue('--codex-home', process.env.CODEX_HOME || join(homedir(), '.codex'))
  const grokHome = argValue('--grok-home', process.env.GROK_HOME || join(homedir(), '.grok'))
  const cursorHome = process.env.CURSOR_DATA_DIR?.trim() || argValue('--cursor-home', process.env.CURSOR_HOME || join(homedir(), '.cursor'))
  const hermesHome = argValue('--hermes-home', process.env.HERMES_HOME || join(homedir(), '.hermes'))
  const commandcodeHome = argValue('--commandcode-home', process.env.COMMANDCODE_HOME || join(homedir(), '.commandcode'))
  const devinHome = argValue('--devin-home', process.env.DEVIN_HOME || join(homedir(), '.local', 'share', 'devin', 'cli'))
  const copilotHome = argValue('--copilot-home', process.env.COPILOT_HOME || join(homedir(), '.copilot'))
  const agyHome = argValue('--agy-home', process.env.AGY_HOME || join(homedir(), '.gemini', 'antigravity-cli'))
  return {
    dataDir,
    registryFile: join(dataDir, 'registry.json'),
    bootFile: join(dataDir, 'registry-boot'),
    claudeProjectsDir,
    codexSessionsDir: join(codexHome, 'sessions'),
    grokHome,
    grokSessionsDir: join(grokHome, 'sessions'),
    cursorProjectsDir: join(cursorHome, 'projects'),
    hermesDb: join(hermesHome, 'state.db'),
    commandcodeProjectsDir: join(commandcodeHome, 'projects'),
    devinHome,
    devinLocksDir: join(devinHome, 'session_locks'),
    agyHome,
    agyBrainDir: join(agyHome, 'brain'),
    agyPresenceDir: join(agyHome, 'presence'),
    copilotHome,
    copilotSessionsDir: join(copilotHome, 'session-state'),
  }
}

/** Copilot's deterministic transcript layout, duplicated here because the hook cannot import src/. */
function copilotTranscriptPath(p, sessionId) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId || '')) return undefined
  return join(p.copilotSessionsDir, sessionId, 'events.jsonl')
}

/**
 * Is this agy conversation the PANE's, or a sub-agent's?
 *
 * agy gives every sub-agent its own conversation id, its own transcript AND its own hooks — fired with
 * the parent's `TMUX_PANE`. Registering those rebinds the pane to whichever child announced last:
 * measured on a three-sub-agent run as one agent attaching to three different sessions in four
 * seconds, after which the web pane showed the CHILDREN's messages and the parent's `Task` rows never
 * rendered at all.
 *
 * The discriminator is `presence/<id>.lock`, which agy creates only for a top-level conversation —
 * measured: four locks on this machine, all parents; the six sub-agent conversations have none. It is
 * also ordered safely, created BEFORE the first hook of that conversation (lock 17:57:14, first hook
 * 17:57:15, transcript not until 17:57:17), so a real new session is never mistaken for a child.
 */
function agyIsPaneConversation(p, conversationId) {
  if (!conversationId) return false
  try {
    return statSync(join(p.agyPresenceDir, `${conversationId}.lock`)).isFile()
  } catch {
    return false
  }
}

/** agy's deterministic transcript layout, duplicated here because the hook cannot import from src/. */
function agyTranscriptPath(p, conversationId) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(conversationId || '')) return undefined
  return join(p.agyBrainDir, conversationId, '.system_generated', 'logs', 'transcript_full.jsonl')
}

/** True when the path is a real file on disk right now (undefined/missing → false). */
function existsPath(file) {
  if (typeof file !== 'string' || !file) return false
  try { return statSync(file).isFile() } catch { return false }
}

/** Resolve Grok's authoritative update log. Normal paths use URL-encoded cwd; very long paths use a
 * hashed directory with a `.cwd` sidecar, so scan only that one level as a bounded fallback. */
function grokTranscriptPath(p, cwd, sessionId) {
  if (typeof cwd !== 'string' || !cwd || typeof sessionId !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId)) return ''
  const direct = join(p.grokSessionsDir, encodeURIComponent(cwd), sessionId, 'updates.jsonl')
  if (existsPath(direct)) return direct
  try {
    for (const entry of readdirSync(p.grokSessionsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const group = join(p.grokSessionsDir, entry.name)
      let recorded = ''
      try { recorded = readFileSync(join(group, '.cwd'), 'utf8').trim() } catch { continue }
      if (recorded !== cwd) continue
      const candidate = join(group, sessionId, 'updates.jsonl')
      if (existsPath(candidate)) return candidate
    }
  } catch { /* state root may not exist yet */ }
  return ''
}

function grokHookEvent(value) {
  const key = String(value || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/-/g, '_')
    .toLowerCase()
  return ({
    session_start: 'SessionStart',
    session_end: 'SessionEnd',
    user_prompt_submit: 'UserPromptSubmit',
    stop: 'Stop',
    stop_failure: 'StopFailure',
  })[key] || ''
}

/**
 * True when a hook payload came from Devin rather than the engine the hook was armed for. Devin session
 * ids are lowercase word slugs (`blue-agustinia`) and every live session holds
 * `<DEVIN_HOME>/session_locks/<id>.lock`, while claude's are UUIDs — so the lock file is the tell.
 */
function isDevinSession(input, p) {
  const id = typeof input?.session_id === 'string' ? input.session_id : ''
  if (!id || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id) || id.length > 64) return false
  try { return statSync(join(p.devinLocksDir, `${id}.lock`)).isFile() } catch { return false }
}

function readStdin() {
  return new Promise((resolve) => {
    let data = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (c) => (data += c))
    process.stdin.on('end', () => resolve(data))
    process.stdin.on('error', () => resolve(data))
    // Safety: if stdin never ends, don't hang.
    setTimeout(() => resolve(data), 1000)
  })
}

function boundedPrompt(prompt) {
  // An oversized/escape-heavy prompt must still announce its submission so the daemon
  // clears earlier scope. Keep the serialized field within the hook receiver's bounds.
  return Buffer.byteLength(JSON.stringify(prompt)) <= 128 * 1024 ? prompt : ''
}

/**
 * POST one hook event to the daemon. Resolves true when it answered 2xx, false when it could not be
 * reached, 'refused' when it answered anything else, 'held' for live admission backpressure, and 'late'
 * when it took the request but did not answer within the budget. Only false permits an offline registry write.
 *
 * 'refused' is a daemon that runs: a 500 taken for an outage wrote the hook's own row in place of the
 * agent's, which the daemon's next save took in, and the agent it had created was gone (e2e/scale.e2e.ts).
 * 'late' is not "the daemon is down", and nothing may be written behind its back for it: the request is
 * in its socket, and it handles it once it gets to it. A daemon whose event loop is held for a few
 * seconds (or one simply slow to answer a session-start, which waits for a discovery pass) used to get
 * the offline fallback on every hook meanwhile, each a registry row rebuilt without the name, launch,
 * permission mode or close plan the daemon kept, merged over its own at its next save
 * (e2e/stall.e2e.ts).
 */
/** This process's start, epoch ms: the engine ran the hook then. One reading Node took as it started: two clock
 *  reads here, with a pause between them, put it before the turn's opening record (CI 44381432197, Linux). */
const DELIVERY_ID = randomUUID()
const FIRED_AT = Math.floor(performance.timeOrigin)

/** Mirrors MAX_SOCKET_PATH_BYTES in src/lib/localSocket.ts. */
const MAX_SOCKET_PATH_BYTES = 96

/** A socket file only this account could have made: never send the credential to anything else. */
function privateSocket(file) {
  try {
    const entry = lstatSync(file)
    const uid = typeof process.getuid === 'function' ? process.getuid() : null
    return entry.isSocket() && (entry.mode & 0o077) === 0 && (uid === null || entry.uid === uid)
  } catch { return false }
}

/**
 * The daemon's socket in this data folder. It is named for the daemon's configured port, and this hook's port may be
 * the one the daemon was given instead when another account held that one, so the daemon's records say which
 * (mirrors localSocketRoute in src/lib/localTransport.ts).
 */
function socketIn(dataDir, port) {
  const beside = join(dataDir, `daemon-${port}.sock`)
  if (Buffer.byteLength(beside) <= MAX_SOCKET_PATH_BYTES) return beside
  const root = runtimeShortRoot() ?? join(harnessRoots().state, 's')
  const short = join(root, createHash('sha256').update(dataDir).digest('hex').slice(0, 16), `daemon-${port}.sock`)
  return Buffer.byteLength(short) <= MAX_SOCKET_PATH_BYTES ? short : null
}

/**
 * Where short folders go on Linux when the account has its own runtime folder, as src/lib/localSocket.ts finds it:
 * `$XDG_RUNTIME_DIR/harness` when the variable names an absolute path to a real folder, not a link, of this account's,
 * mode 0700. Null otherwise.
 */
function runtimeShortRoot() {
  const dir = process.env.XDG_RUNTIME_DIR
  if (process.platform !== 'linux' || !dir || !isAbsolute(dir)) return null
  try {
    const seen = lstatSync(dir)
    const uid = typeof process.getuid === 'function' ? process.getuid() : null
    return seen.isDirectory() && seen.uid === uid && (seen.mode & 0o7777) === 0o700 ? join(dir, 'harness') : null
  } catch { return null }
}

function daemonSocket(port, dataDir) {
  const named = socketIn(dataDir, port)
  if (named && privateSocket(named)) return named
  try {
    for (const name of readdirSync(dataDir)) {
      const configured = /^daemon-(\d+)\.json$/.exec(name)?.[1]
      if (!configured) continue
      const socket = socketIn(dataDir, Number(configured))
      if (socket && JSON.parse(readPrivateStateFile(join(dataDir, name), 4096))?.port === port && privateSocket(socket)) return socket
    }
  } catch { /* An unreadable folder has no socket to offer. */ }
  return null
}

/** Mirrors LOCAL_PIPE_RE in src/lib/windows/pipeAuth.ts: a pipe on this computer named harness-<id>, nothing else. A
 *  file, or another computer's pipe (an SMB connection that can carry this user's NTLM credentials), is none. */
const LOCAL_PIPE_RE = /^\\\\\.\\pipe\\harness-([0-9a-f]{32})$/
/** Mirrors TOKEN_TEXT in src/lib/windows/pipeAuth.ts. */
const DAEMON_TOKEN_RE = /^[0-9a-f]{64}\n?$/

/**
 * The record's daemon still runs. Once it is gone, any account can create a pipe of the recorded name, and would hear
 * this request, the prompt in it, before its answer can fail the proof. The daemon is this account's, so a pid that
 * answers EPERM is another account's process now, one that took the pid since: no daemon (Quinn 2's review of #2605).
 * Unlike processProof.ts pidAlive, which counts it alive for callers that also read the process table.
 */
function pidRuns(pid) {
  try { process.kill(pid, 0); return true } catch { return false }
}

/**
 * The daemon's pipe on Windows, as the CLI finds it (src/lib/windows/daemonPipe.ts): the record the core writes,
 * `daemon-<configured port>.json`, names the pipe and the core's pid, both new on each start. This hook's port may be the
 * one the daemon was given instead, so the records say which. Null with no record of a local pipe, no token, or a core
 * that has exited. The pipe auth (src/lib/windows/pipeAuth.ts) proves the token without sending it, and the answer must
 * prove it back.
 */
function windowsDaemonPipe(port, dataDir) {
  const read = (name) => { try { return JSON.parse(readWindowsStateFile(dataDir, join(dataDir, name), 4096)) } catch { return null } }
  let record = read(`daemon-${port}.json`)
  if (!record) {
    try {
      for (const name of readdirSync(dataDir)) {
        if (!/^daemon-\d+\.json$/.test(name)) continue
        const candidate = read(name)
        if (candidate?.port === port) { record = candidate; break }
      }
    } catch { /* An unreadable folder has no record to offer. */ }
  }
  const id = typeof record?.pipe === 'string' ? LOCAL_PIPE_RE.exec(record.pipe)?.[1] : null
  if (!id || !Number.isSafeInteger(record.pid) || record.pid <= 0 || !pidRuns(record.pid)) return null
  let text = ''
  try { text = readWindowsStateFile(dataDir, join(dataDir, 'daemon-token'), 128) } catch { return null }
  if (!DAEMON_TOKEN_RE.test(text)) return null
  const token = Buffer.from(text.slice(0, 64), 'hex')
  const nonce = id + randomBytes(16).toString('hex')
  const mac = (separator) => createHmac('sha256', token).update(Buffer.of(separator)).update(nonce, 'utf8').digest('hex')
  const proof = Buffer.from(mac(0x00), 'hex')
  return {
    address: { socketPath: record.pipe },
    headers: { 'X-Harness-Auth': `${nonce}.${mac(0x01)}` },
    proven: (value) => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value) && timingSafeEqual(Buffer.from(value, 'hex'), proof),
  }
}

/**
 * How this hook reaches the daemon, and what it shows. Any account can bind the TCP port while the daemon restarts (audit
 * H1, docs/security/2026-11-02-team-account-boundary.md), and whoever holds it would hear this request, the user's
 * prompt in it included. So on macOS and Linux it goes over the 0600 socket; with none there the daemon is down, and
 * this is the same as a failed post. A data folder too long to hold a socket has one under the home folder (socketIn). A
 * home too long as well is the one case with no way but TCP, and then the hook-only token goes, never the credential. Over the socket the credential still goes because a daemon from
 * before the hook token (an update not yet handed over) checks it there. On Windows it goes over the daemon's pipe, and
 * never to the port: the Team account's daemon starts at boot, before the owner's, and could hold it (audit W1,
 * docs/security/2026-11-02-team-account-windows.md).
 */
function hookRoute(port) {
  const dataDir = paths().dataDir
  if (process.platform === 'win32') return windowsDaemonPipe(port, dataDir)
  const tokenRoute = (address, token) => token ? { address, headers: { 'X-Harness-Hook-Token': token } } : null
  if (!socketIn(dataDir, port)) return tokenRoute({ host: '127.0.0.1', port }, readHookCredential('hook-token'))
  const socketPath = daemonSocket(port, dataDir)
  return socketPath ? tokenRoute({ socketPath }, readHookCredential()) : null
}

function post(port, path, body, onResponse, facts = {}) {
  return new Promise((resolve) => {
    const payload = JSON.stringify(body)
    const route = hookRoute(port)
    if (!route) { resolve(false); return }
    let connected = false
    const req = http.request(
      {
        ...route.address,
        path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          ...route.headers,
          // Headers, not body fields: a daemon that does not read one ignores it, where it refuses an unknown field.
          ...facts,
          // When the engine ran this hook: this process's start, not its arrival, which can be seconds later on
          // a loaded machine, after the engine has moved on to its next prompt (src/hookServer.ts hookFiredAt).
          'X-Harness-Hook-Fired-At': String(FIRED_AT),
          'X-Harness-Hook-Delivery-Id': DELIVERY_ID,
        },
        timeout: Math.max(1, Math.min(500, remainingBudget())),
      },
      (res) => {
        // Before the body is read: an answer on the pipe without the daemon's proof is whatever took its name, not the
        // daemon, and is never taken (src/lib/windows/pipeClient.ts pipeRequest).
        if (route.proven && !route.proven(res.headers['x-harness-proof'])) { resolve(false); req.destroy(); return }
        let response = ''
        res.setEncoding('utf8')
        res.on('data', (chunk) => { if (response.length < 16_384) response += chunk })
        res.on('end', () => {
          const ok = (res.statusCode || 0) >= 200 && (res.statusCode || 0) < 300
          let reply
          try { if (response.length <= 16_384) reply = JSON.parse(response) } catch { /* no structured reply */ }
          if (res.statusCode === 429 || (res.statusCode === 202 && reply?.retry === true)) { resolve('held'); return }
          if (path === '/api/hook/turn-stop' && ok && reply?.pending === true) { resolve('held'); return }
          if (path === '/api/hook/turn-stop' && ok && reply?.duplicate === true) { resolve('duplicate'); return }
          if (ok && onResponse && response.length <= 16_384) {
            try { onResponse(JSON.parse(response)) } catch { /* Unavailable context never blocks a turn. */ }
          }
          resolve(ok || 'refused')
        })
      }
    )
    req.on('socket', (socket) => {
      if (!socket.connecting) connected = true
      else socket.once('connect', () => { connected = true })
    })
    req.on('error', () => resolve(false))
    req.on('timeout', () => {
      req.destroy()
      resolve(connected ? 'late' : false)
    })
    req.write(payload)
    req.end()
  })
}

/**
 * post() for a session outside a pane, which only the devices hear of (core/observedHook.ts): written, never waited on.
 * The engine waits for this hook, and nothing in the daemon's answer changes what the hook does. So it resolves once
 * the request is handed to the socket ('finish'), which the exit in main()'s finally then cannot cut, or after 150 ms,
 * so a daemon that takes the request and never answers cannot hold the engine.
 */
function postObserved(port, body) {
  return new Promise((resolve) => {
    const route = hookRoute(port)
    if (!route) { resolve(); return }
    const payload = JSON.stringify(body)
    const req = http.request({
      ...route.address,
      path: '/api/hook/observed',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), ...route.headers },
    })
    setTimeout(resolve, 150)
    req.on('finish', resolve)
    req.on('error', resolve)
    req.end(payload)
  })
}

/**
 * Which app a session outside a pane runs in, from the environment the engine gave this hook: these names exactly,
 * never by prefix. Orca also sets ORCA_PAIRING_CODE and ORCA_AGENT_SESSION_SPAWN_TOKEN there (read on an Orca 1.4.256
 * session, 2026-11-13), and they must never leave this process. CLAUDE_CODE_HOST_SESSION_ID is the Claude app's own id
 * for the session it runs (`local_<random uuid>`): a tap on the dial opens the app on that session. It is an id, not a
 * credential (read in the app, 2026-11-14: it names the session in the app's list and its telemetry; the app's tokens
 * are other variables). The app takes one of up to 70 characters, and cut it would still pass as another session's, so
 * one over 64 is left out whole.
 *
 * CLAUDE_CODE_ENTRYPOINT is a fixed word naming how Claude Code was started, not a secret: the VS Code extension sets
 * `claude-vscode` (read in the extension's code), and a tap then opens the extension's tab on the session.
 *
 * HC_TERMINAL_ID is Herdr Core's (hc's) address of the terminal the agent runs in, `t7`: an id, no credential. A named
 * hc session's addresses start again at t1, and the devices follow the default session, where that address would be
 * another terminal: it is sent from the default session alone. And on macOS alone: hc runs on Linux too, but macOS is
 * the one platform the devices try Herdr's window on (Q5).
 *
 * CMUX_SURFACE_ID and CMUX_WORKSPACE_ID are cmux's ids of the terminal and the workspace it sits in (UUIDs): ids, no
 * credential. cmux sets TERM_PROGRAM=ghostty, so without them an agent in cmux reads as Ghostty's. Sent on macOS alone,
 * the one platform cmux runs on. cmux sets CMUX_SOCKET_PASSWORD and other CMUX_ names there too, and they must never
 * leave this process.
 *
 * ZELLIJ_PANE_ID is Zellij's id of the pane (digits) and ZELLIJ_SESSION_NAME the name of the Zellij session holding it,
 * which `zellij --session <name> action …` targets: an id and a name, no credential. KITTY_LISTEN_ON is the address of
 * the socket kitty's remote control listens on (`unix:…`), which `kitten @ --to` needs from outside kitty: an address,
 * no credential. A cut one of these would name another pane, session or socket, so one over 64 characters is left out
 * whole instead.
 *
 * In order: the app's names first, then the hosts from the nearest, as detectHost reads them (cable/hosts/hostDetect.ts),
 * so a session with more than MAX_HINTS set loses the farthest. Zellij's names come before kitty's: a session in Zellij
 * inside kitty keeps Zellij's, the nearer host. HC_TERMINAL_ID comes after the multiplexers: one started
 * in an hc terminal keeps that terminal's address, and is the nearer host. cmux's ids come after them: a multiplexer
 * started in a cmux terminal keeps cmux's ids, and is the nearer host. CLAUDE_CODE_ENTRYPOINT is last, the first the
 * cap drops: without it a tap still brings the app forward.
 *
 * On Windows no app sets __CFBundleIdentifier, and Cursor and VS Code both set TERM_PROGRAM=vscode: the hook finds the
 * app itself (lookUpWindowsApp) and sends its bundle id in that hint, never one the environment claims. The first of
 * these that answers:
 * - CLAUDE_CODE_ENTRYPOINT=claude-desktop, which the Claude app gives the Claude Code it starts (cable/hosts/record.ts):
 *   the Claude app. The hook's own environment, never another process's, and its word on how this session started, so
 *   it is read before an editor's variables the app may have inherited. No process is started.
 * - VSCODE_GIT_ASKPASS_NODE, which an editor sets in its integrated terminals alone: the editor's own program
 *   (`Code.exe`, `Cursor.exe`). No process is started.
 * - VSCODE_PID, for a session started from Claude Code's extension panel, which runs with the extension host's
 *   environment and has no askpass variable (read on the VM, 2026-11-20): the image name of that pid's row in the
 *   hook's own chain (windowsHookChain), the one read the caller's climb makes too, so a Codex hook in the panel starts
 *   the pty host once. An image name, never another process's environment. The editor is one of the hook's parents (on
 *   the VM: two bash.exe, claude.exe and the extension host, then VSCODE_PID's Code.exe), so a pid past the chain's 9
 *   rows names none. A read pays a pty host start, so the answer is kept per editor (keepEditor), and a hook whose kept
 *   answer matches starts none. The key is the pid and the editor's pipe (VSCODE_IPC_HOOK), not the process's start
 *   time: the start time is in the table alone, so checking it would cost the start the kept answer saves, while the
 *   pipe's name is in this hook's own environment and differs between editors and versions, so a pid another editor
 *   reuses misses.
 * - For Codex alone, the ChatGPT app's program among the rows of the hook's own chain, which Codex's climb reads
 *   anyway: the app runs its threads on a codex.exe of its own, a child of its ChatGPT.exe (Task 37 §2 of
 *   docs/plans/2026-11-19-dial-windows-vm-notes.md). An image path the pty host read, never another process's
 *   environment.
 * - ALACRITTY_LOG, the one variable Alacritty sets on Windows (its log file, whose path is never read): Alacritty.
 * - Last, WEZTERM_PANE and TERM_PROGRAM=WarpTerminal, which WezTerm and Warp set on Windows too (read from their
 *   source): their apps. Those names are sent as they are, but a multiplexer inside them (herdr) is the nearer host, and
 *   its own bundle names no window a tap can raise there (cable/hosts/windowsRaise.ts WINDOWS_APPS).
 */
const HOST_HINTS = ['TERM_PROGRAM', '__CFBundleIdentifier', 'HERDR_PANE_ID', 'REX_BLOCK', 'ZELLIJ', 'ZELLIJ_PANE_ID',
  'ZELLIJ_SESSION_NAME', 'TMUX_PANE', 'HC_TERMINAL_ID', 'CMUX_SURFACE_ID', 'CMUX_WORKSPACE_ID', 'KITTY_WINDOW_ID',
  'KITTY_LISTEN_ON', 'WEZTERM_PANE', 'ORCA_AGENT_SESSION_ID', 'ORCA_TERMINAL_HANDLE', 'CLAUDE_CODE_HOST_SESSION_ID',
  'CLAUDE_CODE_ENTRYPOINT']
/** The hints a cut would turn into another pane, session or socket (see HOST_HINTS): sent whole or not at all. */
const WHOLE_HINTS = ['ZELLIJ_PANE_ID', 'ZELLIJ_SESSION_NAME', 'KITTY_LISTEN_ON',
  'CLAUDE_CODE_HOST_SESSION_ID']
/** The core's observed route takes no more (core/observedHook.ts MAX_HINTS, which hookNotify.spec.ts keeps this equal to). */
const MAX_HINTS = 10

/** A character the core refuses in a path or hint (core/observedHook.ts): one there is forged. */
const CONTROL = /[\u0000-\u001f\u007f]/

/** [appBundle] is the app lookUpWindowsApp found, sent on Windows in place of the environment's __CFBundleIdentifier. */
function hostHints(appBundle) {
  const hints = {}
  for (const name of HOST_HINTS) {
    // The core refuses a whole event with more hints than MAX_HINTS, one over 64 characters or one with a control
    // character (core/observedHook.ts): that hint is left out instead.
    if (Object.keys(hints).length === MAX_HINTS) break
    // A named herdr session (`herdr --session <name>`) is a server of its own whose pane ids start again at w1:p1, and
    // herdr sets HERDR_SESSION in its panes alone (herdr 0.8.0): the devices follow the default session, where this id
    // would be another agent's pane. Skipped before the cap counts it, so it costs no other hint its place.
    if (name === 'HERDR_PANE_ID' && process.env.HERDR_SESSION) continue
    // The same for a named hc session's terminal address (see HOST_HINTS), and off macOS, where the devices do not try
    // Herdr. And in a herdr pane, the nearer host: a named herdr session sends no HERDR_PANE_ID above, and the address
    // alone would read as Herdr's own terminal (hostDetect.ts inHerdr).
    if (name === 'HC_TERMINAL_ID' && (process.platform !== 'darwin' || process.env.HERDR_PANE_ID
      || process.env.HERDR_SESSION || (process.env.HC_SESSION && process.env.HC_SESSION !== 'default'))) continue
    // cmux's ids off macOS (see HOST_HINTS), and under herdr or hc, the nearer host when started in a cmux terminal: a
    // named session of either sends no pane id or address above, and the ids alone would read as cmux's own terminal
    // (hostDetect.ts inCmux), which the dial's words are pasted into. Skipped before the cap counts them too.
    if ((name === 'CMUX_SURFACE_ID' || name === 'CMUX_WORKSPACE_ID') && (process.platform !== 'darwin'
      || process.env.HERDR_PANE_ID || process.env.HERDR_SESSION || process.env.HC_TERMINAL_ID)) continue
    // Skipped before the cap counts it too.
    if (WHOLE_HINTS.includes(name) && process.env[name]?.length > 64) continue
    const own = name === '__CFBundleIdentifier' && process.platform === 'win32' ? appBundle : process.env[name]
    const value = own?.slice(0, 64)
    if (value && !CONTROL.test(value)) hints[name] = value
  }
  return hints
}

/** Each editor's Windows program, as `path.win32.basename` names it in lower case, and the bundle id the devices know
 *  the editor by (cable/hosts/hostDetect.ts APP_BUNDLES). */
const WINDOWS_EDITORS = new Map([['code.exe', 'com.microsoft.VSCode'], ['cursor.exe', 'com.todesktop.230313mzl4w4u92']])

/** The bundle id of the editor whose program [path] names, any case, or undefined. */
function editorBundle(path) {
  return WINDOWS_EDITORS.get(win32.basename(path).toLowerCase())
}

/** The ChatGPT app's program, `<WindowsApps>\OpenAI.Codex_<version>_<arch>__<publisher>\app\ChatGPT.exe`, in its Store
 *  package's folder (docs/plans/2026-11-19-dial-windows-vm-notes.md, Task 37 §2). Its beta is another package
 *  (`OpenAI.CodexBeta_`). */
const CHATGPT_APP = /\\WindowsApps\\OpenAI\.Codex_[^\\]+\\(?:[^\\]+\\)*ChatGPT\.exe$/i

/** On Windows, the bundle id of the app [engine]'s session outside a pane runs in, from the inputs HOST_HINTS names, or
 *  undefined. Only the id leaves this process: never a path, a pid or a pipe's name. Each id is the devices' for that
 *  app (cable/hosts/hostDetect.ts APP_BUNDLES). */
async function lookUpWindowsApp(engine) {
  if (process.env.CLAUDE_CODE_ENTRYPOINT === 'claude-desktop') return 'com.anthropic.claudefordesktop'
  const askpass = process.env.VSCODE_GIT_ASKPASS_NODE
  if (askpass !== undefined) return editorBundle(askpass)
  const pid = /^\d{1,10}$/.test(process.env.VSCODE_PID ?? '') ? Number(process.env.VSCODE_PID) : 0
  if (pid > 0) {
    const ipc = editorIpcKey()
    const file = join(paths().dataDir, EDITORS_FILE)
    const kept = ipc && readEditors(file).find((entry) => entry.pid === pid && entry.ipc === ipc)
    if (kept) return kept.app
    const row = (await windowsHookChain())?.find((candidate) => candidate.pid === pid)
    const app = row && editorBundle(row.executable)
    // Only an answer the table gave is kept: no row, or no table, is asked again next time.
    if (app && ipc) keepEditor(file, { pid, ipc, app })
    return app
  }
  if (engine === 'codex' && (await windowsHookChain())?.some((row) => CHATGPT_APP.test(row.imagePath ?? ''))) {
    return 'com.openai.codex'
  }
  if (process.env.ALACRITTY_LOG) return 'org.alacritty'
  if (process.env.WEZTERM_PANE) return 'com.github.wez.wezterm'
  return process.env.TERM_PROGRAM === 'WarpTerminal' ? 'dev.warp.Warp-Stable' : undefined
}

/** The endpoint variables that say an engine is routed through OpenRouter: these names exactly. Their values never leave this process. */
const GATEWAY_URLS = ['ANTHROPIC_BASE_URL', 'OPENAI_BASE_URL', 'OPENAI_API_BASE']

/** By the endpoint's host alone: one that only looks like OpenRouter's (openrouter.ai.example.com, a path) is not. */
function ownGateway() {
  return GATEWAY_URLS.some((name) => {
    try { return /(?:^|\.)openrouter\.ai$/i.test(new URL(process.env[name] ?? '').hostname) } catch { return false }
  }) ? 'ori' : 'none'
}

/**
 * This session's Codex home, as the core takes one (src/hookServer.ts hookFacts): absolute as this platform spells it,
 * on Windows a drive's path, never a share's or a device's (src/engines/kit/homeAdoption.ts homeIsAbsolute). The
 * default is no home of its own.
 */
function ownCodexHome() {
  const home = process.env.CODEX_HOME
  const absolute = home && (process.platform === 'win32' ? /^[A-Za-z]:\\/.test(home) : home.startsWith('/'))
  return absolute && home.length <= 1_024 && !CONTROL.test(home) && home !== join(homedir(), '.codex')
    ? home : undefined
}

/**
 * What this hook says of its session's environment: it reads its own, so the daemon need read no other process's. The
 * gateway for Claude Code and Hermes (Codex's argv says its own), the home for Codex; nothing for another engine.
 */
function ownFacts(engine) {
  if (engine === 'claude' || engine === 'hermes') return { 'X-Harness-Hook-Gateway': ownGateway() }
  const home = engine === 'codex' ? ownCodexHome() : undefined
  // Percent-encoded: Node refuses a header value above U+00FF, and that would end the hook before it registers.
  return home ? { 'X-Harness-Hook-Codex-Home': encodeURIComponent(home) } : {}
}

/** Each engine's name for these moments, as main() reads them in a pane: Claude Code's and the engines that copy it
 *  (Grok's once grokHookEvent has named them), Cursor's and Copilot's lower-camel ones. */
const OBSERVED_EVENTS = new Map([
  ['SessionStart', 'session-start'], ['sessionStart', 'session-start'],
  ['UserPromptSubmit', 'turn-start'], ['beforeSubmitPrompt', 'turn-start'], ['userPromptSubmitted', 'turn-start'],
  ['Stop', 'turn-stop'], ['StopFailure', 'turn-error'],
  ['SessionEnd', 'session-end'], ['sessionEnd', 'session-end'],
])

/** Claude Code's Notification types that wait for the person's answer: a permission, an MCP server's question or
 *  link, or a resume after the quota ran out. */
const NEEDS_INPUT = ['permission_prompt', 'elicitation_dialog', 'elicitation_url_dialog', 'quota_auto_resume_stale']

/** Claude Code and Codex wait on the person at these, each run before its dialog is drawn: PreToolUse for its question
 *  tool alone, so a matcher edited by hand cannot turn each tool call into a request to the daemon. */
function waitsOnPerson(engine, event, input) {
  if (event === 'PreToolUse') return input.tool_name === (engine === 'claude' ? 'AskUserQuestion' : 'request_user_input')
  return event === 'PermissionRequest' || (engine === 'claude' && event === 'Elicitation')
}

/**
 * Whether a Claude Code subagent event is one the daemon counts. Its own helpers (prompt suggestions, `/btw`) end with a
 * SubagentStop of no type after no SubagentStart: it is not sent, so the count stays even.
 */
function countsSubagent(event, input) {
  return event !== 'SubagentStop' || !!input.agent_type
}

/** A paneless hook's event in the devices' words (core/observedHook.ts); null for one that says none of them. */
function observedEvent(engine, event, input) {
  const name = engine === 'copilot' ? argCopilotEvent() : engine === 'agy' ? argAgyEvent() : engine === 'grok' ? grokHookEvent(event) : event
  if (engine === 'copilot' && name === 'agentStop') return copilotStopFailed(input) ? 'turn-error' : 'turn-stop'
  if (engine === 'cursor' && name === 'stop') return input.status === 'error' ? 'turn-error' : 'turn-stop'
  if (engine === 'agy' && name === 'Stop') {
    const status = agyStopStatus(input)
    // Waiting for its sub-agents: the turn goes on.
    return status === 'waiting' ? null : status === 'error' ? 'turn-error' : 'turn-stop'
  }
  // agy's call of its model, and Command Code's tool call, are the only signs those engines give of a turn running.
  if (name === 'PreInvocation' || (engine === 'commandcode' && (name === 'PreToolUse' || name === 'preToolUse'))) return 'turn-start'
  // Grok writes its Stop before the turn's last words (its branch in main()).
  if (engine === 'grok' && name === 'Stop') return null
  // Codex's Stop says Finished outside a pane as Claude Code's does (the devices hold it 1.5 s for a next turn), and its
  // Interrupt is a turn the person stopped, with nothing to tell as done.
  if (engine === 'codex' && name === 'Interrupt') return 'turn-aborted'
  // A lead's subagents keep it working past its Stop. Codex's are not counted: its SubagentStop fires at each child
  // turn's end and never for a failed one (facts-codex §2).
  if (engine === 'claude' && (name === 'SubagentStart' || name === 'SubagentStop')) {
    return countsSubagent(name, input) ? (name === 'SubagentStart' ? 'subagent-start' : 'subagent-stop') : null
  }
  // Claude Code also says idle_prompt a minute after a finished turn, and auth_success: no answer is waited for, and a
  // done agent stays done. One too old to name its type sends that idle notice untyped too, so it says nothing.
  if (name === 'Notification') return NEEDS_INPUT.includes(input.notification_type) ? 'needs-input' : null
  return OBSERVED_EVENTS.get(name) ?? null
}

/** How Claude Code types in a message another session sent; the start is all that is read of the prompt. */
const CROSS_SESSION = /^\s*<cross-session-message /

/** A prompt another session sent, not one the person typed: the devices do not move the dial for it. Codex, Grok and
 *  Devin name their prompt event as Claude Code does, but only Claude Code types another session's message in so. */
function relayedPrompt(engine, event, input) {
  return engine === 'claude' && event === 'UserPromptSubmit' && typeof input.prompt === 'string' && CROSS_SESSION.test(input.prompt)
}

/** The shells an engine runs its hook through: `/bin/sh -c` is dash on Debian and Ubuntu, bash on Fedora and Arch,
 *  BusyBox's on Alpine, and each runs as `sh`; an engine that asks for a shell by name, the person's own zsh or fish
 *  among them, runs it so. */
const HOOK_SHELLS = new Set(['sh', 'dash', 'bash', 'zsh', 'fish'])

/**
 * Whether a shell's command line (/proc's, NUL-separated) has it run a command string: before its first operand, `-c`
 * or a single-dash cluster holding `c` (`-lc`, `-ec`). `-o pipefail`, `+o` and `-O extglob` take the next word as
 * their own, so it is no operand; a long option (`--norc`) is no cluster, whatever its letters.
 */
function runsCommandString(cmdline) {
  const words = cmdline.split('\0')
  for (let index = 1; index < words.length; index++) {
    const word = words[index]
    const cluster = /^-[^-]/.test(word)
    if (cluster && word.includes('c')) return true
    if ((cluster || word.startsWith('+')) && /[oO]/.test(word)) index++
    // The first operand (a script), `-`, `--` or another `+` word: the scan reads no further, and the shell is named.
    else if (!cluster && !/^--./.test(word)) return false
  }
  return false
}

/** The engines that run their hook through a shell on Windows: Codex and Copilot through PowerShell, Command Code
 *  through cmd. Claude Code and the others run it as argv, so its parent is the engine already. */
const WINDOWS_SHELL_ENGINES = new Set(['codex', 'copilot', 'commandcode'])

/** PowerShell's options that take the next word as their value (Windows PowerShell's and pwsh's), each as its name and
 *  the shortest prefix PowerShell takes for it; `ep`, `if`, `of` and `wd` are short names of their own. */
const POWERSHELL_VALUE_OPTIONS = [
  ['executionpolicy', 'ex'], ['ep', 'ep'], ['windowstyle', 'w'], ['inputformat', 'inp'], ['if', 'if'],
  ['outputformat', 'o'], ['of', 'of'], ['configurationname', 'config'], ['workingdirectory', 'wo'], ['wd', 'wd'],
  ['custompipename', 'cus'], ['settingsfile', 'settings'], ['version', 'v'], ['psconsolefile', 'psc'],
]

/**
 * Whether a PowerShell's argv has it run a command: before its first word that is no option, `-c` or a longer prefix of
 * `-Command`, in any case. An option's value is no word of its own; `-File` and `-EncodedCommand` are options, so the
 * script or the encoded text after them ends the scan.
 */
function powershellRunsCommand(argv) {
  for (let index = 1; index < argv.length; index++) {
    const word = argv[index].toLowerCase()
    if (!word.startsWith('-')) return false
    if (word.length >= 2 && '-command'.startsWith(word)) return true
    const name = word.slice(1)
    if (POWERSHELL_VALUE_OPTIONS.some(([option, shortest]) => name.length >= shortest.length && option.startsWith(name))) index++
  }
  return false
}

/** Whether a cmd's argv has it run a command: among its leading switches, `/c` or `/r` before any `/k`, in any case. */
function cmdRunsCommand(argv) {
  for (const word of argv.slice(1)) {
    const lower = word.toLowerCase()
    if (!lower.startsWith('/') || lower === '/k') return false
    if (lower === '/c' || lower === '/r') return true
  }
  return false
}

/** A row of the pty host's table that is a shell started to run a command, as the engines' hook runners start one. */
function windowsCommandShell(row) {
  if (!row.nativeArgv) return false
  const image = row.executable.toLowerCase()
  if (image === 'cmd.exe') return cmdRunsCommand(row.nativeArgv)
  return (image === 'powershell.exe' || image === 'pwsh.exe') && powershellRunsCommand(row.nativeArgv)
}

/**
 * The hook's own chain in [rows]: its parent's row, then each one's parent's, nearest first, at most 9 (pty/src/ps.rs
 * MAX_ANCESTORS). It ends at a pid no row has, a process gone, at a pid seen twice, and at a parent that started after
 * its child: Windows reuses pids, so that one took the pid of a parent gone, and is none of the hook's. A row the host
 * could not open has no start to compare, and the chain goes on through it. Built from the rows, not taken as listed,
 * so a host that takes no `--ancestors` (0.6.22) and lists every row gives the same chain.
 */
function hookChain(rows) {
  const byPid = new Map(rows.map((row) => [row.pid, row]))
  const chain = []
  for (let row = byPid.get(process.ppid); row && chain.length < 9 && !chain.includes(row); row = byPid.get(row.parentPid)) {
    const child = chain.at(-1)
    if (child && startedAfter(row, child)) break
    chain.push(row)
  }
  return chain
}

/** Whether [row] started after [child], by the FILETIMEs of their start markers (`w:<FILETIME>`, pty/src/ps.rs); never
 *  for a row the host could not open, which has none. */
function startedAfter(row, child) {
  const start = ({ startMarker }) => /^w:\d{1,20}$/.test(startMarker) ? BigInt(startMarker.slice(2)) : null
  const started = start(row), childStarted = start(child)
  return started !== null && childStarted !== null && started > childStarted
}

/** The hook's own chain from the pty host (`ps --json --ancestors <its parent>`), read at most once a run by the first to
 *  ask: the caller's climb (windowsHookCallerPid) and the app's lookup (lookUpWindowsApp) share it. Null for a failed
 *  read, and for a helper Node refuses to start (it throws), so neither reader loses the event to it. */
let windowsChain
function windowsHookChain() {
  windowsChain ??= readWindowsTable(['--ancestors', String(process.ppid)]).then((rows) => rows && hookChain(rows), () => null)
  return windowsChain
}

/** hookCallerPid on Windows: past each command shell of the hook's own chain whose parent is in it; the hook's parent
 *  when there is no chain. */
async function windowsHookCallerPid() {
  const chain = await windowsHookChain()
  if (!chain?.length) return process.ppid
  let index = 0
  while (index < 8 && index + 1 < chain.length && windowsCommandShell(chain[index])) index++
  return chain[index].pid
}

/**
 * The hook's caller, the nearest ancestor that outlives it: the core checks it against the engine's recorded process
 * (core/engines/hooks.ts), and the devices keep it for a paneless agent (cable/hosts/observed.ts). On Linux dash keeps
 * an engine's `sh -c` as the hook's parent, and it exits with the hook: the devices kept a pid already gone and dropped
 * the agent (GitHub run 43721656615), and a core held for a second read its process table after the shell had exited
 * and refused the Stop as unbound (e2e/stallHook.e2e.ts). So the climb passes every command shell in a row, at most 8
 * on the engine's wait, read from /proc, never the environment. Only command shells: an engine may itself be a shell
 * that runs a script, and a person's pane shell runs no `-c`, so the climb stops at either and never names a process
 * above the engine. A process /proc cannot show is named, as nothing above it can be read. A shell left to init, its
 * engine gone, is named itself: pid 1 never exits, and the devices would keep the agent. macOS's /bin/sh is a bash
 * that execs the hook, so its parent is the engine already, with nothing to climb.
 *
 * Windows has the same gap: PowerShell (`-Command`) and cmd (`/c`) stay the hook's parent and exit with it. Windows has
 * no /proc, so the climb reads the pty host's table, the one the core's check reads too (lib/windows/processTable.ts):
 * each row's pid, parent, image name and command line, never an environment. Starting the host costs a process start
 * on the hook's path, so only the engines whose runner is a shell pay it, only for an event the hook tells (hookCaller),
 * and it lists the hook's parent and that one's parents alone (`ps --json --ancestors`, at most 9 rows, the 8 steps'
 * worth): reading the whole table added about 58 ms to a hook on a Windows VM. The app's lookup reads the same chain
 * (windowsHookChain), so a run starts the host once at most. A host that takes no `--ancestors` (0.6.22) lists every
 * row, which the climb reads the same way; one that refuses it names the hook's parent, as no table does.
 * A process the host lists but cannot open is named, as its command line cannot be read; a shell whose parent is in no
 * row, gone, or whose parent's pid a process started since has taken, is named itself.
 */
async function hookCallerPid(engine) {
  if (process.platform === 'win32') return WINDOWS_SHELL_ENGINES.has(engine) ? windowsHookCallerPid() : process.ppid
  if (process.platform !== 'linux') return process.ppid
  let pid = process.ppid
  for (let step = 0; step < 8; step++) {
    const shell = linuxOwnerBirth(pid)
    if (!shell || !HOOK_SHELLS.has(shell.command) || shell.parentPid <= 1) break
    const cmdline = readProcField(pid, 'cmdline')
    if (cmdline === null || !runsCommandString(cmdline)) break
    pid = shell.parentPid
  }
  return pid
}

/** The hook's caller (hookCallerPid), found once a run, by the first to name it: so an event the hook drops climbs
 *  nothing. A climb that throws (a helper path Node refuses to start) names the parent, as a run with no table does. */
let caller
function hookCaller() {
  caller ??= hookCallerPid(argEngine()).catch(() => process.ppid)
  return caller
}

/** The core refuses an event whose title is longer (core/observedHook.ts): the hook cuts it to this instead. */
const MAX_TITLE = 64

/**
 * The name the session gives itself, as the core takes one, or undefined for none. The same rule as the devices'
 * cleaner (cable/hosts/observedTitle.ts): this file ships alone and cannot import it, and the hook's test holds the
 * two copies together.
 */
function observedTitle(value) {
  if (typeof value !== 'string') return undefined
  let title = value.replace(/\s+/g, ' ').trim()
  if (title.length > MAX_TITLE) {
    title = title.slice(0, MAX_TITLE)
    // A cut between the two halves of a surrogate pair would leave half a character.
    if (/[\ud800-\udbff]$/.test(title)) title = title.slice(0, -1)
    title = title.trim()
  }
  return title === '' || CONTROL.test(title) ? undefined : title
}

/**
 * What a paneless session's hook tells the devices: which session, what happened and where, and the name it gives
 * itself, never its prompt. A path the core would refuse (over 1024 characters, or with a control character) is left
 * out rather than cost the whole event (core/observedHook.ts), and so are the paths of a body over the 4096 bytes the
 * core reads (hookServer.ts): the transcript's first, as the devices can do without it, then the folder. The title is
 * never dropped: at most 64 characters, it fits beside the hints and ids once both paths are gone, so a body without
 * one always means the session said none. The caller and, on Windows, the app it runs in (lookUpWindowsApp) are found
 * only for an event it tells, so an event it drops starts no pty host; the two read the one chain (windowsHookChain).
 */
async function observedBody(engine, event, input) {
  const kind = observedEvent(engine, event, input)
  const sessionId = input.session_id || input.conversation_id || input.sessionId || input.conversationId
  if (!kind || typeof sessionId !== 'string') return null
  const path = (value) => typeof value === 'string' && value.length <= 1024 && !CONTROL.test(value) ? value : undefined
  // Devin's payload carries no cwd; the hook process inherits the session's working directory.
  const cwd = Array.isArray(input.workspace_roots) ? input.workspace_roots[0]
    : Array.isArray(input.workspacePaths) ? input.workspacePaths[0]
      : input.cwd || input.workspaceRoot || (engine === 'devin' ? process.cwd() : undefined)
  const body = {
    engine, sessionId, event: kind, cwd: path(cwd), callerPid: await hookCaller(),
    transcriptPath: path(input.transcript_path || input.transcriptPath),
    hostHints: hostHints(process.platform === 'win32' ? await lookUpWindowsApp(engine) : undefined),
  }
  if (relayedPrompt(engine, event, input)) body.relayed = true
  const title = kind === 'session-start' || kind === 'turn-start' ? observedTitle(input.session_title) : undefined
  if (title) body.title = title
  const fits = () => Buffer.byteLength(JSON.stringify(body)) <= 4096
  if (!fits()) delete body.transcriptPath
  if (!fits()) delete body.cwd
  return body
}

/** Mirrors syncStateDirectory in src/lib/secureState.ts: Windows cannot flush a directory handle (EPERM), and NTFS
 *  journals the rename itself. */
function syncStateDirectory(directory) {
  if (process.platform === 'win32') return
  const fd = openSync(directory, 'r')
  try { fsyncSync(fd) } finally { closeSync(fd) }
}

/**
 * On Windows NTFS gives Node no owner, and its mode bits read as writable by everyone (src/lib/secureState.ts,
 * windowsStateRoots), so the owner and mode checks below would refuse every folder and file there, and a hook with no
 * daemon could never record its session. There, as the daemon does, a folder must be a folder, and a file is read as
 * the hook reads its other Windows state (readWindowsStateFile): no link, within its size, inside the profile or the
 * hook's data folder. Never inside its own folder alone: the environment may name that one anywhere
 * (HARNESS_HOOK_ROUTES_DIR), and a folder this check passes is no proof of whose it is.
 */
function secureStateDirectory(directory, create = true) {
  if (create) mkdirSync(directory, { recursive: true, mode: 0o700 })
  if (process.platform === 'win32') {
    if (!statSync(directory).isDirectory()) throw new Error('state directory has unsafe type')
    return
  }
  const fd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try {
    const stat = fstatSync(fd)
    const uid = typeof process.getuid === 'function' ? process.getuid() : null
    if (!stat.isDirectory() || (uid !== null && stat.uid !== uid)) {
      throw new Error('state directory has unsafe owner or type')
    }
    const mode = stat.mode & 0o777
    if (mode & 0o022) throw new Error('state directory is group/world writable')
    if (mode !== 0o700) {
      fchmodSync(fd, 0o700)
      if ((fstatSync(fd).mode & 0o777) !== 0o700) {
        throw new Error('state directory permissions could not be tightened')
      }
    }
  } finally { closeSync(fd) }
}

function inspectPrivateStateFile(fd, maxBytes = Number.MAX_SAFE_INTEGER) {
  const stat = fstatSync(fd)
  const uid = typeof process.getuid === 'function' ? process.getuid() : null
  if (!stat.isFile() || (uid !== null && stat.uid !== uid)) throw new Error('state file has unsafe owner or type')
  if (stat.size > maxBytes) throw new Error('state file exceeds its size limit')
  if (process.platform === 'win32') return
  const mode = stat.mode & 0o777
  if (mode & 0o022) throw new Error('state file is group/world writable')
  if (mode !== 0o600) {
    fchmodSync(fd, 0o600)
    if ((fstatSync(fd).mode & 0o777) !== 0o600) {
      throw new Error('state file permissions could not be tightened')
    }
  }
}

function readPrivateStateFile(file, maxBytes = Number.MAX_SAFE_INTEGER) {
  if (process.platform === 'win32') return readWindowsStateFile(paths().dataDir, file, maxBytes)
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    inspectPrivateStateFile(fd, maxBytes)
    return readFileSync(fd, 'utf8')
  } finally { closeSync(fd) }
}

function hardenPrivateStateFileIfPresent(file, maxBytes = Number.MAX_SAFE_INTEGER) {
  let fd
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
  try {
    inspectPrivateStateFile(fd, maxBytes)
    return true
  } finally { closeSync(fd) }
}

function readHookCredential(name = 'hook-credential') {
  let fd = null
  try {
    const dataDir = paths().dataDir
    if (process.platform === 'win32') {
      const value = readWindowsStateFile(dataDir, join(dataDir, name), 128).trim()
      return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : ''
    }
    secureStateDirectory(dataDir, false)
    const uid = typeof process.getuid === 'function' ? process.getuid() : null
    const file = join(dataDir, name)
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.size > 128 || (stat.mode & 0o777) !== 0o600) return ''
    if (uid !== null && stat.uid !== uid) return ''
    const value = readFileSync(fd, 'utf8').trim()
    return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : ''
  } catch { return '' } finally {
    if (fd !== null) closeSync(fd)
  }
}

/**
 * NTFS gives Node no owner or mode bits, so on Windows the hook trusts its own data folder (the --data-dir it was
 * installed with) and the profile. Below the data folder, a state file (the credential, the daemon's token and record)
 * must be a plain file, not a link or junction (lstat does not call one a file): that check is what protects it. Its
 * real path must also lie inside the profile or the data folder, as defence in depth. The file is opened and must be the
 * very file lstat saw, so it cannot be swapped between the check and the read. Throws when there is none; '' when it is
 * refused.
 */
function readWindowsStateFile(dataDir, file, maxBytes) {
  const roots = [homedir(), dataDir].flatMap((root) => { try { return [realpathSync.native(root)] } catch { return [] } })
  const inside = (target) => roots.some((root) => {
    const rel = win32.relative(root, target)
    return rel === '' || (rel !== '..' && !rel.startsWith('..\\') && !win32.isAbsolute(rel))
  })
  const link = lstatSync(file, { bigint: true })
  if (!link.isFile() || link.size > BigInt(maxBytes) || !inside(realpathSync.native(file))) return ''
  let fd = null
  try {
    fd = openSync(file, 'r')
    const opened = fstatSync(fd, { bigint: true })
    if (!opened.isFile() || opened.dev !== link.dev || opened.ino !== link.ino) return ''
    return readFileSync(fd, 'utf8')
  } finally {
    if (fd !== null) closeSync(fd)
  }
}

/**
 * A Harness pty host pane names itself `HARNESS_PANE=<instance>:%N` (pty/src/panes.rs), as a tmux pane has
 * `TMUX_PANE`. It is read only when there is no TMUX_PANE: a tmux pane inside a pty host pane is still the tmux pane.
 * The instance is `p<protocol>` or `p<protocol>-<build>`, as cli/src/lib/ptyHost/instance.ts `PTY_HOST_INSTANCE`.
 */
function ptyHostPane(environment = process.env) {
  if (environment.TMUX_PANE) return null
  const match = /^(p\d{1,4}(?:-(?:[0-9A-Za-z.-]{1,32}|h[0-9a-f]{12}))?):(%\d{1,9})$/.exec(environment.HARNESS_PANE || '')
  return match ? { instance: match[1], paneId: match[2] } : null
}
const PTY_PANE = ptyHostPane()

async function terminalHookFields(tmuxPane) {
  const runtimeHints = []
  if (tmuxPane) runtimeHints.push({ backend: 'tmux', paneId: tmuxPane })
  else if (PTY_PANE) runtimeHints.push({ backend: 'ptyhost', instance: PTY_PANE.instance, paneId: PTY_PANE.paneId })
  return { tmuxPane, runtimeHints, callerPid: await hookCaller() }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function execFileText(cmd, args, timeout, env, options = {}) {
  return new Promise((resolve) => {
    // Whole milliseconds. What is left of the budget is a fraction off the whole (performance.now()),
    // and `execFile` throws ERR_OUT_OF_RANGE on a fractional timeout: once less was left than a step's
    // own limit, as on the shipped 4.5 s budget after a second of earlier steps on a loaded machine, the
    // step threw, and the offline registration it was part of was dropped.
    const budget = Math.floor(Math.min(stepLimit(timeout), remainingBudget()))
    if (budget < 50) { resolve(null); return }
    execFile(cmd, args, { timeout: budget, ...(env && { env }), ...options }, (err, stdout) => {
      resolve(err ? null : stdout)
    })
  })
}

/**
 * Mirrors ensureUtf8Locale in src/lib/childLocale.ts. This process is spawned by the ENGINE, not by the
 * daemon, so it inherits the engine's environment and has to set its own — and a hook child launched by
 * an engine under systemd/docker/ssh usually has no locale at all. It shells out to both `tmux` and
 * `ps`, and Linux mangles both without a UTF-8 locale: tmux turns the `-F` TAB separator into `_`, and
 * procps substitutes `?` for every byte it cannot print. Measured on Ubuntu 24.04 + procps-ng 4.0.4,
 * `⌘ <title>` reads back as `??? <title>` in BOTH comm and args, which kills both halves of the Command
 * Code marker in processMatchScore. macOS never substitutes, so this is Linux-only and cannot regress
 * it. Applied only when nothing usable is configured.
 */
function ensureUtf8Locale(env = process.env) {
  if (process.platform !== 'linux') return
  const configured = env.LC_ALL || env.LC_CTYPE || env.LANG
  if (configured && /utf-?8/i.test(configured)) return
  env.LC_ALL = 'C.UTF-8'
}
ensureUtf8Locale()

/**
 * Mirrors psEnv in src/lib/childLocale.ts. `processRows` below anchors on the `lstart` column, whose
 * shape belongs to LC_TIME, not to `ps`: only C and en_US produce `DOW MON DD HH:MM:SS YYYY`. en_GB and
 * en_AU swap day and month, de_DE/fr_FR do that and add dots, ja_JP prints `火  9/15`, ru_RU puts the
 * year before the time. Every one of those parses ZERO rows, the hook concludes the machine has no
 * processes, and the engine it was launched by goes unrecognised. LC_ALL has to be cleared because it
 * outranks both categories; LC_CTYPE stays UTF-8 so Linux procps keeps returning raw bytes.
 * COMMAND_MODE=unix2003: in legacy mode macOS `ps -e` lists every process's environment, which the hook never reads.
 */
function psEnv(env = process.env) {
  const configured = env.LC_ALL || env.LC_CTYPE || env.LANG
  const ctype = configured && /utf-?8/i.test(configured) ? configured : 'C.UTF-8'
  return { ...env, LC_ALL: '', LC_CTYPE: ctype, LC_TIME: 'C', COMMAND_MODE: 'unix2003' }
}

/** Second line of defence: /proc is raw bytes, so a glibc without C.UTF-8 still resolves correctly. */
function repairMangledRows(rows) {
  if (process.platform !== 'linux') return rows
  return rows.map((row) => {
    if (!row.executable.includes('?') && !row.args.includes('?')) return row
    const args = readProcField(row.pid, 'cmdline')?.replace(/\0/g, ' ').trimEnd()
    const executable = readProcField(row.pid, 'comm')?.trimEnd()
    return { ...row, ...(executable && { executable }), ...(args && { args }) }
  })
}

function readProcField(pid, field) {
  try { return readFileSync(`/proc/${pid}/${field}`, 'utf8') } catch { return null }
}

// The tag a daemon puts on every pane it creates, and the name it gives their sessions (both in
// src/lib/harnessSessionLabel.ts, which hookNotify.spec.ts keeps these equal to). Before tmux 3.0 there
// are no pane options, and the tag rides in the pane's start command instead (`ownerCommand`); this format
// reads it there first and from the option otherwise, as the daemon's listing does on such a tmux
// (`paneOwnerFormat(false)`), and on a newer one a pane's start command never carries it.
const HARNESS_OWNER_OPTION = '@harness_daemon'
const HARNESS_SESSION_PREFIX = 'harness-'
const OWNER_COMMAND_PREFIX = '/usr/bin/env HARNESS_DAEMON='
// A pane's owner, read as the daemon reads it (harnessSessionLabel.ts paneOwnerFormat): from tmux 3.0 the
// pane's own option, which stays with the pane wherever the person moves it; before 3.0 the tag in its start
// command, or its window's tag in a session Harness named only, since elsewhere the window's tag names a
// pane the person split into, or joined into, an agent's window.
const PANE_OWNER_FORMAT = `#{${HARNESS_OWNER_OPTION}}`
const PANE_OWNER_FORMAT_OLD_TMUX = `#{?#{m:${OWNER_COMMAND_PREFIX}*,#{pane_start_command}},#{=${OWNER_COMMAND_PREFIX.length + 16}:pane_start_command},`
  + `#{?#{m:${HARNESS_SESSION_PREFIX}*,#{session_name}},#{${HARNESS_OWNER_OPTION}},}}`

let paneOptions
/** Whether this tmux has pane options (3.0+). A version it cannot read counts as new, as the daemon reads it (tmuxVersion.ts). */
async function tmuxHasPaneOptions() {
  if (paneOptions === undefined) {
    const version = /(\d+)\.(\d+)/.exec((await execFileText('tmux', ['-V'], 2000)) || '')
    paneOptions = !version || Number(version[1]) >= 3
  }
  return paneOptions
}

/** A daemon's tag: its data folder, symlinks resolved, hashed — `harnessPaneOwner` in the daemon. */
function daemonPaneOwner(dataDir) {
  let canonical = resolve(dataDir)
  try { canonical = realpathSync(dataDir) } catch { /* not there: as given */ }
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16)
}

/**
 * The pane, as tmux describes it, in one call: its root process, its session, and the tag of the daemon
 * that made it (from the pane's option, or before tmux 3.0 from its start command). Read once per hook:
 * the route to the daemon is chosen from it first, and the offline fallback reads it again. Undefined
 * when tmux could not answer.
 */
const paneDescriptions = new Map()
function describePane(pane) {
  if (!paneDescriptions.has(pane)) paneDescriptions.set(pane, readPaneDescription(pane))
  return paneDescriptions.get(pane)
}
async function readPaneDescription(pane) {
  const format = (await tmuxHasPaneOptions()) ? PANE_OWNER_FORMAT : PANE_OWNER_FORMAT_OLD_TMUX
  const stdout = await execFileText('tmux', ['display-message', '-p', '-t', pane, `#{pane_pid}|#{session_name}|${format}`], 2000)
  if (stdout === null) return undefined
  const line = (stdout || '').trim()
  const first = line.indexOf('|')
  const last = line.lastIndexOf('|')
  if (first < 0 || last <= first) return undefined
  const pid = Number(line.slice(0, first))
  const session = line.slice(first + 1, last)
  const field = line.slice(last + 1)
  const owner = field.startsWith(OWNER_COMMAND_PREFIX) ? field.slice(OWNER_COMMAND_PREFIX.length).split(' ')[0] : field
  return { pid: Number.isSafeInteger(pid) && pid > 0 ? pid : null, session, owner }
}

/**
 * Whether the daemon this hook writes for takes the pane for one of its agents at all, by the rule its
 * discovery reads panes with (`ownedHere`): one it tagged, wherever the person moved it; an untagged one
 * only in a session Harness named, or one an older build named (`<engine>-<ms>`) that its registry
 * already holds (`taken: 'if-held'`); another daemon's, never. A session the person opened by hand is not
 * an agent: with the daemon up, its hook is turned away. The offline fallback wrote a row for one all the
 * same, and the daemon came back with an agent it would never have made and could not drive, "offline"
 * for good (e2e/hookclient.e2e.ts). Undefined when tmux could not answer.
 */
async function paneFacts(pane, dataDir) {
  const described = await describePane(pane)
  if (!described) return undefined
  const { pid, session, owner } = described
  const taken = owner ? (owner === daemonPaneOwner(dataDir) ? 'yes' : 'no')
    : session.startsWith(HARNESS_SESSION_PREFIX) ? 'yes'
    : /^[a-z][a-z0-9]*-\d{13}$/.test(session) ? 'if-held' : 'no'
  return { pid, taken }
}

/**
 * Whether the session's tmux pane is one the person opened: tmux described it, no daemon tagged it, and the daemon
 * would not take it for an agent (`paneFacts`, the rule that keeps such a session out of registration). The devices
 * are told of it as of a session outside a pane (docs/specs/2026-11-15-device-wave1-checks.md, F1). A pane tmux could
 * not describe is not the person's: the session stays in a pane, as before.
 */
async function ownPane(pane) {
  if (!/^%\d+$/.test(pane || '')) return false
  const described = await describePane(pane)
  if (!described || described.owner) return false
  return (await paneFacts(pane, paths().dataDir))?.taken === 'no'
}

/**
 * Where every daemon on this computer says it listens, one file per pane tag (src/lib/hookRoutes.ts), by default
 * in the state folder.
 */
function hookRoutesDir() {
  return homePath(process.env.HARNESS_HOOK_ROUTES_DIR) || join(harnessRoots().state, 'hook-routes')
}

/**
 * Report to the daemon that made the pane, not to the one whose command this is.
 *
 * Claude Code's and Codex's hooks are installed once per computer, in ~/.claude/settings.json and
 * $CODEX_HOME/hooks.json, and each daemon wrote its own port and data folder into them as it started. With
 * a dev daemon beside the release one, the last to start owned every hook: the other daemon's agents'
 * hooks went to it, it turned them away (the pane was not its own), and their turn ends and session
 * starts were lost. Each daemon now records its data folder and port under the tag it puts on its panes
 * (`publishHookRoute`), and the hook looks the pane's tag up: a record whose data folder hashes to that tag
 * routes this hook, its credential, and any offline write to that daemon. A record still names a daemon
 * that is down: the hook's post fails and its offline write lands in that daemon's own registry, where it
 * will read it. A pane with no tag, or a tag with no record (a daemon from before the records), keeps the
 * command's own `--port` and `--data-dir`, as every installed command did.
 */
async function routeToPaneOwner(pane) {
  if (!/^%\d+$/.test(pane || '')) return null
  const described = await describePane(pane)
  const tag = described?.owner
  if (!tag || !/^[0-9a-f]{16}$/.test(tag)) return null
  try {
    const dir = hookRoutesDir()
    secureStateDirectory(dir, false)
    const record = JSON.parse(readPrivateStateFile(join(dir, `${tag}.json`), 4096))
    const dataDir = record?.dataDir
    const port = record?.port
    if (typeof dataDir !== 'string' || !isAbsolute(dataDir) || !Number.isInteger(port) || port < 1 || port > 65535) return null
    // The record must be the tag's own, and its folder still there: a folder since removed would be
    // created again by the offline write, for a daemon that will never read it.
    if (daemonPaneOwner(dataDir) !== tag || !statSync(dataDir).isDirectory()) return null
    routed = { dataDir, port }
    return routed
  } catch { return null }
}

function argvTokens(args) {
  return (String(args || '').match(/"[^"]*"|'[^']*'|\S+/g) || []).map((token) => {
    const quoted = (token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'"))
    return quoted ? token.slice(1, -1) : token
  })
}

/**
 * Mirrors programName in src/lib/processTable.ts: the file name, lower-cased, without a Windows image's `.exe` or
 * `.com` (`claude.exe`, `node.exe` read as `claude`, `node`; a `.cmd`/`.bat`/`.ps1` script is never a process image),
 * either separator ending a folder; `cmd.exe` keeps its, since it is the Windows command processor, not Command
 * Code's `cmd`.
 */
function programName(token) {
  const path = String(token || '').replace(/[\\/]+$/, '')
  const name = path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1).toLowerCase()
  return name === 'cmd.exe' ? name : name.replace(/\.(?:exe|com)$/, '')
}

function processEntrypoint(args) {
  const tokens = argvTokens(args)
  if (!tokens.length) return ''
  let index = 0
  let command = programName(tokens[index])
  if (command === 'env') {
    index++
    while (index < tokens.length && (tokens[index].startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index]))) index++
    command = programName(tokens[index] || '')
  }
  if (!/^(?:node|nodejs|bun|deno|python(?:\d+(?:\.\d+)*)?|bash|zsh|sh)$/.test(command)) return tokens[index] || ''
  index++
  const optionsWithValue = new Set(['-r', '--require', '--loader', '--import', '--conditions', '--inspect-port'])
  const inlineCodeOptions = new Set(['-c', '--command', '-e', '--eval', '--print'])
  while (index < tokens.length) {
    const token = tokens[index]
    if (token === '--') { index++; break }
    if (token === '-m' && index + 1 < tokens.length) return tokens[index + 1]
    if (inlineCodeOptions.has(token)) return ''
    if (!token.startsWith('-')) break
    index += optionsWithValue.has(token) && index + 1 < tokens.length ? 2 : 1
  }
  return tokens[index] || ''
}

/** Hermes' managed launchers exec Python -I -c with a path bootstrap, then either import main
 * or run it through runpy. Require that executable prefix and actual code, never a script argument
 * or a quoted mention. argv[0] is authoritative here: macOS can truncate an absolute `comm` path.
 * Keep the standalone hook's copy in sync. */
/** macOS `ps` prints argv through vis(3): a newline as `\\012`, a backslash as `\\\\`. Read those back
 * so a multi-line `-c` source is the source it runs. Linux `ps` prints argv as it is, without them. */
function unvisArgs(args) {
  return args.replace(/\\([0-7]{3}|\\)/g, (_, code) => code === '\\' ? '\\' : String.fromCharCode(parseInt(code, 8)))
}

function hermesInlineLauncher(row) {
  const args = unvisArgs(row.args).trim()
  if (!/^python(?:\d+(?:\.\d+)*)?$/.test(programName(argvTokens(args)[0] ?? ''))) return false
  const prefix = /^(?:"[^"]+"|'[^']+'|\S+)(?:\s+-(?:I|E|s|S|u|B|O{1,2}|q))*\s+-c\s+/.exec(args)
  if (!prefix) return false
  const source = args.slice(prefix[0].length).replace(/^["']/, '')
  // Mask string literals before looking for Python statements. A print/prompt containing a whole
  // launcher is still data. Keep literal values only to identify runpy's exact entry module.
  const literals = []
  const code = source.replace(/(['"])(?:\\[\s\S]|(?!\1)[^\\])*?\1/g, (literal) => {
    literals.push(literal.slice(1, -1))
    return `__literal${literals.length - 1}__`
  })
  if (!/^import\s+(?:(?:os|re|sys|runpy)\s*,\s*)*(?:sys|runpy)[;\s]+(?:os\.environ\.pop\(__literal\d+__,\s*None\)[;\s]+)*sys\.path\.insert\(\s*0,\s*__literal\d+__\s*\)/.test(code)) return false
  if (/\bimport\s+hermes_bootstrap\b/.test(code)
    && /\bfrom\s+hermes_cli\.main\s+import\s+main\b/.test(code)
    && /\bsys\.exit\(\s*main\(\)\s*\)/.test(code)) return true
  const run = /\brunpy\.run_module\(\s*__literal(\d+)__\s*,\s*run_name\s*=\s*__literal(\d+)__(?:\s*,\s*alter_sys\s*=\s*True)?\s*\)/.exec(code)
  return !!run && literals[Number(run[1])] === 'hermes_cli.main' && literals[Number(run[2])] === '__main__'
}

const ENGINE_COMMANDS = {
  claude: 'claude', codex: 'codex', cursor: 'agent', hermes: 'hermes', commandcode: 'cmd',
  devin: 'devin', muse: 'muse', grok: 'grok', agy: 'agy', copilot: 'copilot',
}
const ENGINE_PATH_ENV = {
  claude: 'CLAUDE_PATH', codex: 'CODEX_PATH', cursor: 'CURSOR_PATH', hermes: 'HERMES_PATH',
  commandcode: 'COMMANDCODE_PATH', devin: 'DEVIN_PATH', muse: 'MUSE_PATH', grok: 'GROK_PATH',
  agy: 'AGY_PATH', copilot: 'COPILOT_PATH',
}

function executableIdentity(path) {
  try {
    const realPath = realpathSync(path)
    const stat = statSync(realPath)
    return stat.isFile() ? { realPath, fileKey: `${String(stat.dev)}:${String(stat.ino)}` } : null
  } catch {
    return null
  }
}

function commandIdentity(command) {
  if (!command) return null
  if (isAbsolute(command) || command.includes('/') || command.includes('\\')) {
    try { accessSync(command, constants.X_OK) } catch { return null }
    return executableIdentity(command)
  }
  for (const dir of String(process.env.PATH || '').split(delimiter).filter(Boolean)) {
    const path = join(dir, command)
    try { accessSync(path, constants.X_OK) } catch { continue }
    const identity = executableIdentity(path)
    if (identity) return identity
  }
  return null
}

function hookCommandOwnership(p) {
  const agent = commandIdentity('agent')
  const cursor = commandIdentity(process.env.CURSOR_PATH || 'cursor-agent')
  const grok = commandIdentity(process.env.GROK_PATH || 'grok') || commandIdentity(join(p.grokHome, 'bin', 'grok'))
  const cursorKeys = new Set(cursor ? [cursor.fileKey] : [])
  const grokKeys = new Set(grok ? [grok.fileKey] : [])
  if (agent && /\/cursor-agent\/versions\/[^/]+\/cursor-agent$/.test(agent.realPath.split(sep).join('/'))) {
    cursorKeys.add(agent.fileKey)
  }
  return { agentFileKey: agent?.fileKey, cursorKeys, grokKeys }
}

function hookFileOwner(fileKey, ownership) {
  if (!fileKey) return 'unknown'
  const isCursor = ownership.cursorKeys.has(fileKey)
  const isGrok = ownership.grokKeys.has(fileKey)
  if (isCursor && isGrok) return 'conflict'
  if (isCursor) return 'cursor'
  if (isGrok) return 'grok'
  return 'unknown'
}

/** Mirrors commTruncatedPrefixOf in src/lib/tmux.ts: Linux caps `comm` at 15 bytes (TASK_COMM_LEN). */
function commTruncatedPrefixOf(seen, want) {
  if (process.platform !== 'linux' || !seen || !want) return false
  return Buffer.byteLength(seen) === 15 && want.length > seen.length && want.startsWith(seen)
}

function processMatchScore(row, engine, ownership, allowAgentHint = false) {
  if (engine === 'hermes' && hermesGatewayProcess(row)) return 0
  const executable = programName(row.executable)
  const entrypoint = processEntrypoint(row.args).toLowerCase()
  const entrybase = programName(entrypoint)
  const explicit = process.env[ENGINE_PATH_ENV[engine]]
  const configured = String(explicit || ENGINE_COMMANDS[engine] || '').toLowerCase()
  const configuredBase = programName(configured)
  // Linux's `comm` cap is in bytes of the name as the kernel holds it: compared unstripped.
  if (configuredBase && configuredBase !== 'agent' && (row.executable.toLowerCase() === configured
    || entrypoint === configured || executable === configuredBase || entrybase === configuredBase
    || commTruncatedPrefixOf(basename(row.executable).toLowerCase(), basename(configured).toLowerCase()))) return 4
  if (engine === 'codex') return /@openai[\/\\]codex[\/\\]bin[\/\\]codex(?:\.js)?$/.test(entrypoint) ? 2 : 0
  if (engine === 'cursor') {
    if (executable === 'cursor-agent' || entrybase === 'cursor-agent') return 3
    if (argvTokens(row.args).slice(0, 8).some((token) =>
      /cursor-agent[\/\\]versions[\/\\][^/\\]+[\/\\]index\.js$/i.test(token))) return 3
    if (executable === 'agent' || entrybase === 'agent') {
      const aliasOwner = hookFileOwner(row.imageFileKey, ownership) !== 'unknown'
        ? hookFileOwner(row.imageFileKey, ownership)
        : hookFileOwner(ownership.agentFileKey, ownership)
      if (aliasOwner === 'cursor') return 4
      if (aliasOwner === 'grok' || aliasOwner === 'conflict') return 0
      return allowAgentHint ? 1 : 0
    }
    return 0
  }
  if (engine === 'commandcode') {
    if (/^\s*⌘(?:\s|$)/.test(row.executable) || /^\s*⌘(?:\s|$)/.test(row.args)
      || executable === 'commandcode' || executable === 'command-code'
      || entrybase === 'commandcode' || entrybase === 'command-code') return 3
    return /command-code[\/\\]dist[\/\\]index\.mjs$/.test(entrypoint) ? 2 : 0
  }
  if (engine === 'devin') return /devin[\/\\]cli[\/\\]_versions[\/\\][^/\\]+[\/\\]bin[\/\\]devin$/.test(entrypoint) ? 2 : 0
  if (engine === 'hermes' && hermesInlineLauncher(row)) return 2
  if (engine === 'hermes') return /hermes-agent[\/\\]hermes$/.test(entrypoint)
    || /^(?:hermes|hermes_cli)(?:\.|$)/.test(entrypoint) ? 2 : 0
  if (engine === 'muse') return /^muse-bin-/.test(executable) || /^muse-bin-/.test(entrybase) ? 3 : 0
  if (engine === 'grok') {
    if (executable === 'grok' || entrybase === 'grok') return 3
    if (executable === 'agent' || entrybase === 'agent') {
      const aliasOwner = hookFileOwner(row.imageFileKey, ownership) !== 'unknown'
        ? hookFileOwner(row.imageFileKey, ownership)
        : hookFileOwner(ownership.agentFileKey, ownership)
      if (aliasOwner === 'grok') return 4
      if (aliasOwner === 'cursor' || aliasOwner === 'conflict') return 0
      return allowAgentHint ? 1 : 0
    }
    return /\.grok[\/\\]bin[\/\\]grok$/.test(entrypoint) ? 2 : 0
  }
  return /@anthropic-ai[\/\\]claude-code[\/\\]cli\.js$/.test(entrypoint) ? 2 : 0
}

/** Mirrors compareVersions in src/lib/ptyHost/launch.ts. */
/**
 * Mirrors ptyHostBinary in src/lib/ptyHost/launch.ts: `HARNESS_PTY_BIN` as it is, else
 * `<runtime>/pty/<version>/harness-pty.exe` for the version `<runtime>/pty/current-pty` names (the installed CLI's;
 * a version name alone), else the one in `pty/` beside this script (the bundle's).
 */
function ptyHostBinary() {
  const override = process.env.HARNESS_PTY_BIN?.trim()
  if (override) return override
  const binary = 'harness-pty.exe'
  const root = join(homePath(process.env.ADAPTER_RUNTIME_DIR) || join(homedir(), '.harness', 'runtime'), 'pty')
  let version = ''
  try { version = readFileSync(join(root, 'current-pty'), 'utf8').trim() } catch { /* none installed */ }
  if (/^\d+(\.\d+)*$/.test(version)) {
    const file = join(root, version, binary)
    try { accessSync(file, constants.F_OK); return file } catch { /* the bundle's, then */ }
  }
  const beside = join(dirname(fileURLToPath(import.meta.url)), 'pty', binary)
  try { accessSync(beside, constants.F_OK); return beside } catch { return null }
}

/** The PTY host's whole table, read once a run: the engine's lookup and the caller's descent (rootEngineProcess,
 *  callerOwns) share one start. They need rows off the hook's chain (the pane's processes, and more than 9 parents). */
let windowsTable
function windowsListedRows() {
  windowsTable ??= readWindowsTable()
  return windowsTable
}

/**
 * Windows has no `ps`: the PTY host lists the processes (`harness-pty ps --json`, pty/src/ps.rs), and the rows
 * map as the daemon maps them (src/lib/windows/processTable.ts). A row without a start marker (a process the
 * host could not open) can never be an identity and is dropped; a read that names nobody failed.
 */
async function windowsProcessRows() {
  const rows = (await windowsListedRows())?.filter((row) => row.startMarker)
  return rows?.length ? rows : null
}

/** Every row the PTY host lists for `ps --json` and [args], those it could not open (an empty start marker) included;
 *  null for a failed read. */
async function readWindowsTable(args = []) {
  const binary = ptyHostBinary()
  if (!binary) return null
  // A busy machine's table is a few hundred KB of JSON: the daemon's own limit (src/lib/windows/processTable.ts).
  const stdout = await execFileText(binary, ['ps', '--json', ...args], 3000, undefined, { maxBuffer: 64 * 1024 * 1024, windowsHide: true })
  if (stdout === null) return null
  let table
  try { table = JSON.parse(stdout) } catch { return null }
  if (!table || !Array.isArray(table.rows)) return null
  const rows = []
  for (const row of table.rows) {
    if (!row || typeof row !== 'object') continue
    const { pid, parentPid, executable, startMarker, args, nativeArgv, imagePath } = row
    if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(parentPid) || parentPid < 0) continue
    if (typeof executable !== 'string' || typeof args !== 'string' || typeof startMarker !== 'string') continue
    rows.push({
      pid, parentPid, executable, startMarker, args,
      ...(Array.isArray(nativeArgv) && nativeArgv.every((item) => typeof item === 'string') ? { nativeArgv } : {}),
      ...(typeof imagePath === 'string' ? { imagePath } : {}),
    })
  }
  return rows
}

async function processRows() {
  if (process.platform === 'win32') return windowsProcessRows()
  const stdout = await execFileText('ps', ['-axo', 'pid=,ppid=,comm=,lstart=,args='], 3000, psEnv())
  if (stdout === null) return null
  const rows = []
  for (const line of stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s+(\S+\s+\S+\s+\d{1,2}\s+\d{1,2}:\d{2}:\d{2}\s+\d{4})\s*(.*)$/.exec(line)
    if (!match) continue
    rows.push({
      pid: Number(match[1]),
      parentPid: Number(match[2]),
      executable: match[3],
      startMarker: match[4],
      args: match[5],
    })
  }
  return repairMangledRows(rows)
}

function aliasRows(rows) {
  return rows.filter((row) => programName(row.executable) === 'agent'
    || programName(processEntrypoint(row.args)) === 'agent')
}

async function enrichProcessImages(rows) {
  const candidates = aliasRows(rows)
  if (!candidates.length) return rows
  const images = new Map()
  if (process.platform === 'linux') {
    for (const row of candidates) {
      const identity = executableIdentity(`/proc/${row.pid}/exe`)
      if (identity) images.set(row.pid, identity.fileKey)
    }
  } else if (process.platform === 'darwin') {
    const stdout = await execFileText('lsof', ['-a', '-p', candidates.map((row) => row.pid).join(','), '-d', 'txt', '-Fn'], 1500)
    let pid = null
    let textFile = false
    for (const line of String(stdout || '').split('\n')) {
      if (/^p\d+$/.test(line)) {
        pid = Number(line.slice(1))
        textFile = false
      } else if (line === 'ftxt') {
        textFile = true
      } else if (textFile && pid && line.startsWith('n') && !images.has(pid)) {
        const identity = executableIdentity(line.slice(1).replace(/ \(deleted\)$/, ''))
        if (identity) images.set(pid, identity.fileKey)
        textFile = false
      }
    }
  }
  return rows.map((row) => images.has(row.pid) ? { ...row, imageFileKey: images.get(row.pid) } : row)
}

async function rootEngineProcess(rootPid, engine) {
  const rawRows = await processRows()
  if (!rawRows) return { state: 'unknown' }
  const rows = await enrichProcessImages(rawRows)
  const ownership = hookCommandOwnership(paths())
  const children = new Map()
  const byPid = new Map(rows.map((row) => [row.pid, row]))
  for (const row of rows) {
    const list = children.get(row.parentPid) || []
    list.push(row)
    children.set(row.parentPid, list)
  }
  const queue = [{ pid: rootPid, depth: 0 }]
  let best = null
  while (queue.length > 0) {
    const current = queue.shift()
    const row = byPid.get(current.pid)
    const score = row ? processMatchScore(row, engine, ownership, true) : 0
    if (row && score > 0 && (!best || current.depth < best.depth || (current.depth === best.depth && score > best.score))) {
      best = { row, depth: current.depth, score }
    }
    for (const child of children.get(current.pid) || []) queue.push({ pid: child.pid, depth: current.depth + 1 })
  }
  if (!best) return { state: 'gone' }
  const identity = { pid: best.row.pid, executable: best.row.executable, startMarker: best.row.startMarker }
  let native = null
  if (process.platform === 'linux') {
    native = linuxOwnerBirth(identity.pid)
    if (!native) return { state: 'unknown' }
    identity.startTicks = native.startTicks
  }
  // Retain kernel facts across the registry lock and durable staging. A live PID with the
  // same ticks can still have changed its command or parent since the pane/caller walk.
  const current = () => {
    if (!native) return true
    const now = linuxOwnerBirth(identity.pid)
    return !!now && now.startTicks === native.startTicks && now.parentPid === native.parentPid && now.command === native.command
  }
  return { state: 'alive', identity, current }
}

/**
 * Hermes delegation children execute the same pane-scoped hook as the visible CLI session. During
 * daemon downtime the regular hook server cannot apply its source guard, so consult Hermes' own store
 * before writing the offline registry. Unknown is deliberately fail-closed: the startup reconciler can
 * still create the process-owned agent and session repair can bind it once the daemon returns, whereas
 * accepting an unknown row can replace the parent's session with a child.
 */
async function hermesTopLevelSession(dbPath, sessionId) {
  // Hermes 0.23's unified runtime names a session `local-<sha256>` and keeps a CLI or TUI one as
  // source='local', its creator in `created_source` (cli/src/engines/hermes/contract.ts `HERMES_SOURCE`).
  // Only that runtime makes such ids, and it adds the column to every store it opens, so only they ask
  // for it; a store without it fails the query and reads as unreadable, which is fail-closed.
  const local = /^local-[0-9a-f]{64}$/.test(String(sessionId || ''))
  if (!local && !/^[0-9]{8}_[0-9]{6}_[0-9a-fA-F]{4,16}$/.test(String(sessionId || ''))) return false
  // EVERY home on this machine, this one first. `hermes -p <name>` keeps its sessions in
  // `~/.hermes/profiles/<name>/state.db`, and the block in a profile's config.yaml may still name the
  // DEFAULT home (Hermes copies the config when it creates a profile, and older installs baked the
  // default path into it) — so a profile session looked unknown here and was dropped, silently, on
  // every registration the daemon was not up for (openharness#191). The extra stores are asked only
  // when this one has no row, which on a single-home machine is never.
  const homes = hermesHomes(dbPath)
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt > 0) await sleep(75)
    let sawStore = false
    for (const db of homes) {
      const raw = await execFileText('sqlite3', [
        '-json', '-cmd', '.timeout 500', '-cmd', 'PRAGMA query_only=1', `file:${db}?mode=ro`,
        `SELECT source${local ? ', created_source' : ''} FROM sessions WHERE id = '${sessionId}';`,
        // As long as the process scan gets: on a loaded machine a second is not always enough to
        // spawn sqlite3, and a lookup cut short drops a real session's registration.
      ], 3000)
      if (raw === null) continue     // unreadable store — another home may still hold the row
      sawStore = true
      try {
        const rows = JSON.parse(raw.trim() || '[]')
        if (!Array.isArray(rows) || rows.length === 0) continue
        const source = typeof rows[0]?.source === 'string' ? rows[0].source : ''
        if (local && source === 'local') {
          const created = rows[0]?.created_source
          // Not stamped yet ('unknown' is Hermes's placeholder): ask again, as for a row not written yet.
          if (created === null || created === undefined || created === '' || created === 'unknown' || created === 'local') continue
          return (created === 'cli' || created === 'tui') ? db : false
        }
        return (source === '' || source === 'cli' || source === 'tui') ? db : false
      } catch {
        return false
      }
    }
    if (!sawStore) return false
  }
  return false
}

/** `dbPath` and every sibling profile store, deduped, the given one first. */
function hermesHomes(dbPath) {
  const home = dirname(dbPath)
  const roots = [home]
  // A profile store sits at <default home>/profiles/<name>/state.db, so the default home is two
  // levels up from one and the profiles folder is beside the other. Both spellings are cheap to try.
  const base = basename(dirname(home)) === 'profiles' ? dirname(dirname(home)) : home
  if (base !== home) roots.push(base)
  const out = roots.map((root) => join(root, 'state.db'))
  let names = []
  try { names = readdirSync(join(base, 'profiles')) } catch { return [...new Set(out)] }
  for (const name of names.slice(0, 64)) out.push(join(base, 'profiles', name, 'state.db'))
  return [...new Set(out)]
}

function bootTimeSec() {
  return Math.round(Date.now() / 1000 - uptime())
}

// Which boot this is, named as src/lib/bootId.ts names it: the two read and write the same boot file, so
// they must agree. macOS has a per-boot id too; without it a boot was named by the moment it began, which
// moves with every step of the wall clock, and a hook that fell back to the registry after an NTP step
// or a long sleep took the step for a reboot and wrote a registry of its one agent (round 29).
let bootId = null
function currentBootId() {
  if (bootId) return bootId
  try {
    const value = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()
    if (/^[0-9a-f-]{36}$/i.test(value)) return (bootId = `linux:${value}`)
  } catch { /* not Linux */ }
  if (process.platform === 'darwin') {
    try {
      const value = execFileSync('/usr/sbin/sysctl', ['-n', 'kern.bootsessionuuid'], { encoding: 'utf8', timeout: 1000 }).trim()
      if (/^[0-9a-f-]{36}$/i.test(value)) return (bootId = `macos:${value}`)
    } catch { /* sysctl unavailable: the moment the boot began, below */ }
  }
  return (bootId = `time:${bootTimeSec()}`)
}

function readSavedBoot(bootFile) {
  try {
    secureStateDirectory(dirname(bootFile), false)
    const raw = readPrivateStateFile(bootFile, 256).trim()
    if (!raw) return null
    try {
      const parsed = JSON.parse(raw)
      return typeof parsed === 'string' ? parsed : raw
    } catch { return raw }
  } catch {
    return null
  }
}

function writeBoot(bootFile) {
  let tmp = ''
  let renamed = false
  try {
    secureStateDirectory(dirname(bootFile))
    hardenPrivateStateFileIfPresent(bootFile, 256)
    tmp = `${bootFile}.${process.pid}.${randomUUID()}.tmp`
    const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    try { writeFileSync(fd, currentBootId()); fsyncSync(fd) } finally { closeSync(fd) }
    renameSync(tmp, bootFile)
    renamed = true
    syncStateDirectory(dirname(bootFile))
  } catch {
    // best effort
  } finally {
    if (tmp && !renamed) {
      try { rmSync(tmp, { force: true }) } catch { /* best effort */ }
    }
  }
}

function rebootedSinceSnapshot(bootFile) {
  const saved = readSavedBoot(bootFile)
  if (saved === null) return false
  const current = currentBootId()
  if (saved.startsWith('linux:')) return saved !== current
  // A macOS id that cannot be read now is no evidence of a reboot.
  if (saved.startsWith('macos:')) return !current.startsWith('time:') && saved !== current
  const savedNumber = Number(saved.replace(/^time:/, ''))
  const currentNumber = current.startsWith('time:') ? Number(current.slice(5)) : bootTimeSec()
  return !Number.isFinite(savedNumber) || Math.abs(currentNumber - savedNumber) > BOOT_TOLERANCE_SEC
}

function isWithin(root, file) {
  const rel = relative(root, file)
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith('/') && !rel.startsWith('\\'))
}

function validTranscriptPath(engine, filePath, p) {
  try {
    const actual = realpathSync(filePath)
    const root = realpathSync(
      engine === 'codex' ? p.codexSessionsDir
        : engine === 'grok' ? p.grokSessionsDir
        : engine === 'agy' ? p.agyBrainDir
        : engine === 'copilot' ? p.copilotSessionsDir
        : engine === 'cursor' ? p.cursorProjectsDir
        : engine === 'commandcode' ? p.commandcodeProjectsDir
        : p.claudeProjectsDir,
    )
    const st = statSync(actual)
    if (!st.isFile() || !isWithin(root, actual)) return false
    if (engine === 'cursor') {
      const id = basename(actual).replace(/\.jsonl$/, '')
      if (!id || basename(dirname(actual)) !== id || basename(dirname(dirname(actual))) !== 'agent-transcripts') return false
    }
    const uid = typeof process.getuid === 'function' ? process.getuid() : null
    return uid === null || st.uid === uid
  } catch {
    return false
  }
}

function isCodexSubagent(input, p) {
  const source = input && typeof input.source === 'object' && !Array.isArray(input.source)
    ? input.source
    : null
  if (source && source.subagent != null) return true
  const file = typeof input.transcript_path === 'string' ? input.transcript_path : ''
  if (!file || !validTranscriptPath('codex', file, p)) return false
  let fd = null
  try {
    fd = openSync(file, 'r')
    const buffer = Buffer.alloc(CODEX_META_MAX_BYTES)
    const bytes = readSync(fd, buffer, 0, buffer.length, 0)
    const firstLine = buffer.subarray(0, bytes).toString('utf8').split('\n').find((line) => line.trim())
    if (!firstLine) return false
    const record = JSON.parse(firstLine)
    return record?.type === 'session_meta' && record?.payload?.source?.subagent != null
  } catch {
    return false
  } finally {
    if (fd !== null) {
      try { closeSync(fd) } catch { /* best effort */ }
    }
  }
}

function removeLockOwnedBy(lockDir, token) {
  try {
    const owner = JSON.parse(readFileSync(join(lockDir, 'owner.json'), 'utf8'))
    if (owner?.token === token) rmSync(lockDir, { recursive: true, force: true })
  } catch { /* another owner or unsafe artifact must not be removed */ }
}

function processStartMarker(pid) {
  // Windows has no /proc, and a `ps` on its PATH is Git's, which knows no Windows pid: a lock names its owner by pid alone.
  if (process.platform === 'win32' || !Number.isSafeInteger(pid) || pid <= 0) return null
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)
    if (fields[19]) return `linux:${fields[19]}`
  } catch { /* non-Linux or exited process; use ps below */ }
  try {
    const started = execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], {
      encoding: 'utf8', timeout: 1000, env: { ...psEnv(), TZ: 'UTC' },
    }).trim()
    return started ? `ps-c:${started}` : null
  } catch { return null }
}

function processAlive(pid, startMarker = '') {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0) } catch (error) { if (error?.code !== 'EPERM') return false }
  if (!startMarker) return true
  const current = processStartMarker(pid)
  // Pre-upgrade ps markers may use another locale; a mismatch is not death.
  const comparable = current !== null && ['linux:', 'ps-c:'].some(
    (prefix) => startMarker.startsWith(prefix) && current.startsWith(prefix),
  )
  return !comparable || current === startMarker
}


// The legacy field stays empty for ps-c so old readers fall back to PID liveness during upgrade.
function processLockIdentity(pid) {
  const generationMarker = processStartMarker(pid) || ''
  return { startMarker: generationMarker.startsWith('ps-c:') ? '' : generationMarker, generationMarker }
}

function lockStartMarker(owner) {
  return typeof owner?.generationMarker === 'string' ? owner.generationMarker
    : typeof owner?.startMarker === 'string' ? owner.startMarker : ''
}

async function withRegistryLock(registryFile, fn) {
  const lockDir = `${registryFile}.lock`
  const dataDir = dirname(registryFile)
  try {
    secureStateDirectory(dataDir)
  } catch { return }
  const processIdentity = processLockIdentity(process.pid)
  for (let i = 0; i < LOCK_RETRIES; i++) {
    if (remainingBudget(750) < 50) return
    const token = randomUUID()
    let created = false
    try {
      mkdirSync(lockDir, { mode: 0o700 })
      created = true
      const ownerFile = join(lockDir, 'owner.json')
      const ownerFd = openSync(ownerFile, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
      try {
        writeFileSync(ownerFd, JSON.stringify({ pid: process.pid, ...processIdentity, token }))
        fsyncSync(ownerFd)
      } finally { closeSync(ownerFd) }
      try {
        return fn()
      } finally {
        removeLockOwnedBy(lockDir, token)
      }
    } catch (error) {
      if (created) removeLockOwnedBy(lockDir, token)
      if (error?.code !== 'EEXIST') return
      try {
        const uid = typeof process.getuid === 'function' ? process.getuid() : null
        const st = lstatSync(lockDir)
        const ownerStat = lstatSync(join(lockDir, 'owner.json'))
        // No mode on Windows, as the daemon's lock (src/lib/registryPersistence.ts) has none there.
        const unix = process.platform !== 'win32'
        if (!st.isDirectory() || st.isSymbolicLink() || (uid !== null && st.uid !== uid) || (unix && (st.mode & 0o777) !== 0o700)
          || !ownerStat.isFile() || ownerStat.isSymbolicLink() || (uid !== null && ownerStat.uid !== uid)
          || (unix && (ownerStat.mode & 0o777) !== 0o600)) return
        const owner = JSON.parse(readFileSync(join(lockDir, 'owner.json'), 'utf8'))
        const ownerPid = Number(owner?.pid)
        const ownerStartMarker = lockStartMarker(owner)
        const ownerToken = typeof owner?.token === 'string' ? owner.token : ''
        if (!processAlive(ownerPid, ownerStartMarker) && ownerPid > 0 && ownerToken) {
          const current = JSON.parse(readFileSync(join(lockDir, 'owner.json'), 'utf8'))
          if (Number(current?.pid) === ownerPid
            && lockStartMarker(current) === ownerStartMarker
            && current?.token === ownerToken
            && !processAlive(ownerPid, ownerStartMarker)) {
            rmSync(lockDir, { recursive: true, force: true })
            continue
          }
        }
      } catch {
        // Lock disappeared or is still being initialized; wait without stealing it.
      }
      await sleep(LOCK_RETRY_MS)
    }
  }
}

function readJsonArray(file) {
  try {
    secureStateDirectory(dirname(file), false)
    const arr = JSON.parse(readPrivateStateFile(file))
    return Array.isArray(arr) ? arr : []
  } catch (error) {
    return error?.code === 'ENOENT' ? [] : null
  }
}

function readRegistryState(file) {
  try {
    secureStateDirectory(dirname(file), false)
    const rows = JSON.parse(readPrivateStateFile(file))
    if (!Array.isArray(rows)) return null
    if (rows.some((row) => row && typeof row === 'object'
      && Object.hasOwn(row, 'schemaVersion') && row.schemaVersion !== 2)) return null
    const legacyRows = rows.filter((row) => !row || typeof row !== 'object' || !Object.hasOwn(row, 'schemaVersion'))
    if (legacyRows.some((row) => !validLegacyRegistryRow(row))) return null
    const v2Rows = rows.filter((row) => row && typeof row === 'object' && row.schemaVersion === 2)
    if (v2Rows.length && !validV2Registry(v2Rows)) return null
    return rows
  } catch (error) {
    return error?.code === 'ENOENT' ? [] : null
  }
}

function writeRegistry(file, sessions, current = () => true) {
  secureStateDirectory(dirname(file))
  hardenPrivateStateFileIfPresent(file)
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`
  let renamed = false
  try {
    const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    try {
      writeFileSync(fd, JSON.stringify(sessions, null, 2))
      fchmodSync(fd, 0o600)
      fsyncSync(fd)
    } finally { closeSync(fd) }
    if (!current()) return false
    renameSync(tmp, file)
    renamed = true
    syncStateDirectory(dirname(file))
    return true
  } finally {
    if (!renamed) {
      try { rmSync(tmp, { force: true }) } catch { /* ignore */ }
    }
  }
}

/**
 * The editor each panel hook's VSCODE_PID named (lookUpWindowsApp), kept in the data folder so the next hook of that
 * editor starts no pty host. On Windows alone, and only the hook reads or writes it. At most EDITORS_MAX entries of a
 * pid, the key of the editor's pipe (editorIpcKey) and a bundle id, the newest first: never a path or a pipe's name.
 */
const EDITORS_FILE = 'hook-editors.json'
const EDITORS_MAX = 16
const EDITORS_MAX_BYTES = 4096

/** The key of the editor this hook runs under: the first 16 hex digits of the SHA-256 of its pipe's name
 *  (`\\.\pipe\<hex>-<version>-main-sock`), or null when VSCODE_IPC_HOOK holds none: then nothing is read or kept. */
function editorIpcKey() {
  const pipe = process.env.VSCODE_IPC_HOOK ?? ''
  return /^\\\\\.\\pipe\\[^\\]{1,200}$/.test(pipe) ? createHash('sha256').update(pipe).digest('hex').slice(0, 16) : null
}

/** The kept answers. A file missing, over EDITORS_MAX_BYTES, not JSON, of another shape or a link reads as none. */
function readEditors(file) {
  try {
    const editors = JSON.parse(readWindowsStateFile(dirname(file), file, EDITORS_MAX_BYTES)).editors
    const apps = [...WINDOWS_EDITORS.values()]
    const valid = Array.isArray(editors) && editors.length <= EDITORS_MAX && editors.every((entry) =>
      Number.isSafeInteger(entry?.pid) && entry.pid > 0 && typeof entry.ipc === 'string' && /^[0-9a-f]{16}$/.test(entry.ipc)
      && apps.includes(entry.app))
    return valid ? editors.map(({ pid, ipc, app }) => ({ pid, ipc, app })) : []
  } catch { return [] }
}

/**
 * Puts [entry] first among the kept answers, the EDITORS_MAX newest kept, written whole: a temporary file renamed over
 * the old one (a link there is replaced, never followed), so a reader sees the old list or the new. It is the hook's
 * copy of atomicWriteJson and readState (src/lib/secureState.ts), because this file imports nothing from src/. As
 * there on Windows, no owner or mode is checked (NTFS gives Node neither; see secureStateDirectory): the file is read
 * as the hook reads its other Windows state (readWindowsStateFile), and like a cache it is not flushed, since one a
 * power cut empties reads as none and is written again. Two hooks writing at once each write it whole: the last rename
 * wins, and the entry lost is read from the table next time. Never throws: a failed write keeps nothing.
 */
function keepEditor(file, entry) {
  const editors = [entry, ...readEditors(file).filter(({ pid, ipc }) => pid !== entry.pid || ipc !== entry.ipc)]
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`
  let renamed = false
  try {
    const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    try {
      writeFileSync(fd, JSON.stringify({ editors: editors.slice(0, EDITORS_MAX) }, null, 2))
      fchmodSync(fd, 0o600)
    } finally { closeSync(fd) }
    renameSync(tmp, file)
    renamed = true
  } catch { /* nothing kept */ } finally {
    if (!renamed) {
      try { rmSync(tmp, { force: true }) } catch { /* ignore */ }
    }
  }
}

function cursorPendingFile() {
  return join(paths().dataDir, 'cursor-pending-tasks.json')
}

function boundedJson(value) {
  try {
    const serialized = JSON.stringify(value ?? {})
    if (Buffer.byteLength(serialized) <= CURSOR_TASK_MAX_INPUT_BYTES) return JSON.parse(serialized)
  } catch {
    // use the bounded fallback
  }
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  return {
    description: typeof input.description === 'string' ? input.description.slice(0, 2_000) : '',
    prompt: typeof input.prompt === 'string' ? input.prompt.slice(0, 16_000) : '',
    model: typeof input.model === 'string' ? input.model.slice(0, 200) : '',
  }
}

async function persistCursorTask(input) {
  const sessionId = input.session_id || input.conversation_id
  const toolUseId = input.tool_use_id
  if (typeof sessionId !== 'string' || !sessionId || typeof toolUseId !== 'string' || !toolUseId) return
  const file = cursorPendingFile()
  await withRegistryLock(file, () => {
    const now = Date.now()
    const current = readJsonArray(file)
    if (current === null) return
    const existing = current.filter((item) =>
      item
      && typeof item.sessionId === 'string'
      && typeof item.toolUseId === 'string'
      && typeof item.createdAt === 'number'
      && now - item.createdAt <= CURSOR_TASK_MAX_AGE_MS
      && item.toolUseId !== toolUseId)
    existing.push({ sessionId, toolUseId, input: boundedJson(input.tool_input), createdAt: now })
    writeRegistry(file, existing.slice(-CURSOR_TASK_MAX_ENTRIES))
  })
}

async function clearCursorTasks(sessionId) {
  if (typeof sessionId !== 'string' || !sessionId) return
  const file = cursorPendingFile()
  await withRegistryLock(file, () => {
    const current = readJsonArray(file)
    if (current === null) return
    const next = current.filter((item) => !item || item.sessionId !== sessionId)
    if (next.length) writeRegistry(file, next)
    else {
      try { rmSync(file, { force: true }) } catch { /* best effort */ }
    }
  })
}

function runtimeRouteKey(runtime) {
  return `tmux\u0000${runtime.paneId}`
}

function runtimePlacementKey(runtime) {
  return runtimeRouteKey(runtime)
}

function mergeRuntimes(current, observed) {
  const merged = new Map()
  for (const runtime of [...(Array.isArray(current) ? current : []), ...observed]) {
    if (runtime?.backend === 'tmux') merged.set(runtimePlacementKey(runtime), runtime)
  }
  return [...merged.values()].sort((a, b) => runtimePlacementKey(a).localeCompare(runtimePlacementKey(b)))
}

// Every engine a registry row can name: the daemon's own list (src/engines/types.ts ENGINES), which
// hookNotify.spec.ts keeps this one equal to. A row naming one missing here made the whole registry read
// as damaged, and a hook while the daemon was down then registered nothing at all: `terminal` was
// missing, so one terminal open on the machine was enough (e2e/hookclient.e2e.ts).
const REGISTRY_ENGINES = new Set([
  'claude', 'codex', 'cursor', 'opencode', 'pi', 'omp', 'hermes', 'commandcode', 'devin', 'muse', 'amp', 'kilo', 'grok',
  'agy', 'copilot', 'openclaw', 'terminal',
])

function validRegistryString(value, max = 4096) {
  return typeof value === 'string' && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value)
}

function validRegistryRuntime(runtime) {
  return !!runtime && typeof runtime === 'object'
    && runtime.backend === 'tmux' && typeof runtime.paneId === 'string' && /^%\d+$/.test(runtime.paneId)
}

function validRegistryProcess(identity) {
  return identity === null || (!!identity && typeof identity === 'object'
    && Number.isSafeInteger(identity.pid) && identity.pid > 0
    && validRegistryString(identity.executable, 1000)
    && validRegistryString(identity.startMarker, 200) && identity.startMarker.length > 0
    && (identity.startTicks === undefined || Number.isSafeInteger(identity.startTicks) && identity.startTicks >= 0))
}

function validV2Registry(rows) {
  const agents = new Set()
  const sessions = new Set()
  const processes = new Set()
  const routes = new Set()
  for (const row of rows) {
    if (row.schemaVersion !== 2 || row.active !== true && row.active !== false
      || !validRegistryString(row.agentId, 200) || !row.agentId
      || !validRegistryString(row.sessionId, 200)
      || !REGISTRY_ENGINES.has(row.engine)
      || !validRegistryString(row.projectDir)
      || !Array.isArray(row.runtimes) || !row.runtimes.length || !row.runtimes.every(validRegistryRuntime)
      || typeof row.primaryRuntimeKey !== 'string'
      || !validRegistryProcess(row.processIdentity)) return false
    const placementKeys = row.runtimes.map(runtimePlacementKey)
    if (new Set(placementKeys).size !== placementKeys.length) return false
    const routeKeys = row.runtimes.map(runtimeRouteKey)
    if (row.active ? !routeKeys.includes(row.primaryRuntimeKey) : row.primaryRuntimeKey !== '') return false
    const tmuxProjection = row.runtimes.find((runtime) => runtime.backend === 'tmux')?.paneId
    if (tmuxProjection ? row.tmuxPane !== tmuxProjection : Object.hasOwn(row, 'tmuxPane')) return false
    if (agents.has(row.agentId)) return false
    agents.add(row.agentId)
    if (row.sessionId) {
      if (sessions.has(row.sessionId)) return false
      sessions.add(row.sessionId)
    }
    if (row.processIdentity) {
      const processKey = `${row.engine}\u0000${row.processIdentity.pid}\u0000${row.processIdentity.startMarker}`
      if (processes.has(processKey)) return false
      processes.add(processKey)
    }
    for (const route of routeKeys) {
      if (routes.has(route)) return false
      routes.add(route)
    }
  }
  return true
}

function validLegacyRegistryRow(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row) || Object.hasOwn(row, 'schemaVersion')) return false
  const id = typeof row.agentId === 'string' && row.agentId ? row.agentId : row.launcherId
  if (!validRegistryString(id, 200) || !id) return false
  if (row.engine !== undefined && !REGISTRY_ENGINES.has(row.engine)) return false
  if (row.tmuxPane !== undefined && (typeof row.tmuxPane !== 'string' || !/^%\d+$/.test(row.tmuxPane))) return false
  if (row.runtimes !== undefined
    && (!Array.isArray(row.runtimes) || !row.runtimes.length || !row.runtimes.every(validRegistryRuntime))) return false
  return /^%\d+$/.test(row.tmuxPane || '') || (Array.isArray(row.runtimes) && row.runtimes.length > 0)
}

function linuxOwnerBirth(pid) {
  try {
    // /proc stat is a kernel-sized record; accept only complete evidence for this exact live PID.
    const text = readFileSync(`/proc/${pid}/stat`, 'utf8')
    const start = text.indexOf('('), end = text.lastIndexOf(')')
    if (text.length > 8192 || !text.endsWith('\n') || start < 1 || end <= start
      || Number(text.slice(0, start).trim()) !== pid) return null
    const fields = text.slice(end + 1).trim().split(/\s+/)
    if (!/^[RSDTtKWPI]$/.test(fields[0] || '') || !/^\d+$/.test(fields[1] || '')
      || !/^\d+$/.test(fields[19] || '')) return null
    const parentPid = Number(fields[1]), startTicks = Number(fields[19])
    if (!Number.isSafeInteger(parentPid) || parentPid > 0x7fffffff || !Number.isSafeInteger(startTicks)) return null
    return { parentPid, startTicks, command: text.slice(start + 1, end) }
  } catch { return null }
}

/** Hermes' shared gateway (`<python> -m hermes_cli.main [--profile <name>] gateway …`), which runs every session's
 * hooks. Copy of cli/src/lib/processTable.ts `hermesGatewayProcess`. */
function hermesGatewayProcess(row) {
  const tokens = argvTokens(row.args || '')
  const entrypoint = processEntrypoint(row.args || '')
  if (entrypoint !== 'hermes_cli.main' && programName(entrypoint) !== 'hermes') return false
  let index = tokens.indexOf(entrypoint) + 1
  if (index <= 0) return false
  if (tokens[index] === '--profile' || tokens[index] === '-p') index += 2
  return tokens[index] === 'gateway'
}

async function callerOwns(identity, current) {
  const rows = await processRows()
  if (!rows) return false
  const byPid = new Map(rows.map((row) => [row.pid, row]))
  let pid = process.ppid
  const visited = new Set()
  while (pid > 0 && !visited.has(pid)) {
    if (pid === identity.pid) return current()
    visited.add(pid)
    const row = byPid.get(pid)
    // A hook from Hermes' gateway sits under whichever pane started it, and belongs to none of them.
    if (row && hermesGatewayProcess(row)) return false
    pid = row?.parentPid || 0
  }
  return false
}

async function fallbackRegister(input, engine, tmuxPane) {
  const p = paths()
  const transcriptPath = typeof input.transcript_path === 'string' ? input.transcript_path : ''
  const rawSessionId = input.session_id || input.conversation_id
  const sessionId = typeof rawSessionId === 'string' && rawSessionId
    ? rawSessionId
    : (transcriptPath ? basename(transcriptPath).replace(/\.jsonl$/, '') : '')
  if (!sessionId) return
  const transcriptOptional = ['cursor', 'opencode', 'kilo', 'pi', 'hermes', 'commandcode', 'devin', 'grok', 'agy', 'copilot', 'openclaw'].includes(engine)
  if (!transcriptOptional && !transcriptPath) return
  if (transcriptPath && !validTranscriptPath(engine, transcriptPath, p)) return
  const observations = []
  const pane = /^%\d+$/.test(tmuxPane || '') ? await paneFacts(tmuxPane, p.dataDir) : undefined
  const taken = pane?.taken ?? 'no'
  if (taken === 'no' || !pane.pid) return
  const tmux = await rootEngineProcess(pane.pid, engine)
  if (tmux.state === 'alive' && tmux.identity && await callerOwns(tmux.identity, tmux.current)) {
    observations.push({ identity: tmux.identity, current: tmux.current, runtime: { backend: 'tmux', paneId: tmuxPane } })
  }
  if (!observations.length) return
  const process = observations[0]
  if (observations.some((observation) => observation.identity.pid !== process.identity.pid
    || observation.identity.startMarker !== process.identity.startMarker
    || observation.identity.startTicks !== process.identity.startTicks)) return
  const observedRuntimes = observations.map((observation) => observation.runtime)
  // The store that turned out to hold it — recorded below, so the daemon's mirror reads this agent's
  // OWN history when it comes back up rather than the default home's.
  let hermesHome = null
  if (engine === 'hermes') {
    const db = await hermesTopLevelSession(p.hermesDb, sessionId)
    if (!db) return
    hermesHome = dirname(db)
  }

  await withRegistryLock(p.registryFile, () => {
    if (remainingBudget(600) < 50 || !process.current()) return
    const loaded = rebootedSinceSnapshot(p.bootFile) ? [] : readRegistryState(p.registryFile)
    // Corrupt/non-array/unknown-schema/unsafe bytes are operator-owned recovery data. Never turn them
    // into an empty registry merely because the daemon is down.
    if (loaded === null) return
    let sessions = loaded
    const routeKeys = new Set(observedRuntimes.map(runtimeRouteKey))
    const onRoute = (s) => !!s && !!(Array.isArray(s.runtimes)
      ? s.runtimes.some((runtime) => routeKeys.has(runtimeRouteKey(runtime)))
      : s.tmuxPane && routeKeys.has(runtimeRouteKey({ backend: 'tmux', paneId: s.tmuxPane })))
    // A session an older build named is the daemon's only while its registry holds an agent there.
    if (taken === 'if-held' && !sessions.some(onRoute)) return
    const now = Date.now()
    const sameRuntime = (s) => s && s.engine === engine
      && s.processIdentity?.pid === process.identity.pid
      && (s.processIdentity?.startTicks !== undefined && process.identity.startTicks !== undefined
        ? s.processIdentity.startTicks === process.identity.startTicks
        : s.processIdentity?.startMarker === process.identity.startMarker)
    let existingIndex = sessions.findIndex(sameRuntime)
    // An engine typed into a terminal is that terminal's agent from then on, as the daemon adopts it
    // (registry.adoptEngine): the same agent, its name and its tile, now this engine's. Taken for a
    // stranger on its pane, the terminal's row was dropped for a new agent, and the tile the person had
    // open was gone when the daemon came back (e2e/hookclient.e2e.ts).
    if (existingIndex < 0) existingIndex = sessions.findIndex((s) => s?.engine === 'terminal' && onRoute(s))
    const existing = existingIndex >= 0 ? sessions[existingIndex] : null
    // A resumed session moves to this process agent; the previous process remains visible but unbound.
    sessions = sessions.map((s) => s && s.sessionId === sessionId && !sameRuntime(s)
      ? { ...s, sessionId: '', boundAt: null, transcriptPath: null, source: null, updatedAt: now }
      : s)
    if (existingIndex < 0) sessions = sessions.filter((s) => !onRoute(s))
    const agentId = typeof existing?.agentId === 'string' && existing.agentId ? existing.agentId : randomUUID()
    const runtimes = mergeRuntimes(existing?.runtimes, observedRuntimes)
    const tmuxProjection = runtimes.find((runtime) => runtime.backend === 'tmux')?.paneId || ''
    // What the daemon chose for this agent at launch and cannot re-derive from the process — the
    // grid launch (credential included), the Codex profile, the bypass flag, the observed grid and
    // gateway — is carried forward, in the shapes `registry.register()` gives them. A hook arriving
    // while the daemon is down must not be the one write that strips the row of them. `launch` is not:
    // like there, a hook means the engine is up, whatever the launch was.
    const carried = {
      gateway: existing?.gateway === 'ori' ? 'ori' : null,
      grid: existing?.grid ?? null,
      ...(existing && Object.hasOwn(existing, 'gridLaunch') ? { gridLaunch: existing.gridLaunch ?? null } : {}),
      codexHome: typeof existing?.codexHome === 'string' && existing.codexHome ? existing.codexHome : null,
      // …and the Hermes home this session's store turned out to be in — see hermesTopLevelSession.
      // Fill-only, exactly as the daemon's own registry treats it.
      hermesHome: hermesHome || (typeof existing?.hermesHome === 'string' && existing.hermesHome ? existing.hermesHome : null),
      ...(existing?.bypassPermission === true ? { bypassPermission: true } : {}),
      // When an app last opened this agent (RegisteredSession.lastOpenedAt): a fact about the person,
      // not the process, and the daemon's own rebuild carries it the same way.
      ...(Number.isSafeInteger(existing?.lastOpenedAt) && existing.lastOpenedAt > 0 ? { lastOpenedAt: existing.lastOpenedAt } : {}),
      // A pane that was a terminal goes back to being one when this engine exits.
      ...(existing?.engine === 'terminal' || existing?.terminalHost === true ? { terminalHost: true } : {}),
    }
    // Everything else the daemon kept on the row goes on as it stands: the agent's name, permission mode,
    // harness (DSH) and its runtime, named agent, subscription model, the web search a grid launch decided,
    // the close planned for after the task (#812), whether it is a terminal, that a stop must be resumed
    // and not started over, and whatever the daemon keeps there next. Named fields alone were the row
    // rebuilt without them, which the daemon then loaded as its own: a hook in the seconds an update or a
    // restart leaves the daemon down relaunched a harness as a plain engine, out of the mode it was made
    // in and under another name, and never closed an agent its person had asked to close (#831;
    // e2e/hookclient.e2e.ts). The launch is over once a hook comes, as `registry.register()` has it:
    // left behind, or `ready` on a row that may only be resumed.
    const { launch: _launch, ...kept } = existing ?? {}
    const entry = {
      ...kept,
      ...(existing?.resumeOnly === true ? { launch: { state: 'ready' } } : {}),
      schemaVersion: 2,
      active: true,
      ...carried,
      agentId,
      sessionId,
      engine,
      boundAt: Date.now(),
      transcriptPath: transcriptPath || existing?.transcriptPath || null,
      projectDir: engine === 'grok'
        ? basename(typeof input.cwd === 'string' ? input.cwd : '') || sessionId
        : transcriptPath
        ? basename(dirname(transcriptPath))
        : basename(typeof input.cwd === 'string' ? input.cwd : '') || sessionId,
      // The row's folder outranks the hook's for the session the row already holds: Claude reports
      // its tracked shell directory, which follows every Bash `cd`, and a resume or restore `cd`s
      // wherever this says. Same rule as `registry.register()`.
      cwd: existing && existing.sessionId === sessionId && typeof existing.cwd === 'string' && existing.cwd
        ? existing.cwd
        : typeof input.cwd === 'string' ? input.cwd : (existing?.cwd ?? null),
      runtimes,
      primaryRuntimeKey: existing?.primaryRuntimeKey && runtimes.some((runtime) => runtimeRouteKey(runtime) === existing.primaryRuntimeKey)
        ? existing.primaryRuntimeKey
        : runtimeRouteKey(observedRuntimes[0]),
      tmuxPane: tmuxProjection,
      source: typeof input.source === 'string' ? input.source : (existing?.source ?? null),
      title: typeof input.session_title === 'string' ? input.session_title : (existing?.title ?? null),
      model: typeof input.model === 'string' ? input.model : (existing?.model ?? null),
      cliVersion: typeof (input.cli_version || input.version) === 'string' ? (input.cli_version || input.version) : (existing?.cliVersion ?? null),
      processIdentity: process.identity,
      registeredAt: typeof existing?.registeredAt === 'number' ? existing.registeredAt : now,
      // A bind is a change to the row, as the daemon stamps one; `updatedAt` is that stamp's name for
      // a daemon from before 2026-09-27.
      updatedAt: now,
      touchedAt: now,
      lastHookAt: now,
      lastTranscriptAt: typeof existing?.lastTranscriptAt === 'number' ? existing.lastTranscriptAt : now,
    }
    if (!tmuxProjection) delete entry.tmuxPane
    if (existingIndex >= 0) sessions[existingIndex] = entry
    else sessions.push(entry)
    if (!process.current()) return
    // Commit rows before advancing their boot authority. If the native fence or durability
    // fails, an old registry must not become current-boot evidence. A failed boot write
    // after this commit leaves the old marker, so recovery cannot accept those rows as current.
    if (writeRegistry(p.registryFile, sessions, process.current)) writeBoot(p.bootFile)
  })
}

async function fallbackSessionEnd(sessionId, reason, engine, tmuxPane) {
  // SessionEnd is not process-lifetime authority. If the daemon is down, its startup scan will reconcile
  // the actual tmux process; deleting the offline record here would hide a still-running CLI.
  void sessionId; void reason; void engine; void tmuxPane
}

async function main() {
  let port = argPort()
  const engine = argEngine()
  const raw = await readStdin()
  let input = {}
  try {
    input = JSON.parse(raw)
  } catch {
    return
  }

  const event = input.hook_event_name || input.hookEventName
  const tmuxPane = process.env.TMUX_PANE
  // A pane: tmux's, or a pty host's (Windows). Routing to another daemon and the offline registry fallback read
  // tmux; from a pty host pane they find nothing and the daemon's own scan reconciles. A session outside a pane, or in
  // a tmux pane the person opened (ownPane), is told only to the devices, below, after the engine guards: it registers
  // nothing.
  const paneless = (!tmuxPane && !PTY_PANE) || await ownPane(tmuxPane)
  // Notification is installed for the session outside a pane, to say it waits for the person. In an agent's pane
  // nothing is told: there PermissionRequest and Elicitation say it, as the dialog opens, where Notification comes only
  // once the person has not typed for 6 s, and never for a dialog answered sooner (facts-claude §1). Whose pane it is is
  // tmux's to say, so even that asks tmux first.
  if (!paneless && event === 'Notification') return
  // Before anything reads the data folder or posts: which daemon this pane is (routeToPaneOwner).
  if (!paneless && await routeToPaneOwner(tmuxPane)) port = argPort()
  if (engine === 'cursor' && input.is_background_agent === true) return
  if (engine === 'codex' && isCodexSubagent(input, paths())) return
  // Devin's documented user-level hook locations include ~/.claude.json and ~/.claude/settings.json, so a
  // Devin session can fire the machine's CLAUDE hook and register itself as claude (wrong engine, and a
  // session id claude's path validation then rejects). Devin has its own hook installed with
  // `--engine devin`; drop the claude-armed duplicate. Cheap and scoped: a real claude session has a UUID
  // session id and no Devin lock file.
  if (engine === 'claude' && isDevinSession(input, paths())) return

  if (paneless) {
    // agy's sub-agents fire hooks of their own; only a top-level conversation is a session (agyIsPaneConversation).
    if (engine === 'agy' && !agyIsPaneConversation(paths(), input.conversationId)) return
    const body = await observedBody(engine, event, input)
    if (body) await postObserved(port, body)
    return
  }

  // After the guards: an event they drop climbs to no caller (hookCaller).
  const mutationFields = { engine, ...await terminalHookFields(tmuxPane) }

  // Grok's hook payload and event records are camelCase, while every Claude-compatible engine above is
  // snake_case. Its Stop hook is deliberately NOT installed: Grok persists that hook_execution before
  // the final assistant chunk, so treating Stop as authoritative would close the turn too early. The
  // transcript's `turn_completed` record closes normal turns; only StopFailure is needed as an error
  // fallback here.
  // Copilot: every event carries `sessionId` and `cwd`, and `agentStop` additionally names the
  // transcript. `sessionStart` fires AFTER the first prompt (measured: userPromptSubmitted at
  // …796411, sessionStart at …798963), so registration is driven by whichever arrives first —
  // both are idempotent.
  if (engine === 'copilot') {
    const copilotEvent = argCopilotEvent()
    if (!copilotEvent) return
    const sessionId = input.sessionId
    const p = paths()
    const transcriptPath = existsPath(input.transcriptPath) ? input.transcriptPath : copilotTranscriptPath(p, sessionId)
    const cwd = input.cwd
    if (copilotEvent === 'sessionEnd') {
      const ok = await post(port, '/api/hook/session-end', { sessionId, reason: input.reason, ...mutationFields })
      if (ok === false) await fallbackSessionEnd(sessionId, input.reason, engine, tmuxPane)
      return
    }
    if (copilotEvent === 'agentStop') {
      await post(port, '/api/hook/turn-stop', {
        sessionId, transcriptPath, status: copilotStopFailed(input) ? 'error' : undefined, ...mutationFields,
      })
      return
    }
    const body = {
      engine,
      hookEvent: 'SessionStart',
      sessionId,
      transcriptPath,
      cwd,
      ...await terminalHookFields(tmuxPane),
    }
    const registered = await post(port, '/api/hook/session-start', body)
    if (registered === false) {
      await fallbackRegister({
        ...input, hook_event_name: 'SessionStart', session_id: sessionId, transcript_path: transcriptPath, cwd,
      }, engine, tmuxPane)
    }
    return
  }

  // agy: the hook is the whole binding. Its `PreInvocation` fires before every model round-trip, so the
  // FIRST one of a turn is the session announce; `Stop` fires exactly once when the execution loop ends
  // and is the authoritative turn boundary (the transcript records no closing marker of its own, and a
  // backgrounded step stays `status: RUNNING` forever because the file is append-only).
  if (engine === 'agy') {
    const agyEvent = argAgyEvent()
    if (!agyEvent) return
    const sessionId = input.conversationId
    const p = paths()
    // A sub-agent's hooks carry the parent's pane; only the pane's own conversation may register.
    if (!agyIsPaneConversation(p, sessionId)) return
    // Trust the payload's path when it resolves; agy's own docs show a workspace-scoped example that
    // does not match what the CLI actually writes, so the derived path is the fallback that does.
    const transcriptPath = existsPath(input.transcriptPath) ? input.transcriptPath : agyTranscriptPath(p, sessionId)
    const cwd = Array.isArray(input.workspacePaths) ? input.workspacePaths[0] : undefined
    if (agyEvent === 'Stop') {
      // agy stops its execution loop as soon as the MODEL has nothing left to say — including the moment
      // it has launched sub-agents and is waiting on them. Measured on a two-sub-agent run: the parent
      // fired Stop twice, first `fullyIdle: false` at the "standing by for their reports" point, then
      // again `fullyIdle: true` when the reports were in. Closing on the first one ended the turn and
      // ran the recap while the work was still going ("chưa done đã recap").
      //
      // So `fullyIdle` is the turn boundary, not Stop itself. A build that omits the field is treated as
      // idle, which is the pre-existing behaviour.
      //
      // A waiting Stop is still REPORTED, as `status: 'waiting'`, rather than swallowed: one measured run
      // finished its sub-agents and never sent another Stop at all, leaving the turn open with nothing
      // coming to close it. The daemon uses this to arm a pane-idle backstop.
      await post(port, '/api/hook/turn-stop', { sessionId, transcriptPath, status: agyStopStatus(input), ...mutationFields })
      return
    }
    const body = {
      engine,
      hookEvent: 'SessionStart',
      sessionId,
      transcriptPath,
      cwd,
      ...await terminalHookFields(tmuxPane),
      model: modelName(input.modelName),
    }
    const registered = await post(port, '/api/hook/session-start', body)
    if (registered === false) {
      await fallbackRegister({
        ...input,
        hook_event_name: 'SessionStart',
        session_id: sessionId,
        transcript_path: transcriptPath,
        cwd,
      }, engine, tmuxPane)
    }
    return
  }

  if (engine === 'grok') {
    const grokEventName = grokHookEvent(event)
    const sessionId = input.sessionId || input.session_id
    const cwd = input.cwd || input.workspaceRoot
    const transcriptPath = grokTranscriptPath(paths(), cwd, sessionId)
    if (grokEventName === 'SessionEnd') {
      const ok = await post(port, '/api/hook/session-end', { sessionId, reason: input.reason, ...mutationFields })
      if (ok === false) await fallbackSessionEnd(sessionId, input.reason, engine, tmuxPane)
      return
    }
    if (grokEventName === 'StopFailure') {
      await post(port, '/api/hook/turn-stop', { sessionId, transcriptPath, status: 'error', ...mutationFields })
      return
    }
    if (grokEventName !== 'SessionStart' && grokEventName !== 'UserPromptSubmit') return
    const body = {
      engine,
      hookEvent: grokEventName,
      sessionId,
      ...(grokEventName === 'UserPromptSubmit' && typeof input.prompt === 'string' ? { prompt: boundedPrompt(input.prompt) } : {}),
      transcriptPath,
      cwd,
      ...await terminalHookFields(tmuxPane),
      model: modelName(input.model),
      cliVersion: input.cliVersion || input.version,
    }
    const registered = await post(port, '/api/hook/session-start', body)
    if (registered === false) {
      await fallbackRegister({
        ...input,
        hook_event_name: grokEventName,
        session_id: sessionId,
        transcript_path: transcriptPath,
        cwd,
        cli_version: input.cliVersion || input.version,
      }, engine, tmuxPane)
    }
    return
  }

  if (((engine === 'claude' || engine === 'devin') && event === 'SessionEnd') || (engine === 'cursor' && event === 'sessionEnd')) {
    const ok = await post(port, '/api/hook/session-end', {
      sessionId: input.session_id || input.conversation_id,
      reason: input.reason,
      ...mutationFields,
    })
    if (ok === false) await fallbackSessionEnd(input.session_id || input.conversation_id, input.reason, engine, tmuxPane)
    // Only once the daemon has taken the end in: a reply that did not come in time ('late') is no answer,
    // and the tasks it would have settled are still the daemon's to settle.
    if (engine === 'cursor' && ok === true) await clearCursorTasks(input.session_id || input.conversation_id)
    return
  }

  // Command Code's only live signal that a turn is running. Fired per tool call, so the adapter side is
  // idempotent (see onTurnStart) — this opens a turn at the FIRST tool of a turn and is a no-op after.
  if (engine === 'commandcode' && (event === 'PreToolUse' || event === 'preToolUse')) {
    await post(port, '/api/hook/turn-start', {
      sessionId: input.session_id || input.conversation_id,
      ...mutationFields,
    })
    return
  }

  if (engine === 'cursor' && event === 'preToolUse') {
    if (input.tool_name === 'Task' && typeof input.tool_use_id === 'string') {
      await persistCursorTask(input)
      await post(port, '/api/hook/tool-start', {
        sessionId: input.session_id || input.conversation_id,
        toolUseId: input.tool_use_id,
        toolName: input.tool_name,
        input: input.tool_input,
        ...mutationFields,
      })
    }
    return
  }

  if (engine === 'cursor' && event === 'stop') {
    const sessionId = input.session_id || input.conversation_id
    const body = {
      engine,
      hookEvent: event,
      sessionId,
      status: input.status,
      transcriptPath: input.transcript_path,
      cwd: Array.isArray(input.workspace_roots) ? input.workspace_roots[0] : input.cwd,
      ...await terminalHookFields(tmuxPane),
      model: modelName(input.model),
      cliVersion: input.cursor_version || input.version,
    }
    const registered = await post(port, '/api/hook/session-start', body)
    if (registered === false) await fallbackRegister(input, engine, tmuxPane)
    const stopped = await post(port, '/api/hook/turn-stop', {
      sessionId,
      status: input.status,
      transcriptPath: input.transcript_path,
      ...mutationFields,
    })
    if (stopped === true) await clearCursorTasks(sessionId)
    return
  }

  // What Claude Code and Codex tell the daemon of a pane's turn beyond its registration: a wait on the person, a
  // subagent of Claude Code's, and Codex's own turn end and interrupt. The event and the tool's name only, never a tool's
  // input or what is asked. Every answer, none included, leaves the hook silent on stdout with exit 0, which both
  // engines read as no decision (main()'s finally).
  if (engine === 'claude' || engine === 'codex') {
    const sessionId = input.session_id
    if (event === 'PreToolUse' || event === 'PermissionRequest' || event === 'Elicitation') {
      if (waitsOnPerson(engine, event, input)) {
        await post(port, '/api/hook/wait', { sessionId, hookEvent: event, toolName: input.tool_name, ...mutationFields })
      }
      return
    }
    // Codex's subagents are not counted: its SubagentStop fires at each child turn's end and never for a failed one
    // (facts-codex §2).
    if (engine === 'claude' && (event === 'SubagentStart' || event === 'SubagentStop')) {
      // A subagent's events carry its lead's session_id (facts-claude §2).
      if (countsSubagent(event, input)) await post(port, '/api/hook/subagent', { sessionId, hookEvent: event, ...mutationFields })
      return
    }
    if (engine === 'codex' && (event === 'Stop' || event === 'Interrupt')) {
      await post(port, '/api/hook/turn-stop', {
        sessionId, hookEvent: event, transcriptPath: input.transcript_path,
        status: event === 'Interrupt' ? 'interrupted' : undefined, ...mutationFields,
      })
      return
    }
  }

  // Stop / StopFailure (claude): the authoritative turn-close signal, independent of JSONL parsing.
  // Stop fires when Claude finishes responding (incl. max_tokens / refusal); StopFailure fires when the
  // turn ends on an API error (Stop does NOT fire then). Both → tell the adapter to close the turn. We
  // write nothing to stdout so Claude stops normally (only exit 2 / decision:block would continue it).
  // Command Code exposes no UserPromptSubmit, so Stop is its only turn-close signal (same shape as claude's).
  if ((engine === 'claude' || engine === 'commandcode' || engine === 'devin') && (event === 'Stop' || event === 'StopFailure')) {
    // Command Code's whole hook set is PreToolUse/PostToolUse/Stop/SessionStart — no UserPromptSubmit, so
    // Stop is also its ONLY catch hook. Without re-registering here, a session that left the registry for
    // any reason (a reaper miss, a daemon restart, a fresh data dir) can never come back while the CLI
    // keeps running: the web/device just show nothing until the user quits and relaunches commandcode.
    // Registration is idempotent, and this is also where a session first announced without a transcript
    // (Command Code fires SessionStart before creating the file) finally gets its real path.
    if (engine === 'commandcode') {
      const registered = await post(port, '/api/hook/session-start', {
        engine,
        hookEvent: event,
        sessionId: input.session_id,
        status: event === 'StopFailure' ? 'error' : undefined,
        transcriptPath: existsPath(input.transcript_path) ? input.transcript_path : undefined,
        cwd: input.cwd,
        ...await terminalHookFields(tmuxPane),
        title: input.session_title,
        model: modelName(input.model),
        cliVersion: input.cli_version || input.version,
      })
      if (registered === false) await fallbackRegister(input, engine, tmuxPane)
    }
    await post(port, '/api/hook/turn-stop', {
      sessionId: input.session_id,
      transcriptPath: input.transcript_path,
      status: event === 'StopFailure' ? 'error' : undefined,
      ...mutationFields,
    })
    return
  }

  // SessionStart or UserPromptSubmit (the catch hook) → register the session. Registration is
  // idempotent, so re-registering on every prompt is cheap. The adapter verifies the process.
  // Command Code fires SessionStart BEFORE it writes the transcript, and the daemon validates the path
  // (realpath) — sending one that isn't on disk yet gets the whole registration rejected. Announce
  // without it; the session is registered again with the real path on the first Stop. Scoped to
  // commandcode: every other engine REQUIRES a transcriptPath, so dropping it would break them.
  // Devin keeps history in sessions.db and writes no transcript file (unless the user passes --export),
  // so it registers with none — like opencode/pi/hermes.
  const transcriptPath = engine === 'devin'
    ? undefined
    : engine === 'commandcode' && !existsPath(input.transcript_path)
      ? undefined
      : input.transcript_path
  const body = {
    engine,
    hookEvent: event,
    sessionId: input.session_id || input.conversation_id,
    ...(event === 'UserPromptSubmit' && (engine === 'claude' || engine === 'codex') && typeof input.prompt === 'string'
      ? { prompt: boundedPrompt(input.prompt) } : {}),
    transcriptPath,
    // Devin's payload carries no cwd; the hook process inherits the session's working directory.
    cwd: Array.isArray(input.workspace_roots) ? input.workspace_roots[0] : (input.cwd || (engine === 'devin' ? process.cwd() : undefined)),
    source: input.source,
    ...await terminalHookFields(tmuxPane),
    title: input.session_title,
    model: modelName(input.model),
    cliVersion: input.cli_version || input.cursor_version || input.version,
  }
  // The daemon reads them on this registration alone (src/hookServer.ts hookFacts).
  const facts = ownFacts(engine)
  let ok = await post(port, '/api/hook/session-start', body, undefined, facts)
  let held = ok === 'held'
  // A live core's bounded admission queue owns the existing candidates. Retry this
  // delivery within the hook budget, never reconstruct registry state behind it.
  for (let attempt = 0; engine === 'hermes' && ok === 'held' && attempt < 3 && remainingBudget() > 750; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 250))
    ok = await post(port, '/api/hook/session-start', body, undefined, facts)
    held ||= ok === 'held'
  }
  if (held && ok !== true) process.stderr.write('[harness] Hermes admission is held; this delivery could not be confirmed. The current conversation is unchanged.\n')
  if (ok === false && !held) await fallbackRegister(input, engine, tmuxPane)
}

main()
  .catch(() => {})
  .finally(() => {
    // Cursor and Hermes parse the hook's stdout as JSON; `{}` is the explicit no-op (for Hermes it also
    // guarantees a pre_llm_call hook never injects context). Claude/Codex want no stdout at all.
    const e = argEngine()
    // agy REQUIRES a JSON object on stdout. `{}` is the safe no-op for both events it fires: on Stop,
    // only `{"decision":"continue"}` would block the stop. It is also why PreToolUse is never installed
    // — there `decision` is required, and `{}` reads as a denial (measured: every tool call of the turn
    // came back "Tool call denied by pre-tool hook").
    // Copilot parses stdout as JSON too; `{}` is the documented no-op for every event installed here.
    if (e === 'cursor' || e === 'hermes' || e === 'agy' || e === 'copilot') process.stdout.write('{}\n', () => process.exit(0))
    else process.exit(0)
  })
