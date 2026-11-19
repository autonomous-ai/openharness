/**
 * The ChatGPT app's Codex threads in its sidebar's order, read from the metadata the app keeps in the Codex home: each
 * thread's id, source, folder and times from `state_5.sqlite` (table `threads`), and the sidebar's projects from
 * `.codex-global-state.json` (`project-order`, `thread-project-assignments`). Nothing else of either file is read, and
 * neither is ever written. A thread's name is Codex's own (`session_index.jsonl`) or its folder's, never the store's
 * title or first message (docs/plans/2026-11-19-dial-chatgpt-ring-and-follow-design.md, D4).
 *
 * Each read opens its own read-only connection and closes it before it ends: a handle kept open would hold the app's
 * `-wal` and `-shm` after the app quits. Nothing is logged here; the listing source says what a read cost, in counts.
 */
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, statSync, type Stats } from 'node:fs'
import { basename, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { codexThreadName } from '../../lib/sessionTitle.js'
import { builtinSqlite, idleWalStore, type DatabaseConstructor } from '../../lib/sqliteBuiltin.js'
import type { SqliteRow } from '../../lib/sqliteRead.js'
import { CODEX_THREAD } from './codexQueue.js'
import { observedTitle } from './observedTitle.js'

/** The threads a read lists: the newest, so a project with many threads cannot keep every Recent one off the dial. */
export const MAX_LISTED = 16
/** The rows a read takes, each given its sidebar place, so a running thread's hooked copy is placed too. */
export const MAX_ROWS = 200
/** The project ids kept of `project-order`. */
export const MAX_PROJECTS = 64
/** The largest JSON file read: the app's is about 135 KB. */
export const MAX_STATE_BYTES = 1_048_576
/** The longest folder a row may have. */
export const MAX_CWD = 4_096

const STORE = 'state_5.sqlite'
const STATE = '.codex-global-state.json'
/** The binding is synchronous on the devices event loop: a store the app holds locked fails fast, and is read next time. */
const BUSY_TIMEOUT_MS = 50
/** A person's own threads, a terminal's (`cli`) and the app's or an editor's (`vscode`), never a script's, a subagent's or
 *  a guardian review's; served by the store's own `idx_threads_recency_at_ms`. No value from outside goes in. */
const QUERY = 'SELECT id, source, cwd, recency_at_ms, updated_at_ms FROM threads WHERE archived = 0 AND source IN '
  + `('cli','vscode') ORDER BY recency_at_ms DESC LIMIT ${MAX_ROWS}`

export interface CodexAppThread {
  /** Checked against CODEX_THREAD: the Codex session id. */
  id: string
  cwd: string
  /** D4: Codex's own name for it, else its folder's. */
  name: string
  /** `recency_at_ms`, else `updated_at_ms`, else 0. */
  at: number
  /** Under a project of `project-order` (D6), else under Recent. */
  inProject: boolean
}

export type CodexAppRead =
  | { ok: true; order: readonly string[]; listed: readonly CodexAppThread[]; rows: number; skipped: number }
  | { ok: false }

/** For tests: the store's binding, and the one read of the JSON file's open descriptor. */
export interface CodexAppSeams {
  sqlite?: () => DatabaseConstructor | null
  readState?: (fd: number, max: number) => Buffer
}

/** What the JSON file said, kept under its stamp until it changes. */
interface Projects {
  stamp: string
  /** The place, in `project-order`, of each thread under a project. */
  places: ReadonlyMap<string, number>
  /** The threads it was parsed for. Null when it names no project: it places no thread, whichever comes. */
  ids: ReadonlySet<string> | null
}

interface Kept { id: string; cwd: string; at: number }

const noProjects = (stamp: string): Projects => ({ stamp, places: new Map(), ids: null })
const stampOf = (stats: Stats): string => `${stats.size}:${stats.mtimeMs}`
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
/** Codex declares `recency_at_ms NOT NULL DEFAULT 0` and a nullable `updated_at_ms`: 0 is no time, as NULL is. */
const time = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0)
/** Newest first; a tie by id, descending, as the store's own index orders it, so every read gives the same order. */
const newest = (a: Kept, b: Kept): number => b.at - a.at || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)

/** The file whole, up to `max` bytes: a read may return less than it was asked for, so it reads on to the end. */
function readWhole(fd: number, max: number): Buffer {
  const buffer = Buffer.alloc(max)
  let length = 0
  while (length < max) {
    const read = readSync(fd, buffer, length, max - length, length)
    if (read === 0) break
    length += read
  }
  return buffer.subarray(0, length)
}

/** The sidebar's projects in the file's text, kept only for `ids`. Anything not of the shape the app writes is no project. */
function parseProjects(bytes: Buffer, stamp: string, ids: readonly string[]): Projects {
  let state: unknown
  try { state = JSON.parse(bytes.toString('utf8')) } catch { return noProjects(stamp) }
  if (!isObject(state)) return noProjects(stamp)
  const order = state['project-order'], assignments = state['thread-project-assignments']
  if (!Array.isArray(order) || !isObject(assignments)) return noProjects(stamp)
  const projects = new Map<string, number>()
  for (const project of order) {
    if (projects.size === MAX_PROJECTS) break
    if (typeof project === 'string' && !projects.has(project)) projects.set(project, projects.size)
  }
  if (projects.size === 0) return noProjects(stamp)
  // D6: only a local project the sidebar orders holds a thread; any other entry leaves it under Recent.
  const places = new Map<string, number>()
  for (const id of ids) {
    const entry = assignments[id]
    if (!isObject(entry) || entry.projectKind !== 'local' || typeof entry.projectId !== 'string') continue
    const place = projects.get(entry.projectId)
    if (place !== undefined) places.set(id, place)
  }
  return { stamp, places, ids: new Set(ids) }
}

