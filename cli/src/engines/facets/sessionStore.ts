import type { FolderSetting } from './hooks.js'

/**
 * Where an engine keeps its sessions, and how core reads them: as the registry loads, on the hook path and
 * in session repair. Declared data, applied in core by the kit (kit/sessionRecords.ts, kit/continuation.ts)
 * and lib/sessionRepair.ts. Binding a session never waits on an engine worker
 * (docs/design/2026-10-08-engine-launch.md, (c4)).
 */
export interface SessionStoreContract {
  /** How the daemon's log and its own hook events name the engine (`[registry] repaired Codex parent …`,
   *  `ClaudeContinuation`). */
  label: string
  /** How the person knows it, in what the daemon tells them (`Claude Code in <home>`). */
  product: string
  /**
   * Where sessions are. The daemon's own folder is `own` (a setting naming it, with `folder` below it when the
   * setting names a home), unless the agent runs on a profile of its own (`profile`), which is then its only
   * one. Every home the person moves with `moved.variable` adds `moved.folder` below it; the daemon's own home
   * for that variable is `moved.ownHome` (the setting's folder, or the parent of `own`'s). A finished session
   * may move to `archived`, beside `own.folder` in the same home.
   */
  sessions: {
    own: { setting: FolderSetting; folder?: string }
    profile?: boolean
    moved: { variable: string; folder: string; ownHome: 'setting' | 'parent' }
    archived?: string
  }
  /** How one session's file is found by its id. `walk`: a file ending in `suffix` whose name holds the id, at any
   *  depth, at most `walk` entries looked at, for an id `id` accepts. `projects`: `<id><suffix>` in any one folder
   *  directly below a sessions folder. */
  byId: { layout: 'walk'; suffix: string; id: RegExp; walk: number } | { layout: 'projects'; suffix: string }
  /**
   * What a session file's first record says about it, read within `maxBytes`: its `type`, and where it keeps
   * the id, the folder, the field whose presence marks a session another one delegated to, and that one's parent.
   */
  first?: { type: string; id: readonly string[]; cwd: readonly string[]; child: readonly string[]; parent: readonly string[]; maxBytes: number
    /** Native source variants that can conclusively exclude the delegated variant. */
    source?: { field: readonly string[]; values: readonly string[]; named: readonly string[]; legacyMissing: boolean }
  }
  /**
   * How a scan of the store tells which folder a session belongs to. `first`: the first record above, a child
   * never counts. `head`: the first `cwd` in its opening lines, never a file below a `childFolder` segment or one
   * whose first `sidechain` flag is true.
   */
  scan: { from: 'first' } | { from: 'head'; childFolder: string; sidechain: string }
  /**
   * How a live process names its own session. `record`: a file of its own, `<folder>/<pid><suffix>` beside each
   * sessions folder, naming the pid, its start (UTC or the host's local form), the folder and the session. `open`:
   * the session file it holds open, named like `file`; behind a Node launcher (`launcher`), its one native child's.
   */
  live: { record: { folder: string; suffix: string; pid: string; start: string; cwd: string; id: string } }
    | { open: { file: RegExp; launcher: RegExp } }
  /**
   * A conversation continued in another file: the last record of the transcript (within `tailBytes`) has type
   * `type` and names the next session in `field`, `<id><suffix>` beside it. It is taken only once that file holds a
   * turn (a record of `turns`, within `headBytes`, or a file at least that long).
   */
  continuation?: { type: string; field: string; suffix: string; tailBytes: number; turns: readonly string[]; headBytes: number }
  /** A parent's binding, overwritten by its delegated session's hook, is put back as the registry loads. */
  repairsOverwrittenParent?: boolean
  /**
   * What counts as conversation activity in a transcript, for an agent's frame (lib/transcriptActivity.ts): a
   * record whose `at` field is a time, of one of `records`' kinds. Metadata rewritten when an idle session is
   * discovered or resumed never counts. A kind names the record's `type`, and may require fields of the record,
   * or of its item (the first object at one of `item`'s paths), to be one of the values listed: `in` compares a
   * field as text, `is` as it is.
   */
  activity?: {
    at: string
    item?: readonly (readonly string[])[]
    records: readonly ActivityRecord[]
  }
}

export type ActivityMatch = { in: readonly string[] } | { is: readonly string[] }
export interface ActivityRecord {
  type: string
  fields?: Readonly<Record<string, ActivityMatch>>
  item?: Readonly<Record<string, ActivityMatch>>
}
