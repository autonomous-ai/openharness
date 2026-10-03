/**
 * Cursor (`cursor-agent`, also `agent`): a chat is `<configDir>/chats/<md5(folder)>/<id>/`, holding its
 * `store.db` (SQLite, WAL) and `meta.json`, which says its title, when it last moved, the folder it
 * ran in, and whether it is a sub-agent's or still empty. What was said is a separate transcript
 * under the data folder: `<dataDir>/projects/<slug(folder)>/agent-transcripts/<id>/<id>.jsonl`.
 *
 * `--resume` looks for a chat only in the bucket of the folder it runs in, so a chat is offered with
 * a folder only when that folder's md5 is its bucket's name. Every chat in a bucket shares its folder,
 * so one chat that names it names it for all. The slug is lossy (`/a/b-c` and `/a/b/c` are both
 * `a-b-c`) and is never read as a folder; it only guides a walk whose every answer the md5 checks.
 *
 * No `store.db` means no chat Cursor can resume (the IDE's transcripts, a worker's runs elsewhere).
 * A `--print` run cannot be told from a person's chat: both are listed.
 *
 * A running Cursor holds its chat's `store.db` open for the life of the chat, so `lsof` names the
 * owner; `--resume <id>` in its arguments is the fallback. A chat inside Cursor's own tmux server
 * (`tmux -L cursor-agent`, its "persistent sessions") is stopped with `agent persist stop`, never by
 * a signal from here.
 */

import { createHash } from 'node:crypto'
import { readFile, realpath, stat } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { agentCommandOwnershipSnapshot } from '../../engineBin.js'
import { builtinSqlite } from '../../sqliteRead.js'
import { argvTokens, engineProcessMatch, resumeSessionId } from '../../tmux.js'
import { absoluteFolder, entries, fileStamp, parseLine, readJson, readTail, record, text, UUID } from './support.js'
import type { ExternalProvider, ExternalSession, OwnerClaim, ProcessView, RunningProcess, ScanContext } from './types.js'

/** The read-only SQLite a chat store is read with; `node:sqlite`'s `DatabaseSync` in production. */
export interface CursorDatabase {
  new (path: string | URL, options: { readOnly: boolean }): { prepare(sql: string): { get(): unknown }; close(): void }
}

export interface CursorOptions {
  configDir: string
  dataDir: string
  /** How a chat with no `meta.json` has its store read; null when this Node has no SQLite. Tests set it. */
  database?: CursorDatabase | null
}

/** A chat's own account of itself, from `meta.json` or, when that is missing, its store. */
export interface CursorMeta {
  title: string
  /** When the chat last moved (`updatedAtMs`); null when it does not say. */
  updatedAt: number | null
  hasConversation: boolean
  isSubagent: boolean
  cwd: string | null
}

export type CursorSkip = 'no-store' | 'unreadable' | 'subagent' | 'empty'

const BUCKET = /^[0-9a-f]{32}$/
/** Cursor's name for a chat nobody named. */
const DEFAULT_TITLE = 'New Agent'
const META_MAX_BYTES = 64 * 1024
const TAIL_BYTES = [256 * 1024, 4 * 1024 * 1024]
/** How many folders a walk for a lost folder may list before it gives up. */
const WALK_READS = 256

/** Cursor's project name for a folder: every run of other characters becomes one `-`, trimmed. */
export function cursorSlug(folder: string): string {
  return folder.replace(/[^a-zA-Z0-9]/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '')
}

/** A folder's bucket name: the md5 of its resolved path. */
export function cursorBucket(folder: string): string {
  return createHash('md5').update(resolve(folder)).digest('hex')
}

function cursorTitle(value: unknown): string {
  const title = text(value).trim()
  return title === DEFAULT_TITLE ? '' : title
}

/** `meta.json` as Cursor itself reads it: without a numeric `createdAtMs` it is not one. */
export function parseCursorMeta(value: unknown): CursorMeta | null {
  const row = record(value)
  if (!row || typeof row.createdAtMs !== 'number' || !Number.isFinite(row.createdAtMs)) return null
  const updated = row.updatedAtMs
  return {
    title: cursorTitle(row.title),
    updatedAt: typeof updated === 'number' && Number.isFinite(updated) && updated > 0 ? Math.floor(updated) : null,
    hasConversation: row.hasConversation === true,
    isSubagent: row.isSubagent === true,
    cwd: absoluteFolder(row.cwd),
  }
}

