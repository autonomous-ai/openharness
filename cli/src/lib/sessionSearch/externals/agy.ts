import { externalReadFailed } from '../evidence.js'
/**
 * Antigravity (`agy`): `<home>/brain/<id>/.system_generated/logs/transcript_full.jsonl` is each
 * conversation's history, and `<home>/presence/<id>.lock` is made only for a top-level one (a
 * sub-agent gets a brain folder and no lock) and held open by the process that has it. A `-p` run
 * gets a lock too, but opens no workspace.
 *
 * The transcript names no folder. `history.jsonl`, agy's prompt recall, does: each line's
 * `conversationId` and `workspace`, the latest line winning. `cache/last_conversations.json` maps a
 * workspace to its latest conversation and answers for the rest. A conversation neither places is
 * left out: resumed anywhere else it would work in the wrong folder.
 *
 * The lock held open says exactly which process has a conversation. Nothing on disk says a turn is
 * running: the transcript never marks one's end, and a backgrounded step stays `RUNNING` for good.
 */

import { realpath, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

import { agyTranscriptPath } from '../../../engines/agy/contract.js'
import type { AgentCommandOwnershipSnapshot } from '../../engineBin.js'
import { engineProcessMatch } from '../../tmux.js'
import { absoluteFolder, entries, fileStamp, parseLine, readJson, readText, record, text, UUID } from './support.js'
import type { ExternalProvider, ExternalSession, OwnerClaim, ProcessView, ScanContext } from './types.js'

/**
 * A process row carries no file identity, so the PATH walk behind a full ownership snapshot could
 * not change a match: one empty snapshot serves every row.
 */
const NO_FILE_OWNERS: AgentCommandOwnershipSnapshot = {
  cursorFileKeys: new Set(), grokFileKeys: new Set(), conflictingFileKeys: new Set(),
  agentCandidates: [], cursorAgentCandidates: [], grokCandidates: [],
}

/** Each conversation's workspace from `history.jsonl`: the latest line that names both wins. */
export async function agyHistoryFolders(path: string): Promise<Map<string, string>> {
  const folders = new Map<string, string>()
  for (const line of (await readText(path)).split('\n')) {
    if (!line.includes('"conversationId"')) continue
    const row = record(parseLine(line))
    const id = text(row?.conversationId)
    const cwd = absoluteFolder(row?.workspace)
    if (id && cwd) folders.set(id, cwd)
  }
  return folders
}

/**
 * Each conversation's workspace from `cache/last_conversations.json` (workspace → its latest
 * conversation). A conversation it names under two workspaces is placed by neither.
 */
export async function agyLatestFolders(path: string): Promise<Map<string, string>> {
  const folders = new Map<string, string>()
  const twice = new Set<string>()
  for (const [workspace, id] of Object.entries(record(await readJson(path)) ?? {})) {
    const cwd = absoluteFolder(workspace)
    if (!cwd || typeof id !== 'string' || !id) continue
    if (folders.has(id)) twice.add(id)
    folders.set(id, cwd)
  }
  for (const id of twice) folders.delete(id)
  return folders
}

/** A file's parsed value, read again only when it changed; [empty] when it is missing. */
async function memoFile<T>(ctx: ScanContext, path: string, read: (path: string) => Promise<T>, empty: T): Promise<T> {
  const stamp = await fileStamp(path)
  return stamp ? ctx.memo(`agy:${path}`, stamp.stamp, () => read(path)) : empty
}

async function isFile(path: string): Promise<boolean> {
  return (await stat(path).catch(error => { externalReadFailed(error, 'record'); return null }))?.isFile() ?? false
}

export interface AgyOptions { home: string }

export function agyProvider(options: AgyOptions): ExternalProvider {
  const presence = join(options.home, 'presence')
  return {
    engine: 'agy',
    async scan(ctx: ScanContext): Promise<ExternalSession[]> {
      const history = await memoFile(ctx, join(options.home, 'history.jsonl'), agyHistoryFolders, new Map<string, string>())
      const latest = await memoFile(ctx, join(options.home, 'cache', 'last_conversations.json'), agyLatestFolders, new Map<string, string>())
      const found: ExternalSession[] = []
      for (const entry of await entries(join(options.home, 'brain'))) {
        if (!entry.isDirectory() || !UUID.test(entry.name)) continue
        const id = entry.name
        const transcriptPath = agyTranscriptPath(options.home, id)!
        const transcript = await stat(transcriptPath).catch(error => { externalReadFailed(error, 'record'); return null })
        // A conversation nobody has spoken in yet has an empty transcript, or none.
        if (!transcript?.isFile() || !transcript.size || !await isFile(join(presence, `${id}.lock`))) continue
        await ctx.pace()
        const cwd = history.get(id) ?? latest.get(id)
        if (!cwd || ctx.excluded(cwd)) continue
        found.push({
          sessionId: id, engine: 'agy', cwd, origin: 'terminal',
          // Steps carry `created_at` to the second, set when a step begins; the file's time is when it was written.
          title: '', mtime: Math.floor(transcript.mtimeMs), transcriptPath,
        })
      }
      return found
    },
    async owners(view: ProcessView): Promise<OwnerClaim[]> {
      const pids = (await view.list()).filter((row) => engineProcessMatch(row, 'agy', NO_FILE_OWNERS).score).map((row) => row.pid)
      if (!pids.length) return []
      // lsof names a file by its real path: the presence folder may be reached through a link.
      const folders = new Set([presence, await realpath(presence).catch(error => { externalReadFailed(error, 'folder'); return presence })])
      const claims: OwnerClaim[] = []
      for (const [pid, files] of await view.openFiles(pids)) {
        for (const path of files) {
          const id = basename(path, '.lock')
          if (path.endsWith('.lock') && UUID.test(id) && folders.has(dirname(path))) claims.push({ sessionId: id, pid, record: path })
        }
      }
      return claims
    },
    // The transcript never marks a turn's end: the file cannot say one is running.
    busy: async () => null,
  }
}
