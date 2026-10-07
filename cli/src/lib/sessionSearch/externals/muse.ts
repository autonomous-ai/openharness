/**
 * Muse: `<home>/sessions/YYYY/MM/DD/<id>/session.jsonl`, one append-only log per session. Nothing in
 * the path names the project: the first record, the session's metadata, carries `workspace_root`,
 * and its `stream.id` is the session's id, which must be the folder's. Sub-agents live one level
 * deeper (`<id>/subagent/<child>/`) and are never read.
 *
 * Every record names its stream: Muse mirrors its sub-agents' records (and a memory reminder's) into
 * the parent's log, so only the session's own stream counts. A session somebody talked to has
 * opened a run in it; Muse's own reminder sessions sit beside the person's with the same folder and
 * never do. Times are `recorded_at`, in microseconds.
 *
 * Muse's hooks never fire and how it locks a session is not known, so only an argv that names the
 * session (`muse resume <id>`) says which process has it. A run of its own that has started and not
 * ended means a turn is running.
 */

import { basename, dirname, join } from 'node:path'

import type { AgentCommandOwnershipSnapshot } from '../../engineBin.js'
import { engineProcessMatch, resumeSessionId } from '../../tmux.js'
import { forEachLine } from '../../transcriptReader.js'
import { absoluteFolder, entries, epochMs, fileStamp, parseLine, readHead, readTail, record, text, UUID } from './support.js'
import { type ExternalProvider, type ExternalSession, type OwnerClaim, type ProcessView, type ScanContext, UNSETTLED } from './types.js'

/** A log's first record is a few hundred bytes: this much is read first, and never more than the bound. */
const FIRST_BYTES = 16 * 1024
const HEAD_BYTES = 256 * 1024
const TAIL_BYTES = 64 * 1024
const DATE_PART = /^\d+$/

/**
 * A process row carries no file identity, so the PATH walk behind a full ownership snapshot could
 * not change a match: one empty snapshot serves every row.
 */
const NO_FILE_OWNERS: AgentCommandOwnershipSnapshot = {
  cursorFileKeys: new Set(), grokFileKeys: new Set(), conflictingFileKeys: new Set(),
  agentCandidates: [], cursorAgentCandidates: [], grokCandidates: [],
}

export interface MuseHead { sessionId: string; cwd: string }

/** A log's session and folder, from its first record: the metadata of the stream its folder names. */
export async function readMuseHead(path: string, folderId: string): Promise<MuseHead | null | typeof UNSETTLED> {
  let first: string | undefined
  for (const bytes of [FIRST_BYTES, HEAD_BYTES]) {
    const head = await readHead(path, bytes)
    const newline = head.indexOf('\n')
    if (newline >= 0) {
      first = head.slice(0, newline)
      break
    }
    // The whole log, and no complete record in it yet: the first is still being written.
    if (Buffer.byteLength(head) < bytes) return UNSETTLED
  }
  if (first === undefined) return null
  const row = record(parseLine(first))
  const payload = record(row?.payload)
  const cwd = absoluteFolder(record(payload?.record)?.workspace_root)
  if (record(row?.stream)?.id !== folderId || payload?.kind !== 'metadata' || !cwd) return null
  return { sessionId: folderId, cwd }
}

interface OwnRecord { run: boolean; kind: string; at: number | null }

/** One record of [sessionId]'s own stream (its run lifecycle, and when), or null for another stream's. */
function ownRecord(line: string, sessionId: string): OwnRecord | null {
  if (!line.includes(sessionId)) return null
  const row = record(parseLine(line))
  if (record(row?.stream)?.id !== sessionId) return null
  const payload = record(row?.payload)
  return { run: payload?.kind === 'run', kind: text(record(payload?.event)?.kind), at: epochMs(row?.recorded_at) }
}

/** Whether [sessionId] has opened a run of its own: somebody (or their schedule) has talked to it. */
export async function museOwnRun(path: string, sessionId: string): Promise<boolean> {
  let ran = false
  // Other streams' records are dropped unread, and so is everything once a run is found.
  await forEachLine(path, 0, ({ text: line }) => {
    const own = ownRecord(line, sessionId)
    if (own?.run && own.kind === 'started') ran = true
  }, { skip: (head) => ran || !head.includes(sessionId), shouldStop: () => ran }).catch(() => undefined)
  return ran
}

