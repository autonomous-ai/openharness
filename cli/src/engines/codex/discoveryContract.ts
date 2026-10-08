import type { DiscoveryContract } from '../facets/discovery.js'

/**
 * Codex's discovery, declared: data only, which core applies with the kit (engines/discoveries.ts). Copied
 * from the former tables of lib/tmux.ts and lib/gridAssignment.ts, and lib/codexHomeProbe.ts.
 */
export const discovery: DiscoveryContract = {
  process: {
    basenames: [/^codex$/, /^codex-(?:aarch64|x86_64)-(?:apple-darwin|unknown-linux-(?:gnu|musl))$/],
    entrypoints: [/@openai[\/\\]codex[\/\\]bin[\/\\]codex(?:\.js)?$/],
  },
  // `codex fork <id>` never matched `resume`: a fork's id is its parent's.
  resumeArgs: { flags: ['resume'], id: /^[0-9a-f-]{16,}$/i },
  // Codex omits `-m` when no model was picked.
  modelInArgv: true,
  /**
   * A codex pane the daemon did not create (started by hand, or a row discovery had to mint again) has no
   * profile carried from `agent_create`. Its transcript lives under `<CODEX_HOME>/sessions`, so without this
   * the hook's transcript path fails validation against the default profile and session repair scans the
   * wrong root.
   */
  profile: { variable: 'CODEX_HOME', setting: 'CODEX_HOME' },
}
