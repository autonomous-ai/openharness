/**
 * Find the session a live discovered engine process is running, when no hook has bound one yet.
 *
 * Process discovery can see an engine immediately, including after a daemon restart, but a session id is
 * owned by the engine and may not be present in argv. Prefer the engine's process evidence; when no
 * exact process lookup applies, narrow the engine's store by directory and process start time.
 *
 * Two rules keep it honest:
 *   - **Started after the engine process did.** A session older than the process cannot be the one it is
 *     running now. (Resumed agents name their id on the command line and are adopted from argv instead —
 *     see tmuxAgentDiscovery.)
 *   - **Unique or nothing.** Two candidate sessions in one directory means two agents there, and guessing
 *     would hand one agent's transcript to the other's tile. Ambiguity returns null; the agent stays
 *     unbound until its next turn, which is recoverable — mis-binding is not.
 */

import { execFile } from 'child_process'
import { open, readdir, readFile, readlink, realpath, stat } from 'fs/promises'
import { basename, dirname, join, relative, sep } from 'path'
import { env } from '../config/env.js'
import { museEvent, museWorkspaceRoot } from '../engines/muse/normalizer.js'
import type { AgentEngine } from '../engines/types.js'
import { readCodexRolloutMeta, resolveCodexRollout } from '../engines/codex/rollout.js'
import { agyConversationForPid, findAgyTranscript } from '../engines/agy/session.js'
import { copilotSessionCwd, copilotSessionForPid, findCopilotTranscript } from '../engines/copilot/session.js'
import { hermesDbPath, listHermesHomes } from '../engines/hermes/home.js'
import { sqliteReadAll, type SqliteParam } from './sqliteRead.js'
import { piSessionFolder, readPiHead } from './sessionSearch/externals/pi.js'
import { claudeProjectsRoots, codexHomeRoots } from './engineHomes.js'
import { argvTokens, engineProcessMatchScore, processRows, type ProcessRow } from './tmux.js'

/**
 * Clock granularity only. `ps` reports start time to the second, so a file created in the same second
 * must still count as "after".
 *
 * Deliberately small. It was 60s, and that let a session the user had JUST exited be handed to the engine
 * they started seconds later in the same pane: the old transcript's last write fell inside the window, so
 * the new agent came up wearing the dead session's id (measured — `/exit`, relaunch, and repair re-bound
 * `6899ff76`). Whatever is picked here must belong to the process running NOW.
 */
const START_SLACK_MS = 5_000
/** Directories to walk per engine root. Deep enough for codex's <year>/<month>/<day> layout. */
const MAX_DEPTH = 4
const MAX_FILES = 400

export interface RepairedSession {
  sessionId: string
  /** File-backed engines only; the DB-backed ones are read by session id. */
  transcriptPath?: string
  /** Hermes only: which home's store the session was found in, when it was not the default one. */
  hermesHome?: string
}

interface TranscriptFile { path: string; mtimeMs: number; birthMs: number }

/** Every `.jsonl` under `root`, newest first, capped. Checkpoint/sidecar files are not transcripts. */
async function transcripts(root: string, depth = 0): Promise<TranscriptFile[]> {
  if (depth > MAX_DEPTH) return []
  let entries
  try { entries = await readdir(root, { withFileTypes: true }) } catch { return [] }
  const out: TranscriptFile[] = []
  for (const entry of entries) {
    const full = join(root, entry.name)
    if (entry.isDirectory()) { out.push(...await transcripts(full, depth + 1)); continue }
    if (!entry.name.endsWith('.jsonl') || entry.name.includes('.checkpoints.')) continue
    try {
      const info = await stat(full)
      out.push({ path: full, mtimeMs: info.mtimeMs, birthMs: info.birthtimeMs || info.mtimeMs })
    } catch { /* vanished mid-scan */ }
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, MAX_FILES)
}

/**
 * The `cwd` a transcript declares, from its opening lines.
 *
 * Not just line one: claude opens with bookkeeping records (`leafUuid`, `mode`) that carry no cwd, so a
 * first-line-only read found nothing for every claude session on the computer — caught when a live repair
 * returned null for a pane whose transcript was sitting right there. pi and Command Code do put it on
 * line one; scanning a few lines covers all three without knowing which is which.
 */
const CWD_SCAN_LINES = 20
const CWD_SCAN_CHARS = 256 * 1024

/**
 * The first `cwd` in a transcript's head and, when asked, its opening `isSidechain` flag. One bounded read
 * (256 KB — transcripts run to hundreds of MB) shared by every file engine that declares its cwd in-file.
 * Without `wantSide` it stops at the first cwd, exactly as it always did.
 */
