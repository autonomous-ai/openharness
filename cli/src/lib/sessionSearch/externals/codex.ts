/**
 * Codex: every local session is a rollout under `~/.codex/sessions/YYYY/MM/DD/` (or
 * `archived_sessions/`). Its first line (`session_meta`) says who wrote it: `source` `cli` (a
 * terminal) or `vscode` (the Codex app, whose `originator` is "Codex Desktop", and the editor
 * extensions). `exec` is a script and a `subagent` source is another thread's helper. Thread names
 * are in `session_index.jsonl`.
 *
 * Codex keeps no process record, but holds its rollout open while it runs, so `lsof` names the
 * owner; the rollout's last turn event says whether a turn is running.
 */

import { join } from 'node:path'

import { absoluteFolder, entries, fileStamp, firstLine, parseLine, readHead, readTail, readText, record, text } from './support.js'
import { argvTokens } from '../../tmux.js'
import { type ExternalOrigin, type ExternalProvider, type ExternalSession, type OwnerClaim, type ProcessView, type RunningProcess, type ScanContext, UNSETTLED } from './types.js'

/** How much of a rollout is read for its first line: a little first; `session_meta` can carry long
 *  base instructions, so up to a megabyte when it has to. */
const HEAD_BYTES = [16 * 1024, 1024 * 1024]
const SESSION_ID = /^[A-Za-z0-9-]{8,80}$/
const ROLLOUT_ID = /-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i

export interface CodexHead { sessionId: string; cwd: string; origin: ExternalOrigin }

/**
 * A rollout's session, folder and source, from its first line. UNSETTLED while that line has no end
 * yet in a file shorter than what is read: Codex is still writing it.
 */
export async function readCodexHead(path: string): Promise<CodexHead | null | typeof UNSETTLED> {
  let line: string | null = null
  for (const bytes of HEAD_BYTES) {
    line = await firstLine(path, bytes)
    if (line !== null) break
    // The whole file was read and it has no line yet: Codex is still writing it.
    if (Buffer.byteLength(await readHead(path, bytes)) < bytes) return UNSETTLED
  }
  if (line === null) return null
  const row = record(parseLine(line))
  const meta = record(row?.payload)
  if (row?.type !== 'session_meta' || !meta) return null
  const origin: ExternalOrigin | null = meta.source === 'cli' ? 'terminal'
    : meta.source === 'vscode' ? (meta.originator === 'Codex Desktop' ? 'codex-app' : 'editor')
    : null
  const cwd = absoluteFolder(meta.cwd)
  if (!origin || !SESSION_ID.test(text(meta.id)) || !cwd) return null
  return { sessionId: text(meta.id), cwd, origin }
}

/** Thread names: `session_index.jsonl`, one `{id, thread_name}` a line, the last one winning. */
export async function codexTitles(path: string, ctx: ScanContext): Promise<Map<string, string>> {
  const stamp = await fileStamp(path)
  if (!stamp) return new Map()
  return ctx.memo(`codex:titles:${path}`, stamp.stamp, async () => {
    const titles = new Map<string, string>()
    for (const line of (await readText(path)).split('\n')) {
      const row = record(parseLine(line))
      const name = text(row?.thread_name).trim()
      if (text(row?.id) && name) titles.set(text(row?.id), name)
    }
    return titles
  })
}

/** Every rollout file under a sessions folder (`YYYY/MM/DD/rollout-*.jsonl`), at any depth up to 4. */
export async function rollouts(dir: string): Promise<string[]> {
  const out: string[] = []
  const walk = async (at: string, depth: number): Promise<void> => {
    for (const entry of await entries(at)) {
      const path = join(at, entry.name)
      if (entry.isDirectory() && depth < 4) await walk(path, depth + 1)
      // A file or a link to one; the scan's stat drops a broken link.
      else if (!entry.isDirectory() && entry.name.startsWith('rollout-') && entry.name.endsWith('.jsonl')) out.push(path)
    }
  }
  await walk(dir, 0)
  return out
}

const TURN_MARK = /"(task_started|task_complete|turn_aborted)"/

const SERVER_COMMANDS = new Set(['app-server', 'mcp-server', 'mcp', 'proto'])

/** Whether a Codex process serves other clients rather than a person's terminal. */
export function codexServer(row: RunningProcess | undefined): boolean {
  if (!row) return false
  if (/codex-acp$/.test(row.executable) || /(?:^|\/)codex-acp(?:\s|$)/.test(row.args)) return true
  // The subcommand: the first argument that is not an option.
  const subcommand = argvTokens(row.args).slice(1).find((token) => !token.startsWith('-'))
  return !!subcommand && SERVER_COMMANDS.has(subcommand)
}

/**
 * Whether a rollout's last turn is still running: the last `task_started`, `task_complete` or
 * `turn_aborted` event near its end says. What was said can name the events; only events count.
 * A file that cannot say counts as busy.
 */
export async function codexTurnOpen(path: string, unknown: boolean | null = true): Promise<boolean | null> {
  for (const bytes of [256 * 1024, 4 * 1024 * 1024]) {
    const lines = (await readTail(path, bytes)).split('\n')
    for (let i = lines.length - 1; i > 0; i--) {
      const line = lines[i]
      if (!line.includes('"event_msg"') || !TURN_MARK.test(line)) continue
      const kind = record(record(parseLine(line))?.payload)?.type
      if (kind === 'task_started') return true
      if (kind === 'task_complete' || kind === 'turn_aborted') return false
    }
  }
  return unknown
}

export function codexProvider(options: { home: string }): ExternalProvider {
  return {
    engine: 'codex',
    async scan(ctx: ScanContext): Promise<ExternalSession[]> {
      const titles = await codexTitles(join(options.home, 'session_index.jsonl'), ctx)
      const found: ExternalSession[] = []
      for (const path of [
        ...await rollouts(join(options.home, 'sessions')),
        ...await rollouts(join(options.home, 'archived_sessions')),
      ]) {
        const stamp = await fileStamp(path)
        if (!stamp) continue
        // A rollout's first line never changes: read once, however the file grows.
        const head = await ctx.head(`codex:${path}`, stamp.stamp, () => readCodexHead(path))
        await ctx.pace()
        if (!head || ctx.excluded(head.cwd)) continue
        found.push({ ...head, engine: 'codex', title: titles.get(head.sessionId) ?? '', mtime: stamp.mtime, transcriptPath: path })
      }
      return found
    },
    async owners(view: ProcessView): Promise<OwnerClaim[]> {
      const claims: OwnerClaim[] = []
      const held = await view.openFilesOf(['codex', 'Codex'])
      if (!held.size) return claims
      const processes = new Map((await view.list()).map((row): [number, RunningProcess] => [row.pid, row]))
      for (const [pid, files] of held) {
        // A server Codex runs for other clients (the app, an editor, MCP) holds their threads: never
        // stopped from here, even when a terminal started it.
        const app = codexServer(processes.get(pid))
        for (const path of files) {
          const id = ROLLOUT_ID.exec(path)?.[1]
          if (id && path.includes('rollout-')) claims.push({ sessionId: id, pid, record: path, ...(app ? { app: true } : {}) })
        }
      }
      return claims
    },
    busy: (owner) => codexTurnOpen(owner.record, null),
  }
}
