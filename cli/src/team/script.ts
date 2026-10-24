/**
 * The privileged scripts behind `harness team setup` and `harness team remove`, and the LaunchDaemon that runs the
 * team daemon (docs/plans/2026-10-24-swarm-team-account.md, Task 2). Each is built here as text, checked by its
 * spec, and run once as root behind the macOS administrator prompt (./admin.ts).
 *
 * Rules every line follows:
 * - Every value is checked against a strict pattern first (./layout.ts) and goes into the script single-quoted.
 *   Nothing a person typed reaches the shell unquoted, and nothing reaches it that the pattern did not allow.
 * - Root never writes inside the team account's home. That account may run a teammate's agent, which could plant a
 *   symbolic link where root is about to write and turn the write into one anywhere on disk. Root makes the home
 *   folder itself (its parent, /Users, is root's) and stages files in a folder only root can change; the team
 *   account copies them in itself (`as_team`). Likewise the sentinel in the owner's home is written as the owner.
 * - Every step checks what is there, so a second run repairs a first one that stopped part-way.
 */
import { TEAM_ENGINES } from './engines.js'
import {
  SENTINEL_NAME, TEAM_CONFIG_FILE, TEAM_LABEL, TEAM_PLIST, TEAM_SHARED_DIR, TEAM_STATUS_DIR,
  checkName, checkPath, checkPort, checkUser, teamPaths,
} from './layout.js'

/** POSIX single quotes: the one quoting with no special characters inside. */
export function sh(word: string): string {
  return `'${word.replaceAll("'", `'\\''`)}'`
}

const xml = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')

const ENV_NAME = /^[A-Z_][A-Z0-9_]{0,63}$/
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/

function checkEnv(env: Record<string, string>): Record<string, string> {
  for (const [name, value] of Object.entries(env)) {
    if (!ENV_NAME.test(name) || CONTROL.test(value) || value.length > 1024) {
      throw new Error(`the team daemon cannot carry ${JSON.stringify(name)}=${JSON.stringify(value)}`)
    }
  }
  return env
}

/** What `team __start` is run with before the master, as the team account: redeem a handed-over sign-in code if
 *  there is one, run the privacy check, then the daemon. Positional, so no path is ever part of the shell source. */
export const TEAM_JOB_WRAPPER = '"$1" "$2" team __start "$3" >>"$4" 2>&1; exec "$1" "$2" __harnessd >>"$4" 2>&1'

export interface TeamPlistInput {
  label?: string
  user: string
  home: string
  /** The team account's own Node and CLI. */
  node: string
  cli: string
  port: number
  /** Backend settings carried from the owner's environment (./layout.ts `carriedBackendEnv`). */
  env: Record<string, string>
}

/**
 * The LaunchDaemon: launchd runs the team daemon as the team account from boot, and again if it crashes.
 *
 * No StandardOutPath: launchd may open it as root, inside a home the team account controls. The wrapper opens the
 * log itself, as the team account. No HARNESSD_PLATFORM either: that names the owner's own launchd agent
 * (harnessd/platform.ts), which `harness stop` inside the team account would otherwise try to stop.
 */
export function teamLaunchdPlist(input: TeamPlistInput): string {
  const user = checkUser(input.user)
  const home = checkPath(input.home, 'team home')
  const node = checkPath(input.node, 'team Node')
  const cli = checkPath(input.cli, 'team CLI')
  const port = checkPort(input.port)
  const paths = teamPaths(home)
  const environment = {
    HOME: home, USER: user, LOGNAME: user, SHELL: '/bin/zsh', LANG: 'en_US.UTF-8',
    PATH: `${paths.bin}:/usr/bin:/bin:/usr/sbin:/sbin`,
    ADAPTER_DATA_DIR: paths.data, PORT: String(port),
    ...checkEnv(input.env),
  }
  const vars = Object.entries(environment).map(([name, value]) => `\t\t<key>${xml(name)}</key>\n\t\t<string>${xml(value)}</string>`).join('\n')
  const args = ['/bin/sh', '-c', TEAM_JOB_WRAPPER, 'harness-team', node, cli, paths.handoff, paths.log]
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- The Harness Team account's daemon: Swarm work on this Mac runs as the separate user "${xml(user)}", which cannot
     read the owner's files. Written by "harness team setup"; "harness team status" shows it, "harness team remove"
     removes it with the account. -->
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>${xml(input.label ?? TEAM_LABEL)}</string>
	<key>UserName</key>
	<string>${xml(user)}</string>
	<key>GroupName</key>
	<string>staff</string>
	<key>InitGroups</key>
	<true/>
	<key>ProgramArguments</key>
	<array>
${args.map((arg) => `\t\t<string>${xml(arg)}</string>`).join('\n')}
	</array>
	<key>EnvironmentVariables</key>
	<dict>
${vars}
	</dict>
	<key>WorkingDirectory</key>
	<string>${xml(home)}</string>
	<key>RunAtLoad</key>
	<true/>
	<!-- Again after a crash, not after a clean exit: a clean exit is a stop someone asked for, or a sign-in that ended. -->
	<key>KeepAlive</key>
	<dict>
		<key>SuccessfulExit</key>
		<false/>
		<key>Crashed</key>
		<true/>
	</dict>
	<key>ThrottleInterval</key>
	<integer>10</integer>
	<key>ExitTimeOut</key>
	<integer>10</integer>
	<!-- The agents live in tmux and outlive the daemon, as they do for the owner's. -->
	<key>AbandonProcessGroup</key>
	<true/>
	<!-- Not Interactive like the owner's own daemon: the person at this Mac comes first. -->
	<key>ProcessType</key>
	<string>Standard</string>
</dict>
</plist>
`
}

