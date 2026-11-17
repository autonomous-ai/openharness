/** Fixed authority declared for a guest pane; account creation and folder policy live in shared machines. */
import type { GuestLaunchEngine } from './guestEngines.js'

export const GUEST_HELPER_PATH = '/usr/local/libexec/harness/guest-helper'

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

export function guestEngineArgv(input: { engine: GuestLaunchEngine; bypassPermission: boolean; permissionFlags?: readonly string[]; prompt?: string }): string[] {
  const approve = input.permissionFlags ? [...input.permissionFlags] : input.bypassPermission ? [APPROVE_ALL[input.engine]] : []
  // A message that starts with `-` is still a message, not one of the engine's options.
  const first = !input.prompt ? [] : input.prompt.startsWith('-') ? ['--', input.prompt] : [input.prompt]
  return [input.engine, ...approve, ...first]
}
