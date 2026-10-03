/**
 * Command Code: `<home>/projects/<slug>/<id>.jsonl`, one file per session, written once its first
 * turn commits. The slug is lossy (case-folded, punctuation collapsed, camelCase split), so the
 * folder comes from the header alone: `{type:'session', version:3, id, timestamp, cwd}`, Pi's
 * envelope. Beside the transcript sit `<id>.meta.json` (its title, and `entrypoint: 'print'` for a
 * headless `cmd -p` run, which Command Code keeps out of its own picker and so is left out here),
 * `.prompts.jsonl`, `.checkpoints.jsonl`, `.share.json` and `.v2.bak`. A file from before the v3
 * format has no header and so no folder: it is left out until Command Code opens and rewrites it,
 * and read again then.
 * Read from command-code 1.66.0.
 *
 * Command Code holds no file open and writes no process record. Only an argv that names the session
 * (`--resume <id>`) says which process has it, and Command Code renames its process at start
 * (`command-code` in 1.66.0, `⌘ <title>` before), which replaces the arguments `ps` shows: a build or
 * launcher that leaves them is the only one found. Nothing on disk says a turn is running: a turn is
 * written when it commits, so a running one is not in the file yet.
 */

import { join } from 'node:path'

import type { AgentCommandOwnershipSnapshot } from '../../engineBin.js'
import { engineProcessMatch, resumeSessionId } from '../../tmux.js'
import { absoluteFolder, entries, fileStamp, parseLine, readHead, readJson, readTail, record, text } from './support.js'
import { type ExternalProvider, type ExternalSession, type OwnerClaim, type ProcessView, type ScanContext, UNSETTLED } from './types.js'

/** A header is a few hundred bytes: this much is read first, and never more than the bound. */
const FIRST_BYTES = 16 * 1024
const HEAD_BYTES = 256 * 1024
const TAIL_BYTES = 64 * 1024
/** A transcript's name. Its sidecars end `.jsonl` too, so the whole name is matched. */
const TRANSCRIPT = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i

/**
 * A process row carries no file identity, so the PATH walk behind a full ownership snapshot could
 * not change a match: one empty snapshot serves every row.
 */
const NO_FILE_OWNERS: AgentCommandOwnershipSnapshot = {
  cursorFileKeys: new Set(), grokFileKeys: new Set(), conflictingFileKeys: new Set(),
  agentCandidates: [], cursorAgentCandidates: [], grokCandidates: [],
}

export interface CommandCodeHead { sessionId: string; cwd: string }

/**
 * A transcript's folder, from its first line: Command Code's v3 header, naming the same id as the
 * file (Command Code resumes by the file's name). Any later format keeps the header's shape. A file
 * from before v3 cannot be judged yet: Command Code rewrites it in place, with a header, when it
 * next opens it.
 */
export async function readCommandCodeHead(path: string, fileId: string): Promise<CommandCodeHead | null | typeof UNSETTLED> {
  let line: string | undefined
  for (const bytes of [FIRST_BYTES, HEAD_BYTES]) {
    const head = await readHead(path, bytes)
    line = head.split('\n').slice(0, -1).find((piece) => piece.trim())
    if (line !== undefined) break
    // The whole file, and no line in it yet: its header is still being written.
    if (Buffer.byteLength(head) < bytes) return UNSETTLED
  }
  if (line === undefined) return null
  const row = record(parseLine(line))
  const version = row?.version
  if (row?.type !== 'session' || typeof version !== 'number' || version < 3) return UNSETTLED
  const cwd = absoluteFolder(row.cwd)
  return typeof row.timestamp === 'string' && row.id === fileId && cwd ? { sessionId: fileId, cwd } : null
}

export interface CommandCodeMeta { title: string; headless: boolean }

/** A session's title and whether a headless run made it, from `<id>.meta.json`; none when it is missing or torn. */
export async function readCommandCodeMeta(path: string): Promise<CommandCodeMeta> {
  const meta = record(await readJson(path))
  return { title: text(meta?.title).trim(), headless: meta?.entrypoint === 'print' }
}

/** When the conversation last moved, as Command Code measures it: its newest entry's time. */
export async function commandCodeActivity(path: string): Promise<number | null> {
  const tail = await readTail(path, TAIL_BYTES)
  const lines = tail.split('\n')
  let latest: number | null = null
  // The first piece is part of a line when the read began mid-file; the header's time is its birth.
  for (const line of Buffer.byteLength(tail) < TAIL_BYTES ? lines : lines.slice(1)) {
    const row = record(parseLine(line))
    const at = row && row.type !== 'session' ? Date.parse(text(row.timestamp)) : NaN
    if (at > 0 && (latest === null || at > latest)) latest = at
  }
  return latest
}

/** Every file named like a transcript, one folder a project. Command Code reads linked folders too. */
async function transcripts(dir: string): Promise<Array<{ path: string; id: string }>> {
  const out: Array<{ path: string; id: string }> = []
  for (const project of await entries(dir)) {
    if (!project.isDirectory() && !project.isSymbolicLink()) continue
    const folder = join(dir, project.name)
    for (const file of await entries(folder)) {
      const id = TRANSCRIPT.exec(file.name)?.[1]
      if (id) out.push({ path: join(folder, file.name), id })
    }
  }
  return out
}

export interface CommandcodeOptions { home: string }

export function commandcodeProvider(options: CommandcodeOptions): ExternalProvider {
  /** Each id's transcript, from the last scan: what an owner's record points at. */
  let known = new Map<string, string>()
  return {
    engine: 'commandcode',
    async scan(ctx: ScanContext): Promise<ExternalSession[]> {
      const found: ExternalSession[] = []
      for (const { path, id } of await transcripts(join(options.home, 'projects'))) {
        const stamp = await fileStamp(path)
        if (!stamp) continue
        // A v3 header never changes: read once, however the transcript grows.
        const head = await ctx.head(`commandcode:${path}`, stamp.stamp, () => readCommandCodeHead(path, id))
        await ctx.pace()
        if (!head || ctx.excluded(head.cwd)) continue
        const metaPath = path.replace(/\.jsonl$/, '.meta.json')
        const metaStamp = await fileStamp(metaPath)
        const meta = metaStamp
          ? await ctx.memo(`commandcode:meta:${metaPath}`, metaStamp.stamp, () => readCommandCodeMeta(metaPath))
          : { title: '', headless: false }
        if (meta.headless) continue
        const moved = await ctx.memo(`commandcode:time:${path}`, stamp.stamp, () => commandCodeActivity(path))
        found.push({
          sessionId: head.sessionId, engine: 'commandcode', cwd: head.cwd, origin: 'terminal',
          title: meta.title, mtime: moved ?? stamp.mtime, transcriptPath: path,
        })
      }
      known = new Map(found.map((session) => [session.sessionId, session.transcriptPath!]))
      return found
    },
    async owners(view: ProcessView): Promise<OwnerClaim[]> {
      const claims: OwnerClaim[] = []
      for (const row of await view.list()) {
        if (!engineProcessMatch(row, 'commandcode', NO_FILE_OWNERS).score) continue
        // `--resume <id>`, `-r <id>` or `--session <id>`: a title, a path or a prefix names no session exactly.
        const sessionId = resumeSessionId('commandcode', row.args)
        // Only the arguments say so, and a /resume inside moves on: never stopped on this.
        if (sessionId) claims.push({ sessionId, pid: row.pid, record: known.get(sessionId) ?? '', fromArgs: true })
      }
      return claims
    },
    // A turn reaches the file only once it commits: the file cannot say one is running.
    busy: async () => null,
  }
}