export interface SetupScriptInput {
  user: string
  realName: string
  home: string
  owner: string
  ownerHome: string
  /** The owner's private staging folder, holding `team.json` and `team.plist`. */
  stageDir: string
  /** The owner's managed Node runtime folder (`~/.harness/runtime/node-…`), copied for the team account. */
  nodeRuntimeDir: string
  /** The owner's managed tmux folder, when the installer put one under ~/.harness/runtime; else Homebrew's serves. */
  tmuxRuntimeDir: string | null
  /** The owner's installed CLI folder (`~/.harness/cli`): cli.js, notify.mjs, package.json. */
  cliDir: string
  /** The owner's Node and CLI, run as the owner to mint the team sign-in code at the moment it is handed over. */
  ownerNode: string
  ownerCli: string
  /** Settings for that run: which backend, which sign-in folder. */
  mintEnv: Record<string, string>
  /** `missing`: hand over a sign-in only when the team account has none. `always`: a new one regardless. */
  signIn: 'missing' | 'always'
}

const basename = (path: string): string => path.slice(path.lastIndexOf('/') + 1)

/** The team account copies the staged runtime into its own home: run as that account, never as root. */
export const TEAM_COPY = [
  'set -eu',
  'umask 077',
  'stage=$1; home=$2; node_name=$3; tmux_name=$4',
  'rt="$home/.harness/runtime"; cli="$home/.harness/cli"; bin="$home/.local/bin"',
  'mkdir -p "$rt" "$cli/data" "$home/.harness/auth" "$bin"',
  'chmod 700 "$home/.harness" "$cli/data" "$home/.harness/auth"',
  'put_dir() { rm -rf "$2.next"; cp -R "$1" "$2.next"; rm -rf "$2"; mv "$2.next" "$2"; }',
  'put_dir "$stage/node" "$rt/$node_name"',
  `printf '%s\\n' "$rt/$node_name/bin/node" > "$rt/current-node.next" && mv -f "$rt/current-node.next" "$rt/current-node"`,
  // Its Node on its own PATH, as tmux is: Codex's launcher is `#!/usr/bin/env node`, and the account has no other Node, so
  // `codex login` in a terminal on its machine would not start. ~/.local/bin is last on a login shell's PATH: a Node the
  // system has wins.
  'ln -sfn "$rt/$node_name/bin/node" "$bin/node"',
  'if [ -n "$tmux_name" ]; then',
  '  put_dir "$stage/tmux" "$rt/$tmux_name"',
  `  printf '%s\\n' "$rt/$tmux_name/bin/tmux" > "$rt/current-tmux.next" && mv -f "$rt/current-tmux.next" "$rt/current-tmux"`,
  '  ln -sfn "$rt/$tmux_name/bin/tmux" "$bin/tmux"',
  'fi',
  'for f in cli.js notify.mjs package.json; do',
  '  [ ! -e "$stage/cli/$f" ] || { cp "$stage/cli/$f" "$cli/.$f.next" && mv -f "$cli/.$f.next" "$cli/$f"; }',
  'done',
  // The same launcher the installer writes, so `harness` works in the team account's own terminals.
  `printf '#!/bin/sh\\nexec "%s" "%s" "$@"\\n' "$rt/$node_name/bin/node" "$cli/cli.js" > "$bin/harness.next"`,
  'chmod 755 "$bin/harness.next" && mv -f "$bin/harness.next" "$bin/harness"',
].join('\n')

