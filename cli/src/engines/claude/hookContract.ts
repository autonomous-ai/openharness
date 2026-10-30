import type { HookContract } from '../facets/hooks.js'

/**
 * Claude Code's hooks, declared: data only, which core applies with the kit's installer and rules
 * (engines/hooks.ts). Copied from the former installHooks.ts and hooks.ts of this folder.
 */
export const hooks: HookContract = {
  settings: {
    // The person's own. A home the person moved (CLAUDE_CONFIG_DIR, lib/engineHomes.ts) gets the same block
    // in its own settings.json (core/engines/hooks.ts).
    home: { inHome: '.claude' },
    file: 'settings.json',
    // SessionStart/UserPromptSubmit bind mutable engine-session metadata to the process agent. SessionEnd
    // only asks discovery to reconcile: the process, not the hook, owns the tile lifetime. UserPromptSubmit
    // is the CATCH hook, so a SessionStart missed because the adapter started late is repaired on first input.
    // Stop/StopFailure are the authoritative turn-close signals (Stop = normal finish incl. max_tokens/
    // refusal; StopFailure = turn ended on an API error, where Stop does NOT fire) — they close a turn even
    // when the JSONL-derived turn_ended is missed. Neither supports a matcher (silently ignored).
    events: [{ event: 'SessionStart' }, { event: 'SessionEnd' }, { event: 'UserPromptSubmit' }, { event: 'Stop' }, { event: 'StopFailure' }],
    timeout: 5,
    // Agent Messages: a teammate's message reaches a working agent at its next tool call (kit/messagesHook.ts).
    inbox: { event: 'PostToolUse' },
    // Harness's agent commands and MCP tools, in the person's permission rules (facets/hooks.ts HarnessAllowance):
    // auto mode's check refused a Harness command outright, and a person away from the pane cannot answer a
    // question. Claude Code checks deny, then ask, then allow; a verb the person's deny or ask names in any spelling
    // gets no allow in any. The launcher's full path too: Claude Code does not match `/…/harness ps` to `harness ps`.
    // Not `{node} {cli}`, whose versioned path would leave a stale rule in the person's list at every runtime update
    // (a rules file of its own can be rewritten; this list is theirs). The MCP tools by name, under both names Claude
    // Code gives them: a server the person added as `harness` (`claude mcp add harness -- harness mcp`, as /agents
    // says), and the plugin's (`mcp__plugin_<plugin>_<server>__<tool>`). By name, not `mcp__harness__*`: another
    // product's MCP server is also often added as `harness`, and its tools are not Harness's to allow. And
    // `harness --help`, which every harness is told to read as it starts (lib/agentAttribution.ts): in ask mode it was
    // the one question left in a hand-off (2026-10-12, in a clean VM). It only prints.
    allow: {
      list: ['permissions', 'allow'],
      unless: ['deny', 'ask'],
      rules: ['Bash(harness --help)', 'Bash(harness -h)', 'Bash({launcher} --help)',
        'Bash(harness {verb}:*)', 'Bash({launcher} {verb}:*)', 'mcp__harness__{tool}', 'mcp__plugin_harness_harness__{tool}'],
    },
    commandNamesHome: false,
    // Windows: exec form, `command` (the managed node.exe) and `args`, run without a shell. In shell form Claude Code runs
    // Git Bash, or PowerShell when Git Bash is missing, and no one quoting serves both. Claude Code 2.1.300's schema
    // tip says: "For exec form (no shell), set `command` to the executable and `args` to its arguments".
    win32Runner: 'argv',
    upToDate: { command: 'first-ours', matcher: false },
    messages: {
      current: '[hooks] Claude session + turn (Stop/StopFailure) hooks already installed',
      installed: '[hooks] installed Claude session + turn (Stop/StopFailure) hooks → {file}',
      updated: '[hooks] updated (path/port changed) → {script} --port {port} in {file}',
      after: '[hooks] (takes effect on the next claude session start)',
      failed: '[hooks] failed to write settings.json:',
    },
  },
  sessionFile: { suffix: '.jsonl' },
  stopClosesTurns: true,
}
