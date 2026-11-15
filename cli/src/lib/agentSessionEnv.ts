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
export const AGENT_SESSION_VARIABLES: ReadonlySet<string> = new Set([
  'AI_AGENT', 'HARNESS_AGENT_SESSION',
  'CLAUDECODE', 'CLAUDE_PID', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ATTENDED', 'CLAUDE_CODE_EXECPATH', 'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN',
  // The Claude app's id for the session it runs (`local_<uuid>`): Claude Code in a pane that kept it would name itself
  // that app session, and a tap on the dial would open the app on it (cable/hosts/open.ts).
  'CLAUDE_CODE_HOST_SESSION_ID',
  'CODEX_THREAD_ID', 'CODEX_CI', 'CODEX_SANDBOX', 'CODEX_SANDBOX_NETWORK_DISABLED', 'CODEX_ESCALATE_SOCKET',
])

/**
 * The ORCA_* names an Orca terminal has: those this repository knows, as Orca 1.4.256 names them (#4296's tests), and
 * the names in an Orca 1.4.249 terminal's environment (read 2026-11-15, names only). Its secrets are among them: the
 * pairing code and the hook, launch and spawn tokens. The core unsets these in a tmux server by name, as it never
 * lists that server's environment (tmuxBackend.ts `serverVariablesToUnset`). A name a later Orca adds stays in a
 * server started from an Orca terminal until it restarts: that is the follow-up "a new pane removes ORCA_* from its
 * own environment".
 */
export const ORCA_VARIABLES: readonly string[] = [
  'ORCA_AGENT_HOOK_ENDPOINT', 'ORCA_AGENT_HOOK_ENV', 'ORCA_AGENT_HOOK_OPENCODE_TUI', 'ORCA_AGENT_HOOK_PORT',
  'ORCA_AGENT_HOOK_TOKEN', 'ORCA_AGENT_HOOK_TRANSPORT', 'ORCA_AGENT_HOOK_VERSION', 'ORCA_AGENT_LAUNCH',
  'ORCA_AGENT_LAUNCH_TOKEN', 'ORCA_AGENT_PANE', 'ORCA_AGENT_SESSION_ID', 'ORCA_AGENT_SESSION_SPAWN_TOKEN',
  'ORCA_APP_VERSION', 'ORCA_CLAUDE_AGENT_VIEW_PLUGIN_DIR', 'ORCA_CLAUDE_CONFIG_DIR', 'ORCA_CLAUDE_PROFILE_POINTER',
  'ORCA_CLI_BIN_DIR', 'ORCA_ENVIRONMENT', 'ORCA_HISTFILE', 'ORCA_IMAGE_PROTOCOL', 'ORCA_OPENCODE_AGENT',
  'ORCA_PAIRING_CODE', 'ORCA_PANE_KEY', 'ORCA_PI_SOURCE_AGENT_DIR', 'ORCA_RUNTIME_SOURCE_ID',
  'ORCA_RUNTIME_SOURCE_INCARNATION', 'ORCA_RUNTIME_SOURCE_PROFILE_PATH', 'ORCA_TAB_ID', 'ORCA_TERMINAL_HANDLE',
  'ORCA_USER_DATA_PATH', 'ORCA_WORKSPACE_ID', 'ORCA_WORKTREE_ID', 'ORCA_WSL_HOSTS_GATE_STATE',
]

/** Whether [name] names an agent's own session, never for a daemon or a pane it makes. */
export function isAgentSessionVariable(name: string): boolean {
  // Orca sets some thirty ORCA_* in each terminal it opens (1.4.256): that terminal's handle, pane and tab, and secrets,
  // its pairing code and its hook, launch and spawn tokens. A pane that kept them would be that terminal to an engine's
  // hook. The few a person may set (ORCA_USER_DATA_PATH, ORCA_ENVIRONMENT) steer only Orca's own `orca` command, which
  // the devices process then runs as a daemon started at login does, without them. A prefix: Orca adds names as it goes.
  return AGENT_SESSION_VARIABLES.has(name) || name.startsWith('ORCA_')
}

/** Takes every agent session variable out of [env], this process's own by default. Says which it took. */
export function dropAgentSessionEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  const dropped = Object.keys(env).filter(isAgentSessionVariable)
  for (const name of dropped) delete env[name]
  return dropped
}