async function readTranscriptHead(path: string, wantSide: boolean): Promise<{ cwd: string; side: boolean | undefined } | null> {
  try {
    // Preserve the existing UTF-16 character budget, including non-ASCII paths. Four
    // UTF-8 bytes per code unit is sufficient even when the cutoff splits a surrogate
    // pair; a byte budget equal to the character budget would silently shrink the scan.
    const head = (await headBytes(path, CWD_SCAN_CHARS * 4)).toString('utf-8').slice(0, CWD_SCAN_CHARS)
    let cwd = ''
    let side: boolean | undefined
    for (const line of head.split('\n', CWD_SCAN_LINES)) {
      if (!line.trim()) continue
      let obj: Record<string, unknown>
      try { obj = JSON.parse(line) as Record<string, unknown> } catch { continue }
      if (!cwd && typeof obj.cwd === 'string' && obj.cwd) cwd = obj.cwd
      if (wantSide && side === undefined && typeof obj.isSidechain === 'boolean') side = obj.isSidechain
      if (cwd && (!wantSide || side !== undefined)) break
    }
    return { cwd, side }
  } catch { return null }
}

async function readTranscriptMeta(path: string): Promise<TranscriptMeta | null> {
  const head = await readTranscriptHead(path, false)
  return head?.cwd ? { cwd: head.cwd } : null
}

/**
 * `readTranscriptMeta` for Claude, which also refuses a SUBAGENT transcript.
 *
 * Claude's subagents (the Task tool, background agents) write transcripts of their own in the same project
 * directory tree, and a scan by directory cannot tell them from a conversation. Two layouts exist:
 *
 *   <projects>/<proj>/<parentSession>/subagents/agent-<id>.jsonl   (current)
 *   <projects>/<proj>/agent-<id>.jsonl                             (older builds)
 *
 * Both open with `{type:'user', isSidechain:true, cwd, sessionId:<parent>}` — the cwd and the PARENT's
 * session id — whereas a main transcript carries `isSidechain:false`. Left in the scan, the youngest
 * subagent file of a parent that is still running was picked as the session of the agent born next to it
 * (a fork): the sweep bound the fork to its parent's subagent, and Stop capture then recorded that id.
 * So: a path with a `subagents` segment below the projects root is out before it is read, and so is a
 * file whose FIRST record carrying a boolean `isSidechain` says true. Later records are not consulted for
 * the flag — a main transcript can hold sidechain records, and only its opening says what the file is.
 */
async function readClaudeTranscriptMeta(path: string): Promise<TranscriptMeta | null> {
  // Relative to the projects root it is under (the daemon's own, or a moved home's): the root itself may
  // legitimately sit under a folder of that name.
  const root = claudeProjectsRoots(env.CLAUDE_PROJECTS_DIR).find((one) => !relative(one, path).startsWith('..'))
  if (root !== undefined && relative(root, path).split(sep).includes('subagents')) return null
  const head = await readTranscriptHead(path, true)
  return head && head.side !== true && head.cwd ? { cwd: head.cwd } : null
}

/** Session id from `<id>.jsonl`, or from pi's `<timestamp>_<id>.jsonl`. */
function idFromFile(path: string): string {
  const base = path.split('/').pop()?.replace(/\.jsonl$/, '') ?? ''
  const underscore = base.lastIndexOf('_')
  return underscore === -1 ? base : base.slice(underscore + 1)
}

/**
 * Compare two directories as the filesystem sees them, not as strings.
 *
 * On macOS `/tmp` is a symlink to `/private/tmp`, so discovery reporting one and an engine recording the
 * other describe the SAME directory and would never match textually — measured: a repair that resolved
 * correctly for `/private/tmp/synctest` returned null for `/tmp/synctest`.
 */
export async function sameDir(a: string, b: string): Promise<boolean> {
  if (a === b) return true
  const [ra, rb] = await Promise.all([
    realpath(a).catch(() => a),
    realpath(b).catch(() => b),
  ])
  return ra === rb
}

/**
 * Two tiers, because two different things look alike from here.
 *
 *   born  — the transcript was CREATED after the process started: a session this engine opened itself.
 *   wrote — created earlier but written to after the process started: a session it RESUMED.
 *
 * Preferring `born` is what stops a just-exited session from being handed to its replacement: the dead
 * transcript was created before the new process, and its final write lands before the new process starts,
 * so it qualifies for neither tier and the pane stays unbound until the real session appears.
 */
interface TranscriptMeta { cwd: string | null; sessionId?: string }

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

/**
 * True once a muse session has opened a RUN — the lifecycle a conversation is made of.
 *
 * Not "has a prompt": a scheduled run is a real turn whose prompt is empty, because the scheduler
 * triggered it rather than a person. `payload.kind` is what separates the two lifecycles that share the
 * name `started`; a `task` one is scheduler bookkeeping and several fire inside a single run.
 */