export class CodexAppThreads {
  private readonly sqlite: () => DatabaseConstructor | null
  private readonly readState: (fd: number, max: number) => Buffer
  private projects: Projects | undefined

  constructor(private readonly home: string, seams: CodexAppSeams = {}) {
    this.sqlite = seams.sqlite ?? builtinSqlite
    this.readState = seams.readState ?? readWhole
  }

  /** Whether the Codex home is a folder now. */
  there(): boolean {
    try { return statSync(this.home).isDirectory() } catch { return false }
  }

  /** The threads, or `{ ok: false }` when either file could not be read as it is now. Never throws. */
  async read(): Promise<CodexAppRead> {
    try {
      const rows = this.query()
      if (!rows) return { ok: false }
      const kept: Kept[] = []
      let skipped = 0
      for (const row of rows) {
        const { id, cwd } = row
        if (typeof id !== 'string' || !CODEX_THREAD.test(id) || typeof cwd !== 'string' || cwd === '' || cwd.length > MAX_CWD) {
          skipped++
          continue
        }
        kept.push({ id, cwd, at: time(row.recency_at_ms) || time(row.updated_at_ms) })
      }
      const projects = this.readProjects(kept.map((thread) => thread.id))
      if (!projects) return { ok: false }
      this.projects = projects
      const placeOf = (thread: Kept) => projects.places.get(thread.id) ?? MAX_PROJECTS
      const order = [...kept].sort((a, b) => placeOf(a) - placeOf(b) || newest(a, b))
      const listed = new Set([...kept].sort(newest).slice(0, MAX_LISTED).map((thread) => thread.id))
      return {
        ok: true,
        order: order.map((thread) => thread.id),
        listed: order.filter((thread) => listed.has(thread.id)).map(({ id, cwd, at }) => ({
          id, cwd, at,
          name: observedTitle(codexThreadName(id, this.home)) ?? (basename(cwd) || 'codex'),
          inProject: projects.places.has(id),
        })),
        rows: rows.length,
        skipped,
      }
    } catch {
      return { ok: false }
    }
  }

  /** Drops the JSON file's last parse, so the next read parses it afresh. */
  forget(): void {
    this.projects = undefined
  }

  private query(): readonly SqliteRow[] | null {
    const Database = this.sqlite()
    if (!Database) return null
    const path = join(this.home, STORE)
    try {
      // SQLite's own open of a FIFO waits for a writer for good: only a regular file is a store.
      if (!statSync(path).isFile()) return null
      // An idle WAL store opened read-only would get a -wal and -shm made beside it; immutable, it gets none.
      let location: string | URL = path
      if (idleWalStore(path)) {
        location = pathToFileURL(path)
        location.search = 'immutable=1'
      }
      const db = new Database(location, { readOnly: true })
      try {
        db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`)
        return db.prepare(QUERY).all()
      } finally {
        db.close()
      }
    } catch {
      return null
    }
  }

  /**
   * The sidebar's projects for `ids`, or null when the file changed while it was read (the app writing it): the last
   * parse is then kept as it was, so the projects do not flash to Recent and back. The file is parsed again only when
   * its size or mtime changed, or a thread comes that the last parse was not kept for. A file that held still and is
   * not the app's (missing, a link, too large, not JSON, of another shape) names no project until it next changes.
   */
  private readProjects(ids: readonly string[]): Projects | null {
    const path = join(this.home, STATE)
    let found: Stats
    try { found = lstatSync(path) } catch { return noProjects('none') }
    const last = this.projects, known = last?.ids
    if (last?.stamp === stampOf(found) && (!known || ids.every((id) => known.has(id)))) return last
    // A link, a FIFO or a folder is never opened, and no file this large is the app's.
    if (!found.isFile() || found.size > MAX_STATE_BYTES) return noProjects(stampOf(found))
    let fd: number
    try {
      fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    } catch {
      return noProjects(stampOf(found))
    }
    try {
      const opened = fstatSync(fd)
      if (!opened.isFile() || opened.size > MAX_STATE_BYTES) return noProjects(stampOf(opened))
      const bytes = this.readState(fd, MAX_STATE_BYTES + 1)
      const after = fstatSync(fd)
      let now: Stats
      try { now = lstatSync(path) } catch { return null }
      const stamp = stampOf(opened)
      // Appended to, or a new file renamed over it: what was read may be half of one write.
      if (stampOf(after) !== stamp || stampOf(now) !== stamp || now.ino !== opened.ino) return null
      return parseProjects(bytes, stamp, ids)
    } finally {
      closeSync(fd)
    }
  }
}
