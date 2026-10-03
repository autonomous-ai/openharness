/**
 * Hermes: one SQLite store per home, `<home>/state.db`. A machine has the default home and one per
 * profile (`<root>/profiles/<name>`, what `hermes -p <name>` runs in); `<root>/active_profile` makes a
 * plain `hermes` run in a profile instead. Several Hermes versions write one store, so its columns are
 * read from the store before the list is asked for (measured: schema 22 on disk, 17 in the CLI's code).
 *
 * `sessions.source` says who started one: `cli` (the REPL, and one-shots), `tui` (the terminal UI and
 * the desktop app), `acp` (an editor). Everything else is a gateway, cron, a tool or a sub-agent.
 * `parent_session_id` means three things: a delegation child (`_delegate_from` in `model_config`,
 * hidden), a `/branch` (listed on its own), and a compression continuation: the parent ended with
 * `end_reason = 'compression'` and the conversation carries on under the child's id. A chain is one
 * conversation, listed once under its newest id (its tip), as Hermes lists it (`hermes_state.py`,
 * `list_sessions_rich` and `get_compression_tip`, v0.18.0). Times are REAL epoch seconds.
 *
 * Where it ran: `cwd` is written for the REPL only; an editor keeps it in `model_config.cwd`; else the
 * repository root. A terminal UI session has none (measured: all three here), so it cannot be resumed.
 *
 * Owners: `<home>/runtime/active_sessions.json` (exact; Hermes writes it only when
 * `max_concurrent_sessions` is set), then the id in a Hermes process's arguments (`-r/--resume`),
 * followed to its chain's tip: only where the process started, so `fromArgs`.
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { hermesMessagesToEvents, isTerminalFinish } from '../../../engines/hermes/normalizer.js'
import { HERMES_HISTORY_ID_RE, readHermesMessages } from '../../../engines/hermes/reader.js'
import { hasSqliteReader } from '../../sqliteAvailability.js'
import type { SqliteParam, SqliteRow } from '../../sqliteRead.js'
import { argvTokens, resumeSessionId } from '../../tmux.js'
import {
  LIST_LIMIT, ancestry, argvSubcommand, engineProcess, ownerRecord, parseOwnerRecord, readSql, rowsOf, splitCounts,
  storeStamp, tableColumns, tally, type Counting, type SqlRead, type Tally,
} from './opencode.js'
import { absoluteFolder, entries, epochMs, readJson, record, text } from './support.js'
import type { ExternalProvider, ExternalSession, OwnerClaim, ProcessView, RunningProcess, ScanContext } from './types.js'

export interface HermesOptions {
  root: string
  /** How a statement is run; tests replace it. */
  read?: SqlRead
  /** Whether this machine can read SQLite at all; tests replace it. */
  available?: () => boolean
  /** Epoch ms; tests replace it. */
  now?: () => number
}

/**
 * One conversation under several ids: a compression chain. `aliases` are its other ids, oldest first,
 * so a caller that holds any of them (a Harness agent bound before the chain moved on) can tell it is
 * the same conversation.
 */
export type HermesSession = ExternalSession & { aliases: readonly string[] }

/** Hermes's own rule for a profile's name (`hermes_cli/profiles.py`). */
const PROFILE_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/
/** A person with hundreds of profile folders has a different problem; this keeps the scan bounded. */
const MAX_PROFILES = 64

/** Subcommands that serve other clients (the desktop app, a browser, a chat platform, an editor). */
const SERVERS = new Set(['serve', 'dashboard', 'desktop', 'gui', 'gateway', 'acp'])
/** Hermes's top-level flags that take a value (`hermes_cli/main.py`). */
const VALUE_FLAGS = new Set(['-z', '--oneshot', '-m', '--model', '--provider', '-t', '--toolsets', '-r', '--resume', '-s', '--skills', '-p', '--profile'])
/** `-c [name]`: a value only when one follows. */
const OPTIONAL_VALUE_FLAGS = new Set(['-c', '--continue'])
const SUBCOMMAND_FLAGS = new Set([...VALUE_FLAGS, ...OPTIONAL_VALUE_FLAGS])

