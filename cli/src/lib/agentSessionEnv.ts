/**
 * The variables a coding agent sets in the shells it runs commands in, naming its own session: Claude Code's
 * CLAUDECODE, session id and messaging socket and token, Codex's thread id and sandbox, and the AI_AGENT others set.
 * And every ORCA_* an Orca terminal has, whatever runs in it.
 *
 * They belong to that one session. An agent that installs Harness and runs `harness start` from its shell started a
 * daemon with them all (found 2026-10-11: the core of a daemon restarted from a Claude Code session had four), and a
 * tmux server that daemon starts hands its environment to every pane: every harness would have looked like that one
 * agent's session (agentClient/model.ts `outsideCaller`), and had its messaging token. So the master takes them out
 * of its environment before it starts anything (masterProcess.ts), the core does too, for a core started without a
 * master, and the core removes them from a tmux server's environment as it removes harnessd's own (core/main.ts).
 *
 * A setting the person chose (CLAUDE_CODE_USE_BEDROCK, CODEX_HOME, …) is not a session's, and stays.
 */
const AGENT_SESSION_VARIABLES: ReadonlySet<string> = new Set([
  // HARNESS_CORES: a Swarm agent's share of its machine's cores (superTabs/inCore/launch.ts), which is that agent's alone.
  'AI_AGENT', 'HARNESS_AGENT_SESSION', 'HARNESS_CORES',
  'CLAUDECODE', 'CLAUDE_PID', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ATTENDED', 'CLAUDE_CODE_EXECPATH', 'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN',
  'CODEX_THREAD_ID', 'CODEX_CI', 'CODEX_SANDBOX', 'CODEX_SANDBOX_NETWORK_DISABLED', 'CODEX_ESCALATE_SOCKET',
])

/** Whether [name] names an agent's own session, never for a daemon or a pane it makes. */
export function isAgentSessionVariable(name: string): boolean {
  // Orca sets some thirty ORCA_* in each terminal it opens (1.4.256): that terminal's handle, pane and tab, and secrets,
  // its pairing code and its hook, launch and spawn tokens. All are that terminal's or its session's, none a setting the
  // person chose, and a pane that kept them would be that terminal to an engine's hook. A prefix: Orca adds names as it goes.
  return AGENT_SESSION_VARIABLES.has(name) || name.startsWith('ORCA_')
}

/** Takes every agent session variable out of [env], this process's own by default. Says which it took. */
export function dropAgentSessionEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  const dropped = Object.keys(env).filter(isAgentSessionVariable)
  for (const name of dropped) delete env[name]
  return dropped
}
