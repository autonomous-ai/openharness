/**
 * The shell guard's hook (superTabs/shellGuard.ts, task #3596) as each engine runs it, for the sessions the Swarm starts
 * (lib/swarmEngineArgs.ts) and never a person's own. Claude Code takes it as a `--settings` value, which adds hooks to the
 * person's own settings for that session only. Codex takes it as a session flag (`-c hooks.PreToolUse=…`), which it runs
 * only once the home's config.toml records its hash as trusted (`codex app-server` `hooks/list`, codex-cli 0.166.0: the
 * key below, `untrusted` until recorded; a `hooks.state` given by `-c` is ignored), so Harness's Codex hook installation
 * records it beside its own (engines/codex/hookContract.ts). The hook names the script by its path only: nothing here
 * loads the Swarm's code.
 */
import { fileURLToPath } from 'node:url'
import { quoteHookCommand } from '../engines/kit/notifyHooks.js'
import { managedNodePath } from './nodeRuntime.js'
import type { SessionHook } from '../engines/facets/hooks.js'

/** Seconds an engine waits for the hook: lsof, read only for a worktree's removal, is given 5 of them. */
const TIMEOUT = 30
/** Claude Code's tools that run a shell or write a file at a path. */
const CLAUDE_MATCHER = 'Bash|Write|Edit|MultiEdit|NotebookEdit'

/** A release carries the guard inside cli.js, not as a separate script. The lean core sets argv[1] to that CLI
 *  before installing hooks (leanCoreEntry.ts). Source/per-file builds use their lightweight entry instead. */
export function shellGuardArgv(): string[] {
  const file = fileURLToPath(import.meta.url)
  const source = /[/\\]agentShellGuard\.ts$/.test(file)
  const perFile = /[/\\]agentShellGuard\.[jt]s$/.test(file)
  const script = perFile ? fileURLToPath(new URL(source ? '../entry.ts' : '../entry.js', import.meta.url)) : process.argv[1]
  const loader = source ? ['--import', fileURLToPath(new URL('../../node_modules/tsx/dist/loader.mjs', import.meta.url))] : []
  return [managedNodePath(), ...loader, script, '__swarm-shell-guard']
}

/** Claude Code's `--settings` for the guard: a shell line, or on Windows exec form, as Harness's own hooks there. */
export function claudeShellGuardArgs(platform: NodeJS.Platform = process.platform, argv: string[] = shellGuardArgv()): string[] {
  const quoted = quoteHookCommand(platform === 'win32' ? 'argv' : 'bash', argv)
  const hook = Array.isArray(quoted)
    ? { type: 'command', command: quoted[0], args: quoted.slice(1), timeout: TIMEOUT }
    : { type: 'command', command: quoted, timeout: TIMEOUT }
  return ['--settings', JSON.stringify({ disableAllHooks: false, hooks: { PreToolUse: [{ matcher: CLAUDE_MATCHER, hooks: [hook] }] } })]
}

/** The guard as Codex runs it and hashes it: every tool, a POSIX line, or on Windows a PowerShell one. */
export const CODEX_SHELL_GUARD = {
  /** Where Codex keeps the record of the one session flag hook: its file, its event, its block and hook. */
  key: '/<session-flags>/config.toml:pre_tool_use:0:0',
  event: 'PreToolUse',
  matcher: '*',
  timeout: TIMEOUT,
  command: (platform: NodeJS.Platform = process.platform, argv: string[] = shellGuardArgv()): string =>
    quoteHookCommand(platform === 'win32' ? 'powershell' : 'bash', argv) as string,
}

/** Codex's session flag for the guard. TOML's basic strings read JSON's escapes. */
export function codexShellGuardArgs(platform: NodeJS.Platform = process.platform, argv: string[] = shellGuardArgv()): string[] {
  const { matcher, timeout } = CODEX_SHELL_GUARD
  const command = CODEX_SHELL_GUARD.command(platform, argv)
  return ['-c', `hooks.PreToolUse=[{matcher=${JSON.stringify(matcher)},hooks=[{type="command",command=${JSON.stringify(command)},timeout=${timeout}}]}]`]
}

/** The guard as Codex records it as reviewed (engines/kit/hookReview.ts): its key, its event's name in the hash, its hook. */
export function codexShellGuardSessionHook(platform: NodeJS.Platform = process.platform): SessionHook {
  const { key, matcher, timeout } = CODEX_SHELL_GUARD
  return { key, label: 'pre_tool_use', matcher, command: CODEX_SHELL_GUARD.command(platform), timeout }
}