/**
 * Claude Code and Codex for the team account (./engines.ts), installed by that account itself, never by root: the vendors'
 * npm packages, with its own copy of Harness's Node and npm, under its own home (`~/.local`, whose bin folder is on its
 * daemon's PATH). Positional: the home, the Node folder's name, then the packages. A package that fails is said and left,
 * never failing setup: running setup again tries again, and `harness team status` shows what is missing.
 */
export const TEAM_ENGINES_INSTALL = [
  'set -u',
  'umask 022',
  'home=$1; node_name=$2; shift 2',
  'bin="$home/.harness/runtime/$node_name/bin"',
  `[ -x "$bin/npm" ] || { printf 'harness: %s\\n' "the team account's Node has no npm; Claude Code and Codex were not installed" >&2; exit 0; }`,
  'PATH="$bin:/usr/bin:/bin:/usr/sbin:/sbin"; export PATH',
  'cd "$home" || exit 0',
  'for pkg in "$@"; do',
  '  if "$bin/npm" install --global --prefix "$home/.local" --no-fund --no-audit --loglevel=error "$pkg" >/dev/null 2>&1; then',
  `    printf 'harness: installed %s for the team account\\n' "$pkg"`,
  `  else printf 'harness: could not install %s for the team account; harness team setup tries again\\n' "$pkg" >&2; fi`,
  'done',
].join('\n')

/** Stdin to a file, as whoever runs it: the next name first, then a rename, so a reader never sees half of it. */
export const WRITE_PRIVATE = 'umask 077 && cat > "$1.next" && mv -f "$1.next" "$1"'
export const WRITE_PUBLIC = 'umask 022 && cat > "$1.next" && chmod 644 "$1.next" && mv -f "$1.next" "$1"'

export const SENTINEL_TEXT = 'Harness Team privacy check. The Harness Team account on this Mac must not be able to read this file:'
  + ' if it can, your home folder is not private. It is removed with the account (harness team remove).'

