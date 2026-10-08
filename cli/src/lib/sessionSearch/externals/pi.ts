/**
 * Pi: `<agentDir>/sessions/--<folder>--/<time>_<id>.jsonl`, or one flat folder when the person moved
 * them (`PI_CODING_AGENT_SESSION_DIR`, else `sessionDir` in `<agentDir>/settings.json`; Pi then
 * reads no other). The first entry is the header, `{type:'session', id, cwd}`, and it is the only
 * authority for either: the folder name is lossy (`/a/b-c` and `/a-b/c` share one) and an id can be
 * the person's own (`--session-id`). Pi writes a file only once the first reply lands. Print, JSON
 * and RPC runs are saved the same way and cannot be told apart; Pi's own picker lists them, and so
 * does this.
 *
 * A session's name is the latest `session_info` entry anywhere in the file (an empty one clears it),
 * read incrementally: only what a scan has not seen yet. Its time is Pi's own: the newest user or
 * assistant message.
 *
 * Pi keeps no descriptor open and writes no process record, and it renames its process to `pi`,
 * which erases its arguments from `ps`: only an argv that still names the session says which process
 * has it. The last message says whether a turn is running.
 */

import { stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

import type { AgentCommandOwnershipSnapshot } from '../../engineBin.js'
import { engineProcessMatch, resumeSessionId } from '../../tmux.js'
import { forEachLine } from '../../transcriptReader.js'
import { absoluteFolder, entries, fileStamp, parseLine, readHead, readJson, readTail, record, text } from './support.js'
import { type ExternalProvider, type ExternalSession, type OwnerClaim, type ProcessView, type ScanContext, UNSETTLED } from './types.js'

/** How much of a file is read for its header first: headers are a few hundred bytes. */
const FIRST_BYTES = 16 * 1024
/** Pi's own bound on a header: a larger first entry is not a session. */
const HEAD_BYTES = 1024 * 1024
/** Enough of a header to see its version, which a migration rewrites. */
const LEAD_BYTES = 256
const TAIL_BYTES = 64 * 1024
/**
 * Pi's rule for an id (`--session-id` takes any such), kept to what Harness takes as one: 2 to 128
 * characters. One that ends `.jsonl` is read by `--session` as a file path, so it cannot be resumed.
 */
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,126}[A-Za-z0-9]$/

/**
 * A process row carries no file identity, so the PATH walk behind a full ownership snapshot could
 * not change a match: one empty snapshot serves every row.
 */
const NO_FILE_OWNERS: AgentCommandOwnershipSnapshot = {
  cursorFileKeys: new Set(), grokFileKeys: new Set(), conflictingFileKeys: new Set(),
  agentCandidates: [], cursorAgentCandidates: [], grokCandidates: [],
}

export interface PiHead { sessionId: string; cwd: string }

/**
 * A session file's id and folder, from its first entry. Blank and malformed lines before it are
 * skipped, as Pi skips them; any other first entry means the file is not a session.
 */
export async function readPiHead(path: string): Promise<PiHead | null | typeof UNSETTLED> {
  for (const bytes of [FIRST_BYTES, HEAD_BYTES]) {
    const head = await readHead(path, bytes)
    // The last piece has no newline: an entry still being written, or one cut by the read.
    for (const line of head.split('\n').slice(0, -1)) {
      if (!line.trim()) continue
      const value = parseLine(line)
      if (value === null) continue
      const row = record(value)
      if (row?.type !== 'session') return null
      const id = text(row.id)
      const cwd = absoluteFolder(row.cwd)
      return SESSION_ID.test(id) && !id.endsWith('.jsonl') && cwd ? { sessionId: id, cwd: resolve(cwd) } : null
    }
    // The whole file, and no entry in it yet: its first one is still being written.
    if (Buffer.byteLength(head) < bytes) return UNSETTLED
  }
  return null
}

/** The folder Pi keeps a working directory's sessions in, named as Pi names it. */
export function piSessionFolder(cwd: string): string {
  return `--${cwd.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`
}

