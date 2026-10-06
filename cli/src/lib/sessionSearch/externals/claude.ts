/**
 * Claude Code: `~/.claude/projects/<folder>/<id>.jsonl`. A transcript's first lines say who wrote it:
 * `entrypoint` `cli` (a terminal) or `claude-desktop` (the Claude app). `sdk-cli` is a program driving
 * Claude (Harness's own summaries among them), and a sub-agent's file lives in a folder of its own.
 *
 * A running Claude Code keeps `~/.claude/sessions/<pid>.json` naming its session and saying `idle`
 * between turns: the owner and its state, exactly.
 */

import { join } from 'node:path'

import { agentCommandOwnershipSnapshot } from '../../engineBin.js'
import { engineProcessMatch } from '../../tmux.js'
import { absoluteFolder, entries, fileStamp, readHead, readJson, record, text } from './support.js'
import { type ExternalOrigin, type ExternalProvider, type ExternalSession, type OwnerClaim, type ProcessView, type RunningProcess, type ScanContext, UNSETTLED } from './types.js'

/**
 * How much of a transcript is read to classify it, a window at a time. The line that says who wrote it
 * is usually the first prompt, which can carry a pasted image: a few hundred kilobytes, or megabytes.
 */
const HEAD_BYTES = [256 * 1024, 4 * 1024 * 1024, 32 * 1024 * 1024]
const SESSION_ID = /^[A-Za-z0-9-]{8,80}$/
/** `ps` gives a start to the second; Claude stamps its record a moment after it starts. */
const START_SLACK_MS = 2_000

export interface ClaudeHead { sessionId: string; cwd: string; origin: ExternalOrigin }

/**
 * A transcript's session, folder and entrypoint, from the first line that has them. UNSETTLED when no
 * such line is there yet in a file shorter than what is read: Claude may still be writing it.
 */
export async function readClaudeHead(path: string, windows: readonly number[] = HEAD_BYTES): Promise<ClaudeHead | null | typeof UNSETTLED> {
  for (const bytes of windows) {
    const head = await readHead(path, bytes)
    const whole = Buffer.byteLength(head) < bytes
    // A window that ends mid-file ends mid-line: that line is read whole by the next, wider one.
    const lines = head.split('\n')
    if (!whole) lines.pop()
    for (const line of lines) {
      if (!line.includes('"entrypoint"')) continue
      let row: Record<string, unknown> | null
      try { row = record(JSON.parse(line)) } catch { continue }
      if (!row) continue
      if (row.isSidechain === true) return null
      const origin: ExternalOrigin | null = row.entrypoint === 'cli' ? 'terminal' : row.entrypoint === 'claude-desktop' ? 'claude-app' : null
      const cwd = absoluteFolder(row.cwd)
      if (!origin || !SESSION_ID.test(text(row.sessionId)) || !cwd) return null
      return { sessionId: text(row.sessionId), cwd, origin }
    }
    // The whole file, and no line says yet: Claude may still be writing it.
    if (whole) return UNSETTLED
  }
  return null
}

export function claudeProvider(options: { projectsDir: string; home: string; roots?: () => string[] }): ExternalProvider {
  return {
    engine: 'claude',
    async scan(ctx: ScanContext): Promise<ExternalSession[]> {
      const found: ExternalSession[] = []
      for (const projectsDir of options.roots?.() ?? [options.projectsDir]) {
        for (const project of await entries(projectsDir)) {
          if (!project.isDirectory()) continue
          const folder = join(projectsDir, project.name)
          // Only the project's own files: a sub-agent's are in a folder beneath it.
          for (const file of await entries(folder)) {
            if (!file.name.endsWith('.jsonl')) continue
            const path = join(folder, file.name)
            // A file, or a link to one; not a folder, not a broken link.
            const stamp = await fileStamp(path)
            if (!stamp) continue
            // A transcript's first lines never change: its head is read once, however it grows.
            const head = await ctx.head(`claude:${path}`, stamp.stamp, () => readClaudeHead(path))
            await ctx.pace()
            if (!head || ctx.excluded(head.cwd)) continue
            found.push({ ...head, engine: 'claude', title: '', mtime: stamp.mtime, transcriptPath: path })
          }
        }
      }
      return found
    },
    async owners(view: ProcessView): Promise<OwnerClaim[]> {
      const claims: OwnerClaim[] = []
      const dirs = options.roots?.().map(root => join(root, '..', 'sessions')) ?? [join(options.home, 'sessions')]
      for (const dir of dirs) {
        const records = (await entries(dir)).filter((file) => file.isFile() && file.name.endsWith('.json'))
        if (!records.length) continue
        const processes = new Map((await view.list()).map((process): [number, RunningProcess] => [process.pid, process]))
        const ownership = agentCommandOwnershipSnapshot()
        for (const file of records) {
          const path = join(dir, file.name)
          const row = record(await readJson(path))
          const pid = row?.pid
          if (typeof pid !== 'number' || !text(row?.sessionId) || !view.alive(pid)) continue
          // A record outlives a crash, and its pid can be handed to anything after — a shell in another
          // tab. Only a Claude process already running when the record says Claude started still has it.
          const process = processes.get(pid)
          if (!process || engineProcessMatch(process, 'claude', ownership).score <= 0) continue
          if (process.started !== undefined && typeof row?.startedAt === 'number' && process.started > row.startedAt + START_SLACK_MS) continue
          claims.push({ sessionId: text(row?.sessionId), pid, record: path })
        }
      }
      return claims
    },
    async busy(owner): Promise<boolean | null> {
      const row = record(await readJson(owner.record))
      // No record: the process ended with it, so it is not mid-turn.
      if (!row) return false
      return row.status === 'busy' ? true : row.status === 'idle' ? false : null
    },
  }
}
