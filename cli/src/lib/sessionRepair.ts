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
import { readdir, readlink, realpath, stat } from 'fs/promises'
import { basename, dirname, isAbsolute, join, sep } from 'path'
import { env } from '../config/env.js'
import type { SessionStoreContract } from '../engines/facets/sessionStore.js'
import { identityBytes, identityEntries, identityFile, identityHead, identityScanBudget, IdentityReadUnavailable } from '../engines/kit/identityScan.js'
import { sessionIdentityMetaOf } from '../engines/sessionFiles.js'
import { exactTranscript, exactWorkspaces } from '../engines/kit/exactTranscript.js'
import { readSessionHeader } from '../engines/kit/sessionIdentity.js'
import { sessionStoreOf } from '../engines/sessionStoreContracts.js'
import type { AgentEngine } from '../engines/types.js'
import { HERMES_HOMES, HERMES_HISTORY_ID_RE, HERMES_ID_SQL, HERMES_SOURCE, HERMES_SOURCE_SQL } from '../engines/hermes/contract.js'
import { readStorePool } from '../engines/kit/storePool.js'
import { isInteractiveSource } from '../engines/kit/storeSource.js'
import { museSessionIdentity, piSessionFolder, readPiHead } from '../engines/repairIdentities.js'
import { PI_HEADER, PI_SESSION_ID } from '../engines/pi/contract.js'
import { transcriptOf, processSessionOf as nativeProcessSession } from '../engines/identities.js'
import { COPILOT_CWD } from '../engines/copilot/contract.js'
import { recordCwd } from '../engines/kit/sessionLocation.js'
import { sqliteReadAll, type SqliteParam } from './sqliteRead.js'
import { sqlitePreflightMessage } from './sqliteAvailability.js'
import { sessionRoots } from './engineHomes.js'
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

/** Known empty homes still require native probes. Do not let a saved catalog bypass the walk bound. */
function repairRoots(engine: AgentEngine, profile?: string): string[] {
  const roots = sessionRoots(engine, profile)
  if (roots.length > 64) throw new IdentityReadUnavailable('the known session-home limit was reached')
  return roots
}

export interface RepairedSession {
  sessionId: string
  /** File-backed engines only; the DB-backed ones are read by session id. */
  transcriptPath?: string
  /** Hermes only: which home's store the session was found in, when it was not the default one. */
  hermesHome?: string
}

interface TranscriptFile { path: string; mtimeMs: number; birthMs: number }

/** Collect a complete bounded pool. Truncation must never make two conversations look like one. */
async function transcripts(root: string, budget: { remaining: number }, out: TranscriptFile[], excluded?: string, depth = 0): Promise<void> {
  for await (const entry of identityEntries(root, budget, depth === 0)) {
    const full = join(root, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === excluded) continue
      if (depth >= MAX_DEPTH) throw new IdentityReadUnavailable('the transcript depth limit was reached')
      await transcripts(full, budget, out, excluded, depth + 1)
      continue
    }
    if (!entry.name.endsWith('.jsonl') || entry.name.includes('.checkpoints.')) continue
    if (out.length >= MAX_FILES) throw new IdentityReadUnavailable('the transcript count limit was reached')
    try {
      const info = await stat(full)
      if (!info.isFile()) throw new IdentityReadUnavailable('a transcript is not a regular file')
      out.push({ path: full, mtimeMs: info.mtimeMs, birthMs: info.birthtimeMs || info.mtimeMs })
    } catch (error) {
      if (error instanceof IdentityReadUnavailable) throw error
      throw new IdentityReadUnavailable('a transcript could not be inspected')
    }
  }
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
 * The first `cwd` in a transcript's head and, when asked, its opening flag named `sidechain` (an engine's session
 * store declares it: `scan.sidechain`). One bounded read (256 KB — transcripts run to hundreds of MB) shared by
 * every file engine that declares its cwd in-file. Without a flag it stops at the first cwd, exactly as it always did.
 */
