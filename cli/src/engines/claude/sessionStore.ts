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
  /** A prompt, an answer, and the system records a turn ends with: a title, a file snapshot or a mode is not work. */
  activity: {
    at: 'timestamp',
    records: [
      { type: 'user' }, { type: 'assistant' },
      { type: 'system', fields: { subtype: { in: ['turn_duration', 'stop_hook_summary', 'compact_boundary'] } } },
    ],
  },
}

/** Control reads the first identity-bearing opening, after Claude's bookkeeping. */
export const controlIdentity = {
  maxBytes: 1024 * 1024, maxRecords: 20, id: ['sessionId'], cwd: ['cwd'], sidechain: 'isSidechain',
} as const satisfies import('../kit/controlIdentity.js').ControlIdentityRule
