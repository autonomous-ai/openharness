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
      after: '[hooks] Codex asks to review hooks it has not seen; Harness records its own as reviewed',
      failed: '[hooks] failed to write Codex hooks.json:',
      malformed: ['[hooks] Codex hooks file is invalid JSON; leaving it unchanged: {file}', '[hooks] fix the file, then restart harness login'],
    },
    // Codex 0.162 asks a person to review every hook it has not seen ("Hooks need review"), Harness's own
    // among them, in the first Codex pane: a fresh Mac with real Codex and Claude Code, 2026-10-09. Picked
    // "Continue without trusting", Harness's hooks never run and its Codex sessions lose their turns and
    // questions. The answer for Harness's own two is recorded as Codex records it ("Trust all"): matched
    // against `codex app-server` `hooks/list` of codex-cli 0.162.0 (engines/kit/hookReview.spec.ts). Any other
    // hook is still asked about. A Codex that hashes differently asks about these again, as before.
    reviewed: {
      file: 'config.toml',
      table: 'hooks.state',
      key: 'trusted_hash',
      events: { SessionStart: 'session_start', UserPromptSubmit: 'user_prompt_submit' },
      matcherEvents: ['SessionStart'],
      defaultTimeout: 600,
      messages: {
        recorded: "[hooks] recorded Harness's own Codex hooks as reviewed → {config}",
        skipped: "[hooks] {config} defines hooks.state in a form Harness does not edit; Codex will ask to review Harness's hooks",
      },
    },
  },
  // A delegated session (a Codex sub-agent) runs its hooks from its parent's pane, and its rollout's first
  // record names it a child (`source.subagent`). Registered, it would take the parent's pane and transcript,
  // and its prompt would be credited to the parent: refused before either (hookServer.ts, registry.register).
  children: { type: 'session_meta', child: ['payload', 'source', 'subagent'], reason: 'codex_subagent' },
  // Codex closes turns through its transcript, never a Stop hook.
}
