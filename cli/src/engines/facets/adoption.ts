import type { ExternalOrigin } from '../../lib/sessionSearch/externals/types.js'

/**
 * How search finds an engine's conversations on this machine that Harness did not start, which process holds one
 * open, and whether a turn is running there: adoption (Cmd-P, opening one here, and stopping its owner first).
 * Declared data, applied in search by the kit (kit/adoption.ts). Core owns takeover consent, cancellation and
 * signals; unavailable or uncertain observations hold adoption (docs/design/2026-10-09-external-session-boundary.md).
 */
export interface AdoptionContract {
  /**
   * Which files hold conversations. `projects`: `<root>/<folder>/<name><suffix>`, a folder's own files, never a
   * sub-agent's folder beneath it; a root is a sessions folder. `walk`: files named `<prefix>…<suffix>` below a
   * home's `folders.sessions` (and `folders.archived`, found to read but marked archived), `depth` folders down.
   */
  files:
    | { layout: 'projects'; suffix: string }
    | { layout: 'walk'; prefix: string; suffix: string; depth: number; folders: { sessions: string; archived?: string } }
  /** How a file's head says whose conversation it is. */
  head: {
    /** Read a window at a time, each wider than the last; a file shorter than a window is read whole. */
    windows: readonly number[]
    /**
     * `marked`: the first whole line naming `marker` that parses to an object, which then decides; `first`: the
     * file's first line, once it has ended. A file read whole with no such line is still being written.
     */
    line: { marked: string } | 'first'
    /** The record's `type`, when one is required, and where its fields are (the record itself, else `at`). */
    type?: string
    at?: readonly string[]
    /** A conversation another one delegated to: never offered. */
    skip?: { field: string; is: unknown }
    id: { field: string; pattern: RegExp }
    /** An absolute folder: where it ran, and so where it resumes. */
    cwd: string
    /** Who wrote it, by a field's value; one value may need a second field to say. No match is not a person's. */
    origin: { field: string; values: Readonly<Record<string, ExternalOrigin | { field: string; is: string; then: ExternalOrigin; otherwise: ExternalOrigin }>> }
  }
  /** The engine's own names for its conversations: one `{id, title}` record a line, the last one winning. */
  titles?: { file: string; id: string; title: string }
  /**
   * Which process holds a conversation. `records`: a record the process keeps of itself, beside each sessions
   * folder, naming its pid and conversation; a record whose pid now runs another engine, or a process that started
   * after the record says (past `slackMs`), is someone else's. `open`: the session file a process of these
   * `commands` holds open, its conversation the id the file's name holds; a server's (an app's or an editor's) is
   * never stopped from here. A live process with no record says at most, in its arguments, the conversation it
   * started on: the engine's resume flags (`resumeArgs`, lib/tmux.ts) or one of `sessionFlags`.
   */
  owners:
    | { records: { folder: string; suffix: string; pid: string; id: string; started: string; slackMs: number; sessionFlags?: readonly string[] } }
    | { open: { commands: readonly string[]; id: RegExp; contains: string; servers: { executable: RegExp; args: RegExp; subcommands: readonly string[] } } }
  /**
   * Whether the owner is mid-turn. `record`: its record's `field` says (no record: it ended, so not). `tail`: the
   * last turn event near the file's end, read in widening windows, says; `marker` is on every such line, and only
   * the event's type at `at` counts, never what was said.
   */
  busy:
    | { record: { field: string; busy: string; idle: string } }
    | { tail: { windows: readonly number[]; marker: string; at: readonly string[]; open: string; closed: readonly string[] } }
}
