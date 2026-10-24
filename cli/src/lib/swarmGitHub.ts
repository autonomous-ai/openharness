/**
 * git and gh for a Swarm agent doing another person's project work, through the Harness GitHub App
 * (docs/swarm-github-app.md) instead of this machine owner's own GitHub login.
 *
 * Everything reaches the agent as environment variables, because those survive what its shells do: Codex runs every
 * command in a login shell, Claude Code replays the person's startup files, and on a Mac both put Homebrew's folders
 * back in front of PATH, so a wrapper placed first on PATH would be passed over. So:
 *
 * - git reads `GIT_CONFIG_PARAMETERS` (the variable `git -c` itself uses, above every config file): for github.com its
 *   credential helpers are reset to Harness's alone, which asks the daemon for the task's token
 *   (superTabs/gitCredential.ts) and answers only for the task's repository; ssh remotes of github.com are fetched and
 *   pushed over https, so no ssh key of the owner is used; and `core.hooksPath` names hooks that run the repository's
 *   own hook first, then add the attribution trailers to each commit message.
 * - gh reads `GH_CONFIG_DIR`, a folder of this session's own whose token the daemon keeps fresh (superTabs/github.ts)
 *   and empties when the task ends. The owner's gh configuration is never read.
 *
 * The variable `GIT_CONFIG_KEY_n` is not used: Codex leaves out of its commands every variable whose name contains KEY.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { env } from '../config/env.js'
import { daemonCommand } from './daemonCommand.js'
import { readAuthSession } from './authSession.js'
import { computerId } from './daemonState.js'

/** Every hook git runs from `core.hooksPath`, so a repository's own hooks all still run. */
export const GIT_HOOK_NAMES = ['applypatch-msg', 'pre-applypatch', 'post-applypatch', 'pre-commit', 'pre-merge-commit', 'prepare-commit-msg',
  'commit-msg', 'post-commit', 'pre-rebase', 'post-checkout', 'post-merge', 'pre-push', 'pre-receive', 'update', 'proc-receive',
  'post-receive', 'post-update', 'reference-transaction', 'push-to-checkout', 'pre-auto-gc', 'post-rewrite', 'sendemail-validate',
  'p4-changelist', 'p4-prepare-changelist', 'p4-post-changelist', 'p4-pre-submit', 'post-index-change'] as const

/** Variables that would put another GitHub login in front of the session's own (gh reads them before its config). */
export const SWARM_GITHUB_CLEAR_ENV = ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN']

/** A word for a POSIX shell. */
export const shellWord = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`

export const swarmGitHubRoot = (dataDir: string) => join(dataDir, 'swarm-github')
const SESSION_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
/** This session's own folder: its gh configuration and its commit trailers. Null for a key unfit for a path. */
export function swarmGitHubSessionDir(dataDir: string, key: string): string | null {
  return SESSION_KEY.test(key) ? join(swarmGitHubRoot(dataDir), 'sessions', key) : null
}

/** What git reads for the session (see the file comment). */
export function gitConfigParameters(helper: string, hooks: string): string {
  const entries: Array<[string, string]> = [
    // An empty helper empties the list of helpers read so far, from every config file: only Harness's is left.
    ['credential.https://github.com.helper', ''],
    ['credential.https://github.com.helper', `!${shellWord(helper)}`],
    // git sends the repository's path to the helper, which answers only for the task's repository.
    ['credential.https://github.com.usehttppath', 'true'],
    ['url.https://github.com/.insteadof', 'git@github.com:'],
    ['url.https://github.com/.insteadof', 'ssh://git@github.com/'],
    ['core.hookspath', hooks],
  ]
  return entries.map(([key, value]) => `${shellWord(key)}=${shellWord(value)}`).join(' ')
}

export function credentialHelperScript(input: { command: string; port: number; machineId: string; dataDir: string }): string {
  return '#!/bin/sh\n'
    + '# Written by Harness for Swarm agents\' git (docs/swarm-github-app.md); rewritten as agents start.\n'
    + `ADAPTER_DATA_DIR=${shellWord(input.dataDir)} exec ${input.command} git-credential --port ${input.port} --machine ${shellWord(input.machineId)} "$@"\n`
}

/** One script for every hook: the repository's own hook first (found with Harness's settings left out); then, for a
 *  commit message that has words in it, each trailer the message does not already have, anywhere in it (an amend keeps one
 *  of each). An empty message is left alone so that it still aborts the commit. */
export function hookScript(input: { hooks: string; helper: string }): string {
  return `#!/bin/sh
# Written by Harness for Swarm agents (docs/swarm-github-app.md): runs this repository's own hook, then adds to each
# commit message who the work is for and which agent and machine did it.
ours=${shellWord(input.hooks)}
name=\${0##*/}
own=$(GIT_CONFIG_PARAMETERS= git rev-parse --git-path hooks 2>/dev/null)
if [ -n "$own" ] && [ -x "$own/$name" ] && [ "$(cd "$own" 2>/dev/null && pwd -P)" != "$(cd "$ours" && pwd -P)" ]; then
  case $name in
    prepare-commit-msg|commit-msg) "$own/$name" "$@" || exit $? ;;
    *) exec "$own/$name" "$@" ;;
  esac
