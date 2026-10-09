import type { AdoptionContract } from '../facets/adoption.js'
import { sessionStore } from './sessionStore.js'

const first = sessionStore.first!

/**
 * Codex's conversations, for adoption: data only, which core applies with the kit (kit/adoption.ts). Copied from
 * the former lib/sessionSearch/externals/codex.ts. The folders and the first record are its session store's.
 */
export const adoption: AdoptionContract = {
  // `<home>/sessions/YYYY/MM/DD/rollout-*.jsonl`, and the same below `archived_sessions/`: found, to read, but
  // Codex resumes one only once `codex unarchive` puts it back.
  files: { layout: 'walk', prefix: 'rollout-', suffix: '.jsonl', depth: 4, folders: { sessions: sessionStore.sessions.own.folder!, archived: sessionStore.sessions.archived } },
  head: {
    // A little first; `session_meta` can carry long base instructions, so up to a megabyte when it has to.
    windows: [16 * 1024, 1024 * 1024],
    line: 'first',
    type: first.type,
    at: first.id.slice(0, -1),
    id: { field: first.id[first.id.length - 1], pattern: /^[A-Za-z0-9-]{8,80}$/ },
    cwd: first.cwd[first.cwd.length - 1],
    // A terminal, or the Codex app (`vscode` from "Codex Desktop") and the editor extensions. `exec` is a script,
    // and a sub-agent's source is another thread's helper.
    origin: { field: 'source', values: { cli: 'terminal', vscode: { field: 'originator', is: 'Codex Desktop', then: 'codex-app', otherwise: 'editor' } } },
  },
  titles: { file: 'session_index.jsonl', id: 'id', title: 'thread_name' },
  // Codex keeps no process record, but holds its rollout open while it runs, so `lsof` names the owner. A server
  // Codex runs for other clients (the app, an editor, MCP) holds their threads.
  owners: {
    open: {
      commands: ['codex', 'Codex'], id: /-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i, contains: 'rollout-',
      servers: { executable: /codex-acp$/, args: /(?:^|\/)codex-acp(?:\s|$)/, subcommands: ['app-server', 'mcp-server', 'mcp', 'proto'] },
    },
  },
  // The rollout's last turn event says whether a turn is running; a file that cannot say is busy.
  busy: { tail: { windows: [256 * 1024, 4 * 1024 * 1024], marker: '"event_msg"', at: ['payload', 'type'], open: 'task_started', closed: ['task_complete', 'turn_aborted'] } },
}