export interface HermesHome {
  home: string
  dbPath: string
  /** The profile's name; null for the default home. */
  profile: string | null
}

/** The profile `hermes profile use <name>` made sticky, or null for the default. */
export async function activeProfile(root: string): Promise<string | null> {
  const name = (await readFile(join(root, 'active_profile'), 'utf8').catch(() => '')).trim()
  return PROFILE_ID.test(name) && name !== 'default' ? name : null
}

function homeOf(root: string, profile: string | null): HermesHome {
  const home = profile ? join(root, 'profiles', profile) : root
  return { home, dbPath: join(home, 'state.db'), profile }
}

/** Every home: the default first, then the profiles, the sticky one ahead so a cap never drops it. */
export async function hermesHomes(root: string, active: string | null): Promise<HermesHome[]> {
  const names = (await entries(join(root, 'profiles')))
    .filter((entry) => (entry.isDirectory() || entry.isSymbolicLink()) && PROFILE_ID.test(entry.name) && entry.name !== 'default')
    .map((entry) => entry.name)
    .sort()
  const ordered = active && names.includes(active) ? [active, ...names.filter((name) => name !== active)] : names
  return [homeOf(root, null), ...ordered.slice(0, MAX_PROFILES).map((name) => homeOf(root, name))]
}

/**
 * One statement: the newest rows a person could have started, with what a chain needs to be put
 * together, and how many rows each rule kept out (a row with a null id is a count). Built from the
 * columns the store has.
 */
export function hermesListSql(sessions: ReadonlySet<string>, messages: ReadonlySet<string>): string | null {
  if (!sessions.has('id') || !sessions.has('source')) return null
  const col = (name: string): string => (sessions.has(name) ? `s.${name}` : 'NULL')
  const config = sessions.has('model_config') ? 'CASE WHEN json_valid(s.model_config) THEN s.model_config END' : ''
  const marker = (key: string): string => (config ? `json_extract(${config}, '$.${key}')` : 'NULL')
  const parent = (name: string): string => (sessions.has('parent_session_id') && sessions.has(name)
    ? `(SELECT p.${name} FROM sessions p WHERE p.id = s.parent_session_id)`
    : 'NULL')
  const lastMessage = messages.has('session_id') && messages.has('timestamp')
    ? '(SELECT max(m.timestamp) FROM messages m WHERE m.session_id = s.id)'
    : 'NULL'
  const skip = "CASE WHEN s.source IS NULL OR s.source NOT IN ('cli', 'tui', 'acp') THEN 'source'"
    + (sessions.has('archived') ? " WHEN COALESCE(s.archived, 0) <> 0 THEN 'archived'" : '')
    + (config ? ` WHEN ${marker('_delegate_from')} IS NOT NULL THEN 'delegated'` : '')
    + " ELSE '' END"
  const columns = [
    's.id AS id', 's.source AS source', `${col('parent_session_id')} AS parent`, `${col('started_at')} AS started`,
    `${col('ended_at')} AS ended`, `${col('end_reason')} AS end_reason`, `${col('cwd')} AS cwd`,
    `${marker('cwd')} AS config_cwd`, `${col('git_repo_root')} AS repo`, `${col('title')} AS title`,
    `${col('display_name')} AS display_name`, `${marker('_branched_from')} AS branched`,
    `${parent('end_reason')} AS parent_end`, `${parent('ended_at')} AS parent_ended`, `${lastMessage} AS last_msg`,
    "'' AS skip", 'NULL AS n',
  ]
  return `SELECT * FROM (SELECT ${columns.join(', ')} FROM sessions s WHERE ${skip} = '' `
    + `ORDER BY coalesce(${lastMessage}, ${col('started_at')}, 0) DESC LIMIT ${LIST_LIMIT}) `
    + `UNION ALL SELECT ${'NULL, '.repeat(columns.length - 2)}${skip} AS skip, count(*) AS n FROM sessions s GROUP BY skip`
}

/** One `sessions` row, as the list reads it. Times are epoch seconds. */
export interface HermesRow {
  id: string
  source: string
  parent: string | null
  started: number | null
  ended: number | null
  endReason: string | null
  cwd: string | null
  configCwd: string | null
  repo: string | null
  title: string
  displayName: string
  branched: boolean
  parentEnd: string | null
  parentEnded: number | null
  lastMsg: number | null
}

