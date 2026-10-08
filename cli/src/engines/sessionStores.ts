/**
 * Where an engine keeps its sessions, and how core reads them: a session file's first record, a session
 * file found by its id, the session a live process names, and a conversation continued in another file.
 * Composed per engine, so the registry, session repair, resume capture and the handoff name no engine.
 */
import { claudeContinuation, claudeProcessSession, codexProcessFiles, codexProcessSession, type RepairedSession } from '../lib/sessionRepair.js'
import { readCodexRolloutMeta, resolveCodexRollout } from './codex/rollout.js'
import type { AgentEngine } from './types.js'

/** What a session file's first record says about it. */
export interface SessionMeta {
  id: string
  /** A session another session delegated to. */
  isSubagent: boolean
  /** The session that delegated to it, when the record names one. */
  parentThreadId: string | null
  /** The folder the session was started in: the one field that says where it belongs. */
  cwd: string | null
}

/** The first record of `engine`'s session file at `path`; null for an engine with no such record, or a file
 *  that does not open with one. */
export function sessionMetaOf(engine: AgentEngine | string, path: string): SessionMeta | null {
  return engine === 'codex' ? readCodexRolloutMeta(path) : null
}

/** One session file found by its id under `root` (else every home), without scanning unbounded history. */
export function findSessionFileOf(engine: AgentEngine | string, id: string, root?: string): string | null {
  return engine === 'codex' ? resolveCodexRollout(id, root) : null
}

/** The session a live process names in a record of its own, for an engine that keeps one. */
export function processSessionOf(engine: AgentEngine | string, pid: number, cwd: string, startedAtMs: number): Promise<RepairedSession | null> {
  return engine === 'claude' ? claudeProcessSession(pid, cwd, startedAtMs) : Promise.resolve(null)
}

/** The session a live process holds open, for an engine whose process keeps its session file open. */
export function openFileSessionOf(
  engine: AgentEngine | string, pid: number, roots: string | string[], cwd: string, files?: (pid: number) => Promise<string[]>,
): Promise<RepairedSession | null> {
  return engine === 'codex' ? codexProcessSession(pid, roots, cwd, files) : Promise.resolve(null)
}

/** The files a process holds open, including its native child's behind a launcher. */
export function processFilesOf(
  engine: AgentEngine | string, pid: number, files?: Parameters<typeof codexProcessFiles>[1], processes?: Parameters<typeof codexProcessFiles>[2],
): Promise<string[]> {
  return engine === 'codex' ? codexProcessFiles(pid, files, processes) : Promise.resolve([])
}

/** The file a conversation continued in, when its transcript's last record says it moved there. */
export function continuationOf(engine: AgentEngine | string, transcriptPath: string): Promise<RepairedSession | null> {
  return engine === 'claude' ? claudeContinuation(transcriptPath) : Promise.resolve(null)
}
