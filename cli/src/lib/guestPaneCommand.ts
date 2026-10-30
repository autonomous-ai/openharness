/**
 * What a tmux pane runs for a guest's harness (docs/plans/2026-10-19-guest-machine-sharing-plan.md): the
 * engine as the guest's own OS user, through the guest helper (guestAccounts.ts), in the guest's workspace,
 * spending the owner's subscription through the relay (subscriptionRelay.ts). Nothing of the owner's goes
 * in: no launch script, no PATH, no HOME, no key — the helper starts the engine with `env -i` and only the
 * variables passed here.
 *
 * The pane itself is the owner's. Before it hands over it asks the helper whether the guest has the engine,
 * and when not installs it as the guest, in that pane, so the guest watches it happen the first time rather
 * than waiting on a create that says nothing for a minute.
 */
import { GUEST_HELPER_PATH, guestRunCommand, type GuestAccount } from './guestAccounts.js'
import { claudeRelayEnv, codexRelayArgs, codexRelayEnv } from './subscriptionRelay.js'

/** The engines a guest's harness runs: the two whose subscription the relay can spend. */
export type GuestLaunchEngine = 'claude' | 'codex'
export const GUEST_LAUNCH_ENGINES: readonly string[] = ['claude', 'codex'] satisfies readonly GuestLaunchEngine[]

/** Each engine's flag for "work without asking for each command", which a harness starts with by default. */
const APPROVE_ALL: Record<GuestLaunchEngine, string> = {
  claude: '--dangerously-skip-permissions',
  codex: '--dangerously-bypass-approvals-and-sandbox',
}

/**
 * The owner's side of the pane: $1 the helper, $2 the guest's user, $3 the workspace, $4 the engine, then the
 * helper's `run` command. The check runs `command -v` as the guest, on the guest's PATH (the helper's).
 */
export const GUEST_PANE_BOOTSTRAP = [
  'helper=$1 user=$2 work=$3 engine=$4; shift 4',
  'if ! sudo -n "$helper" run "$user" --cwd "$work" -- /bin/sh -c \'command -v "$0" >/dev/null\' "$engine" 2>/dev/null; then',
  '  sudo -n "$helper" install "$user" "$engine" || { printf \'\\nCould not install %s.\\n\' "$engine"; exit 1; }',
  'fi',
  'exec "$@"',
].join('\n')

export interface GuestPaneInput {
  account: GuestAccount
  engine: GuestLaunchEngine
  /** The relay's base, `http://127.0.0.1:<port>`, and this harness's token for it. */
  relayUrl: string
  token: string
  bypassPermission: boolean
  /** The engine's flags for the permission mode the guest chose (Ask first, Auto-approve, …), in place of the
   *  all-or-nothing [bypassPermission]: Auto-approve is not Skip all checks. */
  permissionFlags?: readonly string[]
  /** The guest's first message, which both engines take as their last argument. It is on the engine's command
   *  line, which `ps` shows every account on this computer: a guest's task, never a secret of the owner's. */
  prompt?: string
  /** Where it starts: the guest's workspace unless a folder the owner shares (the helper checks it is). */
  cwd?: string
  /** The owner's LANG, so the guest's terminal reads text as the owner's does. */
  lang?: string
  helperPath?: string
}

/** The pane's argv and the variables to set on it (`tmux new-session -e`), which the helper passes on. */
export function guestPaneCommand(input: GuestPaneInput): { argv: string[]; env: Record<string, string> } {
  const { account, engine, relayUrl, token } = input
  const helperPath = input.helperPath ?? GUEST_HELPER_PATH
  const approve = input.permissionFlags ? [...input.permissionFlags] : input.bypassPermission ? [APPROVE_ALL[engine]] : []
  // A message that starts with `-` is still a message, not one of the engine's options.
  const first = !input.prompt ? [] : input.prompt.startsWith('-') ? ['--', input.prompt] : [input.prompt]
  const engineArgv = engine === 'claude' ? ['claude', ...approve, ...first] : ['codex', ...codexRelayArgs(relayUrl), ...approve, ...first]
  const env = {
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    LANG: input.lang || 'en_US.UTF-8',
    ...(engine === 'claude' ? claudeRelayEnv(relayUrl, token) : codexRelayEnv(token)),
  }
  const cwd = input.cwd ?? account.workspace
  const run = guestRunCommand(account.user, cwd, env, engineArgv, helperPath)
  return {
    argv: ['/bin/sh', '-c', GUEST_PANE_BOOTSTRAP, 'harness-guest', helperPath, account.user, cwd, engine, ...run.argv],
    env: run.env,
  }
}