const orNull = (value: unknown): string | null => (typeof value === 'string' && value ? value : null)
const number = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null)

export function hermesRow(row: SqliteRow): HermesRow {
  return {
    id: text(row.id), source: text(row.source), parent: orNull(row.parent), started: number(row.started),
    ended: number(row.ended), endReason: orNull(row.end_reason), cwd: orNull(row.cwd), configCwd: orNull(row.config_cwd),
    repo: orNull(row.repo), title: text(row.title), displayName: text(row.display_name),
    branched: row.branched !== null && row.branched !== undefined, parentEnd: orNull(row.parent_end),
    parentEnded: number(row.parent_ended), lastMsg: number(row.last_msg),
  }
}

/**
 * What a row is to a person: the start of a conversation (a root, or a `/branch`, by its marker or by
 * Hermes's older rule: the parent ended `branched` before the child began), the continuation of one
 * (its parent was compressed), or a sub-agent's child, hidden.
 */
export function hermesKind(row: HermesRow): 'head' | 'continuation' | 'child' {
  if (!row.parent) return 'head'
  if (row.branched) return 'head'
  if (row.parentEnd === 'branched' && row.parentEnded !== null && row.started !== null && row.started >= row.parentEnded) return 'head'
  return row.parentEnd === 'compression' ? 'continuation' : 'child'
}

const rank = (row: HermesRow): number => (row.endReason === 'compression' ? 0 : row.ended === null ? 1 : 2)
const activity = (row: HermesRow): number => row.lastMsg ?? row.started ?? 0

/**
 * The continuation a chain follows, as `get_compression_tip` picks it: one compressed again, then one
 * still open, then the most recently active; a stale sibling (a reaped websocket's) loses.
 */
export function bestContinuation(children: readonly HermesRow[]): HermesRow {
  return [...children].sort((a, b) => rank(a) - rank(b)
    || activity(b) - activity(a)
    || (b.started ?? 0) - (a.started ?? 0)
    || (a.id < b.id ? 1 : -1))[0]
}

export interface HermesChain {
  /** Oldest first; the last is the tip, the id a resume takes. */
  members: HermesRow[]
  /** The id the chain started from when that row is older than the list: part of it, not listed. */
  lost: string | null
}

/** The listed rows put together into conversations: each root or branch followed to its tip. */
export function hermesChains(rows: readonly HermesRow[], counts: Tally): HermesChain[] {
  const byId = new Map(rows.map((row) => [row.id, row]))
  const continuations = new Map<string, HermesRow[]>()
  const starts: HermesChain[] = []
  for (const row of rows) {
    const kind = hermesKind(row)
    if (kind === 'head') starts.push({ members: [row], lost: null })
    else if (kind === 'continuation') continuations.set(row.parent!, [...continuations.get(row.parent!) ?? [], row])
    else tally(counts, 'child')
  }
  // A continuation whose parent is older than the list: the conversation starts there, unlisted.
  for (const [parent, children] of continuations) {
    if (!byId.has(parent)) starts.push({ members: [bestContinuation(children)], lost: parent })
  }
  const placed = new Set(starts.map((chain) => chain.members[0].id))
  for (const chain of starts) {
    for (;;) {
      const tip = chain.members[chain.members.length - 1]
      const next = (continuations.get(tip.id) ?? []).filter((child) => !placed.has(child.id))
      if (!next.length) break
      const chosen = bestContinuation(next)
      placed.add(chosen.id)
      chain.members.push(chosen)
    }
  }
  // Continuations no chain reached: a stale sibling, or one under a hidden child.
  for (const children of continuations.values()) for (const child of children) if (!placed.has(child.id)) tally(counts, 'stale')
  return starts
}

/** The first answer, newest member first. */
function newestFirst<T>(members: readonly HermesRow[], pick: (row: HermesRow) => T | null): T | null {
  for (let i = members.length - 1; i >= 0; i--) {
    const value = pick(members[i])
    if (value) return value
  }
  return null
}