function hasRun(lines: string[]): boolean {
  for (const line of lines) {
    const record = museEvent(line)
    if (record?.scope === 'run' && str(record.event.kind) === 'started') return true
  }
  return false
}

async function fileEngineSession(
  root: string | string[],
  cwd: string,
  startedAtMs: number,
  readMeta: (path: string) => Promise<TranscriptMeta | null>,
  opts?: { bornOnly?: boolean },
): Promise<RepairedSession | null> {
  const since = startedAtMs - START_SLACK_MS
  const born: RepairedSession[] = []
  const wrote: RepairedSession[] = []
  // Several roots are one pool, newest first: one conversation in each of two homes is two agents, as in one.
  const files = typeof root === 'string' ? await transcripts(root)
    : (await Promise.all(root.map((one) => transcripts(one)))).flat().sort((a, b) => b.mtimeMs - a.mtimeMs)
  for (const file of files) {
    if (file.mtimeMs < since) break // sorted newest-first: everything after is older still
    const meta = await readMeta(file.path)
    if (!meta?.cwd || !await sameDir(meta.cwd, cwd)) continue
    const found = { sessionId: meta.sessionId || idFromFile(file.path), transcriptPath: file.path }
    ;(file.birthMs >= since ? born : wrote).push(found)
  }
  // "Unique or nothing" at each tier: two candidates means two agents in one directory, and a wrong guess
  // wires one agent's tile to the other's transcript.
  if (born.length === 1) return born[0]
  if (born.length > 1) return null
  // `bornOnly`: the caller is binding an agent that has NEVER had a session. Accepting the `wrote` tier
  // there hands it whatever session was last touched in this directory — measured: exit the engine,
  // run `claude` again in the same pane, and the new agent adopted the PREVIOUS conversation,
  // so the web opened a fresh tab already full of old messages. A resume the user asked for by name is
  // matched from argv by the discovery path instead, which needs no guessing.
  if (opts?.bornOnly) return null
  return wrote.length === 1 ? wrote[0] : null
}

let missingSqliteReported = false

/** The store-backed repair branch cannot work without a SQLite reader; warn on the first miss only. */
async function reportMissingSqliteOnce(): Promise<void> {
  if (missingSqliteReported) return
  missingSqliteReported = true
  const { sqlitePreflightMessage } = await import('./sqliteAvailability.js')
  console.warn(sqlitePreflightMessage() ?? '[preflight] no SQLite reader available')
}

/** Read-only, through the same helper the readers use, so a repair can never write to the user's store. */
async function dbEngineSession(dbPath: string, sql: string, params: SqliteParam[]): Promise<RepairedSession | null> {
  const result = await sqliteReadAll(dbPath, sql, params, { maxBuffer: 1024 * 1024 })
  if (!result.ok) {
    // No reader at all is not a transient DB lock, and repair returning null forever with no signal is
    // how "my opencode agents never appear on Ubuntu" looks from the outside. Say it once.
    if (result.reason === 'missing') await reportMissingSqliteOnce()
    return null
  }
  const rows = result.rows
  if (rows.length !== 1) return null // 0 = nothing to adopt, >1 = ambiguous
  const id = rows[0].id
  return typeof id === 'string' && id ? { sessionId: id } : null
}

/** One `?` per directory, for an `IN (…)` over both spellings of the cwd. */
function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ')
}

/**
 * The session a discovered engine process is running in `cwd`, or null when it cannot be said for certain.
 *
 * `startedAtMs` is when the engine process started (`ps` lstart). Cursor is absent on purpose: its
 * transcripts are located by id rather than listed by directory, and its resumes already have a
 * dedicated discovery path.
 */

/**
 * Copilot names its session directory by uuid, so the cwd lives inside the file — on the first record,
 * `session.start.data.context.cwd`. `readTranscriptMeta` scans the first lines for a bare `cwd`, but
 * Copilot nests it, so this reads it out itself.
 */
async function copilotDirectoryScan(
  cwd: string,
  startedAtMs: number,
  opts?: { bornOnly?: boolean },
): Promise<RepairedSession | null> {
  return fileEngineSession(join(env.COPILOT_HOME, 'session-state'), cwd, startedAtMs, async (path) => {
    if (basename(path) !== 'events.jsonl') return null
    const head = (await readFile(path, 'utf8').catch(() => '')).split('\n', 5)
    const root = copilotSessionCwd(head)
    return root ? { cwd: root, sessionId: basename(dirname(path)) } : null
  }, opts)
}