/** A log's last complete lines, newest first: the first piece is dropped when the read began mid-line. */
function tailLines(tail: string, bytes: number): string[] {
  const lines = tail.split('\n')
  return (Buffer.byteLength(tail) < bytes ? lines : lines.slice(1)).reverse()
}

/** When the session's own stream last moved: its newest record's `recorded_at`. */
export async function museActivity(path: string, sessionId: string): Promise<number | null> {
  for (const line of tailLines(await readTail(path, TAIL_BYTES), TAIL_BYTES)) {
    const at = ownRecord(line, sessionId)?.at
    if (at) return at
  }
  return null
}

/**
 * Whether the session's own run is still going: its last run `started` has no `terminal` after it.
 * Null when neither is near the end of the log.
 */
export async function museTurnOpen(path: string): Promise<boolean | null> {
  if (!path) return null
  const sessionId = basename(dirname(path))
  for (const bytes of [256 * 1024, 4 * 1024 * 1024]) {
    const tail = await readTail(path, bytes)
    for (const line of tailLines(tail, bytes)) {
      const own = ownRecord(line, sessionId)
      if (own?.run && own.kind === 'started') return true
      if (own?.run && own.kind === 'terminal') return false
    }
    // The whole log was read: a larger look finds nothing more.
    if (Buffer.byteLength(tail) < bytes) break
  }
  return null
}

/** Every log at exactly `YYYY/MM/DD/<id>/session.jsonl`: a sub-agent's, one level deeper, is not one. */
async function logs(dir: string): Promise<Array<{ path: string; id: string }>> {
  const out: Array<{ path: string; id: string }> = []
  const within = async (at: string, pattern: RegExp): Promise<string[]> =>
    (await entries(at)).filter((entry) => entry.isDirectory() && pattern.test(entry.name)).map((entry) => join(at, entry.name))
  for (const year of await within(dir, DATE_PART)) {
    for (const month of await within(year, DATE_PART)) {
      for (const day of await within(month, DATE_PART)) {
        for (const session of await within(day, UUID)) out.push({ path: join(session, 'session.jsonl'), id: basename(session) })
      }
    }
  }
  return out
}

export interface MuseOptions { home: string }

export function museProvider(options: MuseOptions): ExternalProvider {
  /** Each id's log, from the last scan: what `busy` reads. */
  let known = new Map<string, string>()
  /** Logs known to hold a run of their own. A run once written stays, so they are not read for it again. */
  const ran = new Set<string>()
  return {
    engine: 'muse',
    async scan(ctx: ScanContext): Promise<ExternalSession[]> {
      const found: ExternalSession[] = []
      for (const { path, id } of await logs(join(options.home, 'sessions'))) {
        const stamp = await fileStamp(path)
        if (!stamp) continue
        // The metadata record never changes: read once it is whole, however the log grows.
        const head = await ctx.head(`muse:${path}`, stamp.stamp, () => readMuseHead(path, id))
        await ctx.pace()
        if (!head || ctx.excluded(head.cwd)) continue
        const info = await ctx.memo(`muse:info:${path}`, stamp.stamp, async () => ({
          ran: ran.has(path) || await museOwnRun(path, id),
          mtime: await museActivity(path, id),
        }))
        if (!info.ran) continue
        ran.add(path)
        found.push({
          sessionId: head.sessionId, engine: 'muse', cwd: head.cwd, origin: 'terminal',
          title: '', mtime: info.mtime ?? stamp.mtime, transcriptPath: path,
        })
      }
      known = new Map(found.map((session) => [session.sessionId, session.transcriptPath!]))
      const listed = new Set(known.values())
      for (const path of ran) if (!listed.has(path)) ran.delete(path)
      return found
    },
    async owners(view: ProcessView): Promise<OwnerClaim[]> {
      const claims: OwnerClaim[] = []
      for (const row of await view.list()) {
        if (!engineProcessMatch(row, 'muse', NO_FILE_OWNERS).score) continue
        const sessionId = resumeSessionId('muse', row.args)
        // Only the arguments say so, and a /resume inside moves on: never stopped on this.
        if (sessionId) claims.push({ sessionId, pid: row.pid, record: known.get(sessionId) ?? '', fromArgs: true })
      }
      return claims
    },
    busy: (owner) => museTurnOpen(owner.record),
  }
}