interface Listed { rows: HermesRow[]; counts: Tally }

async function listSessions(read: SqlRead, dbPath: string): Promise<Listed | null> {
  const columns = await tableColumns(read, dbPath, ['sessions', 'messages'])
  if (!columns) return null
  const sql = hermesListSql(columns.get('sessions') ?? new Set(), columns.get('messages') ?? new Set())
  if (!sql) return { rows: [], counts: {} }
  const rows = await rowsOf(read, dbPath, sql)
  if (!rows) return null
  const split = splitCounts(rows)
  return { rows: split.rows.map(hermesRow), counts: split.counts }
}

/**
 * The chain [sessionId] belongs to, followed forward to its tip, as Hermes resumes it. A store too
 * old to have chains, or one that cannot be read, answers the id itself.
 */
const TIP_SQL = 'SELECT child.id AS id FROM sessions parent JOIN sessions child ON child.parent_session_id = parent.id'
  + " WHERE parent.id = ? AND parent.end_reason = 'compression'"
  + " AND json_extract(CASE WHEN json_valid(child.model_config) THEN child.model_config END, '$._branched_from') IS NULL"
  + " AND json_extract(CASE WHEN json_valid(child.model_config) THEN child.model_config END, '$._delegate_from') IS NULL"
  + " AND COALESCE(child.source, '') <> 'tool'"
  + " ORDER BY CASE WHEN child.end_reason = 'compression' THEN 0 WHEN child.ended_at IS NULL THEN 1 ELSE 2 END,"
  + ' COALESCE((SELECT max(m.timestamp) FROM messages m WHERE m.session_id = child.id), child.started_at) DESC,'
  + ' child.started_at DESC, child.id DESC LIMIT 1'

export async function compressionTip(read: SqlRead, dbPath: string, sessionId: string): Promise<string> {
  const seen = new Set([sessionId])
  let current = sessionId
  for (;;) {
    const result = await read(dbPath, TIP_SQL, [current])
    const next = result.ok ? text(result.rows[0]?.id) : ''
    if (!next || seen.has(next)) return current
    seen.add(next)
    current = next
  }
}

async function found(read: SqlRead, dbPath: string, sql: string, params: SqliteParam[]): Promise<boolean> {
  const result = await read(dbPath, sql, params)
  return result.ok && result.rows.length > 0
}

/** The profile a Hermes process's arguments name (`-p work`, `--profile=work`, `-p default`), or null. */
export function argvProfile(args: string): string | null {
  const tokens = argvTokens(args)
  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i]
    if (token === '--') break
    // Hermes takes the first one, and ignores a name it would refuse.
    if (token === '-p' || token === '--profile') return PROFILE_ID.test(tokens[i + 1] ?? '') ? tokens[i + 1] : null
    if (token.startsWith('--profile=')) return PROFILE_ID.test(token.slice(10)) ? token.slice(10) : null
    if (VALUE_FLAGS.has(token) || (OPTIONAL_VALUE_FLAGS.has(token) && !(tokens[i + 1] ?? '-').startsWith('-'))) i++
  }
  return null
}

export interface HermesLease {
  sessionId: string
  pid: number
  /** When the lease's process started, epoch ms (Hermes writes psutil's `create_time`, seconds), when known. */
  started?: number
}

/** How far a lease's start may sit from `ps`'s (whole seconds) and still be the same process. */
const START_SLACK_MS = 2_000

/** Hermes's active-session leases: the stored sessions a live CLI or terminal UI holds, by pid. */
export async function hermesLeases(home: string): Promise<HermesLease[]> {
  const file = await readJson(join(home, 'runtime', 'active_sessions.json'))
  const list = Array.isArray(file) ? file : record(file)?.entries
  if (!Array.isArray(list)) return []
  const leases: HermesLease[] = []
  for (const item of list) {
    const entry = record(item)
    const sessionId = text(entry?.session_id)
    const pid = entry?.pid
    const started = entry?.process_start_time
    // A gateway's lease names a chat's key, not a stored session.
    if (!HERMES_HISTORY_ID_RE.test(sessionId) || text(entry?.surface).startsWith('gateway')) continue
    if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) continue
    leases.push({ sessionId, pid, ...(typeof started === 'number' && started > 0 ? { started: started * 1000 } : {}) })
  }
  return leases
}

