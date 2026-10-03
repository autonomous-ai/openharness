/**
 * The shapes every engine's discovery shares: what a conversation Harness did not start looks like,
 * how an engine lists them, and how it says which process has one open.
 *
 * One provider per engine (`claude.ts`, `codex.ts`, …), gathered in `index.ts`, used by
 * `../external.ts`. A provider reads the engine's own store and nothing else: it never writes, never
 * starts the engine, and never logs a process's arguments (they can carry a key).
 */

import type { LiveEvent } from '../../normalize.js'

/**
 * The engines whose conversations can be found on this machine's disk. Amp is not one: it keeps its
 * threads on its server, and nothing local holds what was said.
 */
export const EXTERNAL_ENGINES = [
  'claude', 'codex', 'cursor', 'opencode', 'kilo', 'hermes', 'devin', 'pi', 'commandcode', 'muse', 'grok',
  'agy', 'copilot',
] as const
export type ExternalEngine = typeof EXTERNAL_ENGINES[number]

/**
 * Where a conversation was held. `claude-app` and `codex-app` name the engines' own desktop apps;
 * `app` is another engine's app, `editor` an editor's extension.
 */
export type ExternalOrigin = 'terminal' | 'editor' | 'app' | 'claude-app' | 'codex-app'

export interface ExternalSession {
  sessionId: string
  engine: ExternalEngine
  /** The folder it ran in, and so the folder it resumes in. */
  cwd: string
  origin: ExternalOrigin
  /** The engine's own name for it, or '' (the index then titles it by its first ask). */
  title: string
  /** When the conversation last moved, epoch ms. */
  mtime: number
  /** The JSONL transcript the index reads line by line; null for an engine that keeps a database. */
  transcriptPath: string | null
  /** A database engine's history, read whole. */
  readHistory?: () => Promise<readonly LiveEvent[]>
  /** Arguments a resume needs besides the id: a Hermes profile (`-p work`). */
  launchArgs?: readonly string[]
  /** Its other ids: one Hermes conversation carries on under a new id each time it is compressed. */
  aliases?: readonly string[]
}

/** A file's head that cannot be judged yet: the engine is still writing its first lines. */
export const UNSETTLED: unique symbol = Symbol('unsettled')

export interface ScanContext {
  /** `read`, run again only when `fingerprint` (a file's size and time) changed since the last scan. */
  memo<T>(key: string, fingerprint: string, read: () => Promise<T>): Promise<T>
  /**
   * A file's head, read once for good — unless `read` says it cannot judge it yet (UNSETTLED: the
   * first lines are still being written). Then it is read again when [stamp] changes, and counts as
   * no session meanwhile.
   */
  head<T>(key: string, stamp: string, read: () => Promise<T | null | typeof UNSETTLED>): Promise<T | null>
  /** A folder whose sessions are Harness's own byproducts (its data folder): never offered. */
  excluded(cwd: string): boolean
  /** Lets the daemon breathe between files on a long first scan. */
  pace(): Promise<void>
}

/** A running process. Its arguments identify it and are never logged: a worker's can carry a key. */
export interface RunningProcess {
  pid: number
  ppid: number
  /** The command's name as the system reports it (`comm`). */
  executable: string
  args: string
  /**
   * When it started, epoch ms to the second (`ps` lstart), when known. A record or lock older than
   * the process named in it was left by another process that once had the same pid.
   */
  started?: number
}

/** What a provider may ask about the machine's processes. One view serves one look. */
export interface ProcessView {
  list(): Promise<readonly RunningProcess[]>
  /** The files each of [pids] has open. */
  openFiles(pids: readonly number[]): Promise<Map<number, string[]>>
  /** The files processes with these command names have open, by pid (`lsof -c`). */
  openFilesOf(commands: readonly string[]): Promise<Map<number, string[]>>
  alive(pid: number): boolean
}

/** A provider's word that [pid] has [sessionId] open. */
export interface OwnerClaim {
  sessionId: string
  pid: number
  /** What says whether it is mid-turn: a record, a transcript, a database. */
  record: string
  /** An app or a shared server holds it (a Grok leader, `kilo serve`): never stopped from here. */
  app?: boolean
  /**
   * The only evidence is the process's arguments: they name the session it STARTED on, and a TUI can
   * move to another conversation since (`/resume` in it). The session may be open there, so it is not
   * opened a second time; but the process is never stopped on the strength of it.
   */
  fromArgs?: boolean
}

export interface ExternalProvider {
  readonly engine: ExternalEngine
  /** Every conversation of this engine on disk that a person started and Harness can resume. */
  scan(ctx: ScanContext): Promise<ExternalSession[]>
  /** Which of them a process has open right now, when the engine leaves exact evidence of it. */
  owners?(view: ProcessView): Promise<OwnerClaim[]>
  /** Whether the owner is mid-turn; null when the engine's store cannot say. */
  busy?(owner: { pid: number; record: string }): Promise<boolean | null>
}
