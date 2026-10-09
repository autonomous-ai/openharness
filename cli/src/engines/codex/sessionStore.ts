import type { SessionStoreContract } from '../facets/sessionStore.js'
import { hooks } from './hookContract.js'
import { launch } from './launch.js'

const rollouts = launch.resumeRepair!.sessions

/**
 * Where Codex keeps its sessions, declared: data only, which core applies with the kit
 * (engines/sessionStoreContracts.ts, lib/sessionRepair.ts, lib/engineHomes.ts, the registry). Copied from the
 * former engines/codex/rollout.ts, lib/sessionRepair.ts and lib/engineHomes.ts. The rollout layout and the
 * child rule are the same declarations the resume repair and hook admission use.
 */
export const sessionStore: SessionStoreContract = {
  label: 'Codex',
  product: 'Codex',
  sessions: {
    // `<CODEX_HOME>/sessions/<yyyy>/<mm>/<dd>/rollout-<timestamp>-<id>.jsonl`. An agent's own profile is its only
    // home; else the daemon's and every CODEX_HOME the person moved.
    own: { setting: 'CODEX_HOME', folder: rollouts.folder },
    profile: true,
    moved: { variable: 'CODEX_HOME', folder: rollouts.folder, ownHome: 'setting' },
    // Codex moves a finished session's rollout here; it is still that home's.
    archived: 'archived_sessions',
  },
  byId: { layout: 'walk', suffix: rollouts.suffix, id: rollouts.id, walk: rollouts.walk },
  /**
   * The rollout's first record is the session's metadata: its id (the file name only holds it), the folder it
   * started in (the one field that says where a rollout belongs), and whether a parent delegated to it. Read
   * within 128 KiB.
   */
  first: {
    type: hooks.children!.type, id: ['payload', 'id'], cwd: ['payload', 'cwd'], child: hooks.children!.child,
    parent: [...hooks.children!.child, 'thread_spawn', 'parent_thread_id'], maxBytes: 128 * 1024,
    // Native SessionSource is an externally tagged enum. Legacy rollouts omitted it;
    // present unknown object shapes cannot establish that a rollout is interactive.
    source: { field: ['payload', 'source'], values: ['cli', 'vscode', 'exec', 'mcp', 'unknown'], named: ['custom'], legacyMissing: true },
  },
  scan: { from: 'first' },
  /**
   * October 6 parallel-create incident: the only rollout in a folder can belong to a sibling whose file opened
   * first, so a known Codex process names its own open rollout and is never matched by folder. npm's Node
   * launcher holds no rollout; its one native child does.
   */
  live: { open: { file: /rollout-[^/]*\.jsonl$/, launcher: /^node(?:js)?$/ } },
  // A sub-agent's hooks run from its parent's pane, and an older daemon let them overwrite the parent's binding.
  repairsOverwrittenParent: true,
  /**
   * The events and items of a conversation, and a compaction; never `session_meta`, `turn_context`, a token count
   * or a rate-limit reading. An item is the payload's, or the one nested in it.
   */
  activity: {
    at: 'timestamp',
    item: [['payload', 'item'], ['payload']],
    records: [
      { type: 'event_msg', item: { type: { in: ['user_message', 'UserMessage', 'agent_message', 'AgentMessage', 'task_started', 'task_complete', 'turn_aborted', 'context_compacted'] } } },
      { type: 'response_item', item: { type: { in: ['reasoning', 'function_call', 'custom_tool_call', 'tool_search_call', 'function_call_output', 'custom_tool_call_output', 'tool_search_output'] } } },
      { type: 'response_item', item: { type: { is: ['message'] }, role: { is: ['user', 'assistant'] } } },
      { type: 'compacted' },
    ],
  },
}