export function buildSetupScript(input: SetupScriptInput): string {
  const user = checkUser(input.user, 'team account')
  const owner = checkUser(input.owner, 'owner account')
  if (user === owner) throw new Error('the team account must be a different account from the owner')
  if (!/^[A-Za-z0-9 ]{1,40}$/.test(input.realName)) throw new Error(`not a usable full name: ${JSON.stringify(input.realName)}`)
  const home = checkPath(input.home, 'team home')
  const ownerHome = checkPath(input.ownerHome, 'owner home')
  if (home === ownerHome || home.startsWith(`${ownerHome}/`) || ownerHome.startsWith(`${home}/`)) throw new Error('the team home and the owner home must be apart')
  const stage = checkPath(input.stageDir, 'staging folder')
  const nodeDir = checkPath(input.nodeRuntimeDir, 'Node runtime')
  const nodeName = checkName(basename(nodeDir), 'Node runtime folder')
  const tmuxDir = input.tmuxRuntimeDir === null ? null : checkPath(input.tmuxRuntimeDir, 'tmux runtime')
  const tmuxName = tmuxDir === null ? '' : checkName(basename(tmuxDir), 'tmux runtime folder')
  const cliDir = checkPath(input.cliDir, 'installed CLI')
  const ownerNode = checkPath(input.ownerNode, 'owner Node')
  const ownerCli = checkPath(input.ownerCli, 'owner CLI')
  const mintEnv = Object.entries(checkEnv(input.mintEnv)).map(([name, value]) => sh(`${name}=${value}`)).join(' ')
  const paths = teamPaths(home)
  const lines = [
    '#!/bin/sh',
    '# Harness Team account setup (cli/src/team/script.ts), run once as root behind the macOS administrator prompt.',
    '# Running it again repairs what is there; `harness team remove` undoes it.',
    'set -eu',
    'umask 022',
    'cd /',
    `die() { printf 'harness: %s\\n' "$1" >&2; exit "\${2:-1}"; }`,
    `say() { printf 'harness: %s\\n' "$1"; }`,
    `TEAM=${sh(user)}`,
    `TEAM_NAME=${sh(input.realName)}`,
    `TEAM_HOME=${sh(home)}`,
    `OWNER=${sh(owner)}`,
    `OWNER_HOME=${sh(ownerHome)}`,
    `STAGE=${sh(stage)}`,
    `NODE_SRC=${sh(nodeDir)}`,
    `NODE_NAME=${sh(nodeName)}`,
    `TMUX_SRC=${sh(tmuxDir ?? '')}`,
    `TMUX_NAME=${sh(tmuxName)}`,
    `CLI_SRC=${sh(cliDir)}`,
    `OWNER_NODE=${sh(ownerNode)}`,
    `OWNER_CLI=${sh(ownerCli)}`,
    `SHARED=${sh(TEAM_SHARED_DIR)}`,
    `CONFIG=${sh(TEAM_CONFIG_FILE)}`,
    `STATUS_DIR=${sh(TEAM_STATUS_DIR)}`,
    `LABEL=${sh(TEAM_LABEL)}`,
    `PLIST=${sh(TEAM_PLIST)}`,
    `SENTINEL=${sh(`${ownerHome}/${SENTINEL_NAME}`)}`,
    `HANDOFF=${sh(paths.handoff)}`,
    `TEAM_SESSION=${sh(paths.session)}`,
    `SIGN_IN=${sh(input.signIn)}`,
    'as_team() { /usr/bin/sudo -n -H -u "$TEAM" "$@"; }',
    'as_owner() { /usr/bin/sudo -n -H -u "$OWNER" "$@"; }',
    // A folder root relies on must be root's alone, and not a link: another account could swap what it holds.
    'owned_by_root() {',
    '  [ -e "$1" ] || return 0',
    '  [ ! -L "$1" ] || die "$1 is a symbolic link" 6',
    '  [ "$(stat -f %u "$1")" = 0 ] || die "$1 is not owned by root" 6',
    '  mode=$(stat -f %Lp "$1")',
    '  [ $((0$mode & 022)) -eq 0 ] || die "$1 can be written by others" 6',
    '}',
    '# The first free user id at or above 600, as the guest helper picks one.',
    'free_id() {',
    "  used=$(dscl . -list /Users UniqueID | awk '{print $2}')",
    '  candidate=600',
    '  while printf \'%s\\n\' "$used" | grep -qx "$candidate"; do candidate=$((candidate + 1)); done',
    "  printf '%s' \"$candidate\"",
    '}',
    '',
    '[ "$(id -u)" = 0 ] || die "run as root"',
    '[ "$(uname -s)" = Darwin ] || die "the Harness Team account is for macOS"',
    'for dir in / /Users /Library "/Library/Application Support" /Library/LaunchDaemons; do owned_by_root "$dir"; done',
    'owner_uid=$(id -u "$OWNER") || die "no such account: $OWNER"',
    '[ "$owner_uid" != 0 ] || die "the owner cannot be root"',
    '[ -d "$OWNER_HOME" ] && [ ! -L "$OWNER_HOME" ] || die "$OWNER_HOME is not a folder"',
    '[ "$(stat -f %u "$OWNER_HOME")" = "$owner_uid" ] || die "$OWNER_HOME does not belong to $OWNER"',
    '[ -f "$CLI_SRC/cli.js" ] || die "no installed Harness CLI at $CLI_SRC"',
    '[ -x "$NODE_SRC/bin/node" ] || die "no Harness Node runtime at $NODE_SRC"',
    '',
    '# 1. The account: a standard user named Harness Team, visible in System Settings > Users & Groups, whose',
    '#    password is unusable, so nobody can sign in to it. An account by this name that is not ours is left alone.',
    'if dscl . -read "/Users/$TEAM" UniqueID >/dev/null 2>&1; then',
    "  existing=$(dscl . -read \"/Users/$TEAM\" NFSHomeDirectory 2>/dev/null | awk '{print $2}')",
    '  [ "$existing" = "$TEAM_HOME" ] || die "an account named $TEAM already exists and is not the Harness Team account; nothing was changed" 4',
    'else',
    '  say "creating the account $TEAM_NAME ($TEAM)"',
    '  uid=$(free_id)',
    '  dscl . -create "/Users/$TEAM"',
    '  dscl . -create "/Users/$TEAM" UniqueID "$uid"',
    '  dscl . -create "/Users/$TEAM" NFSHomeDirectory "$TEAM_HOME"',
    'fi',
    'dscl . -create "/Users/$TEAM" RealName "$TEAM_NAME"',
    'dscl . -create "/Users/$TEAM" PrimaryGroupID 20',
    'dscl . -create "/Users/$TEAM" UserShell /bin/zsh',
    "dscl . -create \"/Users/$TEAM\" Password '*'",
    // Visible on purpose (see layout.ts): an earlier hidden setup is made visible again.
    'dscl . -delete "/Users/$TEAM" IsHidden >/dev/null 2>&1 || true',
    'if dseditgroup -o checkmember -m "$TEAM" admin >/dev/null 2>&1; then dseditgroup -o edit -d "$TEAM" -t user admin; fi',
    'team_uid=$(id -u "$TEAM")',
    '',
    '# 2. Its home folder, private to it.',
    '[ ! -L "$TEAM_HOME" ] || die "$TEAM_HOME is a symbolic link" 4',
    'if [ ! -d "$TEAM_HOME" ]; then',
    '  createhomedir -c -u "$TEAM" >/dev/null 2>&1 || true',
    '  [ -d "$TEAM_HOME" ] || mkdir "$TEAM_HOME"',
    'fi',
    'home_uid=$(stat -f %u "$TEAM_HOME")',
    '[ "$home_uid" = "$team_uid" ] || [ "$home_uid" = 0 ] || die "$TEAM_HOME belongs to another account" 4',
    'chown "$TEAM:staff" "$TEAM_HOME"',
    'chmod 700 "$TEAM_HOME"',
    '',
    '# 3. The owner\'s home folder, private: every account on a Mac is in the group staff, and a home folder is',
    '#    readable by that group by default. The sentinel inside is readable by everyone on purpose, so the',
    '#    privacy check proves the folder\'s own mode keeps it out.',
    'say "making $OWNER_HOME private (mode 700)"',
    'chmod 700 "$OWNER_HOME"',
    `printf '%s\\n' ${sh(SENTINEL_TEXT)} | as_owner /bin/sh -c ${sh(WRITE_PUBLIC)} sh "$SENTINEL"`,
    '',
    '# 4. The team daemon stops while its files are replaced. Its agents keep running in tmux.',
    'launchctl bootout "system/$LABEL" >/dev/null 2>&1 || true',
    '',
    '# 5. The Harness runtime, staged where only root can change it, then copied in by the team account itself.',
    'RT=$(mktemp -d /private/var/tmp/harness-team.XXXXXX)',
    'trap \'rm -rf "$RT"\' EXIT',
    'mkdir "$RT/node" "$RT/cli"',
    'for part in bin lib include; do [ ! -e "$NODE_SRC/$part" ] || cp -R "$NODE_SRC/$part" "$RT/node/"; done',
    'for f in cli.js notify.mjs package.json; do [ ! -e "$CLI_SRC/$f" ] || cp "$CLI_SRC/$f" "$RT/cli/"; done',
    'if [ -n "$TMUX_NAME" ]; then cp -R "$TMUX_SRC" "$RT/tmux"; fi',
    'chmod -R a+rX,go-w "$RT"',
    'chmod 755 "$RT"',
    `as_team /bin/sh -c ${sh(TEAM_COPY)} sh "$RT" "$TEAM_HOME" "$NODE_NAME" "$TMUX_NAME"`,
    '',
    '# 5b. Claude Code and Codex, installed by the team account itself into its own home: the owner\'s copies are inside the',
    '#     owner\'s private home. None of the owner\'s sign-ins is copied; the owner signs them in once (harness team status).',
    `as_team /bin/sh -c ${sh(TEAM_ENGINES_INSTALL)} sh "$TEAM_HOME" "$NODE_NAME" ${TEAM_ENGINES.map((e) => sh(e.packageName)).join(' ')} || true`,
    '',
    '# 6. What setup made (root\'s), and the team account\'s status folder, which the owner can read.',
    'if [ ! -d "$SHARED" ]; then mkdir -p "$SHARED"; chown 0:0 "$SHARED"; chmod 755 "$SHARED"; fi',
    'owned_by_root "$SHARED"',
    'install -o 0 -g 0 -m 0644 "$STAGE/team.json" "$CONFIG"',
    '[ ! -L "$STATUS_DIR" ] || die "$STATUS_DIR is a symbolic link" 6',
    '[ -d "$STATUS_DIR" ] || mkdir "$STATUS_DIR"',
    'chown "$TEAM:staff" "$STATUS_DIR"',
    'chmod 755 "$STATUS_DIR"',
    '',
    '# 7. Sign-in: a single-use code minted from the owner\'s own sign-in now, so its 90 seconds start here, and',
    '#    written where only the team account can read it. The team daemon redeems it as it starts and deletes it.',
    '#    A code that cannot be had is reported after step 8: step 4 stopped the daemon, and it must start again,',
    '#    with the sign-in it had or none, rather than stay stopped until the next successful setup or restart.',
    'no_sign_in=',
    'if [ "$SIGN_IN" = always ] || [ ! -s "$TEAM_SESSION" ]; then',
    `  if minted=$(as_owner /usr/bin/env ${mintEnv ? `${mintEnv} ` : ''}"$OWNER_NODE" "$OWNER_CLI" team __handoff); then`,
    // Its last line: a warning the CLI printed first must not become part of the code.
    '    code=$(printf \'%s\\n\' "$minted" | tail -n 1)',
    // The shell's own check of what ./layout.ts HANDOFF_CODE allows: token characters, 16 to 256 of them.
    '    case $code in \'\'|*[!A-Za-z0-9_-]*) no_sign_in="the sign-in code was not in the form Harness expects" ;; esac',
    '    [ -n "$no_sign_in" ] || { [ "${#code}" -ge 16 ] && [ "${#code}" -le 256 ]; } || no_sign_in="the sign-in code was not in the form Harness expects"',
    '  else',
    '    no_sign_in="could not get a sign-in code from your Harness sign-in"',
    '  fi',
    '  if [ -z "$no_sign_in" ]; then',
    `    printf '%s\\n' "$code" | as_team /bin/sh -c ${sh(WRITE_PRIVATE)} sh "$HANDOFF"`,
    '    say "handed a sign-in to the team account"',
    '  fi',
    'fi',
    '',
    '# 8. The LaunchDaemon, root\'s, which runs the team daemon as the team account from boot.',
    'install -o 0 -g 0 -m 0644 "$STAGE/team.plist" "$PLIST"',
    'plutil -lint "$PLIST" >/dev/null || die "the team daemon\'s definition is not valid" 8',
    'launchctl enable "system/$LABEL" >/dev/null 2>&1 || true',
    'tries=0',
    'until launchctl bootstrap system "$PLIST" >/dev/null 2>&1; do',
    '  tries=$((tries + 1))',
    '  [ "$tries" -lt 5 ] || die "launchd would not start the team daemon" 8',
    '  launchctl bootout "system/$LABEL" >/dev/null 2>&1 || true',
    '  sleep 1',
    'done',
    'say "the team daemon runs as $TEAM ($LABEL)"',
    '[ -z "$no_sign_in" ] || die "$no_sign_in; the team daemon runs without a new sign-in" 7',
    '',
  ]
  return lines.join('\n')
}