export async function findLiveSession(
  engine: AgentEngine,
  cwd: string,
  startedAtMs: number,
  // codexHome: the specific agent's own CODEX_HOME profile, when it isn't this machine's default —
  // see RegisteredSession.codexHome. Only the 'codex' case below reads it.
  opts?: { bornOnly?: boolean; pid?: number; codexHome?: string },
): Promise<RepairedSession | null> {
  const sinceMs = startedAtMs - START_SLACK_MS
  // The DB engines match on a directory STRING, so ask for both spellings of it (see sameDir).
  const real = await realpath(cwd).catch(() => cwd)
  const dirs = real === cwd ? [cwd] : [cwd, real]
  const dirList = placeholders(dirs.length)
  switch (engine) {
    case 'claude': {
      // Native Claude publishes a PID-to-conversation record even before a hook binds it.
      // Unlike a directory scan this also identifies an old process in a busy project.
      // Every home, the moved ones too (lib/engineHomes.ts): the default alone left an agent in a moved
      // CLAUDE_CONFIG_DIR whose start-up hook did not bind it without a conversation.
      const exact = opts?.pid ? await claudeProcessSession(opts.pid, cwd, startedAtMs) : null
      return exact ?? fileEngineSession(claudeProjectsRoots(env.CLAUDE_PROJECTS_DIR), cwd, startedAtMs, readClaudeTranscriptMeta, opts)
    }
    case 'codex': {
      // The agent's own profile alone, else the daemon's home and every one the person moved, as
      // findResumedTranscript looks: the default alone missed a rollout in a moved CODEX_HOME.
      const sessions = (opts?.codexHome ? [opts.codexHome] : codexHomeRoots(env.CODEX_HOME)).map((home) => join(home, 'sessions'))
      // October 6 parallel-create incident: the only rollout in a folder can belong to a sibling
      // whose file opened first. A known Codex process must name its own open rollout; until then,
      // leave it unbound for its next discovery pass or startup hook, never guess from the folder.
      if (opts?.pid) return codexProcessSession(opts.pid, sessions, cwd)
      // Codex writes no `cwd` on line one; its rollout meta carries it — and says whether the rollout
      // belongs to a subagent, which must never become an agent of its own.
      // Its session id lives INSIDE the file: the name is `rollout-<timestamp>-<id>.jsonl`, so deriving
      // the id from the filename produced the literal string "rollout-…" (seen on a live pane).
      return fileEngineSession(sessions, cwd, startedAtMs, async (path) => {
        const meta = readCodexRolloutMeta(path)
        return meta && !meta.isSubagent ? { cwd: meta.cwd, sessionId: meta.id || undefined } : null
      }, opts)
    }
    case 'pi':
      return fileEngineSession(join(env.PI_HOME, 'agent', 'sessions'), cwd, startedAtMs, readTranscriptMeta, opts)
    case 'commandcode':
      return fileEngineSession(join(env.COMMANDCODE_HOME, 'projects'), cwd, startedAtMs, readTranscriptMeta, opts)
    case 'muse':
      // Muse's hooks never fire, so this scan is the ONLY way a muse pane is ever bound. The tree is
      // `sessions/YYYY/MM/DD/<session-uuid>/session.jsonl` (4 levels — exactly MAX_DEPTH) and nothing in
      // the path names the project: `workspace_root` in the first record is the only link. Sub-agent
      // files live one level deeper under `subagent/`, and must never be adopted as agents of their own.
      return fileEngineSession(join(env.MUSE_HOME, 'sessions'), cwd, startedAtMs, async (path) => {
        if (path.includes(`${sep}subagent${sep}`)) return null
        const lines = (await readFile(path, 'utf-8').catch(() => '')).split('\n')
        const root = museWorkspaceRoot(lines[0] ?? '')
        if (!root) return null
        // Muse opens sessions of its OWN under the same workspace_root — memory reminders
        // (`memory_reminder_child_session_linked`) are the ones seen live. They are indistinguishable from
        // the user's session by path, workspace or birth time, and being younger they WIN the `born` tier:
        // measured, the daemon tailed an 11-line reminder session while the real conversation ran on in
        // another file, so web and device received nothing at all. What separates them is that a session
        // being conversed in has opened a RUN.
        if (!hasRun(lines)) return null
        return { cwd: root, sessionId: basename(dirname(path)) }
      }, opts)
    case 'amp':
      // The transcripts scanned here are the adapter's own — Amp keeps no conversation on disk, so its
      // plugin writes one per thread as `<AMP_SESSIONS_DIR>/<threadId>.jsonl` with `cwd` on the first
      // line. That makes the ordinary file scan work unchanged, and the file name IS the session id.
      //
      // Amp also offers a second, exact answer that this deliberately does not use: `session.json` maps
      // `tmux:<pane>@<server-pid>,<session>` to the thread started in that pane. It is a better key than a
      // directory — but `findLiveSession` is asked about a cwd, not a pane, and a repair that silently
      // needed a different question would be the kind of split path this file exists to avoid.
      return fileEngineSession(env.AMP_SESSIONS_DIR, cwd, startedAtMs, readTranscriptMeta, opts)
    case 'grok':
      // `updates.jsonl` lives under `<encoded-cwd>/<uuid>/`; long cwd values use a hashed group with a
      // `.cwd` sidecar. The file itself is ACP updates and carries no cwd, so derive it from that group.
      return fileEngineSession(join(env.GROK_HOME, 'sessions'), cwd, startedAtMs, async (path) => {
        if (basename(path) !== 'updates.jsonl') return null
        const sessionDir = dirname(path)
        const group = dirname(sessionDir)
        let root = ''
        try { root = decodeURIComponent(basename(group)) } catch { /* hashed layout below */ }
        if (!root.startsWith('/')) root = (await readFile(join(group, '.cwd'), 'utf8').catch(() => '')).trim()
        return root ? { cwd: root, sessionId: basename(sessionDir) } : null
      }, opts)
    case 'opencode':
      // time_created is epoch MILLISECONDS here.
      return dbEngineSession(
        join(env.OPENCODE_DATA_DIR, 'opencode.db'),
        `SELECT id FROM session WHERE directory IN (${dirList}) AND parent_id IS NULL`
          + ' AND (time_created >= ? OR time_updated >= ?)'
          + ' ORDER BY time_updated DESC LIMIT 2;',
        [...dirs, Math.trunc(sinceMs), Math.trunc(sinceMs)],
      )
    case 'kilo':
      // Same store shape as opencode (measured: `session` is byte-identical between the two DBs), and
      // time_created is epoch MILLISECONDS here too — the real row on this machine reads 1786091927554.
      return dbEngineSession(
        join(env.KILO_DATA_DIR, 'kilo.db'),
        `SELECT id FROM session WHERE directory IN (${dirList}) AND parent_id IS NULL`
          + ' AND (time_created >= ? OR time_updated >= ?)'
          + ' ORDER BY time_updated DESC LIMIT 2;',
        [...dirs, Math.trunc(sinceMs), Math.trunc(sinceMs)],
      )
    case 'hermes': {
      // started_at is epoch SECONDS (fractional).
      //
      // EVERY home, not just the default: `hermes -p <name>` keeps its sessions in
      // `~/.hermes/profiles/<name>/state.db`, and a repair that only asked the default store could
      // never rebind a profile agent after a restart (openharness#191). Each store is asked on its
      // own and the answers are pooled, so two homes claiming the same cwd is ambiguous — exactly as
      // two rows in one store already are — rather than "whichever home was listed first".
      const homes = await listHermesHomes()
      const found: RepairedSession[] = []
      for (const home of homes) {
        const one = await dbEngineSession(
          hermesDbPath(home),
          `SELECT id FROM sessions WHERE cwd IN (${dirList}) AND started_at >= ?`
            + ' ORDER BY started_at DESC LIMIT 2;',
          [...dirs, Math.trunc(sinceMs / 1000)],
        )
        if (one) found.push({ ...one, hermesHome: home })
        if (found.length > 1) return null
      }
      return found[0] ?? null
    }
    case 'devin':
      // created_at is epoch SECONDS (integer).
      return dbEngineSession(
        join(env.DEVIN_HOME, 'sessions.db'),
        // created_at is when the session began; last_activity_at moves when devin resumes into it, which
        // is the only marker a continued session leaves behind.
        `SELECT id FROM sessions WHERE working_directory IN (${dirList})`
          + ' AND (created_at >= ? OR last_activity_at >= ?)'
          + ' ORDER BY last_activity_at DESC LIMIT 2;',
        [...dirs, Math.trunc(sinceMs / 1000), Math.trunc(sinceMs / 1000)],
      )
    case 'copilot': {
      // The lock the process holds is the only thing a `/resume` leaves behind, and it is exact.
      // Fall through to the directory scan when there is no pid or no lock yet (a brand-new session
      // takes its lock only once Copilot creates it).
      const locked = opts?.pid ? await copilotSessionForPid(env.COPILOT_HOME, opts.pid) : null
      if (locked) {
        const transcriptPath = await findCopilotTranscript(env.COPILOT_HOME, locked)
        return { sessionId: locked, transcriptPath: transcriptPath ?? undefined }
      }
      return copilotDirectoryScan(cwd, startedAtMs, opts)
    }

    case 'agy':
      // The one engine here that cannot be found by directory. agy's transcript records no cwd, its
      // brain directory is named by the conversation id, and `conversation_summaries.db` — which looks
      // like the index for exactly this — holds only IDE rows, never CLI ones (measured on 1.1.14).
      //
      // What it does leave is `presence/<conversationId>.lock`, held open by the live process for the
      // life of the conversation. That is a pid→conversation map and a liveness test in one, so repair
      // asks the process rather than the directory. Without a pid there is nothing to ask.
      return opts?.pid ? agySession(opts.pid) : null
    default:
      return null
  }
}