/**
 * A chat store's own metadata (`meta` row `0`, hex-encoded JSON), for a chat whose `meta.json` is
 * missing. Opening a WAL database creates its `-wal` and `-shm` files when they are not there, so a
 * store without them (its Cursor closed it cleanly, and the main file holds everything) is opened
 * immutable: nothing is written beside it. A store that cannot be opened throws; the next scan tries
 * again.
 */
export async function readStoreMeta(storePath: string, Database: CursorDatabase | null): Promise<CursorMeta | null> {
  if (!Database) return null
  const [wal, shm] = await Promise.all([fileStamp(`${storePath}-wal`), fileStamp(`${storePath}-shm`)])
  const url = pathToFileURL(storePath)
  url.search = 'immutable=1'
  const db = new Database(wal && shm ? storePath : url, { readOnly: true })
  let value: unknown
  try {
    value = record(db.prepare("SELECT value FROM meta WHERE key = '0' LIMIT 1").get())?.value
  } finally {
    db.close()
  }
  const hex = text(value)
  if (!hex || hex.length > META_MAX_BYTES * 2 || !/^(?:[0-9a-f]{2})+$/i.test(hex)) return null
  const meta = record(parseLine(Buffer.from(hex, 'hex').toString('utf8')))
  if (!meta || (text(meta.agentId) && meta.agentId !== basename(dirname(storePath)))) return null
  return {
    title: cursorTitle(meta.name),
    updatedAt: null,
    hasConversation: text(meta.latestRootBlobId).length > 0,
    isSubagent: meta.subagentInfo !== undefined && meta.subagentInfo !== null,
    cwd: null,
  }
}

/** The first answer [pick] gives, reading lines back from the end of [path]. */
async function fromEnd<T>(path: string, pick: (line: string) => T | null): Promise<T | null> {
  const size = (await stat(path).catch(() => null))?.size ?? 0
  for (const bytes of TAIL_BYTES) {
    const lines = (await readTail(path, bytes)).split('\n')
    // A window that starts mid-file starts mid-line.
    for (let i = lines.length - 1; i >= (size > bytes ? 1 : 0); i--) {
      const found = pick(lines[i])
      if (found !== null) return found
    }
    if (size <= bytes) break
  }
  return null
}

/**
 * Whether a chat's last turn is still running: a prompt after the last `turn_ended`. Cursor writes the
 * transcript at each checkpoint of the chat, so it trails the chat: a turn that just ended can read
 * as running (the safe way: Harness asks before stopping it), and a prompt just sent can read as
 * idle until its first checkpoint. Null when the end of the transcript says neither.
 */
export function cursorTurnOpen(path: string): Promise<boolean | null> {
  return fromEnd(path, (line) => {
    const row = record(parseLine(line))
    if (row?.type === 'turn_ended') return false
    return row?.role === 'user' ? true : null
  })
}

/** A transcript, and the project (the slug of a folder) it is filed under. */
interface Transcript { path: string; project: string }

/** Transcripts by chat id, for chats whose own folder's project holds none: every project, listed once. */
async function transcriptIndex(dataDir: string): Promise<Map<string, Transcript>> {
  const projects = join(dataDir, 'projects')
  const found = new Map<string, Transcript>()
  for (const project of await entries(projects)) {
    if (!project.isDirectory()) continue
    const dir = join(projects, project.name, 'agent-transcripts')
    for (const entry of await entries(dir)) {
      const flat = entry.name.replace(/\.jsonl$/, '')
      if (entry.isDirectory() && UUID.test(entry.name)) {
        found.set(entry.name, { path: join(dir, entry.name, `${entry.name}.jsonl`), project: project.name })
      } else if (entry.isFile() && flat !== entry.name && UUID.test(flat) && !found.has(flat)) {
        // The layout older builds wrote: `agent-transcripts/<id>.jsonl`.
        found.set(flat, { path: join(dir, entry.name), project: project.name })
      }
    }
  }
  return found
}

/** A chat's transcript: where its folder puts it, else wherever a project holds one by its id. */
async function transcriptOf(
  dataDir: string, sessionId: string, cwd: string | null, index: () => Promise<Map<string, Transcript>>,
): Promise<Transcript | null> {
  if (cwd) {
    const project = cursorSlug(cwd)
    const path = join(dataDir, 'projects', project, 'agent-transcripts', sessionId, `${sessionId}.jsonl`)
    if (await fileStamp(path)) return { path, project }
  }
  const elsewhere = (await index()).get(sessionId)
  return elsewhere && await fileStamp(elsewhere.path) ? elsewhere : null
}

