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
  /**
   * Codex archived it (`archived_sessions/`). Found, to read, but not opened: Codex refuses to resume
   * one until `codex unarchive <id>` puts it back (codex-rs thread_processor.rs, "session <id> is
   * archived"), so a harness opened on it only showed that error.
   */
  archived?: true
}

/** A file's head that cannot be judged yet: the engine is still writing its first lines. */
export { UNSETTLED } from '../../../engines/kit/sessionIdentity.js'
import { UNSETTLED } from '../../../engines/kit/sessionIdentity.js'

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
  /** Stable across wall-clock corrections on Linux; otherwise the locale-pinned process start. */
  generation?: string
}

/** What a provider may ask about the machine's processes. One view serves one look. */
export interface ProcessView {
  list(): Promise<readonly RunningProcess[]>
  /** The files each of [pids] has open. */
  openFiles(pids: readonly number[]): Promise<Map<number, string[]>>
  /** The files processes with these command names have open, by pid (`lsof -c`). */
  openFilesOf(commands: readonly string[]): Promise<Map<number, string[]>>
  /** Each of [pids]' working folder, where it could be read; a pid left out is one nobody can say. */
  cwds(pids: readonly number[]): Promise<Map<number, string>>
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

/**
 * A live process of the engine that leaves no exact word of which conversation it has open: Claude Code
 * started before it kept `sessions/<pid>.json`, with no session in its arguments. It may hold any
 * conversation its own `/resume` lists, which are its working folder's; `cwd` is null when that folder
 * could not be read, and then it may hold any.
 */
export interface UnresolvedOwner {
  pid: number
  cwd: string | null
  /** The conversation its arguments name, which it started on; it may since have moved to another. */
  named?: string
}

/** A provider's whole answer about who holds what: its exact claims, and the processes it could not place. */
export interface Ownership {
  claims: OwnerClaim[]
  unresolved: UnresolvedOwner[]
}

export interface ExternalProvider {
  readonly engine: ExternalEngine
  /** Every conversation of this engine on disk that a person started and Harness can resume. */
  scan(ctx: ScanContext): Promise<ExternalSession[]>
  /** Which of them a process has open right now, when the engine leaves exact evidence of it. */
  owners?(view: ProcessView): Promise<OwnerClaim[]>
  /**
   * The same claims as `owners`, with the live processes it could not place. Only admission asks it, and
   * only an engine whose processes can be unplaced has it; without it, every process is placed.
   */
  ownership?(view: ProcessView): Promise<Ownership>
  /** Whether the owner is mid-turn; null when the engine's store cannot say. */
  busy?(owner: { pid: number; record: string }): Promise<boolean | null>
  /** Final admission proof from one coherent record: exact ownership and activity together.
   *  Separate process/file reads cannot prove idle. Missing support means unknown, never idle. */
  confirmOwner?(owner: OwnerClaim, process: RunningProcess | null): Promise<{ current: boolean; busy: boolean | null } | null>
}