async function readTranscriptHead(path: string, sidechain: string | null, requestedCwd?: string): Promise<{ cwd: string; side: boolean | undefined } | null> {
  try {
    // Preserve the existing UTF-16 character budget, including non-ASCII paths. Four
    // UTF-8 bytes per code unit is sufficient even when the cutoff splits a surrogate
    // pair; a byte budget equal to the character budget would silently shrink the scan.
    const bytes = await identityBytes(path, CWD_SCAN_CHARS * 4 + 1)
    const text = bytes.subarray(0, CWD_SCAN_CHARS * 4).toString('utf-8')
    const head = text.slice(0, CWD_SCAN_CHARS)
    const complete = bytes.length <= CWD_SCAN_CHARS * 4 && text.length <= CWD_SCAN_CHARS
      && head.split('\n').length <= CWD_SCAN_LINES
    let cwd = ''
    let side: boolean | undefined
    let malformed = false
    for (const line of head.split('\n', CWD_SCAN_LINES)) {
      if (!line.trim()) continue
      let obj: Record<string, unknown>
      try { obj = JSON.parse(line) as Record<string, unknown> } catch { malformed = true; continue }
      if (!obj || typeof obj !== 'object' || Array.isArray(obj)) { malformed = true; continue }
      if (!cwd && typeof obj.cwd === 'string' && obj.cwd) cwd = obj.cwd
      if (cwd && !isAbsolute(cwd)) throw new IdentityReadUnavailable('the transcript working directory is invalid')
      if (sidechain && side === undefined && typeof obj[sidechain] === 'boolean') side = obj[sidechain] as boolean
      if (cwd && requestedCwd && !await sameDir(cwd, requestedCwd)) return { cwd, side }
      if (side === true || (cwd && (!sidechain || side !== undefined))) return { cwd, side }
    }
    if (!complete) throw new IdentityReadUnavailable('the transcript header exceeds the read limit')
    if (!cwd || (sidechain && side === undefined && malformed)) {
      throw new IdentityReadUnavailable('the transcript header is incomplete or invalid')
    }
    return { cwd, side }
  } catch (error) {
    if (error instanceof IdentityReadUnavailable) throw error
    throw new IdentityReadUnavailable('a transcript header could not be read')
  }
}

async function readTranscriptMeta(path: string): Promise<TranscriptMeta | null> {
  const head = await readTranscriptHead(path, null)
  return head?.cwd ? { cwd: head.cwd } : null
}

/**
 * How a scan of `engine`'s declared store reads a file (its session store's `scan`), refusing a session another
 * one delegated to.
 *
 * `head`: the first cwd of the opening lines, as `readTranscriptMeta`, but never a file below a `childFolder`
 * segment of the sessions folder it is in, nor one whose FIRST record carrying the boolean `sidechain` flag says
 * true. Claude's subagents write transcripts of their own in the same tree, which a scan by directory cannot tell
 * from a conversation; left in, the youngest subagent file of a parent still running was picked as the session of
 * the agent born next to it (a fork), and Stop capture then recorded that id. Later records are not consulted for
 * the flag: a main transcript can hold sidechain records, and only its opening says what the file is.
 *
 * `first`: the file's first record (engines/sessionFiles.ts), whose id is the session's (the file name only holds
 * it), and never a child's: a subagent's rollout must never become an agent of its own.
 */