/** The conversation the given `agy` pid is holding, if its transcript exists yet. */
async function agySession(pid: number): Promise<RepairedSession | null> {
  const conversationId = await agyConversationForPid(env.AGY_HOME, pid)
  if (!conversationId) return null
  const transcriptPath = await findAgyTranscript(env.AGY_HOME, conversationId)
  // A conversation with no transcript is one agy has opened but not written to; registry derives the
  // path anyway, so bind it and let the watcher pick the file up when it appears.
  return { sessionId: conversationId, transcriptPath: transcriptPath ?? undefined }
}

/** The last `maxBytes` of a file, as text. Bounded so a multi-MB transcript costs nothing to check. */
async function tailBytes(path: string, maxBytes: number): Promise<string> {
  const handle = await open(path, 'r')
  try {
    const info = await handle.stat()
    const start = Math.max(0, info.size - maxBytes)
    const length = info.size - start
    if (length <= 0) return ''
    const buffer = Buffer.alloc(length)
    await handle.read(buffer, 0, length, start)
    return buffer.toString('utf-8')
  } finally {
    await handle.close()
  }
}

const CLAUDE_CONTINUATION_TAIL_BYTES = 4 * 1024
/** Enough of a continuation to see whether anybody ever spoke in it. Its first turn is within a few
 *  lines of the top — the records before it are bookkeeping (mode, file history, title, agent name). */