/** How far a title read got: where it stopped, the header's start then, and the name so far. */
export interface PiTitleRead { end: number; lead: string; title: string }

/**
 * A session's name: the latest `session_info` entry, '' when there is none or it was cleared. Reads on
 * from [prior] when the file only grew; one that shrank or was rewritten (a migration changes its
 * header) is read again from the start. Only lines that name `session_info` are parsed.
 */
export async function readPiTitle(path: string, prior?: PiTitleRead): Promise<PiTitleRead> {
  const [start, info] = await Promise.all([readHead(path, LEAD_BYTES), stat(path).catch(() => null)])
  const lead = start.split('\n')[0]
  const from = prior && info && prior.lead === lead && info.size >= prior.end ? prior : { end: 0, lead, title: '' }
  let title = from.title
  const read = await forEachLine(path, from.end, ({ text: line }) => {
    const row = record(parseLine(line))
    if (row?.type === 'session_info') title = text(row.name).trim()
  }, { skip: (head) => !head.includes('"session_info"') }).catch(() => null)
  // Unreadable now (gone, or being replaced): nothing is carried over, and the next change reads it whole.
  return read ? { end: read.end, lead, title } : { end: 0, lead: '', title: '' }
}

/** A file's last complete lines, newest first: the first piece is dropped when the read began mid-line. */
function tailLines(tail: string, bytes: number): string[] {
  const lines = tail.split('\n')
  return (Buffer.byteLength(tail) < bytes ? lines : lines.slice(1)).reverse()
}

/** One `message` entry near a file's end, or null for any other line. */
function messageOf(line: string): { row: Record<string, unknown>; message: Record<string, unknown> } | null {
  if (!line.includes('"message"')) return null
  const row = record(parseLine(line))
  const message = record(row?.message)
  return row?.type === 'message' && message ? { row, message } : null
}

/**
 * When the conversation last moved, as Pi's own picker measures it: its newest user or assistant
 * message (the message's own time, else its entry's). Null when none is near the end.
 */
export async function piActivity(path: string): Promise<number | null> {
  let latest: number | null = null
  for (const line of tailLines(await readTail(path, TAIL_BYTES), TAIL_BYTES)) {
    const found = messageOf(line)
    if (!found || (found.message.role !== 'user' && found.message.role !== 'assistant')) continue
    const at = typeof found.message.timestamp === 'number' ? found.message.timestamp : Date.parse(text(found.row.timestamp))
    if (at > 0 && (latest === null || at > latest)) latest = at
  }
  return latest
}

/**
 * Whether a session's turn is running, from its last message: a person's message or a tool's result
 * means the agent is on it, an assistant message is mid-turn only while it calls tools. Null when
 * the file cannot say (no message near its end, or none at all).
 */
export async function piTurnOpen(path: string): Promise<boolean | null> {
  if (!path) return null
  for (const bytes of [256 * 1024, 4 * 1024 * 1024]) {
    const tail = await readTail(path, bytes)
    for (const line of tailLines(tail, bytes)) {
      const message = messageOf(line)?.message
      if (message?.role === 'user' || message?.role === 'toolResult') return true
      if (message?.role === 'assistant') return text(message.stopReason) ? message.stopReason === 'toolUse' : null
    }
    // The whole file was read: a larger look finds nothing more.
    if (Buffer.byteLength(tail) < bytes) break
  }
  return null
}

export interface PiOptions {
  agentDir: string
  /** `PI_CODING_AGENT_SESSION_DIR`, which outranks the settings file. */
  sessionDir?: string
  /** The folder a `~` stands for; tests replace it. */
  home?: string
}

interface PiLayout { dir: string; flat: boolean }

/** A moved sessions folder as Pi reads it: `~`, `~/…` or absolute. A relative one depends on where
 *  Pi was started, so no one folder holds its sessions. */
function movedFolder(value: string, home: string): string | null {
  if (value === '~') return home
  if (value.startsWith('~/')) return join(home, value.slice(2))
  return isAbsolute(value) ? value : null
}