export interface RemoveScriptInput {
  user: string
  home: string
  ownerHome: string
  /** The team account's Node and CLI (from its config), run as that account to sign it out; null when unknown. */
  teamNode: string | null
  teamCli: string | null
  /** The backend settings the team daemon runs with, for that sign-out. */
  env?: Record<string, string>
}

export function buildRemoveScript(input: RemoveScriptInput): string {
  const user = checkUser(input.user, 'team account')
  const home = checkPath(input.home, 'team home')
  const ownerHome = checkPath(input.ownerHome, 'owner home')
  const teamNode = input.teamNode === null ? '' : checkPath(input.teamNode, 'team Node')
  const teamCli = input.teamCli === null ? '' : checkPath(input.teamCli, 'team CLI')
  const env = Object.entries(checkEnv(input.env ?? {})).map(([name, value]) => sh(`${name}=${value}`)).join(' ')
  return [
    '#!/bin/sh',
    '# Harness Team account removal (cli/src/team/script.ts), run once as root behind the macOS administrator prompt.',
    '# It leaves the owner\'s home folder private, as setup made it.',
    'set -eu',
    'cd /',
    `die() { printf 'harness: %s\\n' "$1" >&2; exit "\${2:-1}"; }`,
    `say() { printf 'harness: %s\\n' "$1"; }`,
    `TEAM=${sh(user)}`,
    `TEAM_HOME=${sh(home)}`,
    `LABEL=${sh(TEAM_LABEL)}`,
    `PLIST=${sh(TEAM_PLIST)}`,
    `CONFIG=${sh(TEAM_CONFIG_FILE)}`,
    `STATUS_DIR=${sh(TEAM_STATUS_DIR)}`,
    `SENTINEL=${sh(`${ownerHome}/${SENTINEL_NAME}`)}`,
    `TEAM_NODE=${sh(teamNode)}`,
    `TEAM_CLI=${sh(teamCli)}`,
    '[ "$(id -u)" = 0 ] || die "run as root"',
    'exists=',
    'if dscl . -read "/Users/$TEAM" UniqueID >/dev/null 2>&1; then',
    '  exists=1',
    "  existing=$(dscl . -read \"/Users/$TEAM\" NFSHomeDirectory 2>/dev/null | awk '{print $2}')",
    '  [ "$existing" = "$TEAM_HOME" ] || die "the account $TEAM is not the Harness Team account (its home is $existing); nothing was removed" 4',
    'fi',
    'if [ -e "$TEAM_HOME" ] && [ ! -L "$TEAM_HOME" ]; then',
    // A home left by a team account deleted earlier is owned by a bare user id; anyone else's is not ours to delete.
    '  holder=$(stat -f %Su "$TEAM_HOME")',
    '  case $holder in',
    '    "$TEAM"|root) ;;',
    '    *[!0-9]*) die "$TEAM_HOME belongs to $holder; nothing was removed" 4 ;;',
    '  esac',
    'fi',
    '# Sign the team account out of Harness while it still can, as that account and with its own CLI.',
    'if [ -n "$exists" ] && [ -n "$TEAM_NODE" ] && [ -x "$TEAM_NODE" ] && [ -f "$TEAM_CLI" ]; then',
    `  /usr/bin/sudo -n -H -u "$TEAM" /usr/bin/env ${env ? `${env} ` : ''}"$TEAM_NODE" "$TEAM_CLI" team __signout >/dev/null 2>&1 \\`,
    '    || say "could not sign the team account out of Harness; that sign-in lapses after 90 days unused"',
    'fi',
    'launchctl bootout "system/$LABEL" >/dev/null 2>&1 || true',
    'rm -f "$PLIST"',
    'if [ -n "$exists" ]; then',
    '  pkill -KILL -u "$TEAM" >/dev/null 2>&1 || true',
    '  sleep 1',
    '  dscl . -delete "/Users/$TEAM"',
    'fi',
    'rm -rf "$TEAM_HOME" "$STATUS_DIR"',
    'rm -f "$CONFIG" "$SENTINEL"',
    'say "removed the Harness Team account, its home folder and its daemon"',
    '',
  ].join('\n')
}
