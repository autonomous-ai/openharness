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
    // Agent Messages: a teammate's message reaches a working agent at its next tool call (kit/messagesHook.ts).
    inbox: { event: 'PostToolUse' },
    // Harness's agent commands (facets/hooks.ts HarnessAllowance) need the daemon, which Codex's sandbox cannot
    // reach: measured with `codex sandbox` (codex-cli 0.162.1), neither 127.0.0.1:18473 nor the daemon's socket
    // answered. An `allow` rule runs a command outside the sandbox on its first try, without asking, when every
    // command in it matches one (codex-rs core/src/exec_policy.rs, `Skip { bypass_sandbox }`, 0.162.1). Codex reads
    // every `.rules` file in its `rules` folder and ranks forbidden over prompt over allow, so the person's own rules
    // still win. A list in a pattern is a choice of words: one rule a spelling covers every verb.
    // Codex also matches an absolute program path by its last part, so `/any/folder/harness ps` met the `harness`
    // rule: a script an agent wrote in its own folder ran outside the sandbox (the review of #1232, codex-rs
    // execpolicy/src/policy.rs `match_host_executable_rules`). `host_executable` keeps that to the launcher, whose path
    // then meets the `harness` rule and the person's own rules for `harness` alike (codex-cli 0.107 and later).
    allow: {
      file: 'rules/harness.rules',
      rules: [
        'host_executable(name="harness", paths=["{launcher}"])',
        'prefix_rule(pattern=["harness", {verbs}], decision="allow")',
        'prefix_rule(pattern=["{node}", "{cli}", {verbs}], decision="allow")',
      ],
    },
    commandNamesHome: true,
    // Windows: the session's shell runs the line, and on Windows that shell is PowerShell: `powershell.exe -NoProfile
    // -Command <line>` (rust-v0.162.1: core/src/session/mod.rs `build_hooks_config`, shell-command/src/shell_detect.rs
    // `default_user_shell`). Seen on the Windows VM (B4.15): a line quoted for cmd.exe made every hook exit 1.
    // `%COMSPEC% /C "<line>"` (hooks/src/engine/command_runner.rs `build_command`) runs it only in two fallbacks: no one
    // local session shell (several environments, a remote one, or one still starting), or no PowerShell found. There
    // the leading `&` is a cmd.exe syntax error ("& was unexpected at this time.", checked on the VM): the hook fails
    // closed, and nothing else runs. `commandWindows` would override `command` there; Harness writes `command`, quoted
    // for PowerShell.
    win32Runner: 'powershell',
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
      events: { SessionStart: 'session_start', UserPromptSubmit: 'user_prompt_submit', PostToolUse: 'post_tool_use' },
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