/**
 * The folder whose bucket is [bucket] and whose slug is [slug], walked down to from `/` through real
 * folders whose slugs lead to it. The md5 decides: a slug alone never names a folder.
 */
async function walkToFolder(slug: string, bucket: string): Promise<string | null> {
  let reads = WALK_READS
  const walk = async (dir: string): Promise<string | null> => {
    const own = cursorSlug(dir)
    if (own === slug && cursorBucket(dir) === bucket) return dir
    if (own && own !== slug && !slug.startsWith(`${own}-`)) return null
    if (reads-- <= 0) return null
    for (const entry of await entries(dir)) {
      if (!entry.isDirectory()) continue
      const found = await walk(join(dir, entry.name))
      if (found) return found
    }
    return null
  }
  return walk('/')
}

interface Chat {
  sessionId: string
  meta: CursorMeta
  /** When it last moved: `updatedAtMs`, else the store's last write. */
  movedAt: number
}

type ChatRead = { kind: 'chat'; chat: Chat } | { kind: 'skip'; reason: CursorSkip }

/** One chat folder, classified. Its metadata is read again only when one of its files changed. */
export async function readChat(ctx: ScanContext, chatDir: string, Database: () => CursorDatabase | null): Promise<ChatRead> {
  const store = join(chatDir, 'store.db')
  const [db, wal, meta] = await Promise.all([fileStamp(store), fileStamp(`${store}-wal`), fileStamp(join(chatDir, 'meta.json'))])
  if (!db) return { kind: 'skip', reason: 'no-store' }
  let read: CursorMeta | null
  try {
    read = await ctx.memo(`cursor:${chatDir}`, `${meta?.stamp ?? '-'}|${db.stamp}|${wal?.stamp ?? '-'}`, async () => {
      // A `meta.json` Cursor is still writing is not JSON yet, and throws: nothing is remembered, and
      // the next scan reads it again. One that is not a sidecar is read past, as Cursor reads past it.
      const source = await readFile(join(chatDir, 'meta.json'), 'utf8').catch(() => null)
      return (source === null ? null : parseCursorMeta(JSON.parse(source))) ?? readStoreMeta(store, Database())
    })
  } catch {
    // Half-written, or a store that could not be opened: read again next scan.
    read = null
  }
  if (!read) return { kind: 'skip', reason: 'unreadable' }
  if (read.isSubagent) return { kind: 'skip', reason: 'subagent' }
  if (!read.hasConversation) return { kind: 'skip', reason: 'empty' }
  return { kind: 'chat', chat: { sessionId: basename(chatDir), meta: read, movedAt: read.updatedAt ?? Math.max(db.mtime, wal?.mtime ?? 0) } }
}

/** Whether [row] runs inside Cursor's own tmux server (`tmux -L cursor-agent`), a few parents up. */
function persistent(row: RunningProcess, byPid: ReadonlyMap<number, RunningProcess>): boolean {
  let parent = byPid.get(row.ppid)
  for (let depth = 0; parent && depth < 4; depth++) {
    const tokens = argvTokens(parent.args)
    const tmux = basename(parent.executable) === 'tmux' || basename(tokens[0] ?? '') === 'tmux'
    if (tmux && tokens.some((token, i) => /^-Lcursor/.test(token) || (token === '-L' && /^cursor/.test(tokens[i + 1] ?? '')))) return true
    parent = byPid.get(parent.ppid)
  }
  return false
}