const CLAUDE_CONTINUATION_HEAD_BYTES = 256 * 1024

async function headBytes(path: string, maxBytes: number): Promise<Buffer> {
  const handle = await open(path, 'r')
  try {
    const length = Math.min((await handle.stat()).size, maxBytes)
    if (length <= 0) return Buffer.alloc(0)
    const buffer = Buffer.alloc(length)
    let read = 0
    while (read < length) {
      const { bytesRead } = await handle.read(buffer, read, length - read, read)
      if (!bytesRead) break
      read += bytesRead
    }
    return buffer.subarray(0, read)
  } finally {
    await handle.close()
  }
}

/**
 * Whether a transcript holds a CONVERSATION, rather than being the file Claude opens for a session
 * nobody has spoken in yet.
 *
 * `claude` writes the same `continued-in` marker for a BACKGROUND session as for a rollover, and the
 * file it points at then holds two bookkeeping lines (`ai-title`, `agent-name`) and never grows,
 * while the real conversation goes on in the original file. Following that marker moved an agent onto
 * an empty session: its tile went quiet, and the conversation archived when the engine exited was the
 * empty one — Open then asked `claude --resume <background id>`, which the CLI refuses outright
 * ("is running as a background session … run `claude attach`"). Measured on one machine: of nine
 * `continued-in` markers, three named a background session and every one of those files had exactly
 * these two lines and no turn.
 */
async function hasConversationTurn(path: string): Promise<boolean> {
  let head: Buffer
  try {
    head = await headBytes(path, CLAUDE_CONTINUATION_HEAD_BYTES)
  } catch {
    return false
  }
  for (const line of head.toString('utf-8').split('\n')) {
    if (!line.trim() || (!line.includes('"user"') && !line.includes('"assistant"'))) continue
    try {
      const record = JSON.parse(line) as { type?: unknown }
      if (record.type === 'user' || record.type === 'assistant') return true
    } catch { /* a line cut by the read bound, or one this version does not know */ }
  }
  // Nothing in the head, but more file than we read: a continuation can open on a `file-history-snapshot`
  // large enough to push the first turn past the bound, and the thing being ruled out is two short
  // lines. Anything this size is a conversation, so the bound must never be what refuses one.
  // Count the bytes read, not decoded UTF-16 characters: Unicode bookkeeping must not make
  // a read that hit the byte cap look smaller and strand the real turn beyond it.
  return head.length >= CLAUDE_CONTINUATION_HEAD_BYTES
}

/**
 * Claude rolls a long conversation's transcript over to a NEW file on its own (compaction, a resume
 * chain) — the old file's last line names the new session and Claude simply starts writing there. No
 * fresh SessionStart/UserPromptSubmit fires for it on its own if the actual turn that follows is
 * served by a pooled/"spare" worker process rather than one spawned directly in the pane — so a
 * hook-only bind can be left pointed at a transcript that has gone permanently quiet while the real
 * conversation continues one file over. This is a cheap, bounded check for exactly that marker, read
 * from the tail since it is always the very last line and tiny.
 */