function scanMeta(engine: AgentEngine, scan: SessionStoreContract['scan'], cwd: string): (path: string) => Promise<TranscriptMeta | null> {
  if (scan.from === 'first') {
    return async (path) => {
      const meta = await sessionIdentityMetaOf(engine, path)
      return meta && !meta.isSubagent ? { cwd: meta.cwd, sessionId: meta.id || undefined } : null
    }
  }
  return async (path) => {
    // Relative to the sessions folder it is under (the daemon's own, or a moved home's): that folder itself may
    // legitimately sit under a folder of the child's name.
    // The bounded walk already excludes childFolder below each root. Reading the home
    // catalog again here would make every transcript reopen an unrelated configuration.
    const head = await readTranscriptHead(path, scan.sidechain, cwd)
    return head && head.side !== true && head.cwd ? { cwd: head.cwd } : null
  }
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

async function fileEngineSession(
  root: string | string[],
  cwd: string,
  startedAtMs: number,
  readMeta: (path: string) => Promise<TranscriptMeta | null>,
  opts?: { bornOnly?: boolean; excludedDirectory?: string },
): Promise<RepairedSession | null> {
  const since = startedAtMs - START_SLACK_MS
  const born: RepairedSession[] = []
  const wrote: RepairedSession[] = []
  // Several roots are one pool, newest first: one conversation in each of two homes is two agents, as in one.
  const files: TranscriptFile[] = []
  const budget = identityScanBudget()
  for (const directory of typeof root === 'string' ? [root] : root) {
    await transcripts(directory, budget, files, opts?.excludedDirectory)
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
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
  opts: { bornOnly?: boolean } | undefined,
): Promise<RepairedSession | null> {
  return fileEngineSession(join(env.COPILOT_HOME, 'session-state'), cwd, startedAtMs, async (path) => {
    if (basename(path) !== 'events.jsonl') return null
    const head = await identityHead(path, 5)
    const root = recordCwd(head.lines, COPILOT_CWD)
    if (!root || !isAbsolute(root)) throw new IdentityReadUnavailable(head.complete
      ? 'the session header is incomplete or invalid' : 'the session header exceeds the read limit')
    return root ? { cwd: root, sessionId: basename(dirname(path)) } : null
  }, opts)
}

/**
 * The session a live process of an engine with a declared store is running (engines/sessionStoreContracts.ts), in
 * every one of its sessions folders: the daemon's own and each home the person moved (lib/engineHomes.ts), or the
 * agent's own profile alone. The default alone left an agent in a moved home unbound.
 *
 * A process that names its own session in a record (`live.record`) is asked first: unlike a scan by folder, that
 * also identifies an old process in a busy project. One that holds its session file open (`live.open`) is only
 * ever matched by that file once its pid is known (the October 6 parallel-create incident: the only file in a
 * folder can belong to a sibling whose file opened first), and left unbound until then rather than guessed.
 */
async function storeSession(
  engine: AgentEngine,
  store: SessionStoreContract,
  cwd: string,
  startedAtMs: number,
  opts?: { bornOnly?: boolean; pid?: number; codexHome?: string },
): Promise<RepairedSession | null> {
  const scan = scanMeta(engine, store.scan, cwd)
  if ('record' in store.live) {
    const exact = opts?.pid ? await processSessionOf(engine, opts.pid, cwd, startedAtMs) : null
    if (exact) return exact
  }
  const sessions = repairRoots(engine, opts?.codexHome)
  const found = opts?.pid && 'open' in store.live
    ? await openFileSessionOf(engine, opts.pid, sessions, cwd)
    : await fileEngineSession(sessions, cwd, startedAtMs, scan,
      { ...opts, ...(store.scan.from === 'head' ? { excludedDirectory: store.scan.childFolder } : {}) })
  // The login shell may adopt another home during any native read. Its unseen candidates
  // invalidate this pool; an explicit profile remains independent of unrelated homes.
  if (repairRoots(engine, opts?.codexHome).join('\0') !== sessions.join('\0')) {
    throw new IdentityReadUnavailable('the known session homes changed during discovery')
  }
  return found
}

export async function findLiveSession(
  engine: AgentEngine,
  cwd: string,
  startedAtMs: number,
  // codexHome: the specific agent's own profile (its CODEX_HOME), when it isn't this machine's default —
  // see RegisteredSession.codexHome. Read only for an engine whose sessions follow one (`sessions.profile`).
  opts?: { bornOnly?: boolean; pid?: number; codexHome?: string; hermesHome?: string },
): Promise<RepairedSession | null> {
  const store = sessionStoreOf(engine)
  if (store) return storeSession(engine, store, cwd, startedAtMs, opts)
  const sinceMs = startedAtMs - START_SLACK_MS
  // The DB engines match on a directory STRING, so ask for both spellings of it (see sameDir).
  const real = await realpath(cwd).catch(() => cwd)
  const dirs = real === cwd ? [cwd] : [cwd, real]
  const dirList = placeholders(dirs.length)
  // Native identity is eager. Optional interpretation cannot keep a process unbound.
  switch (engine) {
    case 'pi':
      return fileEngineSession(join(env.PI_HOME, 'agent', 'sessions'), cwd, startedAtMs, readTranscriptMeta, opts)
    case 'commandcode':
      return fileEngineSession(join(env.COMMANDCODE_HOME, 'projects'), cwd, startedAtMs, readTranscriptMeta, opts)
    case 'muse': {
      // Muse's hooks never fire, so this scan is the ONLY way a muse pane is ever bound. The tree is
      // `sessions/YYYY/MM/DD/<session-uuid>/session.jsonl` (4 levels — exactly MAX_DEPTH) and nothing in
      // the path names the project: `workspace_root` in the first record is the only link. Sub-agent
      // files live one level deeper under `subagent/`, and must never be adopted as agents of their own.
      return fileEngineSession(join(env.MUSE_HOME, 'sessions'), cwd, startedAtMs, async (path) => {
        if (path.includes(`${sep}subagent${sep}`)) return null
        // Muse opens sessions of its OWN under the same workspace_root — memory reminders
        // (`memory_reminder_child_session_linked`) are the ones seen live. They are indistinguishable from
        // the user's session by path, workspace or birth time, and being younger they WIN the `born` tier:
        // measured, the daemon tailed an 11-line reminder session while the real conversation ran on in
        // another file, so web and device received nothing at all. What separates them is that a session
        // being conversed in has opened a RUN.
        const identity = await museSessionIdentity(path, root => sameDir(root, cwd))
        return identity ? { ...identity, sessionId: basename(dirname(path)) } : null
      }, { ...opts, excludedDirectory: 'subagent' })
    }
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
        if (!root.startsWith('/')) root = (await identityFile(join(group, '.cwd')).catch(error => {
          if (error instanceof IdentityReadUnavailable) throw error
          throw new IdentityReadUnavailable('the session working directory is unavailable')
        })).trim()
        if (!isAbsolute(root)) throw new IdentityReadUnavailable('the session working directory is invalid')
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
      const found = await readStorePool(HERMES_HOMES, env.HERMES_HOME, {
        sql: `SELECT ${HERMES_ID_SQL} AS id, ${HERMES_SOURCE_SQL} AS source, started_at, typeof(cwd) AS cwd_type,`
          + " CASE WHEN typeof(cwd) = 'text' AND length(CAST(cwd AS BLOB)) <= 4096 AND instr(CAST(cwd AS BLOB), x'00') = 0 THEN cwd END AS cwd"
          + ' FROM sessions LIMIT 8193;',
        params: [], maxRows: 8192, maxBuffer: 40 * 1024 * 1024,
        columns: ['id', 'source', 'cwd', 'started_at'], knownHome: opts?.hermesHome,
      })
      const candidates: RepairedSession[] = []
      for (const { home, aliases, row } of found) {
        // Editor/gateway rows may have no working directory; they cannot claim this process's cwd.
        if (row.cwd === null && row.cwd_type === 'null') continue
        if (typeof row.cwd !== 'string') {
          throw new IdentityReadUnavailable('a Hermes store contains invalid discovery evidence')
        }
        if (!dirs.includes(row.cwd)) continue
        if (typeof row.started_at !== 'number' || !Number.isFinite(row.started_at)) {
          throw new IdentityReadUnavailable('a Hermes store contains invalid discovery evidence')
        }
        if (row.started_at < Math.trunc(sinceMs / 1000)) continue
        if (typeof row.source !== 'string') throw new IdentityReadUnavailable('a Hermes session source is unavailable')
        if (!isInteractiveSource(HERMES_SOURCE, row.source)) continue
        if (typeof row.id !== 'string' || !HERMES_HISTORY_ID_RE.test(row.id)) {
          throw new IdentityReadUnavailable('a Hermes store contains an invalid conversation id')
        }
        if (opts?.hermesHome && !aliases.includes(opts.hermesHome)) continue
        candidates.push({ sessionId: row.id, hermesHome: opts?.hermesHome ?? home })
      }
      return candidates.length === 1 ? candidates[0] : null
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
      const locked = opts?.pid ? await nativeProcessSession('copilot', env.COPILOT_HOME, opts.pid) : null
      if (locked) {
        const transcriptPath = await transcriptOf('copilot', env.COPILOT_HOME, locked)
        if (await nativeProcessSession('copilot', env.COPILOT_HOME, opts!.pid!) !== locked) {
          throw new IdentityReadUnavailable('the process conversation changed during transcript lookup')
        }
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
  const conversationId = await nativeProcessSession('agy', env.AGY_HOME, pid)
  if (!conversationId) return null
  const transcriptPath = await transcriptOf('agy', env.AGY_HOME, conversationId)
  if (await nativeProcessSession('agy', env.AGY_HOME, pid) !== conversationId) {
    throw new IdentityReadUnavailable('the process conversation changed during transcript lookup')
  }
  // A conversation with no transcript is one agy has opened but not written to; registry derives the
  // path anyway, so bind it and let the watcher pick the file up when it appears.
  return { sessionId: conversationId, transcriptPath: transcriptPath ?? undefined }
}

/**
 * The transcript behind a session id a process names on its own command line (`claude --resume <id>`,
 * `codex resume <id>`) — the file `registry.register` insists on for the engines with a declared store, which
 * argv does not carry. Found as the store declares (`byId`): in any one project folder directly below a sessions
 * folder (Claude's cwd encoding is its own to define, so the folders are listed rather than the name derived), or
 * by the walk for a file whose name holds the id (Codex's rollouts). Only a file that exists is returned: a resume
 * of a session this machine never wrote (or one that was deleted) binds nothing.
 */
export async function findResumedTranscript(
  engine: AgentEngine,
  sessionId: string,
  opts?: { codexHome?: string; cwd?: string },
): Promise<string | null> {
  if (engine === 'pi') {
    // Pi allocates an ID before its first reply creates the file. Look up that
    // exact ID again at Close, including after exit, without guessing by mtime.
    if (!opts?.cwd || !PI_SESSION_ID.test(sessionId)) {
      throw new IdentityReadUnavailable('the Pi conversation location is unavailable', 'The Pi conversation location is unavailable.')
    }
    // The folder and header are native identity, available even when Pi's history reader cannot load.
    const directory = join(env.PI_HOME, 'agent', 'sessions', piSessionFolder(opts.cwd))
    const workspaces = exactWorkspaces()
    return exactTranscript([directory], { kind: 'directory', matches: file => file.endsWith(`_${sessionId}.jsonl`) }, {
      accepts: async (path, version) => {
        const head = await readSessionHeader(PI_HEADER, async bytes => (await identityBytes(path, bytes, version)).toString('utf8'))
          .catch(() => null)
        if (!head || typeof head === 'symbol') {
          throw new IdentityReadUnavailable('the Pi conversation file could not be read', 'The Pi conversation file could not be read.')
        }
        return head.sessionId === sessionId && await workspaces.same(head.cwd, opts.cwd!)
      },
      verify: workspaces.verify,
      ambiguous: 'More than one file matches this Pi conversation.',
    })
  }
  if (!/^[0-9a-f-]{16,128}$/i.test(sessionId)) return null
  const byId = sessionStoreOf(engine)?.byId
  if (!byId) return null
  // In every folder the registry takes a transcript from (registry.validTranscriptPath): the daemon's own and
  // each home the person moved in their shell profile (lib/engineHomes.ts), or an agent's own profile alone.
  // Only the default folders were looked in, so a resume typed into a pane for a conversation in a moved home
  // found no file and never bound, though the registry would have taken it.
  const roots = repairRoots(engine, opts?.codexHome)
  const found = await (byId.layout === 'walk'
    ? exactTranscript(roots, { kind: 'walk', matches: file => file.endsWith(byId.suffix) && file.includes(sessionId) }, {
      accepts: async (path, version) => {
        const meta = await sessionIdentityMetaOf(engine, path, version)
        if (!meta?.id || !byId.id.test(meta.id)) throw new IdentityReadUnavailable('the exact rollout header has no conclusive conversation id')
        return meta.id === sessionId
      },
    })
    : exactTranscript(roots, { kind: 'projects', filename: `${sessionId}${byId.suffix}` }))
  if (repairRoots(engine, opts?.codexHome).join('\0') !== roots.join('\0')) {
    throw new IdentityReadUnavailable('the known session homes changed during exact lookup')
  }
  return found
}

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

type ProcessTable = () => Promise<readonly Pick<ProcessRow, 'pid' | 'parentPid' | 'executable' | 'args'>[] | null>

/**
 * The files a process of an engine that holds its session file open (`live.open`) has open, its native child's
 * too behind a launcher (the declared `launcher`, npm's Node one): the launcher holds no session file, its child
 * does. October 6 ownership E2E: removing the folder guess exposed that distinction for a manually started Codex
 * with no hook. Only one direct child of that engine is read, never a nested tool. Empty for another engine.
 */
export async function processFilesOf(
  engine: AgentEngine,
  pid: number,
  files: typeof openFiles = openFiles,
  processes: ProcessTable = processRows,
): Promise<string[]> {
  const live = sessionStoreOf(engine)?.live
  if (!live || !('open' in live)) return []
  const { file, launcher } = live.open
  const own = await files(pid)
  if (own.some(path => file.test(path))) return own
  const rows = await processes()
  const wrapper = rows?.find(row => row.pid === pid)
  if (!wrapper || ![wrapper.executable, argvTokens(wrapper.args)[0] ?? '']
    .some(path => launcher.test(basename(path)))) return own
  const children = rows!.filter(row => row.parentPid === pid && engineProcessMatchScore(row, engine) > 0)
  return children.length === 1 ? [...own, ...await files(children[0].pid)] : own
}

/**
 * The conversation a process of an engine that holds its session file open (`live.open`) is writing: the one
 * such file it holds below `sessionsRoot`, in `cwd`, never a child's. Null for another engine.
 *
 * The one way to name a fork's conversation when its start-up hook was lost (a daemon restart in its
 * first second). `codex fork <id>` names only its source in argv, and a fork shares its source's
 * folder with every sibling started near it, so a scan of that folder finds them all and must refuse
 * to guess — the fork stayed without a conversation for good (e2e/chaos.e2e.ts).
 */
export async function openFileSessionOf(
  engine: AgentEngine,
  pid: number,
  sessionsRoot: string | string[],
  cwd: string,
  files: (pid: number) => Promise<string[]> = (one) => processFilesOf(engine, one),
): Promise<RepairedSession | null> {
  const live = sessionStoreOf(engine)?.live
  if (!live || !('open' in live)) return null
  const roots = await Promise.all((typeof sessionsRoot === 'string' ? [sessionsRoot] : sessionsRoot)
    .map((one) => realpath(one).catch(() => one)))
  const found = new Map<string, RepairedSession>()
  for (const path of await files(pid)) {
    if (!live.open.file.test(path)) continue
    const real = await realpath(path).catch(() => path)
    if (!roots.some((root) => real.startsWith(`${root}${sep}`))) continue
    const meta = await sessionIdentityMetaOf(engine, real)
    if (!meta || meta.isSubagent || !meta.id || !meta.cwd || !await sameDir(meta.cwd, cwd)) continue
    found.set(real, { sessionId: meta.id, transcriptPath: real })
  }
  return found.size === 1 ? [...found.values()][0] : null
}

/**
 * The session a live process names in a record of its own, for an engine that keeps one (`live.record`):
 * `<home>/<folder>/<pid><suffix>` beside each of its sessions folders, a moved home's too (lib/engineHomes.ts):
 * the default alone was read, so a process in a moved home was never named by its own record. Removed at exit,
 * so Stop captures it before signalling the engine. Null for another engine.
 */
export async function processSessionOf(engine: AgentEngine, pid: number, cwd: string, startedAtMs: number): Promise<RepairedSession | null> {
  const live = sessionStoreOf(engine)?.live
  if (!live || !('record' in live)) return null
  if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isFinite(startedAtMs)) return null
  const rule = live.record
  let result: RepairedSession | null = null
  let selected: string | undefined
  const roots = repairRoots(engine)
  const records: { file: string; text: string | null }[] = []
  const read = (file: string) => identityFile(file).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  })
  for (const sessions of roots) {
    const file = join(dirname(sessions), rule.folder, `${pid}${rule.suffix}`)
    const text = await read(file)
    records.push({ file, text })
    if (text === null) continue
    const found = await processRecord(engine, rule, text, pid, cwd, startedAtMs)
    if (!found) continue
    if (result && (result.sessionId !== found.sessionId || result.transcriptPath !== found.transcriptPath)) {
      throw new IdentityReadUnavailable('current process records name different conversations')
    }
    result = found
    selected = file
  }
  // A conversation can change inside the same process while another home is being read.
  // Recheck absent/stale claims too: a newly created claim invalidates the earlier pool.
  // Read the authoritative claim last: otherwise it can change while the later homes
  // are being rechecked. No asynchronous work follows that final native read.
  const recheck = [...records.filter(record => record.file !== selected), ...records.filter(record => record.file === selected)]
  for (const { file, text } of recheck) {
    if (await read(file) !== text) throw new IdentityReadUnavailable('the process records changed during discovery')
  }
  if (repairRoots(engine).join('\0') !== roots.join('\0')) throw new IdentityReadUnavailable('the known session homes changed during discovery')
  return result
}

type ProcessRecordRule = Extract<SessionStoreContract['live'], { record: unknown }>['record']

async function processRecord(engine: AgentEngine, rule: ProcessRecordRule, text: string, pid: number, cwd: string, startedAtMs: number): Promise<RepairedSession | null> {
  try {
    const record = JSON.parse(text)
    if (!record || typeof record !== 'object' || Array.isArray(record)
      || !Number.isSafeInteger(record[rule.pid]) || record[rule.pid] <= 0 || typeof record[rule.start] !== 'string'
      || !Number.isFinite(Date.parse(record[rule.start]))
      || typeof record[rule.cwd] !== 'string' || !isAbsolute(record[rule.cwd])
      || typeof record[rule.id] !== 'string' || !record[rule.id]) {
      throw new IdentityReadUnavailable('the process record is incomplete or invalid')
    }
    const start = record[rule.start]
    const folder = record[rule.cwd]
    const sessionId = record[rule.id]
    // Claude's procStart is UTC in current builds, while older builds used the host's local ps format.
    // Both represent the exact second, not the metadata file's modification time or a recycled PID.
    if (record[rule.pid] !== pid || ![Date.parse(start), Date.parse(`${start} UTC`)].includes(startedAtMs)) return null
    if (!await sameDir(folder, cwd)) throw new IdentityReadUnavailable('the current process record names a different working directory')
    const transcriptPath = await findResumedTranscript(engine, sessionId)
    if (!transcriptPath) throw new IdentityReadUnavailable('the process names a conversation whose transcript is unavailable')
    return { sessionId, transcriptPath }
  } catch (error) {
    if (error instanceof IdentityReadUnavailable) throw error
    if (error instanceof SyntaxError) throw new IdentityReadUnavailable('the process record is incomplete or invalid')
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw new IdentityReadUnavailable('the process record could not be read')
  }
}
