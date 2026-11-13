/**
 * The variables a coding agent sets in the shells it runs commands in, naming its own session: Claude Code's
 * CLAUDECODE, session id and messaging socket and token, Codex's thread id and sandbox, and the AI_AGENT others set.
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
  'AI_AGENT', 'HARNESS_AGENT_SESSION',
  'CLAUDECODE', 'CLAUDE_PID', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ATTENDED', 'CLAUDE_CODE_EXECPATH', 'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN',
  'CODEX_THREAD_ID', 'CODEX_CI', 'CODEX_SANDBOX', 'CODEX_SANDBOX_NETWORK_DISABLED', 'CODEX_ESCALATE_SOCKET',
])

/** Whether [name] names an agent's own session, never for a daemon or a pane it makes. */
export function isAgentSessionVariable(name: string): boolean {
  return AGENT_SESSION_VARIABLES.has(name)
}

/** Takes every agent session variable out of [env], this process's own by default. Says which it took. */
export function dropAgentSessionEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  const dropped = Object.keys(env).filter(isAgentSessionVariable)
  for (const name of dropped) delete env[name]
  return dropped
}