export async function claudeContinuation(transcriptPath: string): Promise<RepairedSession | null> {
  let tail: string
  try {
    tail = await tailBytes(transcriptPath, CLAUDE_CONTINUATION_TAIL_BYTES)
  } catch {
    return null
  }
  const lines = tail.split('\n').map((line) => line.trim()).filter(Boolean)
  const lastLine = lines[lines.length - 1]
  if (!lastLine) return null
  let record: Record<string, unknown>
  try {
    record = JSON.parse(lastLine) as Record<string, unknown>
  } catch {
    return null
  }
  const nextId = record.type === 'continued-in' && typeof record.continuedInSessionId === 'string'
    ? record.continuedInSessionId
    : ''
  if (!nextId) return null
  const nextPath = join(dirname(transcriptPath), `${nextId}.jsonl`)
  try {
    if (!(await stat(nextPath)).isFile()) return null
  } catch {
    return null
  }
  // A marker alone does not prove the conversation moved: the same one is written for a background
  // session, whose file never holds a turn. Waiting for one costs nothing — this runs on every
  // reconciler pass, so a continuation that is real binds on the pass after its first turn lands.
  if (!await hasConversationTurn(nextPath)) return null
  return { sessionId: nextId, transcriptPath: nextPath }
}

/**
 * The transcript behind a session id a claude/codex process names on its own command line
 * (`claude --resume <id>`, `codex resume <id>`) — the file `registry.register` insists on for those
 * two engines, which argv does not carry. Claude keeps one file per session under
 * `<projects>/<encoded cwd>/<id>.jsonl`; the cwd encoding is Claude's to define, so the project
 * folders are listed rather than the name derived. Codex names its rollout after the thread id, and
 * the rollout walker already knows that layout. Only a file that exists is returned: a resume of a
 * session this machine never wrote (or one that was deleted) binds nothing.
 */
export async function findResumedTranscript(
  engine: AgentEngine,
  sessionId: string,
  opts?: { codexHome?: string; cwd?: string },
): Promise<string | null> {
  if (engine === 'pi') {
    // Pi allocates an ID before its first reply creates the file. Look up that
    // exact ID again at Close, including after exit, without guessing by mtime.
    if (!opts?.cwd || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,126}[A-Za-z0-9]$/.test(sessionId)
      || sessionId.endsWith('.jsonl')) throw new Error('The Pi conversation location is unavailable.')
    const directory = join(env.PI_HOME, 'agent', 'sessions', piSessionFolder(opts.cwd))
    let files: string[]
    try { files = await readdir(directory) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error // An unreadable store is not an unwritten conversation.
    }
    const matches: string[] = []
    for (const file of files.filter(file => file.endsWith(`_${sessionId}.jsonl`))) {
      const head = await readPiHead(join(directory, file))
      if (!head || typeof head === 'symbol') throw new Error('The Pi conversation file could not be read.')
      if (head.sessionId === sessionId && await sameDir(head.cwd, opts.cwd)) matches.push(file)
    }
    if (matches.length > 1) throw new Error('More than one file matches this Pi conversation.')
    return matches.length ? join(directory, matches[0]) : null
  }
  if (!/^[0-9a-f-]{16,}$/i.test(sessionId)) return null
  // In every home the registry takes a transcript from (registry.validTranscriptPath): the daemon's own and
  // each one the person moved in their shell profile (lib/engineHomes.ts), or an agent's own Codex profile
  // alone. Only the default folders were looked in, so a resume typed into a pane for a conversation in a
  // moved home found no file and never bound, though the registry would have taken it.
  if (engine === 'codex') {
    for (const home of opts?.codexHome ? [opts.codexHome] : codexHomeRoots(env.CODEX_HOME)) {
      const found = resolveCodexRollout(sessionId, join(home, 'sessions'))
      if (found) return found
    }
    return null
  }
  if (engine !== 'claude') return null
  for (const root of claudeProjectsRoots(env.CLAUDE_PROJECTS_DIR)) {
    let projects: string[]
    try { projects = await readdir(root) } catch { continue }
    for (const project of projects) {
      const candidate = join(root, project, `${sessionId}.jsonl`)
      try {
        if ((await stat(candidate)).isFile()) return candidate
      } catch { /* not this project */ }
    }
  }
  return null
}