/** Where Pi keeps its sessions: the env's folder, else the settings file's, else its own per-folder tree. */
async function piLayout(options: PiOptions, ctx: ScanContext): Promise<PiLayout | null> {
  let moved = options.sessionDir ?? ''
  if (!moved) {
    const path = join(options.agentDir, 'settings.json')
    const stamp = await fileStamp(path)
    const settings = stamp ? record(await ctx.memo(`pi:settings:${path}`, stamp.stamp, () => readJson(path))) : null
    moved = text(settings?.sessionDir)
  }
  if (!moved) return { dir: join(options.agentDir, 'sessions'), flat: false }
  const dir = movedFolder(moved, options.home ?? homedir())
  return dir ? { dir, flat: true } : null
}

/** Every `.jsonl` Pi would list, with the folder it is in (null in a flat one). Pi follows linked folders. */
async function piFiles(layout: PiLayout): Promise<Array<{ path: string; folder: string | null }>> {
  const out: Array<{ path: string; folder: string | null }> = []
  const add = async (dir: string, folder: string | null): Promise<void> => {
    for (const file of await entries(dir)) if (file.name.endsWith('.jsonl')) out.push({ path: join(dir, file.name), folder })
  }
  if (layout.flat) {
    await add(layout.dir, null)
    return out
  }
  for (const folder of await entries(layout.dir)) {
    if (folder.isDirectory() || folder.isSymbolicLink()) await add(join(layout.dir, folder.name), folder.name)
  }
  return out
}

/** The session each running Pi names on its command line (`--session <id>`, `--session-id <id>`). */
async function argvClaims(view: ProcessView, recordOf: (sessionId: string) => string): Promise<OwnerClaim[]> {
  const claims: OwnerClaim[] = []
  for (const row of await view.list()) {
    if (!engineProcessMatch(row, 'pi', NO_FILE_OWNERS).score) continue
    const sessionId = resumeSessionId('pi', row.args)
    // Only the arguments say so, and Pi can move to another session inside: never stopped on this.
    if (sessionId) claims.push({ sessionId, pid: row.pid, record: recordOf(sessionId), fromArgs: true })
  }
  return claims
}

export function piProvider(options: PiOptions): ExternalProvider {
  /** Each id's transcript, from the last scan: what `busy` reads. The newest file of an id wins. */
  let transcripts = new Map<string, string>()
  const titles = new Map<string, PiTitleRead>()
  return {
    engine: 'pi',
    async scan(ctx: ScanContext): Promise<ExternalSession[]> {
      const layout = await piLayout(options, ctx)
      const found: ExternalSession[] = []
      for (const { path, folder } of layout ? await piFiles(layout) : []) {
        const stamp = await fileStamp(path)
        if (!stamp) continue
        // What the header says never changes (a migration rewrites only its version): read once it is whole.
        const head = await ctx.head(`pi:${path}`, stamp.stamp, () => readPiHead(path))
        await ctx.pace()
        // In Pi's own tree an id resumes only from the folder its header's folder names; from any
        // other, Pi asks whether to fork it instead.
        if (!head || (folder !== null && folder !== piSessionFolder(head.cwd)) || ctx.excluded(head.cwd)) continue
        const info = await ctx.memo(`pi:info:${path}`, stamp.stamp, async () => {
          const read = await readPiTitle(path, titles.get(path))
          titles.set(path, read)
          return { title: read.title, mtime: await piActivity(path) }
        })
        found.push({
          sessionId: head.sessionId, engine: 'pi', cwd: head.cwd, origin: 'terminal',
          title: info.title, mtime: info.mtime ?? stamp.mtime, transcriptPath: path,
        })
      }
      const listed = new Set(found.map((session) => session.transcriptPath))
      for (const path of titles.keys()) if (!listed.has(path)) titles.delete(path)
      transcripts = new Map([...found].sort((a, b) => a.mtime - b.mtime).map((session) => [session.sessionId, session.transcriptPath!]))
      return found
    },
    owners: (view: ProcessView) => argvClaims(view, (sessionId) => transcripts.get(sessionId) ?? ''),
    busy: (owner) => piTurnOpen(owner.record),
  }
}
