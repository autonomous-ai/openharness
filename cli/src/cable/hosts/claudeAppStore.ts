/**
 * The Claude app's Code sessions, read from the app's own store (docs/plans/2026-11-19-dial-claude-app-sessions-design.md):
 * `claude-code-sessions/<account>/<org>/local_<uuid>.json`, one file per session whether its process runs or not. Of a
 * file only six fields are read (`sessionId`, `cliSessionId`, `cwd`, `isArchived`, `lastActivityAt`, `title`): the rest
 * holds the session's messages, which the dial never reads.
 *
 * The store is the app's, written while it runs, so nothing here writes it: no file is made, changed or locked, and
 * the app sees no reader. A file caught mid-write, too large, a link, or with a field of the wrong form is skipped and
 * counted, and read again at its next change; one whose read failed is skipped and counted, and read again at the next
 * read.
 *
 * A working turn writes its file several times a second and a person can have hundreds of sessions, so each file's
 * size and mtime are held and only a new or changed file is parsed, and a read walks the files newest first and stops
 * once no file left can be among the 16 listed. Every list is bounded, and what a bound cuts is counted.
 *
 * Nothing here logs: the source (claudeAppSource.ts) says the counts, in log lines of fixed words. No call rejects.
 */
import { constants, type Stats } from 'node:fs'
import { lstat, open, readdir, type FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import { CLAUDE_SESSION } from './claudeApp.js'
import { MAX_CWD } from './herdrSource.js'
import { observedTitle } from './observedTitle.js'

export const MAX_ACCOUNTS = 8
export const MAX_ORGS = 8
export const MAX_FILES = 1_024
export const MAX_LISTED = 16
export const MAX_PARSES = 256
export const MAX_FILE_BYTES = 1024 * 1024

/** Claude Code's own form of a session id, as vscode.ts checks one. */
const CLI_SESSION = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** One Code session, as its store file says it. Nothing else of the file is kept. */
export interface ClaudeAppSession {
  /** The app's id: the file's name without `.json`, and its `sessionId`. */
  localId: string
  /** Claude Code's id of the session: `cliSessionId`. */
  sessionId: string
  cwd: string
  /** `title` after the title rule (at most 64 characters), so a held session stays small whatever the app wrote. */
  title?: string
  /** The store's, when a finite number; else the file's mtime (ms). A read hands out its sort time, never past the
   *  mtime: a time in the future would pin the session first. */
  lastActivityAt: number
}
/** The folders read, each an absolute path of a real folder, in name order. */
export interface StoreFolders { accounts: readonly string[]; orgs: readonly string[] }
export interface StoreRead { sessions: ClaudeAppSession[]; parsed: number; skipped: number; over: number; more: boolean }

/** What a file gave when it was parsed. */
type Gave = ClaudeAppSession | 'archived' | 'unusable'

/** A `local_….json` name held, as its last `lstat` saw it, and what it gave when parsed at that size and mtime. */
interface Held {
  name: string
  path: string
  size: number
  mtime: number
  /** False for a link or a folder: it is never opened. */
  regular: boolean
  parsed?: { size: number; mtime: number; gave: Gave }
}

/** An org folder read: the names held, and how many its bound left out. */
interface Org {
  files: Map<string, Held>
  over: number
}

/** A session a walk counted, the file it came from, and its sort time. */
interface Kept {
  session: ClaudeAppSession
  name: string
  time: number
}

const byName = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

/** The app's id of the session a file name holds: the name without `.json`, in the form the app's link checks. */
export function localIdOf(name: string): string | undefined {
  const id = name.endsWith('.json') ? name.slice(0, -'.json'.length) : ''
  return CLAUDE_SESSION.test(id) ? id : undefined
}

async function lstatOf(path: string): Promise<Stats | undefined> {
  try {
    return await lstat(path)
  } catch {
    return undefined
  }
}

/** The real folders in a folder, in name order: the first `max`, and how many more. */
async function foldersIn(folder: string, max: number): Promise<{ taken: string[]; over: number }> {
  let names: string[] = []
  try {
    // A dirent's type is the entry's own, as lstat gives it: a link to a folder is no folder.
    names = (await readdir(folder, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort(byName)
  } catch {
    // Gone since its parent was read: no folders.
  }
  return { taken: names.slice(0, max).map((name) => join(folder, name)), over: Math.max(0, names.length - max) }
}

/** A name's new stat, keeping what it gave when last parsed: the walk compares the two. */
function hold(path: string, name: string, stats: Stats, before: Held | undefined): Held {
  return { name, path, size: stats.size, mtime: stats.mtimeMs, regular: stats.isFile(), parsed: before?.parsed }
}

/** What a file gave, while its size and mtime are still those it was parsed at. */
function current(file: Held): Gave | undefined {
  const { parsed } = file
  return parsed && parsed.size === file.size && parsed.mtime === file.mtime ? parsed.gave : undefined
}

/** No file's session is newer than the file's mtime, whatever the app wrote in it. */
const sortTime = (session: ClaudeAppSession, mtime: number): number => Math.min(session.lastActivityAt, mtime)

/** A file's place in a walk: its session's sort time once parsed at its present size and mtime, else its mtime. */
function placeOf(file: Held): number {
  const gave = current(file)
  return typeof gave === 'object' ? sortTime(gave, file.mtime) : file.mtime
}

/** The newest sort times, at most as many as are listed. */
const newest = (times: number[]): number[] => times.sort((a, b) => b - a).slice(0, MAX_LISTED)

/** A file's text, or none for a file refused: a link is never followed, a FIFO never waited on, and no more than 1 MiB +
 *  1 byte read. A read that fails (no access, too many open files, an I/O error) rejects: it says nothing of the file,
 *  so the caller tries it again. */
async function textOf(path: string): Promise<string | undefined> {
  let handle: FileHandle
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  } catch (error) {
    // O_NOFOLLOW's refusal of a link.
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') return undefined
    throw error
  }
  try {
    // What was opened is checked again: the name can have been swapped since its lstat.
    const stats = await handle.stat()
    if (!stats.isFile() || stats.size > MAX_FILE_BYTES) return undefined
    // One byte past its size tells a file that grew since its stat.
    const buffer = Buffer.alloc(stats.size + 1)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    return bytesRead > stats.size ? undefined : buffer.toString('utf8', 0, bytesRead)
  } finally {
    await handle.close()
  }
}

/** The six fields, checked in this order: whose file it is, whether it is archived (then no other field matters, so an
 *  archived session is never counted skipped), then the session's id and folder. A title or time of the wrong type
 *  skips nothing. */
function sessionOf(file: Held, text: string | undefined): Gave {
  let value: unknown
  try {
    value = JSON.parse(text ?? '')
  } catch {
    // Unreadable, or caught while the app rewrites it.
    return 'unusable'
  }
  if (!value || typeof value !== 'object') return 'unusable'
  const { sessionId, cliSessionId, cwd, isArchived, lastActivityAt, title } = value as Record<string, unknown>
  const localId = file.name.slice(0, -'.json'.length)
  if (sessionId !== localId) return 'unusable'
  if (isArchived !== undefined && typeof isArchived !== 'boolean') return 'unusable'
  if (isArchived) return 'archived'
  if (typeof cliSessionId !== 'string' || !CLI_SESSION.test(cliSessionId)) return 'unusable'
  if (typeof cwd !== 'string' || cwd === '' || cwd.length > MAX_CWD) return 'unusable'
  const shown = observedTitle(title)
  return {
    localId,
    sessionId: cliSessionId,
    cwd,
    ...(shown !== undefined && { title: shown }),
    lastActivityAt: typeof lastActivityAt === 'number' && Number.isFinite(lastActivityAt) ? lastActivityAt : file.mtime,
  }
}

export class ClaudeAppStore {
  private orgs = new Map<string, Org>()
  private overFolders = 0

  constructor(private readonly root: string) {}

  /** Lists the account folders and each one's org folders again. None when the root is no real folder: every file is
   *  forgotten. */
  async folders(): Promise<StoreFolders | undefined> {
    if (!(await lstatOf(this.root))?.isDirectory()) {
      this.forget()
      return undefined
    }
    const accounts = await foldersIn(this.root, MAX_ACCOUNTS)
    let over = accounts.over
    const orgs: string[] = []
    for (const account of accounts.taken) {
      const found = await foldersIn(account, MAX_ORGS)
      orgs.push(...found.taken)
      over += found.over
    }
    // Built on the map as it is after the reads, so what a forget() dropped meanwhile is not brought back. A folder
    // that left takes its files with it.
    const held = this.orgs
    this.orgs = new Map(orgs.map((org) => [org, held.get(org) ?? { files: new Map(), over: 0 }]))
    this.overFolders = over
    return { accounts: accounts.taken, orgs }
  }

  /** In each org folder read: the `local_….json` names, each `lstat`ed. No file is opened. */
  async files(): Promise<void> {
    for (const [folder, org] of this.orgs) {
      let names: string[] = []
      try {
        names = (await readdir(folder)).filter((name) => localIdOf(name) !== undefined).sort(byName)
      } catch {
        // Gone since it was listed: its names go with it.
      }
      const files = new Map<string, Held>()
      for (const name of names.slice(0, MAX_FILES)) {
        const path = join(folder, name)
        const stats = await lstatOf(path)
        if (stats) files.set(name, hold(path, name, stats, org.files.get(name)))
      }
      org.files = files
      org.over = Math.max(0, names.length - MAX_FILES)
    }
  }

  /** One file's `lstat` alone; gone, it is forgotten. A name outside the form, or an org folder not read, does
   *  nothing. */
  async touch(folder: string, name: string): Promise<void> {
    const org = this.orgs.get(folder)
    if (!org || localIdOf(name) === undefined) return
    const path = join(folder, name)
    const stats = await lstatOf(path)
    if (!stats) {
      org.files.delete(name)
      return
    }
    const before = org.files.get(name)
    // Past its bound, a folder's new name waits for the next listing of the folders, which counts it.
    if (!before && org.files.size >= MAX_FILES) return
    org.files.set(name, hold(path, name, stats, before))
  }

  /** The walk: the sessions to list, newest sort time first, at most 16. */
  async read(): Promise<StoreRead> {
    // The order is fixed at the start: newest place first, ties by name.
    const order = [...this.orgs.values()].flatMap((org) => [...org.files.values()])
      .map((file) => ({ file, place: placeOf(file) }))
      .sort((a, b) => b.place - a.place || byName(a.file.name, b.file.name))
    // By Claude Code's id: the app can hold two files of one session.
    const kept = new Map<string, Kept>()
    let top: number[] = []
    let parsed = 0
    let skipped = 0
    let cut = 0
    for (const [index, { file, place }] of order.entries()) {
      // Every file left has a place no newer than this one's, and its session sorts no newer than its place.
      if (top.length === MAX_LISTED && place < top[MAX_LISTED - 1]!) break
      let gave = file.regular ? current(file) : 'unusable'
      if (gave === undefined) {
        if (parsed === MAX_PARSES) {
          cut = order.length - index
          break
        }
        parsed++
        let text: string | undefined
        try {
          text = await textOf(file.path)
        } catch {
          // Not held: a failed read is tried again at the next read, within its bound of parses.
          skipped++
          continue
        }
        gave = sessionOf(file, text)
        file.parsed = { size: file.size, mtime: file.mtime, gave }
      }
      if (gave === 'archived') continue
      if (gave === 'unusable') {
        skipped++
        continue
      }
      const time = sortTime(gave, file.mtime)
      const other = kept.get(gave.sessionId)
      if (!other) {
        kept.set(gave.sessionId, { session: gave, name: file.name, time })
        top = newest([...top, time])
        continue
      }
      // Two files of one session: the newest sort time is kept, then the newest activity, the other counted. Sort time
      // first: a copy whose activity is newer but whose mtime is older can lie past where the walk stops, so choosing
      // it would depend on how many other sessions there are.
      skipped++
      if (other.time > time || (other.time === time && other.session.lastActivityAt >= gave.lastActivityAt)) continue
      kept.set(gave.sessionId, { session: gave, name: file.name, time })
      top = newest([...kept.values()].map((one) => one.time))
    }
    const sessions = [...kept.values()]
      .sort((a, b) => b.time - a.time || byName(a.name, b.name)).slice(0, MAX_LISTED)
      .map((one) => ({ ...one.session, lastActivityAt: one.time }))
    const over = this.overFolders + [...this.orgs.values()].reduce((sum, org) => sum + org.over, 0) + cut
    return { sessions, parsed, skipped, over, more: cut > 0 }
  }

  /** Drops everything held. */
  forget(): void {
    this.orgs = new Map()
    this.overFolders = 0
  }
}