/** Claude's native process record is removed at exit; capture it before Stop signals the engine. */
/** The files a process holds open: `/proc` on Linux, `lsof` elsewhere. Empty when neither can say. */
export async function openFiles(pid: number): Promise<string[]> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return []
  if (process.platform === 'linux') {
    const fds = await readdir(`/proc/${pid}/fd`).catch(() => [] as string[])
    const paths = await Promise.all(fds.map((fd) => readlink(`/proc/${pid}/fd/${fd}`).catch(() => null)))
    return paths.filter((path): path is string => !!path && path.startsWith('/'))
  }
  const stdout = await new Promise<string>((resolve) => {
    // `-Fn`: one `n<path>` line per open file. A process that is gone answers nothing.
    execFile('lsof', ['-n', '-P', '-p', String(pid), '-Fn'], { timeout: 3_000 }, (_error, out) => resolve(out ?? ''))
  })
  return stdout.split('\n').filter((line) => line.startsWith('n/')).map((line) => line.slice(1))
}

/** The rollout may be held by the native child of npm's Node launcher, not the launcher itself.
 *  October 6 ownership E2E: removing the folder guess exposed that distinction for a manually started
 *  Codex with no hook. Read only one direct Codex child of a Node launcher, never a nested tool. */
export async function codexProcessFiles(
  pid: number,
  files: typeof openFiles = openFiles,
  processes: () => Promise<readonly Pick<ProcessRow, 'pid' | 'parentPid' | 'executable' | 'args'>[] | null> = processRows,
): Promise<string[]> {
  const own = await files(pid)
  if (own.some(path => /rollout-[^/]*\.jsonl$/.test(path))) return own
  const rows = await processes()
  const wrapper = rows?.find(row => row.pid === pid)
  if (!wrapper || ![wrapper.executable, argvTokens(wrapper.args)[0] ?? '']
    .some(path => /^node(?:js)?$/.test(basename(path)))) return own
  const children = rows!.filter(row => row.parentPid === pid && engineProcessMatchScore(row, 'codex') > 0)
  return children.length === 1 ? [...own, ...await files(children[0].pid)] : own
}

/**
 * The conversation a Codex process is writing: the rollout it holds open.
 *
 * The one way to name a fork's conversation when its start-up hook was lost (a daemon restart in its
 * first second). `codex fork <id>` names only its source in argv, and a fork shares its source's
 * folder with every sibling started near it, so a scan of that folder finds them all and must refuse
 * to guess — the fork stayed without a conversation for good (e2e/chaos.e2e.ts).
 */
export async function codexProcessSession(
  pid: number,
  sessionsRoot: string | string[],
  cwd: string,
  files: (pid: number) => Promise<string[]> = codexProcessFiles,
): Promise<RepairedSession | null> {
  const roots = await Promise.all((typeof sessionsRoot === 'string' ? [sessionsRoot] : sessionsRoot)
    .map((one) => realpath(one).catch(() => one)))
  const found = new Map<string, RepairedSession>()
  for (const path of await files(pid)) {
    if (!/rollout-[^/]*\.jsonl$/.test(path)) continue
    const real = await realpath(path).catch(() => path)
    if (!roots.some((root) => real.startsWith(`${root}${sep}`))) continue
    const meta = readCodexRolloutMeta(real)
    if (!meta || meta.isSubagent || !meta.id || !meta.cwd || !await sameDir(meta.cwd, cwd)) continue
    found.set(real, { sessionId: meta.id, transcriptPath: real })
  }
  return found.size === 1 ? [...found.values()][0] : null
}

export async function claudeProcessSession(pid: number, cwd: string, startedAtMs: number): Promise<RepairedSession | null> {
  if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isFinite(startedAtMs)) return null
  // `<home>/sessions/<pid>.json` in a moved CLAUDE_CONFIG_DIR too (lib/engineHomes.ts): the default alone
  // was read, so a process in a moved home was never named by its own record.
  for (const projects of claudeProjectsRoots(env.CLAUDE_PROJECTS_DIR)) {
    const found = await claudeProcessRecord(join(dirname(projects), 'sessions', `${pid}.json`), pid, cwd, startedAtMs)
    if (found) return found
  }
  return null
}

async function claudeProcessRecord(file: string, pid: number, cwd: string, startedAtMs: number): Promise<RepairedSession | null> {
  try {
    const record = JSON.parse(await readFile(file, 'utf8'))
    // procStart is UTC in current Claude, while older builds used the host's local ps format.
    // Both represent the exact second, not the metadata file's modification time or a recycled PID.
    if (record.pid !== pid || typeof record.procStart !== 'string'
      || ![Date.parse(record.procStart), Date.parse(`${record.procStart} UTC`)].includes(startedAtMs)
      || typeof record.cwd !== 'string' || !await sameDir(record.cwd, cwd)
      || typeof record.sessionId !== 'string') return null
    const transcriptPath = await findResumedTranscript('claude', record.sessionId)
    return transcriptPath ? { sessionId: record.sessionId, transcriptPath } : null
  } catch { return null }
}
