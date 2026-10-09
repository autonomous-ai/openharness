import type { AdoptionContract } from '../facets/adoption.js'
import { sessionStore } from './sessionStore.js'

const record = 'record' in sessionStore.live ? sessionStore.live.record : null

/**
 * Claude Code's conversations, for adoption: data only, which core applies with the kit (kit/adoption.ts).
 * Copied from the former lib/sessionSearch/externals/claude.ts. The layout and the process record are its
 * session store's.
 */
export const adoption: AdoptionContract = {
  // `<projects>/<folder>/<id>.jsonl`; a sub-agent's files live in a folder of their own beneath.
  files: { layout: 'projects', suffix: '.jsonl' },
  head: {
    // The line that says who wrote it is usually the first prompt, which can carry a pasted image: a few hundred
    // kilobytes, or megabytes.
    windows: [256 * 1024, 4 * 1024 * 1024, 32 * 1024 * 1024],
    line: { marked: '"entrypoint"' },
    skip: { field: sessionStore.scan.from === 'head' ? sessionStore.scan.sidechain : 'isSidechain', is: true },
    id: { field: 'sessionId', pattern: /^[A-Za-z0-9-]{8,80}$/ },
    cwd: 'cwd',
    // A terminal, or the Claude app. `sdk-cli` is a program driving Claude, Harness's own summaries among them.
    origin: { field: 'entrypoint', values: { cli: 'terminal', 'claude-desktop': 'claude-app' } },
  },
  // A running Claude Code keeps `<home>/sessions/<pid>.json` naming its session and saying `idle` between turns:
  // the owner and its state, exactly. `ps` gives a start to the second, and Claude stamps its record a moment after.
  // `--session-id <uuid>` starts a conversation under that id, so a process with no record has it open as surely
  // as one that resumed it.
  owners: { records: { folder: record!.folder, suffix: record!.suffix, pid: record!.pid, id: record!.id, started: 'startedAt', slackMs: 2_000,
    sessionFlags: ['--session-id'] } },
  busy: { record: { field: 'status', busy: 'busy', idle: 'idle' } },
}