fi
case $name in prepare-commit-msg|commit-msg) ;; *) exit 0 ;; esac
msg=$1
dir=$HARNESS_SWARM_GITHUB_DIR
[ -n "$msg" ] && [ -f "$msg" ] && [ -n "$dir" ] || exit 0
[ -n "$(git stripspace --strip-comments < "$msg" 2>/dev/null)" ] || exit 0
[ -s "$dir/trailers" ] || ${shellWord(input.helper)} trailers >/dev/null 2>&1
[ -s "$dir/trailers" ] || exit 0
set --
while IFS= read -r line || [ -n "$line" ]; do
  [ -n "$line" ] && ! grep -qxF -- "$line" "$msg" && set -- "$@" --trailer "$line"
done < "$dir/trailers"
[ $# -gt 0 ] && git interpret-trailers --in-place --if-exists addIfDifferent "$@" "$msg" 2>/dev/null
exit 0
`
}

/** Writes [text] to [file] unless it already says exactly that; never through a half-written file. */
function writeIfChanged(file: string, text: string, mode: number): void {
  try { if (readFileSync(file, 'utf8') === text) { chmodSync(file, mode); return } } catch { /* absent: written below */ }
  const next = `${file}.${process.pid}.next`
  writeFileSync(next, text, { mode })
  chmodSync(next, mode)
  renameSync(next, file)
}

export interface SwarmGitHubTools { dataDir: string; command: string; port: number; machineId: string }
const defaultTools = (): SwarmGitHubTools => ({ dataDir: env.ADAPTER_DATA_DIR, command: daemonCommand(), port: env.PORT,
  machineId: readAuthSession()?.machineId || computerId() })

/** The helper and the hooks, shared by every session on this machine, written for this daemon's CLI. */
export function writeSwarmGitHubTools(tools: SwarmGitHubTools): { helper: string; hooks: string } {
  const root = swarmGitHubRoot(tools.dataDir)
  const bin = join(root, 'bin'), hooks = join(root, 'hooks')
  for (const dir of [root, bin, hooks]) mkdirSync(dir, { recursive: true, mode: 0o700 })
  const helper = join(bin, 'git-credential')
  writeIfChanged(helper, credentialHelperScript(tools), 0o700)
  const script = hookScript({ hooks, helper })
  for (const name of GIT_HOOK_NAMES) writeIfChanged(join(hooks, name), script, 0o700)
  return { helper, hooks }
}

const GH_CONFIG = 'version: "1"\n'
/** gh's own token format, and nothing that could break out of the YAML around it. */
const TOKEN = /^[A-Za-z0-9_]{20,255}$/

/** The session's gh login: [token] for github.com, or none. And, when given, the trailers its commits get. */
export function writeSessionGitHub(dir: string, token: string | null, trailers?: readonly string[]): void {
  const gh = join(dir, 'gh')
  mkdirSync(gh, { recursive: true, mode: 0o700 })
  if (!existsSync(join(gh, 'config.yml'))) writeIfChanged(join(gh, 'config.yml'), GH_CONFIG, 0o600)
  const hosts = token && TOKEN.test(token)
    ? `github.com:\n    users:\n        x-access-token:\n            oauth_token: ${token}\n    git_protocol: https\n    oauth_token: ${token}\n    user: x-access-token\n`
    : '{}\n'
  writeIfChanged(join(gh, 'hosts.yml'), hosts, 0o600)
  if (trailers) {
    const lines = trailers.filter(line => /^[A-Za-z][A-Za-z0-9-]*: [^\r\n]+$/.test(line) && line.length <= 300)
    writeIfChanged(join(dir, 'trailers'), lines.map(line => `${line}\n`).join(''), 0o600)
  }
}

/**
 * The launch of a Swarm session that uses the app ([key]: its session label, `SwarmSkill.key`): its environment, and the
 * variables to clear from what it inherits. Writes the shared tools and the session's folder first. Null where it does not
 * apply: on Windows, whose git does not run these shell scripts, or for a key unfit for a path.
 */
export function swarmGitHubLaunch(key: string, tools: SwarmGitHubTools = defaultTools(), platform: NodeJS.Platform = process.platform):
  { env: Record<string, string>; clearEnv: string[] } | null {
  const dir = swarmGitHubSessionDir(tools.dataDir, key)
  if (platform === 'win32' || !dir) return null
  const { helper, hooks } = writeSwarmGitHubTools(tools)
  if (!existsSync(join(dir, 'gh', 'hosts.yml'))) writeSessionGitHub(dir, null)
  return {
    env: {
      GIT_CONFIG_PARAMETERS: gitConfigParameters(helper, hooks),
      // A credential the helper cannot give fails at once instead of waiting on a prompt nobody answers in an agent's pane.
      GIT_TERMINAL_PROMPT: '0',
      GH_CONFIG_DIR: join(dir, 'gh'),
      GH_PROMPT_DISABLED: '1',
      GH_NO_UPDATE_NOTIFIER: '1',
      HARNESS_SWARM_GITHUB_DIR: dir,
    },
    clearEnv: [...SWARM_GITHUB_CLEAR_ENV],
  }
}
