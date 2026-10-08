import type { EngineLaunch } from '../facets/launch.js'

/** What `-c a.b.NAME=…` can address: Codex splits the key on dots, so a name must be a bare key. */
const CODEX_ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * Codex runs a session's commands in a shared app server (`codex app-server --managed-daemon`, codex-cli
 * 0.159.3), not under the process Harness launched, so they never see that process's environment.
 * Measured: HARNESS_CONTEXT_FILE and every manifest variable were unset in the agent's shell, and the
 * Model Manager ran without its instructions. `shell_environment_policy.set` is what Codex itself gives
 * every command, and `-c` carries it to whichever process runs them. The value is a JSON string, which
 * TOML reads as the same string.
 */
export function codexEnvArgs(env: Record<string, string>): string[] {
  return Object.entries(env)
    .filter(([name]) => CODEX_ENV_NAME.test(name))
    .flatMap(([name, value]) => ['-c', `shell_environment_policy.set.${name}=${JSON.stringify(value)}`])
}

const permissionModes = {
  auto: ['--approve-for-me'],
  readOnly: ['--sandbox', 'read-only'],
  ask: [],
  full: ['--dangerously-bypass-approvals-and-sandbox'],
}
export const launch: EngineLaunch = {
  permissionModes, bypassPermission: permissionModes.auto,
  firstPromptArgs: [], resumeArgs: ['resume'], forkArgs: { lead: ['fork'] },
  instructionFiles: ['AGENTS.override.md', 'AGENTS.md'], envArgs: codexEnvArgs,
}
