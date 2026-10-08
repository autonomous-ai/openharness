import type { HookContract } from '../facets/hooks.js'

/**
 * Codex's hooks, declared: data only, which core applies with the kit's installer and rules
 * (engines/hooks.ts). Copied from the former installHooks.ts and hooks.ts of this folder.
 */
export const hooks: HookContract = {
  settings: {
    // This machine's own default profile. A Codex agent launched against a different CODEX_HOME profile (see
    // `Agent.codexHome`/`agent_create`) reads hooks.json from THAT folder, not this one, so `onCreateAgent`
    // installs again into the chosen profile before spawning such an agent. Idempotent either way.
    home: { setting: 'CODEX_HOME' },
    file: 'hooks.json',
    events: [{ event: 'SessionStart', matcher: 'startup|resume|clear|compact' }, { event: 'UserPromptSubmit' }],
    timeout: 5,
    commandNamesHome: true,
    // A malformed existing file is left untouched: silently replacing it could disable user
    // security/automation hooks.
    unreadable: 'keep',
    write: 'atomic',
    upToDate: { command: 'first', matcher: true },
    messages: {
      current: '[hooks] Codex SessionStart/UserPromptSubmit hooks already installed → {file}',
      installed: '[hooks] installed Codex SessionStart/UserPromptSubmit hooks → {file}',
      after: '[hooks] Codex requires reviewing these user hooks with /hooks before normal use',
      failed: '[hooks] failed to write Codex hooks.json:',
      malformed: ['[hooks] Codex hooks file is invalid JSON; leaving it unchanged: {file}', '[hooks] fix the file, then restart harness login'],
    },
  },
  // A delegated session (a Codex sub-agent) runs its hooks from its parent's pane, and its rollout's first
  // record names it a child (`source.subagent`). Registered, it would take the parent's pane and transcript,
  // and its prompt would be credited to the parent: refused before either (hookServer.ts, registry.register).
  children: { type: 'session_meta', child: ['payload', 'source', 'subagent'], reason: 'codex_subagent' },
  // Codex closes turns through its transcript, never a Stop hook.
}