/**
 * Whether [lease] still names the process now running under its pid. A Hermes that crashed leaves its
 * lease behind, and the pid can go to anything after, a tool another Hermes runs among them; the
 * process's start says which. Either side unknown: the pid is all there is to go on.
 */
export function leaseHeldBy(lease: HermesLease, row: RunningProcess | undefined): boolean {
  if (lease.started === undefined || row?.started === undefined) return true
  return Math.abs(row.started - lease.started) <= START_SLACK_MS
}

/**
 * Whether the tail says a turn runs: a person's message waits for an answer, a tool's result for the
 * model, and an assistant message runs on unless it finished (`stop`, not `tool_calls`).
 */
export function hermesTurnOpen(rows: readonly SqliteRow[]): boolean | null {
  const tail = rows[0]
  if (!tail) return false
  if (tail.role === 'user' || tail.role === 'tool') return true
  if (tail.role !== 'assistant') return null
  return !isTerminalFinish(typeof tail.finish_reason === 'string' ? tail.finish_reason : null)
}

export function hermesProvider(options: HermesOptions): ExternalProvider & Counting {
  const { root } = options
  const read = options.read ?? readSql
  const available = options.available ?? hasSqliteReader
  const now = options.now ?? Date.now
  const lastGood = new Map<string, Listed | null>()
  let counts: Tally = {}

  function conversations(home: HermesHome, listed: Listed, ctx: ScanContext, active: string | null): HermesSession[] {
    const out: HermesSession[] = []
    // A profile's session resumes in its profile; the default home's, when a sticky profile would
    // otherwise send a plain `hermes` elsewhere, says so.
    const launchArgs = home.profile ? ['-p', home.profile] : active ? ['-p', 'default'] : null
    for (const { members, lost } of hermesChains(listed.rows, counts)) {
      const tip = members[members.length - 1]
      if (members.length > 1) tally(counts, 'compressed', members.length - 1)
      if (!HERMES_HISTORY_ID_RE.test(tip.id)) { tally(counts, 'badId'); continue }
      if (members.every((row) => row.lastMsg === null)) { tally(counts, 'empty'); continue }
      const cwd = newestFirst(members, (row) => absoluteFolder(row.cwd) ?? absoluteFolder(row.configCwd) ?? absoluteFolder(row.repo))
      // A terminal UI session records no folder: there is nowhere to resume it.
      if (!cwd) { tally(counts, 'noFolder'); continue }
      if (ctx.excluded(cwd)) { tally(counts, 'excluded'); continue }
      const ids = [...(lost ? [lost] : []), ...members.map((row) => row.id)]
      out.push({
        sessionId: tip.id,
        engine: 'hermes',
        cwd,
        origin: members[0].source === 'acp' ? 'editor' : 'terminal',
        title: newestFirst(members, (row) => row.displayName.trim() || row.title.trim()) ?? '',
        mtime: Math.max(...members.map((row) => epochMs(row.lastMsg ?? row.started) ?? 0)),
        transcriptPath: null,
        // The whole chain, oldest first: what was said before each compression is the same conversation.
        readHistory: async () => hermesMessagesToEvents((await Promise.all(ids.map((id) => readHermesMessages(home.dbPath, id)))).flat()),
        ...(launchArgs ? { launchArgs } : {}),
        aliases: ids.filter((id) => id !== tip.id),
      })
    }
    return out
  }

  return {
    engine: 'hermes',
    lastScan: () => counts,
    async scan(ctx: ScanContext): Promise<ExternalSession[]> {
      counts = {}
      if (!available()) return []
      const active = await activeProfile(root)
      const sessions: HermesSession[] = []
      const failures: unknown[] = []
      let stores = 0
      for (const home of await hermesHomes(root, active)) {
        const stamp = await storeStamp(home.dbPath)
        if (!stamp) continue
        stores++
        let listed: Listed | null
        try {
          listed = await ctx.memo(`hermes:${home.dbPath}`, stamp, () => listSessions(read, home.dbPath))
          lastGood.set(home.dbPath, listed)
        } catch (error) {
          // One home locked or broken keeps what it said last time; the others still answer.
          failures.push(error)
          listed = lastGood.get(home.dbPath) ?? null
        }
        await ctx.pace()
        if (!listed) continue
        for (const [reason, n] of Object.entries(listed.counts)) tally(counts, reason, n)
        sessions.push(...conversations(home, listed, ctx, active))
      }
      if (failures.length && failures.length === stores) throw failures[0]
      counts.found = sessions.length
      return sessions
    },
    async owners(view: ProcessView): Promise<OwnerClaim[]> {
      const processes = await view.list()
      const byPid = new Map(processes.map((row) => [row.pid, row]))
      const isHermes = engineProcess('hermes')
      const active = await activeProfile(root)
      const homes = await hermesHomes(root, active)
      // A plain `hermes` runs in the sticky profile: ask its store first.
      const sticky = active ? homes.find((home) => home.profile === active) ?? homeOf(root, active) : null
      const plain = sticky ? [sticky, ...homes.filter((home) => home !== sticky)] : homes
      const claims = new Map<string, OwnerClaim>()
      // Served to another client (the desktop app, a dashboard's terminal): never stopped from here.
      const served = (owner: RunningProcess): boolean => ancestry(byPid, owner.pid, 4)
        .some((row) => isHermes(row) && SERVERS.has(argvSubcommand(row.args, SUBCOMMAND_FLAGS)))
      const claim = async (candidates: readonly HermesHome[], sessionId: string, owner: RunningProcess, fromArgs: boolean): Promise<void> => {
        let at = { dbPath: candidates[0].dbPath, sessionId }
        for (const home of candidates) {
          if (!await found(read, home.dbPath, 'SELECT id FROM sessions WHERE id = ?', [sessionId])) continue
          // Compression moves a running conversation to a new id: the tip is the one listed.
          at = { dbPath: home.dbPath, sessionId: await compressionTip(read, home.dbPath, sessionId) }
          break
        }
        if (claims.has(at.sessionId)) return
        claims.set(at.sessionId, {
          sessionId: at.sessionId, pid: owner.pid, record: ownerRecord(at.dbPath, at.sessionId),
          ...(served(owner) ? { app: true } : {}),
          ...(fromArgs ? { fromArgs: true } : {}),
        })
      }
      // A lease is exact, so it is read first and wins over the same session named in arguments.
      for (const home of homes) {
        for (const lease of await hermesLeases(home.home)) {
          if (!view.alive(lease.pid) || !leaseHeldBy(lease, byPid.get(lease.pid))) continue
          // The lease's pid is the REPL itself, or a terminal UI's gateway two levels under its
          // `hermes` (hermes → node UI → python gateway). A pid that is neither was reused.
          const owner = ancestry(byPid, lease.pid, 2).find(isHermes)
          if (owner) await claim([home], lease.sessionId, owner, false)
        }
      }
      // The id a process was started on: it may have moved to another conversation since (`/resume`).
      for (const row of processes) {
        if (!isHermes(row)) continue
        const sessionId = resumeSessionId('hermes', row.args)
        if (!sessionId) continue
        const profile = argvProfile(row.args)
        await claim(profile ? [homeOf(root, profile === 'default' ? null : profile)] : plain, sessionId, row, true)
      }
      return [...claims.values()]
    },
    async busy(owner): Promise<boolean | null> {
      const at = parseOwnerRecord(owner.record)
      if (!at) return null
      const locks = await read(at.dbPath, "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'compression_locks'")
      if (!locks.ok) return null
      if (locks.rows.length) {
        // Compressing: the conversation is being rewritten under a new id right now.
        const held = await read(at.dbPath, 'SELECT 1 AS held FROM compression_locks WHERE session_id = ? AND expires_at > ? LIMIT 1', [at.sessionId, now() / 1000])
        if (!held.ok) return null
        if (held.rows.length) return true
      }
      const tail = await read(at.dbPath, 'SELECT role, finish_reason FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT 1', [at.sessionId])
      return tail.ok ? hermesTurnOpen(tail.rows) : null
    },
  }
}