export function cursorProvider(options: CursorOptions): ExternalProvider {
  const chatsRoot = join(options.configDir, 'chats')
  let database: CursorDatabase | null | undefined = options.database
  const Database = (): CursorDatabase | null => (database === undefined ? (database = builtinSqlite() as unknown as CursorDatabase | null) : database)

  /** The store of chat [sessionId], in whichever bucket holds it. */
  async function storeOf(sessionId: string): Promise<string | null> {
    for (const bucket of await entries(chatsRoot)) {
      const path = join(chatsRoot, bucket.name, sessionId, 'store.db')
      if (bucket.isDirectory() && BUCKET.test(bucket.name) && await fileStamp(path)) return path
    }
    return null
  }

  return {
    engine: 'cursor',
    async scan(ctx: ScanContext): Promise<ExternalSession[]> {
      let listed: Promise<Map<string, Transcript>> | null = null
      const index = () => (listed ??= transcriptIndex(options.dataDir))
      const found: ExternalSession[] = []
      for (const bucket of await entries(chatsRoot)) {
        if (!bucket.isDirectory() || !BUCKET.test(bucket.name)) continue
        const bucketDir = join(chatsRoot, bucket.name)
        const chats: Chat[] = []
        for (const entry of await entries(bucketDir)) {
          if (!entry.isDirectory() || !UUID.test(entry.name)) continue
          const read = await readChat(ctx, join(bucketDir, entry.name), Database)
          await ctx.pace()
          if (read.kind === 'chat') chats.push(read.chat)
        }
        if (!chats.length) continue
        // A chat that names a folder whose md5 is the bucket names it for every chat there.
        const named = chats.map((chat) => chat.meta.cwd).find((cwd) => cwd && cursorBucket(cwd) === bucket.name)
        const cwd = named ? resolve(named) : await ctx.memo(`cursor:folder:${bucketDir}`, chats.map((chat) => chat.sessionId).sort().join(','), async () => {
          // None does (chats older than their `cwd`): the project a transcript is filed under guides a walk.
          const tried = new Set<string>()
          for (const chat of chats) {
            const project = (await transcriptOf(options.dataDir, chat.sessionId, null, index))?.project
            if (!project || tried.has(project)) continue
            tried.add(project)
            const folder = await walkToFolder(project, bucket.name)
            if (folder) return folder
          }
          return null
        })
        if (!cwd || ctx.excluded(cwd)) continue
        for (const chat of chats) {
          found.push({
            sessionId: chat.sessionId, engine: 'cursor', cwd, origin: 'terminal', title: chat.meta.title, mtime: chat.movedAt,
            transcriptPath: (await transcriptOf(options.dataDir, chat.sessionId, cwd, index))?.path ?? null,
          })
        }
      }
      return found
    },
    async owners(view: ProcessView): Promise<OwnerClaim[]> {
      const rows = await view.list()
      const ownership = agentCommandOwnershipSnapshot()
      const cursor = rows.filter((row) => engineProcessMatch(row, 'cursor', ownership).score > 0 && view.alive(row.pid))
      if (!cursor.length) return []
      const byPid = new Map(rows.map((row) => [row.pid, row]))
      const roots = new Set([chatsRoot, join(await realpath(options.configDir).catch(() => options.configDir), 'chats')])
      const files = await view.openFiles(cursor.map((row) => row.pid))
      const claims: OwnerClaim[] = []
      for (const row of cursor) {
        const app = persistent(row, byPid) ? { app: true } : {}
        const held = new Set<string>()
        for (const path of files.get(row.pid) ?? []) {
          const store = path.replace(/-(?:wal|shm)$/, '')
          const chatDir = dirname(store)
          const sessionId = basename(chatDir)
          if (basename(store) !== 'store.db' || !UUID.test(sessionId) || !BUCKET.test(basename(dirname(chatDir)))) continue
          if (!roots.has(dirname(dirname(chatDir))) || held.has(sessionId)) continue
          held.add(sessionId)
          claims.push({ sessionId, pid: row.pid, record: store, ...app })
        }
        if (held.size) continue
        // No chat store open (yet, or `lsof` could not say): the chat its arguments name.
        const resumed = resumeSessionId('cursor', row.args)
        // A guess: an in-app `/resume` leaves the arguments naming the first chat. Never stopped on it.
        if (resumed && UUID.test(resumed)) claims.push({ sessionId: resumed, pid: row.pid, record: await storeOf(resumed) ?? '', fromArgs: true, ...app })
      }
      return claims
    },
    async busy(owner): Promise<boolean | null> {
      if (!owner.record) return null
      const chatDir = dirname(owner.record)
      const meta = parseCursorMeta(await readJson(join(chatDir, 'meta.json')))
      const cwd = meta?.cwd && cursorBucket(meta.cwd) === basename(dirname(chatDir)) ? meta.cwd : null
      const transcript = await transcriptOf(options.dataDir, basename(chatDir), cwd, () => transcriptIndex(options.dataDir))
      return transcript ? cursorTurnOpen(transcript.path) : null
    },
  }
}

