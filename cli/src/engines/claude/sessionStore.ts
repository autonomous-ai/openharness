import type { SessionStoreContract } from '../facets/sessionStore.js'

/**
 * Where Claude Code keeps its sessions, declared: data only, which core applies with the kit
 * (engines/sessionStoreContracts.ts, lib/sessionRepair.ts, lib/engineHomes.ts). Copied from the former
 * lib/sessionRepair.ts and lib/engineHomes.ts.
 */
export const sessionStore: SessionStoreContract = {
  label: 'Claude',
  product: 'Claude Code',
  sessions: {
    // `<projects>/<encoded cwd>/<id>.jsonl`. A CLAUDE_CONFIG_DIR the person moves keeps its own `projects`.
    own: { setting: 'CLAUDE_PROJECTS_DIR' },
    moved: { variable: 'CLAUDE_CONFIG_DIR', folder: 'projects', ownHome: 'parent' },
  },
  // The cwd encoding is Claude's to define, so the project folders are listed rather than the name derived.
  byId: { layout: 'projects', suffix: '.jsonl' },
  /**
   * Claude opens with bookkeeping records (`leafUuid`, `mode`) that carry no cwd, so the opening lines are read.
   * Its subagents (the Task tool, background agents) write transcripts of their own in the same tree, which a
   * scan by folder cannot tell from a conversation: `<proj>/<parent>/subagents/agent-<id>.jsonl` (current) and
   * `<proj>/agent-<id>.jsonl` (older builds), both opening with `isSidechain: true` and the PARENT's id. Left in,
   * the youngest subagent file of a running parent was bound to the fork born next to it. Only the opening
   * record's flag counts: a main transcript can hold sidechain records later.
   */
  scan: { from: 'head', childFolder: 'subagents', sidechain: 'isSidechain' },
  /**
   * Native Claude publishes a pid-to-conversation record (`<home>/sessions/<pid>.json`) even before a hook binds
   * it, removed at exit. `procStart` is UTC in current Claude and the host's local `ps` form in older builds: the
   * exact second either way, never a recycled pid.
   */
  live: { record: { folder: 'sessions', suffix: '.json', pid: 'pid', start: 'procStart', cwd: 'cwd', id: 'sessionId' } },
  /**
   * Claude rolls a long conversation over to a new file on its own; the old file's last line names the next
   * session. The same marker is written for a background session, whose file holds two bookkeeping lines and
   * never a turn, so a continuation counts only once a turn is in it (or the file is too long to be those lines).
   */
  continuation: { type: 'continued-in', field: 'continuedInSessionId', suffix: '.jsonl', tailBytes: 4 * 1024, turns: ['user', 'assistant'], headBytes: 256 * 1024 },
  /** On compaction Claude Code writes what it still remembers of the earlier conversation as a user record
   *  flagged `isCompactSummary` (its normalizer drops it from turns). The handoff quotes the latest one, without the
   *  wrapper Claude puts around it: an opening line, a pointer to its raw transcript outside the project, and orders
   *  to resume "without asking the user any further questions", which contradict the record's "wait for the user"
   *  (every real summary on the reviewer's machine ended with them, 2026-10-21). */
  compactSummary: {
    flag: 'isCompactSummary', text: ['message', 'content'],
    wrapper: {
      opening: ['This session is being continued from a previous conversation'],
      closing: ['If you need specific details from before compaction', 'Continue the conversation from where it left off',
        'The messages after this summary are the most recent messages'],
    },
  },
  /** A prompt, an answer, and the system records a turn ends with: a title, a file snapshot or a mode is not work. */
  activity: {
    at: 'timestamp',
    records: [
      { type: 'user' }, { type: 'assistant' },
      { type: 'system', fields: { subtype: { in: ['turn_duration', 'stop_hook_summary', 'compact_boundary'] } } },
    ],
  },
}

/** Control reads the first identity-bearing opening, after Claude's bookkeeping. The byte limit is the bound:
 * a resumed Claude Code 2.1.30x session opens with its title, name and modes and then one
 * `file-history-snapshot` per earlier checkpoint, and two live transcripts measured on 2026-10-21 named their
 * first `cwd` at records 48 and 60. A 20-record limit held them, and Change agent waited on them forever. */
export const controlIdentity = {
  maxBytes: 1024 * 1024, maxRecords: 10_000, id: ['sessionId'], cwd: ['cwd'], sidechain: 'isSidechain',
} as const satisfies import('../kit/controlIdentity.js').ControlIdentityRule
